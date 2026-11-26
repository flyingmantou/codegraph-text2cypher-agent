# 易震宇：Harness 与集成交接

你负责 packages/harness/，以及根工程配置、contracts/、docs/、scripts/。精确清单由本包外层 HANDOFF-yi-zhenyu.json 和根 ownership.json 给出。先读根AGENTS和docs/module-plan.md。

## 模块交付

- 独立工作台runtime按版本化Skill阶段运行；真实模型规划/生成；实体确认、预算、超时、修复、来源和用量记录。
- dsh插件直接注册7工具及Skill，设置guard/状态/可信确认接口；不再转发整条后端查询。
- HTTP服务与模型配置、共享接口、集成检查、四包打包、CI及Docker说明。

真实dsh宿主尚未加载；原生dsh UI的歧义确认需对接controller。项目Web使用standalone-workbench，不能把它说成已运行的dsh Web。API真实请求已尝试但DNS失败；在线成功仍待验收。课程Neo4j未提供。

## 接收与提交

1. 在完整四包合并目录运行 npm test、npm run check:integration、npm run verify:examples、npm run check:ownership。
2. 在已有GitHub仓库新建自己的功能分支，仅复制本人文件；先比较仓库README及他人修改，勿覆盖用户已有工作。
3. 公共contracts与根工程基础先合入集成分支；B/C/D模块随后接入；本模块runtime依赖B/C，完整运行须等模块齐全。
4. `node scripts/check-ownership.ts --owner yi-zhenyu --list` 获取文件，按明确路径暂存；`--staged`检查。包外HANDOFF JSON不提交。
5. 按本人身份和实际时间提交，不伪造开发或评审；让同学实际审查后合并。当前包没有执行Git写操作。

需要补验：正常终端启动npm start并浏览器操作；运行scripts/test-live.command获取真实API响应；按dsh/README加载宿主；提供课程图谱后验证Schema和示例。保留真实版本和失败记录。
