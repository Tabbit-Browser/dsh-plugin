/*
 * ============================================================================
 * 文件职责：直连 Runtime Service 公开端点（endpoint.json + NDJSON socket）
 * ============================================================================
 *
 * 这是与浏览器通信的【第二条物理通道】，与 cli.ts（launcher 子进程）并列：
 *
 *   cli.ts     —— 每次 spawn launcher 子进程，走完整 CLI 面（求值/finish/…），
 *                 具备"浏览器没在跑时自动拉起"的能力，代价是 ~1 秒级延迟；
 *   endpoint.ts（本文件）—— 直接连浏览器发布的本机 socket，仅覆盖【无任务】
 *                 操作（目前是 tabs 清单与 ping），稳态延迟 ~1ms，
 *                 但【不会】拉起浏览器：离线就如实报离线。
 *
 * 选型背景（2026-08-28，与 Tabbit 团队确认）：persistent 模式（CLI 的 NDJSON
 * 交互式子命令）计划移除，不能依赖；当时 socket 协议里的 unbound `tabs` 是
 * dispatch 的一等 case，与 persistent/bootstrap 绑定机制无关——这是"零浏览器
 * 改动 + 快速读取"的唯一交集。
 * 后续（2026-09-01 浏览器提交 556476dd92b，1.13.20 起）persistent/bound 整套
 * 连接模式被删，unbound `tabs` 一并消失（dispatch 只剩 `cli` 与 `ping`），
 * 同一批次还删掉了 `tasks` CLI 子命令（client.ts 的 listTasks 另有适配）。
 * 于是清单读取分两代（见 listAllTabs）：
 *   - 旧代（1.11.16 ～ 1.13.8）：{"op":"tabs"} 直取；
 *   - 新代（1.13.20+）：{"op":"tabs"} 回 METHOD_NOT_FOUND，改在同一条 socket
 *     上发 {"op":"cli", argv:["tabs", ...]}——仍然不经 launcher、不拉起浏览器。
 *
 * ─── 线上协议（对 1.11.16 / 1.13.8 / 1.13.24 三版源码核对，并经真机验证；
 *      服务端实现 runtime-public-server.mjs + runtime-service.mjs）───
 *
 *  1. endpoint.json（schema v2，浏览器 C++ 侧 local_agent_endpoint.cc 写出）：
 *       {version:2, kind:"browser-runtime-service", transport, address,
 *        token(32字节 base64url), generation, browserPid}
 *     位置在 <用户数据目录>/LocalAgent/endpoint.json（注册表记录里给了全路径）。
 *     【只在 Runtime Service 运行期间存在，浏览器退出即删；每次重启
 *     address/token/generation 三元组全部轮换】——所以本文件的铁律是：
 *     每次连接前【现读】该文件，绝不缓存凭据。
 *  2. 传输：macOS/Linux = unix domain socket（0600）；Windows = named pipe
 *     （\\.\pipe\tabbit-runtime-…）。Node 的 net.createConnection 对两者同一 API。
 *  3. 帧格式：NDJSON（一行一个 JSON + \n）。连接后第一帧必须是【严格恰好
 *     三个键】的认证帧 {"version":1,"token":…,"generation":…}——服务端用
 *     timingSafeEqual 比对，不匹配就【无响应直接断开】（这是认证失败唯一的
 *     可观测征兆，见下面 STALE_ENDPOINT 的处理）。认证帧成功也没有回执。
 *  4. 认证后每帧一个请求对象，响应一行 {ok:true,value} 或
 *     {ok:false,error:{name,code,message}}。非 persistent 连接一问一答后由
 *     服务端主动收尾；我们读到响应行就自行断开，不依赖这一行为。
 *  5. 旧代 unbound {"op":"tabs"}：返回全 profile 标签页清单。服务端内部开一个
 *     临时会话并在同一 dispatch 里 finalize(keep:true)——不产生任务、页面、
 *     标签组，也不出现在 `tasks` 列表里（真机核查）。
 *     新代 {"op":"cli","argv":[...],"stdin":""}：与 launcher 子进程走的是同一个
 *     runCliCommand。`tabs --task <名> --limit ≤200 [--cursor <游标>]` 遍历所有
 *     普通窗口、带分组信息；它按 --task 名 useTask 建一个任务、列完就
 *     finish(keep:true)——C++ 侧 OpenSession 只登记会话对象，不开页、不建组，
 *     用户看不到任何变化，只是比直取慢（毫秒到百毫秒级）。清单超过 --limit
 *     时带 nextCursor 翻页；两页之间标签页变了服务端回 STALE_CURSOR。
 *     状态词汇也换代了：旧代 available|owned|busy，新代 available|owned|claimed
 *     （claimed = 被别的任务占有，即旧代的 busy）。
 *     {"op":"ping"} 两代都返回 {running:true, generation}，可当健康检查。
 *  6. 服务端限额：认证帧 ≤4KB、请求 ≤64MB、8 并发 dispatch（超了回
 *     SERVICE_BUSY）、未认证连接空闲 5 秒收、dispatch 超时 150 秒。
 *
 * 错误统一包装成 TabbitCliError（与 CLI 通道共用一套错误分类，上层不用区分
 * 消息是从哪条通道冒出来的）。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';

import { CLI_ERROR_CODES, TabbitCliError, classifyAppError } from './errors.js';

/* 我们支持的 endpoint.json schema 版本（浏览器侧 kBrowserRuntimeEndpointVersion）。 */
const ENDPOINT_SCHEMA_VERSION = 2;

/* 解析后的 endpoint.json。字段名与文件一致。 */
export interface TabbitEndpoint {
  version: number;
  kind: string;
  transport: 'unix_socket' | 'named_pipe';
  address: string;
  token: string;
  generation: string;
  browserPid: number;
}

/*
 * `tabs` 清单里的单个标签页描述符。形状以浏览器 C++ 序列化代码为准
 * （browser_runtime_service_host.cc 的 OnRuntimeListTabs），真机两代验证一致。
 */
export interface TabbitTabDescriptor {
  tabId: number;
  windowId: number;
  /* 在所属窗口标签条（tab strip）里的位置，从 0 起。 */
  index: number;
  title: string;
  url: string;
  active: boolean;
  /* available=无主可认领；owned=属于发起清单的那个任务（清单用的是临时任务，
   * 实际不会出现）；busy=被别的任务占有（新代服务端叫 claimed，读入时归一为 busy）。 */
  state: 'available' | 'owned' | 'busy';
  /* 所在标签组的元数据；不在任何组里时为 null。组标题只是展示文本，不是身份。 */
  group: { groupId: string; title: string } | null;
}

export interface TabbitTabInventory {
  tabs: TabbitTabDescriptor[];
  /* 服务端因体量截断清单时为 true（正常机器上标签页数量远够不到上限）。 */
  truncated: boolean;
}

export interface EndpointRequestOptions {
  /* 整个请求的墙钟超时（毫秒）。tabs 稳态 ~1ms，默认值只是兜底。 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/*
 * 读取并校验 endpoint.json。三种失败各有语义：
 *   - 文件读不到/不是 JSON：浏览器离线（文件退出即删）——ENDPOINT_MISSING；
 *   - schema 版本或 kind 不认识：浏览器换了协议世代，需要升级本插件——
 *     ENDPOINT_UNSUPPORTED（宁可明确失败也不猜着连）；
 *   - transport 不认识：同上。
 */
export function readEndpoint(endpointPath: string): TabbitEndpoint {
  let parsed: Partial<TabbitEndpoint>;
  try {
    parsed = JSON.parse(readFileSync(endpointPath, 'utf8')) as Partial<TabbitEndpoint>;
  } catch (error) {
    throw new TabbitCliError({
      kind: 'browser-unavailable',
      code: 'ENDPOINT_MISSING',
      message: `Tabbit Browser is not running (cannot read ${endpointPath}): ${String((error as Error)?.message ?? error)}`,
    });
  }
  if (parsed.version !== ENDPOINT_SCHEMA_VERSION || parsed.kind !== 'browser-runtime-service') {
    throw new TabbitCliError({
      kind: 'protocol',
      code: 'ENDPOINT_UNSUPPORTED',
      message: `Unsupported Runtime Service endpoint schema (version=${String(parsed.version)} kind=${String(parsed.kind)}); update dsh-tabbit.`,
    });
  }
  if (
    (parsed.transport !== 'unix_socket' && parsed.transport !== 'named_pipe') ||
    typeof parsed.address !== 'string' ||
    parsed.address === '' ||
    typeof parsed.token !== 'string' ||
    typeof parsed.generation !== 'string'
  ) {
    throw new TabbitCliError({
      kind: 'protocol',
      code: 'ENDPOINT_UNSUPPORTED',
      message: 'Runtime Service endpoint file is missing transport/address/token/generation fields.',
    });
  }
  return parsed as TabbitEndpoint;
}

/*
 * 在一条新连接上完成"认证帧 + 单个请求帧 → 一行响应"的完整交换。
 *
 * 实现要点：
 *   - 认证帧和请求帧一次性写出（服务端逐帧消费，无需等认证回执——协议里
 *     认证成功本来就没有回执）；
 *   - settled 布尔量保证 resolve/reject 只发生一次（error/close/data 会竞争）；
 *   - 读到第一个换行即为完整响应，之后立刻 destroy——unbound 连接没有任何
 *     需要善后的服务端状态（无任务绑定），断开即干净；
 *   - 【close 先于 data 到达 = 认证被拒或服务端换代】：服务端对坏凭据的行为
 *     是无响应断开，映射为 STALE_ENDPOINT，由上层（requestViaEndpoint）现读
 *     endpoint.json 重试一次——覆盖"浏览器刚重启、我们拿的是上一代凭据"窗口。
 */
function endpointRequestOnce(endpoint: TabbitEndpoint, payload: object, timeoutMs: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(endpoint.address);
    let buffer = '';
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      action();
    };
    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new TabbitCliError({
            kind: 'timeout',
            code: 'CLIENT_TIMEOUT',
            message: `Runtime Service endpoint did not respond within ${timeoutMs}ms`,
          }),
        ),
      );
    }, timeoutMs);
    timer.unref();

    socket.on('error', (error: NodeJS.ErrnoException) => {
      // 两类都归为"凭据/端点过期"（可现读文件重试一次）：
      //   ENOENT/ECONNREFUSED —— 文件还在但 socket 已不可连（浏览器正在退出
      //   或重启的窗口期）；
      //   ECONNRESET/EPIPE —— 交换中途被掐（服务端对坏凭据的 destroy 在
      //   客户端常表现为 RST，而不是干净的 close）。
      const stale =
        error.code === 'ENOENT' ||
        error.code === 'ECONNREFUSED' ||
        error.code === 'ECONNRESET' ||
        error.code === 'EPIPE';
      settle(() =>
        reject(
          new TabbitCliError({
            kind: stale ? 'browser-unavailable' : 'protocol',
            code: stale ? 'STALE_ENDPOINT' : 'SOCKET_ERROR',
            message: stale
              ? `Runtime Service connection dropped before a response (browser restarting or stale credentials): ${error.code}`
              : `Runtime Service socket error: ${error.message}`,
          }),
        ),
      );
    });
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({ version: 1, token: endpoint.token, generation: endpoint.generation })}\n` +
          `${JSON.stringify(payload)}\n`,
      );
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      settle(() => {
        let response: { ok?: boolean; value?: unknown; error?: { name?: string; code?: string; message?: string } };
        try {
          response = JSON.parse(buffer.slice(0, newline)) as typeof response;
        } catch {
          reject(
            new TabbitCliError({
              kind: 'protocol',
              code: 'BAD_FRAME',
              message: `Runtime Service returned a non-JSON frame: ${buffer.slice(0, 200)}`,
            }),
          );
          return;
        }
        if (response.ok === true) {
          resolve(response.value);
          return;
        }
        const error = response.error ?? {};
        reject(
          new TabbitCliError({
            kind: classifyAppError(error),
            code: error.code ?? 'REQUEST_FAILED',
            message: error.message ?? 'Runtime Service request failed',
          }),
        );
      });
    });
    socket.on('close', () =>
      settle(() =>
        reject(
          new TabbitCliError({
            kind: 'browser-unavailable',
            code: 'STALE_ENDPOINT',
            message:
              'Runtime Service closed the connection before responding (endpoint credentials are stale; the browser likely restarted)',
          }),
        ),
      ),
    );
  });
}

/*
 * 对外的单请求入口：现读 endpoint.json → 交换一次；命中"凭据过期/socket 刚没"
 * 这两类【重启窗口】错误时，再现读一次文件重试——文件是浏览器新一代身份的
 * 唯一权威来源，重读即自愈。其余错误（离线、超时、服务端应用错误）原样上抛。
 */
export async function requestViaEndpoint(
  endpointPath: string,
  payload: object,
  options: EndpointRequestOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await endpointRequestOnce(readEndpoint(endpointPath), payload, timeoutMs);
  } catch (error) {
    if (!(error instanceof TabbitCliError) || error.code !== 'STALE_ENDPOINT') throw error;
    return await endpointRequestOnce(readEndpoint(endpointPath), payload, timeoutMs);
  }
}

/* CLI 分页清单每页上限（服务端 --limit 的硬上限）与最多翻页数（防游标环路自旋）。 */
const CLI_TABS_PAGE_LIMIT = 200;
const CLI_TABS_MAX_PAGES = 25;

/*
 * 全 profile 标签页清单（含用户自己开的页面，不限于代理任务页）。
 * 两代读取路径（见文件头第 5 条）：先按旧代直取 {"op":"tabs"}（稳态 ~1ms）；
 * 服务端回 METHOD_NOT_FOUND 说明是 1.13.20+ 的新代，改走同一 socket 上的
 * CLI `tabs` 分页拼全量。为什么不干脆只走 CLI：旧代的 CLI `tabs` 没有
 * --limit/--cursor（默认 50 条就截断），直取才是旧代的全量路径。
 * 两条路径都不经 launcher，浏览器离线照旧如实报离线（不会拉起浏览器）。
 * 返回值形状逐字段校验——数据要进提示词/UI，宁可在这里挡住服务端未来的
 * 形状漂移，也不把 unknown 直接漏给上层。
 */
export async function listAllTabs(endpointPath: string, options?: EndpointRequestOptions): Promise<TabbitTabInventory> {
  let value: unknown;
  try {
    value = await requestViaEndpoint(endpointPath, { op: 'tabs' }, options);
  } catch (error) {
    if (!(error instanceof TabbitCliError) || error.code !== CLI_ERROR_CODES.methodNotFound) throw error;
    return await listAllTabsViaCli(endpointPath, options);
  }
  const page = normalizeInventoryPage(value);
  return { tabs: page.tabs, truncated: page.truncated };
}

/*
 * 新代路径：在公开端点上直接投递 CLI `tabs` 子命令并按 nextCursor 翻页。
 * 游标失效（STALE_CURSOR：翻页期间用户开/关了标签页）从头重来一次；再失效
 * 就原样上抛——清单变动得比翻页还快，不值得无限追。
 */
async function listAllTabsViaCli(endpointPath: string, options?: EndpointRequestOptions): Promise<TabbitTabInventory> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await listAllTabsViaCliOnce(endpointPath, options);
    } catch (error) {
      if (attempt === 0 && error instanceof TabbitCliError && error.code === CLI_ERROR_CODES.staleCursor) continue;
      throw error;
    }
  }
}

/*
 * 一轮完整翻页。任务名每次随机：CLI 对不存在的 --task 名 useTask 新建、列完
 * finish；若两次并发清单共用一个名字，后到的会复用前者的任务（reused），而
 * 前者列完就把任务 finish 掉，后者的请求便撞上 "Task is closing"。随机名让
 * 每次清单各用各的任务互不干扰；同一轮的各页沿用同一个名字即可。
 */
async function listAllTabsViaCliOnce(endpointPath: string, options?: EndpointRequestOptions): Promise<TabbitTabInventory> {
  const task = `dsh-tab-inventory-${randomUUID().slice(0, 8)}`;
  const tabs: TabbitTabDescriptor[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < CLI_TABS_MAX_PAGES; page += 1) {
    const argv = ['tabs', '--task', task, '--limit', String(CLI_TABS_PAGE_LIMIT)];
    if (cursor !== undefined) argv.push('--cursor', cursor);
    // stdin 必须给字符串（哪怕为空）：服务端 runCliCommand 对非字符串直接抛 TypeError。
    const value = await requestViaEndpoint(endpointPath, { op: 'cli', argv, stdin: '' }, options);
    const inventory = normalizeInventoryPage(value);
    tabs.push(...inventory.tabs);
    // 没截断 = 已到末页；截断却没给游标是服务端形状异常，按"截断"如实上报。
    if (!inventory.truncated) return { tabs, truncated: false };
    if (inventory.nextCursor === undefined) return { tabs, truncated: true };
    cursor = inventory.nextCursor;
  }
  return { tabs, truncated: true };
}

/*
 * 校验并归一化一页清单（两代路径共用）。状态词汇归一：新代的 claimed 与旧代
 * 的 busy 同义（被别的任务占有），都记为 busy——若放任它落到 available，上层
 * 会拿它去 claim_tabs 然后撞 TAB_OWNERSHIP_CONFLICT。
 */
function normalizeInventoryPage(value: unknown): TabbitTabInventory & { nextCursor?: string } {
  const inventory = value as { tabs?: unknown; truncated?: unknown; nextCursor?: unknown };
  if (typeof inventory !== 'object' || inventory === null || !Array.isArray(inventory.tabs)) {
    throw new TabbitCliError({
      kind: 'protocol',
      code: 'BAD_FRAME',
      message: 'Runtime Service tabs inventory has an unexpected shape',
    });
  }
  const tabs: TabbitTabDescriptor[] = [];
  for (const entry of inventory.tabs) {
    if (typeof entry !== 'object' || entry === null) continue;
    const tab = entry as Record<string, unknown>;
    if (typeof tab.tabId !== 'number' || typeof tab.url !== 'string') continue;
    const group = tab.group as Record<string, unknown> | null | undefined;
    tabs.push({
      tabId: tab.tabId,
      windowId: typeof tab.windowId === 'number' ? tab.windowId : 0,
      index: typeof tab.index === 'number' ? tab.index : 0,
      title: typeof tab.title === 'string' ? tab.title : '',
      url: tab.url,
      active: tab.active === true,
      state: tab.state === 'owned' ? 'owned' : tab.state === 'busy' || tab.state === 'claimed' ? 'busy' : 'available',
      group:
        typeof group === 'object' && group !== null && typeof group.groupId === 'string'
          ? { groupId: group.groupId, title: typeof group.title === 'string' ? group.title : '' }
          : null,
    });
  }
  return {
    tabs,
    truncated: inventory.truncated === true,
    ...(typeof inventory.nextCursor === 'string' && inventory.nextCursor !== '' ? { nextCursor: inventory.nextCursor } : {}),
  };
}

/* 健康检查：浏览器在线时返回 {running:true, generation}。 */
export async function pingEndpoint(
  endpointPath: string,
  options?: EndpointRequestOptions,
): Promise<{ running: boolean; generation: string }> {
  const value = (await requestViaEndpoint(endpointPath, { op: 'ping' }, options)) as {
    running?: unknown;
    generation?: unknown;
  };
  return {
    running: value?.running === true,
    generation: typeof value?.generation === 'string' ? value.generation : '',
  };
}
