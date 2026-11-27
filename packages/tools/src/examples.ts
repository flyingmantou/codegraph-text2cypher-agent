import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Category, ExampleInput, ExampleRepository, ExampleSearchResult, GraphPort, Limits, QueryExample, SemanticConcept, VerificationReport } from '../../../contracts/index.ts';

export const CATEGORIES: Category[] = ['entity', 'filter', 'api', 'downstream', 'impact', 'mq', 'combined'];
export type RetrievalMode = 'lexical' | 'semantic' | 'hybrid';
export interface RankedExample extends ExampleSearchResult { lexicalScore: number; semanticScore: number; retrievalMode: RetrievalMode; }

/** Surface words only. Semantic equivalence is represented separately by explicit domain concepts. */
export function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const tokens = normalized.match(/[a-z0-9_:-]+/g) ?? [];
  for (const chunk of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (chunk.length === 1) tokens.push(chunk);
    else for (let i = 0; i < chunk.length - 1; i++) tokens.push(chunk.slice(i, i + 2));
  }
  return tokens;
}
const cosine = (a: Map<string, number>, b: Map<string, number>): number => {
  const dot = [...a].reduce((sum, [key, value]) => sum + value * (b.get(key) ?? 0), 0);
  const norm = (v: Map<string, number>) => Math.sqrt([...v.values()].reduce((sum, x) => sum + x * x, 0));
  return dot / (norm(a) * norm(b) || 1);
};
function semanticVector(text: string, concepts: SemanticConcept[]): Map<string, number> {
  const normalized = text.toLowerCase();
  return new Map(concepts.filter(concept => concept.terms.some(term => normalized.includes(term.toLowerCase()))).map(concept => [concept.id, 1]));
}
export function rankExamples(examples: QueryExample[], query: string, concepts: SemanticConcept[], mode: RetrievalMode = 'hybrid', category?: Category): RankedExample[] {
  const items = category ? examples.filter(example => example.category === category) : examples;
  if (!query.trim()) return items.slice(0, 10).map(example => ({ example, score: 0, lexicalScore: 0, semanticScore: 0, retrievalMode: mode }));
  const texts = items.map(item => `${item.question} ${item.description}`);
  const docs = texts.map(tokenize); const df = new Map<string, number>();
  for (const tokens of docs) for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1);
  const vector = (tokens: string[]) => {
    const out = new Map<string, number>(); for (const token of tokens) out.set(token, (out.get(token) ?? 0) + 1);
    for (const [token, count] of out) out.set(token, (1 + Math.log(count)) * (1 + Math.log((items.length + 1) / ((df.get(token) ?? 0) + 1))));
    return out;
  };
  const q = vector(tokenize(query)); const semanticQ = semanticVector(query, concepts);
  return items.map((example, index) => {
    const lexicalScore = cosine(q, vector(docs[index]));
    const semanticScore = cosine(semanticQ, semanticVector(texts[index], concepts));
    const score = mode === 'lexical' ? lexicalScore : mode === 'semantic' ? semanticScore : .6 * semanticScore + .4 * lexicalScore;
    return { example, score: Number(score.toFixed(6)), lexicalScore: Number(lexicalScore.toFixed(6)), semanticScore: Number(semanticScore.toFixed(6)), retrievalMode: mode };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.example.id.localeCompare(b.example.id)).slice(0, 5);
}
export function validateExample(input: ExampleInput): void {
  if (!input || typeof input !== 'object' || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.id)) throw new Error('INVALID_EXAMPLE');
  for (const [field, maximum] of [['question', 2000], ['cypher', 12000], ['description', 4000]] as const) {
    if (typeof input[field] !== 'string' || (field !== 'description' && !input[field].trim()) || input[field].length > maximum) throw new Error('INVALID_EXAMPLE');
  }
  if (!CATEGORIES.includes(input.category) || !['simple', 'medium', 'hard'].includes(input.complexity)) throw new Error('INVALID_EXAMPLE');
  if (!input.parameters || typeof input.parameters !== 'object' || Array.isArray(input.parameters) || JSON.stringify(input.parameters).length > 16000) throw new Error('INVALID_EXAMPLE');
}
/** Abort the waiter while still observing the underlying operation; queued jobs check again before any work. */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')); };
    operation.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); }, error => { signal.removeEventListener('abort', onAbort); reject(error); });
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
}
export class ExampleStore implements ExampleRepository {
  private file: string; private seedPath: string; private lexiconPath: string; private graph: GraphPort; private limits: Limits;
  private items: QueryExample[] = []; private concepts: SemanticConcept[] = []; private queue: Promise<unknown> = Promise.resolve();
  constructor(directory: string, seedPath: string, lexiconPath: string, graph: GraphPort, limits: Limits) {
    this.file = join(directory, 'examples.json'); this.seedPath = seedPath; this.lexiconPath = lexiconPath; this.graph = graph; this.limits = limits;
  }
  async initialize(): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true, mode: 0o700 });
    let raw: string;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; raw = await readFile(this.seedPath, 'utf8'); }
    const parsed = JSON.parse(raw); if (!Array.isArray(parsed) || parsed.length > 2000) throw new Error('INVALID_EXAMPLE_STORE');
    for (const item of parsed) validateExample(item);
    if (new Set(parsed.map(item => item.id)).size !== parsed.length) throw new Error('INVALID_EXAMPLE_STORE');
    this.items = parsed.map(item => ({ ...item, verification: item.verification ?? { status: 'unverified' } }));
    const lexicon = JSON.parse(await readFile(this.lexiconPath, 'utf8'));
    if (!Array.isArray(lexicon.concepts) || lexicon.concepts.some((x: SemanticConcept) => typeof x.id !== 'string' || !Array.isArray(x.terms) || x.terms.some(term => typeof term !== 'string' || !term.trim()))) throw new Error('INVALID_SEMANTIC_LEXICON');
    this.concepts = lexicon.concepts;
  }
  async list(signal?: AbortSignal): Promise<QueryExample[]> {
    signal?.throwIfAborted(); await abortable(this.queue, signal); signal?.throwIfAborted(); return structuredClone(this.items);
  }
  async search(question: string, category?: Category, verifiedOnly = false, signal?: AbortSignal): Promise<RankedExample[]> { return this.searchWithMode(question, category, verifiedOnly, 'hybrid', signal); }
  async searchWithMode(question: string, category: Category | undefined, verifiedOnly: boolean, mode: RetrievalMode, signal?: AbortSignal): Promise<RankedExample[]> {
    signal?.throwIfAborted();
    const schema = await abortable(this.graph.getSchema(signal), signal); signal?.throwIfAborted();
    const items = (await this.list(signal)).filter(item => !verifiedOnly || item.verification.status === 'verified' && item.verification.source === schema.source && item.verification.graphVersion === schema.version);
    signal?.throwIfAborted(); return rankExamples(items, question, this.concepts, mode, category);
  }
  private mutate<T>(callback: (items: QueryExample[]) => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const work = this.queue.then(async () => {
      signal?.throwIfAborted();
      const next = structuredClone(this.items); const result = await callback(next); signal?.throwIfAborted();
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, signal });
        signal?.throwIfAborted();
        // Atomic rename is the commit point. A completed commit is not rolled back by a later cancellation.
        await rename(temporary, this.file); this.items = next; return structuredClone(result);
      } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
    });
    this.queue = work.catch(() => undefined); return abortable(work, signal);
  }
  async upsert(input: ExampleInput, signal?: AbortSignal): Promise<QueryExample> {
    signal?.throwIfAborted(); validateExample(input);
    const item: QueryExample = { id: input.id, question: input.question.trim(), category: input.category, complexity: input.complexity, cypher: input.cypher.trim(), parameters: structuredClone(input.parameters), description: input.description.trim(), verification: { status: 'unverified' } };
    return this.mutate(items => { const index = items.findIndex(x => x.id === item.id); if (index >= 0) items[index] = item; else { if (items.length >= 2000) throw new Error('EXAMPLE_LIMIT'); items.push(item); } return item; }, signal);
  }
  async delete(id: string, signal?: AbortSignal): Promise<boolean> { return this.mutate(items => { const index = items.findIndex(x => x.id === id); if (index < 0) return false; items.splice(index, 1); return true; }, signal); }
  async verify(signal?: AbortSignal): Promise<VerificationReport> {
    const operationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.limits.timeoutMs)]) : AbortSignal.timeout(this.limits.timeoutMs);
    return this.mutate(async items => {
      operationSignal.throwIfAborted();
      const schema = await abortable(this.graph.getSchema(operationSignal), operationSignal);
      const results: VerificationReport['results'] = [];
      for (const item of items) {
        operationSignal.throwIfAborted();
        try {
          const validation = await abortable(this.graph.validate(item, this.limits, operationSignal), operationSignal);
          operationSignal.throwIfAborted(); if (!validation.valid) throw new Error('VALIDATION_FAILED');
          const result = await abortable(this.graph.execute(item, this.limits, operationSignal), operationSignal);
          operationSignal.throwIfAborted(); if (!result.rows.length) throw new Error('EMPTY_RESULT');
          item.verification = { status: 'verified', source: schema.source, graphVersion: schema.version, verifiedAt: new Date().toISOString(), rowCount: result.rows.length };
          results.push({ id: item.id, status: 'verified', rowCount: result.rows.length });
        } catch {
          operationSignal.throwIfAborted();
          item.verification = { status: 'failed', source: schema.source, graphVersion: schema.version, verifiedAt: new Date().toISOString(), error: 'QUERY_VERIFICATION_FAILED' };
          results.push({ id: item.id, status: 'failed', rowCount: 0, error: 'QUERY_VERIFICATION_FAILED' });
        }
      }
      operationSignal.throwIfAborted();
      return { total: items.length, verified: results.filter(item => item.status === 'verified').length, failed: results.filter(item => item.status !== 'verified').length, graphVersion: schema.version, source: schema.source, results };
    }, operationSignal);
  }
}
