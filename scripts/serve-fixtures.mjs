import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures');
const types = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.webm': 'video/webm', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://localhost');
    const requested = decodeURIComponent(url.pathname === '/' ? '/article.html' : url.pathname);
    const file = resolve(fixtureRoot, '.' + requested);
    if (!file.startsWith(fixtureRoot + sep)) { response.writeHead(403).end(); return; }
    const info = await stat(file);
    if (!info.isFile()) { response.writeHead(404).end(); return; }
    const headers = { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    let start = 0, end = info.size - 1;
    if (match) {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
      if (start > end || start >= info.size) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
      headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    }
    response.writeHead(match ? 206 : 200, { ...headers, 'Content-Length': end - start + 1 });
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(file, { start, end }).on('error', () => response.destroy()).pipe(response);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 400).end('Fixture unavailable');
  }
});
server.listen(Number(process.env.CLIPPER_FIXTURE_PORT || 4179), '127.0.0.1', () => {
  console.log(`Clipper fixtures: http://127.0.0.1:${server.address().port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
