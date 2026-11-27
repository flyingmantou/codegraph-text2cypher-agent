import type { Category, Complexity, ExecutionResult, QueryRequest, QueryResponse, QuerySpec, QueryStatus } from '../../../contracts/index.ts';

export interface DevelopmentCase extends QueryRequest {
  id: string; complexity: Complexity; category: Category; expectedStatus: QueryStatus;
  expectedNodeIds?: string[]; exactNodeIds?: string[]; exactServiceIds?: string[]; exactCandidateIds?: string[];
  requiredPlanBranches?: string[]; maxModelCalls?: number;
}
export interface EvaluationSuite {
  name: string; purpose: string; requiredGraphMode: string; requiredModelMode: string; cases: DevelopmentCase[];
}
export interface CaseEvaluation {
  id: string; question: string; category: Category; complexity: Complexity; passed: boolean; assertions: string[];
  executionSuccessful: boolean; elapsedMs: number; status: string; cypher: string[]; queries: QuerySpec[]; actualResult: ExecutionResult | null;
  actualNodeIds: string[]; actualServiceIds: string[]; summary: string;
  source: QueryResponse['source'] | null; usage: QueryResponse['usage'] | null;
  semanticReview: 'pending-human-review'; transportError?: string;
}
export interface EvaluationReport {
  suite: string; purpose: string; createdAt: string; cases: CaseEvaluation[];
  totals: { total: number; passed: number; executionSuccessful: number; elapsedMs: number; modelCalls: number; promptTokens: number; completionTokens: number; estimatedCostCny: number | null; humanSemanticAccuracy: null };
}
const uniqueSorted = (items: string[]) => [...new Set(items)].sort();
const equalSet = (actual: string[], expected: string[]) => JSON.stringify(uniqueSorted(actual)) === JSON.stringify(uniqueSorted(expected));

/** Assert fixture evidence, not just HTTP success or a nonempty result. */
export function checkCase(item: DevelopmentCase, response: QueryResponse, suite: Pick<EvaluationSuite, 'requiredGraphMode' | 'requiredModelMode'>): string[] {
  const failures: string[] = [];
  if (response.status !== item.expectedStatus) failures.push(`status: expected ${item.expectedStatus}, received ${response.status}`);
  if (response.source.graph !== suite.requiredGraphMode) failures.push('graph source mismatch');
  if (response.source.model !== suite.requiredModelMode) failures.push('model mode mismatch');
  const nodeIds = response.result.graph.nodes.map(node => node.id);
  if (item.expectedNodeIds?.some(id => !nodeIds.includes(id))) failures.push('required evidence node missing');
  if (item.exactNodeIds && !equalSet(nodeIds, item.exactNodeIds)) failures.push('evidence node set mismatch');
  if (item.exactServiceIds && !equalSet(response.result.graph.nodes.filter(node => node.label === '服务').map(node => node.id), item.exactServiceIds)) failures.push('service set mismatch');
  if (item.exactCandidateIds && !equalSet(response.candidates.map(node => node.id), item.exactCandidateIds)) failures.push('clarification candidate set mismatch');
  if (item.requiredPlanBranches && !equalSet(response.plan?.branches.map(branch => branch.category) ?? [], item.requiredPlanBranches)) failures.push('decomposition branch set mismatch');
  if (item.maxModelCalls !== undefined && response.usage.modelCalls > item.maxModelCalls) failures.push('model call budget exceeded');
  if (response.status === 'success' && (!response.queries.length || !response.result.rows.length || !response.summary.trim())) failures.push('successful response lacks query/result/summary');
  return failures;
}

export async function evaluateSuite(suite: EvaluationSuite, run: (request: QueryRequest) => Promise<QueryResponse>): Promise<EvaluationReport> {
  const report: EvaluationReport = {
    suite: suite.name, purpose: suite.purpose, createdAt: new Date().toISOString(), cases: [],
    totals: { total: suite.cases.length, passed: 0, executionSuccessful: 0, elapsedMs: 0, modelCalls: 0, promptTokens: 0, completionTokens: 0, estimatedCostCny: 0, humanSemanticAccuracy: null },
  };
  for (const item of suite.cases) {
    const start = performance.now();
    let result: CaseEvaluation;
    try {
      const response = await run({ question: item.question, complexity: item.complexity, ...(item.entityId ? { entityId: item.entityId } : {}) });
      const failures = checkCase(item, response, suite);
      result = {
        id: item.id, question: item.question, category: item.category, complexity: item.complexity,
        passed: failures.length === 0, assertions: failures,
        executionSuccessful: ['success', 'empty', 'partial'].includes(response.status) && response.queries.length > 0,
        elapsedMs: Math.round(performance.now() - start), status: response.status, cypher: response.queries.map(query => query.cypher), queries: response.queries, actualResult: response.result,
        actualNodeIds: uniqueSorted(response.result.graph.nodes.map(node => node.id)),
        actualServiceIds: uniqueSorted(response.result.graph.nodes.filter(node => node.label === '服务').map(node => node.id)),
        summary: response.summary, source: response.source, usage: response.usage, semanticReview: 'pending-human-review',
      };
      report.totals.modelCalls += response.usage.modelCalls;
      report.totals.promptTokens += response.usage.promptTokens;
      report.totals.completionTokens += response.usage.completionTokens;
      report.totals.estimatedCostCny = report.totals.estimatedCostCny === null || response.usage.estimatedCostCny === null ? null : report.totals.estimatedCostCny + response.usage.estimatedCostCny;
    } catch {
      result = { id: item.id, question: item.question, category: item.category, complexity: item.complexity, passed: false, assertions: ['request failed'], executionSuccessful: false, elapsedMs: Math.round(performance.now() - start), status: 'transport_error', cypher: [], queries: [], actualResult: null, actualNodeIds: [], actualServiceIds: [], summary: '', source: null, usage: null, semanticReview: 'pending-human-review', transportError: 'REQUEST_FAILED' };
      report.totals.estimatedCostCny = null;
    }
    report.cases.push(result);
    report.totals.passed += Number(result.passed);
    report.totals.executionSuccessful += Number(result.executionSuccessful);
    report.totals.elapsedMs += result.elapsedMs;
  }
  return report;
}
