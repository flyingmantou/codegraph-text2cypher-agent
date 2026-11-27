import { CATEGORY_LABELS, STATUS_LABELS, COMPLEXITY_LABELS, parseBatch, parseParameters, displayValue, graphPositions, sourceLabels } from './helpers.js';
import { createApiClient } from './api-client.js';

const $ = id => document.getElementById(id);
const state = { health: null, current: null, currentComplexity: 'simple', examples: [], batchQuestions: [], busy: false, graphZoom: 1, controller: null, examplesRequest: 0 };
const client = createApiClient();
const api = client.json;
const SVG_NS = 'http://www.w3.org/2000/svg';
const STAGE_LABELS = { request: '请求检查', schema: '获取图谱结构', plan: '制定查询计划', entities: '识别与澄清实体', entity: '识别与澄清实体', examples: '检索查询示例', retrieval: '检索查询示例', generate: '生成查询', generation: '生成查询', repair: '修复查询', repair_generation: '修复查询', validate: '校验查询', validation: '校验查询', execute: '受控执行', execution: '受控执行', merge: '合并执行证据', report: '整理证据报告', formatting: '整理结果' };

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function svg(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function message(text, kind = 'info') {
  const node = $('global-message');
  node.textContent = text;
  node.className = `message ${kind}`;
}

function navigate(page) {
  const names = { query: '查询工作台', examples: '示例知识库', guide: '运行说明' };
  if (!(page in names)) page = 'query';
  for (const node of document.querySelectorAll('.page')) node.classList.toggle('hidden', node.id !== `page-${page}`);
  for (const button of document.querySelectorAll('[data-page]')) {
    const active = button.dataset.page === page;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  $('page-title').textContent = names[page];
  document.title = `CodeGraph · ${names[page]}`;
  if (page === 'examples') loadExamples().catch(error => message(error.message, 'error'));
  if (page === 'guide') loadSchema().catch(error => message(error.message, 'error'));
}

function detailItem(container, name, value) {
  container.append(el('dt', name), el('dd', displayValue(value)));
}

async function loadHealth() {
  try {
    const health = await api('/api/health');
    state.health = health;
    const labels = sourceLabels(health);
    $('graph-mode').textContent = labels.graph;
    $('model-mode').textContent = labels.model;
    $('graph-mode').className = `badge ${health.graphMode === 'fixture' ? 'warning' : ''}`;
    $('model-mode').className = `badge ${health.modelMode === 'demo' ? 'warning' : ''}`;
    const demo = health.graphMode === 'fixture' || health.modelMode === 'demo';
    const warnings = [];
    if (health.graphMode === 'fixture') warnings.push('当前使用人工构造的样例图谱，并非课程真实 Train Ticket 图谱。');
    if (health.modelMode === 'demo') warnings.push('查询由受限规则生成，未调用大模型。');
    warnings.push(...(health.warnings || []));
    $('mode-warning').textContent = warnings.join(' ');
    $('mode-warning').classList.toggle('hidden', !warnings.length);
    const details = $('health-details');
    details.replaceChildren();
    for (const [name, value] of [
      ['服务状态', health.ready === false ? '尚未就绪' : '运行中'],
      ['图谱来源', labels.graph], ['运行器', labels.runtime], ['Skill 版本', labels.skill],
      ['检索方式', health.retrievalMode || '未标注'], ['领域工具', health.toolNames?.join('、')],
      ['图谱版本', health.graphVersion], ['生成方式', health.modelMode === 'demo' ? '规则演示' : health.modelName],
      ['接口版本', health.contractVersion], ['最大结果行数', health.limits?.maxRows], ['最大路径深度', health.limits?.maxDepth],
      ['查询超时', `${health.limits?.timeoutMs ?? '—'} ms`], ['最大修复次数', health.limits?.maxRepairs], ['模型调用上限', health.limits?.maxModelCalls], ['工具调用上限', health.limits?.maxToolCalls],
    ]) detailItem(details, name, value);
    if (!demo && !warnings.length) $('mode-warning').classList.add('hidden');
  } catch (error) {
    state.health = null;
    $('graph-mode').textContent = '连接失败';
    $('graph-mode').className = 'badge failed';
    $('model-mode').textContent = '状态未知';
    $('model-mode').className = 'badge neutral';
    $('health-details').replaceChildren(el('dt', '服务状态'), el('dd', '未能获取最新状态，请确认服务已启动后刷新。'));
    message(`无法连接后端：${error.message}`, 'error');
  }
}

function setBusy(busy, label = '正在查询…') {
  state.busy = busy;
  $('query-submit').disabled = busy;
  $('query-submit').textContent = busy ? label : '运行查询 ↗';
  $('query-submit').classList.toggle('loading', busy);
  $('batch-submit').disabled = busy || state.batchQuestions.length === 0;
  $('query-cancel').classList.toggle('hidden', !busy);
  $('query-form').setAttribute('aria-busy', String(busy));
  for (const button of document.querySelectorAll('.candidate, .batch-result')) button.disabled = busy;
}

function complexity() { return document.querySelector('input[name="complexity"]:checked').value; }

function beginRequest(label) {
  state.controller = new AbortController();
  state.current = null;
  $('download-report').disabled = true;
  $('result-content').classList.add('hidden');
  $('result-empty').classList.remove('hidden');
  $('result-empty').replaceChildren(el('h3', label), el('p', '完成后展示实际执行记录；可以随时取消请求。'));
  $('result-status').textContent = '执行中'; $('result-status').className = 'badge neutral';
  $('trace-list').replaceChildren(el('li', '任务处理中，完成后展示实际阶段记录。', 'trace-placeholder loading'));
  setBusy(true, label);
}

function failedRequest(error) {
  const cancelled = error.name === 'AbortError';
  const text = cancelled ? '已取消请求；后端将接收断连取消信号。' : error.message;
  message(text, cancelled ? 'info' : 'error');
  $('result-status').textContent = cancelled ? '已取消' : '请求失败';
  $('result-status').className = `badge ${cancelled ? 'neutral' : 'failed'}`;
  $('result-empty').replaceChildren(el('h3', cancelled ? '查询已取消' : '未获得查询结果'), el('p', '可以修改问题后重新提交。'));
  $('trace-list').replaceChildren(el('li', text, 'trace-placeholder'));
}

async function runQuery(question, entityId, requestedComplexity = complexity()) {
  if (state.busy) return;
  const input = question.trim();
  if (!input) return;
  state.currentComplexity = requestedComplexity;
  beginRequest('正在查询…');
  $('global-message').classList.add('hidden');
  $('trace-list').replaceChildren(el('li', '查询处理中，完成后展示可核对的阶段记录。', 'trace-placeholder loading'));
  try {
    const result = await client.query(input, requestedComplexity, entityId, state.controller.signal);
    renderResult(result);
  } catch (error) {
    failedRequest(error);
  } finally { state.controller = null; setBusy(false); }
}

function renderResult(response) {
  state.current = response;
  $('result-empty').classList.add('hidden');
  $('result-content').classList.remove('hidden');
  $('download-report').disabled = false;
  $('result-status').textContent = STATUS_LABELS[response.status] || response.status;
  $('result-status').className = `badge ${response.status}`;
  $('result-summary').textContent = response.summary;
  const warnings = [...(response.warnings || [])];
  if (response.error) warnings.push(`${response.error.code}：${response.error.message}`);
  if (response.result.truncated) warnings.push('结果已达到限制，当前展示范围可能不完整。');
  $('result-warning').textContent = warnings.join('\n');
  $('result-warning').classList.toggle('hidden', warnings.length === 0);
  $('metric-rows').textContent = response.result.rows.length;
  $('metric-time').textContent = `${Math.round(response.result.durationMs)} ms`;
  $('metric-calls').textContent = response.usage.modelCalls;
  $('metric-tools').textContent = response.usage.toolCalls ?? '未记录';
  $('metric-tokens').textContent = response.usage.promptTokens + response.usage.completionTokens;
  $('metric-cost').textContent = response.usage.estimatedCostCny == null ? '未知' : `¥${response.usage.estimatedCostCny.toFixed(4)}`;
  const source = response.source;
  const labels = sourceLabels(source);
  $('result-meta').textContent = `${labels.graph} / ${source.graphVersion} · ${labels.model} / ${source.modelName} · ${labels.runtime} · Skill ${labels.skill} · 运行 ${response.id}`;
  renderPlan(response.plan, response.evidenceIds || []);
  renderCandidates(response);
  renderRows(response.result);
  renderGraph(response.result.graph);
  renderQueries(response.queries);
  renderTrace(response.trace);
  $('used-examples').textContent = response.examplesUsed.length ? `参考示例：${response.examplesUsed.join('、')}` : '本次未使用已验证示例。';
  $('used-examples').classList.remove('hidden');
}

function renderCandidates(response) {
  const container = $('clarification');
  container.replaceChildren();
  container.classList.toggle('hidden', !response.candidates.length || response.status !== 'needs_clarification');
  if (response.status !== 'needs_clarification') return;
  for (const candidate of response.candidates) {
    const button = el('button', undefined, 'candidate');
    button.append(el('strong', `${candidate.name} · ${candidate.label}`), el('small', candidate.id));
    const requestedComplexity = state.currentComplexity;
    button.addEventListener('click', () => runQuery(response.question, candidate.id, requestedComplexity));
    container.append(button);
  }
}

function renderPlan(plan, evidenceIds) {
  $('plan-panel').classList.toggle('hidden', !plan);
  $('plan-list').replaceChildren();
  if (plan) {
    $('plan-summary').textContent = `${CATEGORY_LABELS[plan.category] || plan.category} · ${plan.branches.length} 个分支`;
    for (const branch of plan.branches) {
      const li = el('li');
      li.append(el('strong', `${branch.id} · ${CATEGORY_LABELS[branch.category] || branch.category}`), el('span', branch.purpose));
      $('plan-list').append(li);
    }
  }
  $('evidence-list').classList.toggle('hidden', !evidenceIds.length);
  $('evidence-list').textContent = `执行证据：${evidenceIds.join('、')}`;
}

function renderRows(result) {
  const container = $('result-table');
  container.replaceChildren();
  if (!result.rows.length) { container.append(el('p', '当前没有数据行。请结合查询状态和执行过程判断原因。', 'muted')); return; }
  const columns = result.columns.length ? result.columns : [...new Set(result.rows.flatMap(row => Object.keys(row)))];
  const table = el('table');
  const head = el('thead'); const header = el('tr');
  for (const column of columns) { const th = el('th', column); th.scope = 'col'; header.append(th); }
  head.append(header); table.append(head);
  const body = el('tbody');
  for (const row of result.rows) {
    const tr = el('tr');
    for (const column of columns) { const td = el('td'); td.append(el('pre', displayValue(row[column]))); tr.append(td); }
    body.append(tr);
  }
  table.append(body); container.append(table);
}

function renderTrace(trace) {
  const list = $('trace-list'); list.replaceChildren();
  if (!trace.length) { list.append(el('li', '此次请求没有执行阶段记录。', 'trace-placeholder')); return; }
  for (const step of trace) {
    const li = el('li');
    const icon = el('span', step.status === 'ok' ? '✓' : step.status === 'error' ? '!' : '–', `trace-step-icon ${step.status}`);
    const heading = el('div', undefined, 'trace-step-name');
    heading.append(el('span', STAGE_LABELS[step.stage] || step.stage), el('small', `${Math.round(step.durationMs)} ms`));
    li.append(icon, heading, el('p', step.message, 'trace-description')); list.append(li);
  }
}

function renderQueries(queries) {
  const container = $('query-code'); container.replaceChildren();
  if (!queries.length) { container.append(el('p', '当前流程尚未生成查询语句。', 'muted')); return; }
  queries.forEach((query, index) => {
    const block = el('div', undefined, 'query-block');
    block.append(el('h3', query.label || `查询 ${index + 1}`), el('pre', query.cypher), el('h3', '参数'), el('pre', JSON.stringify(query.parameters, null, 2)));
    container.append(block);
  });
}

function renderGraph(graph) {
  const container = $('graph-canvas'); container.replaceChildren();
  const edgeTable = el('table'); const edgeHead = el('tr');
  for (const title of ['来源节点', '关系', '目标节点', '关系 ID']) edgeHead.append(el('th', title));
  edgeTable.append(edgeHead);
  const nodeNames = new Map(graph.nodes.map(node => [node.id, node.name]));
  for (const edge of graph.edges) {
    const row = el('tr');
    for (const value of [nodeNames.get(edge.source) || edge.source, edge.type, nodeNames.get(edge.target) || edge.target, edge.id]) row.append(el('td', value));
    edgeTable.append(row);
  }
  $('edge-table').replaceChildren(graph.edges.length ? edgeTable : el('p', '当前结果没有关系。', 'muted'));
  $('node-detail').classList.add('hidden'); state.graphZoom = 1;
  if (!graph.nodes.length) { container.append(el('p', '本次结果不包含可展示的节点或关系。', 'empty-state')); return; }
  const width = Math.max(700, new Set(graph.nodes.map(n => n.label)).size * 160);
  const height = Math.max(430, Math.max(...[...new Set(graph.nodes.map(n => n.label))].map(label => graph.nodes.filter(n => n.label === label).length)) * 85);
  const positions = graphPositions(graph.nodes, width, height);
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `关系子图，${graph.nodes.length} 个节点，${graph.edges.length} 条关系` });
  root.dataset.baseWidth = width; root.dataset.baseHeight = height;
  const defs = svg('defs'); const marker = svg('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' });
  marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#a4b4cb' })); defs.append(marker); root.append(defs);
  for (const edge of graph.edges) {
    const start = positions.get(edge.source), end = positions.get(edge.target); if (!start || !end) continue;
    const dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy) || 1;
    const x1 = start.x + dx * 22 / length, y1 = start.y + dy * 22 / length, x2 = end.x - dx * 26 / length, y2 = end.y - dy * 26 / length;
    root.append(svg('line', { x1, y1, x2, y2, stroke: '#b7c6db', 'stroke-width': 1.3, 'marker-end': 'url(#arrow)' }));
    const label = svg('text', { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 6, 'text-anchor': 'middle', fill: '#879ab5', 'font-size': 9, 'paint-order': 'stroke', stroke: '#fff', 'stroke-width': 3 });
    label.textContent = edge.type; root.append(label);
  }
  const colors = { 服务: ['#e8f0ff', '#5282c9'], 方法: ['#edf7f2', '#479775'], 接口: ['#f0ebfc', '#9172b4'], 交换机: ['#fff3dc', '#c99c45'], 队列: ['#fdece7', '#c57e68'] };
  for (const node of graph.nodes) {
    const pos = positions.get(node.id), [fill, stroke] = colors[node.label] || ['#edf1f5', '#8093ad'];
    const group = svg('g', { class: 'graph-node', tabindex: '0', role: 'button', 'aria-label': `${node.label} ${node.name}，查看属性` });
    group.append(svg('circle', { cx: pos.x, cy: pos.y, r: 21, fill, stroke, 'stroke-width': 1.5 }));
    const kind = svg('text', { x: pos.x, y: pos.y + 4, 'text-anchor': 'middle', 'font-size': 10, fill: stroke }); kind.textContent = node.label;
    const label = svg('text', { x: pos.x, y: pos.y + 37, 'text-anchor': 'middle', 'font-size': 10, fill: '#526b8a' }); label.textContent = node.name.length > 24 ? `${node.name.slice(0, 22)}…` : node.name;
    const title = svg('title'); title.textContent = `${node.name}\n${node.id}`;
    group.append(kind, label, title);
    const show = () => { const detail = $('node-detail'); detail.replaceChildren(el('strong', `${node.name} · ${node.label}`), el('p', node.id, 'muted'), el('pre', JSON.stringify(node.properties, null, 2))); detail.classList.remove('hidden'); };
    group.addEventListener('click', show); group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show(); } });
    root.append(group);
  }
  container.append(root);
}

function zoomGraph(multiplier) {
  const graph = $('graph-canvas').querySelector('svg'); if (!graph) return;
  state.graphZoom = multiplier === 0 ? 1 : Math.max(0.5, Math.min(2.5, state.graphZoom * multiplier));
  // SVG viewBox attributes avoid inline styles under the server's strict CSP.
  const width = Number(graph.dataset.baseWidth), height = Number(graph.dataset.baseHeight);
  const viewWidth = width / state.graphZoom, viewHeight = height / state.graphZoom;
  graph.setAttribute('viewBox', `${(width - viewWidth) / 2} ${(height - viewHeight) / 2} ${viewWidth} ${viewHeight}`);
}

async function loadSchema() {
  const schema = await api('/api/schema');
  $('schema-version').textContent = schema.version;
  const container = $('schema-details'); container.replaceChildren();
  for (const [name, values] of [['节点类型', schema.nodeLabels], ['关系类型', schema.relationshipTypes]]) {
    const section = el('div', undefined, 'schema-section'); const tags = el('div', undefined, 'schema-tags');
    values.forEach(value => tags.append(el('span', value))); section.append(el('h3', name), tags); container.append(section);
  }
  const patterns = el('div', undefined, 'schema-section'); patterns.append(el('h3', '关系方向'));
  const table = el('table');
  for (const item of schema.relationshipPatterns) { const row = el('tr'); row.append(el('td', item.from), el('td', item.type), el('td', item.to)); table.append(row); }
  patterns.append(table); container.append(patterns);
  if (schema.notes?.length) container.append(el('p', schema.notes.join('；'), 'muted'));
}

async function loadExamples() {
  const request = ++state.examplesRequest;
  const data = await client.examples({ question: $('example-search').value, category: $('example-category').value, mode: $('example-search-mode').value });
  if (request !== state.examplesRequest) return;
  state.examples = data.examples;
  const scores = new Map((data.matches || []).map(item => [item.example.id, item.score]));
  const verified = data.examples.filter(e => e.verification.status === 'verified').length;
  $('examples-summary').textContent = `当前 ${data.examples.length} 组示例 · ${verified} 组已通过执行验证。验证来源与版本请查看每条记录。`;
  const list = $('examples-list'); list.replaceChildren();
  if (!data.examples.length) { list.append(el('p', '没有匹配的示例。试试其他关键词或新建示例。', 'empty-state')); return; }
  for (const example of data.examples) {
    const row = el('article', undefined, 'example-row'), content = el('div'), info = el('div', undefined, 'example-info');
    info.append(el('span', CATEGORY_LABELS[example.category] || example.category, 'badge'), el('span', COMPLEXITY_LABELS[example.complexity] || example.complexity), el('span', example.id));
    if (scores.has(example.id)) info.append(el('span', `相似度 ${scores.get(example.id).toFixed(3)}`));
    const ver = example.verification;
    info.append(el('span', ({ verified: '执行已验证', unverified: '待验证', failed: '验证失败' })[ver.status], `badge ${ver.status}`));
    content.append(el('h3', example.question), info);
    if (example.description) content.append(el('p', example.description));
    if (ver.graphVersion) content.append(el('p', `来源 ${ver.source || '未知'} · 版本 ${ver.graphVersion} · ${ver.rowCount ?? 0} 行 · ${ver.verifiedAt || ''}`));
    if (ver.error) content.append(el('p', ver.error, 'message error'));
    const actions = el('div', undefined, 'example-row-actions');
    const use = el('button', '查询', 'button small'); use.addEventListener('click', () => { $('question').value = example.question; setComplexity(example.complexity); location.hash = 'query'; $('question').focus(); });
    const edit = el('button', '编辑', 'button small'); edit.addEventListener('click', () => openEditor(example));
    const remove = el('button', '删除', 'button small'); remove.addEventListener('click', () => deleteExample(example));
    actions.append(use, edit, remove); row.append(content, actions); list.append(row);
  }
}

function openEditor(example) {
  $('example-dialog-title').textContent = example ? '编辑示例' : '新建示例';
  $('edit-id').value = example?.id || '';
  $('edit-id').readOnly = Boolean(example);
  $('edit-question').value = example?.question || '';
  $('edit-category').value = example?.category || 'entity';
  $('edit-complexity').value = example?.complexity || 'simple';
  $('edit-cypher').value = example?.cypher || '';
  $('edit-parameters').value = JSON.stringify(example?.parameters || {}, null, 2);
  $('edit-description').value = example?.description || '';
  $('editor-error').classList.add('hidden');
  $('example-dialog').showModal();
}

async function saveExample(event) {
  event.preventDefault(); $('save-example').disabled = true;
  try {
    const input = { id: $('edit-id').value.trim(), question: $('edit-question').value.trim(), category: $('edit-category').value, complexity: $('edit-complexity').value, cypher: $('edit-cypher').value.trim(), parameters: parseParameters($('edit-parameters').value), description: $('edit-description').value.trim() };
    await api('/api/examples', { method: 'POST', body: JSON.stringify(input) });
    $('example-dialog').close(); await loadExamples(); message('示例已保存，验证状态已重置。', 'success');
  } catch (error) { $('editor-error').textContent = error.message; $('editor-error').classList.remove('hidden'); }
  finally { $('save-example').disabled = false; }
}

async function deleteExample(example) {
  if (!window.confirm(`删除示例「${example.question}」？删除后可通过重新新增恢复。`)) return;
  try { await api(`/api/examples/${encodeURIComponent(example.id)}`, { method: 'DELETE' }); await loadExamples(); message('示例已删除。', 'success'); }
  catch (error) { message(error.message, 'error'); }
}

async function verifyExamples() {
  $('verify-examples').disabled = true; $('verify-examples').textContent = '正在验证…';
  try {
    const report = await api('/api/examples/verify', { method: 'POST', body: '{}' });
    await loadExamples();
    message(`验证完成：${report.verified}/${report.total} 组通过，${report.failed} 组失败。图谱来源 ${report.source}，版本 ${report.graphVersion}。`, report.failed ? 'warning' : 'success');
  } catch (error) { message(error.message, 'error'); }
  finally { $('verify-examples').disabled = false; $('verify-examples').textContent = '验证全部示例'; }
}

async function readBatchFile() {
  const file = $('batch-file').files?.[0]; state.batchQuestions = [];
  if (!file) { readBatchText(); return; }
  try {
    if (file.size > 100_000) throw new Error('文件过大，请上传不超过 100 KB 的问题文件。');
    state.batchQuestions = parseBatch(await file.text(), file.name);
    $('batch-text').value = state.batchQuestions.join('\n');
    $('batch-file-info').textContent = `${file.name} · ${state.batchQuestions.length} 个问题`;
    $('batch-submit').disabled = state.busy;
  } catch (error) { $('batch-file-info').textContent = error.message; $('batch-submit').disabled = true; }
}

function readBatchText() {
  state.batchQuestions = [];
  try {
    state.batchQuestions = parseBatch($('batch-text').value);
    $('batch-file-info').textContent = `${state.batchQuestions.length} 个问题 · 使用当前选择的查询难度`;
  } catch (error) { $('batch-file-info').textContent = $('batch-text').value.trim() ? error.message : '尚未输入问题'; }
  $('batch-submit').disabled = state.busy || !state.batchQuestions.length;
}

async function runBatch() {
  if (state.busy || !state.batchQuestions.length) return;
  const requestedComplexity = complexity();
  state.currentComplexity = requestedComplexity;
  beginRequest('批量查询中…');
  $('batch-results').replaceChildren(el('p', '正在依次执行，请稍候…', 'muted loading'));
  try {
    const data = await client.batch([...state.batchQuestions], requestedComplexity, state.controller.signal);
    const container = $('batch-results'); container.replaceChildren();
    for (const result of data.results) {
      const button = el('button', undefined, 'batch-result');
      button.append(el('span', result.question), el('span', STATUS_LABELS[result.status] || result.status, `badge ${result.status}`));
      button.addEventListener('click', () => { $('question').value = result.question; state.currentComplexity = requestedComplexity; setComplexity(requestedComplexity); renderResult(result); });
      container.append(button);
    }
    message(`批量查询完成，共 ${data.results.length} 题。点击条目查看完整记录。`, 'success');
    if (data.results.length) renderResult(data.results[0]);
  } catch (error) { $('batch-results').replaceChildren(); failedRequest(error); }
  finally { state.controller = null; setBusy(false); }
}

async function downloadReport() {
  if (!state.current) return;
  try {
    const blob = new Blob([await client.report(state.current.id)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = el('a');
    link.href = url; link.download = `codegraph-${state.current.id}.md`; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { message(error.message, 'error'); }
}

document.querySelector('.skip-link').addEventListener('click', event => { event.preventDefault(); $('main-content').focus(); });
for (const button of document.querySelectorAll('[data-page]')) button.addEventListener('click', () => { location.hash = button.dataset.page; });
window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
function setComplexity(value) {
  if (!Object.hasOwn(COMPLEXITY_LABELS, value)) return;
  document.querySelector(`input[name="complexity"][value="${value}"]`).checked = true;
}
for (const button of document.querySelectorAll('[data-question]')) button.addEventListener('click', () => {
  $('question').value = button.dataset.question;
  setComplexity(button.dataset.question.includes('综合') ? 'hard' : button.dataset.question.includes('下游') || button.dataset.question.includes('MQ') ? 'medium' : 'simple');
  $('question').focus();
});
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => {
  for (const tab of document.querySelectorAll('[data-view]')) { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); }
  for (const view of document.querySelectorAll('.result-view')) view.classList.toggle('hidden', view.id !== `view-${button.dataset.view}`);
});
const tabs = [...document.querySelectorAll('[data-view]')];
tabs.forEach((tab, index) => tab.addEventListener('keydown', event => {
  const target = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
  if (target >= 0) { event.preventDefault(); tabs[target].click(); tabs[target].focus(); }
}));
$('query-form').addEventListener('submit', event => { event.preventDefault(); runQuery($('question').value); });
$('query-cancel').addEventListener('click', () => state.controller?.abort());
$('question').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); $('query-form').requestSubmit(); } });
$('refresh-health').addEventListener('click', loadHealth);
$('download-report').addEventListener('click', downloadReport);
$('zoom-in').addEventListener('click', () => zoomGraph(1.25));
$('zoom-out').addEventListener('click', () => zoomGraph(0.8));
$('zoom-reset').addEventListener('click', () => zoomGraph(0));
$('new-example').addEventListener('click', () => openEditor());
$('close-example-dialog').addEventListener('click', () => $('example-dialog').close());
$('cancel-example').addEventListener('click', () => $('example-dialog').close());
$('example-form').addEventListener('submit', saveExample);
$('search-examples').addEventListener('click', () => loadExamples().catch(error => message(error.message, 'error')));
$('example-category').addEventListener('change', () => loadExamples().catch(error => message(error.message, 'error')));
$('example-search-mode').addEventListener('change', () => loadExamples().catch(error => message(error.message, 'error')));
$('example-search').addEventListener('keydown', event => { if (event.key === 'Enter') loadExamples().catch(error => message(error.message, 'error')); });
$('verify-examples').addEventListener('click', verifyExamples);
$('batch-file').addEventListener('change', readBatchFile);
$('batch-text').addEventListener('input', readBatchText);
$('batch-submit').addEventListener('click', runBatch);
navigate(location.hash.slice(1));
loadHealth();
