import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.HORIZON_STUDIO_PORT ?? 7300);
// И из src/, и из dist/ это указывает на dist/web.
const webRoot = fileURLToPath(new URL('../dist/web/', import.meta.url));
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  // URL-парсер схлопывает `..` (в т.ч. %2e%2e), выйти за webRoot нельзя.
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const file = path === '/' ? 'index.html' : path.slice(1);
  try {
    const body = await readFile(webRoot + file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    // SPA: неизвестные пути отдаём фронту.
    res.writeHead(200, { 'content-type': types['.html'] }).end(await readFile(webRoot + 'index.html'));
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`horizon studio on http://127.0.0.1:${port}`);
});
