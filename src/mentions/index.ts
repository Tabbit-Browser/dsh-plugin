/*
 * ============================================================================
 * 文件职责：`@tab` 提及的服务端半边 + 观看实例打点路由
 * ============================================================================
 *
 * `@tab` 提及是一个"前后端合作"的功能：
 *  - 前端半边在 client/client.js（跑在 dsh 网页里）：输入框敲 `@` 时列出
 *    候选标签页、选中插 chip、发送时序列化 chip；
 *  - 本文件是后端半边：四条挂在 dsh `webServer` 服务上的 loopback HTTP 路由，
 *    给前端提供数据，外加一个不挂路由、直接注册在 agent 事件上的钩子。
 *
 * ─── 背景：dsh 的 webServer 服务 ─────────────────────────────────────────
 * dsh 起的本机 HTTP 服务器（服务 web UI 的那个）开放了路由注册点：
 * `ctx.webServer.register({kind:'exact', path, handler})` 挂精确路径的处理器，
 * handler 拿到原生 Node 的 (IncomingMessage, ServerResponse)。前端页面和这些
 * 路由同源，fetch 直接打过来。
 *
 * 四条路由：
 *  - GET  /tabbit/mention/tabs?session=<会话id>
 *      @ 候选列表的数据源，两段合并：①该会话浏览器任务里打开的页面
 *      （kind:'task-page'）；②用户浏览器里的普通标签页（kind:'user-tab'，
 *      直连端点清单，仅 state=available——busy 的是某个自动化任务已认领的，
 *      与任务页重复；且仅 http/https、非新标签页，见 mentionableUserTabUrl）。
 *      两段各自失败互不拖累。
 *  - GET  /tabbit/tabs[?instance=<16位大写hex>]
 *      【全 profile】标签页清单（含用户自己开的页面）——直连 Runtime Service
 *      端点读取（runtime/endpoint.ts，~1ms、零副作用、不拉起浏览器），给本机
 *      程序化消费方用。与 roster 不同，这条路由的失败如实回 4xx/5xx。
 *  - POST /tabbit/mention/extract
 *      提取被提及页面的标题+正文（用户点发送时由 chip 的序列化逻辑调用）。
 *      两种请求体：
 *        {"task","url","index"} —— 任务页：在所属任务里就地读取（live 状态）；
 *        {"url","userTab":true} —— 用户标签页：在 fetch 任务里【重新
 *      打开该 URL】提取后结束任务（与 web_fetch 同机制，共享登录态）。不直接读
 *      用户标签页本体是刻意的：就地读取必须先 claim——那会把用户的标签页
 *      可见地挪进代理标签组，对一次提及来说过于侵入。代价是拿到的是该 URL
 *      的新副本而非用户页面的实时状态（表单输入、滚动位置等不包含）。
 *      提取到的正文【不会】原样回给前端：本路由把它暂存进下面的
 *      extractionStash，只回一个一次性 token（见 stashExtraction/
 *      consumeStash）。前端 codec.serialize() 只拿 token 拼一个短标记塞进
 *      发出去的文本，聊天气泡里不会直接堆出整段网页正文。
 *  - POST /tabbit/instance-hint
 *      观看实例打点：网页加载时前端 ping 一下，服务端把这条 TCP 连接溯源到
 *      具体 Tabbit 实例（peer.ts），记为首选执行实例。
 *
 * ─── 正文怎么从"暂存"变成模型看得见的上下文（agent/pre-step 钩子）────────
 *
 * dsh 的 agent 在每一步即将把消息交给模型前会触发 `agent/pre-step`（瀑布式
 * 事件，处理器收到 (payload, next)：调 next() 拿到下游已经处理过的决定，
 * 可以在其基础上再改 messages 后原样返回——src/permissions/index.ts 头部
 * 注释里 tools/pre-execute 瀑布是同一种机制，这里是 agent 版）。
 * 本文件在 apply() 里注册这个钩子：扫描本次即将进入模型的每条【用户】消息
 * 文本，找 `@[标题](tabbit-tab:token)` 这样的标记——命中就：
 *   1. 用 token 从 extractionStash 取回（并清掉）之前 /tabbit/mention/extract
 *      暂存的完整正文；
 *   2. 把消息里的标记文本替换成干净的 "@标题"（用户看到的气泡不再有标记
 *      痕迹）；
 *   3. 在这条消息后面紧跟着插入一条【独立】的消息，source 标成
 *      {kind:'plugin', plugin:'dsh-tabbit', form:'notice'}——dsh 把这种
 *      source.kind 不是 'user' 的消息渲染成默认折叠的"Context injection"
 *      行，而不是普通聊天气泡，正文（含 <browser-tab> 包装）就放在这条
 *      消息里。模型两条都会看到，用户默认只看到一行可展开的提示。
 * 这与 dsh 内置的 @文件/@对话 提及是同一套机制（dsh-session-reference 包
 * 的 ctx.on('agent/pre-step', ...) 就是这么把引用的会话正文接进去的）——
 * MessageSourceMap 的 'plugin' 分支就是官方留给三方插件的扩展点，不需要
 * 改宿主代码。
 *
 * 范围说明：@ 候选列表目前仍只覆盖代理自己任务里开的（或被显式 claim 的）
 * 页面——因为 extract 只能对任务内页面执行；用户标签页要先经 claim 接管才能
 * 提取，@ 提及升级为全量候选是后续工作。枚举本身已不受限：新一代 Runtime
 * Service 的 unbound tabs 清单（/tabbit/tabs 路由）就是为此开的口。
 *
 * 隐私边界：/tabbit/tabs 暴露的是用户整个浏览器的标签页元数据（标题+URL），
 * 敏感度高于 roster——与其它路由同样只接受本机回环访问；它不做逐次审批
 * （路由处理器没有开启中的 turn，接不了 ctx.approval），消费方应自律只在
 * 用户明确交互（如 @ 菜单展开、明确的列表命令）时调用。
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Context } from '@deepseek-ai/cordis';
import { boundContextSummary, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm';

import { FETCH_TASK_NAME } from '../core/index.js';
import { TabbitCliError } from '../runtime/errors.js';
import { listInstances } from '../runtime/instances.js';
import { instanceIdForPeerPort } from '../runtime/peer.js';

import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-host-webserver';

/*
 * 各路由里浏览器求值的超时与提取上限。求值超时统一 60 秒：1.13.23+ 的 CLI
 * 拒绝更小的 --timeout-ms（client.ts 会抬到 60 秒），写小了只是自欺——候选
 * 清单与提取的代码本身都是毫秒级，这个值只在页面卡死时才起作用。
 * 直连清单（listAllTabs）不经 CLI、不受该下限约束，单独给一个短超时。
 */
const EVAL_TIMEOUT_MS = 60_000;
const INVENTORY_TIMEOUT_MS = 15_000;
const EXTRACT_MAX_CHARS = 60_000;

/*
 * 提取正文的暂存有效期：从 /tabbit/mention/extract 写入到 agent/pre-step
 * 消费之间正常只有几百毫秒（用户点发送 → 该条消息进入下一步），10 分钟是
 * 给"发送后消息迟迟没进入任何一步"（比如用户切走、会话卡住）的宽松兜底，
 * 而不是预期路径。过期或已被消费的 token 在 pre-step 里会被当作"取不回"
 * 处理（见 expandTabMentions），不影响这条消息本身发送成功。
 */
const EXTRACT_STASH_TTL_MS = 10 * 60 * 1000;
/* 前端 codec.serialize() 拼出的短标记：@[标题](tabbit-tab:token)。 */
const TAB_MENTION_MARKER = /@\[([^\]]*)\]\(tabbit-tab:([a-zA-Z0-9-]+)\)/gu;

export const name = 'tabbit-mentions';
export const inject = ['tabbit'];

export function apply(ctx: Context): void {
  // 提取结果的暂存表：/tabbit/mention/extract 写入，agent/pre-step 钩子
  // 消费。挂在 apply() 的闭包里而不是模块顶层——同一进程多次 apply()
  // （测试、插件重载）不会共享状态。
  const stash = new Map<string, StashedExtraction>();

  // agent/pre-step 钩子不依赖 webServer（发消息不需要网页在场），无条件注册。
  registerContextInjection(ctx, stash);

  // 软依赖 webServer：无 web 服务器的组合（纯 CLI 形态）下本模块静默不装。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.webServer.register({
      kind: 'exact',
      path: '/tabbit/mention/tabs',
      handler: (req, res) => handleRoster(ctx, req, res),
    });
    webCtx.webServer.register({
      kind: 'exact',
      path: '/tabbit/tabs',
      handler: (req, res) => handleAllTabs(ctx, req, res),
    });
    webCtx.webServer.register({
      kind: 'exact',
      path: '/tabbit/mention/extract',
      handler: (req, res) => handleExtract(ctx, stash, req, res),
    });
    webCtx.webServer.register({
      kind: 'exact',
      path: '/tabbit/instance-hint',
      handler: (req, res) => handleInstanceHint(ctx, req, res),
    });
  });
}

/* /tabbit/mention/extract 暂存的一条提取结果；createdAt 供 TTL 清扫用。 */
interface StashedExtraction {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  refetched?: true;
  createdAt: number;
}

/*
 * 写入一条暂存记录，返回供前端携带的一次性 token。
 * 顺手清扫过期记录（惰性：只在有新写入时扫一遍，不另开定时器）——正常
 * 路径里 token 活不过几百毫秒就被消费掉，这里清的都是异常路径遗留的。
 */
function stashExtraction(stash: Map<string, StashedExtraction>, entry: Omit<StashedExtraction, 'createdAt'>): string {
  const cutoff = Date.now() - EXTRACT_STASH_TTL_MS;
  for (const [token, existing] of stash) {
    if (existing.createdAt < cutoff) stash.delete(token);
  }
  const token = randomUUID();
  stash.set(token, { ...entry, createdAt: Date.now() });
  return token;
}

/* 按 token 取回并【立即删除】——一次性凭据，重放拿不到第二次。 */
function consumeStash(stash: Map<string, StashedExtraction>, token: string): StashedExtraction | undefined {
  const entry = stash.get(token);
  if (entry === undefined) return undefined;
  stash.delete(token);
  return entry;
}

/*
 * agent/pre-step 钩子：见文件头"正文怎么从暂存变成模型看得见的上下文"。
 * 瀑布式事件——先 next() 拿下游已经处理过的决定，'reject' 原样放行；
 * 'enter' 才有 messages 可改，改完原样按同一形状返回。
 */
function registerContextInjection(ctx: Context, stash: Map<string, StashedExtraction>): void {
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    const expanded = await Promise.all(decision.messages.map((message) => expandTabMentions(message, stash)));
    return { ...decision, messages: expanded.flat() };
  });
}

/*
 * 展开一条消息里的所有 tabbit-tab 标记：
 *  - 没有标记的消息（包括非用户消息）原样返回，不多分配；
 *  - 有标记：标记替换成干净的 "@标题"（这条消息本身，用户在气泡里看到的
 *    形态，见 chipMention），每个标记额外产出一条 source.kind='plugin' 的
 *    兄弟消息（dsh 渲染成默认折叠的 Context injection 行），紧跟在这条
 *    消息后面——顺序即引用顺序，模型读起来跟用户打字的顺序一致。
 */
async function expandTabMentions(message: UserMessage, stash: Map<string, StashedExtraction>): Promise<UserMessage[]> {
  if (message.source.kind !== 'user') return [message];
  const siblings: UserMessage[] = [];
  let matchedAny = false;
  const content = message.content.map((block): ContentBlock => {
    if (block.type !== 'text') return block;
    const text = block.text.replace(TAB_MENTION_MARKER, (_whole, title: string, token: string) => {
      matchedAny = true;
      const chip = chipMention(title);
      const entry = consumeStash(stash, token);
      // 取不到（过期/已消费/进程重启丢了内存）：只留干净的标题文本，不附
      // 正文——这是异常路径的兜底，不静默伪造内容，也不让整条消息发送失败
      // （token 只是"附件"，消息本体已经真实发出去了）。
      if (entry === undefined) return chip;
      siblings.push(buildTabContextMessage(entry));
      return chip;
    });
    return { ...block, text };
  });
  if (!matchedAny) return [message];
  return [freezeMessage({ ...message, content }), ...siblings];
}

/*
 * 把标题包成宿主聊天气泡认得的"一整块"引用文案。
 *
 * 宿主转录装饰器（dsh-client-ui-primitives 的 user-text.tsx）用这条正则
 * 识别"@ 引用"：/(^|\s)(\/[\w-]+|@"[^"\n]+"|@[^\s]+)/——裸 @标题 在第一个
 * 空白处就断了（真机验证过的 bug：《Example Domain》只有《Example》被
 * 框进 chip，《 Domain》漏在外面变成普通文字）。带引号的 @"..." 才会被
 * 当成一整块——这也是 dsh 自己的 @文件 提及给带空格路径加引号的同一招。
 * 引号形态的展示逻辑还会把内容按 / 或 \ 分段只取最后一段（抄的是文件路径
 * 展示），所以引号内的斜杠必须先换成形近的全角符号，否则形如
 * "GitHub - foo/bar" 的标题会被裁到只剩 "bar"——这一手只影响这行展示
 * 文案，不影响 <browser-tab> 里模型看到的真实标题。
 * 标题本身干净（无空白/引号/斜杠）时用裸 @标题——更接近人眼里"这是一个
 * 提及"的直觉，没必要为了统一而处处加引号。
 */
function chipMention(rawTitle: string): string {
  const title = rawTitle.replace(/[\r\n]+/gu, ' ').trim().slice(0, 80) || 'tab';
  if (!/["\\/\s]/u.test(title)) return `@${title}`;
  const quoted = title.replace(/"/gu, "'").replace(/\\/gu, '＼').replace(/\//gu, '／');
  return `@"${quoted}"`;
}

/* 把一条暂存的提取结果包装成独立的上下文消息（<browser-tab> 文本块）。 */
function buildTabContextMessage(entry: StashedExtraction): UserMessage {
  const sourceAttr = entry.refetched === true ? ' source="refetched-copy"' : '';
  const truncatedNote = entry.truncated ? '\n[content truncated]' : '';
  const text = `<browser-tab url="${xmlAttrEscape(entry.url)}" title="${xmlAttrEscape(entry.title)}"${sourceAttr}>\n${entry.text}${truncatedNote}\n</browser-tab>`;
  return createUserMessage({
    source: {
      kind: 'plugin',
      plugin: 'dsh-tabbit',
      form: 'notice',
      summary: boundContextSummary(`Fetched "${entry.title || entry.url}"`),
    },
    content: [{ type: 'text', text }],
  });
}

/* 文本转义（url/title 嵌进 <browser-tab ...> 标签属性前）。 */
function xmlAttrEscape(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;');
}

/*
 * 观看实例打点路由。安全设计两条硬规则：
 *  1. 【身份取自 socket，不信请求体】——req.socket.remotePort 是操作系统层
 *     的事实，页面伪造不了；请求体里说什么我们一概不读。
 *  2. 【同源 Origin 校验】——浏览器对跨源 POST 一定带 Origin 头（fetch 规
 *     范如此）；不校验的话，用户在【别的】浏览器里开的任意恶意网页都能向
 *     http://127.0.0.1:<dsh端口>/tabbit/instance-hint 发 no-cors POST，把
 *     首选执行实例翻转到攻击者期望的实例上。
 * 溯源细节（lsof/ps 父链匹配 browserPid）见 runtime/peer.ts。
 * 溯源失败不报错：返回 detected:null（正常现象——用 Chrome 看 dsh 就必然
 * 溯不到 Tabbit）。
 */
async function handleInstanceHint(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!hostAllowed(req)) return sendJson(res, 403, { error: 'forbidden' });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
  const origin = req.headers.origin;
  const host = req.headers.host ?? '';
  if (typeof origin !== 'string' || new URL(origin).host !== host) {
    return sendJson(res, 403, { error: 'cross-origin hint rejected' });
  }
  try {
    const peerPort = req.socket.remotePort ?? 0;
    const detected = await instanceIdForPeerPort(peerPort, listInstances());
    if (detected !== undefined) ctx.tabbit.setViewerInstance(detected);
    sendJson(res, 200, { detected: detected ?? null });
  } catch (error) {
    sendJson(res, 200, { detected: null, note: String((error as Error)?.message ?? error) });
  }
}

/* Host 头校验：只接受本机回环地址的访问（这些路由不该被局域网里其它机器打到）。 */
function hostAllowed(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').toLowerCase();
  return host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]');
}

/* 统一的 JSON 响应写出（no-store：这些数据都是即时状态，禁止缓存）。 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/*
 * 圈定"该会话名下【确实还活着】的任务"。三道保守过滤：
 *  1. 只看 ctx.tabbit 登记过的任务（本会话自己创建过的）；
 *  2. 浏览器全离线就直接返回空——绝不能因为一个 @ 候选查询把浏览器拉起来；
 *  3. 与服务端 `tasks` 实况求交集——【绝不隐式创建任务】：对不存在的任务
 *     调 evaluate 会创建它并开出一个空白标签页，用户会莫名其妙看到浏览器
 *     里多了个标签组。
 */
async function existingSessionTasks(ctx: Context, sessionId: string): Promise<string[]> {
  const registered = ctx.tabbit.sessionTasks(sessionId);
  if (registered.length === 0) return [];
  if (!ctx.tabbit.instances().some((instance) => instance.online)) return [];
  const live = await ctx.tabbit.client().listTasks();
  const liveNames = new Set(live.map((task) => task.taskName));
  return registered.filter((task) => liveNames.has(task));
}

/* 候选清单里的条目（两种 kind 的并集；client.js 按 kind 决定提取方式）。 */
interface RosterEntry {
  kind: 'task-page' | 'user-tab';
  url: string;
  title: string;
  /* task-page 专属：所属任务名 + 页在任务内的序号（extract 按此定位）。 */
  task?: string;
  index?: number;
  /* user-tab 专属：清单描述符的定位字段（tabId 供 claim 流使用）。 */
  tabId?: number;
  windowId?: number;
  active?: boolean;
  /* 所在标签组的标题（有组才带；纯展示）。 */
  group?: string;
}

/*
 * 用户标签页可否作为 @ 候选。两条硬规则：
 *  1. 只收 http/https——提及的兑现方式是"共享 fetch 任务里重取该 URL"，而
 *     chrome:// chrome-extension:// file:// about: 等 Playwright 一律
 *     ERR_BLOCKED_BY_CLIENT 打不开（真机验证）：候选必须能兑现内容，列出
 *     注定失败的页面等于给用户埋一个"点发送就报错"的雷。本地文件类内容
 *     走 dsh 自带的文件提及即可覆盖。
 *  2. 滤掉新标签页（pathname 恰为 /newtab 的产品 newtab 页）——空页对提及
 *     没意义。about:blank 被规则 1 顺带覆盖。
 */
function mentionableUserTabUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return parsed.pathname !== '/newtab';
  } catch {
    return false;
  }
}

/*
 * 候选清单路由：两段数据合并，各自失败互不拖累（note 记原因）。
 *
 * ① 任务页（kind:'task-page'）：对该会话每个活任务跑一段只读求值，列出任务
 *    里所有页面的 {index, url, title}。查询串在下面模板字符串里（用注入全局
 *    pages() 遍历，title() 失败单页容错）。
 * ② 用户标签页（kind:'user-tab'）：ctx.tabbit.listAllTabs() 直连端点清单，
 *    只收 state=available（busy 的已被某个自动化任务认领——即①里的页面，
 *    收了就重复；owned 在无绑定连接上不会出现），滤掉空白页/新标签页；
 *    排序：当前活跃页最前，其余按窗口、标签条位置。
 *
 * 整体失败也回 200 + 空列表（前端的 @ 菜单绝不应该因为我们报错而炸掉）。
 * 不变量保持：本路由绝不拉起浏览器（①只查已存在任务；②直连端点天然不拉起）。
 */
async function handleRoster(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!hostAllowed(req)) return sendJson(res, 403, { error: 'forbidden' });
  const sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('session') ?? '';
  if (sessionId === '') return sendJson(res, 400, { error: 'missing session' });
  const tabs: RosterEntry[] = [];
  const notes: string[] = [];

  try {
    const tasks = await existingSessionTasks(ctx, sessionId);
    for (const task of tasks) {
      const outcome = await ctx.tabbit.client().evaluate({
        task,
        readOnly: true,
        timeoutMs: EVAL_TIMEOUT_MS,
        // ⚠️ 下面是发往浏览器执行的代码原文，勿在字符串内加注释。
        code: `const out = [];
const list = pages();
for (let i = 0; i < list.length; i++) {
  const p = list[i];
  let title = '';
  try { title = await p.title(); } catch {}
  out.push({ index: i, url: p.url(), title });
}
return out;`,
      });
      if (outcome.status !== 'succeeded') continue;
      const value = outcome.result?.value;
      if (!Array.isArray(value)) continue;
      // 返回值来自浏览器侧求值，形状逐字段校验后再收录。
      for (const entry of value) {
        if (typeof entry !== 'object' || entry === null) continue;
        const { index, url, title } = entry as { index?: unknown; url?: unknown; title?: unknown };
        if (typeof url !== 'string' || url === 'about:blank') continue;
        tabs.push({
          kind: 'task-page',
          task,
          index: typeof index === 'number' ? index : 0,
          url,
          title: typeof title === 'string' ? title : '',
        });
      }
    }
  } catch (error) {
    notes.push(`task pages unavailable: ${String((error as Error)?.message ?? error)}`);
  }

  try {
    const inventory = await ctx.tabbit.listAllTabs({ timeoutMs: INVENTORY_TIMEOUT_MS });
    const userTabs = inventory.tabs
      .filter((tab) => tab.state === 'available' && mentionableUserTabUrl(tab.url))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.windowId - b.windowId || a.index - b.index)
      .map(
        (tab): RosterEntry => ({
          kind: 'user-tab',
          url: tab.url,
          title: tab.title,
          tabId: tab.tabId,
          windowId: tab.windowId,
          index: tab.index,
          ...(tab.active ? { active: true } : {}),
          ...(tab.group !== null && tab.group.title !== '' ? { group: tab.group.title } : {}),
        }),
      );
    tabs.push(...userTabs);
  } catch (error) {
    // 典型原因：浏览器离线（直连不拉起）、多实例歧义。@ 菜单退回只有任务页。
    notes.push(`user tabs unavailable: ${String((error as Error)?.message ?? error)}`);
  }

  sendJson(res, 200, { tabs, ...(notes.length > 0 ? { note: notes.join('; ') } : {}) });
}

/*
 * 全 profile 标签页清单路由。与 roster 的两点不同：
 *  1. 数据来源是直连端点的 unbound tabs 清单（ctx.tabbit.listAllTabs），
 *     覆盖用户自己开的页面，不需要任何会话/任务存在；
 *  2. 面向程序化消费方，失败如实回状态码（离线 503、实例问题 409、其余 500）
 *     ——不像 roster 那样为保 @ 菜单永远回 200。
 * ?instance=<16位大写hex> 可显式指定实例；不带时沿用服务的四级实例解析。
 */
async function handleAllTabs(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!hostAllowed(req)) return sendJson(res, 403, { error: 'forbidden' });
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' });
  const instanceParam = new URL(req.url ?? '/', 'http://localhost').searchParams.get('instance');
  if (instanceParam !== null && !/^[0-9A-F]{16}$/u.test(instanceParam)) {
    return sendJson(res, 400, { error: 'instance must be a 16-hex uppercase id' });
  }
  try {
    const inventory = await ctx.tabbit.listAllTabs({
      ...(instanceParam !== null ? { instanceId: instanceParam } : {}),
    });
    sendJson(res, 200, inventory);
  } catch (error) {
    const cliError = error instanceof TabbitCliError ? error : undefined;
    const status =
      cliError?.kind === 'browser-unavailable' ? 503 : cliError?.kind === 'instance-selection' ? 409 : 500;
    sendJson(res, status, {
      error: String((error as Error)?.message ?? error),
      ...(cliError ? { code: cliError.code } : {}),
    });
  }
}

/* 读取并解析 JSON 请求体，64KiB 上限（防恶意大包）。for-await 逐块累积。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += (chunk as Buffer).byteLength;
    if (bytes > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/*
 * 校验浏览器求值返回的提取结果形状、暂存正文、组装回给前端的响应
 * （token 取代 text——见文件头"暂存"说明）。两个提取分支（任务页/用户
 * 标签页）共用，后者额外传 refetched:true。
 */
function stashAndRespond(
  stash: Map<string, StashedExtraction>,
  raw: Record<string, unknown>,
  extra: { refetched?: true } = {},
): { url: string; title: string; truncated: boolean; refetched?: true; token: string } {
  const url = typeof raw.url === 'string' ? raw.url : '';
  const title = typeof raw.title === 'string' ? raw.title : '';
  const text = typeof raw.text === 'string' ? raw.text : '';
  const truncated = raw.truncated === true;
  const token = stashExtraction(stash, { url, title, text, truncated, ...extra });
  return { url, title, truncated, ...extra, token };
}

/*
 * 提取路由：把被提及页面的标题+正文抓出来（chip 序列化时调用）。
 *
 * 流程：校验参数 → 确认任务还活着（404 而不是隐式创建）→ 只读求值提取 →
 * 暂存正文、回一次性 token（见 stashAndRespond）。
 * 提取脚本逻辑（模板字符串内，参数经 JSON.stringify 注入防逃逸）：
 *   先按 URL 精确找页（用户选 chip 后页面可能导航走了，URL 是最强身份）；
 *   找不到再按当时的 index 兜底；都没有就报"页面已关闭"。
 *   正文取 article/main/[role=main] 或 body 的 innerText，60k 字符截断。
 *
 * 与 roster 的一个区别：这里的失败要如实回 4xx/5xx——前端拿到错误会【阻断
 * 发送】（用户以为引用了页面内容、实际没引上，静默降级是更糟的体验）。
 */
async function handleExtract(ctx: Context, stash: Map<string, StashedExtraction>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!hostAllowed(req)) return sendJson(res, 403, { error: 'forbidden' });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
  let body: { task?: unknown; url?: unknown; index?: unknown; userTab?: unknown };
  try {
    body = (await readJsonBody(req)) as typeof body;
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON body' });
  }
  const task = typeof body.task === 'string' ? body.task : '';
  const url = typeof body.url === 'string' ? body.url : '';
  const index = typeof body.index === 'number' ? body.index : -1;
  if (body.userTab === true) {
    if (url === '') return sendJson(res, 400, { error: 'url is required' });
    // 重取只对 http/https 可行（roster 已按此过滤；这里防直接调用方）。
    if (!/^https?:\/\//u.test(url)) {
      return sendJson(res, 400, { error: 'only http(s) tabs can be mentioned; this page type cannot be re-fetched' });
    }
    return extractUserTab(ctx, stash, url, res);
  }
  if (task === '' || url === '') return sendJson(res, 400, { error: 'task and url are required' });

  try {
    const live = new Set((await ctx.tabbit.client().listTasks()).map((entry) => entry.taskName));
    if (!live.has(task)) return sendJson(res, 404, { error: `task "${task}" no longer exists` });

    const outcome = await ctx.tabbit.client().evaluate({
      task,
      readOnly: true,
      timeoutMs: EVAL_TIMEOUT_MS,
      // ⚠️ 下面是发往浏览器执行的代码原文，勿在字符串内加注释。
      code: `const wantedUrl = ${JSON.stringify(url)};
const wantedIndex = ${JSON.stringify(index)};
const list = pages();
let p = list.find((candidate) => candidate.url() === wantedUrl);
if (!p && wantedIndex >= 0 && wantedIndex < list.length) p = list[wantedIndex];
if (!p) throw new Error('mentioned tab is no longer open');
let title = '';
try { title = await p.title(); } catch {}
const data = await p.evaluate(() => {
  const root = document.querySelector('article, main, [role="main"]') || document.body;
  return root ? root.innerText || '' : '';
});
let text = data;
let truncated = false;
if (text.length > ${EXTRACT_MAX_CHARS}) { text = text.slice(0, ${EXTRACT_MAX_CHARS}); truncated = true; }
return { url: p.url(), title, text, truncated };`,
    });
    if (outcome.status !== 'succeeded') {
      return sendJson(res, 500, { error: outcome.errorMessage ?? 'extraction failed' });
    }
    sendJson(res, 200, stashAndRespond(stash, (outcome.result?.value ?? {}) as Record<string, unknown>));
  } catch (error) {
    sendJson(res, 500, { error: String((error as Error)?.message ?? error) });
  }
}

/*
 * 用户标签页的提取：在抓取任务（FETCH_TASK_NAME，与 web_fetch
 * 同一个）里开新页重取该 URL——共享用户登录态，但【不触碰】用户的原标签页
 * （不 claim、不挪组、不抢焦点）。取完关页并结束任务。
 * 结果带 refetched:true，前端把它标进 <browser-tab> 块，让模型知道内容是
 * 该 URL 的新副本、不是用户页面的实时状态。
 * 失败如实回 5xx——前端拿到错误会阻断发送（同任务页提取的语义）。
 */
async function extractUserTab(ctx: Context, stash: Map<string, StashedExtraction>, url: string, res: ServerResponse): Promise<void> {
  try {
    const outcome = await ctx.tabbit.withFetchTask(async (client) => client.evaluate({
      task: FETCH_TASK_NAME,
      readOnly: true,
      timeoutMs: EVAL_TIMEOUT_MS,
      // ⚠️ 下面是发往浏览器执行的代码原文，勿在字符串内加注释。
      code: `const target = ${JSON.stringify(url)};
const p = await context.newPage();
try {
  try {
    await p.goto(target, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch (error) {
    throw new Error('navigation failed: ' + String((error && error.message) || error));
  }
  await p.waitForTimeout(400);
  let title = '';
  try { title = await p.title(); } catch {}
  const data = await p.evaluate(() => {
    const root = document.querySelector('article, main, [role="main"]') || document.body;
    return root ? root.innerText || '' : '';
  });
  let text = data;
  let truncated = false;
  if (text.length > ${EXTRACT_MAX_CHARS}) { text = text.slice(0, ${EXTRACT_MAX_CHARS}); truncated = true; }
  return { url: p.url(), title, text, truncated };
} finally {
  try { await p.close(); } catch {}
}`,
    }));
    if (outcome.status !== 'succeeded') {
      return sendJson(res, 500, { error: outcome.errorMessage ?? 'extraction failed' });
    }
    const value = (outcome.result?.value ?? {}) as Record<string, unknown>;
    sendJson(res, 200, stashAndRespond(stash, value, { refetched: true }));
  } catch (error) {
    sendJson(res, 500, { error: String((error as Error)?.message ?? error) });
  }
}
