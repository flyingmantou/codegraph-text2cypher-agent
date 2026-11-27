import { randomUUID } from 'node:crypto';
import type { ExecutionEvidence, GraphNode, GraphSchema, Limits, SkillBundle, TicketValidation, ToolReply, ToolService } from '../../../contracts/index.ts';

/** Structural subset of the documented DSH host API; it also permits isolated contract tests. */
export interface DshExecution {
  name: string; arguments: unknown; agent?: object; signal: AbortSignal;
}
export interface DshToolDefinition {
  name: string; description: string; parameters: Record<string, unknown>;
  output: { schema: Record<string, unknown>; render(args: unknown, value: unknown): { type: 'text'; text: string }[] };
  execute(args: unknown, exec: DshExecution): Promise<unknown>;
}
export interface DshDenial { reason: string; info: { name: string; code: string }; }
export interface DshHost {
  tools: {
    register(definition: DshToolDefinition): () => void;
    guard(check: (exec: DshExecution) => DshDenial | undefined): () => void;
  };
  skills: { register(skill: { name: string; description: string; source: string; content: string; invocation: { modelInvocable: boolean; userInvocable: boolean } }): () => void };
  on(event: 'tools/execute', callback: (exec: DshExecution, next: () => Promise<unknown>) => Promise<unknown>): () => void;
  on(event: 'session/event', callback: (session: object, event: { type: string }) => void): () => void;
  on(event: 'dispose', callback: () => Promise<void> | void): () => void;
}

interface State {
  sessionId: string; startedAt: number; question: string; calls: number; schemaReady: boolean;
  selectedEntityId?: string; confirmedEntity: boolean; ambiguous: boolean; emptyEntity: boolean; candidates: GraphNode[];
  tickets: Set<string>; evidenceIds: Set<string>; schemaVersion?: string;
}
const PREFIX = 'codegraph_';
const DOMAIN_TOOLS = ['get_schema', 'resolve_entities', 'search_examples', 'validate_query', 'execute_query', 'merge_results', 'export_report'] as const;
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const denial = (code: string, message: string): DshDenial => ({ reason: `${code}: ${message}`, info: { name: 'CodegraphPolicyError', code } });

/** DSH accepts a narrower schema vocabulary than MCP; Tools.call still enforces acquisition bounds. */
export function toDshSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const supported = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples']);
  const bounds = new Set(['minLength', 'maxLength', 'minItems', 'maxItems']);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (bounds.has(key)) continue;
    if (!supported.has(key)) throw new Error('UNSUPPORTED_DSH_SCHEMA_KEY');
    if (key === 'properties') result[key] = Object.fromEntries(Object.entries(object(value) ?? {}).map(([name, node]) => [name, toDshSchema(object(node) ?? {})]));
    else if (key === 'items') result[key] = toDshSchema(object(value) ?? {});
    else if (key === 'oneOf') result[key] = (value as unknown[]).map(node => toDshSchema(object(node) ?? {}));
    else result[key] = structuredClone(value);
  }
  if (!result.type && (Array.isArray(result.enum) || 'const' in result)) {
    const values = Array.isArray(result.enum) ? result.enum : [result.const];
    const types = new Set(values.map(value => value === null ? 'null' : typeof value));
    if (types.size !== 1 || !['string', 'number', 'boolean', 'null'].includes([...types][0])) throw new Error('UNSUPPORTED_DSH_ENUM');
    result.type = [...types][0];
  }
  const notes = [...bounds].filter(key => schema[key] !== undefined).map(key => `${key}=${schema[key]}`);
  if (notes.length) result.description = [result.description, `由领域工具强制限制：${notes.join(', ')}`].filter(Boolean).join(' ');
  return result;
}

/** Installs project tools, Skill and execution policy. The caller retains ToolService ownership. */
export function registerProjectPlugin(ctx: DshHost, options: { tools: ToolService; skill: SkillBundle; limits: Limits }) {
  const { tools, skill } = options;
  const limits = { ...options.limits, maxToolCalls: options.limits.maxToolCalls ?? 24 };
  if (!Number.isInteger(limits.maxToolCalls) || limits.maxToolCalls < 1 || !Number.isFinite(limits.timeoutMs) || limits.timeoutMs < 1) throw new Error('INVALID_DSH_LIMITS');
  const definitions = DOMAIN_TOOLS.map(name => tools.definitions.find(def => def.name === name));
  if (definitions.some(def => !def)) throw new Error('INCOMPLETE_TOOL_SERVICE');
  // Reject unsupported host schemas before creating any registrations.
  const hostSchemas = new Map(definitions.map(def => [def!.name, toDshSchema(def!.inputSchema)]));
  const states = new WeakMap<object, State>();
  const sessionOwners = new WeakMap<object, Set<object>>();
  const disposers: (() => void)[] = [];
  let disposed = false;
  const stateFor = (agent: object): State => {
    const session = object(agent)?.session;
    if (session && typeof session === 'object') {
      let owners = sessionOwners.get(session);
      if (!owners) { owners = new Set(); sessionOwners.set(session, owners); }
      owners.add(agent);
    }
    let state = states.get(agent);
    if (!state) {
      state = { sessionId: randomUUID(), startedAt: performance.now(), question: '', calls: 0, schemaReady: false, confirmedEntity: false, ambiguous: false, emptyEntity: false, candidates: [], tickets: new Set(), evidenceIds: new Set() };
      states.set(agent, state);
    }
    return state;
  };
  const isOwn = (exec: DshExecution) => DOMAIN_TOOLS.some(name => exec.name === PREFIX + name);
  const check = (exec: DshExecution): DshDenial | undefined => {
    if (!isOwn(exec)) return undefined;
    if (disposed) return denial('PLUGIN_DISPOSED', '项目插件已卸载。');
    if (!exec.agent) return denial('AGENT_REQUIRED', '工具必须在具有独立状态的 Agent 中调用。');
    const state = stateFor(exec.agent);
    if (state.calls >= limits.maxToolCalls) return denial('TOOL_BUDGET_EXHAUSTED', '已达到本任务工具调用上限；由可信宿主开始新任务。');
    if (performance.now() - state.startedAt >= limits.timeoutMs) return denial('TASK_TIMEOUT', '本任务已经超时。');
    const name = exec.name.slice(PREFIX.length);
    if (name !== 'get_schema' && !state.schemaReady) return denial('SCHEMA_REQUIRED', '先读取当前图谱 Schema。');
    if (['validate_query', 'execute_query'].includes(name)) {
      if (state.ambiguous) return denial('ENTITY_CONFIRMATION_REQUIRED', '存在同名候选；等待可信界面确认，模型不能自行选择。');
      if (state.emptyEntity) return denial('ENTITY_NOT_FOUND', '本次实体检索没有匹配项，不能继续执行。');
    }
    const args = object(exec.arguments);
    if (name === 'execute_query' && (typeof args?.ticket !== 'string' || !state.tickets.has(args.ticket))) return denial('VALIDATION_TICKET_REQUIRED', '只能使用本任务已签发的校验票据。');
    if (['merge_results', 'export_report'].includes(name)) {
      const ids = args?.executionIds;
      if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !state.evidenceIds.has(id))) return denial('EXECUTION_EVIDENCE_REQUIRED', '只能引用本任务真实执行产生的证据。');
    }
  };
  const remember = (name: string, data: unknown, state: State) => {
    if (name === 'get_schema') {
      const schema = data as GraphSchema;
      if (typeof schema?.version !== 'string' || !Array.isArray(schema.nodeLabels)) throw new Error('INVALID_TOOL_RESULT: Schema 响应无效。');
      if (state.schemaVersion && state.schemaVersion !== schema.version) { state.tickets.clear(); state.evidenceIds.clear(); }
      state.schemaVersion = schema.version; state.schemaReady = true;
    }
    if (name === 'resolve_entities') {
      if (!Array.isArray(data) || data.some(node => !object(node) || typeof node.id !== 'string')) throw new Error('INVALID_TOOL_RESULT: 实体响应无效。');
      // Once ambiguity is observed, another model-controlled lookup cannot clear it.
      if (!state.ambiguous && !state.confirmedEntity) {
        state.candidates = structuredClone(data as GraphNode[]);
        state.ambiguous = data.length > 1; state.emptyEntity = data.length === 0;
        const selected = data.length === 1 ? data[0].id as string : undefined;
        if (selected !== state.selectedEntityId) state.tickets.clear();
        state.selectedEntityId = selected;
      }
    }
    if (name === 'validate_query') {
      const validation = data as TicketValidation;
      if (validation?.valid && typeof validation.ticket === 'string') state.tickets.add(validation.ticket);
    }
    if (name === 'execute_query' || name === 'merge_results') {
      const evidence = data as ExecutionEvidence;
      if (typeof evidence?.executionId !== 'string' || !Array.isArray(evidence.result?.rows)) throw new Error('INVALID_TOOL_RESULT: 执行证据响应无效。');
      state.evidenceIds.add(evidence.executionId);
    }
  };
  disposers.push(ctx.tools.guard(check));
  disposers.push(ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/start') return;
    for (const agent of sessionOwners.get(session) ?? []) {
      const previous = states.get(agent);
      states.delete(agent);
      const state = stateFor(agent);
      // A new host turn renews resource budgets, but never pretends a human selected an entity.
      if (previous?.ambiguous) { state.ambiguous = true; state.candidates = previous.candidates; }
    }
  }));
  disposers.push(ctx.on('tools/execute', async (exec, next) => {
    if (!isOwn(exec)) return next();
    const rejected = check(exec);
    if (rejected) throw new Error(rejected.reason);
    const state = stateFor(exec.agent!);
    const original = exec.signal;
    const remaining = Math.max(1, Math.ceil(limits.timeoutMs - (performance.now() - state.startedAt)));
    exec.signal = AbortSignal.any([original, AbortSignal.timeout(remaining)]);
    try { return await next(); } finally { exec.signal = original; }
  }));
  disposers.push(ctx.skills.register({
    name: 'codegraph-text2cypher', description: '使用实际 Schema、已验证示例和受控工具完成代码图谱查询，保留可核对的执行证据。',
    source: 'runtime', invocation: { modelInvocable: true, userInvocable: true },
    content: `${skill.instructions}\n\n## dsh 工具名称\n本宿主中所有领域工具名使用 codegraph_ 前缀：${DOMAIN_TOOLS.map(name => PREFIX + name).join('、')}。\n校验成功后只能传返回的 ticket 执行。合并和报告只能引用本任务 executionId。多个候选必须等待可信界面确认，不能用另一次精确实体检索绕过。\nSkill 版本：${skill.version}`,
  }));
  for (const definition of definitions) {
    const def = definition!;
    disposers.push(ctx.tools.register({
      name: PREFIX + def.name, description: def.description, parameters: hostSchemas.get(def.name)!,
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        const rejected = check({ ...exec, name: PREFIX + def.name, arguments: args });
        if (rejected) throw new Error(rejected.reason);
        const parameters = object(args);
        if (!parameters) throw new Error('INVALID_TOOL_ARGUMENTS: 参数须为 JSON 对象。');
        const state = stateFor(exec.agent!);
        state.calls++;
        const reply: ToolReply = await tools.call(def.name, parameters, { sessionId: state.sessionId, limits, signal: exec.signal, selectedEntityId: state.selectedEntityId });
        exec.signal.throwIfAborted();
        if (!reply.ok) throw new Error(`${reply.error?.code ?? 'TOOL_FAILED'}: ${reply.error?.message ?? '工具执行失败。'}`);
        remember(def.name, reply.data, state);
        return reply.data ?? null;
      },
    }));
  }
  return {
    /** Trusted host boundary; never expose this as a model-callable tool. */
    beginTask(agent: object, question = '') {
      if (disposed) throw new Error('PLUGIN_DISPOSED');
      states.delete(agent); const state = stateFor(agent); state.question = question; return state.sessionId;
    },
    /** Called by a trusted UI only after the human chooses a returned candidate. */
    confirmEntity(agent: object, entityId: string) {
      if (disposed) throw new Error('PLUGIN_DISPOSED');
      const state = states.get(agent);
      if (!state?.ambiguous || !state.candidates.some(node => node.id === entityId)) throw new Error('INVALID_ENTITY_CONFIRMATION');
      state.selectedEntityId = entityId; state.confirmedEntity = true; state.ambiguous = false; state.emptyEntity = false; state.tickets.clear();
      // Human waiting time does not consume the resumed execution deadline; call budget stays unchanged.
      state.startedAt = performance.now();
    },
    snapshot(agent: object) {
      const state = states.get(agent);
      return state ? { sessionId: state.sessionId, calls: state.calls, schemaReady: state.schemaReady, selectedEntityId: state.selectedEntityId, needsClarification: state.ambiguous, candidates: structuredClone(state.candidates), evidenceIds: [...state.evidenceIds] } : null;
    },
    dispose() { if (disposed) return; disposed = true; for (const dispose of disposers.reverse()) dispose(); },
  };
}
