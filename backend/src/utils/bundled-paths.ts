import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Resolve our own shipped assets, never a different checkout in the host's cwd. */
export function resolveBackendAsset(relativePath: string): string {
  const candidates = [
    path.resolve(moduleDir, '../../', relativePath),
    path.resolve(moduleDir, '../../../backend', relativePath),
  ];
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error(`Bundled backend asset missing / 缺少后端运行资源: ${relativePath}`);
  return found;
}
