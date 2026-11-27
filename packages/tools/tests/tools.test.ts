import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createToolService } from '../src/index.ts';
import { setup, limits, query } from './helpers.ts';
import type { ExecutionEvidence, TicketValidation, ToolContext, ToolService } from '../../../contracts/index.ts';
const context: ToolContext = { sessionId: 'session-a', limits, selectedEntityId: 'method:getAllFood' };
async function execute(service: ToolService, category: 'entity'|'downstream'|'mq' = 'entity', entityId = context.selectedEntityId!, ctx = { ...context, selectedEntityId: entityId }) {
  const checked = await service.call<TicketValidation>('validate_query', { query: query(category, entityId) }, ctx);
  assert.equal(checked.ok, true); assert.equal(checked.data!.valid, true, JSON.stringify(checked));
  const result = await service.call<ExecutionEvidence>('execute_query', { ticket: checked.data!.ticket }, ctx);
  assert.equal(result.ok, true, JSON.stringify(result)); return result.data!;
}

test('execution requires a one-use ticket tied to session, selected entity and limits', async () => {
  const kit = await setup(); try {
    assert.equal((await kit.service.call('execute_query', { query: query() }, context)).error?.code, 'INVALID_ARGUMENT');
    const checked = await kit.service.call<TicketValidation>('validate_query', { query: query() }, context); const ticket = checked.data!.ticket;
    for (const changed of [{ ...context, sessionId: 'other' }, { ...context, selectedEntityId: 'method:placeOrder' }, { ...context, limits: { ...limits, maxRows: 10 } }]) {
      assert.equal((await kit.service.call('execute_query', { ticket }, changed)).error?.code, 'TICKET_CONTEXT_MISMATCH');
    }
    const done = await kit.service.call<ExecutionEvidence>('execute_query', { ticket }, context); assert.equal(done.ok, true); assert.equal(done.data!.result.rows.length, 1);
    assert.equal((await kit.service.call('execute_query', { ticket }, context)).error?.code, 'INVALID_TICKET');
  } finally { await kit.cleanup(); }
});

test('selected entity cannot be widened by a name or substituted parameter', async () => {
  const kit = await setup(); try {
    for (const parameters of [{ name: 'getOrder', entityId: 'method:getAllFood', limit: 100 }, { name: '', entityId: 'method:placeOrder', limit: 100 }]) {
      const result = await kit.service.call<TicketValidation>('validate_query', { query: { ...query(), parameters } }, context);
      assert.equal(result.ok, true); assert.equal(result.data!.valid, false); assert.ok(!result.data!.ticket);
      assert.ok(result.data!.errors.some(error => error.code === 'ENTITY_SCOPE_MISMATCH'));
    }
    const queryObject = query(); const checked = await kit.service.call<TicketValidation>('validate_query', { query: queryObject }, context);
    queryObject.parameters.entityId = 'method:placeOrder';
    const result = await kit.service.call<ExecutionEvidence>('execute_query', { ticket: checked.data!.ticket }, context);
    assert.equal(result.data!.result.graph.nodes[0].id, 'method:getAllFood');
  } finally { await kit.cleanup(); }
});

test('ticket expires and cancelled operations are explicit without leaking caller errors', async () => {
  const kit = await setup(); const realNow = Date.now; try {
    const checked = await kit.service.call<TicketValidation>('validate_query', { query: query() }, context);
    Date.now = () => realNow() + 120001;
    assert.equal((await kit.service.call('execute_query', { ticket: checked.data!.ticket }, context)).error?.code, 'INVALID_TICKET');
    Date.now = realNow;
    const controller = new AbortController(); controller.abort(new Error('DO_NOT_ECHO_SECRET'));
    const result = await kit.service.call('get_schema', {}, { ...context, signal: controller.signal });
    assert.equal(result.error?.code, 'TIMEOUT'); assert.ok(!JSON.stringify(result).includes('DO_NOT_ECHO_SECRET'));
  } finally { Date.now = realNow; await kit.cleanup(); }
});

test('merge/report accepts only same-session evidence and preserves unique paths and communication types', async () => {
  const kit = await setup(); try {
    const ctx = { ...context, selectedEntityId: 'method:placeOrder' };
    const rpc = await execute(kit.service, 'downstream', 'method:placeOrder', ctx); const mq = await execute(kit.service, 'mq', 'method:placeOrder', ctx);
    const merged = await kit.service.call<ExecutionEvidence>('merge_results', { executionIds: [rpc.executionId, mq.executionId, rpc.executionId] }, ctx);
    assert.equal(merged.ok, true); assert.deepEqual(merged.data!.sourceExecutionIds, [rpc.executionId, mq.executionId]);
    assert.ok(merged.data!.result.graph.edges.some(edge => edge.type === 'RPC调用')); assert.ok(merged.data!.result.graph.edges.some(edge => edge.type === '消费'));
    assert.equal(new Set(merged.data!.result.graph.nodes.map(node => node.id)).size, merged.data!.result.graph.nodes.length);
    assert.equal((await kit.service.call('merge_results', { executionIds: [rpc.executionId] }, { ...ctx, sessionId: 'other' })).error?.code, 'UNKNOWN_EVIDENCE');
    assert.equal((await kit.service.call('merge_results', { executionIds: ['fabricated'] }, ctx)).error?.code, 'UNKNOWN_EVIDENCE');
    const report = await kit.service.call<{ markdown: string }>('export_report', { question: 'placeOrder 综合依赖', executionIds: [rpc.executionId, mq.executionId, merged.data!.executionId] }, ctx);
    assert.ok(report.data!.markdown.includes('fixture-train-ticket-v1')); assert.ok(report.data!.markdown.includes('RPC调用')); assert.ok(report.data!.markdown.includes('消费'));
    rpc.result.rows.length = 0;
    const preserved = await kit.service.call<ExecutionEvidence>('merge_results', { executionIds: [rpc.executionId] }, ctx); assert.ok(preserved.data!.result.rows.length > 0);
  } finally { await kit.cleanup(); }
});

test('semantic concepts retrieve equivalent wording without lexical overlap; mutation invalidates verification', async () => {
  const kit = await setup(); try {
    assert.equal((await kit.service.call<any[]>('search_examples', { question: '哪些功能会受牵连', mode: 'semantic' }, context)).data!.length, 0);
    const verified = await kit.service.examples.verify(); assert.equal(verified.verified, 3);
    const lexical = await kit.service.call<any[]>('search_examples', { question: '哪些功能会受牵连', mode: 'lexical' }, context);
    assert.equal(lexical.data!.length, 0);
    const semantic = await kit.service.call<any[]>('search_examples', { question: '哪些功能会受牵连', mode: 'semantic' }, context);
    assert.equal(semantic.data![0].example.id, 'impact'); assert.equal(semantic.data![0].semanticScore, 1);
    const example = (await kit.service.examples.list()).find(item => item.id === 'impact')!;
    await kit.service.examples.upsert({ ...example, description: '更新后的说明' });
    const after = await kit.service.call<any[]>('search_examples', { question: '哪些功能会受牵连', mode: 'semantic' }, context);
    assert.equal(after.data!.length, 0);
    assert.equal((await kit.service.examples.list()).find(item => item.id === 'impact')!.verification.status, 'unverified');
    assert.equal(await kit.service.examples.delete('impact'), true);
  } finally { await kit.cleanup(); }
});

test('verified examples from another graph version are excluded from generation retrieval', async () => {
  const kit = await setup(); try {
    await kit.service.examples.verify(); const storePath = join(kit.config.dataDir, 'examples.json');
    const items = JSON.parse(await readFile(storePath, 'utf8')); items.forEach((item: any) => item.verification.graphVersion = 'old-version');
    await writeFile(storePath, JSON.stringify(items));
    const second = await createToolService(kit.config);
    try { const result = await second.call<any[]>('search_examples', { question: '反向影响' }, context); assert.equal(result.data!.length, 0); }
    finally { await second.close(); }
  } finally { await kit.cleanup(); }
});


test('entity tools prefer exact names or IDs while preserving genuine duplicate names', async () => {
  const kit = await setup(); try {
    const one = await kit.service.call<any[]>('resolve_entities', {term:'getAllFood'}, context);
    assert.deepEqual(one.data!.map(node => node.id), ['method:getAllFood']);
    const duplicate = await kit.service.call<any[]>('resolve_entities', {term:'getOrder'}, context);
    assert.equal(duplicate.data!.length, 2); assert.ok(duplicate.data!.every(node => node.name === 'getOrder'));
    const selected = await kit.service.call<any[]>('resolve_entities', {term:'method:getOrder:admin'}, context);
    assert.deepEqual(selected.data!.map(node => node.id), ['method:getOrder:admin']);
    const fuzzy = await kit.service.call<any[]>('resolve_entities', {term:'food'}, context);
    assert.ok(fuzzy.data!.length > 1);
  } finally { await kit.cleanup(); }
});
