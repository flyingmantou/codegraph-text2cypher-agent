# 四个模块包的接收、提交与合并

四包按照本轮实现前确定的模块边界生成。每个项目文件只出现在一个包中，四包文件集合恰好构成完整项目。目录职责与接口见 `module-plan.md` 和根目录 `ownership.json`。

## 收到的内容

| 成员 | 压缩包 | 项目内范围 | 首先阅读 |
|---|---|---|---|
| 易震宇 | `01-yi-zhenyu-harness.zip` | `packages/harness/`、公共契约、根配置、集成文档与脚本 | `packages/harness/HANDOFF.md` |
| 徐家乐 | `02-xu-jiale-skills.zip` | `packages/skills/` | `packages/skills/HANDOFF.md` |
| 严喆瀚 | `03-yan-zhehan-tools.zip` | `packages/tools/` | `packages/tools/HANDOFF.md` |
| 王雯迪 | `04-wang-wendi-web.zip` | `apps/web/` | `apps/web/HANDOFF.md` |

每包有两个顶层部分：`codegraph-text2cypher-agent/` 是可提交的项目文件，`HANDOFF-成员ID.json` 是该包的逐文件清单与 SHA-256，后者仅供交付核对，不提交到仓库。旁边的 `release-manifest.json` 同样是交付校验材料。

每个包可以独立审阅和提交，但公共类型、运行依赖和完整应用需要合并后才能具备。局部提交暂时不能启动整个系统，不等于该模块验收失败；应按该模块 HANDOFF 中的测试前提检查，不能编造缺失模块来假装完整应用通过。

## 每个人及其 Agent 的接收步骤

1. 将自己的包解压到新的临时目录，不要直接覆盖已有 Git 工作区。阅读模块 HANDOFF 和外层文件清单。
2. 在已有仓库中执行 `git status --short`，检查未提交改动及当前分支。保留现有修改，再建立本人的功能分支。
3. 逐文件比较交付包与仓库，只复制外层清单列出的项目文件。易震宇特别检查仓库中已存在的 `README.md`，按实际最终项目重写或合并；其他人不覆盖根文件。
4. 接入已合并的公共契约，按照模块说明运行测试，并审阅调用方接口。联调时可以在另一份完整项目副本中解压全部四包，但自己的提交仍限于本人文件。
5. 需要修改他人模块或公共契约时，说明影响并由对应负责人处理。不要把他人的文件顺手放入自己的提交。
6. 检查差异，逐路径暂存，核对暂存清单，再按当前操作者明确的提交指令创建提交。沿用真实 Git 身份、实际日期和真实测试记录，不设置其他成员的作者、不虚构评审或开发顺序。
7. PR 写明模块行为、接口依赖、实测命令与结果、尚未验证的外部条件；由另一位成员实际交叉评审后合并。

示例检查命令（以工具模块为例）：

```sh
git status --short
git diff -- packages/tools
node scripts/check-ownership.ts --owner yan-zhehan --list
# 根据上面的清单逐路径执行 git add -- <明确文件路径>
git diff --cached --name-only
node scripts/check-ownership.ts --owner yan-zhehan --staged
git diff --cached
```

禁止 `git add .` 或 `git add -A`。若根检查脚本尚未合入，先用包内 JSON 清单核对本人的文件；正式集成时再运行所有权脚本。暂存检查也会检查删除与重命名涉及的路径，不允许借重命名跨越模块边界。

建议分支名为 `feat/harness-runtime`、`feat/domain-skills`、`feat/codegraph-tools`、`feat/web-workbench`。分支名只是协作建议，不表示这些分支或提交已经创建。

## 合并次序

1. 易震宇先提交公共契约、根工程配置、所有权规则及必要规范，提供各模块共同的基础。该提交不宣称完整应用可运行。
2. 其余三人以该公共基础为依赖，并行提交领域 Skill、工具、Web；易震宇并行审查运行与 dsh 适配模块。
3. 将四个模块接入临时集成分支，处理接口差异并执行完整回归；修复由对应模块负责人提交。
4. 完整验收通过后合入主分支，保留真实评审与测试结果。模型、真实课程图谱和 dsh 宿主的在线验收单独记录，不能用 fixture 或模拟响应替代。

这样分工依据稳定接口和目录边界推进。根工程文件归集成人，不需要为了平均文件数而在四个人之间拆散运行层或公共类型。

## 交付包重组检查

在新的空目录分别解压四包，四个 `codegraph-text2cypher-agent/` 目录合并为一个项目；按清单应无同名项目文件需要覆盖。不要把旧版完整原型包混入本轮目录。

集成负责人从最终项目重新生成四包并核验：

```sh
node scripts/check-ownership.ts
python3 scripts/release.py
python3 scripts/release.py --verify-only
```

默认输出到项目旁的 `deliveries-v2/`，也可用 `--output-dir /absolute/path` 指定项目目录以外的位置。打包会检查每个文件恰有一个负责人，排除 Git 元数据、依赖、运行数据、凭据文件、日志和压缩包，并拒绝源目录中的符号链接。脚本不会运行 Git 写操作。

校验会核对压缩包和逐文件 SHA-256，把四包安全重组到临时目录，并逐字节比对完整项目；同时检查重复、缺失、越界路径及意外文件。`--verify-only` 比较的是当前源目录，源码在打包后继续变化时应重新生成。重组一致证明打包完整性，功能验收仍以应用测试与实际环境结果为准。
