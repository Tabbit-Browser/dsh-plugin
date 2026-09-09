/*
 * ============================================================================
 * 文件职责：`tabbit_browser_install` 与 `tabbit_plugin_update` 两个运维工具
 * ============================================================================
 *
 * 【tabbit_browser_install】让模型在第一次动 `tabbit_browser` 之前先跑一次
 * 体检：机器上装没装稳定版 Tabbit？版本够不够（最低 1.9.0）？Runtime
 * Service 通不通？三种结论：
 *   - ready            一切就绪（结果按会话缓存，之后调用秒回）；
 *   - restart-required 装了、版本也够，但 Runtime Service 不可达——请用户
 *                      重启一次 Tabbit（launcher/endpoint 是浏览器启动时注册的）；
 *   - background       没装或版本太旧——已在后台开始下载对应地区的安装器
 *                      （国际版 tabbit.ai / 国内版 tabbit.com），下好后引导
 *                      用户自己运行安装。
 *
 * 【tabbit_plugin_update】插件自身更新检查的显式入口（逻辑在
 * ../update-check.ts）：记录用户拒绝过的版本 / 跳过日缓存强制重查。日常
 * 通知不靠这个工具——skill 每次加载时自动带出更新通知（core 的 provider）。
 *
 * 出处：自 github:Tabbit-Browser/dsh-tabbit（本包 npm 0.2.x 世代）移植。
 * 与 0.2.x 的两点刻意差异：
 *   1. 不再报告 CLI 沙箱/Full-Permission 状态——那个世代的自动化走 Bash 调
 *      CLI，要关心 shell 沙箱；我们的 `tabbit_browser` 是 dsh 原生工具，在
 *      dsh 宿主进程里直接 spawn CLI，链路里没有 shell 沙箱；
 *   2. "Runtime Service 在不在跑"以 ctx.tabbit 的实例注册表为主信号
 *      （endpoint 文件只在服务运行期间存在，严格更强），注册表读不到实例时
 *      才降级为 0.2.x 的进程探测（Windows 上注册表位置未经真机确认，降级
 *      路径是那里的主要在线判据；见 detect.ts 文件头）。
 *
 * ─── 必备背景：dsh 的 jobs（后台任务）服务 ──────────────────────────────
 * `ctx.jobs.start({kind, label, owner, run})` 启动一个后台任务：
 *   - run() 返回一个句柄 {cancel, done, readOutput}（见 download.ts 的
 *     createDownloadJob）；
 *   - dsh 会轮询 readOutput() 把输出渐进展示给用户、在 done 落定时通知——
 *     也就是说下载进度和完成提醒【不用我们自己做 UI】，挂上 jobs 就有；
 *   - owner 关联到发起的 Agent；ctx.jobs.get(jobId, owner) 可查快照状态。
 */
import { existsSync } from 'node:fs';

import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { JobId } from '@deepseek-ai/dsh-jobs';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';

import {
  detectTabbitInstallations,
  detectTabbitRuntimeProcesses,
  MINIMUM_TABBIT_VERSION,
  summarizeTabbitRuntime,
  type DetectedInstallation,
} from './detect.js';
import { createDownloadJob } from './download.js';
import { readHostVersion } from '../host-version.js';
import { checkPluginUpdate, dismissUpdate, isBrowserManagedInstall, messageForUpdate } from '../update-check.js';

import type {} from '../core/index.js';

// 模块扩充：向 dsh-jobs 的任务种类表登记我们的 kind 名（类型层面的注册，
// 让 ctx.jobs.start({kind:'tabbit-installer'}) 通过类型检查）。
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'tabbit-installer': 'tabbit-installer';
  }
}

export const name = 'tabbit-installer';
export const inject = ['tools', 'jobs', 'tabbit'];

/* 工具结果的形状（message 是渲染给模型看的主文案，其余是结构化细节）。 */
interface InstallStatus {
  status: 'ready' | 'restart-required' | 'background';
  message: string;
  /* 本次是不是直接回放的会话缓存。 */
  cached: boolean;
  jobId?: string;
  minimumVersion?: string;
  onlineInstanceCount?: number;
  installations?: DetectedInstallation[];
  [key: string]: unknown;
}

export function apply(ctx: Context): void {
  registerInstallerTool(ctx);
  registerUpdateTool(ctx);
}

/*
 * DI（依赖注入）覆盖点——【仅单元测试用】：生产路径一律走默认实现。
 * 有它才能不真装浏览器就覆盖 ready/restart-required/background 三态与
 * 会话缓存逻辑（0.2.x 世代的测试套路，随包移植）。
 */
export interface InstallerToolOverrides {
  detect?: typeof detectTabbitInstallations;
  detectRuntime?: typeof detectTabbitRuntimeProcesses;
}

export function registerInstallerTool(ctx: Context, overrides: InstallerToolOverrides = {}): void {
  const detect = overrides.detect ?? detectTabbitInstallations;
  const detectRuntime = overrides.detectRuntime ?? detectTabbitRuntimeProcesses;
  // 两张按 Agent 记账的表。用 WeakMap 的原因：键是 Agent 对象本身，会话
  // 销毁、Agent 被垃圾回收时对应条目自动消失，不需要手动清理。
  /* Agent → 已缓存的 ready 结果（"每会话只真查一次"）。 */
  const readyByOwner = new WeakMap<Agent, InstallStatus>();
  /* Agent → 进行中的下载 jobId（防止重复起下载）。 */
  const activeJobs = new WeakMap<Agent, JobId>();

  ctx.tools.register(defineTool({
    name: 'tabbit_browser_install',
    // 给模型的使用协议：每会话在首次浏览器操作前调一次；ready 结果整会话
    // 有效；只有 launcher/Runtime 报错或用户装了新版本后才带 refresh 重查。
    description: [
      'Check for a supported stable Tabbit Browser install',
      `(version ${MINIMUM_TABBIT_VERSION} or newer) and a reachable Runtime Service before`,
      'using `tabbit_browser`. Call this once before the first browser operation in a',
      "session; a `ready` result is cached for that whole session. Pass refresh only",
      'after a `tabbit_browser` launcher/Runtime failure or a Tabbit install/update.',
      'Downloads the region-appropriate installer in the background when Tabbit is',
      'missing or outdated; otherwise reports when the browser must be restarted once.',
    ].join(' '),
    parameters: {
      refresh: {
        type: 'boolean',
        description:
          "Discard this agent session's cached result and recheck everything. Use only after a launcher/Runtime failure or an install change.",
      },
    },
    output: {
      schema: { type: 'json' },
      // 渲染：只把 message 文案给模型（结构化字段仍在结果 JSON 里）。
      render: (_args, value) => [{ type: 'text', text: (value as InstallStatus).message }],
    },
    // 纯检测、无副作用冲突，声明并发安全（dsh 可与其它工具并行跑它）。
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<JsonValue> {
      const owner = exec.agent;
      // ── 第 1 步：会话缓存 ────────────────────────────────────────────
      if (owner !== undefined && args.refresh === true) readyByOwner.delete(owner);
      if (owner !== undefined && args.refresh !== true) {
        const cached = readyByOwner.get(owner);
        if (cached) {
          return {
            ...cached,
            cached: true,
            message: "Reused this session's cached environment check. The tabbit_browser tool is ready to use.",
          } satisfies InstallStatus as unknown as JsonValue;
        }
      }

      // ── 第 2 步：查有没有还在跑的下载（避免模型重复调用起一堆下载）──
      const existingJobId = owner !== undefined ? activeJobs.get(owner) : undefined;
      if (existingJobId !== undefined) {
        try {
          const snapshot = ctx.jobs.get(existingJobId, owner);
          if (snapshot.status === 'running' || snapshot.status === 'stopping') {
            return {
              status: 'background',
              message: `A Tabbit installer download is already running as ${existingJobId}. DSH will report progress and notify you when it's ready.`,
              cached: false,
              jobId: String(existingJobId),
            } satisfies InstallStatus as unknown as JsonValue;
          }
        } catch {
          // job 已经不存在（被清理了）：把陈账删掉继续走正常流程。
          if (owner !== undefined) activeJobs.delete(owner);
        }
      }

      // ── 第 3 步：安装检测（detect.ts：mac plist / win 注册表读版本）──
      const detected = await detect();
      if (detected.supportedInstallations.length === 0) {
        // 没装 or 版本不够 → 起后台下载。
        const downloadReason =
          detected.installations.length === 0
            ? 'No stable Tabbit edition is installed.'
            : `Installed stable Tabbit version(s) do not meet the minimum ${MINIMUM_TABBIT_VERSION}: ${detected.installations.map((item) => `${item.name} ${item.version ?? 'unknown'}`).join(', ')}.`;

        let jobId: JobId;
        try {
          jobId = ctx.jobs.start({
            kind: 'tabbit-installer',
            label: 'Download the region-appropriate Tabbit Browser installer',
            outputLimitBytes: 16 * 1024,
            owner,
            // run 返回 download.ts 包好的 jobs 句柄；onSettled 里把 activeJobs
            // 的账销掉（只销"还是这单"的账，防止竞态覆盖后来者）。
            run: () => createDownloadJob({ onSettled: () => { if (owner !== undefined && activeJobs.get(owner) === jobId) activeJobs.delete(owner); } }),
          });
        } catch (error) {
          // 连 jobs 都起不来：退化为指导用户自己去官网下载。
          return {
            status: 'background',
            message: `Environment check failed: ${downloadReason} Could not start a background download (${String((error as Error)?.message ?? error)}). Ask the user to download and run the Tabbit Browser installer from tabbit.ai (or tabbit.com in mainland China) themselves.`,
            cached: false,
          } satisfies InstallStatus as unknown as JsonValue;
        }
        if (owner !== undefined) activeJobs.set(owner, jobId);
        return {
          status: 'background',
          message: `Environment check failed: ${downloadReason} Started the region-appropriate Tabbit Browser installer download as ${jobId}. DSH will report progress and notify you when the installer is ready — tell the user the installer path and ask them to run it, then relaunch Tabbit Browser once.`,
          cached: false,
          jobId: String(jobId),
          minimumVersion: MINIMUM_TABBIT_VERSION,
          installations: detected.installations,
        } satisfies InstallStatus as unknown as JsonValue;
      }

      // ── 第 4 步：Runtime Service 可达性 ────────────────────────────────
      // 主信号：ctx.tabbit 的实例注册表（endpoint 在线 = 服务在跑）。
      // 降级信号：注册表里一个实例都没有时（典型是 Windows——注册表目录
      // 位置未经真机确认），扫进程表找 Runtime 常驻进程（见 detect.ts）。
      const launcherPath = ctx.tabbit.launcherPath();
      const launcherReady = existsSync(launcherPath);
      const instances = ctx.tabbit.instances();
      const onlineInstances = instances.filter((instance) => instance.online);
      const runtime = summarizeTabbitRuntime(instances.length === 0 ? detectRuntime() : []);
      const versions = detected.supportedInstallations.map((item) => `${item.name} ${item.version ?? ''}`.trim()).join(', ');

      if (launcherReady && (onlineInstances.length > 0 || runtime.running)) {
        // 全绿：ready，写入会话缓存。多实例（注册表在线数或进程数 >1）时
        // 顺带提醒可能需要选实例。
        const ambiguityNote =
          onlineInstances.length > 1
            ? ` Multiple Tabbit instances are online (${onlineInstances.length}); run /tabbit-info and set settings key tabbit.instance if the wrong one gets picked.`
            : runtime.ambiguous
              ? ` Multiple Tabbit runtime processes are running (${runtime.instanceCount}); set settings key tabbit.instance if the wrong one gets picked.`
              : '';
        const result: InstallStatus = {
          status: 'ready',
          message: `Browser installation and Runtime Service checks passed (${versions}).${ambiguityNote} The tabbit_browser tool is ready to use.`,
          cached: false,
          minimumVersion: MINIMUM_TABBIT_VERSION,
          onlineInstanceCount: onlineInstances.length,
          ...(instances.length === 0 ? { runtimeProcessCount: runtime.instanceCount } : {}),
          installations: detected.supportedInstallations,
        };
        if (owner !== undefined) readyByOwner.set(owner, result);
        return result satisfies InstallStatus as unknown as JsonValue;
      }

      // 装了、版本够，但 launcher 缺失或两路信号都说没在跑：重启一次浏览器
      // 就好（launcher 和 endpoint 都是浏览器启动时注册/发布的）。
      return {
        status: 'restart-required',
        message: `Environment check failed: ${versions} meets the minimum version ${MINIMUM_TABBIT_VERSION}, but its Runtime Service is not reachable${launcherReady ? '' : ` (launcher not found at ${launcherPath})`}. Ask the user to relaunch Tabbit Browser once, then call this tool again with refresh: true.`,
        cached: false,
        minimumVersion: MINIMUM_TABBIT_VERSION,
        onlineInstanceCount: onlineInstances.length,
        installations: detected.supportedInstallations,
      } satisfies InstallStatus as unknown as JsonValue;
    },
  }));
}

/*
 * `tabbit_plugin_update` 工具注册。给模型的使用协议（description 里也写了）：
 * 平时【不要】调它——有新版时 skill 加载已自动带出通知；只有两个场景需要：
 *   - 用户明确拒绝了通知里的版本 → dismiss 记下来，skill 从此不再提这个版本；
 *   - 插件刚更新完 / 网络恢复了 → refresh 跳过日缓存立即重查。
 * 浏览器托管（预装）形态下版本归浏览器管：直接返回 browser-managed，
 * 不发请求也不给 dsh plugin add 建议（照做会把托管安装覆盖成 npm 版）。
 * checkUpdate 调用时带上 host-version.ts 读到的当前宿主版本，"有没有新版"
 * 的判断会把宿主兼容性算进去（见 update-check.ts 的宿主兼容性过滤说明）。
 * overrides 同样仅为单元测试（假 checkUpdate/dismiss/env）。
 */
export interface UpdateToolOverrides {
  checkUpdate?: typeof checkPluginUpdate;
  dismiss?: typeof dismissUpdate;
  env?: NodeJS.ProcessEnv;
}

export function registerUpdateTool(ctx: Context, overrides: UpdateToolOverrides = {}): void {
  const checkUpdate = overrides.checkUpdate ?? checkPluginUpdate;
  const dismiss = overrides.dismiss ?? dismissUpdate;
  const env = overrides.env ?? process.env;
  ctx.tools.register(defineTool({
    name: 'tabbit_plugin_update',
    description: [
      'Record that the user declined an offered dsh-tabbit plugin version, or force a',
      'recheck of the latest published npm release. The skill already loads an update notice',
      'automatically when a newer version exists; call this tool only after the user declines',
      'an offered version, or after a plugin update or connectivity change.',
    ].join(' '),
    parameters: {
      dismiss: {
        type: 'string',
        description: 'The offered version the user declined. The skill stops announcing this version; a newer release is announced again.',
      },
      refresh: {
        type: 'boolean',
        description: 'Skip the daily cache and the failure backoff and check the latest release again.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: (value as { message: string }).message }],
    },
    isConcurrencySafe: () => true,
    async execute(args): Promise<JsonValue> {
      if (isBrowserManagedInstall(env)) {
        return {
          status: 'browser-managed',
          message:
            'This dsh-tabbit install is managed by Tabbit Browser and updates together with the browser. Do not reinstall it via dsh plugin commands.',
        };
      }
      if (args.dismiss !== undefined && args.dismiss !== '') {
        await dismiss(args.dismiss);
        return {
          status: 'dismissed',
          message: `Recorded that the user declined dsh-tabbit ${args.dismiss}. The skill will stop announcing this version; a newer release will be announced again.`,
          dismissedVersion: args.dismiss,
        };
      }
      const update = await checkUpdate({ force: args.refresh === true, hostVersion: readHostVersion() });
      return {
        status: update.status,
        message: messageForUpdate(update),
        ...(update.currentVersion !== undefined ? { currentVersion: update.currentVersion } : {}),
        ...(update.latestVersion !== undefined ? { latestVersion: update.latestVersion } : {}),
        ...(update.changelog !== undefined ? { changelog: update.changelog } : {}),
      };
    },
  }));
}
