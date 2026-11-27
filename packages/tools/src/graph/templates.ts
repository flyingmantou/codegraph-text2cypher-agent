import type { Category } from '../../../../contracts/index.ts';

/** The offline adapter deliberately implements only this documented Cypher subset. */
export const QUERY_TEMPLATES: Record<Category, string> = {
  entity: 'MATCH (n) WHERE n.`名称` = $name OR n.`标识` = $entityId RETURN n LIMIT $limit',
  filter: 'MATCH (n:`服务`) WHERE n.`名称` CONTAINS $keyword RETURN n LIMIT $limit',
  api: 'MATCH p=(a:`接口`)-[:`入口`]->(m:`方法`)-[:`属于`]->(s:`服务`) WHERE s.`名称` = $name OR s.`标识` = $entityId RETURN p LIMIT $limit',
  downstream: 'MATCH p=(m:`方法`)-[:`调用`|`RPC调用`*1..4]->(target:`方法`)-[:`属于`]->(s:`服务`) WHERE m.`名称` = $name OR m.`标识` = $entityId RETURN p LIMIT $limit',
  impact: 'MATCH p=(caller:`方法`)-[:`调用`|`RPC调用`*1..4]->(m:`方法`) WHERE m.`名称` = $name OR m.`标识` = $entityId RETURN p LIMIT $limit',
  mq: 'MATCH p=(m:`方法`)-[:`发布`]->(x:`交换机`)-[:`路由`]->(q:`队列`)-[:`消费`]->(consumer:`方法`)-[:`属于`]->(s:`服务`) WHERE m.`名称` = $name OR m.`标识` = $entityId RETURN p LIMIT $limit',
  combined: 'MATCH p=(m:`方法`)-[:`调用`|`RPC调用`|`发布`|`路由`|`消费`*1..4]->(target:`方法`)-[:`属于`]->(s:`服务`) WHERE m.`名称` = $name OR m.`标识` = $entityId RETURN p LIMIT $limit',
};

export function normalizeCypher(cypher: string): string {
  return cypher.trim().replace(/\s+/g, ' ');
}

export function templateCategory(cypher: string): Category | undefined {
  return (Object.keys(QUERY_TEMPLATES) as Category[]).find(key => normalizeCypher(QUERY_TEMPLATES[key]) === normalizeCypher(cypher));
}
