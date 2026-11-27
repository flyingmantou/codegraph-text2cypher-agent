import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Category, ExecutionResult, GraphConfig, GraphEdge, GraphNode, GraphPort, GraphSchema, Limits, QuerySpec, ValidationResult } from '../../../../contracts/index.ts';
import { templateCategory } from './templates.ts';
import { requestedLimit, validateReadQuery, validationError } from './validation.ts';

type Fixture = { version: string; notice: string; nodes: GraphNode[]; edges: GraphEdge[] };
type GraphPath = { nodes: GraphNode[]; edges: GraphEdge[] };

export async function createFixtureAdapter(config: GraphConfig): Promise<GraphPort> {
  const path = config.fixturePath ?? fileURLToPath(new URL('../../data/fixture-graph.json', import.meta.url));
  const fixture: Fixture = JSON.parse(await readFile(path, 'utf8'));
  const byId = new Map(fixture.nodes.map(n => [n.id, n]));
  if (byId.size !== fixture.nodes.length || fixture.edges.some(e => !byId.has(e.source) || !byId.has(e.target))) throw new Error('人工图结构无效');
  const nodeLabels = [...new Set(fixture.nodes.map(n => n.label))].sort();
  const relationshipTypes = [...new Set(fixture.edges.map(e => e.type))].sort();
  const patterns = new Map(fixture.edges.map(e => { const p = { from: byId.get(e.source)!.label, type: e.type, to: byId.get(e.target)!.label }; return [JSON.stringify(p), p]; }));
  const schema: GraphSchema = {
    version: fixture.version, source: 'fixture', nodeLabels, relationshipTypes,
    nodeProperties: Object.fromEntries(nodeLabels.map(label => [label, [...new Set(fixture.nodes.filter(n => n.label === label).flatMap(n => Object.keys(n.properties)))].sort()])),
    relationshipPatterns: [...patterns.values()], notes: [fixture.notice, '离线执行器只支持七类公开模板，非通用 Cypher 引擎。'],
  };
  const outgoing = (id: string, types?: string[]) => fixture.edges.filter(e => e.source === id && (!types || types.includes(e.type)));
  function validate(spec: QuerySpec, limits: Limits): ValidationResult {
    const result = validateReadQuery(spec, schema, limits);
    if (!templateCategory(spec.cypher)) result.errors.push({ code: 'UNSUPPORTED_FIXTURE_QUERY', message: '人工演示图仅支持 QUERY_TEMPLATES 中的七类模板；自由 Cypher 请使用 Neo4j 模式' });
    const category = templateCategory(spec.cypher);
    const fields = category === 'filter' ? ['keyword'] : ['name', 'entityId'];
    for (const field of fields) if (typeof spec.parameters[field] !== 'string') result.errors.push({ code: 'INVALID_PARAMETERS', message: `${field} 必须为字符串` });
    result.valid = result.errors.length === 0; return result;
  }
  return {
    async getSchema(signal?: AbortSignal) { signal?.throwIfAborted(); return structuredClone(schema); },
    async resolveEntities(term, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const q = term.trim().toLowerCase(); if (!q) return [];
      return fixture.nodes.filter(n => n.id.toLowerCase() === q || n.name.toLowerCase() === q || q.includes(n.name.toLowerCase()) || n.name.toLowerCase().includes(q)).sort((a, b) => Number(b.name.toLowerCase() === q || b.id.toLowerCase() === q) - Number(a.name.toLowerCase() === q || a.id.toLowerCase() === q)).map(n => structuredClone(n));
    },
    async validate(spec, limits, signal?: AbortSignal) { signal?.throwIfAborted(); return validate(spec, limits); },
    async execute(spec, limits, signal?: AbortSignal): Promise<ExecutionResult> {
      signal?.throwIfAborted();
      const checked = validate(spec, limits); if (!checked.valid) throw validationError(checked);
      const started = performance.now(); const cap = requestedLimit(spec, limits.maxRows);
      const category = templateCategory(spec.cypher) as Category;
      const { name, entityId, keyword } = spec.parameters;
      const selected = fixture.nodes.filter(n => n.name === name || n.id === entityId);
      const rows: Record<string, unknown>[] = [];
      const appendPath = (p: GraphPath) => { rows.push({ p: structuredClone(p) }); };
      const clock = () => { signal?.throwIfAborted(); if (performance.now() - started > limits.timeoutMs) throw Object.assign(new Error('人工图查询超时'), { code: 'QUERY_TIMEOUT' }); return rows.length > cap; };
      const walk = (start: GraphNode, types: string[], reverse = false): GraphPath[] => {
        const paths: GraphPath[] = [];
        const visit = (node: GraphNode, nodes: GraphNode[], edges: GraphEdge[]) => {
          if (clock() || paths.length > cap) return;
          if (edges.length > 0 && node.label === '方法') paths.push({ nodes: reverse ? [...nodes].reverse() : [...nodes], edges: reverse ? [...edges].reverse() : [...edges] });
          if (edges.length >= 4) return;
          const nextEdges = reverse ? fixture.edges.filter(e => e.target === node.id && types.includes(e.type)) : outgoing(node.id, types);
          for (const e of nextEdges) {
            if (edges.some(x => x.id === e.id)) continue;
            const next = byId.get(reverse ? e.source : e.target)!;
            visit(next, [...nodes, next], [...edges, e]);
          }
        };
        visit(start, [start], []); return paths;
      };
      if (category === 'entity' || category === 'filter') {
        for (const n of category === 'entity' ? selected : fixture.nodes.filter(n => n.label === '服务' && n.name.includes(String(keyword)))) { rows.push({ n: structuredClone(n) }); if (clock()) break; }
      } else if (category === 'api') {
        for (const service of selected.filter(n => n.label === '服务')) for (const belongs of fixture.edges.filter(e => e.type === '属于' && e.target === service.id)) for (const entry of fixture.edges.filter(e => e.type === '入口' && e.target === belongs.source)) {
          appendPath({ nodes: [byId.get(entry.source)!, byId.get(belongs.source)!, service], edges: [entry, belongs] }); if (clock()) break;
        }
      } else if (category === 'mq') {
        for (const start of selected.filter(n => n.label === '方法')) for (const publish of outgoing(start.id, ['发布'])) for (const route of outgoing(publish.target, ['路由'])) for (const consume of outgoing(route.target, ['消费'])) for (const belongs of outgoing(consume.target, ['属于'])) {
          appendPath({ nodes: [start, byId.get(publish.target)!, byId.get(route.target)!, byId.get(consume.target)!, byId.get(belongs.target)!], edges: [publish, route, consume, belongs] }); if (clock()) break;
        }
      } else {
        const types = category === 'combined' ? ['调用', 'RPC调用', '发布', '路由', '消费'] : ['调用', 'RPC调用'];
        for (const start of selected.filter(n => n.label === '方法')) for (const p of walk(start, types, category === 'impact')) {
          if (category === 'impact') appendPath(p);
          else for (const belongs of outgoing(p.nodes[p.nodes.length - 1].id, ['属于'])) appendPath({ nodes: [...p.nodes, byId.get(belongs.target)!], edges: [...p.edges, belongs] });
          if (clock()) break;
        }
      }
      const truncated = rows.length > cap; const limited = rows.slice(0, cap);
      const nodes = new Map<string, GraphNode>(); const edges = new Map<string, GraphEdge>();
      for (const row of limited) {
        if (row.n) { const n = row.n as GraphNode; nodes.set(n.id, n); }
        if (row.p) { const p = row.p as GraphPath; p.nodes.forEach(n => nodes.set(n.id, n)); p.edges.forEach(e => edges.set(e.id, e)); }
      }
      return { columns: category === 'entity' || category === 'filter' ? ['n'] : ['p'], rows: limited, graph: { nodes: [...nodes.values()], edges: [...edges.values()] }, truncated, durationMs: Math.round((performance.now() - started) * 100) / 100 };
    },
    async close() {},
  };
}
