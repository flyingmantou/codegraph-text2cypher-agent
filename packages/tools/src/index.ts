import { randomUUID } from 'node:crypto';
import type { Category, ExecutionEvidence, ExecutionResult, GraphNode, Limits, QuerySpec, TicketValidation, ToolContext, ToolDefinition, ToolReply, ToolService, ToolServiceConfig } from '../../../contracts/index.ts';
import { createGraphAdapter } from './graph/index.ts';
import { QUERY_TEMPLATES } from './graph/templates.ts';
import { entityScopeMatches } from './entity-scope.ts';
import { CATEGORIES, ExampleStore, type RetrievalMode } from './examples.ts';

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });
const stringSchema = { type: 'string', minLength: 1, maxLength: 2000 };
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: 'get_schema', description: '读取实际图谱 Schema、来源和版本；生成查询前调用。', inputSchema: objectSchema({}) },
  { name: 'resolve_entities', description: '检索代码实体候选；同名候选须由用户澄清，不得猜选。', inputSchema: objectSchema({ term: stringSchema }, ['term']) },
  { name: 'search_examples', description: '检索当前图谱验证通过的示例。hybrid组合词项与领域概念向量；不是神经embedding。', inputSchema: objectSchema({ question: stringSchema, category: { enum: CATEGORIES }, verifiedOnly: { type: 'boolean', default: true }, mode: { enum: ['lexical', 'semantic', 'hybrid'], default: 'hybrid' } }, ['question']) },
  { name: 'validate_query', description: '校验只读 Cypher、Schema、参数、实体和预算；成功签发绑定本会话的一次性执行票据。', inputSchema: objectSchema({ query: objectSchema({ cypher: { type: 'string', minLength: 1, maxLength: 12000 }, parameters: { type: 'object' }, label: { type: 'string' } }, ['cypher', 'parameters']) }, ['query']) },
  { name: 'execute_query', description: '使用校验票据执行查询；内部再次校验。拒绝任意查询文本和票据重放。返回真实执行证据ID。', inputSchema: objectSchema({ ticket: stringSchema }, ['ticket']) },
  { name: 'merge_results', description: '按实体、边与记录去重合并本会话已执行结果，保留路径、通信类型和源证据ID。', inputSchema: objectSchema({ executionIds: { type: 'array', items: stringSchema, minItems: 1, maxItems: 10 } }, ['executionIds']) },
  { name: 'export_report', description: '根据本会话已执行证据生成 Markdown 报告，不接受自造结果。', inputSchema: objectSchema({ question: stringSchema, executionIds: { type: 'array', items: stringSchema, minItems: 1, maxItems: 10 } }, ['question', 'executionIds']) },
];
const errorMessages: Record<string, string> = {
  INVALID_ARGUMENT: '工具参数不符合接口约定。', INVALID_CONTEXT: '工具调用上下文无效。', UNKNOWN_TOOL: '工具不存在。',
  INVALID_TICKET: '校验票据不存在、已使用或已过期，请重新校验。', TICKET_CONTEXT_MISMATCH: '票据所属会话、选定实体或执行限制已变化，请重新校验。',
  SCHEMA_CHANGED: '图谱版本已变化，请重新获取 Schema 并校验。', ENTITY_SCOPE_MISMATCH: '查询未严格约束所选实体。',
  UNKNOWN_EVIDENCE: '证据不存在、过期或不属于本会话。', QUERY_VALIDATION_FAILED: '查询未通过执行前重校验。',
  TIMEOUT: '工具请求已超时或取消。', TOOL_FAILED: '工具执行失败，请检查数据服务配置。', SERVICE_CLOSED: '工具服务已关闭。',
};
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => JSON.stringify(key) + ':' + canonical(val)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARGUMENT'); return value as Record<string, unknown>; }
function text(value: unknown, max = 2000): string { if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_ARGUMENT'); return value as string; }
function limitedLimits(requested: Limits, ceiling: Limits): Limits {
  if (!requested || !ceiling) fail('INVALID_CONTEXT');
  for (const value of [requested.maxRows, requested.maxDepth, requested.timeoutMs, ceiling.maxRows, ceiling.maxDepth, ceiling.timeoutMs]) if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_CONTEXT');
  return { maxRows: Math.min(requested.maxRows, ceiling.maxRows), maxDepth: Math.min(requested.maxDepth, ceiling.maxDepth), timeoutMs: Math.min(requested.timeoutMs, ceiling.timeoutMs), maxRepairs: 0, maxModelCalls: 1 };
}
function queryInput(value: unknown): QuerySpec {
  const input = record(value); const parameters = record(input.parameters);
  if (Object.keys(input).some(key => !['cypher', 'parameters', 'label'].includes(key)) || JSON.stringify(parameters).length > 16000) fail('INVALID_ARGUMENT');
  return { cypher: text(input.cypher, 12000).trim(), parameters: structuredClone(parameters), ...(typeof input.label === 'string' ? { label: input.label.slice(0, 200) } : {}) };
}
function selectedScope(query: QuerySpec, selectedEntityId: string | undefined, live: boolean): boolean {
  return !selectedEntityId || entityScopeMatches(query, { id: selectedEntityId } as GraphNode, live);
}
function idsInput(value: unknown): string[] { if (!Array.isArray(value) || !value.length || value.length > 10) fail('INVALID_ARGUMENT'); return [...new Set((value as unknown[]).map(x => text(x, 200)))]; }
function mergedResult(records: ExecutionEvidence[], limits: Limits): ExecutionResult {
  const rowMap = new Map<string, Record<string, unknown>>(); const nodes = new Map(); const edges = new Map();
  for (const evidence of records) for (const row of evidence.result.rows) rowMap.set(canonical(row), structuredClone(row));
  const rows = [...rowMap.values()].slice(0, limits.maxRows);
  // Reconstruct graph from retained rows when possible, preventing hidden capped rows from leaking into the subgraph.
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const item = value as Record<string, unknown>;
    if (typeof item.id === 'string' && typeof item.source === 'string' && typeof item.target === 'string' && typeof item.type === 'string') edges.set(item.id, structuredClone(item));
    else if (typeof item.id === 'string' && typeof item.label === 'string' && typeof item.name === 'string') nodes.set(item.id, structuredClone(item));
    else Object.values(item).forEach(visit);
  };
  rows.forEach(visit);
  return { columns: [...new Set(records.flatMap(e => e.result.columns))], rows, graph: { nodes: [...nodes.values()], edges: [...edges.values()].filter(edge => nodes.has(edge.source) && nodes.has(edge.target)) }, truncated: rowMap.size > limits.maxRows || records.some(e => e.result.truncated), durationMs: records.reduce((sum, e) => sum + e.result.durationMs, 0) };
}
function markdownReport(question: string, records: ExecutionEvidence[], graphSource: string, graphVersion: string): string {
  const plain = (value: string) => value.replace(/[<>]/g, '').replace(/\r/g, '').slice(0, 4000);
  const lines = ['# 代码图谱查询报告', '', `问题：${plain(question)}`, '', `图谱来源：${graphSource}；版本：${plain(graphVersion)}`, '', '结果来自本会话工具实际执行记录；人工图谱不能作为课程图谱验收依据。', ''];
  for (const evidence of records) {
    lines.push(`## 证据 ${evidence.executionId}`, '', `记录数：${evidence.result.rows.length}；节点：${evidence.result.graph.nodes.length}；关系：${evidence.result.graph.edges.length}；截断：${evidence.result.truncated ? '是' : '否'}`, '');
    if (evidence.query) lines.push('```cypher', evidence.query.cypher.replace(/```/g, ''), '```', '', '```json', JSON.stringify(evidence.query.parameters, null, 2), '```', '');
    if (evidence.sourceExecutionIds) lines.push(`源证据：${evidence.sourceExecutionIds.join('、')}`, '');
    lines.push('```json', JSON.stringify(evidence.result.rows, null, 2).replace(/```/g, '\\u0060\\u0060\\u0060'), '```', '');
  }
  return lines.join('\n');
}

export async function createToolService(config: ToolServiceConfig): Promise<ToolService> {
  limitedLimits(config.limits, config.limits);
  const graph = await createGraphAdapter(config.graph);
  const examples = new ExampleStore(config.dataDir, config.seedPath, config.semanticLexiconPath, graph, config.limits);
  try { await examples.initialize(); } catch (error) { await graph.close(); throw error; }
  type Ticket = { query: QuerySpec; binding: string; graphVersion: string; expires: number };
  type StoredEvidence = { evidence: ExecutionEvidence; sessionId: string; graphVersion: string; graphSource: string; expires: number };
  const tickets = new Map<string, Ticket>(); const evidence = new Map<string, StoredEvidence>(); let closed = false;
  const prune = () => { for (const map of [tickets, evidence]) { for (const [id, value] of map) if (value.expires <= Date.now()) map.delete(id); while (map.size > 1000) map.delete(map.keys().next().value!); } };
  async function call<T = unknown>(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolReply<T>> {
    try {
      if (closed) fail('SERVICE_CLOSED'); prune();
      if (!context || typeof context.sessionId !== 'string' || !context.sessionId || context.sessionId.length > 200 || context.selectedEntityId !== undefined && typeof context.selectedEntityId !== 'string') fail('INVALID_CONTEXT');
      const limits = limitedLimits(context.limits, config.limits);
      const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(limits.timeoutMs)]) : AbortSignal.timeout(limits.timeoutMs); signal.throwIfAborted();
      const definition = TOOL_DEFINITIONS.find(tool => tool.name === name); if (!definition) fail('UNKNOWN_TOOL');
      record(args); const allowed = Object.keys(definition.inputSchema.properties as Record<string, unknown>);
      if (Object.keys(args).some(key => !allowed.includes(key))) fail('INVALID_ARGUMENT');
      const binding = canonical({ sessionId: context.sessionId, selectedEntityId: context.selectedEntityId ?? null, limits });
      const getEvidence = (ids: string[]) => ids.map(id => { const item = evidence.get(id); if (!item || item.sessionId !== context.sessionId || item.expires <= Date.now()) fail('UNKNOWN_EVIDENCE'); return item!; });
      const save = (value: ExecutionEvidence, graphSource: string, graphVersion: string) => { evidence.set(value.executionId, { evidence: structuredClone(value), sessionId: context.sessionId, graphSource, graphVersion, expires: Date.now() + 15 * 60_000 }); prune(); return value; };
      let data: unknown;
      if (name === 'get_schema') data = await graph.getSchema(signal);
      else if (name === 'resolve_entities') {
        const term = text(args.term).trim(); const candidates = await graph.resolveEntities(term, signal);
        const normalized = term.toLowerCase(); const exact = candidates.filter(node => node.id.toLowerCase() === normalized || node.name.toLowerCase() === normalized);
        data = exact.length ? exact : candidates;
      }
      else if (name === 'search_examples') {
        if (args.category !== undefined && !CATEGORIES.includes(args.category as Category) || args.verifiedOnly !== undefined && typeof args.verifiedOnly !== 'boolean' || args.mode !== undefined && !['lexical', 'semantic', 'hybrid'].includes(String(args.mode))) fail('INVALID_ARGUMENT');
        data = await examples.searchWithMode(text(args.question), args.category as Category | undefined, args.verifiedOnly !== false, (args.mode ?? 'hybrid') as RetrievalMode, signal);
      } else if (name === 'validate_query') {
        const query = queryInput(args.query); const schema = await graph.getSchema(signal);
        const checked: TicketValidation = await graph.validate(query, limits, signal);
        if (!selectedScope(query, context.selectedEntityId, schema.source === 'neo4j')) { checked.valid = false; checked.errors.push({ code: 'ENTITY_SCOPE_MISMATCH', message: errorMessages.ENTITY_SCOPE_MISMATCH }); }
        if (checked.valid) { checked.ticket = randomUUID(); tickets.set(checked.ticket, { query: structuredClone(query), binding, graphVersion: schema.version, expires: Date.now() + 120_000 }); }
        data = checked;
      } else if (name === 'execute_query') {
        const id = text(args.ticket, 200); const ticket = tickets.get(id); if (!ticket || ticket.expires <= Date.now()) fail('INVALID_TICKET');
        if (ticket!.binding !== binding) fail('TICKET_CONTEXT_MISMATCH'); tickets.delete(id);
        const schema = await graph.getSchema(signal); if (schema.version !== ticket!.graphVersion) fail('SCHEMA_CHANGED');
        if (!selectedScope(ticket!.query, context.selectedEntityId, schema.source === 'neo4j')) fail('ENTITY_SCOPE_MISMATCH');
        const checked = await graph.validate(ticket!.query, limits, signal); if (!checked.valid) fail('QUERY_VALIDATION_FAILED');
        const result = await graph.execute(ticket!.query, limits, signal); signal.throwIfAborted();
        data = save({ executionId: randomUUID(), query: structuredClone(ticket!.query), result }, schema.source, schema.version);
      } else {
        const records = getEvidence(idsInput(args.executionIds));
        const versions = new Set(records.map(x => `${x.graphSource}:${x.graphVersion}`)); if (versions.size !== 1) fail('SCHEMA_CHANGED');
        if (name === 'merge_results') data = save({ executionId: randomUUID(), result: mergedResult(records.map(x => x.evidence), limits), sourceExecutionIds: records.map(x => x.evidence.executionId) }, records[0].graphSource, records[0].graphVersion);
        else if (name === 'export_report') data = { markdown: markdownReport(text(args.question), records.map(x => x.evidence), records[0].graphSource, records[0].graphVersion) };
      }
      signal.throwIfAborted(); prune(); return { ok: true, data: structuredClone(data) as T };
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const code = context?.signal?.aborted || ['TimeoutError', 'AbortError'].includes(name) ? 'TIMEOUT' : ((error as { code?: string })?.code ?? 'TOOL_FAILED');
      const safeCode = Object.hasOwn(errorMessages, code) ? code : 'TOOL_FAILED';
      return { ok: false, error: { code: safeCode, message: errorMessages[safeCode], retryable: ['TIMEOUT', 'TOOL_FAILED'].includes(safeCode) } };
    }
  }
  return { definitions: structuredClone(TOOL_DEFINITIONS), fixtureTemplates: structuredClone(QUERY_TEMPLATES), examples, call, async close() { closed = true; tickets.clear(); evidence.clear(); await graph.close(); } };
}
