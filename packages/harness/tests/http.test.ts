import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../src/config.ts';
import { createApplication } from '../src/http.ts';
import { invoke } from './http-harness.ts';
import type { AgentPort, GraphSchema, QueryExample, QueryRequest, QueryResponse, SkillBundle, ToolService } from '../../../contracts/index.ts';

const schema: GraphSchema = { version: 'test-v2', source: 'fixture', nodeLabels: ['方法'], relationshipTypes: [], nodeProperties: { 方法: ['名称'] }, relationshipPatterns: [] };
const sample: QueryExample = { id: 'example-one', question: '查询 getAllFood', category: 'entity', complexity: 'simple', cypher: 'MATCH (n) RETURN n LIMIT $limit', parameters: { limit: 10 }, description: '', verification: { status: 'unverified' } };
const skill: SkillBundle = { id: 'codegraph', version: '2.0.0', instructions: 'test', stages: [], planDemo: () => ({ category: 'entity', entityTerm: 'getAllFood', branches: [{ id: 'entity', category: 'entity', purpose: 'query' }] }), seedPath: 'test', semanticLexiconPath: 'test' };
function response(request: QueryRequest): QueryResponse {
  return { id: randomUUID(), question: request.question, status: 'success', summary: '已执行并核对样例结果', createdAt: new Date().toISOString(), source: { graph: 'fixture', model: 'demo', graphVersion: 'test-v2', modelName: 'demo-rules-v2', skillVersion: '2.0.0', runtime: 'standalone-workbench' }, queries: [], result: { columns: [], rows: [], graph: { nodes: [], edges: [] }, durationMs: 1, truncated: false }, trace: [{ stage: 'execute', status: 'ok', message: 'fixture', durationMs: 1 }], usage: { modelCalls: 0, toolCalls: 1, promptTokens: 0, completionTokens: 0, estimatedCostCny: 0 }, examplesUsed: [], candidates: [], warnings: ['人工样例数据'], evidenceIds: ['evidence-one'] };
}
function mockServices() {
  const queries: QueryRequest[] = []; const calls: { name: string; args: Record<string, unknown> }[] = [];
  let examples: QueryExample[] = [structuredClone(sample)]; let closed = 0;
  const tools: ToolService = {
    definitions: [{ name: 'get_schema', description: 'schema', inputSchema: { type: 'object' } }, { name: 'search_examples', description: 'search', inputSchema: { type: 'object' } }],
    fixtureTemplates: {} as ToolService['fixtureTemplates'],
    examples: {
      list: async () => examples,
      search: async () => examples.map(example => ({ example, score: 1 })),
      upsert: async input => { const saved: QueryExample = { ...input, verification: { status: 'unverified' } }; examples = [...examples.filter(x => x.id !== saved.id), saved]; return saved; },
      delete: async id => { const had = examples.some(x => x.id === id); examples = examples.filter(x => x.id !== id); return had; },
      verify: async () => ({ total: examples.length, verified: examples.length, failed: 0, graphVersion: 'test-v2', source: 'fixture', results: examples.map(x => ({ id: x.id, status: 'verified', rowCount: 1 })) }),
    },
    async call<T>(name, args) { calls.push({ name, args }); return { ok: true, data: (name === 'get_schema' ? schema : examples.map(example => ({ example, score: 0.9 }))) as T }; },
    close: async () => { closed++; },
  };
  const agent: AgentPort = { run: async input => { queries.push(input); return response(input); }, listExamples: tools.examples.list, searchExamples: tools.examples.search, upsertExample: tools.examples.upsert, deleteExample: tools.examples.delete, verifyExamples: tools.examples.verify };
  return { tools, agent, skill, queries, calls, get closed() { return closed; } };
}
const post = (value: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

test('config keeps platform credentials server-side and validates modes/budgets', () => {
  const glm = readConfig({ MODEL_MODE: 'glm', GLM_API_KEY: 'PRIVATE_GLM', DEEPSEEK_API_KEY: 'OTHER_SECRET' });
  assert.equal(glm.agent.apiKey, 'PRIVATE_GLM'); assert.equal(glm.agent.modelName, 'glm-5.3');
  assert.equal(glm.agent.apiBaseUrl, 'https://open.bigmodel.cn/api/paas/v4'); assert.equal(glm.limits.timeoutMs, 60000);
  assert.equal(glm.limits.maxModelCalls, 6); assert.equal(glm.limits.maxToolCalls, 40);
  assert.throws(() => readConfig({ MODEL_MODE: 'glm' }), /GLM_API_KEY/);
  assert.throws(() => readConfig({ HOST: '0.0.0.0' }), /loopback/);
  assert.equal(readConfig({ HOST: '0.0.0.0', ALLOW_CONTAINER_BIND: '1' }).host, '0.0.0.0');
  assert.throws(() => readConfig({ HOST: '8.8.8.8', ALLOW_CONTAINER_BIND: '1' }), /loopback/);
  assert.throws(() => readConfig({ MAX_ROWS: '0' }), /MAX_ROWS/);
  assert.throws(() => readConfig({ MODEL_MODE: 'unknown' }), /MODEL_MODE/);
});

test('health exposes actual mode and tool/skill metadata without credentials', async () => {
  const mocks = mockServices(); const config = readConfig({ MODEL_MODE: 'glm', GLM_API_KEY: 'PRIVATE_GLM' });
  const app = await createApplication(config, mocks);
  try {
    const res = await invoke(app.server, '/api/health'); const body = await res.json();
    assert.equal(res.status, 200); assert.equal(body.ready, true); assert.equal(body.runtime, 'standalone-workbench');
    assert.equal(body.skillVersion, '2.0.0'); assert.ok(body.toolNames.includes('get_schema'));
    assert.equal(body.retrievalMode, 'domain-semantic-hybrid'); assert.ok(!JSON.stringify(body).includes('PRIVATE_GLM'));
    assert.equal((await (await invoke(app.server, '/api/schema')).json()).version, 'test-v2');
    assert.ok(res.headers.get('content-security-policy')?.includes("script-src 'self'"));
  } finally { await app.close(); await app.close(); }
  assert.equal(mocks.closed, 1);
});

test('query, batch and saved reports preserve complexity, evidence and source', async () => {
  const mocks = mockServices(); const app = await createApplication(readConfig({}), mocks);
  try {
    const one = await invoke(app.server, '/api/query', post({ question: ' getAllFood ', entityId: 'method:1', complexity: 'hard' }));
    const saved = await one.json(); assert.equal(one.status, 200);
    assert.deepEqual(mocks.queries[0], { question: 'getAllFood', entityId: 'method:1', complexity: 'hard' });
    const batch = await invoke(app.server, '/api/batch', post({ questions: ['first', 'second'], complexity: 'medium' }));
    assert.equal((await batch.json()).results.length, 2); assert.equal(mocks.queries[2].complexity, 'medium');
    const replay = await (await invoke(app.server, `/api/runs/${saved.id}`)).json(); assert.equal(replay.id, saved.id);
    const report = await invoke(app.server, `/api/runs/${saved.id}/report`); const text = await report.text();
    assert.ok(report.headers.get('content-type')?.includes('text/markdown'));
    for (const marker of ['fixture', 'standalone-workbench', '人工样例数据', 'execute', 'evidence-one']) assert.ok(text.includes(marker));
  } finally { await app.close(); }
});

test('example maintenance and hybrid/semantic/lexical search use tools service', async () => {
  const mocks = mockServices(); const app = await createApplication(readConfig({}), mocks);
  try {
    const search = await invoke(app.server, '/api/examples?q=downstream&category=entity&mode=semantic');
    assert.equal(search.status, 200); assert.equal((await search.json()).matches.length, 1);
    assert.deepEqual(mocks.calls[0], { name: 'search_examples', args: { question: 'downstream', category: 'entity', mode: 'semantic', verifiedOnly: false } });
    const created = await invoke(app.server, '/api/examples', post({ ...sample, id: 'second' })); assert.equal((await created.json()).verification.status, 'unverified');
    const verified = await invoke(app.server, '/api/examples/verify', post({})); assert.equal((await verified.json()).total, 2);
    const deleted = await invoke(app.server, '/api/examples/second', { method: 'DELETE' }); assert.equal((await deleted.json()).deleted, true);
  } finally { await app.close(); }
});

test('HTTP boundaries reject unsafe origins, invalid inputs, overlarge batches and private paths', async () => {
  const mocks = mockServices(); const app = await createApplication(readConfig({}), mocks);
  try {
    const cases: [string, Parameters<typeof invoke>[2], number][] = [
      ['/api/query', post({ question: 'x', complexity: 'impossible' }), 400],
      ['/api/query', post({ question: '' }), 400],
      ['/api/query', post({ question: 'x', entityId: '' }), 400],
      ['/api/batch', post({ questions: Array(11).fill('x') }), 400],
      ['/api/examples?q=x&mode=unknown', {}, 400],
      ['/api/query', { ...post({ question: 'x' }), headers: { 'content-type': 'application/json', origin: 'https://evil.example' } }, 403],
      ['/api/health', { headers: { host: 'evil.example' } }, 403],
      ['/api/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }, 400],
      ['/api/query', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }, 415],
      ['/api/query', post({ question: 'x'.repeat(70000) }), 413],
      ['/.env', {}, 404], ['/../contracts/index.ts', {}, 404], ['/api/runs/missing', {}, 404],
    ];
    for (const [path, options, expected] of cases) assert.equal((await invoke(app.server, path, options)).status, expected, path);
    assert.equal(mocks.queries.length, 0);
  } finally { await app.close(); }
});

test('provider/tool errors never reflect private exception messages', async () => {
  const mocks = mockServices(); mocks.tools.call = async () => { throw new Error('PRIVATE_PROVIDER_KEY'); };
  mocks.agent.run = async () => { throw new Error('PRIVATE_PROVIDER_KEY'); };
  const app = await createApplication(readConfig({}), mocks);
  try {
    for (const [path, options] of [['/api/health', {}], ['/api/schema', {}], ['/api/query', post({ question: 'x' })]] as const) {
      const res = await invoke(app.server, path, options); assert.ok(res.status >= 500); assert.ok(!(await res.text()).includes('PRIVATE_PROVIDER_KEY'));
    }
  } finally { await app.close(); }
});

test('query deadline and disconnect propagate cancellation to runner', async () => {
  const mocks = mockServices(); let observed = false;
  mocks.agent.run = async (input, signal) => new Promise<QueryResponse>((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('cancellation was not propagated')), 500);
    const onAbort = () => { clearTimeout(guard); observed = true; resolve({ ...response(input), status: 'failed', error: { code: 'ABORTED', message: '已中止' } }); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  });
  const app = await createApplication(readConfig({ TIMEOUT_MS: '100' }), mocks);
  try {
    const timed = await invoke(app.server, '/api/query', post({ question: 'x' })); assert.equal((await timed.json()).status, 'failed'); assert.ok(observed);
    observed = false; const cancellation = new AbortController();
    const pending = invoke(app.server, '/api/query', { ...post({ question: 'y' }), signal: cancellation.signal });
    cancellation.abort(); await pending; assert.ok(observed);
  } finally { await app.close(); }
});

test('example verification receives the request deadline and disconnect signal', async () => {
  const mocks = mockServices(); let received: AbortSignal | undefined;
  mocks.tools.examples.verify = async (signal?: AbortSignal) => new Promise((_resolve, reject) => {
    received = signal;
    const guard = setTimeout(() => reject(new Error('verification did not receive cancellation')), 500);
    const abort = () => { clearTimeout(guard); reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError')); };
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
  const app = await createApplication(readConfig({ TIMEOUT_MS: '100' }), mocks);
  try {
    const timed = await invoke(app.server, '/api/examples/verify', post({}));
    assert.equal(timed.status, 408); assert.equal((await timed.json()).error.code, 'REQUEST_TIMEOUT'); assert.ok(received?.aborted);
    received = undefined; const cancellation = new AbortController();
    const pending = invoke(app.server, '/api/examples/verify', { ...post({}), signal: cancellation.signal });
    cancellation.abort(); const cancelled = await pending;
    assert.equal(cancelled.status, 408); assert.equal((await cancelled.json()).error.code, 'REQUEST_CANCELLED'); assert.ok(received?.aborted);
  } finally { await app.close(); }
});

test('only two mutations run concurrently and completed requests release slots', async () => {
  const mocks = mockServices(); const releases: (() => void)[] = [];
  mocks.agent.run = input => new Promise(resolve => { releases.push(() => resolve(response(input))); });
  const app = await createApplication(readConfig({}), mocks);
  try {
    const first = invoke(app.server, '/api/query', post({ question: 'first' }));
    const second = invoke(app.server, '/api/query', post({ question: 'second' }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await invoke(app.server, '/api/query', post({ question: 'third' }))).status, 429);
    releases.splice(0).forEach(release => release()); await Promise.all([first, second]);
    mocks.agent.run = async input => response(input);
    assert.equal((await invoke(app.server, '/api/query', post({ question: 'fourth' }))).status, 200);
  } finally { await app.close(); }
});
