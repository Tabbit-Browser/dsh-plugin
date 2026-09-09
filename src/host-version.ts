/*
 * 读取当前宿主 DSH 的版本号，给 update-check.ts 的兼容性过滤用。
 *
 * update-check.ts 本身是纯逻辑、不导入任何 dsh 包（见该文件头注释），所以这
 * 一步单独放在这里，由 core/index.ts、installer/index.ts 两个接线点调用后
 * 把结果当普通字符串传进去。
 *
 * 做法：同一次 harness 发布里，所有 @deepseek-ai/dsh-* 包共享同一个版本号
 * （monorepo 定长版本号），挑一个本来就有硬运行时依赖的包读它 resolve 出来
 * 的 package.json 版本即可，不需要宿主额外暴露任何新 API。选 dsh-tools：
 * installer/index.ts 已经在用它的 defineTool，保证宿主环境下这个包总是能
 * resolve 到。
 */
import { createRequire } from 'node:module';

let cachedHostVersion: string | null | undefined;

/* resolve 不到（旧宿主没装、测试环境等）或字段缺失 → undefined，调用方按
 * "不知道宿主版本，不做兼容性过滤"处理，绝不能因为这一步失败就打断更新检查。 */
export function readHostVersion(): string | undefined {
  if (cachedHostVersion !== undefined) return cachedHostVersion ?? undefined;
  try {
    const require = createRequire(import.meta.url);
    const manifest = require('@deepseek-ai/dsh-tools/package.json') as { version?: unknown };
    cachedHostVersion = typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    cachedHostVersion = null;
  }
  return cachedHostVersion ?? undefined;
}
