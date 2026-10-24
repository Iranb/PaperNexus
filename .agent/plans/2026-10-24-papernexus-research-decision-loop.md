# 建立由实验反馈驱动的科研决策闭环 ExecPlan

Created: 2026-10-24 Asia/Shanghai
Updated: 2026-10-24 Asia/Shanghai
Target repository: `/Users/iranb/Library/Mobile Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus`
Target branch / worktree: 计划基于 `main`，HEAD=`2cccb40f46ceac2b62756561eb31e940a03dfe29`；实施时使用 `codex/research-decision-loop` 或当时已存在的合适任务分支。
Related docs: `docs/agent-materials/research-controller-skill.md`、`docs/operations/research-pipeline.md`、`docs/interfaces/mcp-skill-contracts.md`、`docs/interfaces/mcp-three-workflows.md`、`SKILL/PaperNexus/references/autoresearch-adapter.md`。
Plan review: `.agent/plans/2026-10-24-papernexus-research-decision-loop-review.md`。

本文是持续维护的执行契约。实施者只需当前仓库和本文即可继续，不依赖聊天记录。仓库未发现 `PLANS.md`。每个里程碑后更新 Progress、Surprises & Discoveries、Decision Log、Artifacts and Notes、Outcomes & Retrospective，按依赖顺序完成后续工作。

当前授权包括按本计划实施、提交 GitHub 并合并 main。用户另授权以真实 AutoResearch 项目验证研究推进，问题参考会话 01a10f21-8c1f-7040-9e2a-b9cfe4755e96；可使用 SSH/HPC，新增 GPU 总预算 100 小时。生产服务部署不在本次授权内。真实验证使用独立单元，保留原项目执行与预算权威。

## Purpose / Big Picture

完成后，PaperNexus 能持续回答四个问题，并给出可定位的依据：有哪些值得保留的研究机会；当前优先验证哪个假设及其最小实验；新结果支持、削弱或仍无法区分哪些解释；剩余预算应投向哪项行动。

用户可通过 MCP 建立项目，登记由文献支持的竞争假设，预先保存预测与判定规则，接收外部执行器的真实运行记录，再取得有范围限制的解释更新和下一步建议。新证据、反例或资源变化可以唤回暂存候选。一次完整流程必须产生可阅读的决策报告和可复核的结构化记录；不能只增加 schema、提示词或评分字段便宣布完成。

PaperNexus 负责证据组织、假设与行动记录、可复核的条件判断及预算建议。外部 AutoResearch/实验执行器继续负责作业提交、实际运行状态和原始测量。解释比较由确定性规则处理能明确计算的部分，由研究 Agent 提供有来源的定性分析；模型偏好不转换为实验成功概率。

第一版覆盖受控实验的结构化指标、明确的比较条件、外部提供且可审计的不确定区间，以及定性材料缺口。它不提供通用因果发现器，也不把启发式效用写成贝叶斯后验或预期信息增益。四项能力必须端到端成立，即使某个输入不足时正确答案是“先补这个测量或对照”。

## Progress

- [x] 2026-10-24：核对当前源码、MCP 路由、研究 controller、反思提取、成本材料、持久化与现有测试；记录版本和工作树边界。
- [x] 2026-10-24：完成四项能力的接口、状态权威、科学判定、预算策略、分阶段验收与恢复设计。
- [x] 2026-10-24：完成计划自审，覆盖度 19/20；可进入本地实施，线上版本和真实运行 manifest 待对应阶段核验。审核记录见同目录 review 文档。
- [x] M0：冻结可运行的验收样例与接口契约，完成逐符号影响分析。
- [x] M1：交付可从 MCP 使用的假设记录和项目决策状态最小切片。
- [x] M2：接通真实运行记录、竞争解释评估及反思不确定性修复。
- [x] M3：交付基于判别实验与真实成本的下一步建议。
- [x] M4：交付多来源机会记忆、补证请求和条件触发的候选重访。
- [x] M5：完成 AutoResearch 交接、完整 MCP/脚本体验、文档与恢复演练。
- [x] M6：完成离线行为评测、兼容性回归和最终代码审查；记录能力与有效性边界。
- [ ] M7：完成真实 AutoResearch 的完整测试集补证分析、回执、评估与下一步建议；单独报告新增 GPU 消耗。
- [ ] 发布：提交任务文件、创建 GitHub PR、合并 main 并核对远端提交。

## Context and Orientation

### Current State Snapshot

`src/mcp/research-workflows.js` 提供默认三个工具 `literature_review`、`lineage_analysis`、`idea_generation`，包括能力发现、严格按 operation 校验和 32 KiB 摘要。默认创意入口只读，不运行 controller。高级 `agent_materials/research_controller` 位于 `src/core/materials/research-controller.js`，已有问题分解、候选图、评审、选择、方法卡、设计评审、创新简报和计划型实验方案。

controller 的 `duelingPosteriorSummary` 从成对评审偏好更新 Beta 参数；`buildSelectedSubgraphs` 结合效用、覆盖与候选关系选择方案，并保留 `parked`/`needs_evidence`。`offlineBanditSimulation` 的奖励来自图谱与评审，`offlineBanditCostNormalizedMetrics` 的分母是评分事件数。它们不能代表科学假设成立概率或真实计算收益。本计划保留其现有用途和字段。

`src/core/enhancements/extract.js` 的反思链来自论文中的实验、发现、限制和讨论；连接依赖锚点与文本相似度。`buildReflectionOverlay` 缺少反思时的兜底分支会把 `inconclusive` 也写成支持性解释，必须用回归样例纠正。`src/server/api.js:reflectionChainPayload` 读取这些论文 overlay；新实验评估不应冒充该接口的论文事实。

`src/core/materials/agent-materials.js` 的 `buildNegativeEvidencePack` 主要记录检索范围与缺失，`buildExperimentCostMaterials` 提取论文中的成本线索；两者不提供实测实验反证或本机运行费用。`buildPaperMaterialView`/材料包已有来源准入与版本处理，可直接复用。

`src/core/materials/project-overlay.js:projectOverlayPaths` 给出项目目录和 `.overlay.lock`。现有 `evidence-cart.jsonl` 是材料记忆，`workflow-state.json` 是调用方工作流记忆，`controller-state.json` 是候选探索流程状态。`src/lib/fs.js:writeJson` 使用临时文件与 rename 原子替换，`withFileLock` 提供本地文件锁。新闭环复用这些机制，不建立新数据库或分布式锁。

现有测试可复用：`test/agent-materials-tool.test.js` 的临时语料与 controller checkpoint 测试，`test/research-pipeline-contract.test.js` 的摘要和副作用边界，`test/material-quality-admission.test.js` 的来源准入，`test/research-chain-api.test.js` 与 `test/enhancements.test.js` 的反思路径，`test/mcp-research-workflows.test.js`/`test/mcp-schema-snapshot.test.js` 的公共接口契约。工程为 Node ESM，要求 Node >=20.17；没有必须新增的生产依赖。

当前只核对了本地源码。配置中的 MCP 端点连接被拒绝，未确认线上部署版本。此前计划中的远端通过记录不作为本次能力验收。当前工作树已有论文 `main.pdf` 修改，旧计划、`.agent/reports/`、iCloud 重复文件和无关脚本；保留这些文件，不清理、不暂存、不覆盖。

### Terms and System Map

候选是值得阅读或设计的研究方向；假设是有适用范围、竞争解释和可观察预测的断言；行动是下一项可执行的取证或实验工作；运行是行动在外部执行器上的一次实际尝试；评估是依据已登记预测对有效观测进行的判断；建议是基于某个状态版本给出的下一步选择。推荐、批准、运行完成与科学支持是不同事实。

    文献/方法谱系/跨域材料 -> 候选与机会记忆
                          -> 假设及竞争解释 -> 预测与行动计划
    外部运行记录 -------------------------> 有效性检查与解释评估
    来源变化/预算变化 --------------------> 机会重访与下一步建议
    下一步建议 -> 外部执行器的既有授权与执行流程 -> 新运行记录

## Scope

增加一个面向项目的科研决策工具，支持假设登记、行动登记、运行回流、解释评估、预算建议、机会状态和证据重访。将当前多来源探索结果接入同一项目，保留负结果、未解决问题、暂存原因和重访条件。修正反思兜底的肯定化问题。交付可复用 Node 核心、MCP、规范 Python 客户端入口、完整示例、离线评测和部署交接文档。

默认 MCP `research` profile 从三个工具增加为四个，新增 `research_decision`。原三个工具的读写语义与旧工具接口保持不变；`legacy` 的原工具集合保持不变，`all` 增加新工具。新工具通过 `literature_review/capabilities` 被明确列出，客户端更新后需要重新连接以刷新工具列表。这是显式、增量的工具发现变更。

## Non-Goals

不自动启动训练、预留 GPU、提交 HPC 作业、调用付费 provider、批量导入语料或部署生产服务。不重写现有 controller、不更换 Kuzu/图谱存储、不迁移原始论文事实、不复制 AutoResearch 的阶段状态机。不建设通用统计软件、任意领域因果发现器、在线强化学习平台或新的 Web dashboard。首版用户界面为 MCP 响应与导出的 JSON/Markdown 报告。

不以合成评测或 LLM 自评宣称提高论文新颖性、真实科研成功率或节省真实 GPU 成本。首版必须提供可靠的决策支持行为；现实科研效用属于单独记录证据的后续验证。

## Non-Negotiable Rules

实验结果、论文报告、Agent 推断、检索缺失、候选偏好和模拟结果具有不同 `evidence_origin`，不可混合计数或互相提升。来源准入通过不等于发表真实性已独立核验。没有检索到文献不等于假设被反驳；运行失败不等于科学假设失败；不显著不等于等效或无效。

只有明确协议、指标方向、比较对象、实际干预有效性与不确定性依据的观测，才能推动对应范围的科学判断。没有足够信息时返回具体缺口与最小补证行动。不可给所有未知值填零，不可强制选出获胜假设，不可把候选质量分数解释为成功概率。

已被运行引用的假设、预测、判定规则和行动版本不可原地改写。更改产生新版本；回填历史运行必须标为回顾性分析。新的定义不能追溯性地把旧结果升级为预先预测成功。

本地记录和建议不授予外部执行权限。继续沿用已有发现、导入、模型和实验的授权规则；已有明确任务授权应复用，不添加泛化的重复确认。所有远端、付费、部署和训练操作须在获得相应授权后单独执行，并有 dry-run/隔离演练、回执和回滚路径。

实施修改任何既有函数/类/方法前，运行 GitNexus upstream impact，报告直接调用者、受影响流程与风险；HIGH/CRITICAL 先提示。提交前运行 detect_changes。索引过期先 analyze；工具返回 UNKNOWN 或找不到符号时记录局限，继续用准确路径、context 和源码调用点核对，不能把零结果当成无影响。实施影响分析使用当前工作目录的完整 repo 路径，避免同名旧索引。

不新增无决策用途的文件哈希、兼容包装层或迁移框架。复用现有版本与 ID；幂等请求比较规范化后的结构内容即可。测试首先针对真实支持输入的错误结果、重复计费、状态丢失和错误科学判断。

## Authority / Evidence Model

新增项目文件 `research-decision-state.json`，由 `projectOverlayPaths(rootPath, project).root` 定位。它是该项目的假设版本、行动版本、科学评估、机会生命周期、已接收运行引用、预算记账与请求回执的唯一持久权威。所有报告、摘要和导出都是它的投影。

现有 `controller-state.json` 继续拥有文献候选生成和评审流程，AutoResearch 继续拥有实验执行与项目阶段。新状态引用 `candidate_id`、controller artifact 路径及其观察到的版本，但不回写 `selected/committed/completed`。一个旧候选可以产生多个竞争假设；候选暂存不等于某个假设已被证伪。

外部运行 manifest 和原始指标文件决定运行与测量事实。PaperNexus 保存读到的版本、必要的规范化值及来源定位，不宣称它独立执行了实验。来源更正通过显式新记录 `supersedes_record_id` 引用旧记录；旧评估保留历史，但不再作为当前建议的有效依据。

论文事实继续受现有 source/quality/version 权威约束。论文准入检查只应用于论文材料；external_measured 的可核验性来自对应执行器 manifest 和指标 artifact，不能因其没有 paper_id 而隔离，也不能因论文准入通过而认证实验真实。`evidence-cart` 可以保存材料引用；不另存可以独立改变假设状态的“完成标志”。模型的定性解读作为注释存在，不能直接覆盖确定性有效性检查。

状态写入遵循：锁内重读 -> 校验 `expected_revision`/幂等键 -> 验证输入与计算局部转换 -> 单文件原子替换。锁内不调用模型、网络或长时间材料读取。昂贵读取在锁外基于一个版本完成，提交前再次检查该版本；不一致时返回 `revision_conflict`，不自动重跑付费工作。模型上下文只保存摘要与引用；完整日志留在原执行系统。

## Interfaces and Dependencies

### 新增模块与既有接入点

新增 `src/core/research/decision-contracts.js` 管理输入、状态和结果的版本化契约；`decision-store.js` 管理原子读写与回执；`hypothesis-assessment.js` 处理协议核对与预测判定；`action-policy.js` 处理行动可行性、判别能力与预算；`opportunity-memory.js` 处理补证和重访条件；`decision-service.js` 编排这些纯逻辑及现有材料读取。

新增 `src/mcp/tool-research-decision.js`，导出 `RESEARCH_DECISION_TOOL` 和 `executeResearchDecisionTool(args, options)`。在 `src/mcp/core.js:executeTool` 注册分发，在 `src/mcp/research-workflows.js:listMcpTools/researchCapabilities` 注册发现。工具定义使用明确的 operation 联合 schema，不接受任意 backend/options 透传。核心函数至少提供 `validateHypothesisSet`、`validateActionPlan`、`assessObservation`、`recommendNextAction`、`evaluateRevisitTriggers` 和 `executeResearchDecisionOperation`，便于纯函数测试与 MCP 集成共用。

`src/core/materials/agent-materials.js` 的公开只读材料构建函数用于原文、协议和成本依据；传入现有关闭 provider/import 的选项。不要从新模块调用 controller 的未导出私有函数，也不要复制整套候选生成器。旧 controller 的 status/export 可附带新决策状态的只读引用；这不是新状态的写入路径，旧项目无该文件时保持原行为。

### MCP 工具契约

新工具名为 `research_decision`，契约版本为 `papernexus-research-decision-v1`。公共字段是 `operation`、`corpus`、`project`、`responseMode=full|summary`。变更操作还要求 `requestId`、`expectedRevision`（首次 init 例外）和按操作定义的 `payload` 对象；外层字段沿用 MCP camelCase，payload 内实体字段统一 snake_case，不新增同义别名。`dryRun=true` 完整验证并返回计划差异，但不创建目录、状态或导出文件。

| operation | 输入与能力 | 副作用及权威 |
| --- | --- | --- |
| `init` | 研究目标、约束、预算、科学目标优先级、探索预算上限 | 创建新的项目决策状态；不初始化或重跑整个旧 controller |
| `status` | 可选 requestId 或实体 ID | 只读当前状态、原请求回执和未解决问题；不存在则返回 `not_initialized` |
| `register_hypotheses` | 假设集合、竞争关系、来源与预测；可关联现有候选 | 保存新版本；缺少机制/对照/预测的内容只能是 `draft` |
| `register_actions` | 取证/实验/测量行动、可检验预测、协议、成本与停止规则 | 保存行动版本；仅是计划，无作业提交 |
| `record_run` | 外部尝试 ID、运行状态、测量、成本与原始 artifact 引用 | 幂等接收运行及更正记录；不立即宣称支持或排除 |
| `assess_results` | 已保存的运行记录 ID、对应假设/行动版本、可选有证据注释 | 生成有范围的科学评估；刷新依赖失效状态 |
| `recommend_next` | 可选行动集合；目标取项目已登记阶段 | 只读计算一项主建议、候选替代方案或补输入要求，不预占预算 |
| `update_opportunities` | 暂存/恢复/退役/预算调整/重访条件等明确变更 | 记录原因与条件；无科学判定覆盖权限 |
| `refresh_evidence` | 要检查的来源/候选引用；未给时检查本项目现有依赖 | 只读源材料并更新本地依赖准入、补证请求和触发记录；不发现或导入新论文 |
| `export` | 当前状态或已保存 assessment ID | 返回完整 JSON/Markdown；显式 outputDir 才写服务器上的报告文件 |

payload 形状固定：init 使用 `{objective, goal_phase, budget, exploration_limit}`；register_hypotheses 使用 `{hypotheses:[...]}`；register_actions 使用 `{actions:[...]}`；record_run 使用 `{run:{...}}`；assess_results 使用 `{run_record_ids:[...], hypothesis_versions:[{hypothesis_id,version}], analysis_annotations?:[...]}`；recommend_next 使用可选 `{action_ids:[...]}`；update_opportunities 使用 `{changes:[...]}`，change 的 op 限于 `park|reactivate|retire|set_revisit_conditions|set_budget|set_goal_phase`，每项携带 reason；refresh_evidence 使用可选 `{source_refs:[...], candidate_refs:[...]}`。status/export 选择器为各自明确的 requestId/entityId/assessmentId 字段，不支持任意查询表达式。

`recommend_next` 返回确定性的建议内容、`based_on_revision`、证据版本与未解决假设对。建议引用是 `{project,revision,policy_version,goal_phase,action_id,action_version,scope_action_ids}`，无需额外哈希；完整建议快照在执行器接收该行动的 record_run 回执中保存。重复读取不增加建议次数、预算消耗或探索配额。新工具整体 `readOnlyHint=false`，每个操作的 `effect` 明确为读取、项目状态变更或报告写出；`destructiveHint=false`，默认无外部网络。

建议的 `decision.kind` 为 `execute_action|assess_results|await_run|reconcile_run|needs_input|stop`；只有 execute_action 分支引用一个可执行行动，且仍不代表执行授权。recommend 先检查关联运行：已完成但未评估则要求 assess，正在运行则 await，超时未知则 reconcile，不再推荐同一个未结清尝试。复验须登记新的独立尝试和原因。

init 对已有项目使用新请求 ID 时返回 already_initialized，不重置状态。首版不实现任意历史 revision 的整库重建；保存的实体版本、评估快照和请求回执足以复核已做决定。读历史 assessment 时同时显示其当前有效性，不让旧结论看起来仍是当前建议。

标准响应含 `contractVersion`、`tool`、`operation`、`project`、`revision`、`result`、`evidenceBoundary`、`nextActions`。科学缺口使用 `needs_input/unassessable/inconclusive` 等业务状态；schema 错误使用现有 JSON-RPC 错误，附稳定的原因码。状态冲突、同 requestId 不同输入和数据损坏分别返回 `revision_conflict`、`request_conflict`、`state_corrupt`，不可转换成成功空结果。

`status(requestId=...)` 能读回已提交回执。摘要变更操作的 `read_more` 必须指向 status/export，而不能重放 register/record/assess/update。扩展 `src/mcp/research-summary.js` 时保留原发现/导入回读规则，精确保留有界的 `assessment_gate`、`budget_gate`、`execution_authority` 和 `based_on_revision`；超过预算则明确要求只读 full 回读，不能截断出“允许执行”的假象。

### 假设、预测与行动数据

Hypothesis 具有稳定 `hypothesis_id` 和递增 `version`，包括 `statement`、`mechanism`、`scope`、`intervention`、`control`、`candidate_refs`、`evidence_refs`、`assumptions`、`alternative_hypothesis_ids`、`prediction_ids`、`falsification_rule`。登记 payload 可内嵌 `predictions`，在状态中规范化为版本化预测和 prediction_ids；同一批次先解析全部 ID 再校验相互引用。相同机制的两个实现可引用同一假设，不凭标题相似度自动合并。

证据引用至少区分 `paper_reported`、`external_measured`、`agent_inferred`、`search_absence`、`synthetic_fixture`，并保留来源 ID、版本、span/表格/文件定位及准入状态。来源稀疏的跨域想法可以进入 draft/补证池；不能自动赋予“已验证迁移”标签。

Prediction 声明一个可测的量、条件、比较方向、预期范围或阈值、最小有意义效应，以及它对应的竞争解释。Action 绑定这些预测版本、数据/协议、测量方法、期望区分的假设对、干预有效性检查、估计成本、停止条件和结果分支。第一版支持 `read_source`、`search_literature`、`inspect_code`、`profile_cost`、`repair_baseline`、`diagnostic`、`controlled_experiment`、`replicate`、`scale_test`；检索行动只输出既有工具调用计划，执行仍遵循原授权流程。

不让模型只输出“做消融”便通过登记。一个可推荐实验至少明确改变什么、保持什么、测量什么，以及不同结果改变哪项后续决定。若缺少这些内容，返回可补全字段与原因，而不是自动补成科学事实。

机会生命周期与科学判断分开：`active/parked/retired` 说明当前是否投入；`untested/compatible/supported_in_scope/weakened_in_scope/excluded_in_scope/inconclusive/conflicted` 说明证据关系。`draft` 是设计完整度。一个 retired 方向可以是有支持但暂时成本过高；一个 active 方向也可以仍然没有实验支持。

### 运行与协议数据

Run 使用外部 `executor_id + run_id + attempt_id` 定位，记录 `status=queued|running|completed|failed|cancelled|unknown_after_timeout`、关联行动/假设版本、开始/结束时间、源文件引用和源记录版本。不同 seed 或重新启动的尝试有不同 attempt；同一次运行的状态更新不新增一次成本。

协议包含数据集及版本、split/预处理、可用标签、训练与评估数据权限、backbone/预训练、增强、训练步数/预算、调参预算、checkpoint 选择、评估代码/指标定义和方向、代码 commit 或明确的工作副本来源、命令、环境、seed 与独立实验单位。按行动声明的必要字段比较；缺失为 unknown，已知不一致为 mismatch，不要求无关字段机械相等。

确认性分析还声明 `analysis_set_id`、primary outcome、`look_policy=fixed_final|sequential_adjusted|exploratory`、`multiplicity=single_primary|adjusted|uncontrolled` 和预设停止规则。反复查看结果或筛选多个模型后只回传最好结果，不能按一次固定分析处理；没有有效处理依据时降为 exploratory。初版只验证并使用可审计的外部分析，不实现新的多重检验/序贯统计引擎。

结果可含逐独立单位的测量、汇总效应和区间。首版不从任意论文表格生成置信区间。外部区间须附方法、置信水平、样本单位/数量和可复核计算来源；区间本身不因此获得独立统计认证。支持来源材料、提供者声明和实际复核状态分开。用于排除的区间及计算前提必须经过明确复核；未复核只能兼容性说明或提出检查。

比较明确标记 `vs paper-reported baseline`、`vs reproduced baseline` 或 `vs matched reproduced baseline`；只有相关协议条件经核对才用 matched。论文来源或协议无法核对时写 `paper-report comparison not established`。论文报告单点与复现结果不能混合成同一组独立样本。

干预未按方案施加、代码错误、缺指标或不同协议的结果进入诊断证据，不得作为对假设的否定票。这里的执行有效性指操作是否按设计实施，不要求机制预期的中介变量必须成功改善；操作正确但中介预测落空是可以削弱机制的证据，不能改称“实验无效”而无限保护假设。失败尝试消耗仍进入预算。旧运行后来补登记预测属于 `retrospective`；修改预期区间后仍只能回顾性解释，新的确认需要后续有效运行。运行 manifest 引用登记回执与行动版本，结合原执行器开始记录区分 `registered_before_run|retrospective|unknown`；仅有无法核对的时间戳不认定事前登记。

## Scientific Decision Policy

### 解释更新

评估顺序固定为：定位确切版本 -> 检查来源与运行完整性 -> 检查协议和干预有效性 -> 检查预先预测/回顾性边界 -> 对照预测与有效观测 -> 比较竞争解释 -> 生成范围受限的结论。每一条结果必须给出支持它的预测 ID、运行记录 ID、关键观测与无法区分的解释。

连续量采用登记的区间关系：观测区间落在预测范围内称为 compatible；与预测范围无交集可形成 inconsistent 证据；部分交叠则 inconclusive。只有能区分至少一个具体竞争解释的有效观测才能提升为 `supported_in_scope`。宽泛预测与任何结果相容时不能获得支持奖励。方向型预测必须使用登记的有意义阈值，不能事后移动零点。

`excluded_in_scope` 要求：明确且有效的干预、可比协议、预先登记的排除规则、经过复核的不确定性方法、足够精度、有效的固定或已调整分析规则，以及该规则确实是此假设在该范围内的必要预测。只排除相应条件与效应幅度，不排除所有实现、数据集或机制。定性材料或 LLM 评论不能独自触发排除；多个有效实验冲突时输出 `conflicted` 并提出区分条件的行动，不进行多数投票。探索性结果可生成修订假设和新实验，不能直接升级为确认性排除。

假设集合不是穷尽空间。所有候选解释都不能解释结果时，保留 `unmodeled_explanation` 并建议修订问题或测量。不同解释可共同成立；没有声明互斥就不强制单一赢家。重复或相关测量按独立实验单位分组，不通过重复回传、重用同一 baseline 或同一原始数据虚增证据。

定性评估由外部研究 Agent 提交 `analysis_annotations`，每条包含 evidence refs、假设、适用范围和推理依据。服务校验引用并与确定性 gate 并列展示；无法由规则确定的科学判断保持显式推断。首版不增加另一套默认模型调用器。

### 下一项行动及预算

选择单位是“假设与能够验证它的行动”，同时输出当前最值得验证的假设和具体行动。默认目标是解决对当前研究方向有影响的关键不确定性；项目可以明确切换到“已支持机制的性能验证”阶段。切换需要记录目标变化，不能在遇到负结果后悄悄改变指标或任务。

策略先过滤已知不可行或缺少必要条件的行动，再识别阻塞当前判断的来源、实现、协议、测量和成本问题。只优先修复与待决问题有关的阻塞，不让无关材料检查无限阻塞探索。随后比较有效行动对未解决假设对的判别能力、重要前提的覆盖，以及成本上界。一个行动若被另一个在相同前提和目标下以不更高成本覆盖全部判别需求，则标为 dominated。

在未被支配的行动中，先满足当前明确的科学目标及必要前提；对同一问题选择成本更低且能达到所需精度的行动。收益与成本存在实质权衡时返回主建议、替代项及选择理由，不编造小数效用或伪精确概率。没有可靠精度/成本估计时先推荐有上限的诊断或 profiling；不能把未知成本视为免费。纯指标刷分在解释仍不清楚时不自动优先。

Action 的 `distinguishes` 来自对应预测在相同观测量上的差异，并考虑测量精度。只有模型宣称“信息量大”而没有不同预测的实验，不能算成可判别行动。若预测范围重叠或精度未知，只标 `potentially_discriminating`，并指出所需分辨能力。相互依赖的行动按前提顺序提出，第一版每次只推荐下一项；不建立昂贵的全局组合优化器。

预算记录保留资源类型、GPU 型号/数量与时间、CPU 时间、费用币种、provider 调用次数和预计等待时间。硬约束逐维检查，不在没有换算依据时合并不同 GPU 或币种。外部运行汇报累计消耗，按每次尝试的最新有效记录计算 `spent`；队列/运行中的已接收行动保留 `committed` 估计。建议本身不记账或预留。剩余额度按总额减已花费与未结清承诺计算；未知尾部成本显式占用估计上界或返回余额不确定，不能释放为零。

`record_run` 完成更新以实际消耗替换同一尝试的剩余承诺；重复或乱序更新不双计，较旧源 revision 不覆盖较新记录。失败和取消的实际消耗保留。真实超支可如实记录为超支并阻止新的受限计算建议，不能拒收事实或截断成本以让预算好看。缺少金额不妨碍记录 GPU 小时，但不能据此声称货币预算仍充足。

预算 gate 只说明建议所基于版本的可行性，不是资金预留或作业准入凭证。外部执行器在接受行动时仍按自己的并发和预算权威检查，再回传接收记录；该边界避免两个同时读取建议的客户端把建议当成两份可花费额度。PaperNexus 保留并展示外部真实超支，不承诺替执行器阻止所有超支。

探索预算由项目在 init/update 中明确设置上限，可按行动数和实际资源分别限制。缺少该设置时，系统仍显示暂存机会与重访建议，但不假设存在额外可用预算。满足新证据条件的低成本探索可以使用此额度；不能突破总预算，不能为完成配额而推荐重复或无判别力实验。

### 持续探索与机会记忆

从现有 candidate-graph、selected-subgraphs、结构缺口与跨域材料读取机会，保留 source-domain/mechanism/subproblem/evidence-cluster 等已有覆盖字段。利用现有多样性选择找到遗漏领域和机制，生成有来源的 `evidence_requests`；稀疏图谱只触发补证，不声称发现全球空白。

暂存记录含原因、依赖缺口、上次评估、重访条件和预计最小下一步。首版支持 `new_admitted_evidence`、`dependency_resolved`、`competing_hypothesis_weakened`、`budget_or_resource_changed` 四类条件。人工恢复也可用，但需要原因。没有新条件时重复 refresh 不增加探索、provider 调用或候选数量。

refresh 根据当前来源版本与准入重验有依赖的记录；隔离或替换来源使依赖评估和建议标为 stale。新源解除缺口后将机会放回待评估集合，而非直接设为 supported 或自动运行。外部长期调用方可在收到结果或证据变更后调用这一流程；PaperNexus 不新增常驻定时调度器。

recommend 和 assess 也必须只读检查本次实际使用的 source/graph/quality 版本及准入，不能依赖调用方之前记得 refresh。发现变化时返回 stale_dependencies 和最小 refresh/补证步骤，不在读操作中隐式改写状态。长材料读取结束后、提交评估前重验相关来源版本；发生变化就拒绝提交过期评估。只核对本次依赖，复用现有版本元数据，不扫描或计算整个语料哈希。

## Worked Acceptance Scenario

本例是待实现工具的规范交互，所有数值均为合成验收数据。真实使用替换 corpus、来源和运行记录；不把该例用于科研结论。`payload` 必须接受下列形状，未展示的协议详情由 fixture 的明确对象提供，不依赖自由文本补齐。

第一次调用创建有上限的项目，不预留或消耗 GPU：

    {
      "operation": "init",
      "corpus": "decision-fixture",
      "project": "quality-vs-count",
      "requestId": "init-1",
      "payload": {
        "objective": "区分质量筛选与样本量变化的解释",
        "goal_phase": "mechanism_validation",
        "budget": {
          "gpu_hours": [
            {
              "resource": "fixture-gpu",
              "limit": 6
            }
          ],
          "provider_calls": {
            "limit": 0
          }
        },
        "exploration_limit": {
          "max_actions": 1,
          "gpu_hours": [
            {
              "resource": "fixture-gpu",
              "limit": 1
            }
          ]
        }
      }
    }

假设集合含 Hq 与 Hn。Hq 声明：在相同样本数量、训练步数和数据 split 下，可靠性筛选相对随机筛选的 novel accuracy 差值至少为 1 个百分点。Hn 声明：效果仅由样本数量变化造成，相同条件下差值在 [-0.5, 0.5] 个百分点。两者都是这两个明确解释的预测，不保证穷尽所有原因。各自有待测机制、范围、原文来源、prediction ID 和适用该对照的必要预测说明。

登记请求如下；fixture 必须实际提供两个 source_id 对应的合成来源和完整 matched-v1 协议：

    {
      "operation": "register_hypotheses",
      "corpus": "decision-fixture",
      "project": "quality-vs-count",
      "requestId": "hypotheses-1",
      "expectedRevision": 1,
      "payload": {
        "hypotheses": [
          {
            "hypothesis_id": "Hq",
            "version": 1,
            "statement": "质量筛选在匹配样本量条件下仍提供有意义增益",
            "mechanism": "减少被用于训练的错误伪标签",
            "scope": {
              "protocol_id": "matched-v1"
            },
            "intervention": "可靠性筛选",
            "control": "相同数量随机筛选",
            "candidate_refs": [],
            "assumptions": [
              "训练步数与数据 split 相同"
            ],
            "alternative_hypothesis_ids": [
              "Hn"
            ],
            "predictions": [
              {
                "prediction_id": "Pq",
                "quantity": "novel_accuracy_treatment_minus_control",
                "unit": "percentage_points",
                "expected": {
                  "kind": "lower_bound",
                  "value": 1
                },
                "minimum_meaningful_effect": 1
              }
            ],
            "falsification_rule": {
              "necessary_prediction_ids": [
                "Pq"
              ],
              "requires_confirmatory_analysis": true
            },
            "evidence_refs": [
              {
                "evidence_origin": "synthetic_fixture",
                "source_id": "source:quality",
                "source_version": "1",
                "locator": "claims/quality"
              }
            ]
          },
          {
            "hypothesis_id": "Hn",
            "version": 1,
            "statement": "收益仅由样本数量变化造成，匹配数量后没有有意义的差异",
            "mechanism": "训练样本数量改变优化过程",
            "scope": {
              "protocol_id": "matched-v1"
            },
            "intervention": "可靠性筛选",
            "control": "相同数量随机筛选",
            "candidate_refs": [],
            "assumptions": [
              "训练步数与数据 split 相同"
            ],
            "alternative_hypothesis_ids": [
              "Hq"
            ],
            "predictions": [
              {
                "prediction_id": "Pn",
                "quantity": "novel_accuracy_treatment_minus_control",
                "unit": "percentage_points",
                "expected": {
                  "kind": "interval",
                  "lower": -0.5,
                  "upper": 0.5
                },
                "minimum_meaningful_effect": 0.5
              }
            ],
            "falsification_rule": {
              "necessary_prediction_ids": [
                "Pn"
              ],
              "requires_confirmatory_analysis": true
            },
            "evidence_refs": [
              {
                "evidence_origin": "synthetic_fixture",
                "source_id": "source:count",
                "source_version": "1",
                "locator": "claims/count"
              }
            ]
          }
        ]
      }
    }

版本编号在正常响应中取得，示例的 expectedRevision=1 仅对应这个空项目顺序。实际客户端不得硬编码后续 revision。

可选行动 E0 是 4 fixture-GPU 小时的普通改进训练，但两种解释都预测总分可能提高；E1 是 1 fixture-GPU 小时的匹配对照，可测上述差值；E2 是 3 fixture-GPU 小时的扩规模，依赖机制已得到支持。register_actions 为 E1 绑定 Hq/Hn 的版本、全部 protocol、干预有效性检查、固定终点分析、所需精度和三条分支：差值支持 Hq、差值兼容 Hn、区间无法区分。

recommend_next 应选 E1，并指出 E0 无法区分当前两解释、E2 的前提尚未满足；没有数值概率输出。返回的行动和建议仍未执行。模拟执行器回传 queued/running 后，同一推荐只返回 await_run 或要求核对未完成记录。

模拟执行器在 completed 记录中给出 E1 的效应 0.1 个百分点、有效区间 [-0.2, 0.4]、相同协议、操作按设计执行、外部统计方法与复核引用、实际成本 1.2 fixture-GPU 小时。assess_results 可以在这些条件确实成立时排除 Hq 的“至少 1 个百分点”预测，Hn 在该对照下获得相对支持；不能声称质量筛选在所有任务都无用。若区间改为 [-1.5, 1.6]，则两个解释仍无法区分，下一步应考虑精度与复验成本。若筛选操作根本未执行，则只推荐诊断；若操作正确执行但预先预测的伪标签错误率没有下降，该中介预测落空应成为机制证据，不能当成实现无效而丢弃。仅供评估使用的隐藏标签不得流入训练或方案选择。

再次回传同一已完成尝试后，已花费仍为 1.2，剩余为 4.8；不是 2.4 或 3.6。更正记录须有新源 revision 和 supersedes_record_id，再使依赖旧结果的评估失效。一个以 Hq 削弱为重访条件的替代机制候选回到待评估集合，但不自动获得科学支持。

以上数字证明策略行为，不证明真实科研收益。另一个检索任务 fixture 使用自己的指标和协议，验证逻辑不依赖 GCD 名词。

## Plan of Work

### M0：冻结契约与可验证样例

目的：先确定四项能力如何表现为可观察行为，避免只做记录系统。新增 `test/fixtures/research-decision/` 的合成数据及独立预期决策；定义一个 GCD 伪标签机制例子和一个非 GCD 的检索例子。GCD 包含“筛选质量改善”“样本量变化”“未建模因素”三种解释，普通总分实验不能区分前两者，匹配样本量的控制实验可以。检索例子验证假设与指标未硬编码到 GCD。

编辑范围是契约、新样例和新测试入口。运行现有与新增入口相关的定向基线，记录当前失败是否早已存在；新增测试先表现为缺少能力，而非用宽松断言立即通过。为后续将修改的已有符号逐项运行 impact，并将实际结果保存在本次本地回执目录。

验收：样例明确哪些信息在行动选择前可见，哪些结果只能在回流后可见；每个预期决策有文字理由。风险是把答案放进输入或按当前实现反向写断言。产物为 fixture 说明、协议样例、预期行动与验收映射。

### M1：可从 MCP 使用的假设记录

目的：用户可以创建项目，登记两个竞争假设和预先预测，读取其差异、缺口与可验证状态。实现 decision-contracts/store/service 及新工具的 init/status/register_hypotheses/register_actions；加入发现与能力声明。其余新操作只在实现时加入 advertised enum，不先宣传尚不存在的能力。

复用原子文件替换与项目锁；所有读写明确 revision/requestId。已绑定运行的版本不可原地修改，旧项目无需迁移即可继续调用原工具。补充 draft 校验、幂等回执、并发更新、原子失败和 dry-run 无写入测试。

验收：从 MCP 创建临时项目并登记具体假设；缺预测返回 draft/具体缺口，完整输入为 testable；同请求重放不产生新版本，不同内容复用 ID 被拒绝；两个客户端只允许一个基于同一 revision 的更新成功。风险是双重权威或锁外写入；产物为 MCP 请求/响应及项目状态样例。

### M2：运行回流和竞争解释评估

目的：用户提交一份真实格式的运行记录后，取得“支持/削弱/无法区分”的逐条证据及后续检查。实现 record_run、assess_results、协议比较、来源/版本验证、依赖失效与注释边界。

使用合成原始指标模拟外部执行器，测试数据必须标 synthetic，不宣称真实实测。真实接入采用版本化 JSON manifest，包含前述协议、测量与成本；缺字段仍能记录事实，但对应科学结论应 unassessable。代码只读取由调用方明确提供的 artifact，或接收带来源的内联数据；内联数据未验证时保留 provided/unverified，不伪造 artifact_verified。

同时修正 `buildReflectionOverlay`：`success/failure/mixed/inconclusive` 的兜底分别明确，inconclusive 不生成肯定支持；推断文字保留 inferred 标记。此修复仅改变派生反思，不批量重建旧语料；新决策工具不把旧模板反思当实测依据。

验收：总分提升但竞争解释同预测时输出 compatible/undistinguished；控制实验对不同解释产生不同判断；低精度、不匹配协议、实现失败、回顾性预测和相关重复结果不触发排除；结论冲突被保留。风险是将统计兼容当因果证明，或运行重传导致证据翻倍。产物为评估矩阵、原始 artifact 引用和回归测试。

### M3：真实成本约束下的下一步建议

目的：同一批假设在不同观测与预算下，得到可解释且不同的下一项行动。实现 action-policy 和 recommend_next，覆盖补读、代码诊断、基线修复、profiling、控制实验、复验、扩规模与停止/暂存。

推荐应显示主假设、下一行动、它区分哪些解释、当前证据、备选、成本范围、预算余额、结果分支和停止条件。记录成本时接受真实超支；重放和建议读取不改变预算。外部执行器通过行动版本和计划引用接收建议，是否接受/运行由其原状态机决定。

验收：存在便宜且有区分力的控制实验时不优先推荐无区分力的大训练；成本未知时建议测量；有效负结果后转向或缩小假设；明确的重复验证需求可优先于探索；预算耗尽时仍能输出零外部开销的分析/暂存建议。风险是未知当零、费用重复计入、行动前提被忽略；产物为确定性决策轨迹和预算账目。

### M4：多来源机会记忆与条件重访

目的：扩大来源不会演变为无限检索，暂存机会也不会永久消失。实现 update_opportunities/refresh_evidence，复用候选图与材料包，产生有界补证计划、缺口说明和可审计的条件触发记录。

输入可来自已有 controller 或直接登记的候选，不强制再运行一套完整生成器。补证优先围绕具体迁移假设、最近工作、反例或成本缺口；来源分组用于覆盖与溯源，不用于假定领域距离就是创新价值。

验收：一个弱证据候选被暂存，新准入材料补齐条件后恢复为待评估；未变化的重复 refresh 不重开；竞争假设被削弱可唤回替代路线；来源隔离使受影响建议失效；总预算不被探索额度绕过。风险是把新材料当科学确认，或用去重误删实质不同假设；产物为重访记录与补证调用计划。

### M5：完整交接、可读报告和兼容性

目的：后来者能只凭工具和导出继续完整循环。实现 export、summary/full、状态回读、恢复示例与规范客户端 `SKILL/PaperNexus/scripts/pn_research_decision.py`；客户端复用 `pn_common.py`，不重新实现认证或传输。提供 `--request-file` 读取完整 JSON，不把令牌或大 payload 放进命令行，不自动重试变更调用。

更新 `SKILL/PaperNexus/references/advanced.md`、`autoresearch-adapter.md`、`SKILL/PaperNexusReflection/SKILL.md`、新增按需引用 `SKILL/PaperNexus/references/research-decision.md`。更新 MCP 契约、默认工具列表文档、controller 文档与生成文档脚本。新增 `docs/interfaces/research-decision.md` 和 `docs/operations/research-decision-loop.md`，覆盖四问示例、状态文件、运行 manifest、迁移与恢复。新文档路径需加入 VitePress 导航；规范源与本机已安装技能不同，本轮代码交付不擅自更新全局技能。

给出 AutoResearch 最小适配合同：接收 immutable action/version；回传 executor/run/attempt、协议、原始测量引用、实际成本；不由 PaperNexus 把项目阶段改为完成。首版在本仓库提供转换示例和 round-trip 测试，不擅自修改未定位的外部 AutoResearch 仓库。

验收：HTTP 与 stdio MCP 都能完成一个闭环，默认四工具与 legacy 兼容；summary 不丢 gate 且变更回读不重放；冷启动仅读状态和报告即可继续。风险是写操作伪装只读、默认工具数量更新不完整、报告丢失证据范围；产物为可执行示例、API 文档和恢复回执。

### M6：评测、审查与交付

目的：证明行为已工作，并准确报告尚未验证的现实科研效用。新增 `scripts/evaluate-research-decisions.mjs`，只使用冻结 fixture、显式 seed 和离线执行器；保存每项输入引用、建议、观测揭示次序、评估、预算变化、错误和耗时。运行定向测试通过后执行一次完整测试，再构建文档。

评测至少比较现有候选分数优先的基线与新增策略在相同可见信息和成本下的行动。基线按旧候选优先级选择其关联计划，不能故意让其获得更差材料；无法匹配时明确标不可比。报告错误排除次数、不可比结果提升次数、预算违规/重复计费、无效重复行动、条件触发重访、达到已知模拟判断所耗成本和未解决率。安全/契约反例必须零错误；模拟成本和速度只作诊断，不要求人为设定的百分比提升。

完成一次源码审查与端到端反例回放，核对每个用户能力都有可见结果。真实历史实验回放若有用户可提供的可核查记录，则另行标注数据来源、允许访问范围、协议与盲化方式；缺少该数据不阻塞工程能力验收，但报告必须写“真实科研效用尚未验证”。本阶段不要求新增真实训练来证明工程闭环。

## Agent Contract

采用一个外部研究 Agent 调用 PaperNexus 工具、再交接既有执行器的串行反馈循环；本工程不引入多 Agent 调度平台。研究 Agent 拥有假设内容、竞争解释、来源阅读和有证据的定性分析，不拥有原始结果真实性或直接跳过判定 gate 的权力。输入为目标、材料、现有状态；输出为有版本的假设/行动 payload、注释和面向用户的解释。

PaperNexus 服务拥有结构与来源校验、确定性预测比较、项目状态转换和建议，不拥有 GPU 作业或 AutoResearch 阶段。外部执行器拥有实际运行及测量，输出 versioned manifest；Reviewer/人工意见是审查证据，不替代测量或运行完成状态。模型上下文丢失后以项目状态和原运行记录恢复。

验证路由包括：缺文献时计划补读，协议不一致时计划核对，机制不明时选择判别实验，可信负结果时转向，预算耗尽时停止新计算；不能把所有情况都路由到大训练。若后续实施明确使用子 Agent，遵循项目要求固定 `gpt-5.6-luna`、reasoning effort `max`，并为各任务明确输入、文件所有权、输出和不可修改范围；本计划本身不要求启动子 Agent。

## Concrete Steps

以下命令从 Target repository 运行。命令中的新测试/评测脚本是本计划要求创建的交付物，按里程碑落地后再运行，不声称当前已经存在。

先核对工作树和索引；若 status 提示 stale 才 analyze。优先复用合适的任务工作树；创建新工作树前检查当前聊天附件。不要把用户未提交文件复制进任务分支。

    git status --short
    git branch --show-current
    git rev-parse HEAD
    npx --no-install gitnexus status
    npx --no-install gitnexus impact executeTool --repo PaperNexus --direction upstream
    npx --no-install gitnexus impact listMcpTools --repo PaperNexus --direction upstream
    npx --no-install gitnexus impact summarizeResearchEnvelope --repo PaperNexus --direction upstream
    npx --no-install gitnexus impact buildReflectionOverlay --repo PaperNexus --direction upstream

变更前基线限于受影响路径，失败时区分已有问题与本次引入：

    node --test test/research-pipeline-contract.test.js test/mcp-research-workflows.test.js test/material-quality-admission.test.js test/research-chain-api.test.js

M1—M4 的新测试分别运行，并在新增变化时重跑受影响集合：

    node --test test/research-decision-store.test.js test/research-decision-contract.test.js
    node --test test/research-decision-assessment.test.js test/research-decision-protocol.test.js test/enhancements.test.js
    node --test test/research-decision-policy.test.js test/research-decision-budget.test.js
    node --test test/research-decision-opportunities.test.js test/material-quality-admission.test.js

M5 验证实际工具往返、原接口兼容、脚本和摘要：

    node --test test/mcp-research-decision.test.js test/mcp-research-workflows.test.js test/mcp-research-workflow-boundaries.test.js test/research-pipeline-contract.test.js test/python-remote-scripts.test.js test/agent-materials-tool.test.js

更新 schema snapshot 前逐项审查新增字段/工具，保留旧必需字段与语义。已有 legacy snapshot 使用 `UPDATE_PAPERNEXUS_MCP_SCHEMA_SNAPSHOT=1`，原则上本次无需改变 legacy 定义；新工具快照由 `test/mcp-research-decision.test.js` 提供独立且同样显式的更新入口，不能用更新快照掩盖非预期变化。

M6 的评测脚本接受并验证以下参数：

    node scripts/evaluate-research-decisions.mjs --fixtures test/fixtures/research-decision --seed 17 --output .agent/reports/2026-10-24-research-decision-loop/eval-seed17
    npm test
    npm run docs:build
    git diff --check

评测输出目录已存在时读取并提示 resume，不静默覆盖；显式新目录代表新的一次评测。`npm run docs:build` 已包含 docs:generate，不重复生成。测试使用临时 corpus/PAPERNEXUS_HOME，网络与模型依赖由 mock 阻断；不得读取真实语料运行写测试。

实施完成且用户授权提交时，显式暂存任务文件，运行 GitNexus detect_changes 并复核实际范围。禁止 `git add -A`、强推或把发布文档当成已授权部署。线上验收需在单独部署授权后按既有 `docs/operations/research-release-runbook.md` 做只读诊断、应用备份、隔离演练、切换与回滚；不得擅自启动原先拒绝连接的服务。

## Validation and Acceptance

以下行为是完成标准，不能用“代码存在”替代。每个 case 的请求、源材料与预期结果在 fixture 说明中给出；失败时先定位错误判定或状态转换，再修改实现。

| Case | 可观察结果 | 检测的实际失败 |
| --- | --- | --- |
| A01 来源扩展 | 同领域、邻近领域及远领域候选均可保留，远领域缺桥接证据时产生具体补证请求 | 只保留熟悉候选或把距离当证据 |
| A02 假设质量 | “加模块提高性能”只能是 draft；含范围、机制、对照与预测的假设可登记为 testable | 形式字段齐全却没有可检验含义 |
| A03 行动判别 | 普通总分训练无法区分两个解释，匹配样本量实验可区分；后者获推荐并说明分支 | 选择最高候选分而非有效实验 |
| A04 竞争解释 | 同一观察同时兼容多个解释时明确列出，不强制 winner | 把相容误作独占支持 |
| A05 有范围的排除 | 只有预设规则、有效干预、可比协议与充分精度的反例才能 excluded_in_scope | 从不显著或单次低分推出证伪 |
| A06 无效和回顾性结果 | 运行失败/未复现基线/后补预测进入诊断或回顾性分析 | 实现错误反驳假设、事后预测冒充确认 |
| A07 协议与来源 | mismatch/unknown 不可标 matched；论文报告与复现保持来源标签 | 跨协议提升或复现短缺被隐藏 |
| A08 证据重复与更正 | 同一次运行重放不增加证据，相关单位不当独立样本，更正使下游 stale | 重复回传提高置信度或保留过期建议 |
| A09 成本与预算 | 失败计费、重复不双计、未知不当零、超支如实显示、建议不预占 | 预算虚增、隐去费用或拒收事实 |
| A10 探索重访 | 条件满足才恢复 parked；同证据重复 refresh 无新增动作 | 探索塌缩或无限重访 |
| A11 闭环反应 | 有效反例后建议改变；缺信息则补测；全部解释失败时保留未建模解释 | 固定模板建议与自我强化 |
| A12 状态恢复 | 并发更新、提交后响应丢失、导出中断均能由 status/requestId 恢复 | 双重提交、状态丢失、重跑外部作业 |
| A13 公共接口 | 四工具发现、旧接口兼容、HTTP/stdio 一致、summary 只读回查 | 能力不可发现或摘要重复写入 |
| A14 反思纠正 | inconclusive 的论文反思兜底不输出“得到支持” | 不确定性被模板文字抹去 |
| A15 泛化边界 | 非 GCD 案例仍以其自身协议、指标和假设作决策 | GCD 词表或固定指标泄漏到通用流程 |
| A16 重复查看与选择 | exploratory/未处理多重选择的结果不触发确认性排除，事前回执缺失为 unknown | 多次试验择优或中途查看伪装成单次确认 |
| A17 过期依据 | 即使未显式 refresh，recommend/assess 也检测实际依赖已被隔离、替换或更正 | 调用顺序遗漏造成旧证据继续获准 |
| A18 中介预测失败 | 操作正确而预期中介变量未改善时保留负证据；操作未执行才进入实现诊断 | 以“机制没发生”为由丢掉所有不利结果 |

工程验收要求上述行为全部通过且无未解释回归。评测报告附每项错误和来源，不仅给总平均分。对已解决的契约问题不反复重跑全套；新增变化或失败才增加验证。真实历史回放和付费模型评测不是本地工程通过的前提，也不能标为已完成。

## Idempotence and Recovery

`status`、`recommend_next` 和无 outputDir 的 export 是可重复读操作。所有项目变更用调用方稳定 requestId；同 requestId、同规范输入返回原回执，同 ID 不同内容拒绝。检查已完成回执先于 expectedRevision，以支持“提交成功但响应丢失”的重试；回执包含当时提交 revision，当前 revision 另列，不混淆。

状态内保存版本记录和回执，报告不承担恢复权威。文件写入失败时原状态仍有效；状态提交成功但报告写出失败时返回 `export_pending`，只重做 export。dry-run 不记录 requestId 或消耗版本。状态损坏明确报错，不自动重置为新项目。

断点恢复顺序为：读本文 Progress -> 查看工作树与测试回执 -> 用 status 取得项目 revision 和最后请求回执 -> 核对外部执行器未完成尝试 -> 只补缺少的输入或步骤。未知外部运行状态先协调原执行器；不得通过新 run_id 盲目重投训练。接收旧源版本只保留历史，不覆盖当前有效测量。

新状态文件不存在时返回 not_initialized；第一次明确 init 才创建。已有旧 controller 项目无需迁移，按需引用其候选。遇到未来未知状态版本时明确 unsupported_version，不尝试通用转换。无需新增迁移框架。

## Risks and Rollback

最重要的科学风险是“结论比证据更强”。用 A04—A08 直接验证，保留来源、预测版本和区间前提；不能用更复杂的分数掩盖信息不足。最重要的工程风险是项目并发写和外部结果重复，用同一锁、锁内重读、原子替换及持久回执解决。

新工具默认发现改变可能影响固定工具列表客户端。同步更新能力接口、文档和发现测试，保留旧三个工具与 legacy profile；回退代码后旧工具仍工作，新文件保持原样而不被旧代码读取。原始语料、旧 controller state 和外部运行事实不受回退影响。

本地实现回滚以明确文件清单恢复本次源码，保留研究决策记录供后续版本读取。已有项目决策状态更正通过新版本完成；不能直接恢复旧文件丢掉已经接收的真实运行。只有隔离测试数据可由测试清理。

部署不属于当前授权。未来部署先备份应用版本及此次将触及的项目状态，记录服务启动方式和新文件清单，隔离验证后切换；出错恢复应用，不覆盖上线后新增的运行记录。客户端工具缓存需要重连，不能把缓存缺项误判为服务数据丢失。暂停/取消外部作业只能走原执行器的明确授权路径。

## Surprises & Discoveries

源码确认当前“后验”是成对评审偏好的后验，bandit 成本是评分事件代理；本计划保持这些字段原义，并新增独立的实测证据与预算账目。当前反思兜底对 inconclusive 使用支持性模板，纳入 M2。

规划时 GitNexus 对 `executeTool` 返回 LOW、1 个直接调用者、1 条受影响流程、共 3 个上游符号；对 `buildReflectionOverlay` 返回 LOW、1 个直接调用者、共 2 个上游符号。对存在于源码中的 `listMcpTools` 与 `summarizeResearchEnvelope` 返回 UNKNOWN/未找到，说明索引覆盖不能替代源码检查。实施时按当时版本重跑，不复用本次风险等级作为编辑许可。

MCP 连接当前不可用，线上能力未知。工作树有与本计划无关的修改。实施过程若发现新输入格式、已有测试失败或协议边界，应在此记录证据与下一步，不能把未知写成已实现。

## Decision Log

Decision：新增 `research_decision`，保持原三个工具语义。Rationale：四项闭环能力包含持久项目变更，显式入口比在只读创意工具中隐藏写入更可理解；默认发现增加一个工具是可记录的增量变更。Date：2026-10-24。

Decision：科学决策状态由一个新项目文件所有，旧 controller 和外部执行器各保留原职责。Rationale：研究候选偏好、实验证据和执行状态含义不同；引用而非双写可避免多个完成权威。Date：2026-10-24。

Decision：先交付可解释的判别行动和真实成本策略，数值概率只在有明确统计模型时使用。Rationale：当前偏好和成本代理不足以支撑概率校准；结构化的不同预测和可比观测已经能产生实用决策。Date：2026-10-24。

Decision：运行 manifest 是首版外部交接接口，统计区间由可审计的外部分析提供。Rationale：避免重写执行器与通用统计软件，仍要求区间依据和协议复核；未知输入可记录但不提升科学结论。Date：2026-10-24。

Decision：以事件输入触发重访，不增加定时服务。Rationale：外部研究流程已有运行结果与材料变更时机；同条件去重和预算约束足以形成持续探索。Date：2026-10-24。

## Artifacts and Notes

交付计划与审查报告均放在 `.agent/plans/`。实施私有回执目录为 `.agent/reports/2026-10-24-research-decision-loop/`，存放 impact 输出、定向测试、离线评测和恢复演练记录；不保存凭据、无授权原文或真实数据到公开 fixture。公开 fixture、示例和评测脚本纳入仓库，关键验收不依赖私有目录才能重做。

项目运行状态为 `<projectOverlayPaths.root>/research-decision-state.json`；可选导出为 `research-decision-report.json` 和 `research-decision-report.md`，带 based_on_revision 和来源范围。导出目录为服务端路径，客户端不能直接假设服务器可以读取本机路径。

计划审核覆盖科学判定、单一状态权威、费用记账、探索重访、接口兼容、回读幂等和完成标准。具体审核结论见同目录 review 文档；审核通过仅表示计划可进入实施，不表示功能测试或科研效用已经通过。

## Outcomes & Retrospective

当前结果：四项能力已转为具体数据契约、判定规则、可验收切片和恢复路径。功能实现与功能测试尚未执行。

实施完成时补充实际版本、各里程碑证据、公开接口变化、测试/评测结果和已知限制。只有完成 A01—A18、相关回归和文档交接后才能把 M6 标记完成。没有真实科研回放时继续明确其有效性边界，不把模拟正确行为等同于现实科研收益。

## Revision Notes

2026-10-24：制定四项科研决策能力的完整实施契约，明确当前源码基线、分阶段交付、科学判断边界、运行事实回流、预算策略及恢复验收。

## Implementation evidence (2026-10-24)

M0—M5 已交付 10 个 operation、不可变版本、原子回执、来源失效、区间评估、累计成本、多维预算、机会重访、HTTP/stdio 与 Python 往返以及文档。原三个工具 schema 和 23 个 legacy 工具保持兼容；默认 4 个、all 27 个。

定向回归 81 项通过。全量回归 1,071 项中 1,069 通过、2 项按现有环境条件跳过、0 失败；新决策验收单独覆盖 A01—A18。文档构建和技能安装均通过。当前目录 GitNexus detect_changes 识别 43 个任务文件、48 个既有索引符号和 11 条流程，风险 HIGH 来自公共 executeTool 接入，直接调用方为 handleMessage；HTTP/stdio/CLI 调用链已核对。新文件不在基线索引内，以直接代码和测试验证。

离线评测 seed=17，16 个 GCD/检索案例全部通过；错误排除、不可比提升、重复计费、预算违规、无效重复行动均为 0，条件触发重访 16 次，未解决案例 10 个。未解决结果保留不确定性。候选优先级基线与策略读取相同计划和成本；基线没有对应模拟运行结果，不能建立实际成本节约比较。完整证据位于 `.agent/reports/2026-10-24-research-decision-loop/`；复现命令见 operating guide。

真实验证选用 05-ML-CGCD 的已验收 VOC2007 10+10、H1/EWB/POS/SWAP、seed 0 完整实验。四组已完成 100+30 epochs 和 2,030 次更新，原成本 1.6375 GPUh。新增行动为对全部 4,952 个唯一测试图像执行固定预测的配对 bootstrap，补充点估计缺少的不确定区间。保留原训练的回顾性边界，不把重新分析日期视为事前训练登记；不重复原会话正在执行的 36 组复测。
