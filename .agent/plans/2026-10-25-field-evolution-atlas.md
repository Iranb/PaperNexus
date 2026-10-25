# 构建领域方法与论文演化图 ExecPlan

Created: 2026-10-25 Asia/Shanghai
Updated: 2026-10-25 Asia/Shanghai
Target repository: `/Users/iranb/Library/Mobile Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus`
Target branch / worktree: `codex/field-evolution-atlas` / `/Users/iranb/.codex/worktrees/field-evolution-atlas/PaperNexus`
Related docs: `docs/interfaces/mcp-three-workflows.md`、`docs/interfaces/mcp-skill-contracts.md`。

本文是持续维护的执行契约。后续实施者仅需仓库与本文即可继续。仓库没有 `PLANS.md`。每个里程碑后更新 Progress、Surprises & Discoveries、Decision Log、Artifacts and Notes、Outcomes & Retrospective。用户已授权规划、审核、优化、在新分支实施及完成后合并到本地 `main`；依此继续，无需重复确认。远端部署、付费提取和文献导入不在本任务内。

## Purpose / Big Picture

研究者选择论文库，输入领域或主题以及可选年份范围后，能够在浏览器看到论文和方法随时间发展的关系图。图中区分相连的方法家族、主线、分支、合流和论文报告的替换关系。点击节点可读论文信息；点击关系或转折可读原文引句、关系类型、瓶颈、机制和代价。用户能够从全景进入一条分支，并在论文视图和方法视图间切换。MCP 返回相同分析数据，便于调用者继续阅读来源。

“方法家族”指当前证据图中互相连通的方法集合，不自动等同于公认学派。“主线”是解释清楚的结构性路径，不代表影响力排名。“关键转折”是值得检查的候选节点或关系，必须展示判定依据与来源。只读图谱不能证明某论文首次提出方法、方法已经解决问题或性能已经提升。

## Progress

- [x] 2026-10-25：确认 `main` 基线 `ea70833973108a485581cd44030faa14abd0b162`，建立独立工作区与新分支。
- [x] 2026-10-25：核对主题分析、方法证据、HTTP/MCP 和浏览器路径；相关基线 28 项测试通过。
- [x] 2026-10-25：构建初版 ExecPlan。
- [x] 2026-10-25：完成计划合理性审核并落实范围扫描、论文归属、主线算法、预算与浏览器验收五项修订。
- [x] 2026-10-25：M0：审核计划合理性，记录并解决阻碍实施的问题，完成既有符号影响分析。
- [x] 2026-10-25：M1：实现只读领域演化分析以及可判别的合成样例。
- [x] 2026-10-25：M2：接入 HTTP/MCP，完成接口与来源准入验收。
- [x] 2026-10-25：M3：完成可交互时间轴、论文/方法切换、分支筛选、主线、转折与证据详情。
- [x] 2026-10-25：M4：完成浏览器行为验收、相关回归、文档与最终代码审查。
- [x] 2026-10-25：M5：功能提交 `885af7ca8636a370253aa7cfe14ec9dc619a2179` 已 fast-forward 合并到本地 `main`，祖先检查通过；原工作区无关改动保留。

## Surprises & Discoveries

- 主题概览 `buildTopicAnalysis` 使用局部子图，且 `profiles.slice(0, 8)` 最多选择八个方法展开。新全景应有独立的数据入口，避免把这个预览当成领域全貌。
- `loadCorpusLiteForApi` 已通过 `buildResearchQualityView` 排除不合格论文及其图关系。新入口必须复用该加载路径。
- 方法关系有论文引用方向和 DAG 投影两种表达；`COMPONENT_OF` 是组件到组合方法，其余常见演化关系是新方法到前驱。绘图方向必须统一为前驱到后继，并保留原关系 ID。
- 当前原工作区有论文 PDF 和无关未跟踪文档/脚本，已隔离实施；不清理、不暂存这些文件。

- GitNexus 对共享 `buildMethodEvidenceRecord` 报告 HIGH：五个上游符号，涉及两个 MCP 执行流；本次只将该函数导出，原有函数体和验证规则不变。接口及既有方法证据回归通过。
- 图谱索引不完整覆盖浏览器闭包和文档配置；最终审查同时核对直接源码调用点。

## Decision Log

- Decision：新增独立的领域演化读入口，复用原有证据解析和来源准入。
  Rationale：现有主题预览有八方法限制；全景与主题迁移建议的选择逻辑不同。
  Date：2026-10-25。
- Decision：采用原生 SVG 与现有 JavaScript/CSS，不引入新的前端框架和生产依赖。
  Rationale：项目已有无构建步骤的浏览器界面，SVG 支持可点击关系、键盘操作和导出。
  Date：2026-10-25。
- Decision：只合并本地 `main`，不自动部署或推送。
  Rationale：这是本轮已授权交付边界；线上语料质量与部署须另行验收。
  Date：2026-10-25。

## Outcomes & Retrospective

已完成领域演化模型、HTTP/MCP 接口、SVG 时间轴及证据详情。相关回归测试 94/94 通过；最终界面修改后，视图测试 4/4 与真实浏览器验收 10/10 通过。文档站构建成功。具体行为与证据见 `docs/development/2026-10-25-field-evolution-acceptance.md`。提交前 GitNexus detect_changes 检查了 30 个文件、319 个符号（含文档标题），报告 8 条预期研究查询执行流，总体风险 HIGH；暂存差异未发现任务外改动。功能提交 `885af7ca8636a370253aa7cfe14ec9dc619a2179` 已于 2026-10-25 合并到本地 `main`；`git merge-base --is-ancestor 885af7ca8636a370253aa7cfe14ec9dc619a2179 main` 成功。合并无冲突，没有引入额外代码修改。合成样例证明软件行为，不证明某个真实领域的覆盖率或历史结论。

## Context and Orientation

工程使用 Node ESM。`src/core/graph/graph.js` 提供内存图，`src/core/graph/topic-analysis.js` 提供有界主题子图；`src/core/graph/research-intelligence.js` 负责方法解析、演化关系验证、证据记录、瓶颈和代价。`src/core/ingestion/method-evolution-overlay.js` 将通过验证的关系及其 DAG 投影加入图谱。新工作不改导入过程或图存储。

`src/server/api.js` 的 `loadCorpusLiteForApi` 是经过来源质量筛选的读取路径；`src/server/http.js` 的 `serveCommand` 注册认证 HTTP 路由。`src/mcp/research-workflows.js` 描述按操作验证的接口，`src/mcp/tool-research-lookup.js` 分派只读查询。默认 MCP 的 `lineage_analysis` 已有 overview/problem/method/evidence/path/context/impact。

`web/index.html` 包含左侧主题输入、中间画布和右侧检查器；`web/app.js` 管理语料选择、请求和状态，`web/analysis-view.js` 目前把演化结果画成卡片。新视图应占用中央图区域并提供返回知识图的入口；旧主题分析和导航继续可用。

测试采用 `node --test`，已有 `test/topic-analysis.test.js`、`test/method-evolution-overlay.test.js`、`test/research-workflow-views.test.js`、`test/mcp-research-workflows.test.js` 和 schema snapshots。文档通过 `npm run docs:generate` 从接口生成。

## Scope

交付领域子图筛选、方法关系归一化、家族/主线/分支/合流/替换候选、年份分组、论文关系投影、完整覆盖诊断和交互视图。支持论文信息与关系证据详情，导出当前图 SVG 和完整分析 JSON。新 HTTP/MCP 操作为增量接口，保持既有操作与字段语义。

## Non-Goals

本轮不自动下载论文、调用 LLM、运行训练、刷新生产图谱或部署远端服务；不建立新的数据库或权威状态；不凭引用数量给论文影响力排名，不把结构性家族自动命名为公认学派，也不把年份分组写成学术范式的断代结论。

## Non-Negotiable Rules

修改任何既有函数、方法或类前，执行 GitNexus upstream impact 并告知直接调用者、受影响路径和风险；HIGH/CRITICAL 必须在编辑前提示。提交前执行 detect_changes。索引失效先重建；工具找不到符号不代表没有影响，须记录并核对源码调用点。

分析只读、确定、无网络与查询时 LLM。候选/被拒关系不得进入已验证主线。缺失年份单独显示为 Undated，不猜测；同年先后不靠年份推断。全景必须显示当前论文库、筛选条件、返回数量、预算限制和证据缺失。空图不代表领域没有研究。

SVG/HTML 转义来自论文的文本；点击来源只使用明确的 http/https 文献链接或现有节点定位。出错、快速切换语料和重复请求不得留下上一语料的“成功结果”。

## Authority / Evidence Model

提交的语料图与现有 research quality view 决定可用节点和关系；方法关系验证决定哪些关系进入谱系。新分析结果是该状态的投影，不写回原图。图结构产生的家族、主线和转折候选必须标识推断依据；论文引句保存其 paper/span/edge ID。图中位置和年份只表达排序，不赋予因果或历史优先权。

分析响应和浏览器消费同一模型。测试日志、截图和计划是验证材料；分支提交与 `main` 包含该提交才是代码交付的依据。

## Plan of Work

### M0：计划审查与接口冻结

先检查本文的范围选择、图方向、证据复用、主线定义和浏览器验收是否足够具体。把发现、严重性、修订与结论写入同目录 `2026-10-25-field-evolution-atlas-review.md`，修订本文后再实施。执行现有接入函数的影响分析并保存简要报告。产出是可按命令推进的方案与明确风险，不改业务实现。

### M1：可验证的领域演化模型

新增 `src/core/graph/field-evolution.js`，导出 `buildFieldEvolution(graph, options)`。从领域/主题或明确种子选择论文和方法，在预算内扩展已验证谱系；不受八方法预览限制。复用方法证据记录，合并同一引用的重复投影，统一边方向。返回方法视图和从方法关系投影的论文视图、家族、主线、转折候选、年份分组和覆盖信息。

新增合成 fixture，包括超过八个方法、两条独立家族、分叉、合流、替换、组件复用、重复投影、缺失年份、同年关系、无证据关系、领域外论文和孤立论文。测试既要确认应有关系，也要证明候选边和普通引用不会进入已验证谱系。不得修改输入图。

### M2：接口切片

在 `src/server/api.js` 增加 `fieldEvolutionPayload`，由 HTTP `POST /api/field-evolution` 和 MCP `lineage_analysis/landscape` 共用；旧 `research_lookup` 增加 `field_evolution`。参数使用 query/targetDomain/seedNodeIds/fromYear/toYear/maxDepth/maxNodes/maxEdges/corpus/responseMode 的明确子集，无任意写入参数透传。测试 HTTP/MCP 数据一致性、来源准入、空结果、参数限制和 summary 回读。更新 schema snapshots 和生成文档。

### 已审核的分析规则

范围选择扫描质量视图中的论文与方法，不调用有 50 组上限的 `searchGraph`。从论文标题、摘要、关键词以及关联方法/问题文本构建词法索引；query 的非停用词全部匹配，保留 ML/CV 等短术语，中文采用规范化文本匹配。targetDomain 与论文/方法标签忽略大小写精确匹配。query 与 targetDomain 同时提供时取交集。seedNodeIds 是显式锚点选择器，支持 Paper/Method/有可解析所属论文的语义节点；给出种子时不重新解释 query。接口至少要求 query、targetDomain 或非空 seedNodeIds 之一。

先选核心论文及其关联方法，再沿已验证方法关系双向扩展不超过 maxDepth（默认 2，最大 4）。领域外邻居作为 `boundary` 上下文显示。年份范围作用于所有显示节点，未知年份保留并标注；不把范围外论文偷偷加回图。通过节点/关系 ID 解析来源，单纯引用不扩展为演化边。

`maxNodes` 默认 180、最大 500，分别限制方法视图和论文视图；`maxEdges` 默认 350、最大 1000，分别限制去重后的方法关系和论文投影。先保留核心再保留边界，同级按年份和稳定 ID 顺序。scope 给出库内可用、匹配、返回与省略数量，diagnostics 给出遗漏年份、未验证关系、无法投影的多义论文归属等。预算后的孤立节点仍可显示，不能凭无连线断言没有前驱。

相同 candidateId/citationRelationshipId 的原关系和 DAG 投影合并为一条语义关系，并保留全部 graph edge IDs；不同证据关系仍各自可回查。沿 `COMPONENT_OF` 为组件到组合方法，其余原始强方法边反向显示为前驱到后继。引文与 graphRelationship 保持原样。论文投影优先使用该边的 sourcePaper/targetPaper 归属，缺失时仅接受唯一端点论文；不做多篇归属的笛卡尔积，不画论文自环，无法解析时保留方法关系与诊断。

家族由显示的已验证方法关系的弱连通分量形成；孤立方法归入明确的未连接组，不声称同一学派。无环家族的主线是最长已验证路径，等长按稳定 ID 字典序选择；有环家族不输出主线而保留图和诊断。分叉至少有两个不同后继，合流至少有两个不同前驱；替换和跨域适配依据原始关系类型。所有转折称候选并列出支持的 edgeIds。年度分布只统计观测年份，不自动声称范式阶段。

论文视图按上述关系投影而成，同一论文可能属于多个家族；筛选任一家族均应能看到它。图中不把“关联论文”改称“首次提出”。详情提供完整标题、实际年份精度、所有可用论文引用、原关系类型、引句与 sourceSpan，无法回查的字段保持未知。

### M3：可操作的演化地图

新增 `web/field-evolution-view.js`，把分析模型转换为 SVG 时间轴及详情。横轴表示年份，纵向区分家族和同年节点；缺失年份另列。提供论文/方法切换、家族筛选、主线强调、转折选择、缩放和滚动、来源证据、JSON/SVG 导出。论文视图的连线明确表示方法演化投影，不冒充普通引用图。

在主题表单增加演化地图入口与年份范围。在中央画布容器增加独立地图区域，旧知识图可返回。选择节点/边时高亮邻接关系，并展示完整标题、所属论文、关系原文和机制变化。移动端和键盘用户可访问控件与详情。用请求序号防止旧响应覆盖新语料，失败时显示可操作的错误状态。

### M4：验证、文档与代码审查

执行领域模型、既有方法关系、来源质量、MCP 契约及视图相关测试。用本机隔离样例启动应用，在真实浏览器中完成输入主题、查看时间轴、切换论文/方法、选择家族、点击转折与证据、调整年份和空结果等操作；保存截图和简短验收记录。若已有相关静态或集成检查失败，区分本次问题与基线问题并修复本次问题。更新用户操作说明与技能中的分析入口说明。最终审查筛选范围、时间方向、证据完整性、丢失选择、界面可用性及兼容性。

### M5：提交和本地合并

检查差异只含本任务文件，运行 GitNexus detect_changes，提交 `codex/field-evolution-atlas`。合并前检查原工作区 `main` HEAD、未提交路径和其他工作区占用；不 stash/清理用户改动。如 `main` 前进，在隔离分支整合它并重跑受冲突影响的检查。回到原工作区执行普通 merge/fast-forward，保持无关工作树内容。验收 `main` 包含功能提交并记录最终提交。没有要求远端发布。

## Concrete Steps

所有实现和检查在 `/Users/iranb/.codex/worktrees/field-evolution-atlas/PaperNexus` 运行。首次依赖可复用原工作区的 node_modules（仅本机忽略的链接），不修改依赖清单。

    git status --short
    node --test test/field-evolution.test.js test/field-evolution-api.test.js test/field-evolution-view.test.js
    node --test test/topic-analysis.test.js test/method-evolution-overlay.test.js test/method-evolution-validator.test.js test/research-workflow-views.test.js test/mcp-research-workflows.test.js test/mcp-schema-snapshot.test.js
    npm run docs:generate
    git diff --check

新测试文件须随实现添加；测试期望全部通过，且检验至少十个方法的演化链、有效证据、界面交互与图谱无变更。浏览器使用临时合成语料，禁用后台 worker，不接触生产数据。具体启动命令、临时路径、截图和结果写入验收记录。最终真实浏览器命令为 `node scripts/verify-field-evolution-browser.mjs /tmp/papernexus-field-acceptance-final`。GitNexus CLI 用当前仓库的绝对路径指定索引，避免同名仓库索引混淆。

## Validation and Acceptance

验收以用户行为为准：领域输入得到明确范围的时间轴；超过八个方法可在预算内出现；家族与主线可识别，分叉和合流可追踪；论文/方法切换保留可解释的关系；每个转折候选可打开依据，每条已验证关系可打开原文与来源；无年份独立显示；范围或预算导致的遗漏可见；失败/空结果不展示旧数据；旧主题分析仍正常。JSON 和 SVG 导出与当前结果及筛选一致。

纯函数测试检查图方向、主线选择、重复证据与候选边；集成测试检查真实 HTTP/MCP 路由、准入及只读；浏览器检查实际 DOM、交互、布局和错误。相关现有测试一次通过后不反复全量重跑，除非新增修改影响它们。最终交付包含计划、审查结论、操作文档、验收证据、实现提交和本地 `main` 合并记录。

## Idempotence and Recovery

分析和测试可重复运行，无图谱写入；导出仅写用户显式下载的文件。中断后先读本文 Progress、分支状态和审查记录，在该工作区继续。不要重复创建分支或工作区，不把测试语料导入生产。浏览器测试进程仅按记录的本任务 PID/session 停止。提交前确认哪些文件已暂存；合并前用 `git merge-base --is-ancestor` 判断是否已包含，避免重复合并。

## Risks and Rollback

领域筛选过宽会混入无关方法，过窄会丢失跨域前驱；展示核心论文与边界前驱的区别并记录范围。时间反向、同年循环和重复投影会产生假主线；保留诊断，不能用假日期或任意删边来伪装 DAG。高密度图影响可读性；使用明确预算、家族筛选和滚动/缩放，不隐藏截断事实。接口新增需要 snapshot 和文档同时更新；旧操作回归覆盖兼容性。

实现是新模块加增量入口，无存储迁移。未提交阶段可只恢复本任务文件；提交后用 revert 撤回功能提交，不 reset 或清理用户工作树。远端没有被修改，无远端回滚步骤。

## Artifacts and Notes

计划：`.agent/plans/2026-10-25-field-evolution-atlas.md`。
计划审查：`.agent/plans/2026-10-25-field-evolution-atlas-review.md`。
实现验收：`docs/development/2026-10-25-field-evolution-acceptance.md`。
用户说明：`docs/operations/field-evolution.md`。
浏览器样例与截图保存在任务工作区外的临时或报告目录，报告记录准确路径；不要提交整套临时语料或大幅截图。

## Interfaces and Dependencies

`buildFieldEvolution(graph, options)` 是纯函数，返回 `contractVersion=papernexus-field-evolution-v1`、`status`、`scope`、`methods`、`papers`、`relations`、`paperRelations`、`families`、`turningPoints`、`periods`、`diagnostics`。每个节点和关系保留可回查的 graph/paper/edge/span ID。family 保存成员、主线路径与选取依据。turningPoint 保存类别、涉及节点/关系和结构依据。scope 保存 query/domain/year/budgets、数量、截断原因和范围边界。

`fieldEvolutionPayload` 复用 research quality view，返回上述 result 和来源质量/版本信息。HTTP 和 MCP 共享它。视图模块消费 result，不自行重新推导学术关系。采用现有 Node、浏览器 SVG、CSS 及测试工具，不添加生产依赖。

## Revision Notes

2026-10-25：依据现有代码和用户目标建立初版，准备在实施前审查与收敛具体算法及验收条件。
2026-10-25：完成合理性审查，加入完整范围扫描、证据去重、论文投影、可解释主线、循环处理、逐视图预算和浏览器状态验收的确定性规则；审查材料位于同目录 review 文件。

2026-10-25：完成 M0–M4，记录实现、相关回归、真实浏览器与文档构建结果，进入提交和本地合并。

2026-10-25：M5 完成，本地 main 已包含功能提交；保留原工作区未提交论文 PDF 和无关未跟踪文件。
