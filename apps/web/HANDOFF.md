# 王雯迪的 Agent 交接

你接收的是 Web 交互与可视化模块，独占 `apps/web/`。先阅读项目根 `AGENTS.md`、`docs/module-plan.md` 和本模块 README。

## 文件范围

只审查、修改和提交本目录：

```text
apps/web/
  HANDOFF.md
  README.md
  package.json
  public/
    index.html
    styles.css
    app.js
    api-client.js
    helpers.js
  tests/
    client.test.js
```

公共契约、后端接口、任务 Skill、示例与评测数据、MCP 和数据库工具由相应成员维护。本模块不另建模型调用或查询执行通道。

## 接收后执行

1. 在完整项目或仅本模块目录运行本模块测试，检查界面功能与请求契约。
2. 与 Harness 合并后启动 HTTP 服务，按 README 演示步骤补做浏览器验收，记录真实通过项与问题。
3. 接入已有 Git 仓库时，先检查当前分支和未提交修改；比较已有同名文件，不覆盖其他人的工作。
4. 在当前操作者要求提交后，用其已有 Git 身份与实际时间提交本模块，不改写为其他成员身份，不生成虚构的评审记录。

建议分支 `feat/web-workbench`；以下是提交前检查命令，不表示本包已执行 Git 操作：

```sh
git status --short
node --test apps/web/tests/*.test.js
git diff -- apps/web
git add -- apps/web
git diff --cached --name-only
git diff --cached
```

如果暂存清单包含 `apps/web/` 外的路径，先核对原因。不要使用 `git add .` 或 `git add -A`。

## 联调要点

- Harness 必须从 `apps/web/public/` 提供静态资源。
- 单题、批量请求包含 `complexity`；实体澄清要保留原问题和原复杂度。
- 示例检索模式为 `lexical`、`semantic`、`hybrid`，由服务端实现，前端不计算检索分数。
- 图谱和生成来源、Skill 版本、runtime 均显示服务端值，不以页面可打开作为真实模型或 dsh 验收证据。
- 只读、校验票据、预算和结果真实性由后端保障，界面展示对应状态。
- 当前浏览器端到端验收尚待实际服务运行；本模块已通过的 9 项测试属于纯函数与 HTTP 传输契约测试。

每次提交说明写清楚具体行为、执行过的验收和剩余问题。模块源码由 AI 辅助准备；接收者应理解、检查并维护实际提交内容。
