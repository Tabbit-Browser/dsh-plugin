window.__ModuleLoader__.load({ id: "dsh-tabbit", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict';

/*
 * ============================================================================
 * 文件职责：dsh Web 客户端插件——`@tab` 提及的前端半边 + 观看实例打点
 * ============================================================================
 *
 * ⚠️ 本文件跑在【浏览器里的 dsh 网页】上，不是 Node 进程！它是 package.json
 * `dsh.client` 声明的客户端模块，由 dsh 以 /plugins/dsh-tabbit/client.js
 * 静态服务、被网页加载执行。
 *
 * 首尾两行的 window.__ModuleLoader__.load({id, factory}) 是 dsh Web 端的
 * 客户端模块装载协议：手写这个外壳（而不是上 webpack/vite 打包链）是刻意
 * 选择——本文件零依赖、百来行，不值得为它引入一整套构建。factory 里手工
 * 模拟了 CommonJS 的 module/exports，最后 return module.exports 交回给
 * ModuleLoader。（middle 部分随便改，首尾包裹行不要动。）
 *
 * 功能一：页面加载即向 /tabbit/instance-hint 打点（fire-and-forget），
 *   让服务端检测"用户正用哪个 Tabbit 看 dsh"（→ 优先在那个实例执行任务）。
 * 功能二：注册 `@` 输入源 "网页标签"——输入框敲 @ 时列出两类候选（排在
 *   dsh 自带的"文件与文件夹/对话"之后）：①本会话浏览器任务里打开的页面
 *   （kind:'task-page'）；②用户浏览器里的普通标签页（kind:'user-tab'，
 *   服务端直连 Runtime Service 清单）。选中插入 chip；点发送时立即调用
 *   /tabbit/mention/extract 现场提取（失败阻断发送，语义不变），但序列化
 *   结果不再是整段正文——服务端把提取到的正文暂存、只回一个短 token，
 *   这里拼出 `@[标题](tabbit-tab:token)` 这样的短标记塞进气泡文本。真正的
 *   正文由服务端的 `agent/pre-step` 钩子（src/mentions/index.ts）在模型
 *   即将看到这条消息前，凭 token 取回并接成一条独立的、默认折叠的上下文
 *   消息——和 dsh 内置 @文件/@对话 的做法一致，聊天气泡里不会直接堆全文。
 *   候选与提取的数据都来自服务端的 /tabbit/mention/* 路由
 *   （src/mentions/index.ts），同源 fetch 直连。
 *
 * dsh 客户端插件协议与服务端 Cordis 如出一辙：导出 {name, inject, apply(ctx)}；
 * 这里注入的 'inputTriggers' 是 dsh-client-ui-input-trigger 提供的"输入框
 * 触发菜单"服务（package.json dsh.client.inject 里声明了要它一起装）；
 * 共享的触发菜单负责渲染候选列表 UI——@tab 部分只提供数据，不需要 React。
 *
 * 这里刻意【没有】/tabbit-info 状态卡。0.3.3 及之前本文件还注册过一个
 *   聊天节点，靠服务端落一条自定义 tabbit/status 会话事件驱动；宿主持久
 *   层对不认识的事件类型只认信封上的 ignorable 标记、而插件侧没有设置它
 *   的入口，结果是含该事件的会话冷加载时整个被拒读（issue #22）。
 *   /tabbit-info 的报告现在只走 CommandResult.text，由宿主自带的命令节点
 *   渲染；代价是空白会话里命令文本不渲染——这是宿主客户端的限制，不该
 *   用写坏日志的方式绕过。宿主提供 ignorable 通道前，不要恢复自定义会话
 *   事件（见 AGENTS.md）。
 */

/*
 * 本输入源的注册名（也是 chip 序列化时的 source 标识）。这个字符串同时是
 * @ 菜单分组标题——宿主用 t(source.name) 做本地化查找，查不到译文（我们
 * 的分组名从不在宿主词典里）就原样显示这个字符串，这是宿主自己的
 * "cordis" 提及源也在用的既有兜底行为，不是 hack。
 */
const SOURCE_NAME = '网页标签';
/*
 * 候选键 → 完整标签页引用（task/url/index/title）的暂存表。
 * 为什么需要它：候选条目（candidate）只有 name/description 两个字符串字段，
 * 塞不下结构化引用；先寄存在这里，用户选中时（onPick）再按键取回。
 */
const refByKey = new Map();

/* 从 dsh 会话对象里取会话 id（兼容 sessionId/id 两种字段形状）。 */
function sessionIdOf(session) {
  if (!session) return '';
  return String(session.sessionId || session.id || '');
}

/*
 * 候选名直接用页面标题（回退 URL）——菜单把 name 当主文案渲染（dsh 自带的
 * "对话"源就是人话标题），mangle 成 slug 会显得粗糙。name 同时是 refByKey
 * 的键，必须唯一：同标题的多个标签页给后来者追加 " ·2" 序号消歧。
 */
function candidateName(tab, seen) {
  const base = String(tab.title || tab.url || 'tab').trim().slice(0, 60) || 'tab';
  const count = (seen.get(base) || 0) + 1;
  seen.set(base, count);
  return count > 1 ? base + ' ·' + count : base;
}

/*
 * @ 菜单一次最多渲染的候选数——菜单本身带滚动条（宿主 MenuView 的
 * viewport 是 overflow-y:auto），这里不是"菜单能放几条"的硬限制，只是
 * 防止真机 170+ 标签页时一次性渲染过多 DOM；对齐宿主"对话"提及源自己用
 * 的候选上限（50）。想找更靠后的标签页，继续敲字过滤即可（query 是对
 * 服务端返回的全量清单做的，不受这个数字影响）。
 */
const MAX_CANDIDATES = 50;

/*
 * 给标记文本里的标题转义：serialize() 把它嵌进 `@[标题](tabbit-tab:token)`
 * 这样的短标记里，方括号会打乱服务端 agent/pre-step 钩子的解析——把它们
 * 换成空格，不影响可读性。
 */
function sanitizeMarkerTitle(text) {
  return String(text || '').replace(/[[\]()]/gu, ' ').trim() || 'tab';
}

/* 拉取本会话的标签页清单（GET /tabbit/mention/tabs）。任何异常形状都归一为空数组。 */
async function fetchRoster(sessionId, signal) {
  const response = await fetch('/tabbit/mention/tabs?session=' + encodeURIComponent(sessionId), { signal });
  if (!response.ok) return [];
  const data = await response.json().catch(() => ({}));
  return Array.isArray(data.tabs) ? data.tabs : [];
}

/*
 * 输入源定义——inputTriggers 服务约定的接口形状：
 *   trigger：触发字符（@）；order：多个 @ 源并存时的排序；
 *   candidates()：给出候选；onPick()：用户选中一条时怎么插入；
 *   codec：chip 的序列化协议（clipboardText 复制文案 + serialize 发送时展开）。
 */
const source = {
  trigger: '@',
  name: SOURCE_NAME,
  // 正数：排在宿主"文件与文件夹/对话"（reference 源，order 默认 0）后面。
  order: 10,
  /*
   * 产出候选列表。request.query 是 @ 后面已敲的过滤词，按标题/URL 包含匹配
   * （不区分大小写）；最多 MAX_CANDIDATES 条（菜单本身会滚动，这不是硬
   * 上限，见常量注释）。roster 拉取失败静默返回空——@ 菜单永远不能因为
   * 我们炸掉。每条候选把完整引用寄存进 refByKey，键 = 序号+标题slug。
   */
  async candidates(session, request) {
    const sessionId = sessionIdOf(session);
    if (!sessionId) return [];
    let tabs;
    try {
      tabs = await fetchRoster(sessionId, request && request.signal);
    } catch {
      return [];
    }
    const query = String((request && request.query) || '').toLowerCase();
    const matched = tabs.filter((tab) => {
      if (!query) return true;
      return (
        String(tab.title || '').toLowerCase().includes(query)
        || String(tab.url || '').toLowerCase().includes(query)
      );
    });
    const seen = new Map();
    return matched.slice(0, MAX_CANDIDATES).map((tab) => {
      const label = tab.title || tab.url;
      const key = candidateName(tab, seen);
      // 两类候选的引用形状不同：任务页记 task/index（就地提取要用），
      // 用户标签页记 userTab 标志（提取走服务端重取分支）。
      refByKey.set(
        key,
        tab.kind === 'user-tab'
          ? { userTab: true, url: tab.url, title: label, tabId: tab.tabId }
          : { task: tab.task, url: tab.url, index: tab.index, title: label },
      );
      return {
        name: key, // 候选主文案，同时是唯一键（onPick 靠它回查 refByKey）
        description: tab.url, // 菜单里的副标题
        // 前缀图标：宿主的候选图标是封闭枚举（只有 file/folder/session
        // 三种，见 dsh-client-ui-input-trigger），没有 favicon/自定义图标的
        // 位置——统一用 file（宿主里渲染成一个"浏览"风格的图标）。
        icon: 'file',
        // 来源徽标：任务页标出"是代理任务里的页"，普通标签页只标 Tabbit。
        hint: tab.kind === 'user-tab' ? 'Tabbit' : 'Tabbit task',
      };
    });
  },
  /*
   * 用户选中候选 → 返回插入指令：往输入框插一个真实 chip。
   *   ref：chip 携带的引用数据（JSON 字符串，发送时交给 codec.serialize）；
   *   label：chip 显示文本；clipboardText：chip 被复制时的纯文本形态。
   */
  onPick(pick) {
    const ref = refByKey.get(pick.candidate.name);
    if (!ref) return undefined;
    return {
      insert: {
        source: SOURCE_NAME,
        ref: JSON.stringify(ref),
        label: ref.title,
        clipboardText: '@' + ref.title,
      },
    };
  },
  codec: {
    /* 含 chip 的内容被复制成纯文本时，chip 显示为 "@标题"。 */
    clipboardText(ref) {
      try {
        return '@' + (JSON.parse(ref).title || 'tab');
      } catch {
        return '@tab';
      }
    },
    /*
     * 【发送时】的序列化：dsh 在用户点发送时对每个 chip 调用它，返回值
     * 替换 chip 进入实际发给模型的提示词。
     * 这里调 POST /tabbit/mention/extract 现场提取页面标题+正文——提取失败
     * 就【抛异常阻断发送】（输入框保留草稿和 chip），语义与之前完全一样：
     * 用户以为引用了页面内容、实际上没引上的"静默降级"，比一次显式失败
     * 糟糕得多。
     *
     * 变化的是【提取成功之后】：正文不再直接拼进这里的返回值（那会让整段
     * 网页正文直接堆进用户能看到的聊天气泡）。服务端把提取到的正文暂存，
     * 只把一个一次性 token 回给我们；这里只拼一个短标记
     *   @[标题](tabbit-tab:token)
     * 塞进发出去的文本。真正的正文由服务端的 agent/pre-step 钩子
     * （src/mentions/index.ts）在这条消息即将进入模型这一步时，凭 token
     * 取回暂存内容、接成一条独立的、默认折叠的"Context injection"消息
     * ——聊天气泡里最终只看得到 "@标题"，和 dsh 内置 @文件/@对话 的观感
     * 一致，模型仍然完整拿到正文。
     */
    async serialize(ref, signal) {
      const parsed = JSON.parse(ref);
      // 两类 chip 的提取请求体不同（服务端按 userTab 分流）：
      //   任务页 → {task,url,index} 就地读取；用户标签页 → {url,userTab:true}
      //   服务端在共享 fetch 任务里重取该 URL（不触碰用户原标签页）。
      const body = parsed.userTab === true
        ? { url: parsed.url, userTab: true }
        : { task: parsed.task, url: parsed.url, index: parsed.index };
      const response = await fetch('/tabbit/mention/extract', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error('tab mention failed: ' + (data.error || response.status));
      }
      const title = sanitizeMarkerTitle(data.title || parsed.title);
      return '@[' + title + '](tabbit-tab:' + data.token + ')';
    },
  },
};

module.exports = {
  name: 'dsh-tabbit-client',
  inject: ['inputTriggers'],
  apply(ctx) {
    // 观看实例打点：告诉服务端"是哪个浏览器在看这个页面"。fire-and-forget
    // （不 await、双层吞错）——纯属锦上添花的提示，任何失败都不能影响页面。
    // 服务端由这条连接的 socket 对端溯源出 Tabbit 实例（详见 src/runtime/peer.ts），
    // 之后浏览器任务会优先在那个实例上执行。
    try {
      fetch('/tabbit/instance-hint', { method: 'POST' }).catch(() => {});
    } catch {}

    // 功能二："网页标签" 输入源。
    const inputTriggers = ctx.get('inputTriggers');
    // 防御：服务缺席或形状不对（宿主版本过旧）就静默不注册。
    if (inputTriggers && typeof inputTriggers.registerSource === 'function') {
      const register = () => inputTriggers.registerSource(source);
      // 优先经 ctx.effect 注册（宿主支持时可在插件卸载时正确回收）；
      // 老宿主没有 effect 就直接注册。
      if (typeof ctx.effect === 'function') {
        ctx.effect(register, 'dsh-tabbit: @tab source');
      } else {
        register();
      }
    }
  },
};

return module.exports; } });
