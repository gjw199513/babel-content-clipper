import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const extensionRoot = resolve(root, 'dist/extension');
const archive = {};
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (!entry.name.endsWith('.map')) archive[relative(extensionRoot, path).replaceAll('\\', '/')] = await readFile(path);
  }
}
await collect(extensionRoot);
if (!archive['manifest.json'] || !archive['background.js'] || !archive['content.js']) throw new Error('Build the extension before packaging');
await stat(resolve(root, 'dist/node/cli.js'));
await mkdir(resolve(root, 'release'), { recursive: true });
const zipName = `${pkg.name}-extension-${pkg.version}.zip`;
await writeFile(resolve(root, 'release', zipName), zipSync(archive, { level: 6 }));
const packResult = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--json', '--pack-destination', 'release'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
const packageName = packResult[0].filename;
const notesName = `${pkg.name}-release-notes-${pkg.version}.md`;
const metadataName = `${pkg.name}-release-${pkg.version}.json`;
await writeFile(resolve(root, 'release/source-manifest.json'), await readFile(resolve(root, 'dist/source-manifest.json')));
const releaseNotes = `# Babel Content Clipper ${pkg.version}

## 简体中文

普通用户只需下载 \`${zipName}\`，解压到长期保留的目录，然后在 Chrome / Chromium 扩展管理页开启开发者模式，选择“加载已解压的扩展程序”，并选中包含 \`manifest.json\` 的目录。无需下载源码或自行构建。需要连接本地 MCP 的用户再下载 \`${packageName}\`。

## English

Download \`${zipName}\`, extract it to a directory you will keep, enable Developer mode on the Chrome / Chromium extensions page, choose **Load unpacked**, and select the directory containing \`manifest.json\`. No source checkout or build is required. Download \`${packageName}\` only if you also need the local MCP component.

## 繁體中文

下載 \`${zipName}\`，解壓縮到會長期保留的目錄，在 Chrome / Chromium 擴充功能管理頁開啟「開發人員模式」，選擇「載入未封裝項目」，並選取包含 \`manifest.json\` 的目錄。無需下載原始碼或自行建置。需要連接本機 MCP 時再下載 \`${packageName}\`。

## 日本語

\`${zipName}\` をダウンロードして保持するディレクトリに展開し、Chrome / Chromium の拡張機能ページでデベロッパー モードを有効にします。「パッケージ化されていない拡張機能を読み込む」から \`manifest.json\` を含むディレクトリを選択してください。ソースの取得やビルドは不要です。ローカル MCP も使用する場合だけ \`${packageName}\` をダウンロードします。

## 한국어

\`${zipName}\`을 다운로드해 계속 유지할 디렉터리에 압축 해제한 뒤 Chrome / Chromium 확장 프로그램 페이지에서 개발자 모드를 켭니다. ‘압축해제된 확장 프로그램을 로드합니다’를 선택하고 \`manifest.json\`이 있는 디렉터리를 지정하세요. 소스 코드 다운로드나 직접 빌드는 필요하지 않습니다. 로컬 MCP도 사용할 때만 \`${packageName}\`을 다운로드하세요.

> Chrome does not load an ordinary ZIP directly. Extract it first. One-click installation requires a browser store or another browser-trusted distribution channel.
`;
await writeFile(resolve(root, 'release', notesName), releaseNotes);
await writeFile(resolve(root, 'release', metadataName), JSON.stringify({
  schemaVersion: 1,
  product: 'Babel Content Clipper',
  version: pkg.version,
  extension: { file: zipName, install: 'extract-and-load-unpacked', manifestAtArchiveRoot: true },
  mcp: { file: packageName, requiredForExtensionOnly: false },
  releaseNotes: notesName,
  sourceManifest: 'source-manifest.json',
  remotePublication: false,
}, null, 2) + '\n');
const names = [zipName, packageName, notesName, metadataName, 'source-manifest.json'];
const sums = [];
for (const name of names) sums.push(`${createHash('sha256').update(await readFile(resolve(root, 'release', name))).digest('hex')}  ${name}`);
await writeFile(resolve(root, 'release/SHA256SUMS'), sums.join('\n') + '\n');
console.log(`Local release artifacts:\n${names.join('\n')}\nSHA256SUMS\nNo package was published.`);
