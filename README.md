# 面向代码图谱的 Text2Cypher 查询智能体

高级软件工程中期原型，版本 0.2.0。四模块按公共契约协作：Harness 运行与集成、领域 Skill 与评测、MCP 工具与数据服务、Web 交互。目录分工与接口在本轮实现前确定，见 [模块计划](docs/module-plan.md)。源码由 AI 辅助实现，各成员接收后负责审查、验收、修改和提交；本包没有自动创建 Git 提交。

## 获取与启动

将四个提交包解压到同一目录，合并得到 `codegraph-text2cypher-agent/`。项目外层的 `HANDOFF-*.json` 是各包文件与校验清单，不提交到仓库。不要将上一版平铺目录原型与此版本混装。

安装 Node.js 24.22.3 或更新版本后，在项目根运行：

```sh
npm test
npm run verify:examples
npm start
```

打开 `http://127.0.0.1:3000`。默认人工图谱加规则演示不需要 npm install、数据库或 API Key。没有 npm 时可直接使用 `node scripts/test.mjs`、`node scripts/verify-examples.ts`、`node packages/harness/src/http.ts`。

## 模块及负责范围

| 负责人 | 模块目录 | 本人交接 |
|---|---|---|
| 易震宇 | `packages/harness/`，以及根配置、`contracts/`、`docs/`、`scripts/` | [Harness HANDOFF](packages/harness/HANDOFF.md) |
| 徐家乐 | `packages/skills/` | [Skill HANDOFF](packages/skills/HANDOFF.md) |
| 严喆瀚 | `packages/tools/` | [Tools HANDOFF](packages/tools/HANDOFF.md) |
| 王雯迪 | `apps/web/` | [Web HANDOFF](apps/web/HANDOFF.md) |

每个模块自身的源码、文档、测试、示例或界面资源放在模块目录内。唯一公共类型为 `contracts/index.ts`。分包规则在 `ownership.json`；同一源码文件只出现在一个包中。各自提交前阅读 [合并指南](docs/merge-guide.md)，仅暂存本人清单。

## 可以演示

- 简单、中等、复杂三档入口；单题与最多十题批量输入／文本上传。
- Schema、实体检索与同名澄清、示例检索、生成、校验票据、执行证据、报告。
- 35 组七类示例；新增、修改、删除、分类、验证与版本隔离。
- 关键词、领域概念语义及混合检索；概念来自版本化领域词表，不是训练得到的神经 embedding。
- RPC＋MQ 双分支实际执行及合并，保留通信关系与来源证据。
- Cypher、参数、表格、子图、执行阶段、模型和工具用量、Markdown 报告。
- 只读校验、单次执行票据、会话隔离、取消与超时、调用预算和有限修复。

演示问题：`查询 getAllFood 方法`、`getAllFood 方法依赖哪些下游服务`、`payOrder 的 MQ 发布消费完整链路`、`placeOrder 的 RPC 和 MQ 综合依赖是什么`、`查询 getOrder 方法`、`删除所有节点`。

## dsh 与独立工作台

`npm start` 启动可单独联调的工作台，页面标明 `standalone-workbench`。它加载同一 Skill、调用同一工具服务，真实模式通过 DeepSeek／GLM API 规划与生成。

`packages/harness/dsh/` 提供真实 dsh 插件入口：注册七个细粒度工具与 Skill，落实 Schema、票据、证据、预算及歧义锁。由 dsh 宿主承担模型与会话调度；并非把整条查询封装成一个工具。宿主加载与可信人工确认接入见 [dsh 说明](packages/harness/dsh/README.md)。当前已通过假宿主契约和真实工具贯通测试，尚未实际安装、启动 dsh。独立工作台不标为 dsh Web。

## 真实模型与数据库

复制 `.env.example` 为本地 `.env`。设置 `MODEL_MODE=deepseek` 和 DeepSeek Key，或 `MODEL_MODE=glm` 和 GLM Key。默认型号分别为 `deepseek-flash`、`glm-5.3`。密钥只保留在本机服务端，不放进 Git 或压缩包。

真实模型小样本测试：macOS 运行 `zsh scripts/test-live.command`，输入不回显；已有环境变量可运行 `npm run test:live`。此脚本最多尝试 16 次请求，测试实际规划、生成和人工图谱证据链。当前只测试 DeepSeek Flash 与 GLM-5.3。结果在 `.runtime/live-api-report.json`。

2026-11-25 已用用户提供的凭据尝试真实 API，DeepSeek Flash 与 GLM-5.3 均在 DNS 阶段返回 ENOTFOUND，没有 HTTP 或模型响应。该项未通过，详见 [验收记录](docs/validation.md)。

连接课程图谱前执行 `npm install neo4j-driver@6`，设置 `GRAPH_MODE=neo4j` 及只读连接账号、`GRAPH_VERSION`。读取实际 Schema，重新编写／验证课程示例，不能沿用人工图谱的35条通过记录。当前未提供课程数据库连接与数据。

## 验证与部署

```sh
npm test
npm run check:integration
npm run check:ownership
npm run evaluate:dev  # 服务启动后，执行真实HTTP开发回归
python3 scripts/release.py
python3 scripts/release.py --verify-only
```

自动检查与开发回归含人工图谱，不代表独立课程30题或模型准确率。正式30题模板在 Skill 模块中，仍须基于课程图谱填入人工参考答案并冻结。

可选容器：`docker build -t codegraph-midterm .`，再 `docker run --rm -p 127.0.0.1:3000:3000 codegraph-midterm`。镜像默认仅用于无需依赖的 fixture/demo；真实Neo4j须另行安装驱动、配置凭据。此交付环境未构建容器。

完整静态类型检查需要另装 TypeScript 与 Node 类型：`npm install --save-dev typescript @types/node` 后 `npx tsc --noEmit`。当前环境只完成语法转译与实际代码测试，没有宣称完整类型检查通过。

## 需求与接口

- [需求和中期范围](docs/requirements.md)
- [接口约定](docs/api.md)
- [命名与开发约定](docs/conventions.md)
- [模块边界及架构](docs/module-plan.md)
- [测试证据、限制和演示清单](docs/validation.md)
- [四包提交与合并](docs/merge-guide.md)
