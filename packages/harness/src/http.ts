import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, type AgentPort, type Category, type Complexity, type ExampleInput, type GraphSchema, type QueryRequest, type QueryResponse, type SkillBundle, type ToolContext, type ToolService } from '../../../contracts/index.ts';
import { readConfig, type AppConfig } from './config.ts';

const webRoot = fileURLToPath(new URL('../../../apps/web/public/', import.meta.url));
const categories = ['entity', 'filter', 'api', 'downstream', 'impact', 'mq', 'combined'];
const complexities = ['simple', 'medium', 'hard'];
class HttpError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'CONTENT_TYPE', '请使用 application/json');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length; if (size > 65536) throw new HttpError(413, 'BODY_TOO_LARGE', '请求体不能超过 64 KiB'); chunks.push(bytes); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'INVALID_JSON', 'JSON 格式无效'); }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'INVALID_INPUT', '请求必须是 JSON 对象');
  return value as Record<string, unknown>;
}
function complexity(value: unknown): Complexity | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !complexities.includes(value)) throw new HttpError(400, 'INVALID_COMPLEXITY', '复杂度必须为 simple、medium 或 hard');
  return value as Complexity;
}
function queryInput(value: unknown): QueryRequest {
  const o = record(value);
  if (typeof o.question !== 'string' || !o.question.trim() || o.question.length > 2000) throw new HttpError(400, 'INVALID_QUESTION', '问题长度必须为 1–2000 字符');
  if (o.entityId !== undefined && (typeof o.entityId !== 'string' || !o.entityId.trim() || o.entityId.length > 500)) throw new HttpError(400, 'INVALID_ENTITY', 'entityId 无效');
  return { question: o.question.trim(), ...(o.entityId === undefined ? {} : { entityId: o.entityId as string }), ...(o.complexity === undefined ? {} : { complexity: complexity(o.complexity) }) };
}
function exampleInput(value: unknown): ExampleInput {
  const o = record(value);
  for (const key of ['id', 'question', 'category', 'complexity', 'cypher', 'description']) if (typeof o[key] !== 'string') throw new HttpError(400, 'INVALID_EXAMPLE', `${key} 必须是字符串`);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(o.id as string) || !categories.includes(o.category as string) || !complexities.includes(o.complexity as string) || !(o.question as string).trim() || (o.question as string).length > 2000 || !(o.cypher as string).trim() || (o.cypher as string).length > 20000 || (o.description as string).length > 4000) throw new HttpError(400, 'INVALID_EXAMPLE', '示例字段值不符合约定');
  record(o.parameters);
  return { id: o.id, question: o.question, category: o.category, complexity: o.complexity, cypher: o.cypher, parameters: o.parameters, description: o.description } as ExampleInput;
}
function json(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function reportFor(saved: QueryResponse): string {
  const attached = (saved as QueryResponse & { reportMarkdown?: string }).reportMarkdown;
  const base = attached || `# 代码图谱查询报告\n\n问题：${saved.question}\n\n状态：${saved.status}\n\n${saved.summary}\n\n## 查询与结果\n\n\`\`\`json\n${JSON.stringify({ queries: saved.queries, result: saved.result, evidenceIds: saved.evidenceIds ?? [] }, null, 2)}\n\`\`\`\n`;
  return `# 运行记录\n\n状态：${saved.status}\n\n## 运行来源与用量\n\n\`\`\`json\n${JSON.stringify({ id: saved.id, createdAt: saved.createdAt, source: saved.source, usage: saved.usage }, null, 2)}\n\`\`\`\n\n## 限制说明\n\n${saved.warnings.map(x => '- ' + x).join('\n') || '- 无额外警告'}\n\n## 执行过程\n\n\`\`\`json\n${JSON.stringify(saved.trace, null, 2)}\n\`\`\`\n\n` + base;
}

export async function createApplication(config: AppConfig, injected?: { tools: ToolService; agent: AgentPort; skill: SkillBundle }) {
  const skill = injected?.skill ?? await (await import('../../skills/src/index.ts')).loadSkillBundle();
  const tools = injected?.tools ?? await (await import('../../tools/src/index.ts')).createToolService({ graph: config.graph, dataDir: config.dataDir, seedPath: skill.seedPath, semanticLexiconPath: skill.semanticLexiconPath, limits: config.limits });
  let agent: AgentPort;
  try { agent = injected?.agent ?? await (await import('./runner.ts')).createHarness({ tools, skill, config: config.agent, limits: config.limits }); }
  catch (error) { await tools.close(); throw error; }
  const runs = new Map<string, QueryResponse>();
  let active = 0;
  const run = async (input: QueryRequest, signal: AbortSignal) => {
    const result = await agent.run(input, signal); runs.set(result.id, result);
    while (runs.size > 100) runs.delete(runs.keys().next().value!);
    return result;
  };
  const toolCall = async <T>(name: string, args: Record<string, unknown>, context: ToolContext): Promise<T> => {
    const result = await tools.call<T>(name, args, context);
    if (!result.ok) throw new HttpError(503, 'TOOL_UNAVAILABLE', '数据工具暂不可用，请检查服务端配置');
    return result.data as T;
  };
  const server = createServer(async (req, res) => {
    const cancelled = new AbortController();
    req.on('aborted', () => cancelled.abort(new DOMException('Client disconnected', 'AbortError')));
    res.on('close', () => { if (!res.writableEnded) cancelled.abort(new DOMException('Client disconnected', 'AbortError')); });
    const requestId = randomUUID();
    const signal = AbortSignal.any([cancelled.signal, AbortSignal.timeout(config.limits.timeoutMs)]);
    const context: ToolContext = { sessionId: `http-${requestId}`, limits: config.limits, signal };
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('X-Request-Id', requestId);
    let counted = false;
    try {
      const host = req.headers.host ?? '';
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) throw new HttpError(403, 'HOST_REJECTED', '仅允许本机访问');
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new HttpError(403, 'ORIGIN_REJECTED', '不接受跨来源请求');
      const url = new URL(req.url ?? '/', `http://${host}`); const path = url.pathname;
      if (req.method === 'GET' && path === '/api/health') {
        const base = { contractVersion: CONTRACT_VERSION, graphMode: config.graph.mode, modelMode: config.agent.modelMode, modelName: config.agent.modelName, runtime: 'standalone-workbench', skillVersion: skill.version, toolNames: tools.definitions.map(x => x.name), retrievalMode: 'domain-semantic-hybrid', limits: config.limits };
        try {
          const schema = await toolCall<GraphSchema>('get_schema', {}, context);
          json(res, 200, { ...base, status: 'ok', ready: true, graphVersion: schema.version, warnings: [ ...(config.graph.mode === 'fixture' ? ['人工样例图谱，不是真实课程数据'] : []), ...(config.agent.modelMode === 'demo' ? ['规则演示模式，不调用大模型'] : ['模型连通性以实际查询为准']), '此入口为独立工作台；dsh 插件宿主验收单独记录' ] });
        } catch { json(res, 503, { ...base, status: 'unavailable', ready: false, graphVersion: null, warnings: ['图谱连接失败，请检查服务端配置'] }); }
        return;
      }
      if (req.method === 'GET' && path === '/api/schema') return json(res, 200, await toolCall<GraphSchema>('get_schema', {}, context));
      if (req.method === 'GET' && path === '/api/examples') {
        const q = url.searchParams.get('q') ?? ''; const category = url.searchParams.get('category') ?? ''; const mode = url.searchParams.get('mode') ?? 'hybrid';
        if (q.length > 2000) throw new HttpError(400, 'INVALID_QUERY', '检索文本过长');
        if (category && !categories.includes(category)) throw new HttpError(400, 'INVALID_CATEGORY', '未知查询类型');
        if (!['hybrid', 'semantic', 'lexical'].includes(mode)) throw new HttpError(400, 'INVALID_SEARCH_MODE', '未知检索模式');
        if (q) { const matches = await toolCall<{ example: unknown; score: number }[]>('search_examples', { question: q, ...(category ? { category } : {}), mode, verifiedOnly: false }, context); return json(res, 200, { examples: matches.map(x => x.example), matches, mode }); }
        return json(res, 200, { examples: (await tools.examples.list(signal)).filter(x => !category || x.category === category), mode });
      }
      if (req.method === 'GET' && /^\/api\/runs\/[^/]+(?:\/report)?$/.test(path)) {
        const id = decodeURIComponent(path.split('/')[3]); const saved = runs.get(id);
        if (!saved) throw new HttpError(404, 'RUN_NOT_FOUND', '运行记录不存在或已过期，请重新查询');
        if (!path.endsWith('/report')) return json(res, 200, saved);
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="query-${saved.id.replace(/[^a-zA-Z0-9-]/g, '')}.md"` }); res.end(reportFor(saved)); return;
      }
      if (['POST', 'DELETE'].includes(req.method ?? '') && path.startsWith('/api/')) {
        if (active >= 2) throw new HttpError(429, 'BUSY', '当前有其他任务运行，请稍后重试');
        active++; counted = true;
        if (req.method === 'POST' && path === '/api/query') return json(res, 200, await run(queryInput(await readJson(req)), signal));
        if (req.method === 'POST' && path === '/api/batch') {
          const input = record(await readJson(req)); const selectedComplexity = complexity(input.complexity);
          if (!Array.isArray(input.questions) || !input.questions.length || input.questions.length > 10) throw new HttpError(400, 'INVALID_BATCH', '每批须为 1–10 个问题');
          const questions = input.questions.map(question => queryInput({ question, complexity: selectedComplexity })); const results = [];
          for (const q of questions) { cancelled.signal.throwIfAborted(); results.push(await run(q, AbortSignal.any([cancelled.signal, AbortSignal.timeout(config.limits.timeoutMs)]))); }
          return json(res, 200, { results });
        }
        if (req.method === 'POST' && path === '/api/examples') return json(res, 200, await tools.examples.upsert(exampleInput(await readJson(req)), signal));
        if (req.method === 'POST' && path === '/api/examples/verify') { record(await readJson(req)); return json(res, 200, await tools.examples.verify(signal)); }
        if (req.method === 'DELETE' && /^\/api\/examples\/[^/]+$/.test(path)) {
          const id = decodeURIComponent(path.split('/')[3]);
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new HttpError(400, 'INVALID_EXAMPLE', '示例编号无效');
          return json(res, 200, { deleted: await tools.examples.delete(id, signal) });
        }
      }
      if (path.startsWith('/api/')) throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持该方法');
      let relative: string;
      try { relative = decodeURIComponent(path === '/' ? '/index.html' : path); } catch { throw new HttpError(400, 'INVALID_PATH', '页面路径无效'); }
      const target = resolve(webRoot, `.${relative}`);
      if (!target.startsWith(resolve(webRoot) + sep) || !['.html', '.css', '.js', '.svg', '.ico'].includes(extname(target))) throw new HttpError(404, 'NOT_FOUND', '页面不存在');
      let body: Buffer; try { body = await readFile(target); } catch { throw new HttpError(404, 'NOT_FOUND', '页面不存在'); }
      const mime: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
      res.writeHead(200, { 'Content-Type': `${mime[extname(target)]}; charset=utf-8` }); res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (!res.headersSent) {
        const e = error instanceof HttpError ? error : signal.aborted
          ? new HttpError(408, signal.reason?.name === 'TimeoutError' ? 'REQUEST_TIMEOUT' : 'REQUEST_CANCELLED', '请求已超时或被取消')
          : new HttpError(500, 'INTERNAL_ERROR', '请求失败，请检查服务端环境与数据配置');
        json(res, e.status, { error: { code: e.code, message: e.message }, requestId });
      }
      else res.end();
    } finally { if (counted) active--; }
  });
  server.requestTimeout = Math.max(70000, config.limits.timeoutMs * 10 + 5000); server.headersTimeout = 10000;
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    await new Promise<void>((done, reject) => { if (!server.listening) return done(); server.close(e => e ? reject(e) : done()); server.closeIdleConnections(); });
    await tools.close();
  };
  return { server, tools, agent, skill, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = readConfig(); const app = await createApplication(config);
    app.server.on('error', error => { const code = (error as NodeJS.ErrnoException).code ?? 'SERVER_ERROR'; console.error(`Cannot start local server (${code}). Check the port and local network permissions.`); void app.close().finally(() => { process.exitCode = 1; }); });
    app.server.listen(config.port, config.host, () => console.log(`CodeGraph: http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${(app.server.address() as { port: number }).port} [${config.graph.mode}/${config.agent.modelMode}; standalone-workbench]`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
  } catch { console.error('Startup failed. Check the server configuration and module installation.'); process.exitCode = 1; }
}
