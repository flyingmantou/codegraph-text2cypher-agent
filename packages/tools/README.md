# MCP、领域工具与数据服务

负责人：严喆瀚。公开入口为 `src/index.ts` 的 `createToolService(config)`；公共类型位于 `contracts/index.ts`。本模块不依赖 Harness 或 Web 的内部实现。

本模块提供一份领域能力实现，供独立运行层、dsh 插件和 MCP stdio 使用。人工图谱默认可离线运行，Neo4j 通过官方驱动接入。示例内容与语义词表由 `packages/skills` 提供，工具模块负责存储、检索、验证和执行。

| 工具 | 输入 | 输出与约束 |
|---|---|---|
| `get_schema` | `{}` | 真实节点、关系、属性、来源和图谱版本 |
| `resolve_entities` | `{term}` | 实体候选列表；不把同名候选自动当成用户选择 |
| `search_examples` | `{question, category?, verifiedOnly?, mode?}` | 默认仅检索当前图谱版本验证通过的示例；mode 为 lexical、semantic 或 hybrid |
| `validate_query` | `{query:{cypher,parameters}}` | 校验结果；有效时产生一次性 `ticket` |
| `execute_query` | `{ticket}` | `ExecutionEvidence`，包括实际查询、结果和 `executionId` |
| `merge_results` | `{executionIds}` | 合并同会话证据，按记录、节点和关系 ID 去重，保留源证据 ID 与原始路径 |
| `export_report` | `{question,executionIds}` | 基于同会话真实证据生成 Markdown |

## 强制执行边界

- 每次调用带 `ToolContext`：`sessionId`、`limits`、可选 `signal` 和 `selectedEntityId`。
- 票据绑定会话、选定实体、图谱版本及实际执行限制，120 秒有效，仅能使用一次。变更限制或实体后应重新校验。
- 执行不接受任意 Cypher 参数，必须引用服务端保存的票据，且执行前重新校验。
- 选定实体时必须在查询中精确约束该实体；人工模板要求 `entityId` 精确匹配且 `name` 为空。真实 Neo4j 使用保守的单 MATCH、单 WHERE、首项 elementId 等值约束。该限制可能拒绝一些合法但更复杂的 Cypher。
- 工具限制不得超过服务创建时的上限；外部取消和工具超时传递至查询执行。
- 执行证据保留 15 分钟，仅允许同会话读取、合并和导出；每个缓存最多 1000 项，进程退出后清除。
- 真实数据库必须使用数据库层只读账号。驱动 READ 模式不是数据库权限控制的替代物。
- 报告来自执行结果，但查询语义是否回答自然语言问题仍需 Skill 与评测核验。

## 示例维护与语义检索

`service.examples` 提供 `list/search/upsert/delete/verify`，供运行层管理接口使用；模型侧工具默认只读。编辑撤销验证状态，验证与编辑串行化并原子写入 `dataDir/examples.json`。维护接口均接受可选 AbortSignal：等待队列可取消，已取消的排队写入不会在稍后偷偷执行；整库验证把同一取消信号传至 Schema、校验和执行，并受一次操作总时限约束。取消验证时整批尚未提交的状态变更丢弃，保留原文件；原子 rename 是写入提交点，已完成提交不会因随后到达的取消而回滚。示例需非空执行才标记验证通过；这不是人工语义核对的替代。

`lexical` 使用英文词项、中文二元词 TF-IDF 余弦相似度。`semantic` 使用 Skill 提供的领域同义词表，将不同表达映射到共同概念，再计算稀疏概念向量余弦相似度。`hybrid` 为 0.6 × 概念得分 + 0.4 × 词项得分。结果保留两种分值。该方法是有限领域词义检索，不是预训练神经 embedding；对词表外表达不能保证语义泛化。

## 运行 MCP

在合并后的项目根目录：

```sh
node packages/tools/src/mcp.ts
```

MCP 客户端应以子进程形式启动上面的命令，按换行分隔的 JSON-RPC 2.0 交换消息。实现协议版本 `2025-06-18` 的 stdio 子集：`initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call` 和 `notifications/cancelled`。仅声明 tools 能力，不声称支持资源、提示模板、HTTP 传输或完整官方 SDK。标准输出只包含协议 JSON，启动错误写标准错误。单条输入上限 1 MiB。

可设置环境变量 `GRAPH_MODE`、`DATA_DIR`、`EXAMPLE_SEED_PATH`、`SEMANTIC_LEXICON_PATH`、`MAX_ROWS`、`MAX_DEPTH`、`TIMEOUT_MS`。默认示例和词表分别为 Skill 模块的 `data/examples.seed.json` 与 `data/semantic-concepts.json`。默认 MCP 数据目录 `.runtime/mcp`，不要与其他同时运行的服务共用同一可写示例库。

## Neo4j 接入

在根目录安装 `neo4j-driver@6`，配置 `GRAPH_MODE=neo4j`、`NEO4J_URI`、`NEO4J_USER`、`NEO4J_PASSWORD`、`NEO4J_DATABASE` 与 `GRAPH_VERSION`。不得提交凭据。模块使用 Schema 读取、EXPLAIN、只读事务和受控执行；整数参数转换为驱动 Integer，超大返回整数保留字符串。

人工 fixture 是 42 节点、50 关系的教学数据，仅支持七种规范模板，不是通用 Cypher 数据库。真实课程图谱仍需用实际连接验证 Schema、数据覆盖、查询语义与只读权限；本模块没有伪造这项验收。

## 验证

```sh
node --test packages/tools/tests/*.test.ts
```

测试覆盖七类实际图遍历、方向、图修改后结果变化、危险查询、实体绑定、票据重放/串会话/过期、证据归属与合并、概念检索和验证失效，以及真实子进程 stdio 初始化到查询执行。MCP 子进程检查不需要网络监听。

官方协议依据：[MCP stdio 传输](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)。驱动类型依据：[Neo4j JavaScript 类型映射](https://neo4j.com/docs/javascript-manual/current/data-types/)。
