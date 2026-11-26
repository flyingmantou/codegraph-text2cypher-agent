import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Limits, ToolService } from '../../../contracts/index.ts';
import { createToolService } from './index.ts';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null, error: { code, message } });

/** Minimal MCP stdio server: initialization, ping, tools, and cancellation only. No HTTP transport or SDK claim. */
export function createRpcDispatcher(service: ToolService, limits: Limits) {
  let initialized = false; let ready = false;
  const sessionId = randomUUID(); const inFlight = new Map<string | number, AbortController>();
  return async (value: unknown): Promise<unknown | undefined> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return rpcError(null, -32600, 'Invalid Request');
    const message = value as Rpc;
    const request = Object.hasOwn(message, 'id');
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || request && (message.id === null || !['string', 'number'].includes(typeof message.id)) || message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params))) return rpcError(message.id, -32600, 'Invalid Request');
    if (!request) {
      if (message.method === 'notifications/initialized' && initialized) ready = true;
      if (message.method === 'notifications/cancelled') {
        const id = message.params?.requestId;
        if (typeof id === 'string' || typeof id === 'number') inFlight.get(id)?.abort(new DOMException('Cancelled', 'AbortError'));
      }
      return undefined;
    }
    const id = message.id as string | number;
    if (inFlight.has(id)) return rpcError(id, -32600, 'Duplicate in-flight request ID');
    const controller = new AbortController(); inFlight.set(id, controller);
    try {
      let result: unknown;
      if (message.method === 'initialize') {
        if (initialized || typeof message.params?.protocolVersion !== 'string' || !message.params?.clientInfo || !message.params?.capabilities) return rpcError(id, -32602, 'Invalid initialization parameters');
        initialized = true;
        result = { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'codegraph-tools', version: '2.0.0' }, instructions: 'Use get_schema and resolve_entities before query generation. validate_query issues a single-use ticket required by execute_query. Only actual evidence IDs can be merged/exported. Synthetic fixture data is not course graph evidence.' };
      } else if (message.method === 'ping') result = {};
      else {
        if (!ready) return rpcError(id, -32002, 'Initialize and send notifications/initialized first');
        if (message.method === 'tools/list') {
          if (message.params?.cursor) return rpcError(id, -32602, 'Pagination cursor is not supported');
          result = { tools: service.definitions.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: tool.name === 'get_schema' || tool.name === 'resolve_entities' || tool.name === 'search_examples', openWorldHint: false } })) };
        } else if (message.method === 'tools/call') {
          const name = message.params?.name; const args = message.params?.arguments ?? {};
          if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) return rpcError(id, -32602, 'Invalid tool call');
          const reply = await service.call(name, args as Record<string, unknown>, { sessionId, limits, signal: controller.signal });
          result = { content: [{ type: 'text', text: JSON.stringify(reply) }], structuredContent: reply, isError: !reply.ok };
        } else return rpcError(id, -32601, 'Method not found');
      }
      return { jsonrpc: '2.0', id, result };
    } catch { return rpcError(id, -32603, 'Internal tool server error'); }
    finally { inFlight.delete(id); }
  };
}

export async function runStdio(service: ToolService, limits: Limits): Promise<void> {
  const dispatch = createRpcDispatcher(service, limits); let pending = ''; let discardLine = false; const jobs = new Set<Promise<void>>();
  const send = (message: unknown) => { if (message !== undefined) process.stdout.write(JSON.stringify(message) + '\n'); };
  const line = (input: string) => {
    if (Buffer.byteLength(input, 'utf8') > 1024 * 1024) { send(rpcError(null, -32600, 'Message exceeds 1 MiB')); return; }
    let parsed: unknown; try { parsed = JSON.parse(input); } catch { send(rpcError(null, -32700, 'Parse error')); return; }
    const job = dispatch(parsed).then(send).then(() => undefined); jobs.add(job); void job.finally(() => jobs.delete(job));
  };
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    let text = String(chunk);
    if (discardLine) { const boundary = text.indexOf('\n'); if (boundary < 0) continue; text = text.slice(boundary + 1); discardLine = false; }
    pending += text;
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) { const next = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1); if (next.trim()) line(next); }
    if (Buffer.byteLength(pending, 'utf8') > 1024 * 1024) { send(rpcError(null, -32600, 'Message exceeds 1 MiB')); pending = ''; discardLine = true; }
  }
  if (!discardLine && pending.trim()) line(pending); await Promise.allSettled(jobs);
}
function integer(value: string | undefined, fallback: number, maximum: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error('INVALID_CONFIG'); return number;
}
export async function main(): Promise<void> {
  const env = process.env; const mode = env.GRAPH_MODE ?? 'fixture';
  if (!['fixture', 'neo4j'].includes(mode)) throw new Error('INVALID_CONFIG');
  const limits: Limits = { maxRows: integer(env.MAX_ROWS, 100, 500), maxDepth: integer(env.MAX_DEPTH, 4, 6), timeoutMs: integer(env.TIMEOUT_MS, 15000, 60000), maxRepairs: 0, maxModelCalls: 1 };
  const service = await createToolService({
    graph: { mode: mode as 'fixture' | 'neo4j', uri: env.NEO4J_URI, user: env.NEO4J_USER, password: env.NEO4J_PASSWORD, database: env.NEO4J_DATABASE, graphVersion: env.GRAPH_VERSION },
    dataDir: resolve(env.DATA_DIR ?? '.runtime/mcp'),
    seedPath: env.EXAMPLE_SEED_PATH ?? fileURLToPath(new URL('../../skills/data/examples.seed.json', import.meta.url)),
    semanticLexiconPath: env.SEMANTIC_LEXICON_PATH ?? fileURLToPath(new URL('../../skills/data/semantic-concepts.json', import.meta.url)), limits,
  });
  try { await runStdio(service, limits); } finally { await service.close(); }
}
if (import.meta.main) main().catch(() => { process.stderr.write('MCP server startup failed. Check local configuration and data paths.\n'); process.exitCode = 1; });
