import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

export async function createSourceManifest(root) {
  const paths = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.DS_Store') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
    }
  }
  for (const directory of ['apps', 'packages', 'config', 'scripts', 'docs', 'tests']) await walk(join(root, directory));
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'tokens.css', 'README.md', 'LICENSE-POLICY.md', 'THIRD_PARTY.md']) paths.push(join(root, path));
  const files = {};
  for (const path of paths.sort()) files[relative(root, path).replaceAll('\\', '/')] = createHash('sha256').update(await readFile(path)).digest('hex');
  const sourceDigest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return { schemaVersion: 1, algorithm: 'sha256', sourceDigest, files };
}
