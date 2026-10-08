# dsh-tabbit — Tabbit 的 DeepSeek Harness 官方插件

[English](README.en.md) | **简体中文** | [Changelog](CHANGELOG.md)

![Tabbit Browser for DeepSeek Harness](assets/dsh-tabbit-banner.png)

Tabbit Browser 的 DeepSeek Harness（dsh）插件包（bundle）。dsh 可以通过此插件调用 Tabbit 完成 Agent 任务：真实页面、真实登录态、真实交互，经原生 code-first 工具驱动（不走 shell 转发）。适用于网页自动化、信息提取、QA 与评测。

## 能力

| 能力 | 说明 |
|---|---|
| **`tabbit_browser`** | 用户使用真实的 Tabbit 内置的 CLI 模式执行网页读取和网页操作。 |
| **浏览器代理的 `web_fetch`** | 把 dsh 的 `web_fetch` 改接到 Tabbit 上（dsh 自带的直连抓取器无 JS 渲染、无登录态、不走系统代理——在 fake-ip 代理环境下所有域名都会被它拒绝）。 |
| **"网页标签"输入框提及 `@`** | 在 dsh Web UI 输入框敲 `@`，会列出本会话浏览器任务中打开的页面**以及用户浏览器里的全部标签页**，可以选中成为上下文。 |
| **独立"页面读取"权限** | 完善的权限控制。因为与用户共享 cookie，dsh 访问 Tabbit 网页时会确认权限`pageAccess`（默认每会话询问一次）+ `intranetFetch`（web_fetch 访问内网目标默认逐次审批）。 |
| **`tabbit_browser_install` 工具** | 环境预检：检测已装稳定版 Tabbit、校验 launcher 与 Runtime Service；缺装/过旧时以 dsh 后台任务下载 Tabbit。 |
| **`tabbit_plugin_update` 工具** | 插件更新检查：每天最多查一次 npm 上的最新发布，有合适版本会离线静默安装； |
| **`/tabbit-info` 命令** | 在 dsh 输入框内输入 `/tabbit-info` 可诊断：插件与宿主 DSH 版本、launcher、实例列表（含产品名）、生效实例及来源、权限设置、任务占用。 |
| **`tabbit` skill** | 告知模型使用 Tabbit 的最佳实践。默认使用 Tabbit 自带的 `~/.agents/skills/tabbit/` 的官方 skill（随浏览器 Runtime 同步演进）。本插件内为兜底版本。 |

## 安装

### 前置条件

- 已安装稳定版 Tabbit Browser（[国际版](https://www.tabbit.ai) 或 [国内版](https://www.tabbit.com/)，≥1.9.0），且启动过（首次启动时注册 CLI launcher）；
- Node ≥ 22.19、dsh ≥ 0.1.1-rc.2（dsh 安装：`npm install -g @deepseek-ai/dsh`）。低于 0.1.2-alpha.1 的宿主上，网页版会话里内置的 `web_fetch` 工具不可用（`tabbit_browser` 不受影响）。


### 安装 dsh-tabbit
```bash
dsh plugin --profile web add dsh-tabbit                 # npm 主路线
```

### 其他安装模式

```bash
dsh plugin --profile web add github:Tabbit-Browser/dsh-tabbit # npm 不可达时的回退
dsh plugin --profile web add link:/path/to/dsh-tabbit   # 本地开发
```

> 本包取代早期的 `tabbit-browser` skill-only 插件；npm 上的 0.2.x 版本也由本版本接续——0.2.x 用户经每日更新检查会收到升级提示，重跑安装命令即可原地升级。

## 社区与交流

欢迎扫描下方二维码加入 **dsh-tabbit 开发者交流群**，交流使用心得、反馈问题与探讨新特性：

![dsh-tabbit 开发者交流群](assets/dsh-tabbit-developer-community-qr-2.jpg)

## 设置

### 基本配置
DSH 0.2+：在插件设置中编辑 `tabbit-browser`，或在 profile 的 `cordis.patch.yml` 中写入：

```yaml
- id: tabbit-browser
  config:
    instance: ""          # 显式指定 16 位大写 hex 实例 id；通常留空
    launcherPath: ""      # 留空时自动发现 tabbit-cli
    pageAccess: ask       # ask（每会话一次）| always | never
    intranetFetch: ask    # 内网 web_fetch：ask（每会话每 origin 一次）| always | never
```

DSH 0.1.x：将这四项写在 `$DSH_HOME/settings.yaml` 的 `tabbit:` 节下。升级到 0.2 后，插件会迁移旧值；已有的新配置优先。

### 实例解析优先级

当本机有多个 Tabbit 版本时的优先级配置

1. `tabbit.instance` 显式设置；
2. **正在查看 dsh-web 的 Tabbit 实例**（自动检测：页面加载时 client 插件向 `/tabbit/instance-hint` 打点，服务端由 loopback socket 对端进程沿父链匹配实例注册表的 `browserPid`；仅 macOS，非 Tabbit 浏览器打开时自然不命中）——"在哪个 Tabbit 里看，就在哪个 Tabbit 里执行"；
3. 继承的 `TABBIT_PLAYWRIGHT_INSTANCE` 环境变量（嵌入形态：Tabbit 启动打包的 dsh 时注入自己的实例 id，即为权威通道）；
4. 注册表自动选择（唯一在线实例；歧义时报带实例列表的引导错误。Windows 上注册表不可读时委托原生 CLI 自行选择）。

当前生效来源可用 `/tabbit-info` 命令查看（`execution instance: ... (via ...)`）。

Full access 说明：dsh 的 `danger-full-access` 权限预设会给会话写入审批策略 `never`（dsh 定义为"自动拒绝一切询问"）。本插件的权限门检测到该覆盖时**自动放行**，不再发出注定被拒的询问——Full access 就是完全访问（该模式下 bash 本就不受限，单拦浏览器工具没有防御价值）。例外：部署级把审批默认配成 `never`（非会话覆盖）时公开 API 读不到，仍会被拒；无审批通道的组合（如某些 headless 编排）会得到指明 `tabbit.pageAccess: always` 出路的拒绝信息。

## 权限及安全

- 基于对用户数据安全和用户登录态权限的考量，设计了独立的 `pageAccess` 权限，该权限独立于文件系统/沙箱权限，默认需用户确认。
- 授权记录：某工具调用成功后，本会话后续调用不再重复询问；失败不记入（失败后重试会再次询问）。

## 开发

项目的开发和测试依赖本地的 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 环境。
由于 `@deepseek-ai/*` 系列包在 npm 上的发布版本普遍滞后，不能直接作为依赖安装，因此需要先在本地构建好一份 harness 检出，再通过下方脚本将仓库内的 .dsh-harness 符号链接指向它（该路径已在 .gitignore 中忽略）。
整个流程只需配置这一处，`tsconfig.json` 和 `package.json` 均无需改动。

Deepseek Harness 代码获取及安装（如果已安装请忽略）
```bash
git clone https://github.com/deepseek-ai/deepseek-harness && cd deepseek-harness && pnpm install && pnpm build && cd ..
```

将本机的 Deepseek 环境路径修改并 ln 到本项目，将 `/path/to/deepseek-harness` 改为你的实际目录。
```bash
npm run link-harness -- /path/to/deepseek-harness   # 或设置环境变量 DSH_HARNESS_PATH
```

安装和编译
```bash
pnpm install && pnpm build   # tsc → lib/
npm test                     # 构建 + node --test tests/
```

## 已知限制 / 路线图

- 收藏夹/书签的提及暂不支持。
- 截图进上下文要求当前模型路由支持图像输入。
- Windows 版本回归测试有限。
