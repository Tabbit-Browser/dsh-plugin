/*
 * ============================================================================
 * 文件职责：核心模块——`ctx.tabbit` 服务 + 各种 dsh 宿主集成
 * ============================================================================
 *
 * 这是补丁行 `tabbit-core`（行名 = 裸包名 `dsh-tabbit`）加载的模块，
 * 是其它五个功能模块的共同地基。它做的事：
 *   1. 定义并提供 `ctx.tabbit` 服务（TabbitService 类）：settings 读取、
 *      TabbitClient 缓存、实例四级解析、会话任务登记、权限授权记忆、清理；
 *   2. 注册 settings 命名空间 `tabbit`（instance/launcherPath/pageAccess/intranetFetch）；
 *   3. 注册随包 skill `tabbit`（教模型怎么用工具的文档；与浏览器写入
 *      ~/.agents/skills/tabbit 的共享 skill 同名——刻意的，见 SKILL_NAME 注释）；
 *   4. 注册 `/tabbit-info` 诊断命令（不叫 /tabbit：userInvocable skill 的
 *      `/名字` 调用入口会与之撞名）；
 *   5. 往系统提示词里注入一小段"你有浏览器能力"的说明；
 *   6. 清理历史版本安装的"Tabbit 模式" agent preset（迁移，见 removeManagedPreset）。
 *
 * ─── 必备背景 1：dsh 与 Cordis 插件模型 ─────────────────────────────────
 *
 * DeepSeek Harness（dsh）构建在 Cordis 框架上。Cordis 的世界观：
 *
 *  - 【插件】= 一个导出 { name, inject, apply(ctx) } 的模块。
 *      · name：插件名（日志、调试用）；
 *      · inject：声明依赖哪些【服务】——只有这些服务全就绪，apply 才被调用；
 *      · apply(ctx)：插件的全部逻辑入口，ctx 是上下文对象。
 *
 *  - 【服务】= 挂在 ctx 上的具名能力。`ctx.provide('tabbit', 实例)` 发布服务；
 *    其它插件在 inject 里写 'tabbit' 后就能用 `ctx.tabbit` 拿到实例。
 *    dsh 自身的核心能力也都是服务：ctx.settings（设置）、ctx.tools（工具注册）、
 *    ctx.web（web 能力）、ctx.skills、ctx.commands、ctx.jobs（后台任务）、
 *    ctx.approval（用户审批）、ctx.webServer（HTTP 路由）等。
 *
 *  - 【ctx.inject(名单, 回调)】= "软依赖"：不阻塞本插件加载，等名单里的服务
 *    可用时再执行回调（服务卸载时回调注册的东西也随之回收）。本文件用它挂
 *    skills/commands/systemPrompt——这些服务不在时核心功能照常工作。
 *
 *  - 【ctx.effect(fn, 说明)】= 注册"副作用"：fn 返回一个清理函数，插件被
 *    卸载（disposal）时框架自动调用清理函数。这是 Cordis 的资源生命周期
 *    管理方式（类似 React useEffect）。
 *
 *  - 【ctx.on(事件名, 处理器)】= 订阅事件总线。本文件订阅 dsh 的
 *    `agent/disposed`（一个会话的 agent 被销毁）来触发浏览器任务清理。
 *
 * ─── 必备背景 2：bundle 机制与"为什么行名必须是裸包名" ────────────────
 *
 * dsh 的【bundle】= 一个 npm 包声明 package.json 的 `dsh.bundle.patch` 指向
 * 一份 cordis.patch.yml。dsh 装载 profile 时把补丁叠进插件组合表，按每行的
 * `name`（模块说明符）import 对应模块。行名可以用子路径导出
 * （dsh-tabbit/permissions 等），但【dsh-web 的客户端模块扫描只认裸包名行】：
 * 它靠裸名行找到包的 package.json，读其中 `dsh.client` 字段来发现并服务
 * 前端插件（client/client.js，即 @tab 提及）。所以本 core 模块的行名必须是
 * `dsh-tabbit` 本身，不能写成 `dsh-tabbit/core`。
 */
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Context } from '@deepseek-ai/cordis';
// schemastery：dsh 全家桶用的运行时 schema 校验库（惯例以 z 引入，用法类似 zod）。
import z from '@deepseek-ai/schemastery';

import { readHostVersion } from '../host-version.js';
import { TabbitClient } from '../runtime/client.js';
import { listAllTabs, type TabbitTabInventory } from '../runtime/endpoint.js';
import { TabbitCliError } from '../runtime/errors.js';
import { defaultLauncherPath, listInstances, type TabbitInstance } from '../runtime/instances.js';
import { checkPluginUpdate, prependUpdateNotice, readLocalVersion } from '../update-check.js';
import { migrateLegacySettings } from './legacy-settings.js';

// 下面这些 `import type {}` 是 TypeScript 的"类型副作用导入"：不引入任何
// 运行时代码，只为了让这些包对 Context 接口的类型扩充（declare module）生效，
// 这样 ctx.settings / ctx.skills / ctx.commands 等才有类型。
import type {} from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-skill';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-system-prompt';

/* settings 命名空间 `tabbit` 下的四个配置项（用户可在 dsh 设置界面或 settings.yaml 改，热加载）。 */
export interface TabbitSettings {
  /* 16 位 hex 的 Tabbit 实例 id；空 = 无歧义时自动选择。 */
  instance: string;

  /* launcher 路径覆盖；空 = 默认发现（优先 ~/.local/bin/tabbit-cli，回退旧名
   * tabbit-playwright；Windows 为 %LOCALAPPDATA%\Tabbit\LocalAgent\bin\tabbit-cli.exe）。 */
  launcherPath: string;

  /* 页面访问总闸（因为会带上用户登录态）：ask=每会话询问一次 / always=直接放行 / never=一律拒绝。 */
  pageAccess: 'ask' | 'always' | 'never';
  
  /* web_fetch 访问内网目标的附加闸：ask=每会话每 origin 询问一次 / always / never。 */
  intranetFetch: 'ask' | 'always' | 'never';
}

/* 旧版 settings.register 使用的模式。 */
export const SETTINGS_SCHEMA: z<TabbitSettings> = z.object({
  instance: z.string().default(''),
  launcherPath: z.string().default(''),
  pageAccess: z.union([z.const('ask'), z.const('always'), z.const('never')] as const).default('ask'),
  intranetFetch: z.union([z.const('ask'), z.const('always'), z.const('never')] as const).default('ask'),
});

/* 新版只把 volatile 字段投影到设置页；旧版仍从 SETTINGS_SCHEMA 读用户设置。 */
export const Config = z.object({
  instance: z.string().default('').volatile(),
  launcherPath: z.string().default('').volatile(),
  pageAccess: z.union([z.const('ask'), z.const('always'), z.const('never')] as const).default('ask').volatile(),
  intranetFetch: z.union([z.const('ask'), z.const('always'), z.const('never')] as const).default('ask').volatile(),
});

interface LiveValue<T> { get(): T }
type CurrentConfig = { [K in keyof TabbitSettings]: TabbitSettings[K] | LiveValue<TabbitSettings[K]> };

/* 新版字段是 Volatile<T>，旧版字段是 T；统一读成当前的普通值。 */
function readConfig(config: CurrentConfig): TabbitSettings {
  const value = <K extends keyof TabbitSettings>(key: K): TabbitSettings[K] => {
    const field = config[key];
    return typeof field === 'object' && field !== null && 'get' in field
      ? (field as LiveValue<TabbitSettings[K]>).get()
      : field as TabbitSettings[K];
  };
  return {
    instance: value('instance'),
    launcherPath: value('launcherPath'),
    pageAccess: value('pageAccess'),
    intranetFetch: value('intranetFetch'),
  };
}

/*
 * web_fetch 与 @tab 重取共用任务的固定名字。注意：任务名同时是浏览器里标签组的可见标题
 * （Runtime Service 没有独立标题字段），所以起成给用户看的样子。
 */
export const FETCH_TASK_NAME = 'DeepSeek Harness · Web Fetch';

/* 执行实例是怎么选出来的（四级优先，按顺序）。 */
export type InstanceSource = 'settings' | 'dsh-web-viewer' | 'environment' | 'auto';

export interface ResolvedInstance {
  id?: string;
  source: InstanceSource;
}

/*
 * ============================================================================
 * TabbitService —— 以 `ctx.tabbit` 名义提供给全家使用的核心服务
 * ============================================================================
 * 持有的全部状态都是【进程内内存】（不落盘）：dsh 重启即清零，这正是
 * "每会话询问一次"之类语义想要的。
 */
export class TabbitService {
  /* 缓存的 TabbitClient（按"实例id+launcher路径"作 key，配置变了就重建）。 */
  private cachedClient: TabbitClient | undefined;
  private cachedKey = '';
  /* 抓取与任务结束必须串行；否则下一次抓取可能在上一次 finish 前复用同一任务。 */
  private fetchTaskQueue: Promise<void> = Promise.resolve();
  /*
   * 会话任务登记表：agentId → 任务名 → 该任务【实际在哪些实例上执行过】。
   *
   * 为什么要记实例集合而不是只记任务名？——修过的一个真实 bug：
   * 会话结束清理时如果用"当下重新解析出来的实例"去 finish，而观看实例
   * （viewer）在会话期间漂移过（用户换了个 Tabbit 窗口看 dsh），finish 就会
   * 打到错误实例上、命中 "Unknown task name" 被静默吞掉——真正持有任务的
   * 实例永远收不到 finish，标签组就一直挂在用户浏览器里。
   * 所以每次求值成功都记下当时真正用的实例，清理时对【每个记过的实例】
   * 分别 finish。
   */
  private readonly sessionTaskRegistry = new Map<string, Map<string, Set<string | undefined>>>();
  /* agentId → 该会话已定型的默认任务名（首次调用即定型，之后复用）。 */
  private readonly defaultTaskNames = new Map<string, string>();
  /* 已通过"页面访问"授权的 agentId 集合（会话级记忆，成功一次不再问）。 */
  private readonly pageAccessGrants = new Set<string>();
  /* 内网访问授权：agentId → 已授权的 origin 集合（会话+origin 级记忆）。 */
  private readonly intranetGrants = new Map<string, Set<string>>();
  /* 共享 web_fetch 任务实际用过的实例集合（插件卸载时逐一 finish）。 */
  private readonly fetchTaskInstances = new Set<string | undefined>();
  /* 最近一次检测到的"正在观看 dsh-web 的 Tabbit 实例"（含时间戳）。 */
  private viewerInstance: { id: string; at: number } | undefined;

  // 构造参数是"读取 settings 的函数"而不是 settings 值本身——每次要用时
  // 现读，天然支持热更新（用户改设置立即生效，无需重启）。
  // logger 可选（apply 里接的是 dsh 的 ctx.logger）：会透传给每个 TabbitClient，
  // 让 finish 吞错、清理失败、隔离恢复这些原本静默的路径在 dsh 日志里留痕。
  constructor(
    private readonly readSettings: () => TabbitSettings,
    private readonly logger?: (message: string) => void,
  ) {}

  /* 记录当前观看 dsh web UI 的 Tabbit 实例（mentions 的 /tabbit/instance-hint 路由调用；后写覆盖先写）。 */
  setViewerInstance(id: string): void {
    this.viewerInstance = { id, at: Date.now() };
  }

  viewer(): { id: string; at: number } | undefined {
    return this.viewerInstance;
  }

  /*
   * 【实例四级解析】——多实例机器上"该在哪个 Tabbit 里执行"的决策，按优先级：
   *
   *  1. settings 显式指定（tabbit.instance）——用户说了算；
   *  2. 正在观看 dsh-web 的 Tabbit 实例（须仍在线）——"在哪看就在哪跑"，
   *     由 client 打点 + peer.ts 溯源检测（仅 macOS）；
   *  3. 继承的 TABBIT_PLAYWRIGHT_INSTANCE 环境变量——嵌入形态的权威通道
   *     （Tabbit 打包并启动自带 dsh 时，把自己的实例 id 注入环境变量）；
   *  4. auto：交给注册表自动选择（唯一在线实例就选它；否则由 runtime 客户端
   *     抛出带实例清单的引导错误）。
   */
  resolveExecutionInstance(): ResolvedInstance {
    const settings = this.readSettings();
    if (settings.instance !== '') return { id: settings.instance, source: 'settings' };
    const instances = listInstances();
    const viewer = this.viewerInstance;
    if (viewer !== undefined && instances.some((instance) => instance.id === viewer.id && instance.online)) {
      return { id: viewer.id, source: 'dsh-web-viewer' };
    }
    const fromEnv = process.env.TABBIT_PLAYWRIGHT_INSTANCE;
    if (
      fromEnv !== undefined &&
      fromEnv !== '' &&
      // 正常要求 env 指到的实例真在注册表里。Windows 注册表已能真实解析
      // （%LOCALAPPDATA%\Tabbit\LocalAgent\instances\*.json，见 instances.ts），
      // 但记录由浏览器的 host-integration 安装步骤写入，存在"浏览器装了、
      // 记录还没写"的窗口——注册表为空时放行 env 值兜底：它是嵌入形态的
      // 权威通道，真伪由原生 CLI 自己校验（选不中会报可解码的实例选择错误）。
      (instances.some((instance) => instance.id === fromEnv) || (process.platform === 'win32' && instances.length === 0))
    ) {
      return { id: fromEnv, source: 'environment' };
    }
    return { source: 'auto' };
  }

  currentSettings(): TabbitSettings {
    return this.readSettings();
  }

  /*
   * 拿一个（缓存的）TabbitClient。key 里包含解析出的实例 id 和 launcher 路径，
   * 任一变化（用户改设置、观看实例漂移）就重建客户端——保证永远用最新解析结果。
   */
  client(): TabbitClient {
    const settings = this.readSettings();
    const resolved = this.resolveExecutionInstance();
    const key = `${resolved.id ?? ''} ${settings.launcherPath}`;
    if (!this.cachedClient || this.cachedKey !== key) {
      this.cachedClient = new TabbitClient({
        // 条件展开语法：值存在才把该字段放进对象（避免显式传 undefined）。
        ...(resolved.id !== undefined ? { instanceId: resolved.id } : {}),
        ...(settings.launcherPath ? { launcherPath: settings.launcherPath } : {}),
        ...(this.logger ? { logger: this.logger } : {}),
      });
      this.cachedKey = key;
    }
    return this.cachedClient;
  }

  /* 每次抓取后结束任务并丢弃任务标签页；成功、导航失败和取消都走清理。 */
  async withFetchTask<T>(run: (client: TabbitClient) => Promise<T>): Promise<T> {
    const current = this.fetchTaskQueue.then(async () => {
      const client = this.client();
      this.markFetchTaskUsed(client.resolvedInstanceId());
      try {
        return await run(client);
      } finally {
        await client.finishTask(FETCH_TASK_NAME);
      }
    });
    this.fetchTaskQueue = current.then(() => undefined, () => undefined);
    return await current;
  }

  /*
   * 钉死在指定实例上的客户端，绕过实时解析。
   * 只用于清理路径：任务要在【它实际运行过的实例】上 finish，而不是清理时
   * 恰好解析出来的"当前"实例（那个会漂移，见 sessionTaskRegistry 的注释）。
   * instanceId 为 undefined（登记时实例都解析不出的极端情况）时退回尽力而为
   * 的当前解析。
   */
  private clientFor(instanceId: string | undefined): TabbitClient {
    if (instanceId === undefined) return this.client();
    const settings = this.readSettings();
    return new TabbitClient({
      instanceId,
      ...(settings.launcherPath ? { launcherPath: settings.launcherPath } : {}),
      ...(this.logger ? { logger: this.logger } : {}),
    });
  }

  /* 生效的 launcher 路径（settings 覆盖 > 默认位置）。 */
  launcherPath(): string {
    const settings = this.readSettings();
    return settings.launcherPath || defaultLauncherPath();
  }

  instances(): TabbitInstance[] {
    return listInstances();
  }

  /*
   * 全 profile 标签页清单（含用户自己开的页面）——【不经模型、不经 CLI 子进程】
   * 的直连读取（runtime/endpoint.ts；旧代浏览器一次 socket 请求 ~1ms，1.13.20+
   * 改在同一 socket 上投递 CLI `tabs` 分页拼全量），用户可见的副作用为零：
   * 不开页面、不建标签组（新代会用一个随机名的临时任务列完即 finish）。
   *
   * 实例定位与求值路径刻意不同：求值走 launcher（能自动拉起浏览器），清单是
   * 被动读取——【绝不能因为一次列表查询把浏览器拉起来】（同 mentions 里
   * roster 的既有原则），所以只对"已在线"的实例发起连接：
   *   - options.instanceId 显式指定：必须已注册，离线就如实报离线；
   *   - 未指定：沿用四级实例解析；解析结果为 auto 时选唯一在线实例，
   *     0 个在线报离线、多个在线报歧义（带清单的引导错误）。
   */
  async listAllTabs(options: { instanceId?: string; timeoutMs?: number } = {}): Promise<TabbitTabInventory> {
    const instances = listInstances();
    const wanted = options.instanceId ?? this.resolveExecutionInstance().id;
    let target: TabbitInstance | undefined;
    if (wanted !== undefined) {
      target = instances.find((instance) => instance.id === wanted);
      if (!target) {
        const roster = instances.map((instance) => `${instance.id} (${instance.appName})`).join(', ') || 'none';
        throw new TabbitCliError({
          kind: 'instance-selection',
          code: 'INSTANCE_SELECTION',
          message: `Tabbit instance ${wanted} is not registered. Available instances: ${roster}.`,
        });
      }
    } else {
      const online = instances.filter((instance) => instance.online);
      if (online.length === 1) {
        target = online[0];
      } else if (online.length === 0) {
        throw new TabbitCliError({
          kind: 'browser-unavailable',
          code: 'ENDPOINT_MISSING',
          message: 'No Tabbit Browser instance is currently running.',
        });
      } else {
        const roster = online.map((instance) => `${instance.id} (${instance.appName})`).join(', ');
        throw new TabbitCliError({
          kind: 'instance-selection',
          code: 'INSTANCE_SELECTION',
          message: `Multiple Tabbit Browser instances are online; pick one of: ${roster}.`,
        });
      }
    }
    return await listAllTabs(target.endpointPath, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  /*
   * 会话默认任务名——同时也是用户浏览器里那个标签组的【可见标题】
   * （Runtime Service 没有独立标题字段，任务名即标题）。
   *
   * 规则：【首次调用即定型】。之后的调用永远返回同一个名字，并【无视】新传
   * 的 label——因为换名字就等于换任务（浏览器状态、标签组全都是另一套了），
   * 会话中途换名会把之前的浏览器状态"弄丢"。
   *
   * 名字格式：`<label>-dsh-<id4>`，无 label 时是 `dsh-<id4>`。
   *  - label：模型经 tabbit_browser 工具的 label 参数传入的人话描述
   *    （如 "GitHub trending research"），让用户在浏览器里能看懂这组标签
   *    是干嘛的；
   *  - id4：agentId 去掉 "session-" 前缀后的前 4 个 hex 字符，是 dsh 会话 id
   *    的真实片段。它有两个不可去掉的作用：① 把浏览器里可见的标签组关联回
   *    具体 dsh 会话（/tabbit-info、CLI `tasks` 排障时对得上号）；② 防止不同会话
   *    撞出同一个任务名而共用一个任务。
   */
  defaultTaskFor(agentId: string, label?: string): string {
    const existing = this.defaultTaskNames.get(agentId);
    if (existing !== undefined) return existing;
    const shortId = agentId.replace(/^session-/u, '').slice(0, 4);
    const cleanLabel = sanitizeLabel(label);
    const name = cleanLabel !== '' ? `${cleanLabel}-dsh-${shortId}` : `dsh-${shortId}`;
    this.defaultTaskNames.set(agentId, name);
    return name;
  }

  /*
   * 只读查询当前已定型的默认任务名——不存在就返回 undefined，绝不像
   * defaultTaskFor 那样顺手创建并定型一个新名字（给 list_tasks 之类的查询
   * 路径用：查询本身不该有"顺带开一个任务"的副作用）。
   */
  currentDefaultTask(agentId: string): string | undefined {
    return this.defaultTaskNames.get(agentId);
  }

  /* 登记抓取任务在某实例上被用过（供 releaseAll 补偿清理）。 */
  markFetchTaskUsed(instanceId: string | undefined): void {
    this.fetchTaskInstances.add(instanceId);
  }

  /* 登记"某会话的某任务在某实例上执行过"（tool-browser 每次求值成功后调用）。 */
  rememberSessionTask(agentId: string, taskName: string, instanceId: string | undefined): void {
    let tasks = this.sessionTaskRegistry.get(agentId);
    if (!tasks) {
      tasks = new Map();
      this.sessionTaskRegistry.set(agentId, tasks);
    }
    let instances = tasks.get(taskName);
    if (!instances) {
      instances = new Set();
      tasks.set(taskName, instances);
    }
    instances.add(instanceId);
  }

  /* 某会话名下登记过的任务名列表（mentions 的 @tab 候选用它圈定范围）。 */
  sessionTasks(agentId: string): string[] {
    return [...(this.sessionTaskRegistry.get(agentId)?.keys() ?? [])];
  }

  /*
   * 忘掉一个本会话已不再拥有的任务——模型在会话中途显式 finish 了它
   * （tabbit_browser 的 finish 参数）。两件事：
   *  1. 从清理登记表里删掉（会话结束时不再对它重复 finish）；
   *  2. 若它恰是本会话的默认任务：把默认名也删掉，让下一次不带 task 的调用
   *     重新定名（可携带新 label）、开新任务——而不是复用一个已关闭的名字。
   */
  forgetTask(agentId: string, taskName: string): void {
    this.sessionTaskRegistry.get(agentId)?.delete(taskName);
    if (this.defaultTaskNames.get(agentId) === taskName) {
      this.defaultTaskNames.delete(agentId);
    }
  }

  /* 该会话是否已获得"页面访问"授权（permissions 模块查询）。 */
  hasPageAccessGrant(agentId: string): boolean {
    return this.pageAccessGrants.has(agentId);
  }

  grantPageAccess(agentId: string): void {
    this.pageAccessGrants.add(agentId);
  }

  /* 会话级内网访问授权查询，按 URL origin（协议+主机+端口）为粒度。 */
  hasIntranetGrant(agentId: string, origin: string): boolean {
    return this.intranetGrants.get(agentId)?.has(origin) ?? false;
  }

  grantIntranet(agentId: string, origin: string): void {
    let origins = this.intranetGrants.get(agentId);
    if (!origins) {
      origins = new Set();
      this.intranetGrants.set(agentId, origins);
    }
    origins.add(origin);
  }

  /*
   * 会话结束清理（`agent/disposed` 事件触发）：忘掉该会话的授权与默认任务名，
   * 并把它的每个浏览器任务【在每个实际执行过的实例上】分别 finish。
   * 尽力而为：单个 finish 失败不影响其它任务的清理，但会记一行日志——
   * 清理是无人盯着的静默路径，不留痕就没法排查"标签组没关掉"类问题。
   * （finishTask 内部吞掉的三类"视为已达成"错误在 client 层各自记日志；
   * 这里的 catch 接的是其余真失败，如 151.x 的 INVALID_STATE 竞态。）
   */
  async releaseAgent(agentId: string): Promise<void> {
    this.pageAccessGrants.delete(agentId);
    this.intranetGrants.delete(agentId);
    this.defaultTaskNames.delete(agentId);
    const tasks = this.sessionTaskRegistry.get(agentId);
    this.sessionTaskRegistry.delete(agentId);
    if (!tasks) return;
    await Promise.all(
      [...tasks].flatMap(([taskName, instanceIds]) =>
        [...instanceIds].map((instanceId) =>
          this.clientFor(instanceId)
            .finishTask(taskName)
            .catch((error: unknown) => {
              this.logger?.(
                `session cleanup: finish failed for task "${taskName}" on instance ${instanceId ?? 'unresolved'}: ${String((error as Error)?.message ?? error)}`,
              );
            }),
        ),
      ),
    );
  }

  /*
   * 全量清理（插件卸载/dsh 退出时经 ctx.effect 触发）：结束本插件创建过的
   * 一切任务——所有会话任务 + 共享 fetch 任务，同样按"任务×实例"逐对 finish。
   */
  async releaseAll(): Promise<void> {
    await this.fetchTaskQueue;
    const targets: Array<{ taskName: string; instanceId: string | undefined }> = [];
    for (const tasks of this.sessionTaskRegistry.values()) {
      for (const [taskName, instanceIds] of tasks) {
        for (const instanceId of instanceIds) targets.push({ taskName, instanceId });
      }
    }
    for (const instanceId of this.fetchTaskInstances) targets.push({ taskName: FETCH_TASK_NAME, instanceId });
    this.sessionTaskRegistry.clear();
    this.defaultTaskNames.clear();
    this.pageAccessGrants.clear();
    this.intranetGrants.clear();
    this.fetchTaskInstances.clear();
    await Promise.all(
      targets.map(({ taskName, instanceId }) =>
        this.clientFor(instanceId)
          .finishTask(taskName)
          .catch((error: unknown) => {
            this.logger?.(
              `disposal cleanup: finish failed for task "${taskName}" on instance ${instanceId ?? 'unresolved'}: ${String((error as Error)?.message ?? error)}`,
            );
          }),
      ),
    );
  }
}

// TypeScript 的"模块扩充"（module augmentation）：向 Cordis 的 Context 接口
// 声明我们的 tabbit 服务，让所有 import 了本模块类型的文件都能安全地写
// `ctx.tabbit`。这是 Cordis 生态注册服务类型的标准姿势。
declare module '@deepseek-ai/cordis' {
  interface Context {
    tabbit: TabbitService;
  }
}

const MAX_LABEL_LENGTH = 48;

/*
 * 清洗模型给的 label：压缩连续空白为单个空格、去首尾空白、截断到 48 字符。
 * 必须清洗——这个字符串会原样成为用户浏览器里可见的标签组标题。
 */
function sanitizeLabel(label: string | undefined): string {
  if (label === undefined) return '';
  return label.replace(/\s+/gu, ' ').trim().slice(0, MAX_LABEL_LENGTH);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 随包 skill 注册
 *
 * dsh 的 skill 机制：一份 SKILL.md（教模型做某类事的文档），模型按需加载进
 * 上下文。dsh 的 skills 服务通过【provider】发现 skill：provider 提供
 * list()（列出候选"卡片"：名字/描述/rank，【不含正文】）和 get()（按候选取
 * 正文）。分两段是有讲究的：卡片常驻模型上下文，模型靠 description 决定值不
 * 值得花 token 读正文；正文只在真被调用时才落进上下文。
 * 我们注册一个 provider，把包内 skills/tabbit/ 目录端上去。
 *
 * 【元数据只有一个事实源：SKILL.md 的 frontmatter】。这里曾经硬编码过一份
 * SKILL_DESCRIPTION，于是文件顶部 frontmatter 里的 description 成了死字符串
 * ——改它不生效，两处措辞越漂越远。dsh 本来就为此留了位置（SkillCandidate
 * 的 metadata 字段定义原文："parsed optional metadata object from
 * provider-specific skill frontmatter"），所以改成读文件解析。
 * ──────────────────────────────────────────────────────────────────────────── */

/*
 * skill 的运行时身份。刻意不从 frontmatter 取：系统提示词段落和 tabbit_browser
 * 的工具 description 里都硬写着这个名字，改 frontmatter 改不动它们——名字归
 * 代码管，frontmatter 里的 name 是给人和其它读 SKILL.md 的工具看的。
 *
 * 【为什么叫 tabbit 而不是 tabbit-browser（2026-08-28 方案二决策）】：
 * 浏览器安装时会把官方 skill 写到共享目录 ~/.agents/skills/tabbit/（随浏览器
 * 更新，内容与 Runtime 同步演进），dsh 的 skill-filesystem provider 原生扫描
 * 该目录（user-agents 根，rank 500）。同名去重规则（近层直接胜出/同层 rank
 * 小者胜）下，本包这份 rank 600 的随包副本便自动成为【兜底】：装了新浏览器
 * 的机器用共享版，没装/老浏览器的机器用包内版。名字必须相同这套优先级才
 * 生效——不同名会变成两个 skill 并列出现。
 */
const SKILL_NAME = 'tabbit';
// import.meta.url 是当前模块文件的 file:// URL；new URL(相对路径, 它) 得到
// 包内其它文件的稳定定位——无论包被装到哪里都正确（比 __dirname 更 ESM）。
const SKILL_URL = new URL('../../skills/tabbit/SKILL.md', import.meta.url);
const SKILL_RESOURCE_BASE = {
  kind: 'directory',
  // resourceBase 指向 skill 目录：SKILL.md 里引用的 references/*.md 由此解析。
  path: fileURLToPath(new URL('../../skills/tabbit/', import.meta.url)),
} as const;
/* 模型可自主加载、用户也可手动调用。 */
const SKILL_INVOCATION = { modelInvocable: true, userInvocable: true } as const;
/*
 * dsh 约定：随 npm 包一起发布的 skill 用 rank 600（区分于用户自建等来源）；
 * 重名时 rank【小】者胜，同 rank 再比 provider 注册顺序。
 * dsh-skill 自己也导出了同值的 BUNDLED_SKILL_RANK，这里仍然本地声明——本文件
 * 对所有 dsh 包都是 `import type {}` 的纯类型引用，换成值导入会让插件在没装
 * 该 peer 包的组合里直接加载失败，为一个常量不值当。
 */
const BUNDLED_SKILL_RANK = 600;
const SKILL_PROVIDER_NAME = 'dsh-tabbit-bundled-skill';
/*
 * 只在 frontmatter 被改坏（缺 description）时兜底：dsh 的 validateCandidate 会
 * 拒收空描述的候选，没有兜底就等于整个 skill 从目录里消失。
 */
const SKILL_FALLBACK_DESCRIPTION =
  "Recipes for operating the user's Tabbit Browser through the tabbit_browser tool. Load before non-trivial browser work.";

/*
 * 拆开 SKILL.md：返回 frontmatter 解析出的字段 + 去掉 frontmatter 的正文
 * （正文才是要进模型上下文的内容）。
 * 只认我们自己写的这一层【扁平 key: value】（值可带引号），认不出的行直接
 * 跳过——不为一个几行的 frontmatter 引入 YAML 依赖，也不假装能解析嵌套结构。
 * 开合分隔符按开头是 \n 还是 \r\n 定档、全程沿用同一种换行符（含内部按行
 * split 取字段）——容忍 Windows checkout（git autocrlf）产出的 CRLF 文件，
 * 不强行改写正文本身的换行风格。
 */
export function parseSkillDocument(source: string): { fields: Record<string, string | undefined>; body: string } {
  const newline = source.startsWith('---\r\n') ? '\r\n' : '\n';
  const opening = `---${newline}`;
  if (!source.startsWith(opening)) return { fields: {}, body: source };
  const closing = `${newline}---${newline}`;
  const end = source.indexOf(closing, opening.length);
  if (end === -1) return { fields: {}, body: source };
  const fields: Record<string, string | undefined> = {};
  for (const line of source.slice(opening.length, end).split(newline)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(line);
    if (match === null) continue;
    // 去掉整体包裹的成对引号（YAML 里 description: "..." 很常见）。
    const value = match[2].trim().replace(/^(['"])([\s\S]*)\1$/u, '$2');
    if (value !== '') fields[match[1]] = value;
  }
  return { fields, body: source.slice(end + closing.length) };
}

/*
 * 读盘 + 解析，组装 dsh 要的两样东西：候选卡片（list 用）与正文（get 用）。
 * 每次现读：SKILL.md 改了下一次发现就生效，文件只有几 KB，读盘成本可忽略。
 * signal：provider 契约要求发现流程能被调用方取消，直接透给 readFile。
 * 读失败就让它抛——dsh 注册表会 catch 住、打一行
 * `skill provider "…" skipped: …` 警告并跳过本 provider，比静默返回空目录
 * （"skill 莫名其妙不见了"）好排查得多。
 */
async function loadSkillDocument(signal?: AbortSignal) {
  const source = await readFile(SKILL_URL, { encoding: 'utf8', ...(signal ? { signal } : {}) });
  const { fields, body } = parseSkillDocument(source);
  return {
    candidate: {
      name: SKILL_NAME,
      description: fields.description ?? SKILL_FALLBACK_DESCRIPTION,
      // whenToUse 是 dsh 的可选路由补充字段：frontmatter 写了就带上。
      ...(fields.whenToUse !== undefined ? { whenToUse: fields.whenToUse } : {}),
      invocation: SKILL_INVOCATION,
      provider: SKILL_PROVIDER_NAME,
      source: 'bundled',
      resourceBase: SKILL_RESOURCE_BASE,
      rank: BUNDLED_SKILL_RANK,
      // locator 是 provider 私有句柄（dsh 原样传回 get()）；path 供宿主展示。
      locator: SKILL_URL,
      path: fileURLToPath(SKILL_URL),
      metadata: fields,
    },
    content: body,
  };
}

/*
 * skill provider 本体：list 列卡片，get 按名取正文。
 * get 返回正文前经 prependUpdateNotice 过一道（../update-check.ts）：有新版
 * 时在正文顶部插一段更新通知（由模型转告用户）；检查失败/无新版/浏览器
 * 托管（预装）形态下原样返回，绝不拖慢或搞坏 skill 加载。传入的 checkUpdate
 * 闭包带上 host-version.ts 读到的当前宿主版本，让"有新版"的判断把宿主兼容性
 * 也算进去（见 update-check.ts 文件头的宿主兼容性过滤说明）。
 * export 仅为单元测试（tests/plugin.test.mjs 直接调 list/get）。
 */
export const skillProvider = {
  name: SKILL_PROVIDER_NAME,
  async list(options: { signal?: AbortSignal } = {}) {
    const { candidate } = await loadSkillDocument(options.signal);
    return [candidate];
  },
  async get(selected: { name: string }, options: { signal?: AbortSignal } = {}) {
    if (selected.name !== SKILL_NAME) return undefined;
    const { candidate, content } = await loadSkillDocument(options.signal);
    return {
      ...candidate,
      content: await prependUpdateNotice(content, () => checkPluginUpdate({ hostVersion: readHostVersion() })),
    };
  },
};

/*
 * 注入系统提示词的段落：让模型【一开始就知道】自己有真浏览器能力、状态会
 * 跨调用持久、以及安全底线（别拿用户的浏览器干破坏性的事）。
 * 不写这段的话，模型要等到看见工具列表才隐约知道，用法也容易跑偏。
 */
const PROMPT_SECTION_TEXT = [
  'Tabbit Browser integration: the `tabbit_browser` tool runs Playwright code inside the',
  "user's real Tabbit Browser profile (shared logged-in sessions), and `web_fetch` retrieves",
  'pages through that browser. Browser state persists across calls within a session task.',
  'Load the `tabbit` skill before non-trivial browser work. Treat the browser as the',
  "user's own: no destructive account actions, no visiting sensitive services unasked.",
].join(' ');

/* 历史版本 preset 的所有权标记文件名（目录里有它 = 目录归本插件管）。 */
const PRESET_MARKER = '.dsh-tabbit-managed';

/* $DSH_HOME 的解析：环境变量优先，缺省 ~/.dsh（与 dsh 本体一致）。 */
function dshHome(): string {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh');
}

/*
 * 【迁移清理】移除历史版本安装的「Tabbit 模式」agent preset
 * （`$DSH_HOME/.agent-presets/tabbit`）。
 *
 * 这个 preset 曾经存在的唯一理由：老版本 dsh 自带的 preset 把
 * `tool-web.fetch` 写死为 false，而 bundle 补丁层够不到 preset 文件。
 * dsh 0.1.2-alpha.1 起标准 preset 已自带 `fetch: true`，preset 使命终结；
 * 且旧快照里的配置键（如 backgroundMode）在新版 dsh 里已改名，留着反而会
 * 让「Tabbit 模式」会话挂载失败。
 *
 * 所有权标记协议照旧生效：
 *  - 有 `.dsh-tabbit-managed` 标记 → 归我们管，整目录删除；
 *  - 无标记（用户删标记接管过/自建同名目录）→ 绝不碰。
 */
async function removeManagedPreset(): Promise<void> {
  const targetDir = join(dshHome(), '.agent-presets', 'tabbit');
  if (!existsSync(targetDir) || !existsSync(join(targetDir, PRESET_MARKER))) return;
  await rm(targetDir, { recursive: true, force: true });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Cordis 插件导出三件套（dsh 加载本模块时读取的约定导出）
 * ──────────────────────────────────────────────────────────────────────────── */

export const name = 'tabbit-core';
// 硬依赖 settings 服务：它就绪后 apply 才会被调用。
export const inject = ['settings'];

/* 插件入口：dsh 加载 `dsh-tabbit` 行时调用，完成全部注册。 */
export function apply(ctx: Context, config: CurrentConfig): void {
  // 旧版向 settings 注册命名空间；新版直接读 Config 的实时字段。
  const settings = ctx.settings as unknown as {
    register?: (name: string, schema: z<TabbitSettings>) => { get(): TabbitSettings };
  };
  const legacyScope = settings.register?.('tabbit', SETTINGS_SCHEMA);
  const service = new TabbitService(
    () => legacyScope?.get() ?? readConfig(config),
    // 把 dsh 日志器接给服务与底层客户端：finish 吞错/清理失败/隔离恢复这些
    // 原本静默的路径由此在 dsh 日志里可见（排查实例漂移导致标签组残留的关键痕迹）。
    (message) => ctx.logger.info(`dsh-tabbit: ${message}`),
  );
  // ② 发布 ctx.tabbit 服务——其它五个模块 inject: ['tabbit'] 等的就是这句。
  ctx.provide('tabbit', service);

  // DSH 0.2 会把旧 settings.yaml 改名为 .imported，但无法把 tabbit 节自动映射
  // 到本包的 tabbit-browser 行。迁移只在新版运行，且不阻塞服务启动。
  if (legacyScope === undefined) {
    void migrateLegacySettings(ctx).catch((error: unknown) => {
      ctx.logger.warn(`dsh-tabbit: legacy settings migration failed: ${String((error as Error)?.message ?? error)}`);
    });
  }

  // ③ 迁移清理：移除历史版本安装的 Tabbit 模式 preset（异步发起，失败只
  //    告警不阻塞插件加载；无标记的用户自管目录绝不触碰）。
  void removeManagedPreset().catch((error: unknown) => {
    ctx.logger.warn(`dsh-tabbit: legacy managed preset cleanup failed: ${String((error as Error)?.message ?? error)}`);
  });

  // ④ 注册插件卸载清理：effect 的回调返回"清理函数"，插件被卸载（或 dsh
  //    退出）时框架调用它 → 结束我们创建过的所有浏览器任务。
  ctx.effect(() => () => {
    void service.releaseAll();
  }, 'dsh-tabbit: finish browser tasks on disposal');

  // ⑤ 订阅 dsh 的 agent/disposed 事件：一个会话的 agent 销毁时，清理该会话
  //    的任务与授权（标签组随之从用户浏览器里消失）。
  ctx.on('agent/disposed', ({ agent }) => {
    void service.releaseAgent(String(agent.id));
  });

  // ⑥ 软依赖 skills 服务：可用时注册我们的 skill provider。
  //    （as never 同样是为了绕过 dsh 对第三方 provider 形状的窄类型。）
  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.skills.registerProvider(() => skillProvider as never);
  });

  // ⑦ 软依赖 systemPrompt 服务：注入提示词段落（order 决定它在提示词里的位置）。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'tabbit',
      order: 150,
      text: PROMPT_SECTION_TEXT,
    });
  });

  // ⑧ 软依赖 commands 服务：注册 /tabbit-info 诊断命令（用户在 dsh 输入框里
  //    敲）。不叫 /tabbit：skill 已改名 tabbit 且 userInvocable——dsh 里用户
  //    可用 `/名字` 直接调用 skill，命令名与之撞名会互相遮蔽。
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'tabbit-info',
      description: 'Show Tabbit Browser integration status: launcher, instances, tasks, permissions.',
      handler: async () => {
        try {
          const report = await renderStatus(service, readLocalePreference(ctx.settings));
          // 整份报告只放进 CommandResult.text，由宿主落成它自己认识的
          // command/done 事件。【不要】改回 session.append 自定义事件类型：
          // 宿主持久层对不认识的事件类型只认信封上的 ignorable 标记，而
          // Session.append 没有设置该标记的入口——0.3.3 及之前落下的
          // tabbit/status 事件让整个会话在冷加载时被拒读（issue #22）。宿主
          // 提供 ignorable 通道前，本插件不得向会话日志追加任何自定义事件
          // 类型（见 AGENTS.md）。
          return { kind: 'success', text: report };
        } catch (error) {
          return { kind: 'error', text: `tabbit status failed: ${String((error as Error)?.message ?? error)}` };
        }
      },
    });
  });
}

/*
 * /tabbit-info 首行结论的用户语言。locale.preference 由 dsh 的 locale 插件
 * 注册（zh/en，存用户设置文档）；未设置时 dsh 客户端跟随浏览器语言并兜底
 * en——服务端看不到浏览器语言，因此同样兜底 en，与 dsh 的 FALLBACK_LOCALE
 * 取向一致（浏览器没点名 shipped 语言时，读中文的可能性最低）。
 */
function readLocalePreference(settings: Context['settings']): 'zh' | 'en' {
  const source = settings as unknown as {
    get?: (name: string) => unknown;
    describe?: () => { ns: string; value?: unknown }[];
  };
  const legacy = source.get?.('locale') as { preference?: unknown } | undefined;
  const current = source.describe?.().find((entry) => entry.ns === 'locale')?.value as { preference?: unknown } | undefined;
  return (legacy?.preference ?? current?.preference) === 'zh' ? 'zh' : 'en';
}

/*
 * 首行结论：用户在收起的命令行上能扫到的只有这一行，所以按“是否需要
 * 用户采取行动”给结论——未安装提醒装/启动、未运行提醒启动、多实例时
 * 告知会优先用最近使用的实例，正常时给一句可读的状态摘要。明细行保持
 * 英文技术格式（可直接贴进 issue），不复述结论。
 */
function statusConclusion(
  service: TabbitService,
  settings: TabbitSettings,
  launcher: string,
  locale: 'zh' | 'en',
): string {
  const t = (zh: string, en: string) => (locale === 'zh' ? zh : en);
  if (!existsSync(launcher)) {
    return t(
      '⚠️ 未找到 Tabbit 浏览器——请先启动（或安装）Tabbit Browser，再运行 /tabbit-info',
      '⚠️ Tabbit Browser not found — launch (or install) Tabbit Browser first, then rerun /tabbit-info',
    );
  }
  const onlineInstances = service.instances().filter((instance) => instance.online);
  if (onlineInstances.length === 0) {
    return t(
      '⚠️ Tabbit 浏览器已安装但未在运行——请启动 Tabbit Browser 后重试',
      '⚠️ Tabbit Browser is installed but not running — launch Tabbit Browser and retry',
    );
  }
  if (!settings.instance && onlineInstances.length > 1) {
    // 多实例不再当警告：正常使用中 dsh-web 的观看实例打点（viewer）几乎
    // 总在，解析会落在"当前正在看 dsh 的那个实例"上；需要锁死再设
    // tabbit.instance（明细行里保留了这条提示）。
    return t(
      `✅ 检测到 ${onlineInstances.length} 个在线 Tabbit 浏览器实例，会优先使用最近使用的实例`,
      `✅ ${onlineInstances.length} Tabbit Browser instances online — preferring the most recently used one`,
    );
  }
  const resolved = service.resolveExecutionInstance();
  const execution =
    resolved.id !== undefined
      ? t(`${resolved.id}（来源 ${resolved.source}）`, `${resolved.id} (via ${resolved.source})`)
      : t('唯一在线实例（auto）', 'the single online instance (auto)');
  return t(
    `✅ Tabbit 集成正常——${onlineInstances.length} 个实例在线，执行实例 ${execution}`,
    `✅ Tabbit integration OK — ${onlineInstances.length} instance(s) online, executing on ${execution}`,
  );
}

/*
 * /tabbit-info 命令的输出渲染：首行结论（跟随用户语言），空行，然后是
 * 插件与宿主版本、实例列表（在线/选中标记 + 多实例提示）、生效实例及来源、
 * 观看实例、权限设置、任务占用表。
 *
 * 版本行放明细第一行：排障时第一个要确认的就是"跑的到底是哪个版本"——
 * dsh profile 里 link 到本地 checkout、装了多份、改了声明没重新 install 等
 * 情况下，"以为在跑的版本"和"实际加载的版本"经常不是一回事（真机踩过：
 * package.json 已改指新 checkout，node_modules 里的符号链接还指着旧仓库）。
 * 插件版本来自本包 package.json（update-check.ts 的 readLocalVersion），宿主
 * 版本来自 host-version.ts；任一读不到就如实标 unknown / 省略，绝不因此让
 * 整份报告失败。
 */
async function renderStatus(service: TabbitService, locale: 'zh' | 'en'): Promise<string> {
  const settings = service.currentSettings();
  const launcher = service.launcherPath();
  const lines: string[] = [];
  lines.push(statusConclusion(service, settings, launcher, locale));
  lines.push('');

  const pluginVersion = (await readLocalVersion()) ?? '(version unknown)';
  const hostVersion = readHostVersion();
  lines.push(`plugin: dsh-tabbit ${pluginVersion}${hostVersion !== undefined ? ` · host dsh ${hostVersion}` : ''}`);

  const instances = service.instances();
  if (instances.length === 0) {
    lines.push('instances: none registered');
  } else {
    lines.push('instances:');
    for (const instance of instances) {
      const marks = [instance.online ? 'online' : 'offline', settings.instance === instance.id ? 'selected' : '']
        .filter(Boolean)
        .join(', ');
      lines.push(`  - ${instance.id}  ${instance.appName}  (${marks})`);
    }
    if (!settings.instance && instances.filter((instance) => instance.online).length > 1) {
      lines.push('  ! multiple instances online — set settings key tabbit.instance to one of the ids above');
    }
  }

  const resolved = service.resolveExecutionInstance();
  if (resolved.id !== undefined) {
    lines.push(`execution instance: ${resolved.id} (via ${resolved.source})`);
  } else {
    lines.push('execution instance: auto (single online instance, else guided error)');
  }
  const viewer = service.viewer();
  if (viewer !== undefined) {
    lines.push(`dsh-web viewer: ${viewer.id} (detected ${new Date(viewer.at).toISOString()})`);
  }

  lines.push(`permissions: pageAccess=${settings.pageAccess}, intranetFetch=${settings.intranetFetch}`);

  // 任务列表只在"有在线实例（查询不会有副作用）或全机只装一个实例"时查询：
  // 浏览器全离线时任何 CLI 调用都会把浏览器拉起来——诊断命令不该有这种副作用。
  const online = instances.some((instance) => instance.online);
  if (online || instances.length === 1) {
    try {
      const tasks = await service.client().listTasks();
      if (tasks.length === 0) {
        lines.push('tasks: none');
      } else {
        lines.push(`tasks (${tasks.length}/8):`);
        for (const task of tasks) {
          const flags = [task.idle ? 'idle' : 'active', task.quarantined ? 'QUARANTINED' : ''].filter(Boolean).join(', ');
          lines.push(`  - ${task.taskName}  (${flags})`);
        }
      }
    } catch (error) {
      lines.push(`tasks: unavailable (${String((error as Error)?.message ?? error)})`);
    }
  } else {
    lines.push('tasks: browser offline (skipped to avoid launching it)');
  }
  return lines.join('\n');
}
