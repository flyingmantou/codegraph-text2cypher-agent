# Harness 模块

负责人：易震宇。src/runner.ts 通过公共ToolService与SkillBundle执行版本化阶段；src/model.ts提供DeepSeek/GLM JSON适配；src/http.ts提供Web接口；src/config.ts提供服务端配置。dsh/是真实宿主插件入口与适配契约。

本地工作台与dsh宿主是两条运行路径，共享领域Skill与工具实现。前者可无外部依赖演示；后者使用dsh模型、会话及工具调度。来源必须如实区分，详见dsh/README.md。

运行 `node --test packages/harness/tests/*.test.ts packages/harness/dsh/tests/*.test.ts`。runner集成测试依赖完整B/C模块，HTTP注入测试与dsh假registry测试覆盖接口边界。使用模拟模型响应的测试不算真实API通过。

本模块的跨模块集成文档由根docs维护。逐文件交接见HANDOFF.md。
