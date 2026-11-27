import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { evaluateSuite, type EvaluationSuite } from '../src/evaluation.ts';
import type { QueryResponse } from '../../../contracts/index.ts';

export async function evaluateHttp(baseUrl = 'http://127.0.0.1:3000', fetchImpl: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash) throw new Error('LOCAL_API_REQUIRED');
  const suite = JSON.parse(await readFile(new URL('../data/evaluation.dev.json', import.meta.url), 'utf8')) as EvaluationSuite;
  return evaluateSuite(suite, async request => {
    const response = await fetchImpl(new URL('/api/query', base), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
      signal: AbortSignal.timeout(65_000), redirect: 'error',
    });
    if (!response.ok) throw new Error('QUERY_HTTP_ERROR');
    return await response.json() as QueryResponse;
  });
}

if (import.meta.main) {
  try {
    const report = await evaluateHttp(process.env.CODEGRAPH_BASE_URL);
    const output = resolve(fileURLToPath(new URL('../../../.runtime/', import.meta.url)), 'evaluation-dev.json');
    await mkdir(resolve(output, '..'), { recursive: true, mode: 0o700 });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(`开发回归 ${report.totals.passed}/${report.totals.total}；结果：${output}`);
    console.log('此结果不等于真实课程图谱、独立30题或模型语义准确率。');
    if (report.totals.passed !== report.totals.total) process.exitCode = 1;
  } catch { console.error('开发回归无法完成，请检查本机服务与配置。'); process.exitCode = 1; }
}
