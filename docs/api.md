# API 与模块契约 2.0.0

权威类型：`contracts/index.ts`。字段使用camelCase；稳定错误码为UPPER_SNAKE_CASE。

## 模块接口

- Skill：`loadSkillBundle()` 返回版本化流程、指令、规则演示策略和数据路径。
- Tools：`createToolService(config)` 返回工具定义、call、示例仓库及close；运行器只能通过其公开入口访问能力。
- Harness：`createHarness({tools,skill,config,limits})` 返回AgentPort。
- HTTP：`createApplication(config)` 返回server、tools、agent、skill、close。
- dsh：`registerProjectPlugin(ctx,{tools,skill,limits})` 注册工具、Skill及guard，并返回可信宿主控制器。

## 工具接口

| 名称 | 参数 | 成功data |
|---|---|---|
| get_schema | {} | GraphSchema |
| resolve_entities | {term} | GraphNode[]；精确优先，真正同名仍多候选 |
| search_examples | {question,category?,verifiedOnly?,mode?} | ExampleSearchResult[]；mode为lexical/semantic/hybrid |
| validate_query | {query:{cypher,parameters,label?}} | TicketValidation；valid时含ticket |
| execute_query | {ticket} | ExecutionEvidence：executionId、query、result |
| merge_results | {executionIds} | 带sourceExecutionIds的ExecutionEvidence |
| export_report | {question,executionIds} | {markdown} |

统一返回 `{ok:true,data}` 或 `{ok:false,error:{code,message,retryable?}}`。调用上下文由可信宿主生成：sessionId、limits、selectedEntityId、signal。执行票据120秒、一次性，不能换会话、实体或有效预算使用。证据有效期15分钟，服务重启失效。MCP细则见Tools README，dsh名称前缀映射见dsh README。

## HTTP

| 方法与路径 | 输入 | 输出 |
|---|---|---|
| GET /api/health | 无 | readiness、模式、模型、Skill、runtime、toolNames、检索模式及预算；ready不证明模型可用 |
| GET /api/schema | 无 | GraphSchema |
| POST /api/query | {question,entityId?,complexity?} | QueryResponse |
| POST /api/batch | {questions:string[],complexity?} | {results:QueryResponse[]}，1–10题 |
| GET /api/examples | q、category、mode可选 | {examples,matches?,mode} |
| POST /api/examples | ExampleInput | 保存后的QueryExample，验证状态清除 |
| DELETE /api/examples/:id | 无 | {deleted} |
| POST /api/examples/verify | {} | VerificationReport；可取消，未完成整批不覆盖旧状态 |
| GET /api/runs/:id | 无 | 已保存QueryResponse |
| GET /api/runs/:id/report | 无 | text/markdown |

complexity=simple/medium/hard；question为1–2000字符，JSON请求体64KiB。示例字段id/question/category/complexity/cypher/parameters/description完整提交。最近100条运行记录留在当前进程，重启后失效。

QueryResponse保留status、summary、queries、result、trace、usage、examplesUsed、candidates、warnings、source；新增plan、evidenceIds、reportMarkdown。来源包括graph/model/graphVersion/modelName/skillVersion/runtime。模型用量可能不完整，不能把未知费用写成零。

HTTP仅接受本机Host与同源请求，无跨域放行；最多2个修改请求并行，默认60秒真实模型总时限。Docker绑定0.0.0.0需显式ALLOW_CONTAINER_BIND=1并将容器端口映射到宿主127.0.0.1。密钥不经Web请求传输。
