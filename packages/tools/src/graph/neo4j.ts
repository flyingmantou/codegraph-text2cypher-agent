import { createHash } from 'node:crypto';
import type { ExecutionResult, GraphConfig, GraphEdge, GraphNode, GraphPort, GraphSchema, Limits, QuerySpec, ValidationResult } from '../../../../contracts/index.ts';
import { requestedLimit, validateReadQuery, validationError } from './validation.ts';

/** Driver objects remain at this boundary. Optional installation keeps offline demos dependency-free. */
type DriverRecord = { keys: string[]; get(key: string): any };
type DriverResult = { records: DriverRecord[]; summary?: { queryType?: string } };
type DriverSession = { executeRead<T>(work: (transaction: { run(query: string, parameters: Record<string, unknown>): Promise<DriverResult> }) => Promise<T>, config: { timeout: number }): Promise<T>; close(): Promise<void> };

export async function createNeo4jAdapter(config: GraphConfig): Promise<GraphPort> {
  if (!config.uri || !config.user || !config.password) throw Object.assign(new Error('Neo4j 模式需要 NEO4J_URI、NEO4J_USER 和 NEO4J_PASSWORD'), { code: 'MISSING_NEO4J_CONFIG' });
  if (!/^(neo4j|bolt)(\+s|\+ssc)?:\/\//.test(config.uri)) throw new Error('Neo4j URI 必须使用 neo4j:// 或 bolt:// 协议');
  let neo4j: any;
  try { const packageName = 'neo4j-driver'; const module = await import(packageName); neo4j = module.default ?? module; }
  catch { throw Object.assign(new Error('未安装官方驱动。请在项目根目录运行 npm install neo4j-driver@6，然后重启。'), { code: 'MISSING_NEO4J_DRIVER' }); }
  const driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password), { connectionTimeout: 5000, connectionAcquisitionTimeout: 5000, maxTransactionRetryTime: 0, maxConnectionPoolSize: 5 });
  let schema: GraphSchema | undefined;
  const driverValue = (value: any): any => {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return neo4j.int(value);
    if (Array.isArray(value)) return value.map(driverValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, driverValue(item)]));
    return value;
  };
  const run = async (cypher: string, parameters: Record<string, unknown> = {}, timeout = 5000, signal?: AbortSignal): Promise<DriverResult> => {
    signal?.throwIfAborted();
    const session: DriverSession = driver.session({ database: config.database ?? 'neo4j', defaultAccessMode: neo4j.session.READ });
    const onAbort = () => { void session.close().catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try { const result = await session.executeRead(tx => tx.run(cypher, driverValue(parameters)), { timeout }); signal?.throwIfAborted(); return result; }
    catch (error) { signal?.throwIfAborted(); throw new Error(safeDatabaseError(error, [config.uri!, config.password!])); }
    finally { signal?.removeEventListener('abort', onAbort); await session.close(); }
  };
  const scalar = (value: any): any => {
    if (value == null) return value;
    if (neo4j.isInt(value)) return value.inSafeRange() ? value.toNumber() : value.toString();
    if (Array.isArray(value)) return value.map(scalar);
    if (typeof value === 'object') {
      if (value.constructor?.name && !['Object'].includes(value.constructor.name) && typeof value.toString === 'function') return value.toString();
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scalar(v)]));
    }
    return value;
  };
  const toNode = (value: any): GraphNode => {
    const properties = Object.fromEntries(Object.entries(value.properties ?? {}).map(([k, v]) => [k, scalar(v)]));
    const id = String(value.elementId ?? value.identity?.toString());
    const name = String(properties['名称'] ?? properties.name ?? properties.methodName ?? properties.fullName ?? properties['标识'] ?? id);
    return { id, label: value.labels?.[0] ?? '节点', name, properties };
  };
  const toEdge = (value: any): GraphEdge => ({ id: String(value.elementId ?? value.identity?.toString()), source: String(value.startNodeElementId ?? value.start?.toString()), target: String(value.endNodeElementId ?? value.end?.toString()), type: value.type, properties: scalar(value.properties ?? {}) });
  const normalize = (result: DriverResult, cap: number, durationMs: number): ExecutionResult => {
    const nodes = new Map<string, GraphNode>(); const edges = new Map<string, GraphEdge>();
    const transform = (value: any, depth = 0): any => {
      if (depth > 15) return '[nested value omitted]';
      if (value == null || typeof value !== 'object') return value;
      if (neo4j.isInt(value)) return scalar(value);
      if (Array.isArray(value.labels) && value.properties) { const n = toNode(value); nodes.set(n.id, n); return n; }
      if (typeof value.type === 'string' && value.properties && (value.startNodeElementId != null || value.start != null)) { const e = toEdge(value); edges.set(e.id, e); return e; }
      if (Array.isArray(value.segments)) {
        const pathNodes = new Map<string, GraphNode>(); const pathEdges = new Map<string, GraphEdge>();
        for (const item of [value.start, value.end]) if (item) { const n = transform(item, depth + 1); pathNodes.set(n.id, n); }
        for (const segment of value.segments) { for (const item of [segment.start, segment.end]) { const n = transform(item, depth + 1); pathNodes.set(n.id, n); } const e = transform(segment.relationship, depth + 1); pathEdges.set(e.id, e); }
        return { nodes: [...pathNodes.values()], edges: [...pathEdges.values()] };
      }
      if (Array.isArray(value)) return value.map(v => transform(v, depth + 1));
      if (value.constructor?.name !== 'Object' && value.constructor?.name) return scalar(value);
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, transform(v, depth + 1)]));
    };
    const limited = result.records.slice(0, cap);
    const rows = limited.map(record => Object.fromEntries(record.keys.map(key => [key, transform(record.get(key))])));
    return { columns: result.records[0]?.keys ?? [], rows, graph: { nodes: [...nodes.values()], edges: [...edges.values()] }, truncated: result.records.length > cap, durationMs };
  };
  const getSchema = async (signal?: AbortSignal): Promise<GraphSchema> => {
    signal?.throwIfAborted();
    if (schema) return structuredClone(schema);
    const labels = await run('CALL db.labels() YIELD label RETURN label', {}, 5000, signal);
    const relations = await run('CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType', {}, 5000, signal);
    const props = await run('MATCH (n) UNWIND labels(n) AS label UNWIND keys(n) AS property RETURN DISTINCT label, property LIMIT 5000', {}, 5000, signal);
    const patterns = await run('MATCH (a)-[r]->(b) RETURN DISTINCT labels(a) AS sourceLabels, type(r) AS type, labels(b) AS targetLabels LIMIT 1000', {}, 5000, signal);
    const nodeLabels = labels.records.map(r => String(r.get('label'))).sort();
    const relationshipTypes = relations.records.map(r => String(r.get('relationshipType'))).sort();
    const nodeProperties: Record<string, string[]> = Object.fromEntries(nodeLabels.map(label => [label, []]));
    for (const record of props.records) { const label = String(record.get('label')); (nodeProperties[label] ??= []).push(String(record.get('property'))); }
    Object.values(nodeProperties).forEach(list => list.sort());
    const relationshipPatterns: GraphSchema['relationshipPatterns'] = [];
    for (const record of patterns.records) for (const from of record.get('sourceLabels')) for (const to of record.get('targetLabels')) relationshipPatterns.push({ from, type: String(record.get('type')), to });
    const fingerprint = createHash('sha256').update(JSON.stringify({ nodeLabels, relationshipTypes, nodeProperties })).digest('hex').slice(0, 12);
    schema = { source: 'neo4j', version: config.graphVersion ?? `neo4j-schema-${fingerprint}`, nodeLabels, relationshipTypes, nodeProperties, relationshipPatterns, notes: ['真实数据库连接。必须使用数据库层的只读账号；READ 路由不能替代权限控制。', ...(config.graphVersion ? [] : ['未设置 GRAPH_VERSION；当前版本号只标识 Schema 指纹，不代表数据快照。验收前请设置课程图谱版本。']), ...(props.records.length >= 5000 || patterns.records.length >= 1000 ? ['Schema 采样达到上限，可能存在未列出的属性或关系模式。'] : [])] };
    return structuredClone(schema);
  };
  const validate = async (spec: QuerySpec, limits: Limits, signal?: AbortSignal): Promise<ValidationResult> => {
    signal?.throwIfAborted();
    const result = validateReadQuery(spec, await getSchema(signal), limits); if (!result.valid) return result;
    try {
      const explain = await run(`EXPLAIN ${spec.cypher}`, spec.parameters, limits.timeoutMs, signal);
      if (explain.summary?.queryType && explain.summary.queryType !== 'r') result.errors.push({ code: 'READ_ONLY', message: 'Neo4j 查询计划不是只读类型' });
    } catch (error) { signal?.throwIfAborted(); result.errors.push({ code: 'CYPHER_EXPLAIN_FAILED', message: `Neo4j EXPLAIN 未通过：${safeDatabaseError(error)}` }); }
    result.valid = result.errors.length === 0; return result;
  };
  return {
    getSchema,
    async resolveEntities(term, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (!term.trim()) return [];
      const result = await run('MATCH (n) WHERE elementId(n) = $entityId OR any(k IN $nameKeys WHERE n[k] IS NOT NULL AND (toLower(toString(n[k])) = $term OR toLower(toString(n[k])) CONTAINS $term OR $term CONTAINS toLower(toString(n[k])))) RETURN n ORDER BY CASE WHEN elementId(n) = $entityId OR any(k IN $nameKeys WHERE n[k] IS NOT NULL AND toLower(toString(n[k])) = $term) THEN 0 ELSE 1 END LIMIT 30', { entityId: term.trim().slice(0, 2000), term: term.trim().toLowerCase().slice(0, 2000), nameKeys: ['名称', '标识', 'name', 'methodName', 'fullName', 'qualifiedName'] }, 5000, signal);
      return result.records.map(record => toNode(record.get('n')));
    },
    validate,
    async execute(spec, limits, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const checked = await validate(spec, limits, signal); if (!checked.valid) throw validationError(checked);
      const cap = requestedLimit(spec, limits.maxRows); const start = performance.now();
      const cypher = spec.cypher.replace(/\bLIMIT\s+(\$[A-Za-z_][A-Za-z_0-9]*|\d+)\s*$/i, 'LIMIT $__cg_fetchLimit');
      try { return normalize(await run(cypher, { ...spec.parameters, __cg_fetchLimit: cap + 1 }, limits.timeoutMs, signal), cap, Math.round(performance.now() - start)); }
      catch (error) { signal?.throwIfAborted(); throw Object.assign(new Error(safeDatabaseError(error)), { code: /timeout|timed out|terminated/i.test(String(error)) ? 'QUERY_TIMEOUT' : 'NEO4J_EXECUTION_FAILED' }); }
    },
    async close() { await driver.close(); },
  };
}

function safeDatabaseError(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error ? error.message : '数据库请求失败';
  for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]');
  return message.replace(/(?:bolt|neo4j)(?:\+s|\+ssc)?:\/\/\S+/gi, '[database]').replace(/(?:password|authorization)\s*[:=]\s*\S+/gi, '[redacted]').slice(0, 500);
}
