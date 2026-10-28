# 内置谱系补查、证据审查与发布 ExecPlan

Created: 2026-10-28（Asia/Shanghai）
Updated: 2026-10-28（Asia/Shanghai）
Target repository: `/Users/iranb/.codex/worktrees/field-evolution-atlas/PaperNexus`
Target branch / worktree: `codex/lineage-refinement`，起点 `42d7164`
Related docs: `docs/operations/field-evolution.md`、`docs/operations/extraction-quality.md`、`.agent/plans/2026-10-27-extraction-quality.md`

本 ExecPlan 是持续更新的执行文档。新执行者应仅依靠仓库和本文继续工作。执行中更新 Progress、Surprises & Discoveries、Decision Log、Artifacts and Notes、Outcomes & Retrospective。仓库未发现额外 PLANS.md。逐阶段实施，无需请求通用的“继续”确认；遇到缺失授权、必要决策或实际阻塞时再说明。

## Purpose / Big Picture

用户在 PaperNexus 中选择研究或论文后，可以让已配置模型提取方法承接、分别解释瓶颈与改动、审查证据，按明确预算补查来源，最终通过原生接口将支持的关系发布到方法脉络图。换领域只需改变研究范围和语料，不编写领域专用脚本。

完成后通过三个新增 `literature_review` 操作使用：`lineage_refine` 启动可恢复的模型任务，`lineage_refine_status` 读取状态和逐条裁决，`lineage_publish` 预览或发布已审查关系。HTTP 提供同一服务的入口；研究页面提供启动、状态、预览和发布入口。已有 `lineage_extract/status/card` 保持可调用，证据卡升级为 v2。

验收必须展示：两组不同主题的输入通过同一流程；有证据的关系显示到原生图；比较、负向消融、引句不匹配、身份歧义或过期来源不能被发布；没有瓶颈证据时保持未知；重复请求不会重复模型调用或产生重复边；图重建后发布的有效关系仍可读取。

## Progress

- [x] 2026-10-28：核对线上能力、内置模块、来源审查产物、仓库状态及现有测试；创建实现分支。
- [x] 2026-10-28：起草具体接口、状态权威、恢复边界及验收案例。
- [x] 2026-10-28 M0：完成执行前审查，明确部分成功、撤回、发布冲突及来源投影边界；审查记录见 review 文件。
- [x] 2026-10-28 M1：证据卡 v2 保留独立解释与归属/认识状态；缺失、重复和不匹配有字段诊断；提取及解释测试 12/12 通过。
- [x] M2：内置模型审查、身份解析、逐条裁决及来源版本缓存。
- [x] M3：缺口驱动的有界补查、导入衔接、任务恢复及只读状态。
- [x] M4：统一发布与持久化；来源变化后停用旧证据；接入原生图。
- [x] M5：MCP/HTTP/Web、文档与端到端回归，GitNexus 范围审查和提交。

## Surprises & Discoveries

- 21 条瓶颈重复来自一次性整理脚本将 mechanism 同时赋给 bottleneck。产品内置 `buildLineageCardPrompt` 当前没有独立瓶颈字段，故仅修复该脚本无法支持新领域。
- `lineage_extract` 已按来源/模型/契约缓存整篇抽取，保留引句匹配与待审状态，但 `graphWriteback=false`。这些能力应直接复用。
- `field_research` 是有界发现及通用语义导入，不是按孤立节点驱动的谱系修复。`landscape` 只读已入图关系。
- 普通 `applyCorpusMutations` 修改当前图，不提供经审查谱系在语义快照重建后的独立持久化。发布凭据必须同时成为可重放的领域数据；不能仅修改临时图。
- GitNexus 概念检索出现只读 FTS 初始化错误。索引已更新到起点提交；绝对仓库路径的精确 symbol context/impact 可用。用符号分析及受限源码阅读完成检查，不因检索失败跳过修改前 impact。

## Decision Log

- Decision: 增强现有证据卡，并新增一个领域无关的补查任务服务；不改造成通用多代理框架。
  Rationale: 当前来源读取、模型调用、缓存、检索、导入和图变更模块已经存在。
  Date/Author: 2026-10-28，项目维护。
- Decision: 提取与审查分为独立模型调用，沿用当前配置模型；不要求第二供应商。
  Rationale: 独立提示能检查候选解释，但不能把同模型复核当成独立科学验证。
  Date/Author: 2026-10-28，项目维护。
- Decision: 关系成立与解释完整分开。未知瓶颈不伪造，组件采用允许记录采用理由。
  Rationale: 继承关系可以有充分证据，但其动机或代价未被论文明确论证。
  Date/Author: 2026-10-28，项目维护。
- Decision: 外部扩展以显式预算控制，默认只处理现有来源；状态读取不触发搜索、导入、模型或发布。
  Rationale: 调用者能预览费用相关动作，恢复时只调度已授权的未完成阶段。
  Date/Author: 2026-10-28，项目维护。
- Decision: 本轮执行本地实现和注入模型/检索响应的端到端验证；不部署到 41、不重抽生产论文、不运行实验。
  Rationale: 用户授权了计划审核与实现，尚未要求生产部署或新增付费调用。测试证明软件行为，不声称测量真实模型准确率。
  Date/Author: 2026-10-28，项目维护。

## Outcomes & Retrospective

已实现 v2 证据卡、独立模型审查、有界补查、持久化发布及撤回，并接入 MCP、HTTP 和原生研究页面。有效发布在完整图和 lite 图重建后可恢复；来源内容、身份或活动状态变化会停用旧关系。保存研究按当前发布补入方法及直接前驱上下文，不修改研究成员、revision 或覆盖审查状态。

验证使用两类领域的临时语料、固定模型/检索响应、真实 HTTP/MCP 路由及 Chrome 浏览器。浏览器五项验收通过，包括丢失响应后同 key 重试、预览无写入、发布后原生图可见、刷新无新模型调用和撤回。测试结果与影响分析位于 Artifacts and Notes 指定目录。真实模型准确率、生产部署和线上跑批未在本轮验证。

## Context and Orientation

### Current State Snapshot

受控文件干净，起点 `42d7164` 包含上一轮抽取归属、认识状态、证据及完成语义修复。本地已有大量未跟踪研究报告、一个旧计划及 `node_modules` 链接；不得纳入此次提交。

`src/core/research/lineage-evidence.js` 负责完整来源读取、v1 证据卡模型提示、确定性校验、缓存与提取任务恢复。`src/mcp/research-workflows.js` 定义公共字段、操作路由、能力和后续动作，`research-summary.js` 负责摘要，不能创造完成状态。

`src/core/research/field-research.js` 有检索/导入运行示例和恢复 worker；`src/core/discovery/import-bridge.js` 接入现有导入队列。Markdown 可用 `fast-md-structural`，其他已有支持的来源通过现有 `full` 路径处理；不新增 PDF 解析器。只对新选中来源导入，既有论文不重复运行通用抽取。

`src/storage/corpus-store.js` 提供图、lite 视图及来源 manifest。`src/core/graph/mutations.js` 提供标准图操作。`src/core/graph/research-intelligence.js` 将关系属性转换成证据详情，`field-evolution.js` 生成原生谱系。底层关系方向为采用者/后继到前驱，`COMPONENT_OF` 例外；图展示使用前驱到后继。

`src/server/http.js` 注册认证后的 API。`web/field-evolution-view.js`、`field-studies-view.js` 和 `field-research-view.js` 为既有浏览器入口。相关测试包括 `lineage-evidence.test.js`、`field-research*.test.js`、`field-evolution*.test.js`、`mcp-research-*.test.js` 和 `staged-pipeline*.test.js`。

### Terms and System Map

候选是模型从原文提出的待审关系。审查是第二次模型解释与确定性来源检查的合并结果。发布是用户明确调用后将支持的关系写入原生图及发布记录。缺口包括未审方法、待解析前驱、来源不可用、解释缺证、无可支持的直接关系；缺口不等于创新机会。

## Scope

实现证据卡增强、按论文审查、按缺口生成查询及有界执行、发布持久化、状态与预览、原生界面及文档。保留原始候选、逐条审查理由、来源版本、使用量和失败。两组领域不同的离线案例验证没有 GCD/持续学习专用分支。

## Non-Goals

不迁移全部历史卡、不修改现有 216 篇生产记录、不保证全领域穷尽或提高到某个连边率、不做性能/新颖性认证、不增加通用代理平台、自动实验或独立调度系统。旧卡可读，但不能冒充 v2 已审查发布输入。

## Non-Negotiable Rules

修改已有函数前运行 GitNexus upstream impact，向用户报告调用方、流程和风险；HIGH/CRITICAL 先告知。提交前 detect_changes。新增接口是增量扩展；证据卡版本升级使新抽取避开旧缓存，旧任务/卡仍可读取。

任何发布必须有有效引句、明确方法/论文身份及支持决定。拒绝、歧义、来源过期或不匹配保持可见。模型不能通过任意字段直接提供图操作或文件路径。复制的瓶颈/机制视为解释缺口；不把合法关系仅因缺少动机说明全部拒绝。

不以置信分数阈值代替语义裁决。不新增无意义校验摘要；复用现有来源版本和模型缓存标识以避免重复付费。没有在本轮实际调用真实模型时，不报告真实模型质量。

## Authority / Evidence Model

每个补查任务的 `lineage-refinement/runs/<runId>/run.json` 是阶段权威，保存冻结选择、预算累计、子任务 ID、逐篇审查引用和可恢复进度。提取缓存仍由 `lineage-evidence/cards` 管理。审查记录绑定候选卡、来源版本、已解析前驱来源及模型契约；原始候选不被覆盖。

导入与同步完成由现有导入任务决定。查询返回、下载完成、卡生成或审查完成均不替代导入同步。发布记录保存经审查操作、来源绑定和回滚前值，是发布的持久化权威；原生图是其与普通语料图共同生成的读取结果。任务摘要、Web 进度和计划不独立标记完成。

来源过期时，该发布的关系不再作为当前有效谱系投影；记录仍保留并返回重审原因。当前图已含的旧发布边应停用，不能只停止重放却留下旧边。有效发布在图重新构建或 fast-delta 更新后仍通过统一图加载入口可见。

## Plan of Work

### M0：计划审查

核对真实调用链及可用接口，审查范围、状态权威、来源变化、断点恢复、发布方向及跨领域验收。按技能的 20 分标准审查，至少 16 分且风险控制满分，关键维度不得为零。将最终裁决和必要修订记录到同目录 review 文件后执行。

### M1：可解释的 v2 卡

升级现有卡提示与校验。候选保留独立 `bottleneck`（瓶颈、采用理由或未知）、`mechanismEvidence`、`tradeoff` 证据对象，每项含 text、exactQuote、section/page 和认识状态。保留现有 mechanism 文本便于消费；缺失证据不补用对象名称。校验引句是否出现在所选原文，记录字段级问题，区分未解释与关系本身不成立。

证明：重复文本被识别；作者假设不会变成确定结论；null 瓶颈和无关系的正常论文可完成抽取；旧卡可读，新契约不会命中 v1 缓存。

### M2：模型审查最小闭环

新增内置审查模块，复用完整来源读取和 `generateResearchJson`。按引用标识、精确标题及论文内方法身份解析前驱；有冲突时保持歧义。审查输入含完整子论文、候选及可用前驱证据，不只传标题或模型摘要。输出逐方法/关系的 supported、rejected、uncertain、理由、关系上下文和经证据支持的解释。

程序复查引句、归属、方向和来源版本；模型裁决与程序阻断分别保留。同论文变体不要求外部论文。review 缓存绑定当前输入，前驱补入或来源变更只使受影响项重审。未发布时原图不变。

证明：扩展与组件采用可通过；比较、负向消融、被否定假设、错误父方法、未匹配引句均不能成为可发布关系；跨两个领域运行同一代码。

### M3：缺口驱动任务

新增 `lineage_refine` 服务，选择已有 study 或明确 papers；优先处理缺少关系/解释的方法。保存未选中数量，预算截断不表示全部覆盖。任务先抽取/复用卡并审查，再把实际缺口交给模型生成有依据的查询。明确 `maxQueries` 和 `maxNewPapers` 后，调用现有发现与导入桥接；保存 discovery/import ID，等待现有同步状态后再处理新增来源并重新审查受影响关系。

预算按任务累计，不能每轮重置。最多 3 轮，默认仅一轮现有来源处理。已拒绝的关系没有新证据时不重复提出。查询失败、全文缺失、导入失败、预算耗尽分别返回原因；有界工作完成与覆盖完善分开报告。状态读取纯只读；提交同 key 对齐旧任务，`retryFailed=true` 仅显式恢复失败项，成功模型响应保留。

证明：状态读取零新调用、同 key 零重复、补入前驱后只重审受影响卡、预算不会超出、进程中断可恢复、同步未确认不能进入审查。

### M4：发布与重建

`lineage_publish` 默认预览，显式 `apply=true` 发布。输入只能指定已保存、已终止补查 runId 与 requestId，不接受任意图变更。部分成功任务只发布成功审查的子集，并返回其余失败/未知计数。仅发布支持且当前的身份/关系，保存来源和模型审查标记，绝不标为人工科学核验。复用现有 corpus lock 与 graph mutation 接口，读回实际端点和证据。

加入小型谱系发布存储及统一读取投影，避免完整图重建丢失审查成果。只作用于本功能拥有的节点/关系，保留其他图内容；相同来源及关系重复发布不重复连边。相同端点/关系类型已有一条来源匹配的边时更新该边，保存原值；多条冲突身份或不匹配来源不自动覆盖。后续人工改动不符合本发布拥有标记时报告冲突，不能在读取时强行覆盖。字段级原文、归属与认识状态必须出现在 method evidence/landscape 返回中。来源变更、停用或删除时停止旧发布关系的有效投影，并保留待重审原因。保存回滚前值，提供针对本次发布的撤回方式，不能覆盖发布后无关修改。

证明：预览无写入；重复发布无重复；两种方向正确；图重建、lite 读取和源变更案例通过；审核结果被图和 Web 消费；撤回仅移除/恢复本次发布拥有的内容。

### M5：公共接口、页面和验收

更新 MCP operation/schema/capabilities/摘要及后续动作，增加 HTTP 原生路由。页面在已有研究/语料上下文提供处理预算、任务进度、缺口与审查结果、发布预览和发布；按钮只调用公共服务。刷新可恢复已知 runId，页面读取不会重复提交。

增加注入模型和检索响应的端到端测试与浏览器检查，文档说明模型候选、模型审查、发布和科学验收的区别。运行受影响测试及 docs build，通过后检查 diff、GitNexus 范围并提交。只有新变化或明确失败才扩展测试。

## Concrete Steps

工作目录为 Target repository。已有资料读取完成后，依次编辑 M1–M5；每次修改既有函数前执行：

    gitnexus impact <symbol-or-UID> --direction upstream --repo /Users/iranb/.codex/worktrees/field-evolution-atlas/PaperNexus

验证入口（新测试按实际文件保持同步）：

    node --test test/lineage-evidence.test.js test/lineage-refinement.test.js test/lineage-publication.test.js
    node --test test/mcp-research-workflows.test.js test/research-workflow-quality.test.js test/research-workflow-views.test.js test/field-evolution.test.js test/field-evolution-api.test.js test/lineage-refinement-api.test.js
    node --test test/field-research.test.js test/field-research-api.test.js test/staged-pipeline.test.js
    npm run docs:build
    git diff --check

测试不使用生产 corpus、真实模型密钥或外部训练。用临时语料、显式注入响应和本地 HTTP 服务证明公共路径。浏览器检查使用仓库已有 Playwright/Chrome 方式，不向生产界面提交任务。

## Validation and Acceptance

完成需要同时满足：原生接口可发现且与文档一致；领域无关案例通过；解释分别有证据或明确未知；不支持项不发布；来源新旧明确；任务和发布可重放；缺口扩展遵守累计预算；原生图读取发布结果且重建保留；用户可通过页面完成预览到发布；指定回归与文档构建通过；Outcomes 填写实际结果。

测试案例的语义裁决使用固定模型响应验证软件消费，不据此宣称模型在真实论文上的准确率。保留真实原文片段的静态案例仅用于回归证据归属和否定处理。

## Idempotence and Recovery

每个任务固定 normalized request 与 idempotencyKey。进度先保存再启动昂贵子操作；模糊提交结果按已有 discovery/import ID 查询，不换 key 重新提交。模型响应和使用量写到所属 run 目录，成功卡和审查缓存可复用。恢复 worker 只恢复未终止任务，不自动重试欠费、认证、限流或失败任务。

发布 requestId 绑定相同 run 与选择；预览不产生发布记录。apply 在 corpus lock 内保存发布意图与操作，再提交图并读回，重试从保存状态对齐。撤回使用发布的前值与拥有标记，不回滚整个语料。状态不代表来源永远有效，发布前和读取投影检查来源版本与活动状态。

## Risks and Rollback

错误语义通过由双阶段解释、原文匹配、身份解析及明确拒绝/未知降低风险；模型一致不等于科学真值。读取投影改变统一加载路径，必须用空发布库回归证明普通语料不变，并测试有效、过期、撤回三种状态。新增来源只走既有导入及同步，禁止另建队列。

撤销代码使用本次提交的 revert；不得清理已有未跟踪研究资料。线上部署与真实模型跑批不属于本轮执行。产品运行时调用者通过显式启动/预算/apply 表达授权，dryRun 展示副作用；不加入每条关系都需要人工确认的通用阻断。

## Artifacts and Notes

计划审查：`.agent/plans/2026-10-28-lineage-refinement-review.md`。
实现/验证资料：`.agent/reports/2026-10-28-lineage-refinement/`，保存 impact、测试、浏览器结果及交付记录。只提交代码、必要固定样例、文档和计划；研究原始数据与本地依赖链接不提交。

M1：`m1-tests.log` 为 12/12；`impact/` 保存修改前影响分析。loadCorpus 为 CRITICAL（10 个直接调用方、8 组流程），loadCorpusLite 为 CRITICAL（11 个直接调用方、12 组流程），buildMethodEvidenceRecord 为 HIGH（2 个直接调用方、2 组流程）；其余当前目标为 LOW。风险已在修改前向用户说明。

## Interfaces and Dependencies

`lineage_refine`：`corpus`，`studyId` 或 `papers` 二选一，`idempotencyKey`，`maxPapers`（1–100，默认 20）、`maxQueries`（0–8，默认 0）、`maxNewPapers`（0–20，默认 0）、`maxRounds`（1–3，默认 1）、`dryRun`、`retryFailed`。前两项预算为 0 时不检索/导入；外部补充要求两者均为正。返回 runId、阶段、计数、预算、缺口、使用量及权威子任务引用。

`lineage_refine_status`：`corpus, runId`；不执行新工作。

`lineage_publish`：`corpus, runId, requestId, apply, revoke`；apply/revoke 默认 false。撤回指定原发布的 runId/requestId，并使用 `revoke=true`；apply=false 预览撤回，apply=true 执行撤回。原 requestId 撤回后不能被普通重试重新发布，新的明确发布使用新 requestId。请求只能消费保存的审查结果，不接受关系文本或图操作。

HTTP：`POST /api/lineage-refinement?name=...`、`GET /api/lineage-refinement?name=...&runId=...`、`POST /api/lineage-publication?name=...`。沿用现有认证与配置模型。

模型阶段均用 `generateResearchJson`，原始响应和 usage 写入任务目录。提取模型拥有候选建议；审查模型拥有语义判断建议；服务拥有身份检查、预算、任务状态和发布许可。模型不运行 shell、不写图、不控制导入完成或用户授权。

## Revision Notes

- 2026-10-28：建立可跨领域复用的内置流程计划，覆盖已有证据卡、模型审查、补查、原生发布与重建保留。
- 2026-10-28：审核后明确终止任务子集发布、来源匹配更新、人工修改冲突保护和撤回参数，消除实现中的关键歧义。

执行记录：已完成失效来源、身份歧义、同论文变体、现有方法复用、部分成功发布、恢复响应复用及人工编辑冲突回归。补查单次查询使用一个配置供应商；累计预算包含已选择但导入失败的论文。

验收完成：88/88 定向回归通过；Chrome 浏览器 5 项验收通过、无页面脚本错误；docs:build 通过；git diff --check 通过。GitNexus staged detect_changes 覆盖 33 个文件、422 个符号与 24 组流程，整体 CRITICAL，集中于本计划的发布投影及统一图读取调用链。代码、测试、文档与本计划提交到 codex/lineage-refinement；原始研究报告及本地依赖不纳入提交。
