import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = resolve(root, 'release');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const zipName = `${pkg.name}-extension-${pkg.version}.zip`;
const packageName = `${pkg.name}-${pkg.version}.tgz`;
const notesName = `${pkg.name}-release-notes-${pkg.version}.md`;
const metadataName = `${pkg.name}-release-${pkg.version}.json`;
const expected = [zipName, packageName, notesName, metadataName, 'source-manifest.json'];
const checksumLines = (await readFile(resolve(releaseRoot, 'SHA256SUMS'), 'utf8')).trim().split('\n');
const checksums = new Map(checksumLines.map(line => {
  const match = /^([a-f\d]{64})\s+(.+)$/u.exec(line);
  if (!match) throw new Error(`Invalid checksum line: ${line}`);
  return [match[2], match[1]];
}));
for (const name of expected) {
  const bytes = await readFile(resolve(releaseRoot, name));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (checksums.get(name) !== actual) throw new Error(`Release checksum mismatch: ${name}`);
}
if (checksums.size !== expected.length) throw new Error('SHA256SUMS contains stale or unexpected files.');

const zip = unzipSync(await readFile(resolve(releaseRoot, zipName)));
const entries = Object.keys(zip);
for (const required of ['manifest.json', 'background.js', 'content.js', 'sidepanel.html', 'library.html', 'help.html']) {
  if (!zip[required]?.length) throw new Error(`Extension ZIP is missing ${required} at its root.`);
}
if (entries.some(name => name.endsWith('.map') || name.endsWith('.ts') || name.startsWith('dist/extension/'))) {
  throw new Error('Extension ZIP contains source/build-only files or an extra directory layer.');
}
const manifest = JSON.parse(new TextDecoder().decode(zip['manifest.json']));
if (manifest.name !== 'Babel Content Clipper') throw new Error('Extension ZIP has the wrong product name.');
if (manifest.version !== pkg.version.split('-')[0] || manifest.version_name !== pkg.version) {
  throw new Error('Extension ZIP version does not match package.json.');
}
const metadata = JSON.parse(await readFile(resolve(releaseRoot, metadataName), 'utf8'));
if (metadata.version !== pkg.version || metadata.extension?.file !== zipName || metadata.extension?.manifestAtArchiveRoot !== true) {
  throw new Error('Release metadata does not describe the current extension ZIP.');
}
const notes = await readFile(resolve(releaseRoot, notesName), 'utf8');
if (!notes.includes(zipName) || !notes.includes(packageName)) throw new Error('Release notes do not name the downloadable assets.');
console.log(`Release bundle verified: ${pkg.version}, ${entries.length} extension files, ${expected.length} checksummed assets.`);
