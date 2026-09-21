import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourceManifest } from './source-manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = resolve(root, 'dist/extension');
const manifest = JSON.parse(await readFile(resolve(extensionRoot, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const failures = [];
const checked = new Set();
async function requireFile(path, from = extensionRoot) {
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//')) {
    failures.push(`Remote build asset is not allowed: ${path}`);
    return;
  }
  const target = resolve(from, path.split(/[?#]/)[0]);
  if (!target.startsWith(extensionRoot + sep)) { failures.push(`Asset escapes extension package: ${path}`); return; }
  if (checked.has(target)) return;
  checked.add(target);
  try {
    const info = await stat(target);
    if (!info.isFile() || info.size === 0) { failures.push(`Asset is empty or not a file: ${target}`); return; }
    if (target.endsWith('.html')) {
      const html = await readFile(target, 'utf8');
      for (const match of html.matchAll(/<(?:script|link|img)\b[^>]*(?:src|href)="([^"]+)"/gi)) await requireFile(match[1], dirname(target));
      if (/<script\b(?![^>]*\bsrc=)[^>]*>\s*[^<\s]/i.test(html)) failures.push(`Inline script violates the extension CSP: ${target}`);
    }
  } catch (error) {
    failures.push(`Missing build asset: ${target} (${error.code || error.message})`);
  }
}
if (manifest.manifest_version !== 3) failures.push('Expected Chrome Manifest V3');
if (manifest.background?.type !== 'module') failures.push('Background must be an ES module service worker');
if (manifest.version !== pkg.version.split('-')[0]) failures.push('Manifest and package version do not match');
if (manifest.version_name !== pkg.version) failures.push('Manifest does not disclose the prerelease version');
await requireFile(manifest.background.service_worker);
await requireFile(manifest.side_panel.default_path);
await requireFile('library.html');
await requireFile('help.html');
for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko']) await requireFile(`help-docs/${locale}/install.md`);
if (manifest.default_locale !== 'en') failures.push('Expected English fallback locale');
for (const locale of ['en', 'zh_CN', 'zh_TW', 'ja', 'ko']) {
  const file = `_locales/${locale}/messages.json`;
  await requireFile(file);
  const messages = JSON.parse(await readFile(resolve(extensionRoot, file), 'utf8'));
  for (const match of JSON.stringify(manifest).matchAll(/__MSG_([a-zA-Z0-9_]+)__/g)) {
    if (!messages[match[1]]?.message?.trim()) failures.push(`Missing ${locale} manifest message: ${match[1]}`);
  }
}
await requireFile('offscreen.html');
await requireFile('clipboard-import.css');
for (const content of manifest.content_scripts || []) for (const file of [...(content.js || []), ...(content.css || [])]) await requireFile(file);
for (const file of Object.values(manifest.icons || {})) await requireFile(file);
for (const file of Object.values(manifest.action?.default_icon || {})) await requireFile(file);
for (const name of ['dompurify', 'idb', 'zod']) await requireFile(`licenses/${name}.txt`);
if (!process.argv.includes('--extension-only')) {
  try {
    const cli = await readFile(resolve(root, 'dist/node/cli.js'), 'utf8');
    if (!cli.startsWith('#!/usr/bin/env node')) failures.push('CLI must start with its Node shebang');
  } catch (error) { failures.push(`MCP CLI is missing: ${error.message}`); }
  try {
    const builtSource = JSON.parse(await readFile(resolve(root, 'dist/source-manifest.json'), 'utf8'));
    const currentSource = await createSourceManifest(root);
    if (builtSource.sourceDigest !== currentSource.sourceDigest) failures.push('Source changed after the full build; rebuild before packaging.');
  } catch (error) { failures.push(`Source provenance is missing: ${error.message}`); }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log(`Package integrity passed: ${checked.size} extension assets, local scripts/styles, version and ${process.argv.includes('--extension-only') ? 'extension-only' : 'MCP CLI'} checks.`);
