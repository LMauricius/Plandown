/**
 * Local HTTP front end for the standalone GUI: static files, JSON state, operations and a
 * server-sent event stream that tells the page to refresh. Binds to 127.0.0.1 only.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Mado } from './store.js';

const GUI = fileURLToPath(new URL('./gui/', import.meta.url));
const STATIC: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/mdedit.js': ['mdedit.js', 'text/javascript; charset=utf-8'],
  '/motion.js': ['motion.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const HEADERS = { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; img-src 'self' data:" };

function send(res: ServerResponse, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, { ...HEADERS, 'content-type': type });
  res.end(body);
}

/** Request body with a size cap; the API is local but still a trust boundary. */
function body(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { if ((size += c.length) > limit) { fail(new Error('Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

export function serve(mado: Mado, port = 4848): Promise<{ url: string; close(): void }> {
  const clients = new Set<ServerResponse>();
  const unwatch = mado.watch(() => { for (const c of clients) c.write('data: changed\n\n'); });

  const server = createServer(async (req, res) => {
    const json = (status: number, v: unknown) => send(res, status, 'application/json', JSON.stringify(v));
    try {
      // Host check blocks DNS rebinding; the custom header on POST forces a CORS preflight (which we never grant)
      const p = (server.address() as AddressInfo).port;
      if (req.headers.host !== `127.0.0.1:${p}` && req.headers.host !== `localhost:${p}`) return send(res, 403, 'text/plain', 'Forbidden host');
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;

      // GUI routes (see `url()` in gui/app.ts) all load the page, which reads the view from its location
      const file = STATIC[path] ?? (/^\/(view\/[^/]+|graph|time)$/.test(path) ? STATIC['/'] : undefined);
      if (req.method === 'GET' && file) return send(res, 200, file[1], await readFile(GUI + file[0]));
      if (req.method === 'GET' && path === '/api/state') return json(200, mado.db);
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, { ...HEADERS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'POST' && path === '/api/op') {
        if (req.headers['x-mado'] !== '1') return send(res, 403, 'text/plain', 'Missing X-Mado header');
        const id = await mado.apply(JSON.parse(await body(req)));
        return json(200, { id, db: mado.db });
      }
      send(res, 404, 'text/plain', 'Not found');
    } catch (e) {
      json(400, { error: (e as Error).message, db: mado.db });
    }
  });

  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      close() { unwatch(); for (const c of clients) c.end(); server.close(); },
    }));
  });
}
