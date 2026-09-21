import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (/\.tsx?$/.test(entry.name)) files.push(target);
  }
  return files;
}
const files = process.argv.length > 2 ? process.argv.slice(2).map(p => resolve(root, p)) : (await Promise.all(['packages', 'apps', 'tests'].map(p => walk(resolve(root, p))))).flat();
if (!files.length) throw new Error('No source files to validate');
const expected = new Set(files.map(file => pathToFileURL(file).href));
const reports = new Map();
const pending = new Map();
let nextId = 0;
let buffer = Buffer.alloc(0);
let changedAt = Date.now();
let exited = false;
let stderr = '';
const server = process.env.CLIPPER_LANGUAGE_SERVER
  ? spawn(process.env.CLIPPER_LANGUAGE_SERVER, ['--stdio'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
  : spawn(process.execPath, [resolve(root, 'node_modules/typescript-language-server/lib/cli.mjs'), '--stdio'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
server.on('error', error => { stderr = error.message; exited = true; });
server.on('exit', () => { exited = true; });
server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
  server.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}
function call(method, params) {
  const id = ++nextId;
  return new Promise((fulfill, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`LSP ${method} timed out`)); }, 15000);
    pending.set(id, { fulfill, reject, timer });
    send({ id, method, params });
  });
}
server.stdout.on('data', bytes => {
  buffer = Buffer.concat([buffer, bytes]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const size = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
    if (!Number.isSafeInteger(size) || size < 0) { stderr = 'Invalid LSP frame'; server.kill(); return; }
    if (buffer.length < end + 4 + size) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString());
    buffer = buffer.subarray(end + 4 + size);
    if (message.method && message.id !== undefined) {
      send({ id: message.id, result: message.method === 'workspace/configuration' ? message.params.items.map(() => ({})) : null });
    } else if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (request) {
        clearTimeout(request.timer); pending.delete(message.id);
        message.error ? request.reject(new Error(message.error.message)) : request.fulfill(message.result);
      }
    } else if (message.method === 'textDocument/publishDiagnostics' && expected.has(message.params.uri)) {
      reports.set(message.params.uri, message.params.diagnostics);
      changedAt = Date.now();
    }
  }
});
try {
  const uri = pathToFileURL(root).href;
  await call('initialize', { processId: process.pid, rootUri: uri, workspaceFolders: [{ uri, name: 'babel-content-clipper' }], capabilities: { textDocument: { publishDiagnostics: { relatedInformation: true } } }, initializationOptions: { tsserver: { path: resolve(root, 'node_modules/typescript/lib/tsserver.js') }, disableAutomaticTypingAcquisition: true } });
  send({ method: 'initialized', params: {} });
  for (const file of files) send({ method: 'textDocument/didOpen', params: { textDocument: { uri: pathToFileURL(file).href, languageId: 'typescript', version: 1, text: await readFile(file, 'utf8') } } });
  const deadline = Date.now() + 55000;
  while (reports.size < expected.size || Date.now() - changedAt < 1500) {
    if (exited) throw new Error(`Language server exited: ${stderr}`);
    if (Date.now() > deadline) throw new Error(`Incomplete LSP coverage: ${reports.size}/${expected.size}`);
    await new Promise(fulfill => setTimeout(fulfill, 100));
  }
  let errors = 0, warnings = 0;
  for (const [uri, diagnostics] of reports) {
    for (const item of diagnostics) {
      if (item.severity === 1) errors++;
      if (item.severity === 2) warnings++;
      if (item.severity <= 2) console.log(`${fileURLToPath(uri)}:${item.range.start.line + 1} ${item.severity === 1 ? 'error' : 'warning'} ${item.code ?? ''}: ${item.message}`);
    }
  }
  console.log(`LSP checked ${reports.size}/${expected.size} files: ${errors} errors, ${warnings} warnings.`);
  process.exitCode = errors ? 1 : 0;
  await call('shutdown');
  send({ method: 'exit' });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  server.stdin.end();
  server.kill();
  for (const request of pending.values()) clearTimeout(request.timer);
}
