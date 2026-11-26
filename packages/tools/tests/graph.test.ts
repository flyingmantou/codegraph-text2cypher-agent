import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraphAdapter } from '../src/graph/index.ts';
import { QUERY_TEMPLATES } from '../src/graph/templates.ts';
import { validateReadQuery } from '../src/graph/validation.ts';
import type { Category, Limits } from '../../../contracts/index.ts';

const limits: Limits = { maxRows: 100, maxDepth: 4, timeoutMs: 1000, maxRepairs: 1, maxModelCalls: 2 };
const spec = (category: Category, name = 'getAllFood', extra = {}) => ({ cypher: QUERY_TEMPLATES[category], parameters: { name, entityId: '', limit: 100, ...extra } });

test('fixture exposes synthetic provenance and real schema derived from nodes', async () => {
  const graph = await createGraphAdapter({ mode: 'fixture' });
  const schema = await graph.getSchema();
  assert.equal(schema.source, 'fixture'); assert.equal(schema.version, 'fixture-train-ticket-v1');
  assert.ok(schema.nodeLabels.includes('交换机')); assert.ok(schema.relationshipTypes.includes('消费'));
  assert.match(schema.notes!.join(' '), /人工/);
});

test('all seven canonical templates validate and execute non-empty graph results', async () => {
  const graph = await createGraphAdapter({ mode: 'fixture' });
  const cases: [Category, string, Record<string, unknown>][] = [
    ['entity', 'getAllFood', {}], ['filter', '', { keyword: 'food' }], ['api', 'ts-food-service', {}],
    ['downstream', 'getAllFood', {}], ['impact', 'queryOrder', {}], ['mq', 'payOrder', {}], ['combined', 'placeOrder', {}],
  ];
  for (const [category, name, extra] of cases) {
    const query = spec(category, name, extra); const checked = await graph.validate(query, limits);
    assert.equal(checked.valid, true, `${category}: ${JSON.stringify(checked.errors)}`);
    const result = await graph.execute(query, limits); assert.ok(result.rows.length > 0, category); assert.ok(result.graph.nodes.length > 0);
    assert.ok(result.graph.edges.every(e => result.graph.nodes.some(n => n.id === e.source) && result.graph.nodes.some(n => n.id === e.target)));
  }
});

test('downstream, impact and MQ use their documented edge direction', async () => {
  const graph = await createGraphAdapter({ mode: 'fixture' });
  const downstream = await graph.execute(spec('downstream'), limits);
  assert.deepEqual(downstream.graph.nodes.filter(n => n.label === '服务').map(n => n.name).sort(), ['ts-food-service', 'ts-foodmap-service', 'ts-order-service']);
  const impact = await graph.execute(spec('impact', 'queryFoodStore'), limits);
  assert.deepEqual(impact.graph.nodes.map(n => n.name).sort(), ['getAllFood', 'queryFood', 'queryFoodStore']);
  const mq = await graph.execute(spec('mq', 'payOrder'), limits);
  assert.equal(mq.rows.length, 1); assert.ok(mq.graph.nodes.some(n => n.name === 'ts-notification-service'));
  assert.deepEqual(mq.graph.edges.map(e => e.type), ['发布', '路由', '消费', '属于']);
});

test('entity resolution preserves duplicate-name candidates and identity selection', async () => {
  const graph = await createGraphAdapter({ mode: 'fixture' });
  const candidates = await graph.resolveEntities('getOrder'); assert.equal(candidates.filter(n => n.label === '方法').length, 2);
  const selected = await graph.execute(spec('entity', '', { entityId: 'method:getOrder:admin' }), limits);
  assert.equal(selected.rows.length, 1); assert.equal(selected.graph.nodes[0].id, 'method:getOrder:admin');
});

test('output caps report truncation while absent entities return a genuine empty set', async () => {
  const graph = await createGraphAdapter({ mode: 'fixture' });
  const limited = await graph.execute(spec('downstream', 'getAllFood', { limit: 1 }), limits);
  assert.equal(limited.rows.length, 1); assert.equal(limited.truncated, true);
  const missing = await graph.execute(spec('entity', 'missingMethod'), limits);
  assert.equal(missing.rows.length, 0); assert.equal(missing.truncated, false);
});

test('execute rechecks validation and never dispatches from a forged label', async () => {
  const graph = await createGraphAdapter({ mode: 'fixture' });
  await assert.rejects(() => graph.execute({ cypher: 'MATCH (n) DELETE n RETURN n LIMIT 10', parameters: {}, label: 'entity' }, limits), /DELETE/);
  await assert.rejects(() => graph.execute({ cypher: 'MATCH (n) RETURN n LIMIT 10', parameters: { name: 'getAllFood', entityId: '' }, label: 'entity' }, limits), /七类模板/);
});

test('read-query gate rejects write, procedures, extra statements, unbounded paths and unknown schema', async () => {
  const graph = await createGraphAdapter({ mode: 'fixture' }); const schema = await graph.getSchema();
  for (const cypher of [
    'MATCH (n) SET n.x=1 RETURN n LIMIT 1', 'MATCH (n) CALL db.labels() RETURN n LIMIT 1',
    'MATCH (n) RETURN n LIMIT 1; MATCH (m) RETURN m LIMIT 1',
    'MATCH p=(n)-[:`调用`*]->(m) RETURN p LIMIT 1', 'MATCH p=(n)-[:`调用`*1..99]->(m) RETURN p LIMIT 1',
    'MATCH (n:`Imaginary`) RETURN n LIMIT 1', 'MATCH (n) RETURN n.unknown LIMIT 1',
    'MATCH (n) RETURN apoc.load.json($url) LIMIT 1', 'MATCH (n) RETURN n',
    'MATCH (n) /* hidden */ RETURN n LIMIT 1',
  ]) assert.equal(validateReadQuery({ cypher, parameters: { url: 'https://invalid.example' } }, schema, limits).valid, false, cypher);
  const literal = validateReadQuery({ cypher: 'MATCH (n) WHERE n.`名称` = "DELETE; CALL CREATE" RETURN n LIMIT 1', parameters: {} }, schema, limits);
  assert.equal(literal.valid, true, JSON.stringify(literal.errors));
  assert.equal(validateReadQuery({ cypher: QUERY_TEMPLATES.entity, parameters: { name: 'x', entityId: '' } }, schema, limits).valid, false);
});

test('results change when fixture edges change, rather than returning canned answers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codegraph-fixture-'));
  try {
    const fixture = JSON.parse(await readFile(new URL('../data/fixture-graph.json', import.meta.url), 'utf8'));
    fixture.edges = fixture.edges.filter((edge: { type: string; source: string }) => !(edge.type === '发布' && edge.source === 'method:payOrder'));
    const fixturePath = join(directory, 'graph.json'); await writeFile(fixturePath, JSON.stringify(fixture));
    const graph = await createGraphAdapter({ mode: 'fixture', fixturePath });
    const result = await graph.execute(spec('mq', 'payOrder'), limits); assert.equal(result.rows.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('neo4j configuration fails explicitly without silently falling back to fixture', async () => {
  await assert.rejects(() => createGraphAdapter({ mode: 'neo4j' }), /NEO4J_URI/);
});

test('aborted requests stop before fixture query and schema access', async () => {
  const graph = await createGraphAdapter({ mode: 'fixture' }); const controller = new AbortController();
  controller.abort(new Error('cancelled by caller'));
  await assert.rejects(() => graph.getSchema(controller.signal), /cancelled by caller/);
  await assert.rejects(() => graph.execute(spec('entity'), limits, controller.signal), /cancelled by caller/);
});
