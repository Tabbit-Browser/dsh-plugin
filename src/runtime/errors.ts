/*
 * ============================================================================
 * 文件职责：错误分类体系（error taxonomy）
 * ============================================================================
 *
 * 本文件定义了与 Tabbit Browser「Runtime Service」（浏览器内置的自动化运行时
 * 服务）打交道时可能遇到的所有错误类型。我们不直接连浏览器，而是通过命令行
 * 启动器（launcher，装在 ~/.local/bin/ 下，新名 `tabbit-cli`、旧名
 * `tabbit-playwright`）间接通信，所以错误会从好几个"层"冒出来：
 *
 *   第 1 层：launcher 外壳脚本（POSIX shell 脚本）自己失败
 *           —— 比如机器上装了多个 Tabbit 实例、它不知道选哪个。
 *           表现：stderr 上输出【纯文本】错误信息，进程退出码 69。
 *
 *   第 2 层：launcher 转交给的浏览器原生 CLI 失败
 *           —— 比如任务超时、浏览器没起来、任务队列满了。
 *           表现：stderr 上输出【一行 JSON】，形如
 *           `{"ok":false,"error":{name,code,message}}`，退出码 64/69/70。
 *
 *   第 3 层：子进程本身起不来（launcher 文件不存在/没有执行权限），
 *           或者我们这边等超时把它杀了。
 *
 * 上层代码（client.ts、tool-browser 等）拿到这里分类好的错误后，才能决定：
 * 该不该自动重试？该给模型/用户什么样的提示语？
 * 所有涉及具体错误码和退出码的知识，都是对真机 CLI 实测得来的（不是猜的）。
 */

/*
 * Runtime Service 在应用层（第 2 层）会报出的错误码常量表。
 * 键是我们自己起的驼峰名，值是 CLI 真实返回的错误码字符串。
 * 集中列在这里，是为了让 classifyAppError() 的 switch 不出现裸字符串。
 */
export const CLI_ERROR_CODES = {
  /* 浏览器或它的 Runtime Service 不可达（可能正在启动/已退出）。 */
  browserUnavailable: 'BROWSER_RUNTIME_UNAVAILABLE',
  /* 服务端并发已满，暂时忙。 */
  serviceBusy: 'SERVICE_BUSY',
  /* 单次求值超时（服务端上限：旧代 120 秒，1.13.23+ 为 180 秒）。 */
  taskTimeout: 'TASK_TIMEOUT',
  /* 任务数达到上限（整台机器最多 8 个并发任务）。 */
  taskLimitReached: 'TASK_LIMIT_REACHED',
  /* 单个任务的排队队列满了。 */
  taskQueueFull: 'TASK_QUEUE_FULL',
  /* 任务的 worker 进程丢了（浏览器崩溃/重启）——任务内所有状态已丢失。 */
  taskWorkerLost: 'TASK_WORKER_LOST',
  /* 服务"代际"（generation）不匹配——服务重启过，旧任务作废。 */
  generationMismatch: 'GENERATION_MISMATCH',
  /* 整个 Runtime Service 丢失。 */
  serviceLost: 'SERVICE_LOST',
  /* CLI 与服务端协议版本不匹配（浏览器和 launcher 版本差太多）。 */
  protocolMismatch: 'PROTOCOL_MISMATCH',
  /* 想 claim（认领）的标签页已被别的任务占有。 */
  tabOwnershipConflict: 'TAB_OWNERSHIP_CONFLICT',
  /* 兜底的通用请求失败码。 */
  requestFailed: 'REQUEST_FAILED',
  /* 提交的代码体积超限。 */
  codeTooLarge: 'CODE_TOO_LARGE',
  /* 返回结果体积超限。 */
  resultTooLarge: 'RESULT_TOO_LARGE',
  /* 公开端点不认识请求里的 op（1.13.20+ 删掉了 unbound tabs，见 endpoint.ts）。 */
  methodNotFound: 'METHOD_NOT_FOUND',
  /* 清单分页游标失效：两页之间标签页变了，服务端要求从头重新翻页。 */
  staleCursor: 'STALE_CURSOR',
} as const;

/*
 * 错误的"种类"（kind）——把上面几十种具体错误码收敛成十来个行为类别。
 * 上层只看 kind 做决策（重试？换措辞？直接放弃？），不用背具体错误码。
 */
export type TabbitErrorKind =
  /* launcher 外壳拒绝执行（纯文本 stderr，退出码 69）：通常是实例选择歧义。 */
  | 'instance-selection'
  /* launcher 可执行文件不存在或没有执行权限（用户没装/没启动过 Tabbit）。 */
  | 'launcher-missing'
  /* 浏览器或 Runtime Service 不可达（可短暂重试——浏览器可能正在自动拉起）。 */
  | 'browser-unavailable'
  /* 暂时性容量压力（并发满/队列满）——稍后重试即可。 */
  | 'busy'
  /* 任务的 worker 或整个服务代际没了：任务内的页面、globalThis 状态全部丢失。 */
  | 'task-reset'
  /* 任务被"隔离"（quarantine）：一次带副作用的求值被中断后，服务端拒绝接新活。
   *  旧版 CLI 可用 checkpoint 恢复；新版 CLI 没有该命令。 */
  | 'quarantined'
  /* 请求 claim 的标签页 id 认领失败。 */
  | 'tab-claim'
  /* 求值或调度超时（包括我们客户端这边把子进程杀掉的情况）。 */
  | 'timeout'
  /* 服务端报的其它应用级错误（没有更具体的归类）。 */
  | 'app'
  /* 我们看不懂 CLI 的输出（stdout 不是 JSON 之类）——协议层问题。 */
  | 'protocol';

/*
 * 统一的错误类：所有从 CLI 层冒出来的失败都被包装成这个类抛出。
 * 继承自 JS 内置的 Error，附加了四个字段方便上层判断与排障：
 *   - kind：行为类别（见上面的 TabbitErrorKind）
 *   - code：CLI 原始错误码（或我们自己造的，如 CLIENT_TIMEOUT）
 *   - exitCode：子进程退出码（没有则为 null）
 *   - stderrRaw：stderr 原文（排障时看）
 */
export class TabbitCliError extends Error {
  readonly kind: TabbitErrorKind;
  readonly code: string;
  readonly exitCode: number | null;
  readonly stderrRaw: string;

  constructor(options: {
    kind: TabbitErrorKind;
    code: string;
    message: string;
    exitCode?: number | null;
    stderrRaw?: string;
  }) {
    // super() 调用父类 Error 的构造函数，把 message 存进去。
    super(options.message);
    this.name = 'TabbitCliError';
    this.kind = options.kind;
    this.code = options.code;
    this.exitCode = options.exitCode ?? null;
    this.stderrRaw = options.stderrRaw ?? '';
  }
}

/*
 * "任务被隔离"没有专属错误码，只能靠错误信息文案匹配。
 * 服务端原文形如 "... is quarantined; checkpoint before submitting more work"。
 */
const QUARANTINE_PATTERN = /is quarantined; checkpoint before submitting more work/u;
/* "未知任务名"错误的文案前缀（对不存在的任务调 finish/receipt 时出现）。 */
const UNKNOWN_TASK_PATTERN = /^Unknown task name: /u;

/*
 * 把 CLI 返回的应用层错误对象（{name, code, message}）归类成 TabbitErrorKind。
 * 这是"错误码 → 行为类别"的唯一映射点。
 */
export function classifyAppError(error: { name?: string; code?: string; message?: string }): TabbitErrorKind {
  const code = error.code ?? CLI_ERROR_CODES.requestFailed;
  const message = error.message ?? '';
  switch (code) {
    case CLI_ERROR_CODES.browserUnavailable:
      return 'browser-unavailable';
    case CLI_ERROR_CODES.serviceBusy:
    case CLI_ERROR_CODES.taskQueueFull:
      return 'busy';
    // 下面三种码本质相同：任务/服务的"上一世"没了，之前的状态全部作废。
    case CLI_ERROR_CODES.taskWorkerLost:
    case CLI_ERROR_CODES.generationMismatch:
    case CLI_ERROR_CODES.serviceLost:
      return 'task-reset';
    case CLI_ERROR_CODES.tabOwnershipConflict:
      return 'tab-claim';
    case CLI_ERROR_CODES.taskTimeout:
      return 'timeout';
    default:
      // 隔离错误没有专属 code，只能从 message 文案里认。
      if (QUARANTINE_PATTERN.test(message)) return 'quarantined';
      return 'app';
  }
}

/*
 * 判断一个错误是不是"未知任务名"。
 * 用途：清理任务时（finishTask），任务可能早已不存在（浏览器重启过/用户手动
 * 关了）——这种情况视为"已经清理完成"，静默吞掉即可，不算失败。
 */
export function isUnknownTaskError(error: unknown): boolean {
  return error instanceof TabbitCliError && UNKNOWN_TASK_PATTERN.test(error.message);
}
