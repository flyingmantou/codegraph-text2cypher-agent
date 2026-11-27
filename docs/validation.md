# 中期原型验证记录

记录日期：2026-11-25。只列实际执行结果；本次没有提交、推送Git，也未创建他人作者记录或评审记录。

| 检查 | 实际结果 | 证据／复现命令 |
|---|---|---|
| 模块与集成自动化 | 68通过，0失败，0跳过 | tests-summary.json；`npm test` |
| 示例验证 | 人工fixture 35/35通过 | integration.json |
| 开发任务回归 | 12/12满足状态与实体／服务集合断言 | integration.json；`npm run check:integration` |
| Web静态文件及HTTP接口 | 页面资源、health/schema、批量及Markdown均通过进程内handler检查 | integration.json |
| MCP stdio | 真实子进程完成initialize、tools/list、validate、execute | Tools模块mcp.test.ts |
| dsh插件 | 9项假宿主契约测试，包含实际Tools与Skill的fixture贯通 | Harness dsh/tests/plugin.test.ts |
| TypeScript语法 | syntax.json记录扫描文件数，0错误 | 语法转译，不是完整类型检查 |
| 本机端口 | EPERM，当前环境不允许listen | environment.json |
| DeepSeek Flash与GLM-5.3真实API | 已用用户提供凭据尝试；ENOTFOUND，未收到HTTP响应 | live-api-report.json |
| 四包归属与重建 | 由release.py检查每文件唯一归属、无遗漏、SHA-256一致 | 外层release-manifest.json与verify-only |

上表JSON均在本目录 `validation/` 子目录内。真实API记录保留当时已授权的旧5.4探测历史；用户随后要求只使用5.3，当前脚本已移除5.4，不再重试。

68项中：Harness/HTTP/runner/dsh 27项，Skill 9项，Tools 23项，Web 9项。模型协议测试使用模拟响应；dsh测试使用模拟宿主，不计为真实模型或宿主在线通过。12题开发回归的模型调用数为0，不能称为模型准确率；人工语义准确率保持null。

## 已检查的关键行为

- 精确实体优先、真正同名澄清、非法选择拒绝。
- 七类查询实际遍历人工图，修改图边后结果随之变化。
- RPC/MQ两分支分别执行、按证据合并，保留不同通信类型与路径。
- 只读与Schema检查、票据一次性／过期／会话绑定、执行时重校验。
- 假证据和跨会话证据不能用于合并或报告。
- 取消传播覆盖模型、图谱、示例检索与维护队列；整库验证取消不提交半成品。
- 示例修改后撤销验证，旧图谱版本不会被选入生成提示。
- 领域概念检索能匹配没有表面词重合的同义表达；明确不声称神经embedding。
- 模型有限修复、预算上限、JSON异常与已返回token记账。
- 报告或后续步骤失败保留已执行结果并标partial，不冒充全任务成功。
- Web源信息、参数、图节点身份、批量上传、API输入及报告下载契约。

## 尚未完成的外部验收

1. **真实API响应**：DNS失败发生在鉴权之前，不能判断Key有效性，也不能推断模型效果或实际账单。需要在可联网的正常终端运行 `zsh scripts/test-live.command`；默认只测试DeepSeek Flash和GLM-5.3。密钥隐藏输入、不写文件。
2. **课程Neo4j**：未提供连接和数据。人工图谱标签及示例不能替代课程数据，需按真实Schema重编、复核和验证。
3. **真实dsh宿主**：插件代码与官方接口对照、契约测试已完成；尚未安装加载。原生dsh UI还需要对接controller的可信实体确认；模型不能自行解除歧义锁。
4. **真实浏览器与socket**：环境禁止本机监听；已测试真实HTTP处理函数和静态资源，尚未完成浏览器端实际操作。
5. **Docker、CI远程、完整类型检查**：提供配置，但未在本环境执行Docker构建或GitHub CI；未安装Node类型依赖，因此仅记录语法和实际执行测试。
6. **独立30题及对照**：模板未填、未冻结；需真实图谱人工答案，最终评测不可进入示例库。

## 中期演示步骤

1. 合并四包，运行 `npm test`、`npm run verify:examples`、`npm run check:ownership`。
2. 正常终端启动 `npm start`，打开localhost界面，确认人工图谱／规则模式和独立工作台标记。
3. 展示getAllFood查询和示例参考，查看Cypher、参数、执行票据阶段、结果及报告。
4. 查询getOrder，选择候选后继续；再输入危险写请求，确认拒绝。
5. 修改示例，观察验证撤销；重新验证，尝试语义/关键词检索。
6. 查询placeOrder RPC与MQ联合，展示两个分支、两次执行和合并证据。
7. 上传两题批量文本，导出Markdown，检查状态、来源和限制说明。
8. 配置真实模型后重复上述查询，保留实际API、token与耗时记录；接课程图谱和dsh后的验收分别记录。
