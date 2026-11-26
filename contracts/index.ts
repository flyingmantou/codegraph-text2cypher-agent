/** Public contracts v1. Change these before changing module boundaries. */
export const CONTRACT_VERSION = '2.0.0';
export type GraphMode = 'fixture' | 'neo4j';
export type ModelMode = 'demo' | 'deepseek' | 'glm';
export type Category = 'entity' | 'filter' | 'api' | 'downstream' | 'impact' | 'mq' | 'combined';
export type Complexity = 'simple' | 'medium' | 'hard';
export interface GraphNode { id: string; label: string; name: string; properties: Record<string, unknown>; }
export interface GraphEdge { id: string; source: string; target: string; type: string; properties?: Record<string, unknown>; }
export interface Subgraph { nodes: GraphNode[]; edges: GraphEdge[]; }
export interface GraphSchema {
  version: string; source: GraphMode; nodeLabels: string[]; relationshipTypes: string[];
  nodeProperties: Record<string, string[]>;
  relationshipPatterns: { from: string; type: string; to: string }[];
  notes?: string[];
}
export interface QuerySpec { cypher: string; parameters: Record<string, unknown>; label?: string; }
export interface Limits { maxRows: number; maxDepth: number; timeoutMs: number; maxRepairs: number; maxModelCalls: number; maxToolCalls?: number; }
export interface ValidationResult { valid: boolean; errors: { code: string; message: string }[]; warnings: string[]; }
export interface ExecutionResult { columns: string[]; rows: Record<string, unknown>[]; graph: Subgraph; truncated: boolean; durationMs: number; }
export interface GraphPort {
  getSchema(signal?: AbortSignal): Promise<GraphSchema>;
  resolveEntities(term: string, signal?: AbortSignal): Promise<GraphNode[]>;
  validate(spec: QuerySpec, limits: Limits, signal?: AbortSignal): Promise<ValidationResult>;
  execute(spec: QuerySpec, limits: Limits, signal?: AbortSignal): Promise<ExecutionResult>;
  close(): Promise<void>;
}
export interface GraphConfig {
  mode: GraphMode; uri?: string; user?: string; password?: string; database?: string;
  fixturePath?: string; graphVersion?: string;
}
export interface QueryRequest { question: string; entityId?: string; complexity?: Complexity; }
export type QueryStatus = 'success' | 'empty' | 'needs_clarification' | 'rejected' | 'failed' | 'partial';
export interface TraceStep { stage: string; status: 'ok' | 'error' | 'skipped'; message: string; durationMs: number; }
export interface Usage { modelCalls: number; toolCalls?: number; promptTokens: number; completionTokens: number; estimatedCostCny: number | null; }
export interface QueryResponse {
  id: string; question: string; status: QueryStatus; summary: string; createdAt: string;
  source: { graph: GraphMode; model: ModelMode; graphVersion: string; modelName: string; skillVersion?: string; runtime?: string };
  queries: QuerySpec[]; result: ExecutionResult; trace: TraceStep[]; usage: Usage;
  examplesUsed: string[]; candidates: GraphNode[]; warnings: string[];
  plan?: TaskPlan; evidenceIds?: string[]; reportMarkdown?: string;
  error?: { code: string; message: string };
}
export interface QueryExample {
  id: string; question: string; category: Category; complexity: Complexity;
  cypher: string; parameters: Record<string, unknown>; description: string;
  verification: { status: 'unverified' | 'verified' | 'failed'; graphVersion?: string; source?: GraphMode; verifiedAt?: string; rowCount?: number; error?: string };
}
export type ExampleInput = Omit<QueryExample, 'verification'>;
export interface ExampleSearchResult { example: QueryExample; score: number; }
export interface VerificationReport { total: number; verified: number; failed: number; graphVersion: string; source: GraphMode; results: { id: string; status: string; rowCount: number; error?: string }[]; }
export interface AgentConfig {
  graphMode: GraphMode; modelMode: ModelMode; modelName: string; apiKey?: string; apiBaseUrl?: string;
  inputPriceCnyPerMillion?: number; outputPriceCnyPerMillion?: number;
}
export interface AgentPort {
  run(request: QueryRequest, signal?: AbortSignal): Promise<QueryResponse>;
  listExamples(): Promise<QueryExample[]>;
  searchExamples(query: string, category?: Category): Promise<ExampleSearchResult[]>;
  upsertExample(input: ExampleInput): Promise<QueryExample>;
  deleteExample(id: string): Promise<boolean>;
  verifyExamples(): Promise<VerificationReport>;
}


/** Contract frozen before this modular implementation; additive changes require integration review. */
export interface TaskBranch { id: string; category: Exclude<Category, 'combined'>; purpose: string; }
export interface TaskPlan { category: Category; entityTerm: string; branches: TaskBranch[]; }
export interface SkillBundle {
  id: string; version: string; instructions: string;
  stages: string[];
  planDemo(question: string): TaskPlan;
  seedPath: string; semanticLexiconPath: string;
}
export interface SemanticConcept { id: string; terms: string[]; }
export interface ToolDefinition { name: string; description: string; inputSchema: Record<string, unknown>; }
export interface ToolContext { sessionId: string; limits: Limits; signal?: AbortSignal; selectedEntityId?: string; }
export interface ToolReply<T = unknown> { ok: boolean; data?: T; error?: { code: string; message: string; retryable?: boolean }; }
export interface ExecutionEvidence { executionId: string; query?: QuerySpec; result: ExecutionResult; sourceExecutionIds?: string[]; }
export interface TicketValidation extends ValidationResult { ticket?: string; }
export interface ExampleRepository {
 list(signal?: AbortSignal): Promise<QueryExample[]>;
 search(question: string, category?: Category, verifiedOnly?: boolean, signal?: AbortSignal): Promise<ExampleSearchResult[]>;
 upsert(input: ExampleInput, signal?: AbortSignal): Promise<QueryExample>;
 delete(id: string, signal?: AbortSignal): Promise<boolean>;
 verify(signal?: AbortSignal): Promise<VerificationReport>;
}
export interface ToolService {
 definitions: ToolDefinition[];
 fixtureTemplates: Record<Category, string>;
 examples: ExampleRepository;
 call<T = unknown>(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolReply<T>>;
 close(): Promise<void>;
}
export interface ToolServiceConfig {
 graph: GraphConfig; dataDir: string; seedPath: string; semanticLexiconPath: string; limits: Limits;
}
