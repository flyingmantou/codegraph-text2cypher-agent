import type { GraphNode, QuerySpec } from '../../../contracts/index.ts';
import { QUERY_TEMPLATES } from './graph/templates.ts';
export function entityScopeMatches(query: QuerySpec, entity: GraphNode, live: boolean): boolean {
  if (query.parameters.entityId !== entity.id || !entity.id) return false;
  if (!live) return Object.values(QUERY_TEMPLATES).includes(query.cypher) && query.parameters.name === '';
  // Mask literals and escaped identifiers before finding keywords; text in a
  // string or comment must never be mistaken for a WHERE filter.
  let code = '';
  for (let index = 0; index < query.cypher.length; index++) {
    const char = query.cypher[index];
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      code += ' __literal__ ';
      let closed = false;
      while (++index < query.cypher.length) {
        if (query.cypher[index] === '\\') { index++; continue; }
        if (query.cypher[index] === quote) {
          if (query.cypher[index + 1] === quote) { index++; continue; }
          closed = true; break;
        }
      }
      if (!closed) return false;
    } else if (char === '/' && ['/', '*'].includes(query.cypher[index + 1])) return false;
    else code += char;
  }
  if (/\b(?:OR|XOR|NOT|WITH|UNION|CALL|OPTIONAL)\b/i.test(code)) return false;
  const whereMatches = [...code.matchAll(/\bWHERE\b/gi)];
  if (whereMatches.length !== 1 || !/^\s*MATCH\b/i.test(code)) return false;
  const whereStart = whereMatches[0].index!;
  const prefix = code.slice(0, whereStart);
  if ([...code.matchAll(/\bMATCH\b/gi)].length !== 1 || prefix.includes(',')) return false;
  const body = code.slice(whereStart + 5).split(/\b(?:RETURN|ORDER|SKIP|LIMIT|MATCH)\b/i)[0].trim();
  const predicate = body.match(/^elementId\s*\(\s*([A-Za-z_]\w*)\s*\)\s*=\s*\$entityId\s*(?:$|\bAND\b)/i);
  if (!predicate) return false;
  return new RegExp(`\\(\\s*${predicate[1]}(?:\\s|:|\\)|\\{)`).test(prefix);
}
