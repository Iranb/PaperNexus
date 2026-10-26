# 领域方法谱系流程与两套真实研究 ExecPlan

Created: 2026-10-26 Asia/Shanghai
Updated: 2026-10-26 Asia/Shanghai
Target repository: `/Users/iranb/Library/Mobile Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus`
Target branch / worktree: `codex/field-evolution-research`, `/Users/iranb/.codex/worktrees/field-evolution-atlas/PaperNexus`

本文是持续维护的执行文件。实施时更新 Progress、Surprises & Discoveries、Decision Log、Artifacts and Notes 和 Outcomes & Retrospective。项目没有独立 PLANS.md，遵循 AGENTS.md。已经获得用户授权优化流程、开展真实文献调查、使用已配置 DeepSeek Flash 提取、更新同一服务器图谱并在原生 Web 展示；不重复索要相同授权。

## Purpose / Big Picture

用户从 PaperNexus 的 Web 端选择“多标签增量学习”或“增量学习”，即可查看保存在服务端、可恢复的领域研究、分支覆盖、论文与方法时间轴以及逐条关系的原文证据。技术任务完成不能自动变成领域覆盖完成。研究覆盖由明确的范围、分支检索、引文扩展、纳入排除决定和遗漏复核支持，论文计数只是实际结果。

当前 32 篇、28 个方法、8 条原文核验关系是已有种子证据。它们可以复用，但不能成为新研究的数量上限。增量学习延续此前确认的范围：持续/增量学习的发展，重点类增量，区分任务增量、域增量和在线设定。多标签研究区分新增标签的多标签类增量、固定标签空间的流式/在线多标签、标签漂移与相关性学习，并明确单标签多类方法仅在有迁移依据时作为上下文。

## Progress

- [x] 核实已部署版本 2a65b8e、官方 DeepSeek Flash 配置、现有谱系与有界 field_research 接口。
- [x] 确认安装 skill 缺失 landscape 说明，仓库和安装 skill 均缺领域谱系完整流程。
- [x] 审核并优化本方案，完成符号影响分析。
- [x] 实现服务端研究保存/读取、MCP/HTTP 接口、覆盖语义与原生 Web 展示；初始 25 项回归和新增 4 项研究接口检查通过。
- [x] 更新并同步 canonical skill，安装版本与仓库一致，技能校验通过。
- [x] 完成 13 组检索、715 条候选筛选记录、86 篇补充全文和原有 32 篇复用；保存两套有明确分支边界及来源缺口的研究。
- [x] 合入并部署；权威图和轻量图回读通过；两套原生 Web 的方法／论文、分支、家族和证据交互验收完成。

## Surprises & Discoveries

现有 field_research 是一次有界扩充：默认 20 篇、最大 100 篇，最多 8 个查询、3 个引文种子。其 completed 是本次任务完成，代码明确不证明整个领域覆盖。现有 Web 仅恢复同一 corpus 最近一轮，无法管理两个长期研究。原有 32 篇审核脚本每篇只保留一个主方法，该人为投影不适合本次需求。

GCD 既有来源曾出现错误共享 arXiv 身份、缺少标题和重复版本。新的领域研究必须先做身份检查；只在精确选定来源内修复或补齐。不得清洗、删除整个库。上一轮已验证的原文、PDF、sourceKey、同步回执在主工作区 `.agent/reports/2026-10-25-incremental-learning-review/`。

GitNexus 查询全文索引当前有只读索引警告；已更新工作树结构索引。影响分析和 symbol context 使用结构索引，查询无结果时结合具体源文件定点检查，不把空查询当成无调用者。

## Decision Log

- Decision: 在现有 papernexus skill 增加领域谱系参考流程；不再并列维护一个竞争入口。Rationale: 文献、谱系、维护规则已有唯一入口，新增细分场景应保持可发现且同步。Date: 2026-10-26。
- Decision: 新增保存在 corpus 下的 field study，记录范围、分支、搜索轮次、论文选择、多个方法及覆盖判断；实际节点和关系仍从权威图读取。Rationale: 两套研究需要跨浏览器恢复和独立选择，不能依赖本地 HTML 或 localStorage。Date: 2026-10-26。
- Decision: 保持已有单轮 field_research 兼容，并显式返回 coverage 尚未评估；多轮扩展由领域 skill 根据证据选择下一轮。Rationale: 不用“自动循环到固定篇数”替代学术判断，也不无限消耗 API。Date: 2026-10-26。

## Context and Orientation

`src/core/research/field-research.js` 协调一次发现、导入、语义与同步。`field-research-scope.js` 负责身份匹配和状态。`src/core/graph/field-evolution.js` 从图谱构建方法家族、演化关系和论文投影。`src/mcp/research-workflows.js` 声明三类研究工具及严格路由；`src/server/http.js` 提供已认证 API。`web/field-evolution-view.js` 渲染原生谱系，`web/field-research-view.js` 展示单轮进度。

主工作区有用户修改的论文 PDF 及其他任务文件，不接触。当前附属工作树干净、HEAD 2a65b8e。远端是既有 41 服务、GCD corpus；真实路径由既有配置和服务回执确定。认证沿用 canonical pn_common 包装器，不打印密钥。现会话未挂载 PaperNexus MCP 命名空间，因此使用已授权的同服务 shell MCP 包装器。

## Scope

本次包含可持续维护的领域研究记录、MCP/HTTP/Web 支持、skill 同步、两个主题的实际检索/提取/图同步和原生可视化。技术接口采用增量扩展，现有查询和一次性研究仍可使用。

## Non-Goals

不进行 GPU 训练、论文结果复现、全语料库身份重建、全新通用代理框架或独立展示网站。不将所有 CITES 或共同主题当成方法继承，不承诺未检索范围的穷尽性。

## Non-Negotiable Rules

修改现有函数前完成 GitNexus upstream impact 并报告高风险；提交前 detect_changes。研究写入前保留对应证据与可回滚快照。来源身份、处理阶段、图可见、覆盖判断分别表达。每篇论文允许多个有原文支持的方法或变体；背景算法按上下文角色处理。引用和性能对比本身不得形成演化边。

## Authority / Evidence Model

既有 import task、semantic snapshot 和 authoritative sync 记录决定执行阶段；权威 graph 决定地图中的真实节点和关系；field study 决定纳入范围与分析者记录的覆盖判断。coverage 不等于 execution，也不由 counts 推断。搜索原始记录、纳入排除理由、PDF 页码、原文短引及关系解释是研究证据。保存研究记录不自动证明来源正确或全部领域覆盖。

## Plan of Work

### 1. 完成一个可保存、可切换的原生研究视图

增加小型 `field-studies.js` 服务，保存 title/query/scope、分支、搜索回执、纳入排除论文、所选方法、缺口和覆盖复核说明。保存仅更新研究记录；读取从当前研究质量视图构造地图。接口在 literature_review 增加 study_save/study/studies，在 HTTP 提供同源认证读写路由。研究不存在或节点缺失时明确报告，不用缓存图伪装可用。保存校验字段和 ID；研究覆盖状态只能是未完成、待复核或带明确依据的已复核，已复核也保留限制。

原生侧栏列出两个研究，打开后复用时间轴、论文/方法切换和关系详情，显示分支与覆盖说明。支持以 corpus/study URL 参数恢复。分支筛选在已保存范围内进行，展示全量计数与显示预算分别显示。选定方法可一篇多个；语义组件不会全部冒充论文主方法。

### 2. 修正完成语义并更新技能

单轮 field_research 保留已有 completed/partial 状态，增加明确的批次执行与覆盖评估字段，Web 用词说明该批任务结束仍需覆盖复核。领域 skill 规定范围分解、现库检索、多源分支查询、前后向引文扩展、身份与全文核验、方法/变体区分、关系证据、遗漏复核、保存研究和原生 Web 验证。没有覆盖依据时继续扩展或明确 pending，不能凭论文数量完成。

### 3. 执行两套真实文献研究

先使用已有综述和核心论文建立分支与术语，再对每个分支检索并保留原始候选。对多标签避免 multi-class/multi-label 混淆，对一般增量保持学习设定区别。合并 DOI/arXiv 的同一论文版本，但保留方法变体。复用已验证全文和语义输出；补齐缺失全文后使用已配置 DeepSeek Flash 提取，检查 JSON 输出完整与来源身份。为关系保存原文位置、关系类型、引用前驱、瓶颈/机制/边界。检查已纳入工作的直接方法前驱和主要综述中尚未覆盖的分支；补齐重要遗漏后形成可审核覆盖说明。任何来源获取限制均命名记录，不能静默跳过。

### 4. 部署、写入和可视验证

运行与改动相关的测试、skill 校验和浏览器验收。合并前检查主分支并保留无关修改，部署仅本任务改动文件，使用现有启动方式在空闲时恢复服务。新增语义/关系按支持的增量提交路径写入原库；保存两套 study；通过 MCP/HTTP 回读当前图。打开实际 PaperNexus Web，切换两套研究、分支、论文/方法视图，点开有出处的关系并保存截图。最终交付原生 URL、范围、实际论文/方法/关系数和明确缺口。

## Concrete Steps

所有源码命令在上述附属工作树执行。研究证据放在 `.agent/reports/2026-10-26-field-lineage-studies/`，远端对应 GCD 下的 research-reviews 目录；每轮提交保存请求、响应和 runId/taskId，超时先查原状态。

    node --test test/field-studies.test.js test/field-studies-api.test.js test/field-research.test.js test/field-research-api.test.js test/field-evolution.test.js test/field-evolution-view.test.js
    node --test test/research-workflows.test.js
    npm run docs:build
    python3 /Users/iranb/.codex/skills/.system/skill-creator/scripts/quick_validate.py SKILL/PaperNexus
    python3 scripts/install-research-skills.py
    git diff --check

安装脚本先预览，确认只涉及本次 canonical skill 后以备份目录应用；若预览包含无关客户端更新，使用等价的定向同步保留其它 skill。真实数据验收使用当前 MCP 和 CUA，离线测试只能证明软件行为。

## Validation and Acceptance

测试必须能发现以下实际错误：批次完成被误标覆盖充分、保存后跨会话丢失、单篇多个方法被压成一个、范围外节点污染、缺失来源被静默接受、分支切换失效、关系详情丢失证据和旧 MCP 操作回归。覆盖声明还必须由实际检索与来源决定支持；测试通过不代替科学核验。最终两套研究在同一原生 Web 中可打开，图数据来自实际权威图，用户不需运行本地报告服务器。

## Idempotence and Recovery

field study 使用稳定 ID 和读回的 revision 更新，写入原子化；读取始终构建当前图。研究轮次沿用 discovery/import 幂等键，不在未知提交结果下重放付费或导入。已完成的来源保留精确 sourceKey 和提取模型记录，重启后先查阶段状态。服务器变更有文件备份与原启动脚本；图写入前备份受影响研究记录和图状态，不删除来源。

## Risks and Rollback

共享 MCP/HTTP 路由改动可能影响其它研究功能，保持新增操作且运行相关回归。现有来源身份污染通过精确证据审核处理，不按标题猜测覆盖。LLM 截断按结束标记核验，对失败来源有限重试。部署前记录现有服务、任务状态与备份；有异常恢复本次改动文件并用既有启动方式恢复服务。论文数、模型候选数和逐原文核验的边数必须分别报告。

## Artifacts and Notes

本方案审核文件：`.agent/plans/2026-10-26-field-lineage-studies-review.md`。当前种子材料和前轮同步证明在主工作区 `.agent/reports/2026-10-25-incremental-learning-review/deepseek-20261026/`。本轮目录保留 raw-search、screening、sources、extraction、relations、coverage、deployment 和 verification 的实际证据，不填造不存在的记录。

## Interfaces and Dependencies

继续依赖现有 `buildFieldEvolution`、`loadCorpusLiteForApi`、graph mutations、discovery/import queues、配置的 LLM 与 canonical MCP transport。新增 study 记录是研究范围和复核说明的持久化，不是另一套图数据库。新增 `field-studies` HTTP 与 MCP 操作共享同一业务服务。UI 使用现有 `mountFieldEvolution`，新增轻量 study 列表和覆盖显示模块。

## Outcomes & Retrospective

研究记录、MCP/HTTP 接口和原生 Web 选择入口已上线。多标签研究包含 45 篇论文、55 个方法／变体和 24 条核验关系；增量学习研究包含 78 篇论文、80 个方法／变体和 21 条核验关系。两套研究去重合计 117 篇论文、128 个方法／变体、43 条核验关系。715 条检索候选的纳入、相邻范围、静态设定、元数据记录和待全文审查决定均已保存。

日期、精确引文、关系状态与多篇来源归属保留在轻量图中；研究先按已选范围构图再作质量检查，避免范围外重复来源替换已选节点。19 项相关存储和接口测试在本地与远端通过。原生回读无缺失论文／方法、归属冲突、未标日期、拒绝关系或谱系环。两个 Web 页面已验收并保存截图。

覆盖限制集中保存在每个 study 的分支和 coverage 中。部分自动语义提取因 DeepSeek 余额不足未完成，原状态未改写；新增方法身份与关系由逐源核验建立。未运行论文代码、复现实验或作协议对齐的性能比较。证据目录为 `.agent/reports/2026-10-26-field-lineage-studies/`，入口说明为 `研究说明.md`。
