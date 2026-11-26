import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Category, SkillBundle, TaskPlan } from '../../../contracts/index.ts';

export const STAGES = ['schema', 'plan', 'entities', 'examples', 'generate', 'validate', 'execute', 'merge', 'report'] as const;
const domainWords = new Set(['rpc', 'rest', 'mq', 'api', 'http', 'method', 'function', 'service', 'services', 'query', 'show', 'find', 'the', 'of', 'and', 'or', 'all', 'what', 'which', 'who', 'calls', 'callers', 'downstream', 'upstream', 'dependencies', 'information', 'node', 'entity', 'entry', 'endpoints']);

function failure(code: string, message: string): never {
  throw Object.assign(new Error(`${code}: ${message}`), { code });
}

/** Conservative demo-only intent guard; tools remain the enforcement boundary. */
export function hasUnsafeIntent(question: string): boolean {
  if (/\b(?:DELETE|DETACH|CREATE|MERGE|DROP|LOAD\s+CSV|SET|REMOVE)\b/i.test(question) || /\bCALL\s+[A-Za-z_]\w*\./i.test(question)) return true;
  if (/删除所有|清空|写入|创建节点|创建关系|更新数据库|修改图谱|删除节点|删除关系/.test(question)) return true;
  return /删除/.test(question) && !/影响|范围|分析/.test(question);
}

export function detectDemoCategory(question: string): Category {
  const intent = question.replace(/\/api\/[\w/.-]+/gi, ' ');
  if ((/\brpc\b|\brest\b|同步/i.test(intent) && /\bmq\b|异步|消息/i.test(intent)) || /综合依赖|联合依赖/.test(intent)) return 'combined';
  if (/反向|影响|上游|调用者|谁调用|callers|upstream|impact/i.test(intent)) return 'impact';
  if (/\bmq\b|消息|发布者|发布|消费|队列|交换机|异步/i.test(intent)) return 'mq';
  if (/下游|依赖|调用链|被调用|调用了|downstream|dependencies/i.test(intent)) return 'downstream';
  if (/入口|\bapi\b|接口|端点|endpoint/i.test(intent)) return 'api';
  if (/包含|筛选|模糊|匹配|含有|过滤|contains/i.test(intent)) return 'filter';
  return 'entity';
}

function entityTerm(question: string): string {
  const quoted = question.match(/[“「"']([^”」"']{1,100})[”」"']/u)?.[1]?.trim();
  if (quoted) return quoted;
  const stableId = question.match(/\b(?:service|method|api|exchange|queue):[A-Za-z0-9_.:/-]+/)?.[0];
  if (stableId) return stableId;
  const service = question.match(/\bts-[A-Za-z0-9-]+-service\b/)?.[0];
  if (service) return service;
  const api = question.match(/\/api\/[A-Za-z0-9_./-]+/)?.[0];
  if (api) return api;
  const candidates = [...question.matchAll(/[A-Za-z_][A-Za-z0-9_.:-]*/g)].map(match => match[0]).filter(token => !domainWords.has(token.toLowerCase()));
  return candidates[0] ?? '';
}

function filterTerm(question: string): string {
  const match = question.match(/(?:包含|含有|匹配|contains)\s*[“「"']?([\w.:-]+|[\p{Script=Han}]+)/iu)?.[1];
  return match?.replace(/的?服务.*$/, '').trim() ?? '';
}

/** The offline controller is explicit rules. Live planning is done by the configured model. */
export function planDemo(question: string): TaskPlan {
  if (typeof question !== 'string' || !question.trim() || question.length > 2000) failure('INVALID_REQUEST', '问题长度须为 1–2000 字符');
  if (hasUnsafeIntent(question)) failure('UNSAFE_REQUEST', '本项目只读取代码图谱，不执行修改数据或外部过程请求');
  const category = detectDemoCategory(question);
  const term = category === 'filter' ? filterTerm(question) : entityTerm(question);
  if (!term) failure('UNSUPPORTED_DEMO_QUERY', category === 'filter' ? '规则演示请使用“名称包含 order 的服务”这样的问法' : '规则演示需要明确实体名称，例如 getAllFood；真实模式可让模型理解自然语言别名');
  if (category === 'combined') return {
    category, entityTerm: term,
    branches: [
      { id: 'synchronous', category: 'downstream', purpose: '沿同步调用关系查询被调用方法及所属服务' },
      { id: 'messaging', category: 'mq', purpose: '查询源方法发布、路由、消费到目标服务的异步消息链路' },
    ],
  };
  const purposes: Record<Exclude<Category, 'combined'>, string> = {
    entity: '定位实体节点', filter: '按名称关键词筛选服务', api: '查询目标服务的入口接口路径',
    downstream: '沿调用方向查询下游方法与服务', impact: '沿调用者方向追踪反向影响', mq: '查询发布到消费的完整消息链路',
  };
  return { category, entityTerm: term, branches: [{ id: category, category, purpose: purposes[category] }] };
}

export async function loadSkillBundle(): Promise<SkillBundle> {
  const manifest = JSON.parse(await readFile(new URL('../workflow.json', import.meta.url), 'utf8')) as { id: string; version: string; stages: string[] };
  if (JSON.stringify(manifest.stages) !== JSON.stringify(STAGES)) failure('INVALID_SKILL_WORKFLOW', 'Skill 阶段表与公共执行契约不一致');
  return {
    id: manifest.id, version: manifest.version,
    instructions: await readFile(new URL('../SKILL.md', import.meta.url), 'utf8'),
    stages: [...manifest.stages], planDemo,
    seedPath: fileURLToPath(new URL('../data/examples.seed.json', import.meta.url)),
    semanticLexiconPath: fileURLToPath(new URL('../data/semantic-concepts.json', import.meta.url)),
  };
}
