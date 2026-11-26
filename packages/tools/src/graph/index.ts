import type { GraphConfig, GraphPort } from '../../../../contracts/index.ts';
import { createFixtureAdapter } from './fixture.ts';
import { createNeo4jAdapter } from './neo4j.ts';

export async function createGraphAdapter(config: GraphConfig): Promise<GraphPort> {
  if (config.mode === 'fixture') return createFixtureAdapter(config);
  if (config.mode === 'neo4j') return createNeo4jAdapter(config);
  throw new Error('GRAPH_MODE 必须为 fixture 或 neo4j');
}
