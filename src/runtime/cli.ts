/*
 * ============================================================================
 * 文件职责：Tabbit CLI launcher（tabbit-cli，旧名 tabbit-playwright）的底层子进程调用
 * ============================================================================
 *
 * 这是插件与 Tabbit Browser 通信的两条物理通道之一（另一条是 endpoint.ts 的
 * 直连 socket，仅覆盖无任务的清单/健康检查类读取）：每次请求都
 * 启动一个 launcher 子进程，把参数放在命令行、代码放在 stdin，从 stdout/stderr
 * 收结果。没有常驻连接、没有 socket——launcher 内部才去连浏览器。
 *
 * launcher 的输入输出契约（对真机 CLI 实测得出）：
 *   - 成功：stdout 打印一个 JSON 值，退出码 0；
 *   - 失败（应用层）：stderr 打印【一行 JSON】`{"ok":false,"error":{name,code,message}}`，
 *     退出码 64/69/70；
 *   - 失败（外壳层，实例选择问题）：stderr 打印【纯文本】，退出码 69；
 *   - ⚠️ 每次调用 launcher 都会把 stdin 读到 EOF 才继续——所以哪怕命令不需要
 *     stdin（如 `tasks`），也必须写完就关闭 stdin，否则子进程会永远挂着等输入；
 *   - 任何命令都可能触发"浏览器自动拉起"：浏览器没在跑时，launcher 会先启动它
 *     并重试约 20 秒——这就是为什么下层超时要留足余量（见 client.ts 的常量）。
 *
 * 本文件只做"进程调用 + 输出解码 + 超时/取消"，不理解任何业务语义；
 * 业务层的重试、队列、信封解码都在 client.ts。
 */
import { spawn } from 'node:child_process';

import { TabbitCliError, classifyAppError } from './errors.js';

export interface RunCliOptions {
  /* launcher 可执行文件路径。 */
  launcherPath: string;
  /* 拼在 CLI 动词之前的固定参数。默认空；测试夹具用它把"可执行文件 + 脚本
   * 路径"两段式调用写成同一件事（POSIX 与 Windows 通吃，见 tests/platform.mjs）。 */
  launcherArgs?: readonly string[];
  /* 设置了就通过环境变量 TABBIT_PLAYWRIGHT_INSTANCE 告诉 launcher 用哪个实例。 */
  instanceId?: string;
  /* 对子进程整体的墙钟超时（毫秒），超时就杀进程。 */
  timeoutMs: number;
  /* 调用方的取消信号（dsh 工具执行框架会传进来）；触发时杀掉子进程。 */
  signal?: AbortSignal;
}

/* stdout/stderr 各自最多缓存 32 MiB，防御子进程疯狂输出把内存打爆。 */
const STDIO_CAP_BYTES = 32 * 1024 * 1024;

/*
 * 带上限地累积输出块：超过上限后新数据直接丢弃（保留前面的部分即可，
 * 排障时头部信息最有用）。total 用对象包一层是为了跨调用共享计数。
 */
function capConcat(chunks: Buffer[], next: Buffer, total: { bytes: number }): void {
  if (total.bytes >= STDIO_CAP_BYTES) return;
  const room = STDIO_CAP_BYTES - total.bytes;
  chunks.push(next.byteLength > room ? next.subarray(0, room) : next);
  total.bytes += Math.min(next.byteLength, room);
}

/*
 * 执行一次 launcher 调用。
 *
 * @param argv  命令行参数（不含程序名本身），如 ['nodejs', '--task', 'xxx']。
 * @param stdin 要写进子进程 stdin 的内容（求值代码；无内容的命令传空串）。
 * @returns     stdout 解析出的 JSON 值（stdout 为空则是 undefined）。
 * @throws      TabbitCliError——所有失败路径都归一为这一种错误类型。
 *
 * 实现要点（Node 子进程管理的标准套路，逐段解释）：
 *   - spawn() 启动子进程，stdio 三路都接管为管道（pipe）；
 *   - settled 布尔量保证 resolve/reject 只发生一次（多个事件可能竞争触发）；
 *   - 超时/取消都是先发 SIGTERM（温和终止），2 秒后没死再补 SIGKILL（强杀）；
 *   - timer.unref() 让这个定时器不阻止 Node 进程退出；
 *   - 'close' 事件（而非 'exit'）在【stdio 流全部关闭后】触发，此时输出已收齐，
 *     是做最终判定的正确时机。
 */
export async function runCli(argv: string[], stdin: string, options: RunCliOptions): Promise<unknown> {
  // 复制当前环境变量，按需叠加实例选择变量——launcher 靠它路由到具体实例。
  const env = { ...process.env };
  if (options.instanceId) env.TABBIT_PLAYWRIGHT_INSTANCE = options.instanceId;

  return await new Promise<unknown>((resolve, reject) => {
    let child;
    try {
      child = spawn(options.launcherPath, [...(options.launcherArgs ?? []), ...argv], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      // spawn 同步抛错的少见路径（参数非法等）；常见的 ENOENT 走 'error' 事件。
      reject(spawnFailure(options.launcherPath, error));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const outTotal = { bytes: 0 };
    const errTotal = { bytes: 0 };
    let settled = false; // Promise 是否已敲定（防止重复 resolve/reject）
    let timedOut = false; // 是否因超时被我们杀掉
    let aborted = false; // 是否因调用方取消被我们杀掉

    // 墙钟超时保护：到点先 SIGTERM，再补刀 SIGKILL。
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, options.timeoutMs);
    timer.unref();

    // 调用方取消（比如用户在 dsh UI 里停止了这条消息）：同样杀进程。
    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    };
    if (options.signal?.aborted) onAbort(); // 传进来时就已取消的情况
    options.signal?.addEventListener('abort', onAbort, { once: true });

    // 统一的"只敲定一次"出口：清定时器、摘监听器，再执行真正的 resolve/reject。
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    child.stdout.on('data', (chunk: Buffer) => capConcat(stdout, chunk, outTotal));
    child.stderr.on('data', (chunk: Buffer) => capConcat(stderr, chunk, errTotal));
    // 'error'：进程根本没起来（最典型：launcher 文件不存在）。
    child.on('error', (error) => settle(() => reject(spawnFailure(options.launcherPath, error))));
    // 'close'：进程退出且 stdio 全部排空——在这里做最终判定。
    child.on('close', (exitCode) => {
      settle(() => {
        const stdoutText = Buffer.concat(stdout).toString('utf8').trim();
        const stderrText = Buffer.concat(stderr).toString('utf8').trim();
        // 优先级：取消 > 超时 > 正常退出码判定。
        if (aborted) {
          reject(
            new TabbitCliError({
              kind: 'timeout',
              code: 'CANCELLED',
              message: 'Tabbit CLI call was cancelled',
              exitCode,
              stderrRaw: stderrText,
            }),
          );
          return;
        }
        if (timedOut) {
          reject(
            new TabbitCliError({
              kind: 'timeout',
              code: 'CLIENT_TIMEOUT',
              message: `Tabbit CLI did not respond within ${options.timeoutMs}ms and was killed`,
              exitCode,
              stderrRaw: stderrText,
            }),
          );
          return;
        }
        if (exitCode === 0) {
          // 成功路径：stdout 要么为空（无返回值命令），要么是一个 JSON 值。
          if (stdoutText.length === 0) {
            resolve(undefined);
            return;
          }
          try {
            resolve(JSON.parse(stdoutText));
          } catch {
            reject(
              new TabbitCliError({
                kind: 'protocol',
                code: 'BAD_STDOUT',
                message: `Tabbit CLI printed non-JSON output: ${stdoutText.slice(0, 300)}`,
                exitCode,
                stderrRaw: stderrText,
              }),
            );
          }
          return;
        }
        // 非零退出码：去 stderr 里解码失败原因。
        reject(decodeFailure(exitCode, stderrText));
      });
    });

    child.stdin.on('error', () => {
      /* EPIPE：CLI 没读完 stdin 就退出了（比如立刻报错）。写入失败无所谓，
         最终结论由 close 处理器根据退出码/输出决定，这里只需吞掉异常防止崩溃。 */
    });
    // 写入代码并【必须关闭 stdin】——launcher 每次都读 stdin 到 EOF（见文件头契约）。
    child.stdin.end(stdin, 'utf8');
  });
}

/*
 * 把"进程起不来"翻译成分类错误。
 * ENOENT（文件不存在）/EACCES（无执行权限）= 用户没装或没启动过 Tabbit
 * （launcher 是浏览器首次启动时注册的），给出可操作的提示。
 */
function spawnFailure(launcherPath: string, error: unknown): TabbitCliError {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'EACCES') {
    return new TabbitCliError({
      kind: 'launcher-missing',
      code: 'LAUNCHER_MISSING',
      message: `Tabbit CLI launcher not found or not executable at ${launcherPath}. Install and launch Tabbit Browser once to register it.`,
    });
  }
  return new TabbitCliError({
    kind: 'protocol',
    code: 'SPAWN_FAILED',
    message: `Failed to start Tabbit CLI: ${String((error as Error)?.message ?? error)}`,
  });
}

/*
 * 解码非零退出码的失败。两种来源（见文件头契约）：
 *  1. 原生 CLI：stderr 里找以 '{' 开头的那一行，按 JSON 解析出
 *     {error:{name,code,message}}，交给 classifyAppError 归类；
 *  2. 外壳脚本：纯文本 stderr——退出码 69 时归类为"实例选择"问题
 *     （外壳只在这种情况下自己报错），其余归为协议层未知失败。
 */
function decodeFailure(exitCode: number | null, stderrText: string): TabbitCliError {
  // stderr 可能混有日志行，只认以 '{' 开头的那一行 JSON。
  const jsonLine = stderrText
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('{'));
  if (jsonLine) {
    try {
      const parsed = JSON.parse(jsonLine) as { error?: { name?: string; code?: string; message?: string } };
      const error = parsed.error ?? {};
      return new TabbitCliError({
        kind: classifyAppError(error),
        code: error.code ?? 'REQUEST_FAILED',
        message: error.message ?? 'Unknown error',
        exitCode,
        stderrRaw: stderrText,
      });
    } catch {
      /* JSON 解析失败：落回下面的纯文本处理 */
    }
  }
  if (exitCode === 69) {
    return new TabbitCliError({
      kind: 'instance-selection',
      code: 'INSTANCE_SELECTION',
      message: stderrText || 'The Tabbit CLI launcher could not select a Tabbit Browser instance.',
      exitCode,
      stderrRaw: stderrText,
    });
  }
  return new TabbitCliError({
    kind: 'protocol',
    code: 'CLI_FAILED',
    message: stderrText || `Tabbit CLI exited with code ${exitCode}`,
    exitCode,
    stderrRaw: stderrText,
  });
}
