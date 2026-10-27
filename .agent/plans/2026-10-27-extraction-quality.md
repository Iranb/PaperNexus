# 修复研究语义抽取质量 ExecPlan

Created: 2026-10-27（Asia/Shanghai）
Updated: 2026-10-27（Asia/Shanghai）
Target repository: `/Users/iranb/.codex/worktrees/field-evolution-atlas/PaperNexus`
Target branch / worktree: `codex/extraction-quality`，基于 `e3e53a8`
Related docs: `.agent/reports/2026-10-27-extraction-quality-audit/抽取质量审查.md`

这是持续更新的执行文档。实施者应仅凭当前仓库及本文件继续工作，并逐阶段更新 Progress、Surprises & Discoveries、Decision Log 和 Outcomes & Retrospective。仓库没有独立的 PLANS.md。各阶段完成后直接推进，不以通用的“是否继续”询问中断已授权工作。

## Purpose / Big Picture

用户需要可靠地查询论文的问题、挑战、机制与实验，并据原文审查方法关系。当前结果可作为阅读线索，但部分语义在抽取或入图过程中改变了含义，完成状态也过于宽松。本次修复使系统保留对象归属、认识状态、实验比较条件和原文定位；空输出和未完成分块不能呈现为成功；基线假设、被否定主张及消融试验不能自动变成本文假设或方法采用边。

成功的可观察行为是：通过实际模型接口的离线响应回放，带出处的研究问题、挑战和机制能保留到快照与图；一篇只有学科标签的论文报告空结果；含失败来源的后台任务不再标记全部完成；负向组件消融不进入采用关系；实验数字保留其数据集、任务划分、指标、比较对象和出处。原始抽取与核验结论分别保存，无法确定的科学含义不靠关键词强行改写。

## Progress

- [x] 2026-10-27：读取质量审查、当前代码、现有测试和 GitNexus 索引，建立问题与代码的对应关系。
- [x] 2026-10-27：创建修复分支、ExecPlan 并完成执行前审查。
- [x] 2026-10-27 M1：修复空结果及部分完成状态；单篇、批量和分块空结果测试通过，38 项相关回归通过，混合成功/空结果/欠费的后台批次测试通过。
- [x] 2026-10-27 M2：完善抽取契约，保留证据、归属、认识状态和实验条件，修复输入截断与确定重复。
- [x] 2026-10-27 M3：在图构建中使用语义限定，阻止错误采用与假设边，保留可审查的上下文。
- [x] 2026-10-27 M4：将已确认案例整理为回归集，生成旧产物的离线修正和剩余问题报告。
- [x] 2026-10-27 M5：完成相关回归、文档、变更范围审查和代码提交，记录实际验收结果。

## Surprises & Discoveries

- 研究对象的重复合并需要同时保留多处引句；机制归属或实验条件不同的记录需要保持独立。现有名称去重已更新为同条件合并。
- 原有 supportingSnippets 标准化会截断引句，已保留完整传入引句及来源位置。

- 混合批次回放暴露 HTTP 402 仍触发分块回退。已保留失败状态并跳过欠费回退，测试确认欠费来源只发起一次请求，成功来源独立结算，空结果可进行既有分块回退但不在队列中自动反复重试。

- GitNexus 索引从 `9ce3ae3` 刷新到 `e3e53a8`。概念查询因只读 FTS 初始化错误没有返回结果；符号 context/impact 可用，后续用精确符号分析并辅以源码阅读。
- `createSemanticObjectInferenceResult` 接受调用方的 `participated=true`，没有实际研究对象非空检查。`summarizePaperSemanticExtraction` 又优先信任保存的标记及计数，造成 ICT 空结果误计。
- `sanitizeResearchQuestionRecord`、`sanitizeChallengeRecord` 及其图层 normalizer 丢弃证据属性。机制 normalizer 将短名称填入 description；原文位置没有完整保留。
- `sanitizeEntityRecord` 用对象名填补缺失引句，且截断引句；不能把这个字段的存在视作已找到原文。
- 三种语义提示及三种关系提示是独立构建路径。分块提示将文本硬截为 900 字符，尽管后续还会按提示预算分批。
- 后台 worker 在优化和提交函数返回后直接调用 completed，没有逐篇检查实际快照。GCD 和 SimSiam 的历史分块记录都含失败块。

## Decision Log

- Decision: 将“有产物”“处理完成”“内容已核验”分开，不用参与标记或引句匹配代替质量验收。
  Rationale: 真实数据已有空结果、部分关系和原文可匹配但解释错误的例子。
  Date/Author: 2026-10-27，项目维护。
- Decision: 对归属、认识状态和实验条件增加可选的结构化属性，并在原有对象、证据和关系上保留它们；保持现有节点及边类型。
  Rationale: 当前图和调用方需要读到限定，新增一套并行图或通用迁移框架没有必要。
  Date/Author: 2026-10-27，项目维护。
- Decision: 只根据明确的结构化限定阻止不成立的自动边；不把关键词规则伪装成科学语义判断。
  Rationale: 同一段落可同时讨论有效组件和失败消融，简单词匹配会误杀正确关系。提示与回归样本负责覆盖语义任务，确定性检查负责保留合同与阻止明确矛盾。
  Date/Author: 2026-10-27，项目维护。
- Decision: 本次使用离线回放及所存原文完成验证，不发起新的付费批量抽取，不修改 41 服务的生产数据或重启服务。
  Rationale: 质量修复应先由可重复的接口、快照和图行为证明；已有产物的修正先形成明确的逐项结果。部署和付费重抽是后续独立动作，不应混入质量测试。
  Date/Author: 2026-10-27，项目维护。

## Outcomes & Retrospective

已完成状态、证据与语义限定的保存、图关系准入及已核验案例的离线修正。首轮相关回归 53/53 通过；补充的端到端、历史修正、分阶段流水线与谱系回归 32/32 通过。两轮包含重复测试，不将数量相加作为独立测试数。最终验收共覆盖 149 个不同测试用例，均已通过；文档构建通过。逐项最终结果记录于本次报告目录的 validation.json。GitNexus 提交前范围检查覆盖 27 个文件、255 个符号和 15 条流程，总体 HIGH；所涉导入、抽取和图标准化路径均在既定范围内。代码、文档、测试和计划保存在 codex/extraction-quality 分支的本次提交。

60 份旧快照的回放得到 34 份对象及关系、25 份仅对象、1 份空结果；要求语义和关系均完成的记录为 33 份。四项原文核验修正已写到独立副本。旧数据的 519 条问题/挑战/机制缺引句、511 条同时缺块位置、161 条机制名称式说明、142 条 Evidence 缺实验结构，以及 13 条同条件精确重复均保留为明确诊断。GCD 解析阅读顺序与语义近义词未修复。新提示对真实模型的总体准确率尚未测量；没有付费重抽、部署或生产写入。

## Context and Orientation

### Current State Snapshot

开始执行时工作树的受控文件干净。存在上一轮研究的未跟踪报告、一个未跟踪计划及 `node_modules` 符号链接；它们不能混入本次提交。主工作树和本工作树起点均为 `e3e53a8`，主工作树可能含用户文件改动。

审查范围为 216 篇论文。60 份参与快照中，34 份有研究对象及关系，25 份仅有研究对象，1 份为空；另外 36 份失败或降级，120 份未执行语义抽取。对象与关系分别为 2,970 和 517 条。这些数字是覆盖及产物计数，不是准确率。12 篇作了重点原文核对。

确认案例：RanPAC 将被否定的 CP 基线假设当作无归属假设；SimSiam 将负向预测器消融当成组件采用，且方向错误；C-Flat-Turbo 混淆两项提速的比较基线；SLCA 丢失“可能解释”；ICT 空结果；RanPAC 实验数字未关联完整协议；问题、挑战、机制缺证据；GCD 存在重复及解析和分块问题。正例包括 ALMA 的负向消融、CSC 的条件和 iCaRL 的存储限制。

### Terms and System Map

`src/core/llm/ollama.js` 负责单篇、批量、分块提示，模型请求、输出清洗和推断结果。`src/core/llm/prompts/*` 保存提示版本和缓存签名。`src/core/ingestion/pipeline.js` 合并推断、保存快照、汇总状态、恢复未完成任务以及将自动关系入图。`src/core/ingestion/graph-precompute.js` 构建对象节点及论文到对象的关系。`src/core/graph/research-questions.js`、`challenges.js`、`abstract-mechanisms.js` 负责相应结构的标准化。`src/core/imports/worker.js` 管理后台语义任务及对外完成状态。

`llmSemanticObjects` 是自动语义快照；`llmRelations` 是自动关系；已核验的 64 条谱系关系是独立原文审查产物。`participated` 应表示模型产出了实际研究内容；任务 completed 表示要求执行的阶段完成，不能表示科学结论已核验。

## Scope

修复空结果、部分失败的判定；补齐提示、清洗、快照与图之间的证据和语义限定；保留实验记录的协议及比较对象；处理明确重复；防止已明确为基线、否定、推测或消融的记录被自动升级为不相符的事实关系。新增与确认问题一一对应的离线回归和可重复的产物审查报告。

## Non-Goals

本轮不切换模型服务商，不实现 Batch API，不全量重抽 216 篇，不建立新图存储或通用迁移系统，不改造整套 PDF/OCR 解析器，不承诺科学语义的自动完美判定。GCD 原文阅读顺序问题需要保留为来源质量限制；不能用机械重排冒充修复。

## Non-Negotiable Rules

现有公开工具和节点类型保持兼容；新增属性应有实际消费者及验收，不增加无人使用的状态。保留有价值的负向结果。没有证据的属性保持缺失，不能以对象名制造原文引句。相同名字而实验条件不同的结果不得合并。旧记录缺少新字段时应保留可读性，不能因此删掉整个旧图。

修改已有函数前逐符号运行 GitNexus upstream impact，报告直接调用和影响流程；HIGH/CRITICAL 在修改前告知。提交前运行 detect-changes。所有模型测试拦截请求，使用隔离临时目录，不读写生产语料。报告和修正副本只写到本工作树的本次报告目录。

## Authority / Evidence Model

逐篇所选来源的实际快照是产物及阶段状态的直接依据。对象数组、模型错误、关系阶段记录、已处理和失败块共同决定任务是否完成；标签及模型成功响应本身不决定完成。模型提供的归属与认识状态是抽取内容，不等于外部核验。原文核验记录才支持科学纠错。引句定位、离线测试和质量报告是诊断证据。

## Plan of Work

### M1：如实表示产出与完成状态

统一实际研究内容计数，排除学科标签。单篇、批量和分块输出为空时标记 `empty-semantic-result`，不记成功参与；有有效产物的部分失败仍保留产物。更新旧快照汇总，避免信任过时的计数。后台任务以其 changedSourceKeys 的所选快照为范围，检查必需语义和关系阶段，分别结算合并批次中的成功与失败任务；余额不足不得形成连续自动重试。测试覆盖 ICT、正常有内容、部分分块、合法零关系及混合成功批次。

### M2：保留科学含义与证据

共享语义质量提示约束并覆盖三种语义、三种关系入口。要求区分本文方法与基线、观测与推测、采用与消融，分别记录数值的比较对象和条件；研究问题、挑战和机制需有原文证据及位置。增加紧凑的属性清洗，贯穿 normalizer、快照和图属性。缺失引文不再由名称补充；有引文时保留足够上下文，不静默截掉关键限定。机制支持结构化说明，名称列表继续可读。采用确定性名称及同条件去重，不做未经验证的语义相似合并。分块提示保留传入块的完整文本，由现有预算分批控制调用大小。验收从模拟接口返回到保存快照及最终图读取，不仅检查提示字符串。

### M3：阻止明确不成立的图关系

基线或被否定的假设可以作为论文讨论内容保留，但不能生成本文 ASSUMES 边；消融、比较、推测不能生成正式方法采用或继承边。保存限定和拒绝原因供审查，不凭几个词猜方向或改写结论。结构化实验记录必须能在 Evidence/Finding 的图属性中读到协议及比较基线；缺条件时明确显示缺失，不宣布“可比”。验证正向采用、负向消融、基线假设及正常方法关系共存时的行为。

### M4：真实案例回归与旧产物离线修正

将 Q1—Q8 及正例转为紧凑的回归材料，标明来源、对象指针、审查决定和验证边界。对于 Q1—Q4 的已确认含义错误，在本次目录生成经过原文核对的修正副本和逐项差异；不声称程序能自动推断所有修正。运行新增诊断对现有 60 份快照回放，报告哪些问题已能防止、哪些需要补证或重新抽取。保持旧原始快照不变，避免把输入质量诊断记成已重抽成功。

### M5：集成验收与交付

运行新质量测试与现有语义、分块、关系、后台导入和图测试；发现失败时判断是否为约定变更或回归，修正后再验证相关范围。更新操作说明，说明新增属性、空结果、部分任务恢复和旧产物重审方式。记录 GitNexus 影响、测试和离线回放结论后提交本次明确文件；不加入旧报告、依赖链接或生产语料。最终报告包含计划、实现、验证和已知限制。

## Concrete Steps

所有命令从目标工作树运行。首先完成本计划及审查，再运行各待改符号的 impact。实现时先加入能复现实际问题的测试，然后修改最小调用链。

    npx --no-install gitnexus impact <symbol> --direction upstream --repo /Users/iranb/.codex/worktrees/field-evolution-atlas/PaperNexus
    node --test test/extraction-quality.test.js test/extraction-quality-graph.test.js test/extraction-quality-worker.test.js test/extraction-quality-replay.test.js
    node --test test/semantic-extraction.test.js test/llm-fulltext-batch.test.js test/import-worker.test.js test/takeaway-extraction.test.js test/challenge-graph.test.js test/research-quality.test.js
    node scripts/audit-extraction-quality.mjs --input .agent/reports/2026-10-27-extraction-quality-audit/sources --output .agent/reports/2026-10-27-extraction-quality-fix/replay
    node --test test/ollama.test.js test/materialize-optimize.test.js test/staged-pipeline.test.js test/method-evolution-overlay.test.js test/method-evolution-validator.test.js test/provenance-envelope.test.js
    npx --no-install vitepress build docs
    git diff --check
    npx --no-install gitnexus analyze --force
    npx --no-install gitnexus detect-changes --scope staged --repo /Users/iranb/.codex/worktrees/field-evolution-atlas/PaperNexus

新增测试和审查脚本的名称在实现中确定后同步本段。测试必须零付费请求；输出需证明所存证据及图关系符合上述场景。

## Validation and Acceptance

空输出不得计成功；正常内容不得被误拒。部分失败不可标全完成，混合批次不能拖错其他成功任务。带证据的研究问题、挑战和机制经过整个流程后仍带证据。限定与实验条件经过快照和图构建后仍可读取。消融不会成为采用边，基线假设不会成为本文假设。相同内容的确定重复被合并，实验条件不同的记录保留。原文核对修正与自动诊断分开报告。所有已确认问题须对应修复、明确诊断或保留的来源限制。

## Idempotence and Recovery

本计划和 `.agent/reports/2026-10-27-extraction-quality-fix/` 记录进度与证据。中断后先读计划及 `git status --short`，继续第一个未完成阶段，不重做已通过且代码未变的检查。离线测试使用临时目录，回放脚本仅读取输入并覆盖指定输出目录中的自身报告；不能改写源快照。不得自动执行付费调用、服务器重启或生产图重建。若以后部署或修正生产数据，应先列出具体来源、备份路径、差异及恢复命令，另行形成可审查的操作。

## Risks and Rollback

主要风险是把合法零关系当失败、以新字段缺失误拒旧数据、丢弃负向结果，以及合并条件不同的实验。用正反例回归关闭这些风险。缺失可选字段不作为旧对象删除条件。新增属性不能无依据生成推断内容。代码回滚使用本次提交的逆向提交；本轮不做生产写入，所以无需数据回滚。若重放结果仍有无法自动判定的错误，保留来源及人工核验结论，不扩大为全文语义“自动修复器”。

## Artifacts and Notes

执行前审查：`.agent/plans/2026-10-27-extraction-quality-review.md`。
实际输入及原文：`.agent/reports/2026-10-27-extraction-quality-audit/sources/`，不纳入代码提交。
实现验收、影响分析和回放：`.agent/reports/2026-10-27-extraction-quality-fix/`。
可移植的回归数据应在 `test/fixtures/`，只包含必要短片段和规范化审查内容。

## Interfaces and Dependencies

保持单篇、批量、分块推断函数的调用方式；结果新增字段为可选属性，旧版本读入仍可继续分析。提示版本更新，使缓存不会把旧提示结果误当新抽取产物。后台任务沿用现有 completed/failed 状态和恢复路径，失败原因及部分产物记录在 result/diagnostics 中，不新增平行调度器。新增审查脚本不依赖模型密钥，不连接远程服务。

## Revision Notes

2026-10-27：初版根据八项质量发现和代码调用链制定，限定为抽取合同、内容保留、状态和图语义修复，并安排真实产物的离线重审。
