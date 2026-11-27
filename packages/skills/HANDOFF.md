# 徐家乐的 Agent 交接

你负责且只提交 `packages/skills/`。该目录含领域 Skill、示例内容、语义词表、任务路由、评测数据与脚本、测试及本模块文档。先阅读根 `AGENTS.md`、`docs/module-plan.md` 和 `contracts/index.ts`，再核对本包文件。

## 与其他成员的接口

- 给 Harness：`loadSkillBundle()`，以及 `planDemo(question)` 的有限规则计划。不得把模型调用和通用超时控制重新放到本模块。
- 给工具模块：示例种子与 semantic-concepts JSON 的路径和内容。工具负责持久化、计算检索分数、验证与执行；本模块负责内容和使用策略。
- 给 Web：只提供任务分类、演示问题与效果验收约定；不直接调用前端内部函数。
- 接收 Harness 的任务结果做评测，使用公共 `QueryResponse`。

本包单独提交不表示整个项目已经可运行。需要先接入 Harness 包中的公共契约；完整开发回归还依赖工具、运行层与启动后的本机 HTTP 服务。

## 接收后的工作

1. 在完整合并副本中运行模块测试，理解 35 组示例、七类意图和 combined 两分支。
2. 检查 Skill、词表、数据和真实图谱是否一致；例子的初始 unverified 状态必须保留，执行验证后才可使用。
3. 运行 12 项 fixture 开发回归，保存真实结果；不把它写成模型准确率或独立 30 题评测。
4. 在课程图谱上填写 30 题模板，补参考 Cypher、结果、路径与人工复核，随后冻结，严禁回填到示例库。
5. 按评测规范设计对照，输出正确率、执行成功率、耗时、token/成本和失败分析。

验收命令：

```sh
node --test packages/skills/tests/*.test.ts
node packages/skills/scripts/evaluate.ts
```

## 提交操作

在自己的功能分支先比较已有内容，不覆盖同学改动。确认本模块修改与验收后，使用自己的 Git 身份和真实时间提交：

```sh
git status --short
git diff -- packages/skills
git add -- packages/skills
git diff --cached --name-only
git diff --cached
```

仅在当前操作者授权提交后创建提交或 PR。不要暂存 `.runtime/`、Key、他人模块或压缩包，不生成虚构评审记录。PR 说明实际功能、验证结果和尚未完成的真实环境验收。
