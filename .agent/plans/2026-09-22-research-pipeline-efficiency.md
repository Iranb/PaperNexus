# 打通科研证据与技能流水线 ExecPlan

Created: 2026-09-22 Asia/Shanghai
Updated: 2026-09-22 Asia/Shanghai
Target repository: `/Users/iranb/Library/Mobile Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus`
Target branch / worktree: `main`；仅提交本计划列明的任务文件。
Related docs: `docs/interfaces/mcp-skill-contracts.md`、`docs/interfaces/mcp-three-workflows.md`、`docs/operations/research-quality.md`。

这是持续维护的执行契约。后来者应仅凭仓库和本文继续，无须聊天记录。仓库未发现 PLANS.md。每个里程碑后更新 Progress、Surprises & Discoveries、Decision Log、Artifacts and Notes、Outcomes & Retrospective；按阶段自主执行，不重复询问已授权的下一步。

## Purpose / Big Picture

用户可用三个任务导向 MCP 入口完成论文检索、原文阅读、证据分析与候选创新审查；已隔离记录不会从材料入口重新变成科研证据。客户端能发现能力与版本、取得有边界的紧凑输出，并知道提案缺少什么输入。技能按任务加载，不为简单查询强制启动深度创新流水线。41 实际部署、技能和 GitHub main 保持本次交付一致。

可观察验收：41 tools/list 广告三个研究工具；质量隔离测试论文的 paper view 明确 quarantined 且不返回活跃科研上下文；标准 GCD 原文仍可读取；紧凑输出有字节上限及未展示证据说明；空 proposal 请求立即返回 needs_actions，明确下一步而不是空跑多轮；完整合法动作仍可提交。

## Progress

- [x] 2026-09-22：审计当前 main=4dc47ae、生产旧23工具与本机技能；确认现有 ExecPlan 规范，工作树保护范围。
- [x] Phase 1：统一材料质量与身份映射，验证隔离和版本兼容。
- [x] Phase 2：明确提案动作契约、能力发现、可选紧凑响应。
- [x] Phase 3：技能合并、阶段引用、AutoResearch 适配与契约文档。
- [x] Phase 4：定向及全量回归、生成文档、接口预算验证。
- [x] Phase 5：41 只读预检、隔离演练、备份部署与在线验收。
- [ ] Phase 6：GitNexus staged 检查、选择性提交、推送并核对 GitHub main。

## Context and Orientation

当前 main 已有 src/mcp/research-workflows.js 的 literature_review、lineage_analysis、idea_generation（11/7/6 操作），但 41 `/data2/hyq/PaperNexus` 没有这个模块，实际 tools/list 仍23个旧工具。src/mcp/core.js 分发新旧调用；旧工具保持直接调用兼容。src/core/materials/agent-materials.js 的 loadMaterialContext 直接读取原始 lite 图；buildPaperMaterialView 可能将原始隔离记录标为 in_graph。src/core/graph/research-quality.js 提供不写原图的质量投影。

proposal-controller.js 接收 actions/slates/roleRunners。MCP 包装器仅传 actions/slates，没有服务端生成器。AutoResearch 示例只给问题和 evidenceRefs，导致只有 Problem 的空轮。旧碰撞检查可把领域关键词命中报为组合碰撞，应明确词匹配仅为线索，保留现有新主分支 semantic_equivalence_checked=false 限制。

11 个仓库 SKILL.md 共1410行，主入口303行；大量规则重复。专用 Python wrappers 多为 runpy 转发，保留不复制业务。两处 pn_import_queue.py 文档路径不存在。真实一次创新包约314KiB，不可将 limit 当响应字节预算。已有 API 缓存及异步队列应复用，不造第二套完成状态。

本次开始存在用户论文 main.pdf 修改、旧计划和 .agent/reports、重复 iCloud 文件以及无关脚本；不提交或删除。审计原始记录在 `.agent/reports/2026-09-22-mcp-skill-audit/`，不是公开依赖，关键发现已完整写入本文。

## Scope

修复材料读路径与直接论文读的隔离契约，保留版本映射；完善 proposal 调用可执行示例与缺少动作的快速诊断；添加新入口能力发现和可选有界摘要；合并仓库技能并把已安装 PaperNexus/AutoResearch 的相关调用指南适配为共享契约（本机文件备份、仓库保存可复用适配说明）；验证并部署41完整应用版本，提交GitHub main。

## Non-Goals

不删除原始论文和图谱、不启动全文刷新/导入/训练/付费发现、不自动写科学新颖性结论。不重建 AutoResearch 全部状态库，不开发新的模型生成器或持久缓存系统。本次提高接口可用性和证据边界，不宣称论文创新质量或科研产出已通过模型评测。历史元数据全面修复留给独立任务；本次返回质量投影实际计数。

## Non-Negotiable Rules

用户已明确授权按计划优化并提交 GitHub main；本会话此前41同步部署授权继续有效。部署先只读诊断、隔离演练，再做文件备份和可回滚切换；不额外请求泛化批准。没有授权付费调用、语料删除或训练，本计划不会执行它们。文件/会话认证继续使用既有安全路径，不打印令牌。

所有既有函数修改前执行 GitNexus upstream impact，报告直接调用者/流程/风险；HIGH/CRITICAL 先提示。提交前 detect_changes。旧 MCP 名称及默认完整结果保留，新增质量状态属于纠正语义，文档说明迁移；summary 显式 opt-in。旧技能目录和脚本入口保留转发，不破坏外部调用。

## Authority / Evidence Model

原始语料与 manifest 是来源存储权威；quality view 决定当前科研证据准入，in_graph 只说明存储可见性，eligible 不证明发表真实性。导入 task 与 authoritative-sync 记录分别决定各自就绪状态。proposal controller 只决定结构提交，不决定科学真理；Agent 提供动作，原文 span 支撑主张，独立审查判断证据边界。AutoResearch 状态库继续拥有项目科研阶段，不由报告或 PaperNexus 摘要擅自推进。

## Plan of Work

### Phase 1：材料质量最小闭环

在 loadMaterialContext 应用共享质量投影，并依据隔离ID/来源/版本映射排除材料检索中的失格候选。直接请求隔离论文返回可解释 source_admission、原因、原始身份，禁止返回可提升为研究证据的 graph_context；正常来源、缺失来源与版本别名仍可辨别。保留原始 manifest/graph，读取无写回。补集成测试覆盖 research_material_pack、paper view、source discovery 与版本映射。风险是误滤合法材料，以保留正常源、共享节点及原图字节不变验证。

### Phase 2：可执行提案及有界接口

对无 actions/slates 的 MCP proposal 请求立即返回 diagnosis/needs_actions 与结构化 required_inputs/next_action；合法动作路径保持原契约。新工具 literature_review 增 capabilities 操作，说明可用操作、协议版本、摘要模式和高级动作入口。新三入口增加 responseMode=full|summary，默认full兼容；summary 限制总输出体积，保留顶层证据门槛、状态、下一步和可定位引用，明确未展示内容及回读方式；不可因摘要截断把不充分证据改为充分。单次summary目标 <=32KiB（UTF-8 JSON），超量时返回明确的有界摘要而非无提示截断。使用共享只读投影并保留现有 API 缓存；不引入未评估的多级缓存。

### Phase 3：技能按需收敛

将 SKILL/PaperNexus 作为 papernexus-research 规范实现或兼容稳定名字的研究入口，主体 <=150行，references 分 literature/analysis/ideation/remote-contract/advanced。新维护入口集中 import/refresh，Reflection保留高级复盘职责，其余专用技能成为短转发且保留旧name。修复悬空脚本引用，canonical wrappers 不变。AutoResearch 适配说明明确 quick/standard/deep、增量证据复用、先生成actions再提交proposal；literature/innovation共享证据而不合并科学职责。仅更新直接相关安装技能，并在本地备份；提交仓库版适配说明使GitHub可复现。风险是旧引用失效，用技能引用存在性和工具路由测试检查。

### Phase 4：回归与文档

先跑新增质量/工作流/proposal定向测试，失败修复后跑一次全量 node 测试；只有新故障或改动才重跑受影响部分。执行 docs:generate，检查生成的 schema 和用例。保存请求/响应字节、原图哈希、测试统计与边界验证摘要；不把字节减少声称为token或科学效率提升。

### Phase 5：41可回滚同步

只读记录在线 tools/list、当前文件清单/哈希、图谱哈希、启动方式。服务器不是Git工作树，不能直接git reset覆盖；从当前仓库 tracked app 文件生成候选快照，在41 staging保留现有 node_modules 和运行配置。比较远程应用的差异，不覆盖语料、凭据、环境和未知业务改动。隔离执行接口/质量回归后备份受替换文件和新增路径清单，部署src/web/package与相应SKILL/文档，使用既有启动脚本重启。若失败恢复备份且移除仅本次新增的应用文件，不能删语料。验收真实 MCP tools/list、capabilities、normal paper、quarantined paper、summary以及登录/健康检查；原图哈希不变。

### Phase 6：发布

检查改动范围、计划完成情况、GitNexus staged blast radius。显式 git add 任务文件，不使用 git add -A。提交后 fetch origin main，必要时安全整合远端；直接正常 push（不force）。git ls-remote 的 main SHA 必须等于本地HEAD。发布回执记录提交及部署证据。

## Agent Contract

采用单一外部研究Agent控制的流水线，不启动额外子Agent。Agent拥有问题、候选动作和可追溯解释；不拥有导入完成状态和原始论文真实性。PaperNexus是工具，拥有检索、材料准入、动作结构验证。独立审查阶段可由后续科研任务选择，不在本工程任务启动模型评审。模型上下文只放摘要/引用；运行上下文放操作ID/预算；持久状态放既有项目账本与服务队列，禁止将令牌和未证实科学结论写入状态为事实。

## Tool Contract

材料工具：输入精确论文ID或问题；只读，重复请求不会改变语料；隔离/缺源/未提交有不同状态；审计引用包含原始身份与原因。模拟测试用临时语料和本地source，不接网络。

proposal工具：输入问题、证据引用和经过Agent构建的actions/slates；outputDir未设置时无持久写入；缺少动作是可恢复诊断；有动作继续现有验证与commit；trace必须记录动作/修订/阻塞。科学新颖性永不由commit状态证明。

三个研究入口：严格operation路由、capabilities只读、summary明确预算；discover/import依旧是显式有副作用操作，状态及幂等键由既有队列所有。新summary不得触发网络、导入、模型或导出。错误保持既有JSON-RPC错误路径。

## Concrete Steps

工作目录为本文 Target repository。定向测试按实现新增文件更新，例如：

    node --test test/material-quality-admission.test.js test/mcp-research-workflows.test.js test/proposal-controller.test.js
    node --test --test-concurrency=4 test/*.test.js > /tmp/pn-pipeline-full.log 2>&1
    npm run docs:generate
    git diff --check

预期：新增隔离case被阻断、真实材料可读、summary上限成立、无动作proposal零轮并给出动作契约、合法动作不退化，全量0失败。部署回归命令与实测统计在 Artifacts and Notes 补充。

## Validation and Acceptance

完成的直接证据是自动测试、41实际MCP响应及GitHub SHA，不是计划勾选。验收必须包含：旧工具直接调用兼容；新工具发现与能力协商；隔离记录无法成为活跃图谱证据；summary与full状态不冲突且低于32KiB；proposal缺动作不空转且合法输入可提交；旧skill路径仍存在并可路由；原图哈希不变；用户已有脏文件不进入提交。科学任务评测（新颖性/幻觉率）明确未运行，不作提升声称。

## Idempotence and Recovery

本计划为进度入口；`git status --short`、定向测试与只读 tools/list 可重复。测试语料用临时目录并由测试清理。部署每次使用独立 timestamp staging/backup；相同构建哈希已验收则不重复重启。推送失败先读取远端状态，不能强推。重启、导入、付费调用不可在超时后盲目重试；本计划不会导入或付费。中断后先读计划与实际文件/服务状态，跳过已证明的阶段。

## Risks and Rollback

质量过滤误伤：正常材料/版本别名回归；所有变化只读投影，可回退代码。summary遗失门槛：测试不足与拒绝标志保留，无法展示时显式要求full；不静默推进。旧skill调用失败：保留别名及脚本，增加引用检查。远端版本漂移：完整manifest和差异审核，配置/数据永不纳入应用包。启动失败：恢复应用tar与此前启动方式。安装技能变更回退使用本次本地备份，GitHub仓库版本可独立使用。

## Artifacts and Notes

交付计划：本文（纳入Git）。工程说明：`docs/operations/research-pipeline.md`。测试和部署私有回执：`.agent/reports/2026-09-22-pipeline-implementation/`（不上传原始语料/令牌）。本机全量1031项：1029通过、2跳过、0失败；之后摘要回读修复13项定向通过，材料缓存别名复核后继续定向和41隔离回归。安装技能原文件备份在私有回执的 installed-skills-before/。原GCD lite图 SHA256=d62e37bb0bccb2139d05d392506340a73a7955680577790355128467896021e0。41 staging 53/53通过；最后本机材料/控制器/摘要定向33/33及提案/质量/创新16/16通过；12个仓库技能与7个本机安装技能通过 quick_validate，补正主入口 YAML 后再次验证。41备份：`/data2/hyq/.papernexus/deploy-backups/research-pipeline-20260922`，包含application-before.tar.gz、new-paths.json、changed-paths.json、deployed-manifest.json；226个应用/技能/契约文件逐项SHA256核对一致。真实HTTP MCP验收：3工具，能力操作数12/7/6，正常原文1处span，隔离记录无上下文/原文，旧agent_materials兼容，无动作proposal 0轮；innovation full 807832 bytes，summary 17171 bytes，novelty_claim_allowed=false，两种调用约7.7秒（单次观察，不是性能基准）。浏览器登录/会话/健康均通过，GCD原图哈希未变。将发现的问题、失败原因和修复轨迹写入 Surprises & Discoveries。

## Interfaces and Dependencies

继续使用Node >=20.17、现有Python wrappers和HTTP MCP。不增加第三方依赖。新source_admission为附加字段；完整旧响应默认不删减。summary仅新工具显式请求；缺失动作保留diagnosis大类并追加needs_actions细类。capabilities返回版本和操作列表，不暴露秘密配置。MCP schema变化由生成文档和测试同步。

## Decision Log

Decision：外部Agent生成、服务验证，避免虚构已接通的服务端模型。Rationale：现有MCP没有roleRunners绑定；补齐动作契约即可获得可执行路径。Date/Author：2026-09-22 Codex。

Decision：summary opt-in与按需技能，已有缓存/状态继续复用。Rationale：先解决实测大响应与重复规则，不扩张到新持久化系统。Date/Author：2026-09-22 Codex。

## Surprises & Discoveries

审计发现 production paper_material_view 对隔离测试论文仍报in_graph；proposal最小示例空跑；新增测试先验证旧行为失败，再修复通过。41 完整应用核对发现17个文件落后、5个模块缺失，旧备份文件保留不动。summary 的回读必须区分只读与提交操作，提交后仅指向已有任务状态；请求缓存复用统一参数解析覆盖旧别名，导入副作用请求禁用缓存。

## Outcomes & Retrospective

工程优化和41部署已完成，发布阶段待GitNexus staged检查与GitHub SHA核对。研究入口47行，12个SKILL.md合计175行，详细规则移动到按需references；这只代表默认加载缩减，不能等同科学正确率提升。完整回归1029通过、2跳过，后续修改通过针对性与41回归。已验证summary 32KiB预算、来源隔离、版本兼容、无动作快速诊断和有动作路径。没有运行付费发现、语料写入、模型评审或科研实验；未证明创新质量或实验收益提升。当前Git提交即本次交付版本，发布后在独立回执记录SHA，避免自引用提交哈希。

## Plan Audit / Revision Notes

2026-09-22：按 execplan-builder 20分rubric审计：用户结果2、自包含2、当前状态2、范围2、切片2、验收2、恢复2、风险2、日志2、决策2，总分20/20。风险审批来自用户现有明确实施/部署/推送授权，新增不可逆科研副作用不在范围。

2026-09-22修订：依次完成材料投影、动作诊断/能力/摘要、技能合并、回归和41部署。补充发现：全局 *.md 忽略规则会隐藏技能references，已对规范目录添加精确例外，确保干净克隆可用。提交前只显式暂存任务文件；本地论文PDF及旧计划/回执/重复文件继续保留。

提交前GitNexus：staged 32文件、118个符号/文档节、17条受影响流程，批次风险CRITICAL；逐项核对均为计划中的MCP分发/材料/创新路径，已告知用户并核对高风险上下文。无预期外代码改动，全量和定向/远端验收支持继续发布。
