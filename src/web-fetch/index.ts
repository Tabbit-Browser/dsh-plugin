/*
 * ============================================================================
 * 文件职责：浏览器代理的 `web_fetch` provider
 * ============================================================================
 *
 * 为什么存在（背景知识）：dsh 内置了 `web_fetch` 工具（模型抓网页正文用），
 * 并自 0.1.2-alpha.1 起自带一个匿名直连的 HTTP 抓取 provider
 * （@deepseek-ai/dsh-web-fetch-http，id `http`）：先解析域名、要求答案全部
 * 是公网单播才放行，再把连接钉在验证过的 IP 上直连。这套 SSRF 防护很严谨，
 * 但对真实网页力不从心——无 JS 渲染、无登录态、不走系统代理；在 fake-ip
 * 模式代理的机器上（国内常见），一切域名都解析进保留网段，它会把所有请求
 * 判成"非公网 IP"拒绝（WEB_BLOCKED_URL）。dsh 的 `ctx.web` 服务开放了
 * registerFetchProvider 扩展点：本文件注册一个更能打的替代者。
 *
 * 本文件的做法：
 *  - 用【用户的真实 Tabbit 浏览器】取页（顺带白赚 JS 渲染和登录墙内容）；
 *  - 安全性与 permissions 模块的双闸配对：pageAccess 总闸 + intranetFetch
 *    内网附加闸（默认逐 origin 审批）——这是"敢启用 fetch"的全部底气；
 *  - 请求前的内网判定在 permissions 里做；本文件负责【事后半段】：拿到
 *    最终 URL（重定向后的落点）再查一次，公网请求跳到内网目标一律拒绝
 *    返回内容（redirect containment，防"公网 URL 302 进内网"绕闸）。
 *
 * 执行模型：所有 fetch 共用一个固定任务名（FETCH_TASK_NAME，在用户浏览器
 * 里显示为 "DeepSeek Harness · Web Fetch" 标签组）；每次请求开新页，
 * 提取后关页并 finish 任务，避免留下任务自带的 about:blank 标签组。
 *
 * 选择机制：dsh 的 `ctx.web` 按【钉死的 provider id】选 provider——没有
 * 优先级链，config 里钉的 id 还优先于环境变量 DSH_WEB_FETCH_PROVIDER。基座
 * 把 fetchProvider 钉为内置的 `http`，本 bundle 的 cordis.patch.yml 把它改
 * 钉为本 provider 的 id `tabbit-browser`——因此本文件注册后就是唯一会被使
 * 用的抓取通道；浏览器不可用时 dsh 报 WEB_PROVIDER_CONFIGURED_UNAVAILABLE
 * （工具仍可见，调用时才报错），不会回落到内置直连抓取器。工具开关
 * tool-web.fetch 由 web 形态的标准 preset（alpha.1 起自带 true）和本 bundle
 * 补丁（headless 形态）打开。
 */
import { existsSync } from 'node:fs';

import type { Context } from '@deepseek-ai/cordis';
// WebError：dsh-web 定义的标准错误类型（带错误码），fetch 失败必须抛它，
// dsh 才能把错误规整地渲染给模型。
import { WebError } from '@deepseek-ai/dsh-web';

import { FETCH_TASK_NAME, type TabbitService } from '../core/index.js';
import { TabbitCliError } from '../runtime/errors.js';
import { hostnameLooksLocal, ipIsPrivate } from '../runtime/net.js';

import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web';

/* 提取正文的字符上限（在浏览器侧就截断，见 buildFetchCode）。 */
const MAX_TEXT_CHARS = 180_000;
/* 页面导航（goto）超时。 */
const NAV_TIMEOUT_MS = 25_000;
/* 整段求值超时（导航 + 稳定等待 + 提取）。1.13.23+ 的 CLI 拒绝低于 60 秒的
 * --timeout-ms（client.ts 会把更小的值抬上去），所以这里直接取 60 秒——真正
 * 兜住抓取时长的是上面 25 秒的导航超时，这只是最外层的保险。 */
const EVAL_TIMEOUT_MS = 60_000;

/* 浏览器侧提取脚本返回的数据形状。 */
interface FetchEvalValue {
  finalUrl: string;
  status: number;
  title: string;
  text: string;
  truncated: boolean;
}

/* dsh WebFetchProvider 接口的实现（id 是 provider 的注册标识）。 */
class TabbitFetchProvider implements WebFetchProvider {
  readonly id = 'tabbit-browser';
  /* available() 的 5 秒结果缓存（该方法会被频繁调用，别每次都摸文件系统）。 */
  private availabilityCache: { at: number; value: boolean } | undefined;

  constructor(private readonly tabbit: TabbitService) {}

  /*
   * dsh 用它判断"这个 provider 现在能不能用"。刻意只做【零副作用的本地文件
   * 检查】：launcher 文件存在 + 实例注册表非空。不真连浏览器（那会把离线的
   * 浏览器拉起来），也不管在不在线（fetch 真跑的时候 launcher 自会拉起浏览器）。
   */
  available(): boolean {
    const now = Date.now();
    if (this.availabilityCache !== undefined && now - this.availabilityCache.at < 5000) {
      return this.availabilityCache.value;
    }
    const value = existsSync(this.tabbit.launcherPath()) && this.tabbit.instances().length > 0;
    this.availabilityCache = { at: now, value };
    return value;
  }

  /* 一次抓取。全流程：校验 URL → 浏览器里取页提取 → 重定向围堵 → 组装结果。 */
  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new WebError(`invalid URL: ${request.url}`, 'FETCH_INVALID_URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new WebError(`unsupported URL scheme "${url.protocol}" (http/https only)`, 'FETCH_INVALID_URL');
    }
    // 记住请求【本来就是】内网目标的情况（此时用户已经通过 intranetFetch 闸
    // 批准过了）——这种请求最终落在内网属正常，不该被下面的重定向围堵误杀。
    const requestWasPrivate = hostIsObviouslyPrivate(url.hostname);

    let outcome;
    try {
      outcome = await this.tabbit.withFetchTask(async (client) => {
        return await client.evaluate({
          task: FETCH_TASK_NAME,
          readOnly: true, // 旧版 CLI 可声明只读；新版 CLI 无此参数，client 会自动兼容
          timeoutMs: EVAL_TIMEOUT_MS,
          code: buildFetchCode(url.href),
          ...(signal ? { signal } : {}),
        });
      });
    } catch (error) {
      // CLI 层错误 → 翻译成 dsh 的 WebError（错误码映射见 webErrorCode）。
      if (error instanceof TabbitCliError) {
        throw new WebError(`Tabbit browser fetch failed: ${error.message}`, webErrorCode(error));
      }
      throw error;
    }
    if (outcome.status === 'failed') {
      const message = outcome.errorMessage ?? 'navigation failed';
      const code = /timeout/iu.test(message) ? 'FETCH_TIMEOUT' : 'FETCH_FAILED';
      throw new WebError(`Tabbit browser fetch failed: ${message}`, code);
    }

    const value = (outcome.result?.value ?? {}) as Partial<FetchEvalValue>;
    const finalUrl = typeof value.finalUrl === 'string' && value.finalUrl !== '' ? value.finalUrl : url.href;

    // 【重定向围堵】：公网发起的请求，最终 URL 若落在私有目标上，拒绝返回
    // 内容——否则攻击者可用一个公网短链 302 到 http://127.0.0.1:8080/admin
    // 之类，绕过 intranetFetch 闸把内网内容送进模型上下文。
    if (!requestWasPrivate) {
      try {
        const finalHost = new URL(finalUrl).hostname;
        if (hostIsObviouslyPrivate(finalHost)) {
          throw new WebError(
            `fetch of ${url.href} redirected to a private target (${finalHost}); refusing to return its content`,
            'FETCH_BLOCKED_REDIRECT',
          );
        }
      } catch (error) {
        if (error instanceof WebError) throw error;
        /* 最终 URL 解析不了：按原始 URL 继续（不因解析失败误杀） */
      }
    }

    // 组装 dsh 期望的 WebFetchResult：标题拼成 Markdown 一级标题打头。
    const title = typeof value.title === 'string' ? value.title : '';
    const text = typeof value.text === 'string' ? value.text : '';
    const content = title !== '' ? `# ${title}\n\n${text}` : text;
    return {
      url: finalUrl,
      statusCode: typeof value.status === 'number' && value.status > 0 ? value.status : 200,
      body: { kind: 'text', content },
      truncated: value.truncated === true || outcome.result?.truncated === true,
    };
  }
}

/* "一眼可判"的私有主机检查（字面 IP 私有段 / 本地域名形态；不做 DNS——同步、够快）。 */
function hostIsObviouslyPrivate(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/gu, '');
  return ipIsPrivate(bare) || hostnameLooksLocal(bare);
}

/* TabbitCliError 类别 → dsh WebError 错误码的映射。 */
function webErrorCode(error: TabbitCliError): string {
  switch (error.kind) {
    case 'launcher-missing':
    case 'instance-selection':
    case 'browser-unavailable':
      return 'TABBIT_UNAVAILABLE';
    case 'busy':
      return 'TABBIT_BUSY';
    case 'timeout':
      return 'FETCH_TIMEOUT';
    default:
      return 'FETCH_FAILED';
  }
}

/*
 * 生成在浏览器任务里执行的取页脚本（作为 evaluate 的 code 参数）。
 * URL 经 JSON.stringify 嵌入——这是防注入的关键：URL 里的引号/反斜杠都会被
 * 正确转义，不可能"逃出"字符串字面量变成代码。
 *
 * 脚本逻辑（在浏览器进程里跑，可用注入全局 context 等）：
 *  1. context.newPage() 开新页（挂在共享 fetch 任务的标签组下）；
 *  2. goto 导航，等到 domcontentloaded（DOM 就绪即可，不等全部资源）；
 *  3. 再等 400ms 让常见的客户端渲染稳一稳；
 *  4. p.evaluate(...) 进入【页面 JS 环境】提取：优先 article/main/[role=main]
 *     语义正文容器，退化到 body；取 innerText（渲染后的可见文本，自动剔除
 *     script/style/隐藏元素——比 innerHTML 干净得多）；
 *  5. 超 18 万字符截断并标记；
 *  6. 返回 {finalUrl（重定向后落点，围堵检查用）, status, title, text, truncated}；
 *  7. finally 无论成败必关页——不留孤儿标签页。
 *
 * ⚠️ 模板字符串内是下发浏览器的代码原文，勿在其中加注释/改动。
 */
function buildFetchCode(url: string): string {
  return `const target = ${JSON.stringify(url)};
const p = await context.newPage();
try {
  let resp = null;
  try {
    resp = await p.goto(target, { waitUntil: 'domcontentloaded', timeout: ${NAV_TIMEOUT_MS} });
  } catch (error) {
    throw new Error('navigation failed: ' + String((error && error.message) || error));
  }
  await p.waitForTimeout(400);
  const data = await p.evaluate(() => {
    const root = document.querySelector('article, main, [role="main"]') || document.body;
    const title = document.title || '';
    const text = root ? root.innerText || '' : '';
    return { title, text };
  });
  let text = data.text || '';
  let truncated = false;
  if (text.length > ${MAX_TEXT_CHARS}) {
    text = text.slice(0, ${MAX_TEXT_CHARS});
    truncated = true;
  }
  return {
    finalUrl: p.url(),
    status: resp ? resp.status() : 0,
    title: data.title,
    text,
    truncated,
  };
} finally {
  try { await p.close(); } catch {}
}`;
}

export const name = 'tabbit-web-fetch';
export const inject = ['web', 'tabbit'];

/* 插件入口：把 provider 注册进 dsh 的 web 服务（补丁层已把 fetchProvider 钉到它的 id 上）。 */
export function apply(ctx: Context): void {
  ctx.web.registerFetchProvider(new TabbitFetchProvider(ctx.tabbit));
}
