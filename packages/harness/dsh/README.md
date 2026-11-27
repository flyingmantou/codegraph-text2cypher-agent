# dsh 项目插件

本目录属于 Harness 模块（易震宇）。它把工具模块的七项能力和 Skill 模块的领域流程直接注册进 dsh，并提供强制执行策略。它不再提供“一次调用完成所有查询”的 `codegraph_query` 桥接。

## 两条运行路径

- 项目 Web 调用独立工作台 HTTP runtime，共享 `ToolService` 和 `SkillBundle`，来源应显示 `standalone-workbench`。它不是 dsh Web，也没有调用本插件的 controller。
- 本插件由真实 dsh 宿主加载，模型与会话由宿主运行。项目插件注册细粒度工具和 Skill，工具直接访问同一份领域实现，不经过项目 HTTP 查询端点。

当前证据为假宿主契约测试通过。真实 dsh 宿主尚未安装、加载和验收，不能把这些测试写成 dsh 端到端已通过。

## 公开入口

`registerProjectPlugin(ctx, { tools, skill, limits })` 接受公共 `ToolService`、`SkillBundle` 和 `Limits`，返回供可信宿主使用的 controller：

- `beginTask(agent, question?)`：开始新任务，清除旧票据、证据和状态；不暴露给模型。
- `confirmEntity(agent, entityId)`：仅在用户确实选择已返回候选后调用；错误 ID 被拒绝；不暴露给模型。
- `snapshot(agent)`：读取任务的工具次数、候选和证据 ID，供宿主交互展示。
- `dispose()`：撤销本插件的注册，不关闭调用方提供的 ToolService。

源码 overlay 入口为 `index.ts` 的 `apply(ctx, config)`，声明 `inject=['tools','skills']`。它加载完整项目的 Skill 和 ToolService，在 fixture 模式验证示例；插件卸载时关闭自己创建的 ToolService。数据库连接凭据只从服务端 `NEO4J_*` 环境变量读取。

## 模型可见工具

| dsh 名称 | 公共工具名称 | 主要参数 |
|---|---|---|
| `codegraph_get_schema` | `get_schema` | `{}` |
| `codegraph_resolve_entities` | `resolve_entities` | `{term}` |
| `codegraph_search_examples` | `search_examples` | `{question, category?, verifiedOnly?, mode?}` |
| `codegraph_validate_query` | `validate_query` | `{query:{cypher,parameters}}` |
| `codegraph_execute_query` | `execute_query` | `{ticket}` |
| `codegraph_merge_results` | `merge_results` | `{executionIds}` |
| `codegraph_export_report` | `export_report` | `{question,executionIds}` |

Skill 注册内容明确添加了名称映射。工具的参数 Schema 来自 Tools 模块，并投影成 dsh 支持的 JSON Schema 子集：为枚举补齐类型，长度与数组数量上限转成参数说明，其实际检查仍由 Tools.call 强制执行。其他未知 Schema 关键字会使加载失败，避免静默改变接口。工具返回结构化数据，dsh 渲染器再将值转换为 JSON 文本展示。执行阶段只接收校验票据，不接收未经校验的任意查询。

## 强制状态与可信确认

状态按宿主 `exec.agent` 隔离。同一任务必须先获取 Schema；查询必须持有本任务已签发的票据；合并和报告只能引用该任务真实执行产生的证据。Tools 模块还会再次检查票据与 session、实体和限制的绑定。

实体检索出现多个候选后锁住校验和执行。模型再次检索某个精确 ID、在参数中写入“已确认”或换一次 Schema 查询，都不能解除锁定。可信前端／宿主驱动须展示 `snapshot().candidates`，得到用户选择后调用 `confirmEntity()`。确认恢复执行时重新开始超时窗口，但不重置工具调用计数；同一任务中后续模型检索不能替换用户确认的实体。

本插件没有实现对 dsh 原生聊天消息的可靠人类选择解析，也没有改写其 UI。标准 overlay 中遇到歧义会明确停下；如果要在 dsh 界面继续，需要宿主适配代码接入上述 controller，或在项目独立 Web 中重新提交查询。不能把模型传来的布尔字段或普通工具参数当作可信确认。

`session/event` 的 `turn/start` 为后续宿主回合更新任务预算，并清除旧票据及证据；未解决的歧义会继续保留，不会自动视为用户已确认。首次调用没有 Agent 上下文时直接拒绝。

默认每个任务最多 24 次工具调用、60 秒执行窗口。调用超过预算时，模型不能通过重新读取 Schema 自行重置。`tools/execute` 包装融合并传递取消信号，结束后恢复宿主原 signal。插件只限制自己的工具，不修改其他 dsh 工具或用户权限。

这些是项目工具的运行限制。dsh 自身的模型步数、外层模型 token/费用、完整会话总预算仍由所选宿主配置负责，不能把本插件的工具计数冒称整个 dsh 会话成本。

## 宿主安装与验收

核对的源码接口版本及 Node 范围记录在 `upstream-contract.json`，观察版本为 `0.2.3-alpha.2`、Node `^24.22.3 || >=26.13.1`。它不是 npm 锁文件，也不证明该版本已发布或当前机器已安装。集成人员应选定官方源码版本，记录实际 commit 和 lockfile，使用同一发行线构建宿主。

1. 合并四个提交包，保留完整项目目录。插件从本项目公开入口导入 Tools 和 Skill，不能只复制本目录。
2. 按官方说明准备 dsh 源码 checkout 与依赖。在 `cordis.patch.example.yml` 的 `name` 中填写本项目 `packages/harness/dsh/index.ts` 的真实绝对路径。
3. 将示例 overlay 另存到本机文件，再运行宿主：

```sh
pnpm dsh web --patch /absolute/path/to/cordis.patch.yml
```

4. 配置课程允许的模型，确认项目 Skill 和七项工具已出现。先在 fixture 模式要求模型加载 `codegraph-text2cypher` Skill，再按 Schema、实体、示例、生成、校验、执行、报告的流程处理唯一实体问题。
5. 检查伪造票据、未执行证据、跨会话票据、歧义和取消用例确实被拒绝；确认源信息为人工图谱。之后接真实图谱，重新适配和验证示例。
6. 保存真实宿主版本、加载日志、工具列表、过程记录和验收结果。宿主未实际运行前保持“待验收”。

`Config` 可提供 `graphMode`、`dataDir`、`timeoutMs` 和 `maxToolCalls`。Key、数据库密码不放 overlay 或提交包。

## 契约测试

```sh
node --test packages/harness/dsh/tests/*.test.ts
```

测试使用假的 dsh registry／guard／hook 分发器，验证真实项目插件代码；不使用真实模型或数据库。覆盖七工具与 Skill 注册、Schema 转换、状态顺序、歧义锁、人工选择锁定、会话隔离、报告证据、预算重置边界、宿主回合事件、超时和取消。另有贯通用例加载真实 SkillBundle 和 ToolService，在人工图谱完成检索、校验、执行、报告和一次性票据重放拒绝；这仍属于假宿主集成测试。

## 官方依据

- [工具契约与执行管线](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md)
- [Skill 注册与加载](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md)
- [工具作者指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md)
- [插件扩展入口](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md)
- [源码版本及 Node 要求](https://github.com/deepseek-ai/deepseek-harness/blob/master/package.json)

上述链接指向 master，后续可能变化；实际部署以记录的源码版本和验收结果为准。
