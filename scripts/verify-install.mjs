import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const retainForBrowser = process.argv.includes('--retain-for-browser');
const evidenceRoot = resolve(root, 'artifacts/validation');
await mkdir(evidenceRoot, { recursive: true });
const temporary = await mkdtemp(resolve(evidenceRoot, 'install-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (command, args, cwd = temporary) => execFileSync(command, args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000,
});
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let verified = false;
try {
  const packed = JSON.parse(run(npm, ['pack', '--json', '--pack-destination', temporary], root))[0];
  const packageFile = resolve(temporary, packed.filename);
  const cleanProject = resolve(temporary, 'consumer');
  await mkdir(cleanProject);
  await writeFile(resolve(cleanProject, 'package.json'), '{"name":"clipper-install-smoke","private":true}\n');
  run(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', packageFile], cleanProject);
  const installedRoot = resolve(cleanProject, 'node_modules/babel-content-clipper');
  const cli = resolve(installedRoot, 'dist/node/cli.js');
  const help = run(process.execPath, [cli, '--help'], cleanProject);
  assert(help.includes('--mode=mcp') && help.includes('--mode=install'), 'Installed CLI help is incomplete.');
  const configDirectory = resolve(temporary, 'configuration');
  const manifestDirectory = resolve(temporary, 'browser-registration-fixture');
  const mcpConfigFile = resolve(temporary, 'mcp.json');
  const identity = JSON.parse(await readFile(resolve(root, 'config/extension-identity.json'), 'utf8'));
  const installArgs = [cli, '--mode=install', '--config-dir', configDirectory,
    '--manifest-dir', manifestDirectory, '--extension-id', identity.extensionId,
    '--profile-id', 'install-smoke-profile', '--mcp-config-out', mcpConfigFile];
  const installText = run(process.execPath, installArgs, cleanProject);
  const installation = JSON.parse(installText);
  const manifest = JSON.parse(await readFile(installation.nativeHost.manifestPath, 'utf8'));
  const mcp = JSON.parse(await readFile(mcpConfigFile, 'utf8')).mcpServers['babel-content-clipper'];
  assert(manifest.allowed_origins.length === 1 && manifest.allowed_origins[0] === `chrome-extension://${identity.extensionId}/`, 'Native host origin is not the installed extension.');
  assert(mcp.args.includes(cli) && mcp.args.includes('install-smoke-profile'), 'Generated MCP configuration does not reference the installed package/profile.');
  assert(!mcp.args.some(value => value === '--import' || value.endsWith('.ts')), 'Installed configuration depends on development TypeScript tools.');
  let protectedExisting = false;
  try { run(process.execPath, installArgs, cleanProject); }
  catch (error) { protectedExisting = String(error.stderr).includes('INSTALL_TARGET_EXISTS'); }
  assert(protectedExisting, 'Installer must preserve an existing registration by default.');
  let doctor;
  try { doctor = JSON.parse(run(process.execPath, [cli, '--mode=doctor', '--config-dir', configDirectory, '--profile-id', 'install-smoke-profile'], cleanProject)); }
  catch (error) { assert(error.status === 1, 'Offline doctor returned an unexpected exit code.'); doctor = JSON.parse(String(error.stdout)); }
  assert(doctor.ready === false, 'Offline diagnostic must not claim the extension is ready.');
  const privateConfig = JSON.parse(await readFile(resolve(configDirectory, 'bridge.json'), 'utf8'));
  if (typeof privateConfig.secret === 'string') assert(!installText.includes(privateConfig.secret), 'Installer leaked its private broker credential.');
  const pkg = JSON.parse(await readFile(resolve(installedRoot, 'package.json'), 'utf8'));
  const evidence = {
    checkedAt: new Date().toISOString(), version: pkg.version, platform: process.platform, node: process.version,
    installedFromLocalTarball: true, runtimeDependenciesOnly: true, cliHelp: true,
    generatedNativeManifest: true, generatedMcpConfig: true, preservedExistingRegistration: true,
    offlineDoctorReady: doctor.ready, usedRealBrowserRegistration: false,
    ...(retainForBrowser ? { retainedInstall: { directory: temporary, cli, configDirectory, manifestPath: installation.nativeHost.manifestPath, mcpConfigFile } } : {}),
    scope: 'Isolated package consumer and generated files. Browser connection and media behavior are tested separately.',
  };
  await writeFile(resolve(evidenceRoot, 'installation.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
  verified = true;
} finally {
  if (!retainForBrowser || !verified) await rm(temporary, { recursive: true, force: true });
}
