/*
 * ============================================================================
 * 文件职责：Runtime Service 的高层客户端 `TabbitClient`
 * ============================================================================
 *
 * runtime/ 目录的"总装层"：把 cli.ts（子进程调用）、codec.ts（base64 信封）、
 * errors.ts（错误分类）、instances.ts（实例注册表）组合成一个好用的类。
 * 负责：实例选择、请求排队/并发控制、结果解码、超大结果的分块读回、
 * 以及两类故障（任务隔离 quarantine、任务重置 task-reset）的自动恢复。
 *
 * ⚠️ 本文件（乃至整个 runtime/ 目录）完全不依赖任何 dsh 包——可以脱离 dsh
 * 单独使用（`node` 里直接 import lib/runtime/client.js 做脚本调试）。
 * 与 dsh 的对接全部发生在上层（core/tool-browser/web-fetch/mentions）。
 *
 * ─── 必备背景：Runtime Service 的「任务」（task）模型 ───────────────────
 *
 * Tabbit 的 Runtime Service 以「任务」为隔离单位：
 *  - 每个任务有一个名字（task name）。这个名字【同时也是浏览器里那个
 *    标签组（tab group）唯一可见的标题】——服务没有独立的"标题"字段，
 *    改标题只能改任务命名本身；
 *  - 一个任务 = 一个独立的浏览器上下文视角：自己开的标签页、自己的
 *    globalThis（跨调用持久，可以存变量）、自己的 artifacts 目录；
 *  - 任务【只能看到自己打开的或被显式 claim（认领）的标签页】，无法枚举
 *    用户的其它标签页——这是浏览器侧的安全边界；
 *  - 整机最多 8 个并发任务；单次求值超时的可接受区间两代不同，见
 *    EVAL_TIMEOUT_FLOOR_MS / EVAL_TIMEOUT_CEILING_MS 的注释；
 *  - 本客户端用到的 CLI 动词：`nodejs`（求值，创建时可带 --claim-tab）、
 *    `finish`（结束任务，keep 语义随 CLI 代际变化，见 finishTask 注释）、
 *    `receipt`（查回执）、`checkpoint`（检查点）、`resource`（分块读资源）、
 *    `diagnose`（诊断快照；1.13.20+ 用它的 tasks 字段列任务，旧代仍用
 *    `tasks` 子命令，见 listTasks()）、`claim`（对已存在的任务追加认领标签页，见
 *    claimTabs()——真机 `--help` 确认过是独立顶层子命令，不是只存在于
 *    persistent 帧协议里）。新代 CLI（1.11.16+）另有 tabs/resume/
 *    screenshot/inspect/paste 和 persistent 持久模式（JSON 帧协议）——
 *    本客户端尚未使用，见浏览器共享 skill（~/.agents/skills/tabbit）与
 *    TabbitDance 源码。
 *
 * ─── 一次 evaluate 的完整旅程 ─────────────────────────────────────────
 *
 *  evaluate()
 *    └─ withTaskLock()        同名任务串行化（服务端 worker 本来就一次只做一件事）
 *        └─ 重试循环（最多 3 轮）
 *            └─ evaluateOnce()
 *                ├─ buildEvaluationSource()  给代码穿上 base64 信封（codec.ts）
 *                ├─ invoke('nodejs', ...)    起 CLI 子进程提交（cli.ts；全局限流 4 并发）
 *                ├─ waitForTerminalReceipt() 回执没到终态就轮询 receipt
 *                └─ decodeReceiptResult()    内联结果直接解信封；溢出结果先
 *                                            resource 分块读回再解信封
 */
import { randomUUID } from 'node:crypto';

import { runCli } from './cli.js';
import { buildEvaluationSource, decodeEnvelope, type DecodedResult } from './codec.js';
import { CLI_ERROR_CODES, TabbitCliError, isUnknownTaskError } from './errors.js';
import { defaultLauncherPath, listInstances, resolveInstanceId, type TabbitInstance } from './instances.js';

export interface TabbitClientOptions {
  /* 覆盖 launcher 路径（默认见 instances.ts 的 defaultLauncherPath：优先
   * ~/.local/bin/tabbit-cli，回退旧名 tabbit-playwright；Windows 为
   * %LOCALAPPDATA%\Tabbit\LocalAgent\bin\tabbit-cli.exe）。 */
  launcherPath?: string;
  /* 拼在 CLI 动词之前的固定参数，默认空。给测试夹具与"包一层包装脚本"的安装
   * 形态用，语义见 cli.ts 的 RunCliOptions.launcherArgs。 */
  launcherArgs?: readonly string[];
  /* 16 位 hex 实例 id；不传则每次调用时从注册表自动解析。 */
  instanceId?: string;
  /* 可选的日志回调：恢复动作（隔离/重置重试）与 finishTask 吞掉的错误都会打一行说明。 */
  logger?: (message: string) => void;
}

/* 一次求值请求的全部参数。 */
export interface EvaluateRequest {
  /* 任务名（= 浏览器里标签组的可见标题，见文件头）。 */
  task: string;
  /* async 函数体，可用 Playwright 注入全局（browser/context/page/…）。 */
  code: string;
  /* 声明本次调用无副作用（只读）。好处：中断后服务端不会隔离任务。 */
  readOnly?: boolean;
  /* 单次求值超时；发给服务端前会钳位到 [EVAL_TIMEOUT_FLOOR_MS, EVAL_TIMEOUT_CEILING_MS]。 */
  timeoutMs?: number;
  /* 要认领的标签页 id——【只在本次调用恰好创建该任务时生效】。 */
  claimTabs?: number[];
  /* 是否让浏览器把任务标签页切到前台（默认不抢焦点）。 */
  foreground?: boolean;
  /* 溢出资源读回的字节上限（防超大结果拖死轮询）。 */
  maxResultBytes?: number;
  /* 调用方取消信号；触发时杀掉底层 CLI 子进程。 */
  signal?: AbortSignal;
}

/* 服务端随每次求值返回的任务元数据。 */
export interface TaskMetadata {
  taskId: string;
  taskName: string;
  /* true = 任务早已存在（本次是复用）；false = 本次调用刚创建了它。 */
  reused: boolean;
  claimedTabCount?: number;
  profile?: string;
  browserVersion?: string;
  [key: string]: unknown;
}

/* evaluate() 的最终结果（成功或失败都走这个结构，不抛异常）。 */
export interface EvaluateOutcome {
  status: 'succeeded' | 'failed';
  /* 成功时：解码后的返回值。 */
  result?: DecodedResult;
  /* 失败时：求值报告的错误信息。 */
  errorMessage?: string;
  task: TaskMetadata;
  /* true = 恢复过程中发现任务状态（globalThis、页面）已丢失，是在全新任务里重跑的。 */
  taskWasReset: boolean;
  /* 恢复动作的人话说明（会透传给模型，让它知道发生过什么）。 */
  notes: string[];
}

/* `tasks` 命令返回的任务列表条目。 */
export interface TaskListEntry extends TaskMetadata {
  quarantined?: boolean;
  idle?: boolean;
  activeRequestId?: string | null;
  queuedCount?: number;
  receiptCount?: number;
}

/*
 * 求值超时的区间。两代服务端对 --timeout-ms 的接受范围不同（浏览器源码核对）：
 *   - 旧代（≤1.13.22）：(0, 120000]；
 *   - 新代（1.13.23+，提交 6d261ffd588）：[60000, 180000]，低于 60 秒直接拒绝
 *     "--timeout-ms must be from 60000 through 180000"。
 * 取两者交集 [60000, 120000]，不探测版本也能两代通吃：调用方传得更小就抬到
 * 60 秒（真实等待会比它想的长一点，但不会整个失败），更大就压到 120 秒。
 * export 仅为单元测试与上层文案引用。
 */
export const EVAL_TIMEOUT_FLOOR_MS = 60_000;
export const EVAL_TIMEOUT_CEILING_MS = 120_000;
/* CLI 子进程的墙钟超时。新代 CLI 会等结果到 timeoutMs + 20 秒清理宽限（最长
 *  140 秒），浏览器冷启动还要 ~20 秒，所以子进程超时必须比求值超时富余一大截
 *  （这里留 170 秒），否则会在正常等待时误杀。tool-browser 的 dsh 层超时要 > 它。 */
const SUBPROCESS_TIMEOUT_MS = 170_000;
/* 控制类命令（finish/receipt/resource/tasks）的超时——也要容纳浏览器自动拉起的 ~20 秒。 */
const CONTROL_TIMEOUT_MS = 40_000;
/* 溢出资源默认最多读回 4 MB。 */
const DEFAULT_MAX_RESULT_BYTES = 4_000_000;
/* 同一客户端同时在跑的 CLI 子进程上限（对整台机器的 Runtime Service 友好些）。 */
const MAX_CONCURRENT_CALLS = 4;

/*
 * 「回执」（receipt）：Runtime Service 对每个请求的状态记录。
 * status 流转：queued（排队）→ running（执行中）→ 终态之一
 * （succeeded / failed / interrupted）。
 * result 两种形态：inline（≤8KiB，值直接在里面）或 resource（溢出成
 * 资源文件，只给 resourceId 和字节数，需另行分块读回）。
 */
interface Receipt {
  requestId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  result?: { type: 'inline'; value: unknown } | { type: 'resource'; resourceId: string; byteLength: number };
  error?: unknown;
  [key: string]: unknown;
}

export class TabbitClient {
  private readonly options: TabbitClientOptions;
  /* 每个任务名一条 Promise 链，实现按任务串行（见 withTaskLock）。 */
  private readonly taskQueues = new Map<string, Promise<unknown>>();
  /* 当前在飞的 CLI 子进程数（配合 MAX_CONCURRENT_CALLS 限流）。 */
  private inFlight = 0;
  /* 排队等空位的唤醒回调（先来先走）。 */
  private readonly waiters: Array<() => void> = [];

  constructor(options: TabbitClientOptions = {}) {
    this.options = options;
  }

  listInstances(): TabbitInstance[] {
    return listInstances();
  }

  private launcher(): string {
    return this.options.launcherPath ?? defaultLauncherPath();
  }

  /* 每次调用时实时解析实例（配置的 id 校验一遍；没配就自动选）。可能抛引导错误。 */
  private instance(): string | undefined {
    const instances = listInstances();
    // Windows：实例注册表目录在 Windows 上的位置未经真机确认（本地解析很可能
    // 读到空列表），此时不要在客户端这层拦死——把选择（连同可能配置的 id）
    // 原样委托给原生 tabbit-cli.exe，它自有实例选择与可解码的报错
    // （exit 69 → cli.ts 归类为 instance-selection）。
    if (process.platform === 'win32' && instances.length === 0) return this.options.instanceId;
    return resolveInstanceId(this.options.instanceId, instances);
  }

  /*
   * 当前实际会解析到的实例 id（不抛错版本；解析不出就 undefined）。
   * 用途：上层（core 的任务登记）在每次求值成功后记下"这个任务真正跑在了
   * 哪个实例上"，会话结束清理时对症下药——因为"当前解析结果"是会漂移的
   * （用户换个 Tabbit 窗口看 dsh，观看实例就变了）。
   */
  resolvedInstanceId(): string | undefined {
    try {
      return this.instance();
    } catch {
      return undefined;
    }
  }

  private log(message: string): void {
    this.options.logger?.(message);
  }

  /*
   * 并发限流的"占坑"：满员就把自己的唤醒函数排进 waiters 等着。
   * 返回一个"释放函数"，用 released 标志保证幂等（重复调用只生效一次）；
   * 释放时顺手唤醒队首的等待者。这是不依赖任何库的手写信号量（semaphore）。
   */
  private async acquireSlot(): Promise<() => void> {
    if (this.inFlight >= MAX_CONCURRENT_CALLS) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      this.waiters.shift()?.();
    };
  }

  /*
   * 按任务串行化：同一个任务名下的求值排成一条 Promise 链，前一个完成
   * （无论成败——所以 then 的两个参数都是 fn）才轮到下一个。
   * 为什么：服务端的任务 worker 本来就一次只处理一个请求，客户端排好队
   * 能避免请求在服务端队列里堆积、超时语义也更清晰。
   * 不同任务之间互不阻塞（只受全局 4 并发限流约束）。
   */
  private async withTaskLock<T>(task: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.taskQueues.get(task) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    // 存进 map 的是"吞掉结果和错误"的版本，防止链上残留 rejected Promise
    // 触发 unhandled rejection 警告。
    this.taskQueues.set(
      task,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return await run;
  }

  /* 所有 CLI 调用的统一入口：先占并发坑，再执行，finally 保证释放。 */
  private async invoke(argv: string[], stdin: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const release = await this.acquireSlot();
    try {
      return await runCli(argv, stdin, {
        launcherPath: this.launcher(),
        ...(this.options.launcherArgs ? { launcherArgs: this.options.launcherArgs } : {}),
        instanceId: this.instance(),
        timeoutMs,
        ...(signal ? { signal } : {}),
      });
    } finally {
      release();
    }
  }

  /*
   * 求值主入口：带自动恢复的重试循环（最多 3 次尝试，attempt 0/1/2）。
   * 三种可自动恢复的失败，各自的处理：
   *
   *  - quarantined（任务被隔离）：一次带副作用的求值被中断后，服务端把任务
   *    锁起来拒绝新请求，要求先 checkpoint 确认状态。我们自动补一次
   *    checkpoint 然后重试，并在 notes 里向模型说明（它可能需要核实上次
   *    操作到底成没成功）。
   *
   *  - task-reset（任务重置）：worker 丢了/浏览器重启了，任务里的页面和
   *    globalThis 全没了。直接重试会在【全新的空任务】里执行——所以必须
   *    把 taskWasReset 标记出来告诉模型"你之前存的状态没了"，否则它会
   *    对着空任务困惑。
   *
   *  - browser-unavailable（浏览器暂不可达）：可能正在启动，等 3 秒重试
   *    一次（只在第一次尝试时这么做，避免反复空等）。
   *
   * 其余错误不重试，原样抛出（由上层决定措辞）。
   */
  async evaluate(request: EvaluateRequest): Promise<EvaluateOutcome> {
    return await this.withTaskLock(request.task, async () => {
      const notes: string[] = [];
      let taskWasReset = false;
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await this.evaluateOnce(request, notes, taskWasReset);
        } catch (error) {
          if (!(error instanceof TabbitCliError) || attempt >= 2) throw error;
          if (error.kind === 'quarantined') {
            this.log(`task ${request.task} quarantined; running checkpoint`);
            await this.checkpoint(request.task).catch(() => undefined);
            notes.push('Task was quarantined after an interrupted run; a checkpoint was taken and the call was retried.');
            continue;
          }
          if (error.kind === 'task-reset') {
            taskWasReset = true;
            notes.push(
              'The browser task was reset (worker lost or browser restarted). Pages and globalThis state from earlier calls are gone; the call was retried in a fresh task.',
            );
            continue;
          }
          if (error.kind === 'browser-unavailable' && attempt === 0) {
            notes.push('Tabbit Browser runtime was unavailable; retried once after 3s.');
            await new Promise((resolve) => setTimeout(resolve, 3000));
            continue;
          }
          throw error;
        }
      }
    });
  }

  /*
   * 单次求值（不含重试）。流程：
   *  1. 生成唯一 requestId（幂等追踪用）并拼 `nodejs` 命令的参数；
   *  2. 用信封包装代码，经 invoke 提交（代码走 stdin）；
   *  3. 校验 claim_tabs 语义：claim 只在任务【创建】时生效——若服务端说
   *     reused（任务早已存在），claim 实际被无视了，与其静默让调用者误以为
   *     认领成功，不如报错让它换个新任务名；
   *  4. 回执可能还没到终态（queued/running），轮询等它；
   *  5. 按回执状态返回成功（解码结果）或失败（提取错误信息）。
   */
  private async evaluateOnce(request: EvaluateRequest, notes: string[], taskWasReset: boolean): Promise<EvaluateOutcome> {
    const requestId = `dsh-${randomUUID()}`;
    const argv = ['nodejs', '--task', request.task, '--request-id', requestId];
    if (request.readOnly) argv.push('--read-only');
    if (request.foreground) argv.push('--foreground');
    // 超时钳位到 [60000, 120000]（两代服务端接受范围的交集，见常量注释）。
    const timeoutMs = Math.min(Math.max(request.timeoutMs ?? EVAL_TIMEOUT_CEILING_MS, EVAL_TIMEOUT_FLOOR_MS), EVAL_TIMEOUT_CEILING_MS);
    argv.push('--timeout-ms', String(timeoutMs));
    for (const tab of request.claimTabs ?? []) argv.push('--claim-tab', String(tab));

    const source = buildEvaluationSource(request.code);
    const response = (await this.invoke(argv, source, SUBPROCESS_TIMEOUT_MS, request.signal)) as Record<string, unknown>;

    const task = response.task as TaskMetadata;
    if ((request.claimTabs?.length ?? 0) > 0 && task.reused) {
      throw new TabbitCliError({
        kind: 'tab-claim',
        code: 'CLAIM_REQUIRES_NEW_TASK',
        message: `Task "${request.task}" already exists, and tab claims are only honored when a task is created. Use a new task name to claim tabs.`,
      });
    }

    // 兼容两代 `nodejs` 输出（真机对照实测）：
    //  - 旧版（≤ Tabbit 1.10 / Cr150）：{ task, receipt }——receipt 里带
    //    requestId/status/result（result 有 type 判别）；
    //  - 新版（Tabbit 1.11+/Cr151）：顶层就是一张【扁平终态回执】
    //    { status, result, task, transition }——result 无 type 字段（inline
    //    有 value、溢出有 resourceId+byteLength），失败时错误在 result.error。
    // 注意 `receipt` 子命令两代都返回旧版包裹形（回执存储没变），所以只需
    // 在这里归一化，轮询路径照旧。
    let receipt = response.receipt !== undefined ? (response.receipt as Receipt) : normalizeFlatReceipt(response, requestId);
    receipt = await this.waitForTerminalReceipt(request.task, receipt);

    if (receipt.status === 'succeeded') {
      const result = await this.decodeReceiptResult(request.task, receipt, request.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES, notes);
      return { status: 'succeeded', result, task, taskWasReset, notes };
    }
    const errorMessage = extractReceiptError(receipt);
    return { status: 'failed', errorMessage, task, taskWasReset, notes };
  }

  /*
   * 回执轮询：正常情况下 `nodejs` 命令会阻塞到求值结束才返回终态回执，但
   * 边缘情况（CLI 等待窗口耗尽等）下可能拿到 queued/running。此时每 2 秒
   * 用 `receipt` 命令查一次，最多 20 次（40 秒）；到头了就把非终态回执
   * 原样返回，让上层把它当失败处理。
   */
  private async waitForTerminalReceipt(task: string, receipt: Receipt): Promise<Receipt> {
    let current = receipt;
    for (let poll = 0; poll < 20 && (current.status === 'queued' || current.status === 'running'); poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      current = (await this.invoke(['receipt', '--task', task, '--request', current.requestId], '', CONTROL_TIMEOUT_MS)) as Receipt;
    }
    return current;
  }

  /*
   * 从成功回执里取出并解码返回值：
   *  - 无 result 字段：视为 null；
   *  - inline：值就在回执里，直接解信封；
   *  - resource（结果 >8KiB 溢出成了资源文件）：分块读回文本——
   *      · 读完整了：先 JSON.parse（资源里存的是"包含信封字符串的 JSON"，
   *        即形如 `"b64:xxxx"` 的带引号文本）再解信封；parse 不动就把文本
   *        当 rawText 交上去；
   *      · 被字节上限截停：文本只是前缀（形如 `"b64:AAAA...` 掐头去尾都
   *        不完整），剥掉开头引号后按"不完整"模式解信封（codec 的宽松
   *        解码能救回前缀部分），并在 notes 里提醒模型返回值太大了。
   */
  private async decodeReceiptResult(
    task: string,
    receipt: Receipt,
    maxResultBytes: number,
    notes: string[],
  ): Promise<DecodedResult> {
    const result = receipt.result;
    if (!result) return { value: null, truncated: false };
    if (result.type === 'inline') return decodeEnvelope(result.value);

    const { text, complete } = await this.readResourceText(task, result.resourceId, maxResultBytes);
    if (!complete) {
      notes.push(
        `Result was ${result.byteLength} bytes; only the first ${maxResultBytes} bytes were read back. Return smaller values (or write files via artifactPath) for complete results.`,
      );
    }
    if (complete) {
      try {
        return decodeEnvelope(JSON.parse(text));
      } catch {
        return { rawText: text, truncated: true };
      }
    }
    // 不完整的资源：JSON 文本是形如 `"b64:AAAA...` 的前缀，剥掉引号解信封。
    const stripped = text.startsWith('"') ? text.slice(1) : text;
    return decodeEnvelope(stripped, false);
  }

  /*
   * 用 `resource` 命令分块读回一个溢出资源。
   * 协议：每次带 --offset 请求，返回 {data: 本块文本, nextOffset, eof}；
   * eof=true 表示读完。达到 maxBytes 上限就带着 complete:false 提前收手。
   * 中间那个防御分支：万一服务端返回畸形块（没有 nextOffset 或空 data），
   * 宁可当"没读完"返回也绝不无限自旋。
   */
  async readResourceText(task: string, resourceId: string, maxBytes: number): Promise<{ text: string; complete: boolean }> {
    let offset = 0;
    let text = '';
    for (;;) {
      const chunk = (await this.invoke(
        ['resource', '--task', task, '--resource', resourceId, '--offset', String(offset)],
        '',
        CONTROL_TIMEOUT_MS,
      )) as { data: string; nextOffset: number; eof: boolean };
      text += chunk.data;
      if (chunk.eof) return { text, complete: true };
      if (typeof chunk.nextOffset !== 'number' || chunk.data.length === 0) {
        // 防御：畸形块回复，绝不自旋。
        return { text, complete: false };
      }
      offset = chunk.nextOffset;
      if (offset >= maxBytes) return { text, complete: false };
    }
  }

  /*
   * 结束一个任务（`finish` 命令）。
   *
   * ── keep 语义的代际差异与兼容策略（issue #24）──────────────────────
   * 旧代（≤1.11.13）：缺省关闭，`--keep` 保留；未知的 `--discard` 被忽略。
   * 中间代（1.11.16 起）：缺省保留，`--discard` 关闭，仍接受 `--keep`。
   * 新代（1.13.20+）：缺省保留，`--discard` 关闭；参数校验已删除 `--keep`，
   *   传入它会在执行前报 REQUEST_FAILED，附带只列 [--discard] 的 finish 用法。
   * 因此 keep=true 先带 `--keep`，仅遇到上述参数拒绝时去掉 flag 重试一次；
   * 不能对任意失败都重试裸 finish，否则旧代可能关闭用户想保留的标签页。
   * keep=false 恒传 `--discard`：旧代忽略未知 flag 后按缺省关闭，其余代直接关闭。
   *
   * 三类错误吞掉不抛（视为"清理已达成"），但每次吞掉都【记一行日志】——
   * 吞错本身是对的，可完全无痕就没法排障（真机复现过：finish 打到漂移后的
   * 错误实例，命中 Unknown task name 被吞，调用方误以为成功，真正持有任务
   * 的实例上标签组一直挂着）：
   *  - Unknown task name：任务在【本实例】上不存在——可能确实早没了，也可能
   *    它活在另一个实例上（实例漂移场景），所以日志里特意带上实例 id 供对账；
   *  - browser-unavailable：浏览器都没在跑，任务自然也没了（不能为了 finish
   *    把浏览器拉起来）；
   *  - task-reset：服务重启过，旧任务已作废。
   * 其余错误照常抛出（调用方大多也会 catch 住做尽力而为清理）。
   */
  async finishTask(task: string, options: { keep?: boolean } = {}): Promise<void> {
    const argv = ['finish', '--task', task, options.keep ? '--keep' : '--discard'];
    try {
      try {
        await this.invoke(argv, '', CONTROL_TIMEOUT_MS);
      } catch (error) {
        // 只认新版 finish 的确切用法签名，不按浏览器版本猜测，也不把超时、
        // 执行失败或仍列 --keep 的旧版用法当作可重试信号。
        if (
          !options.keep ||
          !(error instanceof TabbitCliError) ||
          error.code !== CLI_ERROR_CODES.requestFailed ||
          !/^Usage: tabbit-cli finish --task <name> \[--discard\](?:\s*\||\s*$)/u.test(error.message)
        ) {
          throw error;
        }
        this.log(`finish --task "${task}": CLI rejected --keep; retrying with keep-by-default finish`);
        // 重试失败仍走外层的幂等清理规则；其余错误照常交给调用方。
        await this.invoke(['finish', '--task', task], '', CONTROL_TIMEOUT_MS);
      }
    } catch (error) {
      const instance = this.resolvedInstanceId() ?? 'unresolved';
      if (isUnknownTaskError(error)) {
        this.log(
          `finish --task "${task}" ignored: unknown task on instance ${instance} (already gone there; if its tab group is still visible, the task may live on a DIFFERENT instance)`,
        );
        return;
      }
      if (error instanceof TabbitCliError && (error.kind === 'browser-unavailable' || error.kind === 'task-reset')) {
        this.log(`finish --task "${task}" skipped on instance ${instance}: ${error.kind} (${error.message})`);
        return;
      }
      throw error;
    }
  }

  /* 打检查点（`checkpoint` 命令）——解除任务隔离状态的钥匙（见 evaluate 的恢复逻辑）。 */
  async checkpoint(task: string): Promise<unknown> {
    return await this.invoke(['checkpoint', '--task', task], '', CONTROL_TIMEOUT_MS);
  }

  /*
   * 把一个或多个可用（available）标签页追加认领进一个【已经存在】的任务
   * （`claim` 命令）。与 evaluate() 的 claimTabs 只在任务创建那一刻生效不同，
   * 这是独立的一次性 CLI 子命令——真机 `tabbit-cli --help` 的 usage 行确认过
   * 它是顶层动词（`claim --task <name> --tab <id>...`），不是只存在于 persistent
   * 帧协议里；真机验证过对一个此前已创建好的任务追加 claim 可行。
   * 批量原子：文档明确"duplicate, stale, busy, unsupported, or cross-window
   * inputs do not partially claim"——要么全部认领成功，要么整批失败并抛错，
   * 调用方不需要处理"部分成功"的中间态。
   */
  async claimTabs(task: string, tabIds: number[]): Promise<{ groupId?: string; ownedPageCount?: number }> {
    const argv = ['claim', '--task', task];
    for (const tab of tabIds) argv.push('--tab', String(tab));
    const response = (await this.invoke(argv, '', CONTROL_TIMEOUT_MS)) as { groupId?: unknown; ownedPageCount?: unknown };
    return {
      ...(typeof response.groupId === 'string' ? { groupId: response.groupId } : {}),
      ...(typeof response.ownedPageCount === 'number' ? { ownedPageCount: response.ownedPageCount } : {}),
    };
  }

  /*
   * 列出当前实例上的所有任务。两代 CLI 的入口不同（浏览器源码核对）：
   *   - 新代（1.13.20+）：`tasks` 子命令已删（提交 556476dd92b），改由不带
   *     --task 的 `diagnose` 在 tasks 字段里给出任务列表（条目是旧 `tasks`
   *     输出的超集：taskId/taskName/idle/quarantined/... 外加归属诊断）；
   *   - 旧代（≤1.13.8）：`diagnose` 只回计数、没有 tasks 字段，`tasks` 才是列表。
   * 所以先 `diagnose`（两代都存在、都不报错），没有 tasks 数组再退回 `tasks`。
   * 返回值形状异常时兜底为空数组。
   */
  async listTasks(): Promise<TaskListEntry[]> {
    const diagnosis = (await this.invoke(['diagnose'], '', CONTROL_TIMEOUT_MS)) as { tasks?: unknown } | undefined;
    if (Array.isArray(diagnosis?.tasks)) return diagnosis.tasks as TaskListEntry[];
    const value = await this.invoke(['tasks'], '', CONTROL_TIMEOUT_MS);
    return Array.isArray(value) ? (value as TaskListEntry[]) : [];
  }
}

/*
 * 把新版（Cr151 世代）`nodejs` 命令的扁平终态输出归一成旧版 Receipt 形状
 * （形状差异与实测样本见 evaluateOnce 里的注释）。要点：
 *  - result 无 type 判别：有 resourceId 视为溢出资源，否则带 value 键视为
 *    inline（值本身可以是 undefined/null，所以用 'value' in result 判断）；
 *  - 失败时错误在 result.error（字符串）；requestId 可能在顶层或 result 里，
 *    都没有就用我们自己生成的那个（轮询/日志用，语义不受影响）。
 */
function normalizeFlatReceipt(raw: Record<string, unknown>, fallbackRequestId: string): Receipt {
  const result = raw.result as
    | { value?: unknown; resourceId?: unknown; byteLength?: unknown; error?: unknown; requestId?: unknown }
    | undefined;
  const normalizedResult =
    result === undefined
      ? undefined
      : result.resourceId !== undefined
        ? { type: 'resource' as const, resourceId: String(result.resourceId), byteLength: Number(result.byteLength ?? 0) }
        : 'value' in result
          ? { type: 'inline' as const, value: result.value }
          : undefined;
  const requestId =
    typeof raw.requestId === 'string' ? raw.requestId : typeof result?.requestId === 'string' ? result.requestId : fallbackRequestId;
  const error = raw.error ?? result?.error;
  return {
    requestId,
    status: raw.status as Receipt['status'],
    ...(normalizedResult !== undefined ? { result: normalizedResult } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/*
 * 从失败回执里尽力抠出一条人话错误信息：
 * error 字段可能是字符串、带 message 的对象、或任意奇形怪状——逐层降级；
 * interrupted 状态（求值没跑完服务就重启了）给专门文案。
 */
function extractReceiptError(receipt: Receipt): string {
  const error = receipt.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    try {
      return JSON.stringify(error);
    } catch {
      /* 序列化不了就落到最后的兜底文案 */
    }
  }
  if (receipt.status === 'interrupted') return 'Evaluation was interrupted (runtime restarted before it settled).';
  return `Evaluation ${receipt.status} without an error message.`;
}

// 把底层的错误类型和实例类型一并转出去，上层只需要 import 本文件。
export { CLI_ERROR_CODES, TabbitCliError };
export type { TabbitInstance };
