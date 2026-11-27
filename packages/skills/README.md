# 领域 Skill、示例知识库与任务评测

负责人：徐家乐。此目录完整承担领域策略、示例内容、语义词表与任务评测；存储、检索计算和数据库访问由工具模块实现，通用运行机制由 Harness 实现。

## 公开入口

`src/index.ts` 导出 `loadSkillBundle()` 与离线 `planDemo()`。共同类型见根目录 `contracts/index.ts`。

`loadSkillBundle` 返回版本化 Skill 文本、固定阶段表、demo 计划函数和示例/词表的绝对路径。真实 dsh 可注册 Skill 原文；本地运行器使用阶段表。模型真实规划不调用 `planDemo` 冒充模型结果。

`planDemo` 覆盖七类规则问法，combined 产生 downstream 与 mq 两个分支。它不会执行数据库查询，也不依赖工具或 Web 内部代码。缺少明确实体名时抛 `UNSUPPORTED_DEMO_QUERY`，危险写请求抛 `UNSAFE_REQUEST`。

## 内容与检索

- `SKILL.md`：总控、实体澄清、示例参考、生成、校验票据、复杂分解、修复、证据合并与报告流程。
- `workflow.json`：版本与阶段契约。
- `data/examples.seed.json`：35 组七类人工 fixture 示例，初始均未验证。真实图谱迁移后必须修改、执行和人工复核，不能沿用 fixture 的通过证据。
- `data/semantic-concepts.json`：人工领域同义概念词表，供工具做稀疏概念向量及词项混合检索。它是可解释的领域语义归一，不是神经 embedding 模型。
- `data/evaluation.dev.json`：12 项开发回归，检查状态、确切节点/服务集合、消歧候选及联合分支。
- `data/evaluation.course.template.json`：独立 30 题的未填写题位，10 简单、12 中等、8 困难；不是已冻结或已经通过的评测集。

## 验证与运行

在合并后的仓库根目录使用 Node.js 24：

```sh
node --test packages/skills/tests/*.test.ts
node packages/skills/scripts/evaluate.ts
```

第二条命令需要已启动的本机 HTTP 服务，默认为 `http://127.0.0.1:3000`，可通过 `CODEGRAPH_BASE_URL` 配置本机地址。结果保存根目录 `.runtime/evaluation-dev.json`。不访问模型 API、不持有模型 Key；是否调用模型由运行服务配置决定。开发回归要求 fixture/demo，错误模式会导致断言失败。

评测函数 `evaluateSuite(suite, run)` 可注入实际运行器，在受限环境使用真实 handler 的内存传输做集成检查；应在报告中另行标注传输方式，不能称为浏览器/端口测试。

## 交付边界

开发回归只验证已知人工图谱行为，不是独立 30 题，也不是模型语义准确率。报告保留 `semanticReview=pending-human-review` 和 `humanSemanticAccuracy=null`，人工复核后另填正式评测表。当前演示的联合分析是源方法同步依赖与其直接 MQ 发布链的两个有界分支，不包含无限跨消息传播。

详细测试与对照方案见 `docs/evaluation.md`，接收与提交见 `HANDOFF.md`。
