import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentConfig, GraphConfig, Limits } from '../../../contracts/index.ts';

export interface AppConfig { host: string; port: number; dataDir: string; graph: GraphConfig; agent: AgentConfig; limits: Limits; }
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
function integer(env: Record<string, string | undefined>, key: string, fallback: number, min: number, max: number): number {
  const n = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be an integer in [${min}, ${max}]`);
  return n;
}
function price(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('Model prices must be non-negative numbers');
  return n;
}
export function readConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const graphMode = env.GRAPH_MODE ?? 'fixture';
  const modelMode = env.MODEL_MODE ?? 'demo';
  if (!['fixture', 'neo4j'].includes(graphMode)) throw new Error('GRAPH_MODE must be fixture or neo4j');
  if (!['demo', 'deepseek', 'glm'].includes(modelMode)) throw new Error('MODEL_MODE must be demo, deepseek or glm');
  const host = env.HOST ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !(host === '0.0.0.0' && env.ALLOW_CONTAINER_BIND === '1')) throw new Error('Only a loopback HOST is supported unless ALLOW_CONTAINER_BIND=1 and HOST=0.0.0.0');
  const apiKey = modelMode === 'glm' ? env.GLM_API_KEY : modelMode === 'deepseek' ? env.DEEPSEEK_API_KEY : undefined;
  if (modelMode !== 'demo' && !apiKey?.trim()) throw new Error(`${modelMode === 'glm' ? 'GLM' : 'DEEPSEEK'}_API_KEY is required`);
  if (graphMode === 'neo4j' && (!env.NEO4J_URI || !env.NEO4J_USER || !env.NEO4J_PASSWORD)) throw new Error('Neo4j mode requires NEO4J_URI, NEO4J_USER and NEO4J_PASSWORD');
  return {
    host, port: integer(env, 'PORT', 3000, 0, 65535), dataDir: resolve(projectRoot, env.DATA_DIR ?? '.runtime'),
    graph: { mode: graphMode as GraphConfig['mode'], uri: env.NEO4J_URI, user: env.NEO4J_USER, password: env.NEO4J_PASSWORD, database: env.NEO4J_DATABASE ?? 'neo4j', graphVersion: env.GRAPH_VERSION },
    agent: { graphMode: graphMode as GraphConfig['mode'], modelMode: modelMode as AgentConfig['modelMode'],
      modelName: modelMode === 'demo' ? 'demo-rules-v2' : modelMode === 'glm' ? (env.GLM_MODEL ?? 'glm-5.3') : (env.DEEPSEEK_MODEL ?? 'deepseek-flash'),
      apiKey, apiBaseUrl: modelMode === 'glm' ? (env.GLM_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4') : (env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'),
      inputPriceCnyPerMillion: price(env.INPUT_PRICE_CNY_PER_MILLION), outputPriceCnyPerMillion: price(env.OUTPUT_PRICE_CNY_PER_MILLION) },
    limits: { maxRows: integer(env, 'MAX_ROWS', 100, 1, 500), maxDepth: integer(env, 'MAX_DEPTH', 4, 1, 6),
      timeoutMs: integer(env, 'TIMEOUT_MS', modelMode === 'demo' ? 15000 : 60000, 100, 120000),
      maxRepairs: integer(env, 'MAX_REPAIRS', 1, 0, 2), maxModelCalls: integer(env, 'MAX_MODEL_CALLS', 6, 1, 12),
      maxToolCalls: integer(env, 'MAX_TOOL_CALLS', 40, 1, 100) }
  };
}
