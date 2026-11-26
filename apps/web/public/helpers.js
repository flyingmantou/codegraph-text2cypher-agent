export const CATEGORY_LABELS = { entity: '单节点查询', filter: '属性过滤', api: '入口 API', downstream: '下游服务', impact: '反向影响', mq: 'MQ 链路', combined: '综合依赖' };
export const STATUS_LABELS = { success: '查询成功', empty: '结果为空', needs_clarification: '需要澄清', rejected: '已拦截', failed: '查询失败', partial: '部分结果' };
export const COMPLEXITY_LABELS = { simple: '简单', medium: '中等', hard: '复杂' };

export function makeQueryInput(question, complexity = 'simple', entityId) {
  if (typeof question !== 'string' || !question.trim() || question.length > 2000) throw new Error('问题长度必须为 1–2000 字符。');
  if (!Object.hasOwn(COMPLEXITY_LABELS, complexity)) throw new Error('请选择简单、中等或复杂查询。');
  if (entityId !== undefined && (typeof entityId !== 'string' || !entityId || entityId.length > 500)) throw new Error('选择的实体编号无效。');
  return { question: question.trim(), complexity, ...(entityId === undefined ? {} : { entityId }) };
}

export function sourceLabels(source = {}) {
  const graphLabels = { fixture: '人工样例图谱', neo4j: 'Neo4j 图谱' };
  const modelLabels = { demo: '规则演示', deepseek: 'DeepSeek', glm: 'GLM' };
  const graph = source.graph ?? source.graphMode, model = source.model ?? source.modelMode;
  return {
    graph: Object.hasOwn(graphLabels, graph) ? graphLabels[graph] : '图谱来源未知',
    model: Object.hasOwn(modelLabels, model) ? modelLabels[model] : '模型来源未知',
    runtime: source.runtime || '运行器未标注',
    skill: source.skillVersion || 'Skill 版本未标注',
  };
}

export function parseBatch(text, filename = '') {
  if (text.length > 100_000) throw new Error('文件内容过大，请使用不超过 100 KB 的问题文件。');
  let questions;
  if (filename.toLowerCase().endsWith('.json')) {
    try { questions = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('JSON 格式不正确，请提供字符串数组。'); }
    if (!Array.isArray(questions) || questions.some(q => typeof q !== 'string')) throw new Error('JSON 应为字符串数组，例如 ["查询 getAllFood 方法"]。');
  } else questions = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  questions = questions.map(q => q.trim()).filter(Boolean);
  if (questions.length === 0) throw new Error('文件没有有效问题。');
  if (questions.length > 10) throw new Error('每次最多上传 10 个问题，请拆分文件。');
  if (questions.some(q => q.length > 2000)) throw new Error('每个问题最多 2000 字符。');
  return questions;
}

export function displayValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

export function graphPositions(nodes, width = 700, height = 430) {
  const groups = new Map();
  for (const node of nodes) { if (!groups.has(node.label)) groups.set(node.label, []); groups.get(node.label).push(node); }
  const labels = [...groups.keys()];
  const positions = new Map();
  labels.forEach((label, groupIndex) => {
    const members = groups.get(label);
    members.forEach((node, index) => positions.set(node.id, {
      x: labels.length === 1 ? width / 2 : 80 + groupIndex * (width - 160) / (labels.length - 1),
      y: 65 + (index + 0.5) * (height - 130) / members.length,
    }));
  });
  return positions;
}

export function parseParameters(text) {
  let parameters;
  try { parameters = JSON.parse(text); } catch { throw new Error('参数不是有效的 JSON。'); }
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('参数必须为 JSON 对象。');
  return parameters;
}
