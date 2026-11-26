import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolService } from '../src/index.ts';
import { QUERY_TEMPLATES } from '../src/graph/templates.ts';
import type { Category, Limits, QueryExample, ToolServiceConfig } from '../../../contracts/index.ts';
export const limits: Limits = { maxRows: 100, maxDepth: 4, timeoutMs: 1000, maxRepairs: 0, maxModelCalls: 1 };
export const query = (category: Category = 'entity', entityId = 'method:getAllFood') => ({ cypher: QUERY_TEMPLATES[category], parameters: { name: '', entityId, limit: 100 } });
export async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'codegraph-tools-'));
  const seedPath = join(directory, 'seed.json'); const semanticLexiconPath = join(directory, 'concepts.json');
  const examples: QueryExample[] = [
    { id: 'entity', question: '查询 getAllFood 的节点', category: 'entity', complexity: 'simple', ...query(), description: '节点查询', verification: { status: 'unverified' } },
    { id: 'impact', question: '反向影响', category: 'impact', complexity: 'medium', ...query('impact', 'method:queryOrder'), description: '', verification: { status: 'unverified' } },
    { id: 'mq', question: '消息队列', category: 'mq', complexity: 'medium', ...query('mq', 'method:placeOrder'), description: '', verification: { status: 'unverified' } },
  ];
  await writeFile(seedPath, JSON.stringify(examples));
  await writeFile(semanticLexiconPath, JSON.stringify({ version: 'test', concepts: [{ id: 'impact', terms: ['反向影响', '哪些功能会受牵连'] }, { id: 'mq', terms: ['消息队列', '异步通信'] }] }));
  const config: ToolServiceConfig = { graph: { mode: 'fixture' }, dataDir: join(directory, 'runtime'), seedPath, semanticLexiconPath, limits };
  const service = await createToolService(config);
  return { service, config, directory, async cleanup() { await service.close(); await rm(directory, { recursive: true, force: true }); } };
}
