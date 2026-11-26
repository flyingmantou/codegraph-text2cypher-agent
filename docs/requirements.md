# 需求、来源与中期范围

依据小组开题PPT第4、6–15、18–19页，以及《选题.pdf》第2页。后者为课件整理指南，不是老师原始2号PPT；当前未读取原课件，未把其他选题的模型与框架限制套用到本题。

中期主线为T1单题闭环、T2至少30例及维护检索、Web和领域工具／运行控制。T3提供有界双分支原型；最终独立30题、真实课程图谱适配与机制对照仍需后续完成。实现、离线实测、在线验收分别记录。

| 需求 | 责任 | 实现／验收入口 | 当前边界 |
|---|---|---|---|
| F1 三档单题、批量上传 | Web，Harness支持 | apps/web；HTTP query/batch | 最多10题；批量按题运行 |
| F2 Schema、实体消歧、提示及生成 | Tools、Skill、Harness | schema/entity工具、Skill流程、model.ts | 真实模式调用模型；demo为明确规则 |
| F3 查询校验和受控执行 | Tools，Harness强制门控 | validate_query→一次性ticket→execute_query | fixture只支持七种规范模板；Neo4j适配未在线验收 |
| F4 下游、反向、MQ及RPC/MQ联合 | Skill策略、Harness调度、Tools合并 | combined分为downstream和mq两次实际执行 | 有界双分支，暂非任意多层复杂任务规划 |
| F5 子图、总结、过程和报告 | Tools证据、Harness追踪、Web展示 | ExecutionEvidence、QueryResponse、Markdown | 总结按实际结果确定性组织，不凭空补结论 |
| F6 示例CRUD、分类、检索 | Skill内容、Tools实现、Web交互 | 35例、examples仓库、三检索模式 | 领域概念词义归一与向量相似度，非神经embedding |
| T2 七类≥30有效示例 | Skill主责、Tools验证 | 35条覆盖entity/filter/api/downstream/impact/mq/combined | fixture验证35/35；课程图谱需重写并复验、人工核语义 |
| T4 项目Skill和dsh扩展 | Skill与Harness | 版本化SKILL、细粒度dsh工具、强制guard | 假宿主贯通已测，真实dsh加载及原生UI确认适配待验 |
| 独立30题10/12/8 | Skill主责，Tools复核答案 | course.template.json、evaluation.md | 只交编写模板与框架，未填答案、未冻结，不冒充已评测 |
| 对照与指标 | Skill评测、Harness计量 | schema-only／示例／修复对照设计 | 真实模型同条件对照未完成 |
| 工程文档部署协作 | Harness统筹，四人模块交付 | README、CI、Docker、四包清单 | CI远程/Docker未运行；无自动Git提交或虚构评审 |

## 非功能约束

1. 只读：禁写入、过程调用、任意多语句；数据库账号只读与工具校验相互补充。
2. 资源：路径深度、行数、总时限、修复次数、模型和工具次数都有上限；断连传播取消。实际预算进入模型生成及修复提示。
3. 证据：票据绑定会话、所选实体和限制；执行再次验证。merge/report只引用同一会话的真实证据。
4. 追溯：保留图谱来源／版本、模型名、Skill版本、运行器类型、查询／参数、工具阶段、已知token及未知成本。
5. 状态：success、empty、needs_clarification、rejected、failed、partial；部分执行或后续报告失败保留已有结果，避免将不完整结果当完整成功。
6. 维护：各模块独占目录与测试，通过公共契约协作。示例版本与最终评测隔离，修改后验证失效。
7. 凭据：只经服务端环境或隐藏终端输入传入，不进入源代码、运行证据、Web或ZIP。

## 必须区分的验证层次

人工图谱用于验证实现与异常流程；真实模型API验证生成与协议；真实Neo4j验证课程数据适配；真实dsh宿主验证框架加载；浏览器验证真实页面交互。任何一层成功都不替代其他层。完整记录见validation.md。
