import type { GraphSchema, Limits, QuerySpec, ValidationResult } from '../../../../contracts/index.ts';

type Token = { kind: 'word' | 'identifier' | 'parameter' | 'string' | 'number' | 'symbol'; value: string };

/** Small conservative lexer, not a general Cypher parser. Neo4j EXPLAIN remains authoritative. */
function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i];
    if (/\s/.test(char)) { i++; continue; }
    if (char === '"' || char === "'") {
      const quote = char; let closed = false; i++;
      while (i < input.length) {
        if (input[i] === '\\') { i += 2; continue; }
        if (input[i++] === quote) { closed = true; break; }
      }
      if (!closed) throw new Error('字符串未闭合');
      out.push({ kind: 'string', value: '<literal>' }); continue;
    }
    if (char === '`') {
      let name = ''; let closed = false; i++;
      while (i < input.length) {
        if (input[i] === '`' && input[i + 1] === '`') { name += '`'; i += 2; continue; }
        if (input[i] === '`') { i++; closed = true; break; }
        name += input[i++];
      }
      if (!closed) throw new Error('标识符未闭合');
      out.push({ kind: 'identifier', value: name }); continue;
    }
    if (char === '$') {
      const match = input.slice(i + 1).match(/^[\p{L}_][\p{L}\p{N}_]*/u);
      if (!match) throw new Error('参数名称无效');
      out.push({ kind: 'parameter', value: match[0] }); i += match[0].length + 1; continue;
    }
    const word = input.slice(i).match(/^[\p{L}_][\p{L}\p{N}_]*/u);
    if (word) { out.push({ kind: 'word', value: word[0] }); i += word[0].length; continue; }
    const number = input.slice(i).match(/^\d+/);
    if (number) { out.push({ kind: 'number', value: number[0] }); i += number[0].length; continue; }
    if ((char === '/' && ['/', '*'].includes(input[i + 1])) || (char === '*' && input[i + 1] === '/')) throw new Error('此受控查询子集不支持注释');
    out.push({ kind: 'symbol', value: char }); i++;
  }
  return out;
}

const forbidden = new Set('CREATE MERGE DELETE DETACH SET REMOVE DROP ALTER RENAME GRANT DENY REVOKE LOAD CSV CALL APOC DBMS FOREACH USE UNION SHOW TERMINATE START STOP INSERT FINISH PROFILE EXPLAIN'.split(' '));
const functions = new Set('count collect size labels type elementid id tolower toupper tostring coalesce properties nodes relationships length exists head last abs min max sum avg distinct'.split(' '));
const keywordsBeforeParen = new Set('MATCH WHERE AND OR NOT IN RETURN WITH DISTINCT OPTIONAL'.split(' '));

export function requestedLimit(spec: QuerySpec, maxRows: number): number {
  const match = spec.cypher.trim().match(/\bLIMIT\s+(\$[A-Za-z_][A-Za-z_0-9]*|\d+)\s*$/i);
  if (!match) return maxRows;
  return match[1].startsWith('$') ? Number(spec.parameters[match[1].slice(1)]) : Number(match[1]);
}

export function validateReadQuery(spec: QuerySpec, schema: GraphSchema, limits: Limits): ValidationResult {
  const errors: ValidationResult['errors'] = [];
  const add = (code: string, message: string) => { if (!errors.some(e => e.code === code && e.message === message)) errors.push({ code, message }); };
  if (!spec || typeof spec.cypher !== 'string' || !spec.cypher.trim()) return { valid: false, errors: [{ code: 'EMPTY_QUERY', message: '查询不能为空' }], warnings: [] };
  if (!spec.parameters || typeof spec.parameters !== 'object' || Array.isArray(spec.parameters)) return { valid: false, errors: [{ code: 'INVALID_PARAMETERS', message: 'parameters 必须为对象' }], warnings: [] };
  if (spec.cypher.length > 12000) add('QUERY_TOO_LARGE', '查询长度超过 12000 字符');
  let tokens: Token[];
  try { tokens = tokenize(spec.cypher); } catch (error) { return { valid: false, errors: [{ code: 'INVALID_SYNTAX', message: (error as Error).message }], warnings: [] }; }
  if (tokens[0]?.kind !== 'word' || tokens[0]?.value.toUpperCase() !== 'MATCH') add('READ_ONLY', '仅允许以 MATCH 开始的只读查询');
  if (!tokens.some(t => t.kind === 'word' && t.value.toUpperCase() === 'RETURN')) add('INVALID_SYNTAX', '查询必须包含 RETURN');
  const properties = new Set(Object.values(schema.nodeProperties).flat());
  const nodeNames = new Set(schema.nodeLabels);
  const relationNames = new Set(schema.relationshipTypes);
  const stack: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'word' && forbidden.has(token.value.toUpperCase())) add('READ_ONLY', `不允许操作 ${token.value}`);
    if (token.kind === 'symbol') {
      if ([';', '{', '}'].includes(token.value)) add('UNSUPPORTED_SYNTAX', '禁止多语句、子查询和映射字面量；属性过滤请使用 WHERE 与参数');
      if (token.value === '(' || token.value === '[') stack.push(token.value);
      if (token.value === ')' || token.value === ']') {
        const expected = token.value === ')' ? '(' : '[';
        if (stack.pop() !== expected) add('INVALID_SYNTAX', '括号不匹配');
      }
      if ([':', '|'].includes(token.value) && ['word', 'identifier'].includes(tokens[i + 1]?.kind)) {
        const relation = stack[stack.length - 1] === '[';
        if (!(relation ? relationNames : nodeNames).has(tokens[i + 1].value)) add('UNKNOWN_SCHEMA', `Schema 中不存在${relation ? '关系类型' : '节点标签'} ${tokens[i + 1].value}`);
      }
      if (token.value === '.' && ['word', 'identifier'].includes(tokens[i + 1]?.kind)) {
        if (tokens[i + 2]?.value === '(') add('UNSUPPORTED_FUNCTION', '禁止命名空间函数');
        else if (!properties.has(tokens[i + 1].value)) add('UNKNOWN_PROPERTY', `Schema 中不存在节点属性 ${tokens[i + 1].value}`);
      }
      if (token.value === '*' && stack.includes('[')) {
        let j = i + 1; let part = '';
        while (j < tokens.length && tokens[j].value !== ']') part += tokens[j++].value;
        const range = part.match(/^(?:(\d+)\.\.)?(\d+)$/);
        if (!range) add('UNBOUNDED_PATH', '变长路径必须使用固定且有上界的长度，例如 *1..4');
        else if (Number(range[2]) > limits.maxDepth || (range[1] && Number(range[1]) > Number(range[2]))) add('PATH_LIMIT', `路径上界不得超过 ${limits.maxDepth}`);
      }
    }
    if (token.kind === 'parameter') {
      if (!Object.hasOwn(spec.parameters, token.value)) add('MISSING_PARAMETER', `缺少参数 ${token.value}`);
      if (token.value.startsWith('__cg_')) add('RESERVED_PARAMETER', '参数名前缀 __cg_ 为系统保留');
    }
    if ((token.kind === 'word' || token.kind === 'identifier') && tokens[i + 1]?.value === '(' && tokens[i - 1]?.value !== ':' && !keywordsBeforeParen.has(token.value.toUpperCase())) {
      if (!functions.has(token.value.toLowerCase())) add('UNSUPPORTED_FUNCTION', `不允许函数 ${token.value}`);
    }
  }
  if (stack.length) add('INVALID_SYNTAX', '括号未闭合');
  if (!/\bLIMIT\s+(\$[A-Za-z_][A-Za-z_0-9]*|\d+)\s*$/i.test(spec.cypher)) add('RESULT_LIMIT', '查询必须以 LIMIT 整数或参数结束');
  const limit = requestedLimit(spec, limits.maxRows);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > limits.maxRows) add('RESULT_LIMIT', `LIMIT 必须为 1–${limits.maxRows} 的整数`);
  if (!Number.isFinite(limits.timeoutMs) || limits.timeoutMs < 1 || !Number.isSafeInteger(limits.maxRows) || limits.maxRows < 1 || !Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 1) add('INVALID_LIMITS', '执行限制配置无效');
  return { valid: errors.length === 0, errors, warnings: [] };
}

export function validationError(result: ValidationResult): Error & { code: string } {
  return Object.assign(new Error(result.errors.map(e => e.message).join('；')), { code: result.errors[0]?.code ?? 'VALIDATION_FAILED' });
}
