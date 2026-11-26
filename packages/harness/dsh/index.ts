import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createToolService } from '../../tools/src/index.ts';
import { loadSkillBundle } from '../../skills/src/index.ts';
import { registerProjectPlugin, type DshHost } from './plugin.ts';
import type { GraphMode, Limits } from '../../../contracts/index.ts';

export const name = 'codegraph-project-runtime';
export const inject = ['tools', 'skills'];
export interface Config { graphMode?: GraphMode; dataDir?: string; timeoutMs?: number; maxToolCalls?: number; }
/** DSH source-overlay entrypoint. The structural API is verified by contract tests, not a host load. */
export async function apply(ctx: DshHost, config: Config = {}): Promise<void> {
  const graphMode = config.graphMode ?? process.env.GRAPH_MODE ?? 'fixture';
  if (!['fixture', 'neo4j'].includes(graphMode)) throw new Error('INVALID_GRAPH_MODE');
  const limits: Limits = { maxRows: 100, maxDepth: 4, timeoutMs: config.timeoutMs ?? 60000, maxToolCalls: config.maxToolCalls ?? 24, maxModelCalls: 12, maxRepairs: 2 };
  const skill = await loadSkillBundle();
  const tools = await createToolService({
    graph: { mode: graphMode as GraphMode, uri: process.env.NEO4J_URI, user: process.env.NEO4J_USER, password: process.env.NEO4J_PASSWORD, database: process.env.NEO4J_DATABASE ?? 'neo4j', graphVersion: process.env.GRAPH_VERSION },
    dataDir: config.dataDir ? resolve(config.dataDir) : fileURLToPath(new URL('../../../.runtime/dsh/', import.meta.url)),
    seedPath: skill.seedPath, semanticLexiconPath: skill.semanticLexiconPath, limits,
  });
  try {
    if (graphMode === 'fixture') await tools.examples.verify();
    const controller = registerProjectPlugin(ctx, { tools, skill, limits });
    ctx.on('dispose', async () => { controller.dispose(); await tools.close(); });
  } catch (error) { await tools.close(); throw error; }
}

export { registerProjectPlugin } from './plugin.ts';
export type { DshHost, DshExecution, DshDenial, DshToolDefinition } from './plugin.ts';
export type ProjectPluginController = ReturnType<typeof registerProjectPlugin>;
