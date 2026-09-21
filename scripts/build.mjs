import { build } from 'esbuild';
import { access, chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourceManifest } from './source-manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
const extensionOnly = process.argv.includes('--extension-only');
const nodeOnly = process.argv.includes('--node-only');
if (extensionOnly && nodeOnly) throw new Error('Choose --extension-only or --node-only, not both.');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const identity = JSON.parse(await readFile(resolve(root, 'config/extension-identity.json'), 'utf8'));
const sourceBefore = extensionOnly || nodeOnly ? undefined : await createSourceManifest(root);
const common = { absWorkingDir: root, bundle: true, sourcemap: true, legalComments: 'eof', logLevel: 'info' };
await rm(extensionOnly ? resolve(output, 'extension') : nodeOnly ? resolve(output, 'node') : output, { recursive: true, force: true });
if (!nodeOnly) {
await mkdir(resolve(output, 'extension'), { recursive: true });
await cp(resolve(root, 'apps/extension/public'), resolve(output, 'extension'), { recursive: true, filter: path => basename(path) !== '.DS_Store' });
await cp(resolve(root, 'docs/assets/logo.svg'), resolve(output, 'extension/icons/logo.svg'));
for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko']) {
  const source = locale === 'zh-CN' ? 'docs/install.md' : `docs/i18n/${locale}/install.md`;
  await mkdir(resolve(output, `extension/help-docs/${locale}`), { recursive: true });
  await cp(resolve(root, source), resolve(output, `extension/help-docs/${locale}/install.md`));
}
await mkdir(resolve(output, 'extension/licenses'), { recursive: true });
for (const dependency of ['dompurify', 'idb', 'zod']) {
  await cp(resolve(root, `node_modules/${dependency}/LICENSE`), resolve(output, `extension/licenses/${dependency}.txt`));
}
await cp(resolve(root, 'node_modules/dompurify/LICENSE-MPL'), resolve(output, 'extension/licenses/dompurify-MPL.txt'));
await cp(resolve(root, 'THIRD_PARTY.md'), resolve(output, 'extension/licenses/THIRD_PARTY.md'));
const manifest = JSON.parse(await readFile(resolve(root, 'apps/extension/manifest.json'), 'utf8'));
manifest.key = identity.key;
manifest.version = pkg.version.split('-')[0];
manifest.version_name = pkg.version;
await writeFile(resolve(output, 'extension/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
try {
  await access(resolve(root, 'tokens.css'));
  await cp(resolve(root, 'tokens.css'), resolve(output, 'extension/tokens.css'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
}
await Promise.all([
  ...(nodeOnly ? [] : [
    build({ ...common, entryPoints: ['apps/extension/src/background.ts', 'apps/extension/src/sidepanel.ts', 'apps/extension/src/library.ts', 'apps/extension/src/offscreen.ts', 'apps/extension/src/help.ts'], outdir: 'dist/extension', format: 'esm', platform: 'browser', target: 'chrome116' }),
    build({ ...common, entryPoints: ['apps/extension/src/content.ts'], outfile: 'dist/extension/content.js', format: 'iife', platform: 'browser', target: 'chrome116' }),
  ]),
  ...(extensionOnly ? [] : [build({ ...common, entryPoints: ['packages/mcp/src/cli.ts'], outfile: 'dist/node/cli.js', format: 'esm', platform: 'node', packages: 'external', target: 'node22' })]),
]);
if (!extensionOnly) await chmod(resolve(output, 'node/cli.js'), 0o755);
if (sourceBefore) {
  const sourceAfter = await createSourceManifest(root);
  if (sourceAfter.sourceDigest !== sourceBefore.sourceDigest) throw new Error('Source changed during the build. Rebuild after edits are complete.');
  await writeFile(resolve(output, 'source-manifest.json'), JSON.stringify(sourceAfter, null, 2) + '\n');
}
await writeFile(resolve(output, 'build-info.json'), JSON.stringify({ version: pkg.version, extensionId: identity.extensionId, node: process.version }, null, 2) + '\n');
console.log(`Built ${pkg.name} ${pkg.version}; ${nodeOnly ? `MCP CLI: ${resolve(output, 'node/cli.js')}` : `unpacked extension: ${resolve(output, 'extension')}`}`);
