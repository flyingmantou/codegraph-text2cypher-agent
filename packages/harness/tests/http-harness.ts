/** In-process HTTP route harness; tests handlers without requiring a listening socket. */
import { Readable, Writable } from 'node:stream';
import type { Server } from 'node:http';
export async function invoke(server: Server, url: string, options: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}): Promise<Response> {
  const req = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]) as Readable & { method: string; url: string; headers: Record<string, string> };
  req.method = options.method ?? 'GET'; req.url = url; req.headers = { host: '127.0.0.1:3000', ...Object.fromEntries(Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) };
  const chunks: Buffer[] = []; const headers = new Headers();
  const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }) as Writable & { statusCode: number; headersSent: boolean; setHeader(key: string, value: string): void; writeHead(code: number, headers: Record<string, string>): void };
  res.statusCode = 200; res.headersSent = false;
  res.setHeader = (key, value) => { headers.set(key, value); };
  res.writeHead = (code, fields) => { res.statusCode = code; res.headersSent = true; for (const [key, value] of Object.entries(fields ?? {})) headers.set(key, value); };
  return new Promise((resolve, reject) => {
    res.once('finish', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers })));
    res.once('error', reject);
    options.signal?.addEventListener('abort', () => req.emit('aborted'), { once: true });
    if (options.signal?.aborted) queueMicrotask(() => req.emit('aborted'));
    server.emit('request', req, res);
  });
}
