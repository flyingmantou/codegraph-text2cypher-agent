import { makeQueryInput } from './helpers.js';

/** Browser-only transport. All destinations are fixed same-origin application routes. */
export function createApiClient(fetchImpl = fetch) {
  async function json(path, options = {}) {
    const response = await fetchImpl(path, {
      ...options, credentials: 'same-origin', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    let body;
    try { body = await response.json(); }
    catch { throw new Error(`服务返回无效响应（HTTP ${response.status}）。`); }
    if (!response.ok) throw new Error(typeof body?.error?.message === 'string' ? body.error.message : `请求失败（HTTP ${response.status}）`);
    return body;
  }
  return {
    json,
    query(question, complexity, entityId, signal) {
      return json('/api/query', { method: 'POST', body: JSON.stringify(makeQueryInput(question, complexity, entityId)), signal });
    },
    batch(questions, complexity, signal) {
      if (!Array.isArray(questions) || questions.length < 1 || questions.length > 10) throw new Error('每批需要 1–10 个问题。');
      const checked = questions.map(question => makeQueryInput(question, complexity));
      return json('/api/batch', { method: 'POST', body: JSON.stringify({ questions: checked.map(item => item.question), complexity }), signal });
    },
    examples({ question = '', category = '', mode = 'hybrid' } = {}) {
      if (!['hybrid', 'semantic', 'lexical'].includes(mode)) throw new Error('未知检索方式。');
      const params = new URLSearchParams();
      if (question.trim()) { params.set('q', question.trim()); params.set('mode', mode); }
      if (category) params.set('category', category);
      return json(`/api/examples?${params}`);
    },
    async report(id) {
      if (typeof id !== 'string' || !id) throw new Error('没有可导出的运行记录。');
      const response = await fetchImpl(`/api/runs/${encodeURIComponent(id)}/report`, { credentials: 'same-origin', redirect: 'error' });
      if (!response.ok) throw new Error('报告下载失败，请重新执行查询后重试。');
      return response.text();
    },
  };
}
