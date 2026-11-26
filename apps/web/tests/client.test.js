import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../public/api-client.js';
import { parseBatch, parseParameters, makeQueryInput, sourceLabels, graphPositions } from '../public/helpers.js';

test('query and clarification preserve question, difficulty and selected entity without global credentials', async () => {
  const requests = [];
  const client = createApiClient(async (path, init) => { requests.push({ path, init }); return Response.json({ status: 'success' }); });
  const controller = new AbortController();
  await client.query(' 查询 getOrder 方法 ', 'hard', 'method:getOrder:admin', controller.signal);
  const { path, init } = requests[0];
  assert.equal(path, '/api/query');
  assert.deepEqual(JSON.parse(init.body), { question: '查询 getOrder 方法', complexity: 'hard', entityId: 'method:getOrder:admin' });
  assert.equal(init.signal, controller.signal);
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.redirect, 'error');
  assert.equal(new Headers(init.headers).has('Authorization'), false);
});

test('invalid single and batch input cannot generate network requests', () => {
  let calls = 0;
  const client = createApiClient(async () => { calls++; return Response.json({}); });
  for (const args of [['', 'simple'], ['q'.repeat(2001), 'simple'], ['q', '__proto__'], ['q', 'medium', '']]) assert.throws(() => client.query(...args));
  assert.throws(() => client.batch([], 'simple'));
  assert.throws(() => client.batch(Array(11).fill('q'), 'simple'));
  assert.throws(() => client.batch(['valid', 5], 'simple'));
  assert.equal(calls, 0);
});

test('batch snapshot carries selected difficulty and keeps question order', async () => {
  const questions = [' q1 ', 'q2'];
  let payload;
  const client = createApiClient(async (path, init) => { assert.equal(path, '/api/batch'); payload = JSON.parse(init.body); return Response.json({ results: [] }); });
  await client.batch(questions, 'medium');
  assert.deepEqual(payload, { questions: ['q1', 'q2'], complexity: 'medium' });
  assert.deepEqual(questions, [' q1 ', 'q2']);
});

test('example search encodes a literal question and explicit retrieval mode', async () => {
  let destination;
  const client = createApiClient(async path => { destination = path; return Response.json({ examples: [] }); });
  await client.examples({ question: '发布者 & mode=bad <script>', category: 'mq', mode: 'semantic' });
  const url = new URL(destination, 'http://localhost');
  assert.equal(url.pathname, '/api/examples');
  assert.equal(url.searchParams.get('q'), '发布者 & mode=bad <script>');
  assert.equal(url.searchParams.get('mode'), 'semantic');
  assert.equal(url.searchParams.get('category'), 'mq');
  assert.throws(() => client.examples({ mode: 'unknown' }));
});

test('HTTP errors, invalid JSON and cancellation remain failures', async () => {
  const failed = createApiClient(async () => Response.json({ error: { message: '图谱暂不可用' } }, { status: 503 }));
  await assert.rejects(failed.json('/api/health'), /图谱暂不可用/);
  const malformed = createApiClient(async () => new Response('<html>error</html>', { status: 500 }));
  await assert.rejects(malformed.json('/api/health'), /无效响应/);
  const cancelled = createApiClient(async (_path, init) => { init.signal.throwIfAborted(); return Response.json({}); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(cancelled.query('q', 'simple', undefined, controller.signal), { name: 'AbortError' });
});

test('report download encodes IDs and does not interpret report text as markup', async () => {
  let destination;
  const client = createApiClient(async path => { destination = path; return new Response('# Report\n<script>alert(1)</script>'); });
  assert.equal(await client.report('run/id?x=1'), '# Report\n<script>alert(1)</script>');
  assert.equal(destination, '/api/runs/run%2Fid%3Fx%3D1/report');
  await assert.rejects(client.report(''), /没有可导出/);
});

test('batch file parser supports BOM and rejects oversized or malformed input', () => {
  assert.deepEqual(parseBatch('\uFEFF q1\r\n\r\nq2\r\n', 'questions.txt'), ['q1', 'q2']);
  assert.deepEqual(parseBatch('\uFEFF["q1","q2"]', 'questions.json'), ['q1', 'q2']);
  for (const value of ['{}', '[1]', 'null']) assert.throws(() => parseBatch(value, 'q.json'));
  assert.throws(() => parseBatch(Array(11).fill('q').join('\n')), /最多/);
  assert.throws(() => parseBatch('a'.repeat(100001)), /过大/);
});

test('parameter editor and source labels preserve explicit states', () => {
  assert.deepEqual(parseParameters('{"limit":20,"name":"getAllFood"}'), { limit: 20, name: 'getAllFood' });
  for (const value of ['[]', 'null', 'false', '1', 'invalid']) assert.throws(() => parseParameters(value));
  assert.equal(sourceLabels({ model: 'glm' }).model, 'GLM');
  assert.equal(sourceLabels({ model: 'demo' }).model, '规则演示');
  assert.equal(sourceLabels({}).graph, '图谱来源未知');
  assert.equal(sourceLabels({}).runtime, '运行器未标注');
  assert.equal(makeQueryInput(' q ', 'simple').question, 'q');
});

test('graph layout keeps distinct entities with duplicate names separate', () => {
  const nodes = [{ id: 'a', label: '方法', name: 'getOrder' }, { id: 'b', label: '方法', name: 'getOrder' }, { id: 'c', label: '服务', name: 'order' }];
  const positions = graphPositions(nodes);
  assert.equal(positions.size, 3);
  assert.notDeepEqual(positions.get('a'), positions.get('b'));
  for (const point of positions.values()) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
});
