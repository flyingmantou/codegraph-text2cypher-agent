import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCase, evaluateSuite, type DevelopmentCase, type EvaluationSuite } from '../src/evaluation.ts';
import { evaluateHttp } from '../scripts/evaluate.ts';
import type { QueryResponse } from '../../../contracts/index.ts';

const item: DevelopmentCase = { id: 'DEV', question: '查询 getAllFood 方法', category: 'entity', complexity: 'simple', expectedStatus: 'success', exactNodeIds: ['method:getAllFood'] };
const suite: EvaluationSuite = { name: 'unit-test-suite', purpose: 'unit test', requiredGraphMode: 'fixture', requiredModelMode: 'demo', cases: [item] };
function response(): QueryResponse {
  return {
    id: 'run-1', question: item.question, status: 'success', summary: '找到指定方法的节点。', createdAt: '2026-11-25T00:00:00Z',
    source: { graph: 'fixture', model: 'demo', graphVersion: 'unit', modelName: 'demo-rules' },
    queries: [{ cypher: 'MATCH (n) RETURN n LIMIT $limit', parameters: { limit: 1 } }],
    result: { columns: ['n'], rows: [{ n: 'method:getAllFood' }], graph: { nodes: [{ id: 'method:getAllFood', label: '方法', name: 'getAllFood', properties: {} }], edges: [] }, truncated: false, durationMs: 1 },
    trace: [], usage: { modelCalls: 0, promptTokens: 0, completionTokens: 0, estimatedCostCny: 0 }, examplesUsed: [], candidates: [], warnings: [],
  };
}

test('nonempty unrelated results and extra entities fail semantic fixture assertions', () => {
  assert.deepEqual(checkCase(item, response(), suite), []);
  const wrong = response(); wrong.result.graph.nodes[0].id = 'method:unrelated';
  assert.ok(checkCase(item, wrong, suite).includes('evidence node set mismatch'));
  const extra = response(); extra.result.graph.nodes.push({ id: 'method:other', label: '方法', name: 'other', properties: {} });
  assert.ok(checkCase(item, extra, suite).includes('evidence node set mismatch'));
  const wrongMode = response(); wrongMode.source.model = 'deepseek';
  assert.ok(checkCase(item, wrongMode, suite).includes('model mode mismatch'));
});

test('evaluation distinguishes automatic regression success from pending human accuracy and unknown cost', async () => {
  const out = response(); out.usage.estimatedCostCny = null;
  const report = await evaluateSuite(suite, async () => out);
  assert.equal(report.totals.passed, 1); assert.equal(report.totals.executionSuccessful, 1);
  assert.equal(report.totals.estimatedCostCny, null); assert.equal(report.totals.humanSemanticAccuracy, null);
  assert.equal(report.cases[0].semanticReview, 'pending-human-review');
  assert.deepEqual(report.cases[0].queries, out.queries); assert.deepEqual(report.cases[0].actualResult, out.result);
});

test('transport failures stay explicit without leaking raw exceptions into reports', async () => {
  const report = await evaluateSuite(suite, async () => { throw new Error('PRIVATE_TOKEN_MUST_NOT_BE_RECORDED'); });
  assert.equal(report.totals.passed, 0); assert.equal(report.totals.estimatedCostCny, null);
  assert.equal(report.cases[0].status, 'transport_error');
  assert.ok(!JSON.stringify(report).includes('PRIVATE_TOKEN'));
});

test('HTTP evaluator sends query contract only to localhost and refuses redirects', async () => {
  let count = 0;
  const mock: typeof fetch = async (url, init) => {
    count++;
    assert.equal(new URL(String(url)).pathname, '/api/query');
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body));
    assert.ok(body.question); assert.ok(['simple', 'medium', 'hard'].includes(body.complexity));
    return new Response(JSON.stringify(response()));
  };
  const report = await evaluateHttp('http://127.0.0.1:3000', mock);
  assert.equal(count, 12); assert.equal(report.cases.length, 12);
  assert.ok(report.totals.passed < 12);
  await assert.rejects(() => evaluateHttp('https://example.com', mock), /LOCAL_API_REQUIRED/);
  assert.equal(count, 12);
});
