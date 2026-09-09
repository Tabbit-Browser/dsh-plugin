/*
 * ============================================================================
 * 文件职责：插件自身的「每日更新检查」——纯逻辑层
 * ============================================================================
 *
 * 出处：自 github:Tabbit-Browser/dsh-tabbit（本包 npm 0.2.x 世代）的
 * update-check.js 移植。0.2.x 起线上用户就带着这套机制：skill 每次加载时
 * 顺带比对「已装版本 vs 发布仓库 CHANGELOG.md 的最新版本段」，有新版就在
 * skill 正文顶部插一段更新通知，由模型转告用户并询问是否升级。
 * 【0.3.0 起 CHANGELOG 的最新段落就是老用户看到的升级文案】——写它时开头
 * 500 字符要能独立成文（见 truncateChangelog 的截断规则）。
 *
 * 设计约束（缓存/退避/拒绝记忆沿袭 0.2.x，保证升级用户行为连续）：
 *  - 每天最多查一轮：成功结果缓存 24 小时；失败也静默退避 24 小时
 *    （离线用户不该每次会话都白等超时）；
 *  - 【更新源自 0.3.0 起改为 npm】
 *  - 用户拒绝过的版本记下来不再重复announce（更新的版本出现才再提）；
 *  - 缓存文件路径【必须与 0.2.x 相同】（XDG 缓存下 tabbit-dsh/），
 *    这样 0.2.x → 0.3.x 升级后 dismissed 记录、退避状态原样继续生效。
 *
 * 本文件是纯逻辑（不依赖任何 dsh 包），两处接线在别的文件：
 *  - core/index.ts 的 skill provider：get() 返回正文前调 prependUpdateNotice；
 *  - installer/index.ts：注册 `tabbit_plugin_update` 工具（记录拒绝/强制重查）。
 * 两处接线都要把 host-version.ts 读到的当前宿主 DSH 版本，当作
 * checkPluginUpdate 的 hostVersion 传进来——这一步不能挪进本文件（会破坏
 * "不依赖任何 dsh 包"），只能由接线点做。
 *
 * 【宿主兼容性过滤】：harness 还在 alpha 阶段、会有破坏性更新（背景见
 * AGENTS.md），npm 的 latest 不代表"当前宿主装得动"。fetchLatestRelease 现在
 * 不再无脑推荐 npm 报的最新版，而是用 CHANGELOG 里每个版本段声明的
 * "Requires DSH >= X"（发布约定见 AGENTS.md）挑一个当前宿主版本满足下限的最
 * 新版本；hostVersion 判不出、或改动没提过新下限时，行为退化成"就是 npm 报
 * 的最新版"，跟没有这项特性之前完全一致。
 *
 * 【浏览器托管形态的静默】：Tabbit Browser 预装（vendored）形态下插件版本
 * 由浏览器随自身更新管理，若照通知里的 `dsh plugin add` 跑一遍，会把浏览器
 * 托管的安装覆盖成 npm 版、脱离浏览器的版本管理。嵌入形态的权威信号是
 * 浏览器启动 dsh 时注入的 TABBIT_PLAYWRIGHT_INSTANCE 环境变量——检测到它
 * 就整套静默（不发请求、不插通知；用户手动设了该变量的极小众场景会被误伤，
 * 代价可接受）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
/* 单个网络请求限时 1.5 秒：更新检查是锦上添花，绝不能拖慢 skill 加载。
 * 最坏路径是两个串行请求（有新版时才有第二个），每天最多一轮。 */
const FETCH_TIMEOUT_MS = 1500;
/* 通知里塞给模型的变更摘要上限（CHANGELOG 版本段压平空白后截断到此长度）。 */
const CHANGELOG_MAX_CHARS = 500;
/*
 * 版本真相源：npm registry 的 latest 版本清单（标准公开端点，无需鉴权、
 * 无 GitHub API 式的匿名配额问题）。可用环境变量 TABBIT_PLUGIN_UPDATE_URL
 * 覆盖（测试/私有镜像用；覆盖的是这个 JSON 清单地址）。
 * 注意：0.2.x 存量安装轮询的是旧仓库 Tabbit-Browser/dsh-tabbit main 的
 * raw CHANGELOG.md——想通知到他们，旧仓库的 CHANGELOG.md 需要镜像新版本段
 * （见 AGENTS.md 的发布流程）。
 */
const DEFAULT_MANIFEST_URL = 'https://registry.npmjs.org/dsh-tabbit/latest';
/* 变更说明源：jsdelivr 按版本锚定的发布 tarball 内 CHANGELOG.md（锚定 URL
 * 内容不可变、可永久缓存；解析新鲜度由上面的 registry 清单保证）。 */
function defaultChangelogUrl(version: string): string {
  return `https://cdn.jsdelivr.net/npm/dsh-tabbit@${encodeURIComponent(version)}/CHANGELOG.md`;
}
/* 本包 package.json 的位置（编译后本文件在 lib/ 下，包根在上一级）。 */
const PACKAGE_URL = new URL('../package.json', import.meta.url);

/* 进程级缓存已读到的本包版本（null = 读过但失败，undefined = 还没读过）。 */
let cachedLocalVersion: string | null | undefined;

/* "1.9.2" / "v1.9" → [1,9,2]；解析不出（空/乱格式）→ undefined。 */
function numericVersion(version: unknown): number[] | undefined {
  const match = String(version ?? '').trim().match(/^v?(\d+(?:\.\d+)*)/i);
  return match?.[1] !== undefined ? match[1].split('.').map(Number) : undefined;
}

/*
 * 数字段逐段比较两个版本号：1 = left 新，-1 = right 新，0 = 相等；
 * 任一方解析不出 → undefined（调用方把 undefined 当"不可比、不提示"处理）。
 */
export function compareVersions(left: unknown, right: unknown): -1 | 0 | 1 | undefined {
  const leftParts = numericVersion(left);
  const rightParts = numericVersion(right);
  if (!leftParts || !rightParts) return undefined;
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a !== b) return a > b ? 1 : -1;
  }
  return 0;
}

/*
 * 宿主 DSH 版本比较——跟上面的 compareVersions（比插件自己的纯数字版本号）
 * 分开：DSH 版本形如 "0.1.2-alpha.3"／"0.1.1-rc.2"，真实 tag 历史里出现过
 * alpha→rc 这种同一 patch 内的跨标签演进（见 AGENTS.md 的发布记录），纯数字
 * 比较会把它们错误地判成相等。标签成熟度顺序按 HOST_PRERELEASE_ORDER 定义；
 * 出现表外标签、或任一方解析不出格式 → undefined（不可比，调用方按"不知道，
 * 不做兼容性过滤"处理，绝不能因为一次解析失败就拦掉正常的更新提示）。
 */
const HOST_PRERELEASE_ORDER = ['alpha', 'beta', 'rc'];

function parseHostVersion(value: unknown): { core: number[]; tag?: string; tagSeq?: number } | undefined {
  const match = String(value ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z]+)\.(\d+))?$/);
  if (!match) return undefined;
  const [, major, minor, patch, tag, tagSeq] = match;
  return {
    core: [Number(major), Number(minor), Number(patch)],
    tag: tag?.toLowerCase(),
    tagSeq: tagSeq !== undefined ? Number(tagSeq) : undefined,
  };
}

export function compareHostVersions(left: unknown, right: unknown): -1 | 0 | 1 | undefined {
  const a = parseHostVersion(left);
  const b = parseHostVersion(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (a.tag === undefined && b.tag === undefined) return 0;
  if (a.tag === undefined) return 1; // 正式版比任何预发布版新。
  if (b.tag === undefined) return -1;
  if (a.tag !== b.tag) {
    const aRank = HOST_PRERELEASE_ORDER.indexOf(a.tag);
    const bRank = HOST_PRERELEASE_ORDER.indexOf(b.tag);
    if (aRank === -1 || bRank === -1) return undefined; // 表外标签：不可比。
    return aRank === bRank ? 0 : aRank > bRank ? 1 : -1;
  }
  if (a.tagSeq === b.tagSeq) return 0;
  return (a.tagSeq ?? 0) > (b.tagSeq ?? 0) ? 1 : -1;
}

/* 压平所有空白（含换行）为单个空格——CHANGELOG 段落要塞进单行通知。 */
export function flattenChangelog(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/* 压平后截断到 500 字符（尾部加省略号）。 */
export function truncateChangelog(text: unknown): string {
  const value = flattenChangelog(text);
  if (value.length <= CHANGELOG_MAX_CHARS) return value;
  return `${value.slice(0, CHANGELOG_MAX_CHARS - 1).trimEnd()}…`;
}

/*
 * 从 CHANGELOG.md 全文里抠出【最新一个版本段】：
 * 找第一个 `## <版本号>` 标题行，取它到下一个 `## ` 之间的内容作为变更摘要。
 * 没有版本标题 = 文件坏了，抛错（调用方把抛错当"检查失败"静默处理）。
 */
export function parseLatestChangelog(markdown: unknown): { version: string; changelog: string } {
  const match = String(markdown ?? '').match(/^## +(v?\d+(?:\.\d+)+).*$/m);
  if (!match || match.index === undefined) throw new Error('Latest changelog has no version heading.');
  const version = numericVersion(match[1])?.join('.');
  if (version === undefined) throw new Error('Latest changelog heading has no usable version.');
  const sectionStart = match.index + match[0].length;
  const rest = String(markdown).slice(sectionStart);
  const nextSection = rest.search(/^## +/m);
  const section = nextSection === -1 ? rest : rest.slice(0, nextSection);
  return { version, changelog: truncateChangelog(section) };
}

/*
 * 缓存文件的默认位置（【与 0.2.x 完全一致】，保证升级后状态连续）：
 *   XDG_CACHE_HOME（设了就用）> Windows 的 LOCALAPPDATA > ~/.cache，
 * 之下 tabbit-dsh/update-check.json。
 */
export function defaultCacheFile(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const base =
    env.XDG_CACHE_HOME ||
    (platform === 'win32' ? env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local') : undefined) ||
    join(homedir(), '.cache');
  return join(base, 'tabbit-dsh', 'update-check.json');
}

/* 读本包已安装版本（package.json 的 version；读不到 → undefined，检查报 unknown）。 */
export async function readLocalVersion(): Promise<string | undefined> {
  if (cachedLocalVersion !== undefined) return cachedLocalVersion ?? undefined;
  try {
    const parsed = JSON.parse(await readFile(PACKAGE_URL, 'utf8')) as { version?: unknown };
    cachedLocalVersion = typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    cachedLocalVersion = null;
  }
  return cachedLocalVersion ?? undefined;
}

/* 磁盘缓存的形状（字段全可缺；文件坏了当空对象）。 */
export interface UpdateCheckCache {
  /* 最近一次【成功】拿到发布信息的时间戳。 */
  checkedAt?: number;
  /* 最近一次发起请求的时间戳（无论成败；失败退避靠它）。 */
  lastAttemptAt?: number;
  latestVersion?: string;
  changelog?: string;
  /* 用户明确拒绝过的版本（不再重复announce）。 */
  dismissedVersion?: string;
  [key: string]: unknown;
}

export async function readCachedCheck(cacheFile: string): Promise<UpdateCheckCache> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile, 'utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as UpdateCheckCache) : {};
  } catch {
    return {};
  }
}

async function writeCachedCheck(cacheFile: string, state: UpdateCheckCache): Promise<void> {
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/* 限时取回一个 URL 的完整文本（含响应体读取都在超时保护内）。 */
async function fetchTextWithTimeout(url: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Update check failed with HTTP ${response.status}.`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/*
 * 从 CHANGELOG 全文抠出【指定版本】的段落（压平+截断后返回）。
 * 与 parseLatestChangelog（取最新段）的分工：这里按 registry 报的版本精确
 * 定位——锚定 tarball 里最新段理应就是该版本，但万一发布时忘了加条目、
 * 或段落顺序有误，精确匹配能避免把别的版本的说明安到这个版本头上。
 * 精确段缺失时退回"最新段"，且仅当最新段的版本号与目标一致才采用；
 * 都不成立返回 undefined（通知降级为无摘要）。
 */
export function changelogSectionFor(markdown: unknown, version: string): string | undefined {
  const source = String(markdown ?? '');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const heading = source.match(new RegExp(`^## +v?${escaped}(?!\\S).*$`, 'm'));
  if (heading !== null && heading.index !== undefined) {
    const rest = source.slice(heading.index + heading[0].length);
    const next = rest.search(/^## +/m);
    const section = truncateChangelog(next === -1 ? rest : rest.slice(0, next));
    return section !== '' ? section : undefined;
  }
  try {
    const latest = parseLatestChangelog(source);
    if (compareVersions(latest.version, version) === 0 && latest.changelog !== '') return latest.changelog;
  } catch {
    // 整个文件没有版本标题：没有可用摘要。
  }
  return undefined;
}

/* 一个 changelog 版本段解析出的元数据：本段【显式】声明的宿主下限。没写
 * 不代表没要求——是"这版没有把下限进一步抬高"，继承逻辑见
 * withEffectiveFloors。 */
export interface ChangelogVersionEntry {
  version: string;
  requiresHost?: string;
}

/*
 * 按【文件出现顺序】（约定新版本段在前）抠出每个 `## 版本号` 段自己写了什么
 * 宿主下限——不做继承，如实反映每段内容，继承是 withEffectiveFloors 的职责。
 * 固定格式（发布流程见 AGENTS.md）：版本段正文里独占一行的
 * "Requires DSH >= <版本号>."。
 */
export function parseChangelogVersions(markdown: unknown): ChangelogVersionEntry[] {
  const source = String(markdown ?? '');
  const headingRe = /^## +(v?\d+(?:\.\d+)+).*$/gm;
  const headings = [...source.matchAll(headingRe)];
  return headings.map((heading, index) => {
    const version = numericVersion(heading[1])?.join('.') ?? heading[1];
    const sectionStart = (heading.index ?? 0) + heading[0].length;
    const sectionEnd = headings[index + 1]?.index ?? source.length;
    const body = source.slice(sectionStart, sectionEnd);
    const required = body.match(/^Requires DSH >= +(\S+)[ \t]*$/mu)?.[1];
    return { version, requiresHost: required?.replace(/\.$/u, '') };
  });
}

/* 把"没写下限"替换成"离它最近的更早版本声明过的下限"（下限只升不降）。 */
function withEffectiveFloors(entries: readonly ChangelogVersionEntry[]): { version: string; floor?: string }[] {
  let floor: string | undefined;
  // entries 是新→旧；从旧往新走才能把"最近一次显式声明"正确地结转给后面没写的版本。
  const oldestFirst = [...entries].reverse().map(entry => {
    if (entry.requiresHost !== undefined) floor = entry.requiresHost;
    return { version: entry.version, floor };
  });
  return oldestFirst.reverse();
}

/*
 * 在 changelog 全部版本段里，找【当前宿主能跑的、且不比 ceilingVersion
 * （npm 报的最新版）新】的那个最新版本：
 *  - hostVersion 缺失（调用方判断不出当前宿主版本）→ 不过滤，原样给
 *    ceilingVersion（行为等同没有这个特性之前）；
 *  - 某候选没声明过下限，或下限跟宿主版本不可比（格式解析不出）→ 该候选判不了
 *    兼容性，不敢当作满足，继续找更旧的一个；
 *  - 全部候选都不满足/判不了 → undefined（调用方据此退回"没有可推荐的新版"，
 *    绝不能矬子里拔将军选一个判不了兼容性的版本推给用户）。
 */
export function selectCompatibleVersion(
  entries: readonly ChangelogVersionEntry[],
  ceilingVersion: string,
  hostVersion: string | undefined,
): string | undefined {
  if (hostVersion === undefined) return ceilingVersion;
  const candidates = withEffectiveFloors(entries).filter(({ version }) => compareVersions(version, ceilingVersion) !== 1);
  for (const { version, floor } of candidates) {
    if (floor === undefined) return version;
    const cmp = compareHostVersions(hostVersion, floor);
    if (cmp !== undefined && cmp !== -1) return version;
  }
  return undefined;
}

/* 一次发布的元数据（changelog 缺失 = 只有版本、没有变更摘要）。 */
export interface LatestRelease {
  version: string;
  changelog?: string;
}

export interface FetchLatestReleaseOptions {
  /* 版本清单（JSON）地址；默认 npm registry 的 latest 端点。 */
  manifestUrl?: string;
  /* 按版本号生成变更说明（Markdown）地址；默认 jsdelivr 锚定 tarball。 */
  changelogUrlFor?: (version: string) => string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /* 已装版本：不比它新就跳过变更说明请求（多数日子只发一个请求）。 */
  currentVersion?: string;
  /* 当前宿主 DSH 版本；缺失 = 不做兼容性过滤，行为等同没有这项特性
   * （见 selectCompatibleVersion）。 */
  hostVersion?: string;
}

/*
 * 取最新发布：
 *  1. 问 npm registry latest 清单拿版本号（版本真相，失败即整个检查失败、
 *     进入 24h 退避）；
 *  2. 只有确认比已装新，才去 jsdelivr 拉锚定该版本的 CHANGELOG.md 全文——
 *     这步任何失败都只降级为"无摘要"，绝不挡升级提示（jsdelivr 在部分网络
 *     环境下可达性弱于 registry，不能让它拖垮主通道）；
 *  3. 全文（不只是 npm 报的那个版本段）拿去 selectCompatibleVersion 挑一个
 *     当前宿主真正跑得动的版本——可能就是 npm 报的最新版，也可能是更旧的一
 *     个（宿主太老、追不上最新版的宿主下限时）；一个都追不上就退回已装版本
 *     （= 没有可推荐的更新，绝不矬子里拔将军推一个大概率跑不动的版本）。
 */
export async function fetchLatestRelease({
  manifestUrl = process.env.TABBIT_PLUGIN_UPDATE_URL || DEFAULT_MANIFEST_URL,
  changelogUrlFor = defaultChangelogUrl,
  timeoutMs = FETCH_TIMEOUT_MS,
  fetchImpl = fetch,
  currentVersion,
  hostVersion,
}: FetchLatestReleaseOptions = {}): Promise<LatestRelease> {
  const manifest = JSON.parse(await fetchTextWithTimeout(manifestUrl, timeoutMs, fetchImpl)) as { version?: unknown };
  const npmVersion = typeof manifest.version === 'string' ? manifest.version.trim() : '';
  if (numericVersion(npmVersion) === undefined) throw new Error('npm manifest has no usable version.');
  if (currentVersion !== undefined && compareVersions(npmVersion, currentVersion) !== 1) return { version: npmVersion };
  let changelogText: string;
  try {
    changelogText = await fetchTextWithTimeout(changelogUrlFor(npmVersion), timeoutMs, fetchImpl);
  } catch {
    return { version: npmVersion };
  }
  const picked = selectCompatibleVersion(parseChangelogVersions(changelogText), npmVersion, hostVersion);
  const version = picked ?? currentVersion ?? npmVersion;
  const changelog = changelogSectionFor(changelogText, version);
  return changelog !== undefined ? { version, changelog } : { version };
}

function isRecent(timestamp: unknown, now: number): boolean {
  return typeof timestamp === 'number' && now - timestamp < DAY_MS;
}

/* 检查结论的三态 + 附带信息。 */
export interface UpdateSummary {
  status: 'current' | 'update-available' | 'unknown';
  currentVersion?: string;
  latestVersion?: string;
  changelog?: string;
}

/*
 * 把"已装版本 + 已知最新版本 + 拒绝记录"归纳成结论：
 *  - 任一版本缺失/不可比 → unknown（静默，不打扰）；
 *  - 最新 ≤ 已装，或最新恰是用户拒绝过的 → current；
 *  - 否则 → update-available（带变更摘要）。
 */
export function summarizeUpdate({
  currentVersion,
  latestVersion,
  changelog,
  dismissedVersion,
}: {
  currentVersion?: string;
  latestVersion?: string;
  changelog?: string;
  dismissedVersion?: string;
}): UpdateSummary {
  if (currentVersion === undefined || latestVersion === undefined) return { status: 'unknown', currentVersion };
  if (compareVersions(latestVersion, currentVersion) !== 1 || latestVersion === dismissedVersion) {
    return { status: 'current', currentVersion, latestVersion };
  }
  return { status: 'update-available', currentVersion, latestVersion, changelog };
}

function summaryFromCache(currentVersion: string | undefined, cached: UpdateCheckCache): UpdateSummary {
  return summarizeUpdate({
    currentVersion,
    latestVersion: cached.latestVersion,
    changelog: cached.changelog,
    dismissedVersion: cached.dismissedVersion,
  });
}

async function fetchAndCacheRelease({
  currentVersion,
  hostVersion,
  cached,
  cacheFile,
  now,
  fetchRelease,
}: {
  currentVersion: string | undefined;
  hostVersion: string | undefined;
  cached: UpdateCheckCache;
  cacheFile: string;
  now: number;
  fetchRelease: (context: { currentVersion?: string; hostVersion?: string }) => Promise<LatestRelease>;
}): Promise<UpdateSummary> {
  const state: UpdateCheckCache = { ...cached, lastAttemptAt: now };
  try {
    const release = await fetchRelease({ currentVersion, hostVersion });
    state.checkedAt = now;
    state.latestVersion = release.version;
    // 有意整体覆盖（包括写入 undefined→序列化时丢弃）：旧版本的摘要绝不能
    // 残留下来配错到新版本号头上。
    state.changelog = release.changelog;
  } catch {
    // 保留 lastAttemptAt：失败也静默退避一天再试（离线用户不被反复拖慢）。
  }
  try {
    await writeCachedCheck(cacheFile, state);
  } catch {
    // 缓存目录只读等写失败不影响本次结论（只是下次会重查）。
  }
  return summaryFromCache(currentVersion, state);
}

export interface CheckPluginUpdateOptions {
  now?: number;
  cacheFile?: string;
  fetchRelease?: (context: { currentVersion?: string; hostVersion?: string }) => Promise<LatestRelease>;
  readVersion?: () => Promise<string | undefined>;
  /* 当前宿主 DSH 版本；缺失 = 不做兼容性过滤。跟 latestVersion/changelog 一样
   * 走 24h 缓存——宿主版本在这 24 小时内变了，最坏情况是晚一天才反映，跟这个
   * 文件"每天最多查一轮"的既有取舍一致，不单独为它加请求。 */
  hostVersion?: string;
  /* true = 跳过日缓存与失败退避，立即重查（tabbit_plugin_update 的 refresh）。 */
  force?: boolean;
}

/*
 * 检查主入口。非 force 时的省流顺序：
 *  1. 24 小时内成功查过 → 直接用缓存归纳；
 *  2. 24 小时内失败过 → unknown（退避中，不发请求）；
 *  3. 否则才真正发请求并写缓存。
 */
export async function checkPluginUpdate({
  now = Date.now(),
  cacheFile = defaultCacheFile(),
  fetchRelease = fetchLatestRelease,
  readVersion = readLocalVersion,
  hostVersion,
  force = false,
}: CheckPluginUpdateOptions = {}): Promise<UpdateSummary> {
  const currentVersion = await readVersion();
  const cached = await readCachedCheck(cacheFile);
  if (!force) {
    if (isRecent(cached.checkedAt, now) && cached.latestVersion !== undefined) {
      return summaryFromCache(currentVersion, cached);
    }
    if (isRecent(cached.lastAttemptAt, now)) {
      return { status: 'unknown', currentVersion };
    }
  }
  return fetchAndCacheRelease({ currentVersion, hostVersion, cached, cacheFile, now, fetchRelease });
}

/* 记录"用户拒绝了这个版本"（skill 从此不再announce它；更新的版本出现才再提）。 */
export async function dismissUpdate(
  version: unknown,
  { cacheFile = defaultCacheFile() }: { cacheFile?: string } = {},
): Promise<UpdateCheckCache> {
  const cached = await readCachedCheck(cacheFile);
  const state: UpdateCheckCache = { ...cached, dismissedVersion: String(version ?? '').trim() };
  await writeCachedCheck(cacheFile, state);
  return state;
}

/*
 * 浏览器托管形态判定（见文件头）：TABBIT_PLAYWRIGHT_INSTANCE 是浏览器启动
 * 嵌入 dsh 时注入的权威通道，出现即认为插件版本归浏览器管、整套更新检查静默。
 */
export function isBrowserManagedInstall(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.TABBIT_PLAYWRIGHT_INSTANCE;
  return value !== undefined && value !== '';
}

/*
 * 生成插到 skill 正文顶部的更新通知（Markdown 引用块）。
 * 【只用本地模板拼接】：changelog 摘要来自我们自己仓库的 CHANGELOG，且以
 * 数据形式呈现——通知里的行动指令（问用户、跑哪条命令、怎么 dismiss）全部
 * 是这里硬编码的模板文字，摘要影响不了指令本身。
 */
export function formatUpdateNotice({
  currentVersion,
  latestVersion,
  changelog,
}: {
  currentVersion?: string;
  latestVersion?: string;
  changelog?: string;
}): string {
  return [
    `> **Plugin update available**: dsh-tabbit ${latestVersion} (installed ${currentVersion}).`,
    changelog !== undefined && changelog !== '' ? `> New in ${latestVersion}: ${changelog}` : null,
    '> Show the offered version and these changes to the user, then ask whether to update now.',
    '> If they agree, tell them to rerun the install command below over the current install and restart the DSH session afterwards:',
    '> ```bash',
    '> dsh plugin --profile web add dsh-tabbit',
    '> ```',
    `> If they decline, call \`tabbit_plugin_update\` with \`dismiss: "${latestVersion}"\`, then continue the task.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/*
 * 给 skill 正文加前缀通知（core 的 skill provider get() 调用）：
 *  - 浏览器托管形态：原样返回（版本归浏览器管，见文件头）；
 *  - 检查抛错/没有新版：原样返回；
 *  - 有新版：通知 + 空行 + 原正文。
 */
export async function prependUpdateNotice(
  content: string,
  checkUpdate: (options?: CheckPluginUpdateOptions) => Promise<UpdateSummary> = checkPluginUpdate,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (isBrowserManagedInstall(env)) return content;
  let update: UpdateSummary;
  try {
    update = await checkUpdate();
  } catch {
    return content;
  }
  if (update.status !== 'update-available') return content;
  return `${formatUpdateNotice(update)}\n\n${content}`;
}

/* `tabbit_plugin_update` 工具的结果文案（installer/index.ts 注册处调用）。 */
export function messageForUpdate(update: UpdateSummary): string {
  if (update.status === 'update-available') {
    const changes = update.changelog !== undefined && update.changelog !== '' ? update.changelog : 'see the release notes';
    return `dsh-tabbit ${update.latestVersion} is available (installed ${update.currentVersion}). New in this version: ${changes}. Ask the user whether to update now.`;
  }
  if (update.status === 'current') {
    return `The dsh-tabbit plugin is up to date (${update.currentVersion}).`;
  }
  return 'Could not determine the latest dsh-tabbit plugin version. The check stays silent for a day before retrying.';
}
