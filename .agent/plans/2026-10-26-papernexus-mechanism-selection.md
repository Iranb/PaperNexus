# 基于知识图谱的机制判断与实验选择 ExecPlan

Created: 2026-10-26 Asia/Shanghai
Updated: 2026-10-26 Asia/Shanghai
Target repository: `/Users/iranb/.codex/worktrees/experiment-aware-graph/PaperNexus`
Target branch: `codex/mechanism-experiment-selection`
Starting commit: `2a65b8e`（当前 main）
Related docs: `docs/interfaces/research-decision.md`、`docs/operations/research-decision-loop.md`、`.agent/plans/2026-10-25-papernexus-experiment-aware-graph.md`
Review: `.agent/plans/2026-10-26-papernexus-mechanism-selection-review.md`
Evidence directory: `.agent/reports/2026-10-26-mechanism-selection/`

本文是持续维护、可独立交接的执行契约。仓库未发现 PLANS.md。实施者按下列里程碑继续，完成、失败或改变设计后更新 Progress、Surprises & Discoveries、Decision Log、Artifacts and Notes、Outcomes & Retrospective。用户已经要求完成计划、审核并实施；无需为常规代码修改与本地验证重复申请许可。

## Purpose / Big Picture

完成后，PaperNexus 能从已有论文语义图和项目实验记录中，返回有来源的局部机制链、竞争解释、未控制因素、预测依据和可复用结果，并据此选择下一项实验。研究者可以沿返回的关系 ID、原文锚点、假设版本、控制检查及运行 ID，理解为什么选这个行动，缺少什么证据，以及什么结果会改变判断。

最小成功场景是：两个候选都有看似分离的数值预测，其中一个没有控制知识图谱中明确指出的混杂因素，另一个控制了该因素。系统选择后者或先选择能够补齐缺口的低成本诊断，并提供具体机制路径和控制引用。若两项预测只是没有依据的数值假设，系统不宣称能够据此确认或排除机制。登记已有条件匹配的结果后，再次查询能复用该结果；明确要求独立复现的行动仍可推荐。

这次交付的验收目标是工程行为，不以“图谱一定胜过文本”作为通过条件。科学成功率、GPU 节约率及模型性能收益需要前瞻对照，不能由离线测试推出。

## Progress

- [x] 2026-10-26：读取 ExecPlan 技能、仓库约束和前序已完成计划，核对主分支、共享状态与测试入口。
- [x] 2026-10-26：复用当前聊天的独立 worktree，在最新 main 上建立 codex/mechanism-experiment-selection；保留主工作区无关 PDF、报告及脚本。
- [x] 2026-10-26：刷新 GitNexus；查询因本地 FTS 只读错误返回空，已使用 context、impact 和源码调用点补充。14 个现有符号的 upstream 输出已保存。
- [x] 2026-10-26：27 项相关基线测试全部通过，包含真实 HTTP/stdio/Python 客户端现有闭环。
- [x] M0：冻结下述接口、证据含义、行为验收与执行边界。
- [x] M0：完成本地计划审核，20/20；科学推断、旧记录和实验复用边界无未解决阻断项，见同目录 review。
- [x] M1：提供实际语义图中的来源锚定机制上下文。
- [x] M2：实现竞争机制、预测依据、控制要求与结果复用的统一分析。
- [x] M3：让推荐及评估使用该分析，并处理旧输入与旧评估的边界。
- [x] M4：接入 MCP、材料/候选查询、导出、摘要与客户端文档。
- [x] M5：完成真实问题回放、可重复行为评价、回归、代码审核及交付。

## Surprises & Discoveries

Observation: 有界路径枚举可能截掉含控制要求的路径，或只留下与实际干预无关的有效子路径。Action: 控制要求由完整登记关系的反向可达性确定；每个待测预测必须有包含所改组件的有效路径。G05 的分支截断测试覆盖此边界。

Observation: 项目默认视图只显示最新假设，公开 actionVersion 可以引用旧假设版本。Action: 任务门控单独解析行动绑定的精确版本；G14 覆盖升级假设后评估旧行动。

Observation: 全量 1,143 项首轮有一个既有 SIGINT 锁清理测试失败；独立复测通过。源代码先创建锁目录、后安装清理处理器，测试观察到目录即发 SIGINT，存在时间窗口。Action: 不在机制选择改动中修改文件锁模块；保留证据并在最终回归后报告此限制。


Observation: 现有 research_decision 已有不可变假设/行动版本、机制组件与路径、精度依据、预算、结果评估和项目证据查询。Evidence: src/core/research/*.js 与前序计划。Action: 本轮扩展已有入口，不再建立第二套实验状态或“新增已有功能”。

Observation: actionDiscrimination 检查区间分离和预计精度，未检查预测区间本身的依据；机制路径与干预组件未参与它的决策。Evidence: src/core/research/action-policy.js。Action: 补上预测依据与路径控制分析，并在评估中使用同一标准。

Observation: paperGraphReadiness 只返回来源锚定关系计数；项目的 mechanism_paths 依赖手工登记，无法直接显示当前语义图中的具体关系和缺失控制。Evidence: src/core/materials/agent-materials.js、src/core/research/project-evidence.js。Action: 从已有材料上下文派生有界的关系与路径，再将登记的机制关系绑定到这些实际关系。

Observation: GitNexus 报 collectEntityEvidence、inspectEvidence、buildProjectEvidence、readProjectEvidence 为 HIGH。collectEntityEvidence 的索引范围为 13 个影响符号、4 个直接调用者；buildProjectEvidence 为 9 个影响符号、3 个直接调用者，涉及决策与 MCP 流程。部分回调调用未被索引记录。Action: 修改前已向用户报告；复用现有依赖收集和快照，覆盖真实公共入口，不能依据零调用结果省略验证。readProjectEvidence 若无须直接改动，保持原样。

## Decision Log

- Decision: 保留四个公共工具及现有操作，仅增加实体字段与返回的机制分析。Rationale: 现有 evidence_view、recommend_next、assess_results、idea_generation 足够覆盖用户流程。Date/Author: 2026-10-26 / Codex。
- Decision: 语义图关系、代码观察、实测关联、机制假设分别标记，不生成因果证明标签。Rationale: SciAgents/HypoChainer 的路径构造不等于干预识别，ABCD/CEO 需要另行成立的因果模型。Date/Author: 2026-10-26 / Codex。
- Decision: 预测的依据可以是经验、推导或明确假设；缺少依据的旧输入仍可登记，但不再凭该预测获得机制区分或确认性结论。Rationale: 修复实际 FSGCD 中任意数值界限被当作竞争解释约束的问题。Date/Author: 2026-10-26 / Codex。
- Decision: 先采用可解释的判别需求覆盖与多资源成本支配，不增加 LLM 概率、任意综合评分或昂贵贝叶斯优化依赖。Rationale: 本项目没有校准的结果分布，CEO 原实现的采集函数本身也有较高计算开销。Date/Author: 2026-10-26 / Codex。
- Decision: 仅在明确的组件、假设版本、协议、测量和控制一致时复用既有运行；文本相似、同名指标或相似题目不建立实验等价。Rationale: 复用必须减少真实重复，不能阻止独立复现或跨条件检验。Date/Author: 2026-10-26 / Codex。

## Outcomes & Retrospective

M1—M4 已实现。材料输出 mechanism_context；项目查询、推荐、评估、摘要与导出使用统一机制证据。政策版本为 discriminating-action-v3。HTTP、stdio 和 Python 客户端通过新字段的闭环测试；旧 schema 仍接受，旧结论不会绕过新政策。

离线 11 个行为/历史案例通过，未启动 GPU、provider 或远端部署。最终全量 1,146 项中 1,144 通过、2 跳过、0 失败，61 项定向测试及文档构建通过。GitNexus 范围为 36 个任务文件和 8 条预期流程。最终审核记录见同轮 ACCEPTANCE.md；科研效率、成功率和图谱相对文本的收益仍未经前瞻模型实验验证。

## Context and Orientation

### Current State Snapshot

工程为 Node ESM，要求 Node >=20.17。当前依赖满足本轮需求。主工作区有无关 PDF 修改和大量既有未跟踪报告；本轮使用既有隔离 worktree，原有未跟踪 M0/M6 报告和 node_modules 链接保持不动。

关键模块：

| 路径 | 现有职责 | 本轮职责 |
| --- | --- | --- |
| src/core/materials/agent-materials.js | 材料准入、选定论文版本、原文读取、图上下文 | 复用这些事实生成具体来源锚定机制关系 |
| src/core/research/decision-contracts.js | 请求与实体 schema、引用验证 | 增量字段、依据引用收集、组件/预测/检查的交叉验证 |
| src/core/research/decision-evidence.js | 证据检查与快照失效 | 将语义关系内容纳入证据快照，关系改变能使依赖失效 |
| src/core/research/project-evidence.js | 项目证据子图与候选反馈 | 输出竞争机制、缺口、控制、可复用观察与来源路径 |
| src/core/research/action-policy.js | 预算、区间区分和行动推荐 | 使用预测依据、图控制覆盖及有针对性的诊断；成本与信息需求分别报告 |
| src/core/research/hypothesis-assessment.js | 运行与预测评估 | 防止无依据界限、未控制路径被升级为机制支持或排除 |
| src/core/research/decision-service.js | 状态与操作编排 | 统一读/评估/推荐上下文，保持现有事务和幂等语义 |
| src/core/research/project-evaluation.js | 任务用途审查 | 机制诊断与实际推荐采用同一组设计缺口 |
| src/mcp/research-summary.js | 有界摘要 | 完整保留小型决策与关键缺口，过大时标记需完整响应 |
| test/fixtures/research-feedback/measured/ | 真实 FSGCD 历史证据 | 以实际历史观察锚定需求，不虚构尚未执行的对照结果 |

新代码优先放入 src/core/research/mechanism-analysis.js 与 src/core/research/mechanism-graph.js，以纯派生函数处理分析，避免把共享材料模块进一步膨胀。必要的函数名和小范围拆分可按可读性调整；若改变接口或验收，须更新本计划并重新审查相应部分。

### Literature Basis

以下文献的必要结论已包含于此，实施不依赖再次阅读外部链接：

- [SciAgents](https://arxiv.org/abs/2409.05556)：知识图谱路径支持机制构想与批评；主要是生成研究假设，不能据此宣称执行过材料实验。本轮借鉴路径与来源，而非其新颖性自评分。
- [HypoChainer](https://arxiv.org/abs/2507.17209)：专家、LLM 与图谱共同整理假设链并优先选择验证候选。小规模任务完成率不是实验成功率。本轮借鉴链到验证对象的显式对应。
- [ABCD-Strategy](https://proceedings.mlr.press/v89/agrawal19b.html)：预算约束下针对局部因果结构选干预。本轮借鉴针对当前分歧取证，不声称实现其贝叶斯算法或理论保证。
- [CEO](https://proceedings.mlr.press/v206/branchini23a.html)：联合结构学习和效果优化。本轮分别表示信息目标、性能目标与成本；没有校准模型时不计算虚假的信息增益。
- [动态知识图谱自动实验室](https://www.nature.com/articles/s41467-023-44599-9)：真实实验将目标、资源、数据依赖和结果连接起来，条件优化使用 TSEMO。本轮保持外部执行器权威与闭环证据引用。
- [GenExp](https://research.chalmers.se/en/publication/553543)：真实酵母实验及图查询把假设、实验条件和统计结果关联。本轮借鉴按条件复用结果；原系统全文未完成审阅，不以其图结构独有效率为已证实前提。
- [An AI Scientist that Doesn't Drift](https://arxiv.org/abs/2608.07542)：图谱决策模块改变方向，但最佳训练模型来自无模块组。操作者和跨流信息可见性存在混杂，图谱被冻结。本轮所有比较维持相同历史可见性，不把模块差异等同于图结构收益。

完整调研来源元数据可从 /Users/iranb/.codex/work/fsgcd-refresh-20261025/graph-autoresearch-survey-20261026 复制到本轮证据目录，保留静态阅读和运行复现的区别。

## Scope

覆盖论文图的来源锚定局部上下文、项目机制路径的证据分析、预测依据、显式控制要求、针对缺口的诊断选择、按实际条件复用运行、结果对下一次选择的反馈，以及接口、文档、离线验收。数据模型及返回字段必须能用于 FSGCD 之外的案例。

## Non-Goals

本轮不训练模型、不新增 GPU 作业、不恢复已停止的定时任务、不修改运行中的 FSGCD 程序、不自动导入文献或调用付费模型，不把任意 KG 当作已识别的因果 DAG，不新建通用本体/数据库/调度框架。远端部署、公开发布和科学效用实验在缺少相应授权时不执行；完成本地可审阅代码与验收不依赖这些动作。

## Non-Negotiable Rules

研究决策仍由 research-decision-state.json 与原事务/回执规则保存。论文图只读；外部运行和测量事实由执行器提供。输入 schema 为增量，原实体可以读取和登记；政策版本更新为 discriminating-action-v3，缺少新证据可能使旧行动变为 needs_input，此行为变更必须公开说明。

任何机制支持或排除必须保留来源、协议、比较对象、推断单位及不确定性边界。可读文件或已准入论文只证明来源可用，不证明推导成立。graph_relation_ids 必须指向当前所选论文版本可核对的关系；引用缺失、错误版本或原文锚点不存在时返回具体缺口。

登记假设的作用链不得被自动改写。新增结果只能以新版本/运行记录/评估表达。读取不写状态、不改变成本、不自动刷新论文。未通过操作检查或发生来源失效时，机制结论不得继续有效。多个可能机制可以并存；不能把一个解释不成立当作另一个机制已证明。

## Authority / Evidence Model

项目状态是登记与评估的持久化权威；corpus 当前语义图和选定原文是关系与来源状态的权威；外部 manifest 是运行记录来源。新的 mechanism_analysis、实验建议和回放报告都是派生证据，不另保存科学真值。

来源关系经过“来源版本一致、关系身份存在、原文锚点可读”检查后，只可标为 source_anchored。机制路径保留 source_supported/code_observed/measured_association/hypothesized；源文锚定不提升为因果支持。预测依据标记 documented/assumed/missing/stale，并保留其说明和引用，不能称为独立验证过的科学推导。

已存在的旧 assessment 不改写。读取历史时保留其政策/依据边界；新政策不可将缺少依据的旧结论当作当前机制确认。需要重新评估时给出具体提示；不要通过批量状态迁移将旧评估“补齐”。

## Interfaces and Dependencies

保持 public operations 不变。新增字段遵循现有 snake_case：

- prediction.basis：kind=empirical|derivation|assumption，rationale，evidence_refs。前两类用于明确量化预测的依据，assumption 用于尚待检验的假设。仅有精度 basis_refs 不能替代预测依据。
- mechanism_evidence.components[].graph_node_id：可选的实际语义图节点身份；observable 可附 quantity/unit。未知身份留为未连接，不能按名称猜测等价。
- mechanism_evidence.links[].graph_relation_ids：可选实际关系 ID；required_controls 为本假设内组件 ID。每个要求表示该路径需要固定/匹配的因素，并沿该边保留来源。自环、悬空组件、与预测重名的组件须拒绝；作用链可含反馈，遍历有界且不将环当作 DAG 证明。
- action.controlled_components：组件的 hypothesis_id、hypothesis_version、component_id 与 check；check 必须包含于 action.validity_checks。不能把同一组件同时登记为改变与保持固定。
- action.information_targets：具体的假设版本及 prediction_basis、precision、path 或 control 缺口；前三类绑定 prediction_id，control 绑定 component_id。诊断不因名字叫 diagnostic 就自动获得优先级。
- 输出 mechanism_analysis：hypotheses、source_context、prediction_basis、paths、control_requirements、evidence_gaps、reusable_evidence 与 coverage/limitations。引用假设精确版本和现有关系/运行 ID。
- recommend_next 增加 mechanism_analysis、每个候选的 mechanism_test 与 selection_basis。若同条件已有足够结果而候选只是重复设计，可返回 reuse_evidence 及可读取的记录；replicate 不因此阻断。
- material view 增加 mechanism_context，保留原 graph_context 和 graph_readiness。小范围多跳上下文必须暴露实际截断，不能因上限删掉边后声称没有相关关系。
- 摘要保留 decision、mechanism_test/关键 reason_codes、证据时效和成本。超预算的完整机制路径由原只读请求展开。

代码可在这些约束内调整字段具体嵌套，使接口清晰；新增或删减行为必须同步 schema、文档、测试及计划。

## Plan of Work

### M0：合同与计划审核

已核对相关实现和基线。将本计划按交接性、可观察结果、当前状态、边界、可验收切片、验收、恢复、风险、进度和决策十项审核，满分 20，至少 16 且风险 2 分。另审查科学推断与图谱独有贡献。审核发现必须在开始相关实现前解决；评分不是科学有效性的证明。

产物是本文、独立审核记录、源码/影响范围记录和调研元数据。失败时只修正不清晰的合同，不扩大到全库重构。

### M1：实际论文语义图的机制上下文

在新纯函数中遍历选定论文的有限邻域（最多三跳和固定关系/路径上限）。保留关系方向、节点类型/名称、关系 ID、原始论文身份、原文片段和 source_span 引用。排除 Corpus 成员关系等结构性信息；不把另一论文通过共享 Method 节点连入的关系归属给当前论文。必须验证每条可用证据边的来源和片段，候选/未锚定关系只列为待核对上下文。

复用 buildPaperMaterialView 已读取的 graph、selectedSource 和 readable 文本，避免额外 provider 调用或第二次全库加载。inspectEvidence 将必要上下文纳入相同来源快照，因此关系内容更新、撤回或版本改变会使依赖失效。

验收：真实持久化的临时 corpus 包含一条带原文证据的两跳链、一条错误引文边、一条跨版本边和 Corpus 关系；公开材料/项目查询只将有效边作为来源锚定上下文，其他边保持具体缺口。修改原文或删除关系后再次只读查询可见失效；项目 revision 不变。

### M2：统一机制分析与控制需求

新增 buildMechanismAnalysis，从现有 state 和当前证据快照构建派生分析。连接登记的组件、预测、实际图关系和当前运行测量；遍历到预测时保留路径上的 required_controls，输出断链、来源不符、未记录依据和已有观察，不用文本相似度建立身份。

预测依据只确定是否已明确提供及来源是否当前可用。其陈述正确性仍需研究判断；返回措辞必须反映这一点。对于明确 assumption 或没有 basis 的区间，系统仍显示原预测及数据关系，但不能称足以确认/排除实际机制。

用 action 的精确组件引用与操作检查覆盖控制要求。缺少控制产生可直接用于修订行动的 control_requirements；缺少依据或精度产生 information_targets。一个候选改变多项因素时，系统说明哪些路径未隔离，而不是仅输出 compound_intervention 标签。

验收：同一因变量可由两个机制解释；只有控制了图中 nuisance 组件且预测依据明确的对照获得可区分资格。代码事实、关联与假设状态不被提升。多个解释可以同时 compatible。第二个非 GCD 案例复用同一逻辑。

### M3：行动选择、结果评估与复用

actionDiscrimination 除区间和精度外还检查预测依据；recommendNextAction 使用同一机制分析检查所选路径与控制。既有 reconcile→await→assess 顺序不变；不能先跑诊断再处理未知作业。可执行候选仍须通过原预算和版本门控。

优先选择明确填补当前关键缺口的已登记诊断，其 information_targets 必须对得上实际缺口；否则保留为普通候选。之后比较能够覆盖相同分歧和控制需求的实验，用逐资源上界进行支配判断；比较身份、单位、条件不同的实验不得互相支配。成本不同但信息需求不同的实验保留为不同取舍，不强行生成单一收益分数。

结果评估使用实际运行的控制检查、预测依据与登记路径。缺乏数值依据只能评价该假设性区间，不能以其不一致排除更宽的机制。未控制另一条路径时，不产生充分区分机制的声明。新结果/来源更正后，新的视图和推荐使用更新状态；保留原观察，不将结果改写到旧论文关系。

复用只适用于当前、已完成且有有效评估的记录，比较精确假设版本、协议、组件、控制检查、测量和分析规则。新的 replicate 仍需要独立运行。未完成、过期、宽区间未决或不同条件结果只能作为上下文。候选改名不得绕过同条件已完成结果的复用判断。

验收：无依据的“优化效应最多 0.5 点”不再排除优化解释；缺控制先修设计或做有针对性的诊断；有效运行改变后续选择；等价设计复用，独立复现放行；来源变化及不同 comparator 保持分离。

### M4：可用公共接口与文档

将 mechanism_analysis 接入 evidence_view、recommend_next、idea_generation 的项目反馈/机制诊断用途与 export。使用现有 HTTP/stdio MCP 和 Python request-file 客户端，不新增工具或传输层。必要时在 task_gate 中列出和 recommendation 相同的控制/预测依据缺口，避免两个入口互相矛盾。

更新完整 schema 快照、接口文档、运行指南、规范 skill reference 与生成的参考文档。示例需包含完整可登记 payload、读查询和预期返回；任何工程用数值必须标 synthetic_fixture，不呈现为论文报告。

验收：真实 HTTP 和 stdio 从登记到查询/推荐/记录/评估/再次推荐可完成；响应丢失后 status(requestId) 仍可恢复；summary 与 full 不得对机制就绪、预算或 next action 给出相反结论。新请求不带状态写权限时仍只是读取。

### M5：行为评价、回归与交付

新增离线评价脚本 scripts/evaluate-mechanism-selection.mjs，生成逐例输入、输出、决策依据、失败和实际本地耗时。评价包含合成真值案例与真实 FSGCD 历史事实；合成效果、反事实对照和真实观察分开。FSGCD 未执行的打乱/梯度匹配对照只能生成设计建议，不能填入效果数值或胜率。

评价至少包含：移除关系连接但保留相同事实文本、移除预测依据、添加控制、修改来源、重复设计、独立复现、不同协议及 comparator。图结构消融是行为检查，输出其实际决策差异，不以它胜出为验收条件。为未来文本/KG/KG+选择器比较准备相同信息与时间截断的输入包；准备包不能计为执行了模型实验。

相关测试通过后跑一次全量 npm test 和 docs:build；有新改动或实际失败才增加对应检查。完成代码审核，尤其检查声明过强、来源串联错误、历史结论误用、漏算成本和摘要丢失条件。记录 GitNexus detect-changes，核对工作区差异只包含任务文件，交付可审阅结果。

## Concrete Steps

所有代码命令在 Target repository 执行。GitNexus 当前使用别名 PaperNexus-mechanism-selection。新增符号记录首次无调用；修改已有符号前必须执行 upstream impact，风险 HIGH/CRITICAL 先告知用户。索引过期按仓库要求刷新。

    npx --no-install gitnexus analyze --name PaperNexus-mechanism-selection --skip-agents-md
    npx --no-install gitnexus impact SYMBOL --direction upstream --repo PaperNexus-mechanism-selection

阶段测试按实际新增文件执行：

    node --test test/research-mechanism-graph.test.js test/research-mechanism-analysis.test.js
    node --test test/research-mechanism-selection.test.js test/research-decision-policy.test.js test/research-decision-assessment.test.js
    node --test test/research-mechanism-mcp.test.js test/mcp-research-decision.test.js test/research-project-evidence.test.js test/research-purpose-gates.test.js
    node scripts/evaluate-mechanism-selection.mjs --output .agent/reports/2026-10-26-mechanism-selection/evaluation
    npm test
    npm run docs:build
    git diff --check

schema 快照更新只在审阅新增合同后，使用对应已有 UPDATE_PAPERNEXUS_DECISION_SCHEMA 等入口；不得为消除失败盲目重建所有快照。更新后不带环境变量执行相同检查。最后运行：

    npx --no-install gitnexus analyze --name PaperNexus-mechanism-selection --skip-agents-md
    npx --no-install gitnexus detect-changes --repo PaperNexus-mechanism-selection

具体命令输出和退出码记入证据目录。若现有工具参数与此处不同，先读 help 并记录实际命令；不猜测远端部署命令。

## Validation and Acceptance

| ID | 行为 | 通过证据 |
| --- | --- | --- |
| G01 | 从持久化 corpus 读取来源锚定多跳关系 | 实际关系 ID、来源身份、片段、方向与截断状态正确 |
| G02 | 不将跨论文/跨版本/错误片段/Corpus 边当机制证据 | 指定拒绝/未验证原因，不能升级为 source_anchored |
| G03 | 同条件竞争机制有明确路径与预测 | 输出精确假设版本、路径、必要控制与适用范围 |
| G04 | 人工阈值没有依据 | recommend 不宣称充分区分，assessment 不确认/排除机制 |
| G05 | 真实证据路径要求控制，行动未满足 | 具体 control_requirements；修订后缺口消失 |
| G06 | 控制已登记但实际运行未通过 | 评估不产生机制支持/排除，保留原始测量 |
| G07 | 低成本诊断针对实际缺口 | 推荐改变并返回命中的 information_targets；不相关诊断不会抢先 |
| G08 | 同分歧不同成本及不同比较身份 | 支配只发生于可比需求和资源；不跨 comparator/单位 |
| G09 | 已有同条件有效结果 | 新名字的重复设计返回可复用记录；replicate 可继续 |
| G10 | 结果过期、不同条件或未决 | 不当作已回答问题，继续保留必要实验 |
| G11 | 修改论文关系/原文、运行 supersession | 依赖失效可见；没有隐藏写入或成本变化 |
| G12 | 公共 workflow/HTTP/stdio/Python | 新分析真实可调用，写入恢复保持原回执语义 |
| G13 | summary/full/export | 决策、机制缺口、预算和限制一致；大响应只读展开 |
| G14 | 旧 schema 和旧项目 | 仍可解析；缺依据给出修订提示，旧确认边界明确 |
| G15 | 非 GCD 案例 | 无指标、论文名或领域硬编码 |
| G16 | FSGCD 历史回放 | 真实观察与未执行建议分开，没有新训练/付费调用 |
| G17 | 全量回归、文档及范围 | 测试/构建退出成功；GitNexus/差异仅涉及预期功能 |

若某项不可完成，必须在 Outcomes 写明实际边界，不能将 prepare、静态阅读或合成测试写成已执行的科学实验。工程完成需要 G01—G17 的适用行为通过，无未解决的阻断性审核问题。

## Idempotence and Recovery

保留既有 state lock、expectedRevision、requestId 和 source_revision。读取可重复，不生成隐式写入；测试使用独立临时 corpus。评价脚本输出到指定目录，输入与报告保存为独立 artifact；完成的评价目录重复执行只读取已保存结果；重算使用新的输出目录，不提交作业或改真实项目。

中断后读本文 Progress、git status 和最后验收报告，从未完成里程碑继续。缺少报告不代表任务未提交：任何写请求先查询原 requestId 的回执，未知运行先向执行器对账。不得自动重试训练、导入、付费请求、部署或取消作业。

回滚仅撤销本轮代码和隔离测试产物，不重置用户工作区、不清理无关未跟踪文件。新字段是增量，但旧二进制对新政策记录不具备相同解释；降级时保留只读原记录，不通过旧程序继续覆盖新记录。生产数据从未迁移，因而本轮无需生产状态回滚。

## Risks and Rollback

主要风险是把来源可用性误认为因果有效性、把预测范围的反例当作机制反例、把不充分控制当作已区分机制，以及把仅同名的实验当作可复用。对应 G02/G04/G05/G06/G09/G10 直接阻止这些错误。若某个组件证据不足，输出可操作缺口并继续允许有预算的探索，不引入无限审查循环。

共享入口的变更风险通过薄接入、纯函数分析、现有工具不变、真实 MCP 回归和全量测试控制。有限路径遍历可能漏掉机制，必须报告覆盖上限和未验证关系；不能由缺少检索结果推断机制不存在。

局部图关系变化会改变来源快照；旧项目首次升级可能需要显式 refresh_evidence。刷新只更新项目证据快照，不启动导入，不自动为缺失预测依据填值。旧结论与新政策结论分别展示，避免用户误以为原评估被悄悄重写。

## Artifacts and Notes

计划与本地审核在 .agent/plans/。源码影响、测试日志、评价逐例结果、来源清单和最终 ACCEPTANCE.md 在 .agent/reports/2026-10-26-mechanism-selection/。交付时链接计划、审核、主要接口文档及最终验收报告，报告实际检查与限制。

Baseline: 27/27 related tests passed, 0 failed, 2026-10-26。涵盖 contract/policy/assessment/mechanism evidence/project evidence/purpose gates/MCP，HEAD=2a65b8e。

## Revision Notes

2026-10-26：根据七项调研工作和当前代码建立增量计划；将图谱来源、机制判断、实验选择、证据复用与科学效用评价分开规定。实施后补充完整可达控制检查、精确旧版本评估、原始评估/当前解释并存、公开客户端验收与最终回归结果。
