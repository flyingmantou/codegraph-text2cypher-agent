import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRpcDispatcher } from '../src/mcp.ts';
import { setup, limits, query } from './helpers.ts';
import type { ToolService } from '../../../contracts/index.ts';
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'contract-test', version: '1.0' } } };

test('MCP initialization, unknown methods and structured tool errors follow JSON-RPC boundaries', async () => {
  const kit = await setup(); try {
    const rpc = createRpcDispatcher(kit.service, limits);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 0, method: 'tools/list' }) as any).error.code, -32002);
    const init = await rpc(initialize) as any; assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
    const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as any;
    assert.equal(listed.result.tools.length, 7); assert.ok(listed.result.tools.every((tool: any) => tool.inputSchema.type === 'object'));
    assert.equal((await rpc({ jsonrpc: '2.0', id: 3, method: 'unknown' }) as any).error.code, -32601);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'execute_query', arguments: { ticket: 'forged' } } }) as any).result.isError, true);
  } finally { await kit.cleanup(); }
});

test('MCP cancellation reaches only the matching active tool request', async () => {
  let wasCancelled = false;
  const service = { definitions: [], async call(_name: string, _args: unknown, ctx: any) {
    await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => { wasCancelled = true; resolve(); }, { once: true }));
    return { ok: false, error: { code: 'TIMEOUT', message: 'cancelled' } };
  } } as unknown as ToolService;
  const rpc = createRpcDispatcher(service, limits); await rpc(initialize); await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const pending = rpc({ jsonrpc: '2.0', id: 'task', method: 'tools/call', params: { name: 'execute_query', arguments: { ticket: 'x' } } });
  await rpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'task' } });
  const result = await pending as any; assert.equal(wasCancelled, true); assert.equal(result.result.structuredContent.error.code, 'TIMEOUT');
});

test('real subprocess stdio completes initialize, list, validate and execute with protocol-only stdout', { timeout: 10000 }, async () => {
  const kit = await setup();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GRAPH_MODE: 'fixture', DATA_DIR: kit.config.dataDir, EXAMPLE_SEED_PATH: kit.config.seedPath, SEMANTIC_LEXICON_PATH: kit.config.semanticLexiconPath } });
  const pending = new Map<string | number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let buffer = ''; let stderr = ''; const unsolicited: unknown[] = [];
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stderr.on('data', text => stderr += text);
  child.stdout.on('data', text => {
    buffer += text; let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const response = JSON.parse(line); const waiter = pending.get(response.id); if (waiter) { pending.delete(response.id); waiter.resolve(response); } else unsolicited.push(response); }
      catch { for (const waiter of pending.values()) waiter.reject(new Error('non-JSON stdout')); }
    }
  });
  child.on('error', error => { for (const waiter of pending.values()) waiter.reject(error); });
  child.on('exit', () => { for (const waiter of pending.values()) waiter.reject(new Error('MCP exited before response')); });
  const send = (value: any) => new Promise<any>((resolve, reject) => { pending.set(value.id, { resolve, reject }); child.stdin.write(JSON.stringify(value) + '\n'); });
  try {
    assert.equal((await send(initialize)).result.serverInfo.name, 'codegraph-tools');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    assert.equal((await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.length, 7);
    const validated = await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'validate_query', arguments: { query: query() } } });
    const ticket = validated.result.structuredContent.data.ticket; assert.equal(typeof ticket, 'string');
    const executed = await send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'execute_query', arguments: { ticket } } });
    assert.equal(executed.result.structuredContent.data.result.rows.length, 1);
    const replay = await send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'execute_query', arguments: { ticket } } });
    assert.equal(replay.result.structuredContent.error.code, 'INVALID_TICKET');
    assert.deepEqual(unsolicited, []); assert.equal(stderr, '');
  } finally { child.stdin.end(); child.kill(); await kit.cleanup(); }
});
