# 严喆瀚的 Agent 交接

你负责 `packages/tools/` 的全部文件，目录边界在本轮实现之前已确定。先读根 `AGENTS.md`、`docs/module-plan.md`、`contracts/index.ts` 和本模块 README。本交接不授权自动提交或推送。

## 收包与依赖

四包合并到同一项目根目录。工具模块源码仅依赖公共契约；单元测试使用本模块自带测试 seed 和词表，不依赖其他模块内部代码。运行完整 MCP 或 Web 时，由 Skill 模块提供实际 35 组示例和领域词表。旧版 `src/graph` 的图适配与验证规则在此迁移重构；不要再把旧目录整份复制进新项目。

## 本人的提交范围

仅提交 `packages/tools/`。该目录包含图访问、票据门控、示例存储检索、执行证据、MCP stdio、模块测试和说明。公共 `contracts/`、Harness、Skill 数据与 Web 不属于本人提交范围。新增或变更工具协议先与 Harness 和 Skill 负责人协调。

## 必须理解与验收

1. 执行票据必须通过 `validate_query` 获得；执行内部仍然重校验，不能增加直接执行任意模型 Cypher 的后门。
2. 票据不能跨会话、实体或预算复用，执行后不可重放；结果证据亦不能跨会话合并。
3. `search_examples` 默认只使用本图谱来源与版本验证通过的条目，编辑立即撤销旧验证。
4. `semantic` 是领域概念向量，不是神经 embedding。未知表达的质量应根据实际案例评价。
5. fixture 数据是人工样例，Neo4j 代码和真实库验收应分别记录。
6. 在完整项目根运行 `node --test packages/tools/tests/*.test.ts`；另按 README 用 MCP 客户端验收协议，真实库就绪后验证只读连接及目标 Schema。

## 提交操作

先阅读当前分支和未提交变化，比较同名文件，保留他人改动。得到当前操作者明确提交指令后，仅暂存：

```sh
git add -- packages/tools
git diff --cached --name-only
git diff --cached
```

使用当前操作者的真实 Git 身份与实际提交时间。提交描述说明行为和实测结果，不把未接入真实数据库写成已完成验收。完整项目的合并、部署与四包重组检查由集成负责人统筹。
