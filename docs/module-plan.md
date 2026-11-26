# 模块计划与实施约定

日期：2026-11-25。本计划先于本轮模块实现确定，沿用已有原型中可复用的图谱适配与界面逻辑，但不改写既有开发历史。四名同学分别接收模块，审查、验收并提交。

| 模块 | 负责人 | 独占目录 | 验收目标 |
|---|---|---|---|
| Harness 与集成 | 易震宇 | packages/harness，根配置、contracts、docs、scripts | Skill驱动流程、模型接入、工具调度与运行约束、Web API、dsh插件与集成 |
| Skill、示例与评测 | 徐家乐 | packages/skills | 领域流程与路由策略、35组七类示例、语义词表、任务回归与独立评测规范 |
| MCP、工具与数据 | 严喆瀚 | packages/tools | Schema/实体/示例检索、校验票据、执行、证据合并、MCP stdio与Neo4j适配 |
| Web | 王雯迪 | apps/web | 单题/批量/难度、澄清、示例管理、子图、执行记录、报告导出 |

## 接口先行

contracts/index.ts 版本2.0.0是共同类型依据。工具实现导出 createToolService(config: ToolServiceConfig): Promise<ToolService>；Skill导出 loadSkillBundle(): Promise<SkillBundle>；Harness导出 createHarness({tools,skill,config,limits}): AgentPort；Web只使用HTTP API。

工具名称：get_schema、resolve_entities、search_examples、validate_query、execute_query、merge_results、export_report。

- get_schema({}) → GraphSchema。
- resolve_entities({term}) → GraphNode[]。
- search_examples({question,category?,verifiedOnly?}) → ExampleSearchResult[]。
- validate_query({query:QuerySpec}) → TicketValidation；有效时签发与session/实体/限制绑定的ticket。
- execute_query({ticket}) → ExecutionEvidence；内部再次校验；不接受任意未经校验的query。
- merge_results({executionIds}) → ExecutionEvidence；只合并同会话实际执行的证据，按节点/边ID去重，保留来源。
- export_report({question,executionIds}) → {markdown:string}；仅引用本会话真实执行结果。

ToolContext带sessionId、limits、signal、selectedEntityId；返回ToolReply，不在错误中暴露凭据。工具同一服务实例提供examples维护接口给HTTP层使用，模型工具默认只读。

## 模块间依赖

工具模块不导入harness或web；Skill模块不导入harness业务实现；runtime通过公开入口组装模块。测试数据和参考问答由Skill模块持有，工具测试自带小型seed。知识库与评测数据分开，最终课程评测在真实图谱上冻结。

Web HTTP：GET /api/health、GET /api/schema、POST /api/query、POST /api/batch、GET/POST /api/examples、DELETE /api/examples/:id、POST /api/examples/verify、GET /api/runs/:id/report。QueryResponse沿用v1字段，新增plan、evidenceIds和skillVersion/runtime来源。GET /api/health增加skillVersion、runtime、toolNames、retrievalMode。

## 实施与合并

1. 固定契约和目录归属。
2. 四模块按接口独立实现与自测。
3. 集成、跨模块契约检查、完整回归和打包重组验证。
4. 每人收到自己模块的提交包；使用真实身份提交，合并后重跑完整验收。

四个ZIP文件集合必须无重复、无缺失，并恰好重建交付项目。文件职责按目录决定，不按完工后文件数平均分配。
