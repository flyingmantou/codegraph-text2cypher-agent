import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadSkillBundle, planDemo, hasUnsafeIntent, STAGES } from '../src/index.ts';
import type { QueryExample } from '../../../contracts/index.ts';

test('the seven domain intents retain source entity and split joint analysis into real branches', () => {
  const examples = [
    ['查询 getAllFood 方法', 'entity', 'getAllFood'],
    ['名称包含 order 的服务', 'filter', 'order'],
    ['ts-order-service 有哪些入口 API', 'api', 'ts-order-service'],
    ['getAllFood 下游服务依赖', 'downstream', 'getAllFood'],
    ['queryFoodStore 的反向调用者有哪些', 'impact', 'queryFoodStore'],
    ['payOrder 的 MQ 消息链路', 'mq', 'payOrder'],
    ['placeOrder 的 RPC 和 MQ 综合依赖', 'combined', 'placeOrder'],
  ];
  for (const [question, category, entityTerm] of examples) {
    const plan = planDemo(question);
    assert.equal(plan.category, category); assert.equal(plan.entityTerm, entityTerm);
    assert.equal(plan.branches.length, category === 'combined' ? 2 : 1);
  }
  assert.deepEqual(planDemo(examples[6][0]).branches.map(branch => branch.category), ['downstream', 'mq']);
  assert.equal(planDemo('查询 getOrder 方法').entityTerm, 'getOrder');
});

test('demo does not invent missing entity names or confuse API identifiers with API discovery', () => {
  assert.throws(() => planDemo('查询这个方法的下游服务'), /UNSUPPORTED_DEMO_QUERY/);
  assert.throws(() => planDemo('名称包含的服务'), /UNSUPPORTED_DEMO_QUERY/);
  assert.equal(planDemo('查询 /api/getAllFood 节点').category, 'entity');
  assert.equal(planDemo('查询 getApiData 方法').category, 'entity');
  assert.equal(planDemo('查询 method:getOrder:order 节点').entityTerm, 'method:getOrder:order');
  assert.equal(planDemo('查询“订票服务”的下游').entityTerm, '订票服务');
});

test('unsafe write requests remain rejected even when they mention impact analysis', () => {
  for (const question of ['删除所有节点', '清空数据库并分析影响', '删除节点 getAllFood 然后分析影响', 'CALL dbms.components()', 'MATCH (n) DETACH DELETE n']) {
    assert.equal(hasUnsafeIntent(question), true);
    assert.throws(() => planDemo(question), error => (error as Error & { code: string }).code === 'UNSAFE_REQUEST');
  }
  assert.equal(planDemo('如果删除 getAllFood 方法，影响哪些调用者').category, 'impact');
});

test('versioned Skill and seed data preserve contracts, categories and unverified provenance', async () => {
  const bundle = await loadSkillBundle();
  assert.equal(bundle.version, '2.0.0'); assert.deepEqual(bundle.stages, [...STAGES]);
  for (const name of ['get_schema', 'resolve_entities', 'search_examples', 'validate_query', 'execute_query', 'merge_results', 'export_report']) assert.ok(bundle.instructions.includes(name));
  const examples = JSON.parse(await readFile(bundle.seedPath, 'utf8')) as QueryExample[];
  assert.equal(examples.length, 35);
  assert.equal(new Set(examples.map(example => example.id)).size, 35);
  assert.deepEqual([...new Set(examples.map(example => example.category))].sort(), ['api', 'combined', 'downstream', 'entity', 'filter', 'impact', 'mq']);
  assert.ok(examples.every(example => example.verification.status === 'unverified' && example.description.includes('fixture')));
  const concepts = JSON.parse(await readFile(bundle.semanticLexiconPath, 'utf8')) as { concepts: { id: string; terms: string[] }[] };
  assert.equal(new Set(concepts.concepts.map(concept => concept.id)).size, concepts.concepts.length);
  assert.ok(concepts.concepts.every(concept => concept.terms.length >= 3));
  assert.ok(concepts.concepts.find(concept => concept.id === 'consumer')?.terms.includes('订阅'));
});

test('development regression and the unfilled 10/12/8 independent template stay separate from examples', async () => {
  const dev = JSON.parse(await readFile(new URL('../data/evaluation.dev.json', import.meta.url), 'utf8'));
  const course = JSON.parse(await readFile(new URL('../data/evaluation.course.template.json', import.meta.url), 'utf8'));
  assert.ok(dev.cases.length >= 12);
  assert.equal(new Set(dev.cases.map((item: { category: string }) => item.category)).size, 7);
  assert.equal(course.status, 'unfilled-not-frozen'); assert.equal(course.cases.length, 30);
  assert.deepEqual(['simple', 'medium', 'hard'].map(level => course.cases.filter((item: { complexity: string }) => item.complexity === level).length), [10, 12, 8]);
  assert.ok(course.cases.every((item: { question: unknown; referenceCypher: unknown; manualReview: { status: string } }) => item.question === null && item.referenceCypher === null && item.manualReview.status === 'pending'));
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('evaluation.course')); assert.ok(!source.includes('evaluation.dev'));
});
