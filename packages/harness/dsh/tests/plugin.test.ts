import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolService } from '../../../tools/src/index.ts';
import { loadSkillBundle } from '../../../skills/src/index.ts';
import { registerProjectPlugin, toDshSchema, type DshDenial, type DshExecution, type DshHost, type DshToolDefinition } from '../plugin.ts';
import type { Limits, SkillBundle, ToolContext, ToolService } from '../../../../contracts/index.ts';

const names = ['get_schema', 'resolve_entities', 'search_examples', 'validate_query', 'execute_query', 'merge_results', 'export_report'];
const limits: Limits = { maxRows: 100, maxDepth: 4, timeoutMs: 1000, maxRepairs: 1, maxModelCalls: 4, maxToolCalls: 24 };
const skill: SkillBundle = { id: 'text2cypher', version: '2.0.0', instructions: '先检查 Schema，然后查询。', stages: [], planDemo: () => ({ category: 'entity', entityTerm: 'method', branches: [] }), seedPath: '', semanticLexiconPath: '' };
const result = { columns: ['name'], rows: [{ name: 'method' }], graph: { nodes: [], edges: [] }, truncated: false, durationMs: 1 };

function fixture() {
  const definitions = new Map<string, DshToolDefinition>();
  const guards = new Set<(exec: DshExecution) => DshDenial | undefined>();
  const hooks = new Map<string, Set<Function>>();
  const skills: Record<string, unknown>[] = [];
  const calls: { name: string; args: Record<string, unknown>; context: ToolContext }[] = [];
  const ctx = {
    tools: {
      register(definition: DshToolDefinition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); },
      guard(fn: (exec: DshExecution) => DshDenial | undefined) { guards.add(fn); return () => guards.delete(fn); },
    },
    skills: { register(value: Record<string, unknown>) { skills.push(value); return () => { skills.splice(skills.indexOf(value), 1); }; } },
    on(name: string, fn: Function) { let set = hooks.get(name); if (!set) { set = new Set(); hooks.set(name, set); } set.add(fn); return () => set!.delete(fn); },
  } as DshHost;
  const tools: ToolService = {
    definitions: names.map(name => ({ name, description: name, inputSchema: { type: 'object', additionalProperties: true } })),
    fixtureTemplates: {} as ToolService['fixtureTemplates'],
    examples: {} as ToolService['examples'],
    async call(name, args, context) {
      calls.push({ name, args, context });
      let data: unknown;
      if (name === 'get_schema') data = { version: 'fixture-v1', source: 'fixture', nodeLabels: ['方法'], relationshipTypes: [], nodeProperties: {}, relationshipPatterns: [] };
      if (name === 'resolve_entities') data = (args.term === 'ambiguous' ? ['a', 'b'] : ['a']).map(id => ({ id, label: '方法', name: 'method', properties: {} }));
      if (name === 'search_examples') data = [];
      if (name === 'validate_query') data = { valid: true, errors: [], warnings: [], ticket: 'ticket:' + context.sessionId };
      if (name === 'execute_query') data = { executionId: 'evidence:' + context.sessionId, result };
      if (name === 'merge_results') data = { executionId: 'merged:' + context.sessionId, result, sourceExecutionIds: args.executionIds };
      if (name === 'export_report') data = { markdown: '# Evidence report' };
      return { ok: true, data } as any;
    },
    async close() {},
  };
  const exec = async (agent: object, name: string, args: Record<string, unknown> = {}, signal = new AbortController().signal) => {
    const execution: DshExecution = { agent, name: 'codegraph_' + name, arguments: args, signal };
    for (const guard of guards) { const denied = guard(execution); if (denied) throw new Error(denied.reason); }
    const def = definitions.get(execution.name)!;
    const wrappers = [...hooks.get('tools/execute') ?? []];
    const next = (i: number): Promise<any> => i < wrappers.length ? wrappers[i](execution, () => next(i + 1)) : def.execute(args, execution);
    try { return await next(0); } finally { assert.equal(execution.signal, signal); }
  };
  const emit = (event: string, ...args: unknown[]) => { for (const fn of hooks.get(event) ?? []) fn(...args); };
  return { ctx, tools, calls, definitions, guards, hooks, skills, exec, emit };
}

test('DSH installs seven fine-grained tools, a mapped Skill and monotonic guards', () => {
  const f = fixture(); const controller = registerProjectPlugin(f.ctx, { tools: f.tools, skill, limits });
  assert.deepEqual([...f.definitions.keys()], names.map(name => 'codegraph_' + name));
  assert.ok(!f.definitions.has('codegraph_query'));
  assert.equal(f.skills[0].source, 'runtime');
  for (const name of names) assert.ok(String(f.skills[0].content).includes('codegraph_' + name));
  assert.equal(f.guards.size, 1); assert.equal(f.hooks.get('tools/execute')?.size, 1);
  controller.dispose(); controller.dispose();
  assert.equal(f.definitions.size, 0); assert.equal(f.guards.size, 0); assert.equal(f.skills.length, 0);
});

test('MCP schemas are projected into the documented DSH subset without dropping tool-side bounds', () => {
  const schema = toDshSchema({ type: 'object', properties: { category: { enum: ['entity', 'mq'] }, ids: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', maxLength: 100 } } }, required: ['ids'], additionalProperties: false });
  const properties = schema.properties as any;
  assert.equal(properties.category.type, 'string');
  assert.equal(properties.ids.maxItems, undefined); assert.ok(properties.ids.description.includes('maxItems=10'));
  assert.equal(properties.ids.items.maxLength, undefined); assert.ok(properties.ids.items.description.includes('maxLength=100'));
  assert.deepEqual(schema.required, ['ids']); assert.equal(schema.additionalProperties, false);
  assert.throws(() => toDshSchema({ type: 'string', pattern: '.*' }), /UNSUPPORTED_DSH_SCHEMA_KEY/);
});

test('schema, validation ticket, execution and report evidence form enforced stages', async () => {
  const f = fixture(); const controller = registerProjectPlugin(f.ctx, { tools: f.tools, skill, limits }); const agent = {};
  await assert.rejects(() => f.exec(agent, 'validate_query', { query: {} }), /SCHEMA_REQUIRED/);
  await f.exec(agent, 'get_schema'); await f.exec(agent, 'resolve_entities', { term: 'method' });
  await assert.rejects(() => f.exec(agent, 'execute_query', { ticket: 'invented' }), /VALIDATION_TICKET_REQUIRED/);
  const validation = await f.exec(agent, 'validate_query', { query: {} });
  const evidence = await f.exec(agent, 'execute_query', { ticket: validation.ticket });
  await assert.rejects(() => f.exec(agent, 'export_report', { question: 'q', executionIds: ['invented'] }), /EXECUTION_EVIDENCE_REQUIRED/);
  const report = await f.exec(agent, 'export_report', { question: 'q', executionIds: [evidence.executionId] });
  assert.equal(report.markdown, '# Evidence report');
  assert.equal(f.calls.find(call => call.name === 'execute_query')?.context.selectedEntityId, 'a');
  assert.deepEqual(controller.snapshot(agent)?.evidenceIds, [evidence.executionId]);
});

test('ambiguous resolution cannot be bypassed by a model-controlled precise lookup', async () => {
  const f = fixture(); const controller = registerProjectPlugin(f.ctx, { tools: f.tools, skill, limits }); const agent = {};
  await f.exec(agent, 'get_schema'); await f.exec(agent, 'resolve_entities', { term: 'ambiguous' });
  await f.exec(agent, 'resolve_entities', { term: 'a' });
  await assert.rejects(() => f.exec(agent, 'validate_query', { query: {}, selectedEntityId: 'a' }), /ENTITY_CONFIRMATION_REQUIRED/);
  assert.throws(() => controller.confirmEntity(agent, 'outside-candidates'), /INVALID_ENTITY_CONFIRMATION/);
  controller.confirmEntity(agent, 'b');
  await f.exec(agent, 'resolve_entities', { term: 'a' });
  await f.exec(agent, 'validate_query', { query: {} });
  assert.equal(f.calls.at(-1)?.context.selectedEntityId, 'b');
});

test('actual Skill and ToolService complete a fixture query through the fake DSH registry', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'codegraph-dsh-'));
  const bundle = await loadSkillBundle();
  const actual = await createToolService({ graph: { mode: 'fixture' }, dataDir, seedPath: bundle.seedPath, semanticLexiconPath: bundle.semanticLexiconPath, limits });
  const f = fixture();
  const controller = registerProjectPlugin(f.ctx, { tools: actual, skill: bundle, limits });
  try {
    await actual.examples.verify();
    const agent = {};
    const schema = await f.exec(agent, 'get_schema');
    assert.equal(schema.source, 'fixture');
    const candidates = await f.exec(agent, 'resolve_entities', { term: 'method:getAllFood' });
    assert.equal(candidates.length, 1);
    const examples = await f.exec(agent, 'search_examples', { question: '查询 getAllFood 实体', category: 'entity' });
    assert.ok(examples.length > 0);
    const validation = await f.exec(agent, 'validate_query', { query: { cypher: actual.fixtureTemplates.entity, parameters: { entityId: candidates[0].id, name: '', limit: 100 } } });
    assert.equal(validation.valid, true);
    const evidence = await f.exec(agent, 'execute_query', { ticket: validation.ticket });
    assert.ok(evidence.result.rows.length > 0);
    assert.ok(evidence.result.graph.nodes.some((node: { id: string }) => node.id === candidates[0].id));
    const report = await f.exec(agent, 'export_report', { question: '查询 getAllFood 实体', executionIds: [evidence.executionId] });
    assert.ok(report.markdown.includes(evidence.executionId));
    await assert.rejects(() => f.exec(agent, 'execute_query', { ticket: validation.ticket }), /INVALID_TICKET/);
  } finally { controller.dispose(); await actual.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('tickets and evidence cannot cross Agent boundaries', async () => {
  const f = fixture(); registerProjectPlugin(f.ctx, { tools: f.tools, skill, limits }); const a = {}, b = {};
  await f.exec(a, 'get_schema'); const validation = await f.exec(a, 'validate_query', { query: {} });
  const evidence = await f.exec(a, 'execute_query', { ticket: validation.ticket });
  await f.exec(b, 'get_schema');
  await assert.rejects(() => f.exec(b, 'execute_query', { ticket: validation.ticket }), /VALIDATION_TICKET_REQUIRED/);
  await assert.rejects(() => f.exec(b, 'merge_results', { executionIds: [evidence.executionId] }), /EXECUTION_EVIDENCE_REQUIRED/);
});

test('tool budget cannot be reset by rereading Schema; trusted beginTask resets it', async () => {
  const f = fixture(); const controller = registerProjectPlugin(f.ctx, { tools: f.tools, skill, limits: { ...limits, maxToolCalls: 2 } }); const agent = {};
  await f.exec(agent, 'get_schema'); await f.exec(agent, 'get_schema');
  await assert.rejects(() => f.exec(agent, 'get_schema'), /TOOL_BUDGET_EXHAUSTED/);
  controller.beginTask(agent, 'new human request'); await f.exec(agent, 'get_schema');
  assert.equal(controller.snapshot(agent)?.calls, 1);
});

test('host turn events renew budgets without fabricating entity confirmation', async () => {
  const f = fixture(); const controller = registerProjectPlugin(f.ctx, { tools: f.tools, skill, limits }); const agent = { session: {} };
  await f.exec(agent, 'get_schema'); await f.exec(agent, 'resolve_entities', { term: 'ambiguous' });
  f.emit('session/event', agent.session, { type: 'turn/start' });
  assert.equal(controller.snapshot(agent)?.calls, 0); assert.equal(controller.snapshot(agent)?.needsClarification, true);
  await f.exec(agent, 'get_schema');
  await assert.rejects(() => f.exec(agent, 'validate_query', { query: {} }), /ENTITY_CONFIRMATION_REQUIRED/);
});

test('timeout and caller cancellation propagate to the tool service and restore host signal', async () => {
  const f = fixture(); const original = f.tools.call.bind(f.tools); let observed = false;
  f.tools.call = async (name, args, context) => {
    if (name !== 'resolve_entities') return original(name, args, context);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1000);
      const abort = () => { observed = true; clearTimeout(timer); reject(context.signal?.reason); };
      if (context.signal?.aborted) abort(); else context.signal?.addEventListener('abort', abort, { once: true });
    });
    return { ok: true, data: [] } as any;
  };
  registerProjectPlugin(f.ctx, { tools: f.tools, skill, limits: { ...limits, timeoutMs: 30 } }); const agent = {};
  await f.exec(agent, 'get_schema');
  await assert.rejects(() => f.exec(agent, 'resolve_entities', { term: 'method' }), /timeout/i);
  assert.equal(observed, true);
  const signal = new AbortController(); signal.abort();
  await assert.rejects(() => f.exec({}, 'get_schema', {}, signal.signal), /abort/i);
});
