# 让实验结果进入图谱检索与研究决策 ExecPlan

Created: 2026-10-25 14:46 Asia/Shanghai
Updated: 2026-10-25 Asia/Shanghai
Target repository: `/Users/iranb/Library/Mobile Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus`
Target branch / worktree: `codex/experiment-aware-graph`，工作区 `/Users/iranb/.codex/worktrees/experiment-aware-graph/PaperNexus`；起点 `main`=`ea70833973108a485581cd44030faa14abd0b162`。
Related docs: `.agent/plans/2026-10-24-papernexus-research-decision-loop.md`、`docs/interfaces/research-decision.md`、`docs/operations/research-decision-loop.md`、`docs/interfaces/mcp-three-workflows.md`、`SKILL/PaperNexus/references/research-decision.md`。
Plan review: `.agent/plans/2026-10-25-papernexus-experiment-aware-graph-review.md`。

本文是持续维护的执行契约。实施者只需本仓库和本文即可继续，不依赖聊天记录。仓库未发现 `PLANS.md`。每个里程碑结束后更新 Progress、Surprises & Discoveries、Decision Log、Artifacts and Notes、Outcomes & Retrospective；按依赖顺序继续，不为例行下一步重复询问。

用户已授权按本计划在新分支实施，完成后合并 main。授权覆盖产品实施、必要验证、提交与合并；不包含远端部署或新增训练。FSGCD 已有训练、100 GPU 小时预算及每小时跟进属于原实验任务；本计划不改动其作业、预算、冻结分析方案或自动跟进。

## Purpose / Big Picture

完成后，研究者提交一次外部实验结果，再用项目名查询，就能看到这次实验改变了哪些判断、其适用范围是什么、还不能区分哪些解释，以及下一项可执行的取证或控制实验。生成建议时不再依赖调用方重新粘贴全部结果。

用户能沿着“论文来源—代码行为—登记预测—实际测量—比较对象—范围内结论”检查依据。系统同时保留原始基线与当前控制基线，明确部分恢复、指标间取舍和证据不足。图结构中的关联不能升级为因果结论；未检验的新颖性不能升级为已验证的新方法。

首个可用切片是：通过现有 record_run/assess_results 登记结果，重启客户端后调用新的只读 evidence_view，再调用带 project 的 idea_generation/generate；返回具体运行和评估引用，以及由结果引起的研究重点变化。后续切片增加多个比较对象、任务型审查、机制证据、来源就绪状态和精度约束。最终使用真实 FSGCD 历史证据完成本地 MCP 回放。

工程验收证明这些行为真实可用。图结构是否比相同文本和结构化实验记录更有帮助，单独通过受控回放评价；不得把测试通过写成科研成功率或模型性能提升。

## Progress

- [x] 2026-10-25：核对 main、前序计划、接口、状态权威、材料读取、反思链与实际 FSGCD 证据；确认无仓库 PLANS.md。
- [x] 2026-10-25：使用当前仓库绝对路径完成六个主要入口的 GitNexus upstream impact；记录动态调用的索引遗漏。
- [x] 2026-10-25：运行八个相关测试文件，共 31 项全部通过；日志见 `.agent/reports/2026-10-25-experiment-aware-graph-plan/baseline.log`。
- [x] 2026-10-25：形成增量接口、状态权威、七个实施里程碑、行为验收、恢复与受控回放方案，并完成计划审查。
- [x] M0：冻结增量合同、历史证据包和可执行验收输入。
- [x] M1：交付项目证据查询与实际使用结果的候选输出。
- [x] M2：交付多基线比较和目标指标判定。
- [x] M3：交付按研究任务区分的评审入口。
- [x] M4：交付机制证据路径与关键来源就绪诊断。
- [x] M5：交付与推断范围一致的精度判断和下一步建议。
- [x] M6：完成本地端到端回放、接口/文档/客户端同步、恢复演练和工程验收。

## Surprises & Discoveries

Observation: GitNexus CLI 对同名工作区的 backend 注册有覆盖；使用独立别名 `PaperNexus-experiment-aware` 强制索引后可查询当前工作区。共享 buildResearchIdeas 的 upstream risk 为 CRITICAL，本次未修改该符号；新增编排层与比较逻辑的实际入口均为 LOW。
Evidence: `.agent/reports/experiment-aware-graph/M0/` 与当前工作区索引。
Consequence: 最终 detect-changes 使用当前工作区别名，候选反馈接入保持在项目/MCP 层。

Observation: 现有 research_decision 已包含假设、预测、行动、运行、评估、预算与机会重访；现有 reflection_chain 从论文增强层读取实验和反思。
Evidence: `src/core/research/decision-service.js`、`src/server/api.js:reflectionChainPayload`、`src/core/enhancements/extract.js`。
Consequence: 复用这两个事实来源，通过查询投影连接；不再建设独立运行账本，也不把项目实测写成论文报告。

Observation: 本地默认 research profile 已有四个工具；本轮已保存的 41 服务 tools/list 只有三个研究工作流。
Evidence: `docs/interfaces/research-decision.md`、`src/mcp/research-workflows.js:researchCapabilities` 与外部证据包 `TOOLS_LIST.json`。
Consequence: 生产接入前需重新读取能力和部署版本。旧远端响应只证明当时的状态，不证明现在仍缺失，也不证明本地能力已上线。

Observation: `negativeEvidenceAssessment.failed_record_count` 统计 provider 检索失败，不统计失败实验；机制碰撞审计是词项预筛，`semantic_equivalence_checked=false`。
Evidence: `src/core/materials/agent-materials.js:negativeEvidenceAssessment`、`src/core/materials/researchstudio-innovation.js:compileMechanismCollisionAudit`。
Consequence: 新项目实验反馈使用自己的运行/评估引用；不复用检索失败计数，也不把词项命中当作机制等价。

Observation: 当前单次 run 只有一个 baseline/comparison，评估以 quantity/unit 找第一个 measurement；action 的 max_interval_width 是计划要求，不是可达到该精度的实测证据。
Evidence: `decision-contracts.js`、`hypothesis-assessment.js:assessObservation`、`action-policy.js:actionDiscrimination`。
Consequence: 多比较必须有明确身份和匹配规则；精度要求与精度估计必须分开。

Observation: GitNexus 注册了两个同名 PaperNexus。指定当前仓库绝对路径能找到最新决策符号；query 的 FTS 初始化仍报只读数据库错误并返回空结果。executeResearchWorkflow 的 impact 漏报了 executeTool 的动态分发调用。
Evidence: 2026-10-25 的 list/status/impact 输出；`src/mcp/core.js:507` 有实际调用。
Consequence: 使用绝对路径、context 与源码调用点交叉定位。空结果不是无影响；本计划不扩展为修复 GitNexus。

## Decision Log

- Decision: `discriminating-action-v2` 对可达精度缺失返回具体 needs_input，并保留有预算上限的探索。Rationale: 接受旧 v1 输入不等于继续赋予没有精度依据的区分力；已有运行仍优先等待、对账与评估。Date/Author: 2026-10-25 / Codex。
- Decision: 比较参考变化后必须提交新运行 source_revision，刷新来源不能重用旧比较快照。Rationale: 保持已接收测量和参考版本的一致性。Date/Author: 2026-10-25 / Codex。
- Decision: 既有图候选缺少显式身份时保持 unlinked，项目 research_focus 仍使用有效运行反馈。Rationale: 不能依据标题相似度认定同一实验。Date/Author: 2026-10-25 / Codex。

- Decision: 首版采用按需构建的项目证据子图，保留 research-decision-state.json 为唯一项目决策权威，不建立持久化图副本。Rationale: 能立即检索实验反馈，并避免项目结果与论文事实、两个状态库之间的冲突。Date/Author: 2026-10-25 / Codex。
- Decision: 保留四个公共工具；只新增 research_decision/evidence_view 操作，并为 idea_generation 的相关操作增加显式项目与用途选择。Rationale: 现有入口足够承载完整流程，无需第五个工具或泛化工作流框架。Date/Author: 2026-10-25 / Codex。
- Decision: 多个比较结果附属于同一物理运行，沿用 source_revision/supersedes_record_id 更正；不为每个比较复制运行。Rationale: 避免重复预算、重复独立样本和相互冲突的完成状态。Date/Author: 2026-10-25 / Codex。
- Decision: 机制与目标结构附属于不可变的假设/行动版本。Rationale: 必须知道哪条规则在运行前存在，不能事后移动目标。Date/Author: 2026-10-25 / Codex。
- Decision: 默认 evaluate 保留既有创新审查语义；新 purpose 使用独立且有名称的任务判定。Rationale: 不降低既有新颖性要求，也不以跨域创新材料缺口阻止所有机制诊断。Date/Author: 2026-10-25 / Codex。
- Decision: 工程完成不要求图结构在回放中胜出。Rationale: 负结果和无差异也是有效证据；不得以修订评测直到获胜代替验收。Date/Author: 2026-10-25 / Codex。

## Outcomes & Retrospective

项目证据查询、多比较评估、任务用途、机制路径、来源就绪与精度策略已实现，M0—M6 工程验收完成。全量测试共 1,098 项，其中 1,096 项通过、2 项既有可选吞吐基准跳过，0 失败；文档构建通过。HTTP/stdio/Python 客户端、跨服务重连与丢失响应恢复已验证。验收映射见 `.agent/reports/experiment-aware-graph/ACCEPTANCE.md`。

真实 FSGCD 历史 HTTP 回放通过 12 项检查：保留原始基线、OLD/NEW/ALL 的取舍与单 seed 固定模型范围，两个物理 attempt 的历史累计成本为 29.158128 GPU 小时；回放没有新增训练或 provider 调用。A/B/C 的九份盲评材料已准备，尚未执行外部模型比较。未部署到远端 41 服务；图结构独立效用尚未建立。

## Context and Orientation

### Current State Snapshot

工程为 Node ESM，要求 Node >=20.17。现有依赖足够完成本计划；不预设新增数据库、向量库、模型服务或后台调度器。现有模块如下。

| 路径 | 当前职责与本计划接入点 |
| --- | --- |
| `src/core/research/decision-contracts.js` | 严格 request/entity schema、操作集合与计划完整性；承载增量字段和新只读操作 |
| `decision-store.js`（同目录） | 原子状态/回执写入、实体和运行最新版本；继续作为唯一持久化入口 |
| `decision-evidence.js`（同目录） | 论文准入、外部 artifact 元数据、manifest 核对和证据更新检测 |
| `decision-service.js`（同目录） | 登记、运行接收、评估、推荐与导出编排；增加证据视图入口 |
| `hypothesis-assessment.js`、`action-policy.js`（同目录） | 协议/预测判断、精度比较、动作选择、累计预算 |
| `src/mcp/tool-research-decision.js` | 决策工具 schema、信封与操作副作用声明 |
| `src/mcp/research-workflows.js` | 三研究工作流路由、条件校验、能力发现与调用后续建议 |
| `src/mcp/research-summary.js` | 32 KiB 摘要、原始 gate 保留、只读展开入口 |
| `src/core/materials/agent-materials.js` | 论文材料、来源/图谱可用性、创新材料包与审查 |
| `src/core/materials/researchstudio-innovation.js` | 有来源的模式分析、词项碰撞预筛与 proposal handoff |
| `src/server/api.js`、`src/core/enhancements/extract.js` | 论文反思链；保持论文事实来源，项目实测不混入 |
| `SKILL/PaperNexus/scripts/pn_research_decision.py` | 读取 request-file 后发送一次 MCP 请求；沿用连接与认证，不自动重试 |

前序科研决策闭环计划已合入当前 main，不能把其中已完成能力再次列为本次新增。本地工作树存在无关 main.pdf 修改、旧计划、`.agent/reports/`、iCloud 重复目录/脚本及两个无关构建脚本。创建本计划前的完整状态保存在 `worktree-before.txt`。保留这些内容，实施时只暂存本任务明确文件。

本次影响分析：recommendNextAction 的直接调用者为 appendRun、executeResearchDecisionOperation，风险 LOW；executeResearchDecisionOperation 的直接调用者为 MCP 工具与离线评测 call，风险 LOW；buildInnovationEvidencePack 的直接调用者为 executeAgentMaterialsOperation，风险 LOW；buildPaperMaterialView 有四个索引内直接调用者，传播到材料包与创新材料，风险 LOW；summarizeResearchEnvelope 的直接调用者为决策工具与研究工作流，传播至 executeTool/handleMessage，风险 LOW。executeResearchWorkflow 的索引结果为零调用，源码确认 executeTool 分发至该函数，因此必须覆盖 HTTP/stdio/工作流测试。上述仅为计划时快照，实际修改前仍需对具体符号做当时的 impact。

### 本轮实验提供的可复核需求

两个已完成实验使用 CUB、seed 0、120 个预训练 epoch 和 200 个主训练 epoch，分别采用 sampled 和 complete 候选池。已完成配对验收；比较为 `vs matched reproduced baseline`。固定末轮 NEW 为 43.062873% → 39.620653%，OLD 42.083333% → 49.166667%，ALL 43.023256% → 40.006741%。效应精确值以原 ANALYSIS.json 为准。没有可核实、协议对齐的论文数值比较。

伪标签精度平均上升 11.2474 pp；正确旧类伪标签平均数从 39.685 增至 65.905，新类误标为旧类约 48.850 → 48.655。主评价共 5,934 个无标签样本，其中 5,694 个为新类。新增净新类错误为 196 个，其中新类间混淆增加 184 个，新→旧增加 12 个；184/196=93.9% 是错误分解，不能解释为某训练分支的因果贡献。原始新类簇编号的 ARI/NMI 在主评价与 heldout 均下降。

固定末轮 NEW 差距为 −3.4422 pp，最后 20 个 epoch 的平均差距约 −0.5813 pp；后者是事后轨迹描述，epoch 相关，不能替代冻结的主结果。图像 bootstrap 固定了训练模型和映射，不覆盖训练 seed 方差。

当前 triplet 恢复实验保持 complete 候选池与伪标签规则，恢复伪标签样本的 triplet 参与，同时改变锚点/正样本人口和负样本池。它的最终结果不在本计划基准输入中。若仅相对 complete 提升 1 pp，NEW 约为 40.621%，仍低于原始 sampled 的 43.063%；这是用于验收措辞的假设情景，不是已经发生的实验结果。

### Terms and System Map

物理运行由 executor/run/attempt 身份定义。比较是在某个协议、总体和指标下，把这个运行与指定参考运行或论文报告对照。项目证据子图是已有事实与引用的只读视图；它不是新的事实仓库。机制路径区分代码行为、观测关联与待验证预测。任务判定回答材料是否足以开展指定研究步骤，不授予执行权限。

    论文来源与语义边 ───────┐
    代码观察与原始测量 ────┼─> 项目证据视图 ─> generate / evaluate
    research-decision-state ┘       │                 │
            ↑                      └─> 来源与机制定位 ┘
    record_run / assess_results <─ 外部执行器
            │
            └─> 原始基线 + 控制基线 + 论文比较 ─> recommend_next

## Scope

本计划覆盖六项行为改进：实验事实可被后续查询使用；多个比较对象和目标向量；任务型审查；机制证据路径；关键来源的语义就绪状态；与推断范围一致的精度及动作选择。交付 Node 核心、现有 MCP 接入、Python request-file 示例、JSON/Markdown 导出、离线回放和必要文档。

本地工程验收使用临时语料和隔离项目。真实 FSGCD 历史数据只用于构造来源明确的回放包；可重复的单元测试另外使用清楚标注的合成输入。生产修复 FSGCD 图谱节点是后续运行操作，必须在相应授权下使用现有导入/同步流程。

## Non-Goals

不重写 controller、论文抽取器或整库检索，不新增图数据库、通用因果发现器、统计认证引擎、任意 agent 编排框架或 Web dashboard。不把本计划转为新的训练课题，不要求重新跑已完成模型，不自动调用外部模型/provider，不改变原实验停止条件。不把任何一条失败记录变成全领域方法禁用规则。

首版不将项目结果永久写入全局论文图，也不新建结果索引后台同步任务。数据量来自当前受支持的项目；先按需读取已有状态，只有测得读取成本影响实际使用时再决定索引优化。

## Non-Negotiable Rules

1. 原始测量、论文报告、代码观察、代理推断和检索缺失保持可区分。来源可读、来源准入、语义节点存在、关系有证据、科学结论成立是不同状态。
2. 原始基线不能被后续较差控制基线悄悄替代；绝对值、差值、总体、指标方向和单位必须明确。只有相关条件核验通过，才允许使用 matched。
3. 同一物理运行只有一份最新累计成本；新增比较或更正评估不增加独立训练次数。实际新增 CPU/模型成本如发生，由对应执行器如实记录，不虚构免费计算。
4. 已运行的预测、目标和分析规则不可原地改写。更改创建新版本并保留回顾性边界。描述性收益、范围内支持和跨训练稳定性分别报告。
5. 不以检索缺失证明新颖性，不以共同归属路径证明机制，不以代理自评代替可复核的测量和协议。
6. 所有公共读取无训练、无导入、无网络 provider 调用、无隐藏状态写入。已有 run 未完成时，推荐保持 await/reconcile，不能重复提交。
7. 现有 v1 输入继续支持。新增字段为可选增量；旧调用不获得未经支持的新结论。新增多比较记录不同时使用有歧义的旧单比较字段。不建设泛化迁移框架。
8. 修改函数、类或方法前做 GitNexus upstream impact 并报告调用者、流程、风险；HIGH/CRITICAL 在编辑前提示。提交前 detect_changes；索引过期先 analyze。工具缺失或漏报时保留限制，用源码和运行入口补证。
9. 每项检查必须对应具体失败及后续动作。通过后不无理由扩大或重复检查；不新增无决策用途的 hash、守护包装或特性开关。

## Authority / Evidence Model

| 事实或状态 | 唯一直接权威 | 派生视图不能做什么 |
| --- | --- | --- |
| 作业是否运行、完成、失败及原始测量 | 外部执行器 manifest 与指标 artifact | 不能以图谱状态宣布作业完成 |
| 已接收运行版本、累计预算、假设/行动/评估版本 | 原 `research-decision-state.json` | 不能让导出报告或子图另行改写科学状态 |
| 论文身份、可用来源、质量准入与已提交语义节点 | 原 corpus/source/quality/graph 机制 | 不能以项目推断创建论文事实 |
| 代码观察 | 带代码版本、文件/符号定位的已保存观察 artifact | 存在文件不代表代码观察已独立认证 |
| 工程实施完成 | Progress 与最终验收报告，引用实际测试/调用 | 不能把计划勾选当运行证据 |
| 真实科研目标完成 | 原 AutoResearch/用户研究任务的验收规则 | 本计划和回放不能替代原项目完成状态 |

evidence_view 每次读一个明确的项目 revision，只投影该 revision 内最新有效记录，并显示 historical/stale/unassessed/operational_failure 等状态。外部证据变化按现有 inspectEvidence/changedEvidence 检查；只读操作报告失效和 refresh 步骤，不隐式重评。评估写入继续使用锁、expectedRevision、请求回执和原子替换。

### 执行主体与工具边界

研究代理负责阅读来源、形成和修订假设、解释未被规则覆盖的现象，并提交带依据的设计；它不拥有原始测量或科学状态。输入是项目证据视图与来源，输出是 hypothesis/action 新版本或 analysis_annotations；使用既有四个工具，不新增默认模型调用。其关键验收为 F01/F08/F10：能利用反馈、正确选择用途、保留竞争解释。

PaperNexus 服务负责合同验证、证据视图、确定性比较、预算和建议；不替代理发明已验证机制，不替执行器提交作业。外部执行器负责授权、作业、原始测量与累计成本，通过 manifest/record_run 回流。调用模式是顺序管线：读证据 → 登记方案 → 推荐 → 外部执行 → 回流 → 评估；本计划不引入多代理调度。

模型上下文仅缓存当前问题、摘要和引用；运行上下文保存 requestId、版本与传输回执；持久状态继续使用原项目状态和原执行器 artifact。新工具操作的错误沿用 invalid_input、invalid_reference、revision_conflict、request_conflict、stale_dependencies；科学证据不足是 needs_input/inconclusive 业务结果。只读操作幂等，变更操作按原 requestId 幂等；请求/响应轨迹和状态回执共同证明工具行为。

## Interfaces and Dependencies

### A. 只读项目证据入口

新增 `research_decision` 操作 `evidence_view`，外层字段为 operation、corpus、project、responseMode，新增可选 query、limit、includeHistory；limit 默认 10，最大 50，includeHistory 默认 false。不要求 requestId 或 expectedRevision，不创建状态目录，不增加 revision，不自动调用模型。

完整响应 result 至少含 `based_on_revision`、`evidence_freshness`、`observations`、`comparison_summary`、`open_explanations`、`mechanism_paths`、`source_readiness`、`evidence_requests`、`nodes`、`edges`、`coverage`。coverage 明确总匹配数、返回数和截断；完整展开沿用只读请求，不能重放变更操作。

节点引用现有 IDs：paper/source、hypothesis@version、action@version、run record、comparison_id、assessment/prediction。派生节点以这些 ID 的组合标识，无新 hash。每条边包含关系类型、支持它的 source/record 引用、适用协议或范围、证据状态。图中不出现仅为连通而加入的全局 Corpus 机制路径。没有项目返回 not_initialized；无匹配结果返回空匹配及覆盖说明，不把其解释为没有负结果。

`query` 只用于在本项目事实中定位问题。先按显式实体/来源关系检索，再用现有文本匹配帮助定位；词项匹配只能决定展示候选，不能改变科学状态或认定两个机制等价。执行成本、未结清运行和结论限制不因 query 或 limit 被隐藏。

新增 `src/core/research/project-evidence.js`，负责纯投影、引用匹配、机制路径和来源状态汇总；文件与来源读取仍经已有 store/evidence/material API。不要建立一个持久化 project-graph.json。

### B. 让 generate 使用项目结果

`idea_generation/generate` 增加可选 project。没有 project 时行为不变；有 project 时保留原图谱候选结果，并附加 `project_evidence`、`research_focus` 和每个候选的 `project_assessment`。候选与项目结果通过已登记 candidate_refs、source refs、机制组件引用连接，不以标题相似就认定相同实验。

输出分清未测候选、已测但需新干预/范围才能继续的候选、仍无项目关联的候选，并解释排序或分组变化所用的 record/prediction IDs。负结果只影响对应协议与效应范围；合法复验可保留。若没有足够的关联，返回 unlinked，不伪造“图谱已吸收反馈”的结论。生成过程不会把新假设自动登记为已验证事实。

### C. 多比较、目标向量与结论

扩展 action 的可选 `evaluation_plan`，在 register_actions 时随版本冻结。该对象含 `comparators` 和 `outcomes`。

每个 comparator 有 `comparison_id`、`role=original|control|paper`、`reference` 和 `required_protocol_fields`。reference 明确引用既有运行版本或已核验论文 source ref；外部历史基线可使用明确的 manifest/artifact ref，不要求为导入基线而伪造新作业。每个 outcome 有 `quantity`、`unit`、`direction=higher|lower`、`role=primary|guardrail|diagnostic`、`minimum_effect` 或 `max_regression`，以及需要判定的 comparison_ids。推断范围用 `inference_target=fixed_model|training_procedure` 明确；缺失只产生范围未知，不默认稳定性。

reference 采用三个明确分支：`{kind:run_record,record_id}`；`{kind:external_manifest,source_ref,protocol_locator,measurements_locator}`；`{kind:paper_report,source_ref,protocol_locator,measurements_locator}`。locator 指向被引用 artifact 内的具体字段或来源段落。保留解析出的参考协议和测量快照以及它们的版本；外部材料未提供结构化字段时，人工提取必须保存带原文定位的提取 artifact，不能把自由文本自动认定为已匹配协议。comparison 的 reference 必须与注册 comparator 一致。

扩展 prediction 的可选 comparison_id，使相同指标的不同基线预测不会串用。旧预测在单比较路径下沿用现行为；若新多比较路径不能唯一确定预测的比较对象，返回具体缺口，不取数组第一项。

同时扩展 analysis 的 `primary_comparison_id` 和可选 `family:[{comparison_id,quantity}]`。新多比较分析以 `(comparison_id,primary_outcome)` 唯一定位主检验；adjusted 分析的 family 必须覆盖被用于确认性声明的比较/指标。只新增次要原始基线读数，不能因为 quantity 与主检验相同而自动成为第二个确认性主结果；新字段也参与 action/run 分析一致性与前瞻性检查。

新 run 可含 `comparisons[]`。每项含 comparison_id、对应 reference、comparison kind、比较所用的协议信息/核验引用，以及 measurements。测量明确 `value_kind=absolute|difference`；difference 还含 candidate_estimate、reference_estimate，estimate 等于候选减参考，单位必须一致；方向只影响结论解释，不改变差值正负定义。区间必须属于该差值，不能拿候选单臂区间当差值区间。

这里的单位一致指候选与参考的绝对值采用同一尺度。difference 使用 `value_unit` 保存绝对值单位，`unit` 保存差值单位：本例 value_unit=percent、unit=pp；同一物理单位的差值仍使用该单位。只支持已明确的同尺度相减，不自动转换其他量纲；外部需先规范化并保存计算依据。显示四舍五入不参与验收阈值计算。

使用 comparisons 时，不再同时提交旧 run.baseline/run.comparison；顶层 measurements 仅放不依赖比较的观测，例如分支人数。旧单比较输入保持原语义，由专门的小型读取函数提供统一比较视图，不重写旧文件。重复 comparison_id、量纲不一致、找不到 reference、比较对象与 evaluation_plan 不符为明确输入错误。

原 run 的身份、累计成本和 source_revision 规则保持不变。补充第二个比较通过同一次 attempt 的新 source revision 和 supersedes_record_id 提交，manifest 同步更新；旧评估变为 stale。比较条目没有 actual_cost 字段，也不被 latestRuns 当成独立尝试。

新增 `src/core/research/comparison-assessment.js` 处理协议对齐、差值校验、指标向量和声明依据；由 assessObservation、decisionMarkdown 和 evidence_view 共用。三类比较标签沿用现有措辞。matched 需要候选与参考的必要协议字段一致且引用可核验，不能仅比较候选与自己的行动计划。缺字段保留 unknown；已有差异保留 mismatch；论文来源或协议缺失返回 `paper-report comparison not established`。

依赖保持单向：comparison-assessment 为无 I/O 的比较逻辑；project-evidence 接受状态和已读取来源，不反向调用 decision-service 或 MCP；project-evaluation 组合这些读取与判定，不触发 assess_results 等写操作。原材料 API 不依赖新的项目编排模块，避免 decision-evidence → materials → project service 的循环。

输出逐比较逐指标的估计、区间、方向、目标/保护条件结果及范围。汇总声明分为 `not_assessed|inconclusive|tradeoff|partial_recovery|improved_in_scope`，附驱动该结论的 comparison/measurement IDs。仅相对 control 改善而未恢复 original，输出 partial_recovery；目标提升但保护条件未满足，输出 tradeoff 或 inconclusive，取决于证据是否明确。只有指定 original 比较下的主目标和保护条件均满足且分析有效，才能 improved_in_scope；诊断指标不参与替代主目标。多指标统计结论沿用已登记的 multiplicity 与外部统计复核，不新增通用统计引擎。

逐项结果始终保留。若同时发生部分恢复和已证实的保护指标退化，总体声明为 tradeoff，并保留对应指标的 partial_recovery；不能用单个恢复标签掩盖损失。区间不足、比较未匹配或原始基线仅有事后读数时，展示描述性差值及限制，不升级为确认性 improved_in_scope。

### D. 按任务审查

`idea_generation/evaluate` 增加 `purpose=novelty_audit|mechanism_diagnosis|performance_validation`，默认 novelty_audit。默认分支继续使用现有 buildInnovationEvidencePack，保留旧输入及返回语义。

新的两个 purpose 必须有 project 和 actionId，引用已登记的具体行动版本；actionVersion 未给时使用当前最新版本并在返回中固定指出。该分支无需重复提供 candidateMechanism；query 可用于说明问题，不能覆盖注册行动。传入互相冲突的 actionVersion/引用应返回明确错误。schema 和 resolver 均须体现条件要求，而不是只在描述字符串中说明。

新增 `src/core/research/project-evaluation.js`。mechanism_diagnosis 检查已有解释、干预、有效性检查、可测预测、比较/范围、来源和可用资源依据；缺少跨领域创新材料本身不阻止诊断。performance_validation 检查原始基线、目标和保护条件、已登记分析与推断范围。对一个不存在的行动返回 needs_input，不为通过审查自动生成假设或预算。

新分支返回 `purpose`、`task_gate={status:ready_for_design|needs_input,reason_codes,evidence_refs}`、`novelty_claim_allowed:false`、`performance_claim_status`、`project_evidence` 和对应下一步。ready_for_design 不是作业执行许可；只有 recommend_next 的既有规则选择具体已登记行动，执行器仍负责授权。

新分支不复用含义不明的全局 experiment_planning_allowed。保留的默认 novelty_audit 响应明确该字段只属于创新方案交接。summary、Markdown 和 nextActions 使用同一个任务结果，不能同时出现互相矛盾的“可以/不可以”。词项碰撞仍标为候选；语义等价未核查时不得改为已证实撞题。

### E. 机制证据与来源就绪

在 hypothesis 增加可选 `mechanism_evidence`，包含 components 和 links。component 的 id 在该 hypothesis version 内唯一，kind 限于 source_claim、code_component、sample_population、loss_term、observable；保存具体 statement 与 source/代码定位引用。link 限于 `implements|changes_population|proposes_effect|observed_with`，必须引用现有 component 或 prediction/measurement，包含 evidence_refs 与 `status=source_supported|code_observed|measured_association|hypothesized`。不允许来访请求直接写入“causal_proven”或 scientific_state。

代码观察增加 evidence_origin=`code_inspected`，引用已保存 artifact，附 repository、code_revision、file_path、symbol/行定位及观察内容。inspectEvidence 只验证版本、artifact 可用性和定位信息，verification 为 code_artifact_present；不能据此宣布观察已独立认证。静态代码与梯度运行观测分别保留。该新增类型可支持设计依据，但不能替代外部实测去支持或排除假设。

动作可增加 `intervention_components`，逐项引用改变的机制组件与 held_constant。若一个动作同时改变多个组件，返回 compound_intervention 和未隔离的差异，不能伪称单因素控制。系统可以提出拆分建议，但不能把所有必要的复合干预一律判为无效。

沿用 buildPaperMaterialView 的 availability/source_admission，增加派生 `graph_readiness`：`source_readable`、`source_admitted`、`semantic_node_present`、`source_anchored_relation_count`、`status=unavailable|source_only|node_only|anchored_relations`、reason_codes。source_anchored_relation_count 只计可核验的语义边，不能计 Corpus 归属；它表示可展开程度，不保证与当前问题有关。问题适用性由项目视图中的具体引用和缺口说明。

对 Markdown 已可读而图节点缺失的来源，也输出明确 graph gap 与现有导入/同步的下一步；不要重复下载已有来源。若没有执行所需的 serverFilePath/taskId，则返回 needs_input 和缺失字段，不能拼造可执行路径。能力查询、paper/evidence_view 均不触发导入。实际修复后以原任务/同步权威检查，再核对具体 paper 节点与来源边，不能以全局篇数判成功。

### F. 精度、推断范围与建议

保留 action.precision.max_interval_width 为计划可接受宽度。增加可选 `anticipated_interval_width`、`basis_refs` 和 `inference_target`，说明可达精度的来源与适用对象。没有依据时为 unknown。prediction/action 的范围与 measurement.uncertainty 的独立单位必须能支持同一推断；固定模型上的图像/类别重采样不能支持 training_procedure 稳定性。

新分析同时登记 `measurement.uncertainty.inference_target`；训练程序推断还需 `independent_run_refs`，引用实际独立训练运行及其统计计算。独立数量由引用核对，不以 arbitrary 文本或重复 epoch 数推断。两个不同运行本身也不保证稳定性，仍需适用的区间和已登记分析。旧测量没有这组字段时保留旧范围内评估，但不据此产生新增的训练稳定性声明。

actionDiscrimination 输出 `required_interval_width`、`planned_max_interval_width`、`anticipated_interval_width`、`achievability_status=estimated|unknown|insufficient`。预测区间重叠时要求不同条件或不同观测量，不能靠更窄区间自动产生不存在的间隔。即使两个预测区间分离，单次结果仍可能落在两者之间；充分精度不保证支持某一解释。

recommend_next 继续优先 reconcile/await/assess。若存在能回答同一问题的已登记低成本精度诊断，且完整实验的预期精度不足或未知，应先推荐该诊断；无此动作时返回 needs_input，具体说明需注册哪类诊断或以探索性目的修订行动。明确登记的 bounded exploratory 动作可以执行，但 reason 与结果分支不得声称它能确定区分解释。修改推荐策略时提升 POLICY_VERSION，保留旧 recommendation_ref 的可追溯性。

重复训练和重跑 KMeans 分别回答训练程序与固定表征下聚类波动；只在确有必要和数据可用时建议。首版不强制每个任务跑固定数量 seed；训练稳定性由实际独立运行、适用区间和预设分析支持。没有相应证据时正确结果是不确定。

### 公共兼容性与摘要

保持原四工具数量和 legacy/all profile 规则。新 operation、可选字段、code_inspected origin 和新 purpose 在 capabilities 中显式列出，并更新 schema snapshot、生成文档及 request-file 示例。旧客户端无需知道新字段即可继续原操作。

在 research-summary 中优先保留 purpose、task_gate、comparison_summary、推断范围、源更新状态、未结清运行和成本；完整字段放不下时给出“需读 full”的明确状态，不把截断默认为通过。证据视图的 read_more 指向 evidence_view full；变更的 read_more 继续使用 status(requestId)。不得为展开摘要重复写入。

## Plan of Work

### M0：冻结合同和最小证据包

目标是把本计划的输入输出变成可运行样例，并确认当前实现边界。读取当前 Git/工具能力；先完成待改符号的 impact。将真实 FSGCD 的两组结果、原协议、来源定位、图谱调用和代码观察提取为小型历史回放包；不复制模型权重、整个数据集或凭据。新增 `test/fixtures/research-feedback/README.md` 与明确区分 measured/synthetic 的输入。用于反例的“恢复 +1 pp”必须标为 synthetic，不能写进真实结果文件。

修改范围为 fixture、合同草案和本计划；暂不修改训练代码或生产语料。artifact 缺失时，工程测试仍使用合成 fixture，真实回放标为未执行并给出准确缺口，不能用合成结果替代。

验收是两组来源事实及计算关系可从输入复核，基线测试状态已保存，新增请求能被明确描述，旧输入与新输入的兼容/冲突边界已冻结。产物放在 `.agent/reports/experiment-aware-graph/M0/`，含 source-map.json、request-examples.json 和 impact 证据。

### M1：交付可查询且被使用的实验反馈

在 decision-contracts/service、tool-research-decision、research-workflows 中接入 evidence_view；新增 project-evidence.js。读取现有运行/评估形成项目视图，并为 generate(project) 添加基于显式关联的研究重点和候选说明。先完成单比较路径；不等待多比较、机制图全部完成。

验收：通过 HTTP MCP 登记一个有结果的项目，关闭原客户端后重新连接，只给 project/query，仍返回原始 run/prediction/source 引用；相同机制候选显示已测结果与范围，并引出未解决解释。无项目调用保持原结果；只读调用不改变 revision、预算或原 corpus 图；更正后的旧结果不能继续作为当前依据。

风险是只是附加文本而没有影响建议，或错误合并不同协议。用“有明确关联则改变说明/分组，无关联则 unlinked”的成对案例验证。新增 `test/research-project-evidence.test.js`，扩展 MCP/工作流测试。产物为跨连接请求轨迹和导出报告。

### M2：交付多基线与目标比较

实现 evaluation_plan、comparison_id、comparisons 和 comparison-assessment.js；将评估、报告和证据视图接到同一比较结果。保留旧单比较路径；新多比较路径严格验证引用、总体、协议、单位、绝对值和差值。

验收：一个物理运行对 control 改善、对 original 仍下降时输出 partial_recovery；OLD 改善、NEW/ALL 下降时输出 tradeoff；只有伪标签精度提高不能提高主目标状态。再提交同次运行的新比较，预算和独立运行数不变，旧评估失效。相同 quantity 在不同 comparison_id 下不能取错测量；不匹配参考协议不能得到 matched 标签。

风险是新 schema 破坏原始 manifest 核验或旧客户端。保留真实完整 manifest 比较，新增字段也进入验证；不自动修改执行器已冻结文件。新增 `test/research-comparisons.test.js` 并扩展原 assessment/protocol/store/budget 测试。产物为原始、控制及论文三种比较的可读报告。

### M3：交付按任务区分的审查

在 research-workflows 的 schema/resolver/executeResearchWorkflow 中接入新 purpose，新增 project-evaluation.js。默认创新审查继续原路径；两个新 purpose 读取已登记行动和 M1/M2 的证据。更新摘要和后续建议，使它们使用同一任务判定。

验收：同一控制在创新证据不足时可得到 ready_for_design 的机制诊断结果，novelty_claim_allowed 仍为 false；缺干预、比较或测量时仍 needs_input；没有 actionId 不能绕过登记。词项碰撞不自动宣布撞题。调用过程中没有 discovery/import/provider/训练请求。原默认 evaluate 的字段意义与结果不变。

风险是新接口只有注释变化，或把诊断就绪误作执行许可。新增 `test/research-purpose-gates.test.js`，对 schema、resolver、HTTP/full/summary 同时验收。产物为三个用途对同一输入的请求响应对照。

### M4：交付机制路径与来源就绪诊断

在假设/动作 schema、decision-evidence、project-evidence 中接入机制组件、代码观察和复合干预。增量改进 buildPaperMaterialView 的 graph_readiness/gap 输出，保持抽取和来源权威不变。

验收：FSGCD 式 mask→分支人口→梯度→NEW 路径逐边有状态与来源；93.9% 错误分解不能生成“triplet 导致 93.9% 下降”；同时改变锚点和负样本池必须显示未隔离差异；affinity 的静态 detach 观察不等于运行梯度测量。论文仅有可读 Markdown 时返回 source_only 与明确下一步；只有 Corpus 边时不能返回机制可用。代码或论文版本变动时，依赖路径失效。

风险是过度类型化和臆造因果。首版只支持上述 component/link 集合，不扩充通用本体。新增 `test/research-mechanism-evidence.test.js`，扩展 material-quality/research-workflow-quality 测试。产物为带来源的机制路径报告和就绪状态样例；不要求本阶段写远端图谱。

### M5：让精度与推断范围改变下一项行动

修改 actionDiscrimination/recommendNextAction、assessObservation 与输出报告，分开计划阈值、预期精度和实际结果精度。使低成本诊断、范围不足、正在运行、预算和探索目的共同约束具体行动。

验收：预测间隔 0.5 pp、计划容许宽度 3 pp 的动作不能描述为已具备充分区分力；存在合适精度诊断时优先选择，否则给出可执行的缺口说明。固定图像区间不能支持训练程序稳定性。相同运行的多个 epoch 不能增加独立训练单位。合法探索动作可保留，但不会因“潜在可区分”自动得到确定性解释。

风险是把所有探索一律阻断，或把未知当免费/精确。用诊断优先、充分依据的完整控制、明确探索性动作、无可用动作四种案例验证，并保留既有 pending/cost/replay 测试。产物为策略差异和实际理由；不发起训练。

### M6：完整交接、历史回放与工程验收

新增 `scripts/evaluate-research-feedback.mjs`，提供 `--input <evidence-directory> --output <new-directory> --mode engineering|prepare-ablation --seed <integer>`，engineering 支持显式 `--resume`。engineering 使用真实本地 HTTP MCP、隔离语料和项目执行完整读写流程，记录请求/响应、版本、比较、决策、预算与副作用计数；无外部 provider、模型或 GPU 请求。prepare-ablation 只生成后文定义的三种可见材料与盲评包，不自行调用外部模型。

命令遇到已有完整输出返回 existing_output 且不改写；中断输出保留 trace 和 output/corpus 中的隔离项目状态，只有显式 --resume 才重启本地服务、通过已保存 requestId 查回状态并继续未完成步骤。resume 校验原 input 路径、source versions、mode、seed 和冻结请求内容一致；不一致时拒绝并要求新输出目录。不能为恢复而换新 attempt 重新登记同一次运行。脚本先从 source-map 校验本次所需文件是否存在和单位/数量是否完整，不扫描整个项目或计算大文件 hash。

同步接口、操作指南、SKILL/PaperNexus/references/research-decision.md、request-file 示例和生成的 MCP 文档；pn_research_decision.py 只在实际需要支持新输入时修改，能透传请求则保持原有简单实现。完成 HTTP、stdio、Python 客户端、摘要与恢复演练，以及一次全量测试和文档构建。已有论文反思链继续独立返回论文来源。

回放报告分别显示 historical_run_cost 与本次 validation_cost。隔离项目可以读取历史成本验证账本，但不把历史 GPU 消耗再次计入真实项目，也不把回放成本当作模型训练成本。新增验证的 CPU/工具成本按实际可测来源记录，未知项保持 unknown。

验收必须包括隔离项目中的真实 FSGCD 历史结果回放，且主报告逐项说明工程能力与科研证据边界。若原外部文件不可用，交付可运行工程切片并明确真实回放未完成，不能把 M6 全部勾选完成。远端上线另按“部署交接”执行，未获授权时交付可审阅的部署包和差异。

## Concrete Steps

所有本地命令从 Target repository 执行。以下是实施顺序；标注“新增”的脚本/测试由对应里程碑创建，不代表当前已存在。

    git status --short
    git rev-parse HEAD
    gitnexus status

索引过期时执行 `npx gitnexus analyze`。对实际修改符号分别运行以下模式；--repo 必须是当前绝对路径，避免命中旧同名索引。

    gitnexus impact recommendNextAction --direction upstream --repo '/Users/iranb/Library/Mobile Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus'

M0 基线命令已执行过，当前计划时版本无需再跑；实施开始若 HEAD/相关文件已变化，再建立新基线：

    node --test test/research-decision-contract.test.js test/research-decision-budget.test.js test/research-decision-policy.test.js test/research-decision-assessment.test.js test/mcp-research-decision.test.js test/mcp-research-workflows.test.js test/research-chain-api.test.js test/innovation-evidence-pack.test.js

M1 至 M5 分阶段执行新增测试与被修改路径的原测试：

    node --test test/research-project-evidence.test.js test/mcp-research-decision.test.js test/mcp-research-workflows.test.js
    node --test test/research-comparisons.test.js test/research-decision-assessment.test.js test/research-decision-protocol.test.js test/research-decision-store.test.js test/research-decision-budget.test.js
    node --test test/research-purpose-gates.test.js test/mcp-research-workflow-boundaries.test.js test/innovation-evidence-pack.test.js
    node --test test/research-mechanism-evidence.test.js test/material-quality-admission.test.js test/research-workflow-quality.test.js
    node --test test/research-decision-policy.test.js test/research-decision-assessment.test.js test/research-feedback-integration.test.js

schema 变化必须先审阅新合同，再使用仓库已有对应 snapshot 更新入口；不得仅为测试通过无差别刷新所有快照。相关入口为 UPDATE_PAPERNEXUS_DECISION_SCHEMA、UPDATE_PAPERNEXUS_RESEARCH_SCHEMA、UPDATE_PAPERNEXUS_MCP_SCHEMA_SNAPSHOT，只对已审阅的对应测试设置为 1；更新后再次在不设变量时运行测试。M6 新增脚本示例：

    node scripts/evaluate-research-feedback.mjs --input .agent/reports/experiment-aware-graph/M0/measured --output .agent/reports/experiment-aware-graph/M6/historical-01 --mode engineering --seed 17
    node scripts/evaluate-research-feedback.mjs --input .agent/reports/experiment-aware-graph/M0/measured --output .agent/reports/experiment-aware-graph/M6/ablation-01 --mode prepare-ablation --seed 17

两条命令成功应分别输出 status=passed 的工程报告，和 status=prepared 的三臂材料；后者不是图谱收益验证通过。变更收敛后执行一次最终回归：

    node --test test/research-feedback-integration.test.js test/research-feedback-replay.test.js
    npm test
    npm run docs:build
    git diff --check

提交前使用已配置的 gitnexus_detect_changes；MCP 不可用时先查看本机 CLI 的 detect_changes 调用方式，记录实际输出。核对变更仅涉及本计划范围，显式暂存任务文件；不要使用 git add -A、清理无关文件或覆盖用户改动。

### 端到端请求与预期行为

M0 将下列读请求与对应完整 init/register/record/assess 输入保存为 request-examples.json；M6 的隔离 corpus 注册名为 feedback-fixture，项目为 fsgcd-feedback。下面两个请求不需要重新粘贴运行结果：

    {"operation":"evidence_view","corpus":"feedback-fixture","project":"fsgcd-feedback","query":"新类内部混淆与候选池","responseMode":"full"}

    {"operation":"evaluate","corpus":"feedback-fixture","project":"fsgcd-feedback","purpose":"mechanism_diagnosis","actionId":"restore-triplet","actionVersion":1,"responseMode":"full"}

第一条发给 research_decision，必须返回保存过的 sampled/complete 比较及单 seed 范围；第二条发给 idea_generation，使用已登记恢复控制的证据和测量方案，返回具体 task_gate 与仍未建立的新颖性状态。如果用于验收的行动缺少足够设计信息，预期为 needs_input，不以“示例应成功”为理由填造来源。

独立的 synthetic 子案例给恢复分支设置 NEW=40.620653319283456，对 control 的差值为 +1 pp，对 original 的差值为 −2.4422198805760473 pp。两个比较共享同一个 executor/run/attempt，并分别有 comparison_id；区间与完整协议由明确标注的合成 fixture 提供。预期为描述性的部分恢复，不能输出全面提升或稳定改进。F04 检查显示值，F06 检查比较身份，F13 检查推断范围。

## Validation and Acceptance

每项验收检查一个真实可能发生的错误；失败时修复对应切片，不能通过改宽阈值或省略该场景让报告通过。

| ID | 输入/操作 | 必须观察到的结果 | 失败指向 |
| --- | --- | --- | --- |
| F01 | 登记结果后新建客户端，只查询项目 | 返回原 run/prediction/source 与范围，研究重点使用该结果 | M1 事实未进入实际入口 |
| F02 | 新 source_revision 更正结果 | 旧评估为 stale，查询不采用旧结论；成本按最新累计值 | M1/M2 版本或账本错误 |
| F03 | 同次运行增加 control/original 两个比较 | 两份可解释比较，一次物理运行、一次累计计费 | M2 比较/运行混淆 |
| F04 | 合成恢复 NEW=40.621，原始=43.063 | partial_recovery；不能 improved_in_scope | M2 更换了比较基线 |
| F05 | 精度/OLD 提升，NEW/ALL 下降 | 目标/诊断分开，报告 tradeoff 与实际数字 | M2 指标替代 |
| F06 | 同名指标不同 comparison_id 或总体 | 精确绑定；缺少绑定/协议则 unknown/needs_input | M2 取错测量或不可比 |
| F07 | 可读论文但缺来源/协议验证 | 不输出 vs paper-reported baseline 的已建立比较 | M2 来源提升错误 |
| F08 | 同一行动分别作创新审查与机制诊断 | 创新不足与诊断就绪可以并存，均不等于执行许可 | M3 审查用途混淆 |
| F09 | 只有词项碰撞或 Corpus 路径 | 不能输出机制等价或因果证据 | M3/M4 关系误用 |
| F10 | 锚点和负样本池同时改变 | 显示 compound_intervention 与未隔离解释 | M4 过度归因 |
| F11 | Markdown 可读、图节点缺失 | source_only，具体 gap 与有依据的下一步；无自动导入 | M4 就绪误报 |
| F12 | 预测间隔 0.5，计划宽度 3，无精度依据 | 诊断优先或具体 needs_input，不能充分区分声明 | M5 精度措辞/策略错误 |
| F13 | 图像 bootstrap 或多个相关 epoch，单训练 seed | 保留固定模型范围，不能声称训练稳定性 | M5 推断单位错误 |
| F14 | 已有 running/unknown_after_timeout，或重复读取/重放 | await/reconcile；预算、运行数、revision 无非预期变化 | M1/M5 恢复或副作用错误 |
| F15 | 大响应的 full/summary | 任务 gate、比较限制、成本和来源状态一致；只读展开 | MCP 摘要遗漏关键限制 |
| F16 | 原 v1 单比较、无 project 的旧工作流 | 原调用继续工作，原 schema 对未知副作用仍拒绝 | 公共兼容性回归 |
| F17 | 代码/论文 artifact 变更或准入撤销 | 依赖视图/评估明确失效，不能沿用旧证据 | 来源更新检查不足 |
| F18 | 数据身份换成非 GCD 的检索例子 | 规则仍按 comparator/quantity/unit/范围工作 | 硬编码本轮案例 |

F06 还必须覆盖“同一个 quantity 在 control 为主检验、在 original 为次要读数”：只有登记的 primary_comparison_id 对应项可按主检验处理，另一项不能因同名自动获得确认性。

工程完成要求 F01—F18、对应回归、实际 HTTP/stdio/Python 调用、历史回放、文档构建通过，并将产物路径写入 Outcomes。实现评估不得只靠模型自述或 JSON 含有某字段。

### 图结构独立效用的受控回放

采用三个表示条件：A 为相同论文段落与实验事实的文本；B 为相同事实的结构化运行/比较记录；C 在 B 上提供有来源的图关系与路径。三个条件使用相同来源集合、相同时间截断、相同模型版本/推理设置、相同工具与预算上限。A 的文本也必须包含原关系所依据的来源段落，不能故意删掉关键信息制造图优势。

按真实时间冻结三个决策点：完整实验结束后的问题诊断、错误分解可用后的控制选择、控制结果产生前的验收设计。每个决策点只给当时可见材料；后续结果、预期答案、评审标签单独保存，不放进模型可见目录或可调用检索源。当前恢复控制的最终结果不得提前加入历史输入。没有相应未来观测的决策点，只评价理由和设计可检验性，不虚构实际收益。

记录原始请求/响应、模型和配置、暴露的 source IDs、工具调用、token/费用、建议、理由、时间，以及错误声明：错误基线、错误归因、伪稳定性、无依据新颖性、无理由重复已测动作。另评价是否提出可区分预测、是否保留必要竞争解释。评分规则按这些具体行为冻结，人工盲评与程序校验分别保存；没有真实评审则标待评，不虚构 reviewer。每臂可预定 3 次独立生成用于描述输出波动；同一案例的重复不当作多个独立科研任务。

prepare-ablation 只准备材料。实际外部模型/付费调用和盲评在已有相关授权下运行；缺少授权时交付具体模型、调用次数、成本上限和已冻结材料供最后审批。不得循环增加调用直到 C 胜出。无论正负结果，都报告 A/B/C 分别的证据和局限。一次 FSGCD 回放不能支持总体科研成功率或 GPU 节约率结论。

## Idempotence and Recovery

原状态/回执规则继续有效。变更响应丢失后先以原 requestId 调 status；已提交则使用原回执，未提交才在核对 revision 后重发完全相同请求。请求内容改变必须使用新 requestId。source_revision 增加只用于原 attempt 的新事实，重启训练才创建新 attempt。只读 evidence_view/generate/evaluate 不产生可恢复的隐藏写入。

每个里程碑产物写到 `.agent/reports/experiment-aware-graph/M<n>/`，包含输入、请求轨迹、验收结果和输出位置。它们是证据，不另拥有项目科学状态。实施进度只在本计划勾选；回放执行状态由其独立 trace/receipt 决定，不能把其完成标志同步到真实 AutoResearch 项目。

恢复时先读本计划 Progress 与最后一个失败/未完成里程碑，查看 git status 和该阶段 trace。运行状态未知先查本地回放服务/真实执行器，绝不因日志中断重复提交。已有完整报告只读复用；部分报告继续原 request ledger 的未完成步骤，若选择重建隔离语料则使用新输出目录并保留旧目录。

本地历史回放的明确恢复命令为：

    node scripts/evaluate-research-feedback.mjs --input .agent/reports/experiment-aware-graph/M0/measured --output .agent/reports/experiment-aware-graph/M6/historical-01 --mode engineering --seed 17 --resume

源文件缺失、外部盘未挂载、服务不可达分别报告具体缺口。可以继续不依赖它们的工程测试，不能把缺失解释为零结果。不得自动重试生产部署、语料导入、模型付费调用、训练、取消作业或数据删除。任何这类动作都先核对已有授权与原任务回执。

## Risks and Rollback

| 风险 | 可观察信号 | 控制与恢复 |
| --- | --- | --- |
| 项目实测污染论文事实 | 原 paper/reflection_chain 出现项目 run 作为论文报告 | 项目仅做派生视图；回退本切片代码，原论文图不应有写入可撤销 |
| 比较或来源更正影响成本 | 同一 attempt 的 spent/独立运行数增加 | 保留原运行身份及累计账本；修正新 source record，不删除历史掩盖错误 |
| 多比较错配 | 同名 quantity 引用错误 comparator/总体 | 拒绝歧义；用 F03/F06 复核；不靠报告文字修补底层绑定 |
| 新 schema 与旧状态不兼容 | v1 请求/旧项目无法读取或新字段被静默丢弃 | 可选增量、旧路径测试；不迁移全部项目；试运行仅用隔离副本 |
| 政策过严导致无限诊断 | 有效完整控制仍被无关材料阻断 | 明确任务范围及探索路径；只要求会改变当前判断的证据 |
| 政策过松导致过度声明 | 单 seed 图像区间产生稳定性/全面提升 | 范围和 comparator 由结构化结果决定，统一 full/summary/report |
| 生产新状态被旧二进制不完整理解 | 回滚后旧服务可能接受未识别字段并写回 | 部署前保存该项目 overlay 一致快照；回滚代码时同时隔离新写入项目，按回执保存恢复所需新事实；不得只降代码后继续写新项目 |
| 同名索引/工作区混用 | 找不到新符号或行号不符 | GitNexus 指定绝对路径，源码定位补证；不依据空结果削弱测试 |

本地回退仅撤销本任务确认的变更，不执行 git reset --hard、不清理无关文件。数据库/语料的生产回滚不属于代码回退：如授权导入，使用该导入任务的状态、来源标识和既有撤回/修复流程，不删除整库。备份只覆盖将被修改的项目/配置，不新增全盘备份框架。

### 部署交接

工程完成后形成可审阅的版本差异、接口快照、测试结果、部署命令和项目备份/恢复路径。先对目标服务做只读能力与版本检查；若已经具备相同能力，不重复部署。需要写目标服务而现有会话没有相应授权时，先交付上述具体产物，再申请该动作授权。不要因旧响应缺第四工具就直接替换服务。

获授权后使用仓库现有部署方式，先隔离演练，再备份将被写入的项目 overlay/配置，保存部署回执，重连客户端并验证 tools/list/capabilities、旧项目 status、新 evidence_view 和不带项目的原查询。当前 FSGCD 训练和自动跟进不属于部署变更。真实 FSGCD 语义缺口修复使用单来源导入/同步任务，记录 taskId 并等待权威完成，再验证具体节点/来源边。未知状态先查询回执，不重复提交。

## Artifacts and Notes

计划阶段证据：`.agent/reports/2026-10-25-experiment-aware-graph-plan/baseline.log`（31/31，通过，0 skipped）、`worktree-before.txt`、本计划同目录 review 文档。实施验收见 `.agent/reports/experiment-aware-graph/ACCEPTANCE.md`；最终全量日志为 `M6/full-test-verified.log`，历史回放为 `M6/historical-verified/`，文档构建为 `M6/docs-build.log`。未执行外部模型对照或生产验收。

真实历史材料根目录为 `/Volumes/yylx-file-station/HYQ/AutoResearch/06-FS-GCD/experiments`。M0 按下列路径读取所需材料并写 source-map；外部盘不可用时不得据此宣布历史验收通过。

- `papernexus_fsgcd_v1/ANALYSIS.json`、`REPORT.md`、`MECHANISM_REVIEW.json`：主实验与机制观察。
- `papernexus_graph_followup/ERROR_DECOMPOSITION.json`、`MAPPING_INVARIANT_REVIEW.json`、`REFLECTION_PACKET.json`、`REPORT.md`：图谱辅助诊断及范围。
- 同目录 `TOOLS_LIST.json`、`capabilities.json`、`paper_fsgcd.json`、`context_fsgcd.json`、`paper_simgcd.json`、`context_error_definition.json`、`evaluate_followup.json`、`BEFORE_GRAPH.md`：真实接口、来源、图谱贡献与查询前已有判断。
- `papernexus_fsgcd_v2/CAUSE_AUDIT.json`、`CAUSE_AND_GRAPH_REVIEW.md`、`PLAN.json`、`SECONDARY_READOUT_ADDENDUM.json`：轨迹、目标比较、冻结计划及主次分析边界。

该列表仅是来源入口；本计划已经包含关键需求和数字，工程设计不依赖读者获得全部旧对话。后续新增结果必须按其发生时间和原冻结规则接入，不能回填到更早的回放输入。

实施证据按 M0—M6 存放，最终报告为 `.agent/reports/experiment-aware-graph/ACCEPTANCE.md`。报告逐项链接 F01—F18、真实请求响应、历史回放、全量回归、文档构建、GitNexus 影响与变更检查；将未执行的外部模型评价和部署单独列明。
