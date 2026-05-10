# PaperNexus Analysis + KG Only Refocus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 PaperNexus 收口为“论文分析 + 证据抽取 + 知识图谱 + 故事线图谱”平台，不再承担找论文、跨站检索、workflow orchestration、owner routing 等职责。

**Architecture:** 外部系统负责研究目标提出、论文发现、候选 source domain 选择、任务调度与多 agent 编排；PaperNexus 只接收已经提供的论文/语料输入，负责解析、semantic extraction、evidence grounding、domain/mechanism/challenge/takeaway/storyline 等图谱 primitive 的构建与查询。实现上延续当前 `ingestion -> graph precompute -> build/merge/write -> catalyst/enhancement views` 路线，新增 challenge/takeaway/storyline graph layer，并把 Task F 拆成可验证的几阶段能力。

**Tech Stack:** Node.js, existing PaperNexus ingestion pipeline, graph store + lite graph payloads, HTTP API, CLI, enhancement worker, semantic extraction, graph-native catalyst adapters.

---

## 0. 设计依据

### 0.1 论文依据

本计划主要依据论文：

- `<downloads-dir>/2603.12226v1.pdf`

从论文抽出的、对 PaperNexus 真正有要求的创新点不是“自动找论文”，而是：

1. 研究问题分解
2. 目标域进展分析
3. 剩余挑战识别
4. `domain-specific challenge` / `domain-agnostic challenge` 双表示
5. 基于 challenge 的跨域启发式与结构化检索
6. literature-grounded takeaway 抽取
7. source-domain insight 向 target-domain 的 recontextualization
8. 基于 interdisciplinary potential 的排序
9. 避免过早执行导向的收缩，保留 exploratory ideation

### 0.2 当前系统快照

截至 2026-04-04，当前 PaperNexus 已有：

- `Domain` / `AbstractMechanism` schema primitive
- `fieldOfStudy / fieldCandidates / domainTags / abstractMechanisms`
- `queryCrossDomainBridges(...)`
- `catalyst` adapter / API / CLI
- mechanism-level community / bridge analysis
- 旧 corpus catalyst metadata backfill
- per-paper enhancement overlays（theory / storyline / reflection）
- mechanism provenance/support 第一版 contract

但仍有明显空缺：

- `AbstractMechanism` 的 `type/category` 仍然弱，当前多数机制仍是字符串数组
- 缺少 graph-native `ResearchQuestion / Challenge / Takeaway / IdeaFragment / StoryBeat`
- 现有 storyline 主要是“单论文 overlay”，不是跨论文、跨域、证据链驱动的故事线图层
- 缺少 challenge-aware retrieval / structural analogy / motif-level matching
- 缺少明确的“PaperNexus 不负责找论文”的架构边界文档与 contract

### 0.3 架构边界

**由外部系统负责：**

- 提出研究目标 / target problem
- 找论文 / 检索外部文献源 / source domain 候选发现
- corpus 组装与调度
- 多 agent owner routing / workflow stage machine / review orchestration
- 最终 write package、requisition、执行决策

**由 PaperNexus 负责：**

- 接收本地或远程已提供的 PDF / Markdown / manifest
- 论文解析、semantic extraction、evidence grounding
- 论文级与跨论文图谱构建
- challenge / mechanism / bridge / takeaway / storyline 的图谱 primitive 与查询
- 面向上层系统暴露稳定的 analysis/KG contract

**非目标：**

- 不在 PaperNexus 内新增 Semantic Scholar / arXiv / web search 的论文发现流水线
- 不在 PaperNexus 内重做 agent workflow 编排层
- 不把 per-paper enhancement overlay 误扩展成完整科研 workflow

---

## 1. File Structure

### 1.1 预计修改文件

- Modify: `src/core/graph/abstract-mechanisms.js`
- Modify: `src/core/graph/domain-bridges.js`
- Modify: `src/core/graph/catalyst-adapter.js`
- Modify: `src/core/graph/lite.js`
- Modify: `src/core/llm/ollama.js`
- Modify: `src/core/ingestion/pipeline.js`
- Modify: `src/core/ingestion/graph-precompute.js`
- Modify: `src/core/enhancements/extract.js`
- Modify: `src/server/api.js`
- Modify: `src/server/http.js`
- Modify: `src/cli/index.js`
- Modify: `docs/services-and-ui.md`

### 1.2 预计新增文件

- Create: `src/core/graph/research-questions.js`
- Create: `src/core/graph/challenges.js`
- Create: `src/core/graph/takeaways.js`
- Create: `src/core/graph/storylines.js`
- Create: `src/core/graph/analogy.js`
- Create: `src/core/graph/bridge-retrieval.js`
- Create: `test/challenge-graph.test.js`
- Create: `test/takeaway-graph.test.js`
- Create: `test/storyline-graph.test.js`
- Create: `test/analogy-graph.test.js`

### 1.3 模块职责

- `abstract-mechanisms.js`
  - mechanism canonicalization、type/category、provenance/support contract
- `research-questions.js`
  - target problem 分解、question normalization、question node/edge helper
- `challenges.js`
  - domain-specific / domain-agnostic challenge 双表示、challenge contract
- `takeaways.js`
  - source-domain takeaway 节点、recontextualized idea fragment 节点
- `storylines.js`
  - graph-native storyline beat 组装、missing beat / risk / evidence coverage
- `analogy.js`
  - structural analogy / motif alignment helper
- `bridge-retrieval.js`
  - vector-backed retrieval contract 与 graph rerank helper

---

## 2. 目标状态

### 2.1 PaperNexus 的输入 contract

PaperNexus 之后只接受这几类输入：

1. 已提供的论文文件
2. 已准备好的 corpus 目录
3. 已确定 target/source domain 标签的语料集合
4. 已提供的 target problem / abstract challenge / research question

它不再把“从哪里找论文”视为内部能力。

### 2.2 PaperNexus 的输出 contract

上层系统应能稳定消费这些结果：

- `fieldOfStudy / fieldCandidates / domainTags`
- `abstractMechanisms` 及其 support/provenance
- `candidateDomains / bridgeNodes / mechanismMatches`
- `researchQuestions`
- `openChallenges`
- `domainAgnosticChallenges`
- `takeaways`
- `ideaFragments`
- `storylineChain`
- `interdisciplinaryPotential`
- `missingEvidence / missingBeats / unsupportedClaims`

---

## 3. Task A-Prime: 明确平台边界，只保留 Analysis/KG 职责

**Files:**
- Modify: `docs/services-and-ui.md`
- Modify: `src/server/api.js`
- Modify: `src/server/http.js`
- Modify: `src/cli/index.js`
- Test: `test/http-auth.test.js`

- [ ] **Step 1: 写边界 contract 测试说明**

在 `test/http-auth.test.js` 旁边新增或扩展注释型/contract 型测试，明确：

- PaperNexus API 只消费已提供 corpus / root / manifest
- 没有内置“外部论文发现 API”
- catalyst / analysis 路径只在现有图或已导入语料上工作

- [ ] **Step 2: 统一 CLI / API 文案**

在 `src/cli/index.js` 和 `src/server/api.js` 的帮助/错误信息中删除任何暗示“系统会替你找论文”的表述，统一为：

- `analyze/import` = 处理已提供论文
- `catalyst/query/storyline` = 在已导入图上分析

- [ ] **Step 3: 更新服务文档**

在 `docs/services-and-ui.md` 中新增一节：

- “PaperNexus owns analysis + KG only”
- “Discovery / orchestration live outside PaperNexus”

- [ ] **Step 4: 跑最小验证**

Run: `node --test test/http-auth.test.js`

Expected:

- PASS
- 不出现新的外部发现接口假设

- [ ] **Step 5: Commit**

```bash
git add docs/services-and-ui.md src/server/api.js src/server/http.js src/cli/index.js test/http-auth.test.js
git commit -m "docs: refocus papernexus on analysis and kg contracts"
```

---

## 4. Task B-Prime: 把 AbstractMechanism 补成真正的中间语义层

**Files:**
- Modify: `src/core/graph/abstract-mechanisms.js`
- Modify: `src/core/llm/ollama.js`
- Modify: `src/core/ingestion/pipeline.js`
- Modify: `src/core/ingestion/graph-precompute.js`
- Modify: `src/core/graph/domain-bridges.js`
- Modify: `src/core/graph/catalyst-adapter.js`
- Test: `test/semantic-extraction.test.js`
- Test: `test/idea-catalyst-schema.test.js`
- Test: `test/catalyst-adapter.test.js`

- [ ] **Step 1: 先写 failing tests，锁住 mechanism type/category contract**

新增测试覆盖：

- 同一 mechanism 在不同论文中被不同表述命名时要归一
- semantic extraction 除了机制名，还能产出 `mechanismType/category`
- mechanism node 仍保留现有 provenance/support，不破坏旧 contract

- [ ] **Step 2: 扩 semantic extraction schema**

在 `src/core/llm/ollama.js` 中把当前：

```json
"abstractMechanisms": ["memory preservation"]
```

升级为兼容双形态：

```json
"abstractMechanisms": [
  "memory preservation",
  {
    "name": "metacontrol policy",
    "type": "control-policy",
    "description": "adaptive trade-off between persistence and flexibility",
    "aliases": ["cognitive control trade-off"]
  }
]
```

要求：

- 保持旧字符串数组兼容
- 新对象形态是 additive，不破坏旧 snapshot 读取

- [ ] **Step 3: 在 pipeline 中标准化 mechanism object**

在 `src/core/ingestion/pipeline.js` 中新增 helper，将 mechanism 统一变成：

```js
{
  name,
  normalizedName,
  canonicalId,
  mechanismType,
  description,
  aliases
}
```

并同时保留：

- 论文级 `abstractMechanisms`
- 供旧逻辑使用的扁平 `abstractMechanismNames`

- [ ] **Step 4: 把 mechanism node 构建从“字符串节点”升级为“结构化节点”**

在 `src/core/graph/abstract-mechanisms.js` / `src/core/graph/domain-bridges.js` 中：

- node 以 `canonicalId` 为主键
- 合并同义别名
- 保存 `mechanismType/category`
- 继续保存 support/provenance

- [ ] **Step 5: 扩 catalyst/query 输出**

在 `src/core/graph/catalyst-adapter.js` 中让以下输出带上：

- `mechanismType`
- `description`
- `aliases`
- `provenanceVersion`

避免上层仍只拿到 bare string。

- [ ] **Step 6: 跑验证**

Run:

- `node --test test/semantic-extraction.test.js test/idea-catalyst-schema.test.js test/catalyst-adapter.test.js`

Expected:

- PASS
- mechanism type/category 进入 snapshot、graph、query contract

- [ ] **Step 7: Commit**

```bash
git add src/core/graph/abstract-mechanisms.js src/core/llm/ollama.js src/core/ingestion/pipeline.js src/core/ingestion/graph-precompute.js src/core/graph/domain-bridges.js src/core/graph/catalyst-adapter.js test/semantic-extraction.test.js test/idea-catalyst-schema.test.js test/catalyst-adapter.test.js
git commit -m "feat: strengthen abstract mechanism schema and typing"
```

---

## 5. Task G: 引入 ResearchQuestion / Challenge 图层

**Files:**
- Create: `src/core/graph/research-questions.js`
- Create: `src/core/graph/challenges.js`
- Modify: `src/core/graph/schema.js`
- Modify: `src/core/llm/ollama.js`
- Modify: `src/core/ingestion/pipeline.js`
- Modify: `src/core/graph/lite.js`
- Test: `test/challenge-graph.test.js`
- Test: `test/semantic-extraction.test.js`

- [ ] **Step 1: 先写 failing tests**

新增测试覆盖：

- 从 problem statement 或 paper cluster 中生成 `ResearchQuestion`
- 为 challenge 保存双表示：
  - `domainSpecificText`
  - `domainAgnosticText`
- challenge 与 evidence / papers / mechanisms / domains 可连通

- [ ] **Step 2: 扩 schema**

在 `src/core/graph/schema.js` 中新增：

- `NODE_TYPES.RESEARCH_QUESTION`
- `NODE_TYPES.CHALLENGE`
- `EDGE_TYPES.DECOMPOSES_TO`
- `EDGE_TYPES.HAS_OPEN_CHALLENGE`
- `EDGE_TYPES.ABSTRACTS_TO`
- `EDGE_TYPES.SUPPORTED_BY_SNIPPET`

- [ ] **Step 3: 扩 extraction / analysis contract**

在 `src/core/llm/ollama.js` 中新增兼容 schema：

```json
"researchQuestions": [
  {
    "name": "...",
    "domainSpecificText": "...",
    "domainAgnosticText": "..."
  }
],
"openChallenges": [
  {
    "name": "...",
    "domainSpecificText": "...",
    "domainAgnosticText": "...",
    "challengeType": "domain-specific|domain-agnostic|mixed",
    "relatedMechanisms": ["..."]
  }
]
```

- [ ] **Step 4: 写入 graph primitive**

在 `research-questions.js` / `challenges.js` / `pipeline.js` 中把这些对象写入图，并建立：

- `Problem -> DECOMPOSES_TO -> ResearchQuestion`
- `ResearchQuestion -> HAS_OPEN_CHALLENGE -> Challenge`
- `Challenge(domain-specific) -> ABSTRACTS_TO -> Challenge(domain-agnostic)`

- [ ] **Step 5: 跑验证**

Run:

- `node --test test/challenge-graph.test.js test/semantic-extraction.test.js`

Expected:

- PASS
- challenge 双表示进入 graph/lite/API

- [ ] **Step 6: Commit**

```bash
git add src/core/graph/research-questions.js src/core/graph/challenges.js src/core/graph/schema.js src/core/llm/ollama.js src/core/ingestion/pipeline.js src/core/graph/lite.js test/challenge-graph.test.js test/semantic-extraction.test.js
git commit -m "feat: add research question and challenge graph primitives"
```

---

## 6. Task H: 引入 EvidenceSnippet / Takeaway / IdeaFragment 图层

**Files:**
- Create: `src/core/graph/takeaways.js`
- Modify: `src/core/graph/schema.js`
- Modify: `src/core/ingestion/pipeline.js`
- Modify: `src/core/graph/lite.js`
- Modify: `src/server/api.js`
- Test: `test/takeaway-graph.test.js`

- [ ] **Step 1: 写 failing tests**

覆盖：

- snippet 级 evidence 可以挂到 challenge / mechanism / takeaway
- source-domain takeaway 可重用，不绑定单篇 paper overlay
- `IdeaFragment` 能表达 recontextualized insight，而不是最终完整 proposal

- [ ] **Step 2: 扩 schema**

新增：

- `NODE_TYPES.EVIDENCE_SNIPPET`
- `NODE_TYPES.TAKEAWAY`
- `NODE_TYPES.IDEA_FRAGMENT`
- `EDGE_TYPES.HAS_TAKEAWAY`
- `EDGE_TYPES.RECONTEXTUALIZES_TO`
- `EDGE_TYPES.ADDRESSES`
- `EDGE_TYPES.SUPPORTED_BY_SNIPPET`

- [ ] **Step 3: 写 graph helper**

在 `takeaways.js` 中实现：

- evidence snippet node builder
- takeaway node builder
- idea fragment node builder
- support edge helper

- [ ] **Step 4: 接 pipeline / API**

让 `pipeline.js` 与 `api.js` 能保存和查询：

- `takeaways`
- `ideaFragments`
- `supportingSnippets`

要求：

- 允许这些对象来自后续 catalyst / enhancement 分析过程
- 不要求在初次导入时全部存在

- [ ] **Step 5: 跑验证**

Run:

- `node --test test/takeaway-graph.test.js test/query-api.test.js`

Expected:

- PASS
- takeaway / idea fragment 可序列化到 lite/API

- [ ] **Step 6: Commit**

```bash
git add src/core/graph/takeaways.js src/core/graph/schema.js src/core/ingestion/pipeline.js src/core/graph/lite.js src/server/api.js test/takeaway-graph.test.js test/query-api.test.js
git commit -m "feat: add takeaway and idea fragment graph primitives"
```

---

## 7. Task I: 把 storyline 从单论文 overlay 升级为 graph-native story layer

**Files:**
- Create: `src/core/graph/storylines.js`
- Modify: `src/core/enhancements/extract.js`
- Modify: `src/server/api.js`
- Modify: `src/lib/render.js`
- Test: `test/storyline-graph.test.js`
- Test: `test/enhancements.test.js`

- [ ] **Step 1: 写 failing tests**

覆盖：

- 不是只生成某一篇论文的 beat，而是能在 target problem 下生成跨论文 story chain
- story chain 至少包含：
  - `problem`
  - `progress`
  - `open challenge`
  - `source-domain takeaway`
  - `recontextualized idea`
  - `evidence`
  - `risk / missing beat`

- [ ] **Step 2: 设计 StoryBeat contract**

在 `storylines.js` 中定义：

```js
{
  beatType,
  nodeId,
  title,
  summary,
  supportingNodeIds,
  supportingSnippetIds,
  missingEvidence,
  riskLevel
}
```

- [ ] **Step 3: 让 enhancement overlay 退化为 story view，而不是唯一真相**

在 `src/core/enhancements/extract.js` 中：

- 保留 per-paper storyline overlay
- 但新增 graph-native storyline builder 入口
- overlay 只作为 paper-local view，不再承担跨论文 story synthesis

- [ ] **Step 4: 暴露 API/CLI**

在 `src/server/api.js` / `src/lib/render.js` 中新增或扩展：

- `storylineChain`
- `missingBeats`
- `unsupportedClaims`
- `openRisks`

- [ ] **Step 5: 跑验证**

Run:

- `node --test test/storyline-graph.test.js test/enhancements.test.js test/query-api.test.js`

Expected:

- PASS
- 现有 per-paper overlay 不回退
- 新 story chain 可跨论文输出

- [ ] **Step 6: Commit**

```bash
git add src/core/graph/storylines.js src/core/enhancements/extract.js src/server/api.js src/lib/render.js test/storyline-graph.test.js test/enhancements.test.js test/query-api.test.js
git commit -m "feat: add graph-native storyline analysis layer"
```

---

## 8. Task F-Phase 1: vector-backed bridge retrieval

**Files:**
- Create: `src/core/graph/bridge-retrieval.js`
- Modify: `src/core/graph/catalyst-adapter.js`
- Modify: `src/server/api.js`
- Test: `test/analogy-graph.test.js`

- [ ] **Step 1: 写 failing tests**

要求：

- 给定 target challenge，可先向量召回 candidate takeaways / mechanisms / idea fragments
- 之后仍由 graph rerank 保证 contract 稳定

- [ ] **Step 2: 设计 retrieval contract**

至少输出：

- `retrievalScore`
- `graphScore`
- `combinedScore`
- `candidateBridgePaths`

- [ ] **Step 3: 实现“向量召回 + 图重排”**

实现顺序：

1. 向量召回 candidate nodes
2. graph traversal 过滤同域/弱支持候选
3. 用 mechanism support / challenge coverage / domain distance rerank

- [ ] **Step 4: 跑验证**

Run:

- `node --test test/analogy-graph.test.js test/catalyst-adapter.test.js test/query-api.test.js`

Expected:

- PASS
- 保持旧 catalyst contract 向后兼容

- [ ] **Step 5: Commit**

```bash
git add src/core/graph/bridge-retrieval.js src/core/graph/catalyst-adapter.js src/server/api.js test/analogy-graph.test.js test/catalyst-adapter.test.js test/query-api.test.js
git commit -m "feat: add vector-backed bridge retrieval with graph reranking"
```

---

## 9. Task F-Phase 2: structural analogy detection + motif matching

**Files:**
- Create: `src/core/graph/analogy.js`
- Modify: `src/core/graph/catalyst-adapter.js`
- Modify: `src/server/api.js`
- Test: `test/analogy-graph.test.js`

- [ ] **Step 1: 写 failing tests**

覆盖：

- `Problem -> Mechanism -> Method -> Outcome`
- `Challenge -> Takeaway -> IdeaFragment`

这两类 motif 的 typed alignment。

- [ ] **Step 2: 实现 motif 提取**

从 graph 中抽局部子图模板：

- challenge motif
- transfer motif
- evaluation motif

- [ ] **Step 3: 实现结构类比打分**

输出：

- `analogyScore`
- `matchedMotifs`
- `transferableMechanisms`
- `alignmentRationale`

- [ ] **Step 4: API 接线**

在 catalyst/storyline 相关 payload 中，把 analogy 输出作为 additive field 暴露。

- [ ] **Step 5: 跑验证**

Run:

- `node --test test/analogy-graph.test.js test/query-api.test.js`

Expected:

- PASS
- 新 analogy 字段是 additive，不破坏旧调用

- [ ] **Step 6: Commit**

```bash
git add src/core/graph/analogy.js src/core/graph/catalyst-adapter.js src/server/api.js test/analogy-graph.test.js test/query-api.test.js
git commit -m "feat: add structural analogy and motif matching helpers"
```

---

## 10. Task F-Phase 3: interdisciplinary potential ranking

**Files:**
- Modify: `src/core/graph/catalyst-adapter.js`
- Modify: `src/server/api.js`
- Modify: `src/lib/render.js`
- Test: `test/catalyst-adapter.test.js`
- Test: `test/query-api.test.js`

- [ ] **Step 1: 写 failing tests**

锁住新的 ranking contract：

- `interdisciplinaryPotential`
- `noveltyProxy`
- `groundingScore`
- `challengeCoverageScore`
- `storyCompleteness`

- [ ] **Step 2: 实现 ranking feature aggregation**

排序信号至少包括：

- domain distance
- mechanism support density
- challenge coverage
- evidence density
- motif/analogy score
- story completeness

- [ ] **Step 3: 暴露 ranking contract**

在 catalyst/storyline 结果中暴露：

- 最终排序分数
- 子分数
- prune / rerank 理由

- [ ] **Step 4: 跑验证**

Run:

- `node --test test/catalyst-adapter.test.js test/query-api.test.js`

Expected:

- PASS
- 排序字段可解释

- [ ] **Step 5: Commit**

```bash
git add src/core/graph/catalyst-adapter.js src/server/api.js src/lib/render.js test/catalyst-adapter.test.js test/query-api.test.js
git commit -m "feat: rank cross-domain ideas by interdisciplinary potential"
```

---

## 11. Task J: 验证与基准

**Files:**
- Modify: `test/semantic-extraction.test.js`
- Modify: `test/idea-catalyst-schema.test.js`
- Modify: `test/catalyst-adapter.test.js`
- Modify: `test/query-api.test.js`
- Create: `test/storyline-graph.test.js`
- Create: `test/analogy-graph.test.js`

- [ ] **Step 1: 补 Task A 的缺口测试**

新增“同一论文多来源 metadata 冲突时如何归一”的测试，锁住：

- `fieldOfStudy`
- `fieldCandidates`
- `domainTags`

的 merge 规则。

- [ ] **Step 2: 建立故事线验证集**

至少包含：

- 一个 target-domain corpus
- 一个 source-domain corpus
- 一个 challenge
- 一条可验证 storyline

- [ ] **Step 3: 建立 analogy / motif 微基准**

用小图 fixture 验证：

- 真类比能被召回
- 伪相似但无结构对应的候选被压下去

- [ ] **Step 4: 跑完整回归**

Run:

```bash
node --test test/http-auth.test.js test/materialize-optimize.test.js test/staged-pipeline.test.js test/import-worker.test.js test/semantic-extraction.test.js test/idea-catalyst-schema.test.js test/catalyst-adapter.test.js test/query-api.test.js test/enhancements.test.js test/challenge-graph.test.js test/takeaway-graph.test.js test/storyline-graph.test.js test/analogy-graph.test.js
```

Expected:

- PASS
- 新增 graph layer 不破坏现有 import / enhancement / catalyst 路径

- [ ] **Step 5: Commit**

```bash
git add test/semantic-extraction.test.js test/idea-catalyst-schema.test.js test/catalyst-adapter.test.js test/query-api.test.js test/challenge-graph.test.js test/takeaway-graph.test.js test/storyline-graph.test.js test/analogy-graph.test.js
git commit -m "test: expand catalyst storyline and analogy coverage"
```

---

## 12. 建议执行顺序

1. `Task A-Prime`
2. `Task B-Prime`
3. `Task G`
4. `Task H`
5. `Task I`
6. `Task F-Phase 1`
7. `Task F-Phase 2`
8. `Task F-Phase 3`
9. `Task J`

---

## 13. 这份新计划与旧计划的差别

相对于 `2026-04-03-papernexus-next-implementation-plan.zh-CN.md`，这份计划做了 3 个关键收口：

1. 明确把“找论文”排除在 PaperNexus 之外
2. 把“故事线构建”从 per-paper overlay 提升到 graph-native primitive
3. 把 Task F 从泛泛的“高级能力”细化为：
   - vector-backed bridge retrieval
   - structural analogy / motif matching
   - interdisciplinary potential ranking

这样做的目的不是让 PaperNexus 变成另一个 workflow 系统，而是让它成为：

**一个可被别的系统稳定调用的、只负责论文分析与知识图谱推理的底层平台。**
