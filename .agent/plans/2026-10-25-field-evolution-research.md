# 将文献调研接入领域演化地图 ExecPlan

Created: 2026-10-25 Asia/Shanghai
Updated: 2026-10-25 Asia/Shanghai
Target repository: `/Users/iranb/Library/Mobile Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus`
Target branch / worktree: `codex/field-evolution-research` / `/Users/iranb/.codex/worktrees/field-evolution-atlas/PaperNexus`
Related docs: `.agent/plans/2026-10-25-field-evolution-atlas.md`、`docs/operations/field-evolution.md`、`docs/interfaces/mcp-three-workflows.md`。

本文是持续维护的执行契约。仓库没有 `PLANS.md`。在每个里程碑后更新 Progress、Surprises & Discoveries、Decision Log、Artifacts and Notes、Outcomes & Retrospective。按里程碑继续；只有缺失决定、授权或无法安全执行的情况才停止。用户已要求先构建、审核和优化计划，再实施；延续前一轮新分支实施、完成后合并本地 main 的方式。

## Purpose / Big Picture

用户选择论文库并输入主题或领域，能够选择“Research and build map”，让服务依次发现相关文献、补齐可获取的论文、通过现有导入流程提取并验证关系证据，最后自动打开演化地图。过程中显示检索、全文获取、导入、证据处理和图谱同步的实际进度。刷新页面可以继续查看同一任务，不重复提交。检索失败、全文不可得、导入失败或证据不足都应明确呈现。

Map existing corpus 继续读取已有论文库。新增入口明确说明会联网、下载并导入论文，使用当前配置的提取流程，可能调用 LLM。用户点击该入口是本次有界工作的授权。软件不能承诺穷尽“整个领域”；它应提供可追溯的检索记录、覆盖缺口和当前证据图。

## Progress

- [x] 2026-10-25：核对 main 基线 `e2a9f5c`，复用本任务独立工作区，建立 `codex/field-evolution-research`。
- [x] 2026-10-25：检查发现、导入、语义处理、权威同步及演化图接口。
- [x] 2026-10-25：构建初版计划，准备独立审核。
- [x] 2026-10-25：M0：审核并落实完成条件、持久化交接、年代覆盖、补齐预算、论文映射和副作用边界六项修订；既有符号影响分析在各切片编辑前执行。
- [x] 2026-10-25：M1：实现可恢复、有界、去重的调研与导入协调服务及纯状态判断。
- [x] 2026-10-25：M2：接入 HTTP/MCP，验证真实路由、请求重放和状态边界。
- [x] 2026-10-25：M3：在地图入口加入调研模式、进度、恢复和结果展示。
- [x] 2026-10-25：M4：完成相关回归、真实浏览器验收、文档与最终审查。
- [ ] M5：提交、合并本地 main，验证提交已包含并记录证据。

## Surprises & Discoveries

- `executeLiteratureDiscoveryTool` 已支持 plan、run、submit 与 import，并有检索任务恢复。`runLiteratureDiscovery` 保存检索计划、查询结果、候选、来源和覆盖信息；这些不能当作已入图证据。
- `submitDiscoveryImports` 只对全文已就绪的候选排队。导入任务 completed 之外，还存在 semanticStatus、graphVisibilityStatus 和 authoritativeSyncStatus；后台语义与同步可能未完成。
- `executeImportWorkflowTool` 能按 taskIds 读取并补全权威同步状态；不应自行复制同步任务解析规则。
- 现有候选窗口优先按发表日期降序选择。领域演化需要兼顾早期和近期文献，不能把“最新论文列表”冒充发展脉络。
- `fieldEvolutionPayload` 使用研究来源准入及已验证方法关系。查询采用全部非停用词匹配且领域标签精确匹配；新检索论文可能没有相同领域标签。
- 原 main 工作区保留无关论文 PDF 改动及未跟踪材料；实施不得暂存或清理这些文件。
- GitNexus query 的全文检索因只读索引报错，无检索结果；context 和 impact 可用。用符号上下文与源码检查补足，不把空结果解释为无依赖。

- 浏览器恢复通过地址中的 corpus 与保存的 runId 定位；网络响应丢失后重复相同键，刷新只查询状态。
- 缺少已保存检索报告时显示 needs_attention，不能产生终态成功。
- main 已推进至 c5eb209，包含实验反馈功能；共同 MCP 路由已整合，46项联合检查通过。实验反馈夹具的 BEFORE_GRAPH.md 从源资料补齐并跟踪。

## Decision Log

- Decision：协调现有发现、来源解析、导入和同步流程，不另建文献检索器或提取模型。
  Rationale：现有模块已提供来源记录、全文解析、导入去重、证据校验和可恢复任务。新增层只组织用户操作及其范围。
  Date：2026-10-25。
- Decision：调研按钮与已有只读地图按钮并列，默认不改变旧按钮的副作用。
  Rationale：用户可以快速读取现有图，也可以明确启动有界的联网补齐工作。
  Date：2026-10-25。
- Decision：调研执行记录保存请求和发现/导入引用，完成状态由实际任务与图谱证据决定。
  Rationale：前端轮询和协调记录不能自行宣布语义处理或权威同步完成。
  Date：2026-10-25。

## Outcomes & Retrospective

已实现持久化协调服务、HTTP/MCP 和浏览器入口。相关195项测试通过；浏览器研究流程8项与只读地图10项通过。离线验证使用真实认证接口、队列和状态读取，外部检索与导入完成由夹具提供。未运行生产语料或付费模型。文档构建已通过；整合 main 后46项联合检查通过。功能提交为496f3f5，本地 main 快进与完成记录由M5收尾。

## Context and Orientation

`src/mcp/tool-literature-discovery.js` 解析配置并调用 `src/core/discovery/workflow.js`。后者规划查询、聚合多个供应源、展开引文、合并候选、解析全文，并由 `src/core/discovery/store.js` 保存 discovery.json 等记录。

`src/core/discovery/import-bridge.js` 将全文交给 `createImportTaskPayload`。`src/core/imports/worker.js` 负责 materialize、llm-optimize 和 fast-commit，并可排后台语义任务。`src/core/ingestion/pipeline.js` 在图构建中应用 method-evolution overlay；已验证关系才能进入演化地图。`src/mcp/tool-import-workflow.js` 读取任务并补全权威同步状态。

`src/server/http.js` 启动各 worker、暴露认证路由；`src/mcp/research-workflows.js` 提供四个公共研究工具及按操作验证的参数。`web/field-evolution-view.js` 管理地图界面和请求序号，`web/app.js` 负责论文库切换。

当前已有 POST `/api/field-evolution` 与 MCP `lineage_analysis/landscape`。新工作增量扩展这些能力，保持旧接口只读语义。

## Scope

实现调研请求预览、持久化有界运行、检索与全文来源记录、已入库论文跳过、缺失全文的导入提交、实际任务进度、可恢复轮询以及处理完成后的地图。新增 HTTP 入口和 `literature_review` 下的调研操作，更新操作说明、接口快照和相关测试。

## Non-Goals

不更换发现供应源、解析器或 LLM，不进行自动训练或远程部署，不绕过付费墙，不自动扩大论文数预算或无限补齐，不重写旧导入队列，不把检索命中或普通引用生成为方法演化证据。

## Non-Negotiable Rules

任何既有函数/类/方法修改前执行 GitNexus upstream impact，并报告直接调用者、受影响路径与风险；HIGH/CRITICAL 编辑前告知。提交前 detect_changes。只修改本任务路径。

只有显式调研启动操作可以联网或排入导入；状态读取和已有地图操作保持只读。公共请求只接受白名单参数，不允许透传服务器路径、凭据、模型端点或任意执行选项。凭据只从已有服务配置加载，不写入运行记录或浏览器。

maxPapers 默认 20、上限 100。每次请求有可重用的 idempotencyKey，重复同一请求返回同一运行，冲突输入明确报错。协调记录与任务关联保存在 corpus 下，重启可恢复尚未提交导入的调研；已经提交的任务继续由现有 workers 处理。

未知或失败的语义/同步状态不能当作成功。部分成功应保留可用地图并显示缺失项，不能用零结果宣称领域没有相关研究。

## Authority / Evidence Model

调研请求记录决定本次获准的主题、范围、预算与幂等身份。保存的 discovery run 决定查询结果、候选及全文来源。导入 task 和权威同步 job 决定处理是否完成。经过 research quality view 的最新图谱决定哪些论文与关系可展示。

协调层只保存请求、阶段、错误和上述记录的引用。浏览器展示从实际状态推导的进度。地图从已提交图重新构建，保留来源准入和关系验证，不能直接采用发现阶段的 metadataGraph。

## Plan of Work

### M0：审核与冻结契约

对范围、预算、完整性声明、去重、异步恢复、状态权威、提取流程和旧接口兼容进行独立审查。审查写入同目录 review 文件，修订本文后开始业务实现。先对计划涉及的旧符号运行影响分析，测试新状态模型需区分候选、来源、入队、语义和同步。

### M1：调研协调服务

新增服务模块承接 `plan/start/status` 操作。plan 返回已规范化的参数与执行说明，不产生运行记录。start 保存明确请求并启动后台执行；重复键在文件锁下检查一致性。后台执行使用既有文献发现能力，保存并复用已完成的 discovery run，选择未入库全文并调用既有导入桥。保存准确 taskIds，重启时恢复未完成交接。状态端读取对应任务的语义与同步状态并返回真实阶段。

为领域演化增加明确的候选选择方式，保留早期文献与近期文献，已有可靠标识匹配的论文不再下载导入。来源不全或身份不明时记录缺口，不用标题相似度把论文误合并。下载、候选和导入预算分别可见。

### M2：HTTP/MCP 与地图生成

增加认证 HTTP `/api/field-research` 的启动与状态入口；MCP 在 literature_review 中增加 field_research 与 field_research_status，启动支持 dryRun。正常查询仍由 lineage_analysis/landscape 提供。

当本次可用论文完成语义处理与同步后，状态响应附带新 fieldEvolutionPayload。若部分来源无法获取或任务失败，显示部分完成和相关原因。新增论文通过稳定的论文 ID/标识加入地图范围，避免因为缺少领域标签而在刚导入后被地图过滤掉。新生成图仍报告实际选中范围及相关证据缺口。

### 已审核的实现契约

新增 `src/core/research/field-research.js` 管理运行，必要的纯选择/状态函数保持在该模块或紧邻模块，不建立新的通用工作流框架。每次运行位于 corpus 的 `field-research/runs/<runId>/request.json`；runId 由明确幂等键构成，比较规范化请求内容，不另加内容摘要。利用已有 `withFileLock` 保护启动和执行。执行记录保存合法参数、最后进度、discoveryRunId、交接结果与错误；不复制图谱为新权威状态。

发现调用使用现有配置、限定查询/供应源预算及引文展开。新增可信服务端候选选择钩子，在第一次候选窗口和来源解析前生效；普通发现调用不传钩子，原行为不变。第一次窗口为引文展开保留已有锚点和跨年代候选；最终窗口跳过可靠标识匹配的准入论文，按年份范围过滤，年代轮转选择最多 maxPapers 个候选；无日期单列保留机会。按现有 selectionScore、providerAgreementCount、citationCount 和稳定身份排序桶内论文，不另造影响力评分。保存候选 ID、选择理由、跳过已有/年份/预算的数量及原始查询记录。

调研启动参数白名单为 query、targetDomain、fromYear、toYear、maxDepth、maxNodes、maxEdges、maxPapers、providers、idempotencyKey、dryRun。查询与领域至少一个非空。providers 限已支持名称，不接受端点或凭据。默认候选窗口最多 `maxPapers * 3`（最大300），最终全文候选/下载/导入均最多 maxPapers；查询预算固定有界并在预览和结果显示。年份限制本次补齐和地图范围，无日期保留。检索查询使用主题与可选领域上下文；它是召回条件，不是领域完整性证明。

服务重启时恢复没有终止错误且尚未保存导入交接的运行。恢复调用相同执行函数；若对应 discovery run 已存在则复用，若交接已存在则不重做。浏览器关闭不取消已有导入任务。执行过程中写入的进度只用于呈现，任务成功由原始队列和同步记录判断。已失败运行不自动新建、重试或增大预算。

`status` 使用 `executeImportWorkflowTool/status` 的 taskIds 批量读取，只处理本次任务。task completed、graphVisibilityStatus completed、semanticStatus completed、authoritativeSyncStatus completed 或明确 not-required 才算可用；仅结构提取且 semantic not-required 不充当关系提取成功。活动状态返回相应阶段，未知/缺失/失败状态返回明确问题。全部本次任务终止后，有成功部分或原库证据可生成 partial 地图；没有新全文也返回有缺口的结果，不伪称已经补齐。

最终地图用 fresh research quality view。当前查询的核心节点与本次可唯一定位的论文 ID 合并后作为显式种子，最多500；图内方法/论文数量仍分别受 maxNodes 限制。无任何种子时沿用原查询产生 no_matches，不能退化成全库概览。返回选择依据、映射缺失和种子预算遗漏；不将发现候选 metadataGraph 注入演化图。

HTTP：POST `/api/field-research?name=...` 启动或 dryRun，GET `/api/field-research?name=...&runId=...` 只读状态，缺 runId 时可读当前库最近运行。MCP：`literature_review/field_research` 与 `field_research_status` 共用服务。完成状态包含 `analysis`，其结构与现有 fieldEvolutionPayload 相同。运行状态附查询范围、发现覆盖、候选来源、精确任务状态和缺口，前端自动用该 analysis 渲染地图。

### M3：浏览器体验

表单增加 Research and build map、论文数预算和简短副作用说明。启动后显示阶段、检索/全文/入队/完成/失败数量以及运行标识；保留已有图入口。页面刷新或切换回来可恢复当前论文库的运行。关闭视图停止前端轮询，不取消后台任务；再次打开可继续跟踪。失败后可查看原因、重读状态或明确创建新的运行，不能因轮询错误重复下载导入。只允许当前论文库与当前请求更新界面。

完成时自动显示论文演化图，并保留调研覆盖信息和来源缺口入口。当前图 SVG 与 JSON 导出应保留与调研运行的关联。键盘和窄屏可操作。

### M4：验证与文档

纯函数测试覆盖阶段判断、预算、已有论文跳过、部分失败、未知状态以及论文 ID 映射。服务测试覆盖持久化、同键重放、冲突键、恢复、任务绑定和无越权透传。HTTP/MCP 测试覆盖真实路由一致性、认证及旧接口仍只读。用真实浏览器与隔离语料、可控外部供应源响应完成从调研启动到地图的流程，检查重复点击、刷新恢复、论文库切换、失败展示和导出。

运行发现/导入/MCP/演化图相关回归，修复范围内问题，更新 schema、生成文档和用户操作说明。记录哪些检查使用模拟供应源，哪些执行了实际导入或提取步骤。

### M5：本地交付

检查暂存范围，运行 detect_changes，提交本分支。检查 main 是否前进和未提交路径；必要时在独立分支整合并验证受影响部分。合并到本地 main 后用祖先检查确认功能提交已包含。保留原工作区无关修改；不推送或部署远端。

## Concrete Steps

所有命令在 `/Users/iranb/.codex/worktrees/field-evolution-atlas/PaperNexus` 执行：

    node --test test/field-research.test.js test/field-research-api.test.js
    node --test test/field-evolution.test.js test/field-evolution-api.test.js test/field-evolution-view.test.js
    node --test test/literature-discovery.test.js test/tool-import-workflow.test.js test/mcp-research-workflows.test.js test/mcp-schema-snapshot.test.js test/mcp-research-workflow-boundaries.test.js
    node scripts/verify-field-research-browser.mjs /tmp/papernexus-field-research-acceptance
    npm run docs:build
    git diff --check

新文件随实现添加。测试必须能区分“发现完成但语义/同步未完成”和“地图可读”。生产供应源、付费模型与正式论文库不用于验收。测试输出、截图、导出和准确命令写入验收记录。

## Validation and Acceptance

在空或不完整的隔离论文库中发起一次有界调研，能够看到查询记录、全文结果、导入任务及其状态，随后自动得到包含新增已提交论文的演化图。每条演化关系仍可查看原文证据。重复点击同一请求不重复运行；页面刷新/服务恢复不丢失任务；无法下载、导入失败、语义待处理和同步待处理均有准确状态。原有只读地图不发出调研请求。

计划和审核记录、实现、相关测试、真实浏览器材料、操作文档、功能提交及 main 合并证据齐全，才完成本任务。

## Idempotence and Recovery

运行目录保存规范化请求、discoveryRunId、已提交 importResults/taskIds 及最后阶段。启动锁保护同键重放；执行锁保护恢复与运行并发。已保存 discovery run 复用，已入队来源由现有导入去重处理，已保存任务交接不重做。状态读取不启动工作。

浏览器保存每个论文库的运行 ID，刷新只读取状态。未知网络结果重试启动时沿用同一 idempotencyKey。终止的失败不会自动新建运行或扩大预算。正式语料导入一旦提交遵循现有队列处理，不通过删除任务实现界面关闭。

## Risks and Rollback

公开启动入口增加联网与导入副作用；明确按钮语义、固定参数白名单和预算，保留只读旧入口。异步重启可能重复提交；使用稳定请求键、保存的发现结果、执行锁及已有队列去重。摘要或检索命中可能被误当证据；地图只能读准入图与已验证关系。模型不可用或全文不足可能形成无边图；保留缺口，不宣称已还原领域全貌。

新增协调记录不迁移已有图存储。提交后可以 revert 本次功能提交；已有队列和论文保留，不为撤销 UI 删除研究材料。实现期间只恢复本任务文件。

## Artifacts and Notes

计划：`.agent/plans/2026-10-25-field-evolution-research.md`。
审查：`.agent/plans/2026-10-25-field-evolution-research-review.md`。
验收：`docs/development/2026-10-25-field-research-acceptance.md`。
操作文档：`docs/operations/field-evolution.md`。
运行时检索记录保留原始查询与候选来源，协调记录引用它们；截图和临时语料留在仓库外。

## Interfaces and Dependencies

新增协调服务提供 plan/start/status 和恢复入口，复用 executeLiteratureDiscoveryTool、submitDiscoveryImports、executeImportWorkflowTool 和 fieldEvolutionPayload。HTTP 与 MCP 调用同一个服务；前端消费相同的阶段、计数、覆盖信息和地图 payload。只使用已有 Node、SVG、Playwright 和文件存储，不新增生产依赖。

## Revision Notes

2026-10-25：根据既有实现建立初版，待在业务实施前审核并确定候选选择、完成条件和恢复的细节。

2026-10-25：实施前审核完成，加入六项确定性契约；审核结论与20分评估见同目录 review 文件。
