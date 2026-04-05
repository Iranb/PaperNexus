# 2026-04-05 OpenClaw-Research 对接 PaperNexus KG 升级的后续事项

## 背景

`2026-04-04-papernexus-kg-upgrade-guide.md` 把升级拆成了两部分：

1. `PaperNexus` 负责论文分析、知识抽取、知识图谱、跨域 bridge / takeaway / ranking 能力。
2. `openclaw-research` 负责把这些能力接到 scout / integrator / gatekeeper / materializer 等科研流程组件里。

截至本文件编写时，`PaperNexus` 侧 P0-P3 已经完成，剩下需要 `openclaw-research` 落地的是“跨系统消费这些能力”的部分。

## 已可用的 PaperNexus 能力

### 1. Domain distance / taxonomy

- MCP tool: `domain_distance`
- MCP resource: `papernexus://corpus/{corpus}/domain-taxonomy`
- 关键字段：
  - `version`
  - `domains`
  - `neighbors`
  - `distances`
  - `mechanismCoverage`

`mechanismCoverage` 的结构是：

```json
{
  "Psychology": {
    "mechanismCount": 3,
    "mechanisms": ["belief calibration", "metacontrol policy", "reflective control"],
    "topMechanisms": [
      {
        "mechanism": "metacontrol policy",
        "count": 4,
        "nodeTypes": ["Method", "Takeaway"]
      }
    ]
  }
}
```

这份 taxonomy 现在已经会：

- 从图中自动推导 domain 邻接关系
- 持久化进 `meta.json`
- 持久化进 `graph.lite.json`
- 在增量更新和 authoritative sync 后自动刷新

### 2. Cross-domain takeaway extraction

- MCP tool: `extract_takeaways`
- 关键字段：
  - `contractVersion`
  - `targetDomain`
  - `agnosticChallenges`
  - `takeaways[]`

每个 `takeaway` 至少会包含：

- `source_domain`
- `concept`
- `mechanism`
- `source_domain_formulation`
- `mechanism_explanation`
- `kg_evidence`
- `relevance_to_challenge`

### 3. Interdisciplinary potential ranking

- MCP tool: `interdisciplinary_potential`
- 关键字段：
  - `contractVersion`
  - `targetDomain`
  - `rankedSourceDomains[]`
  - `domainProfileVersion`
  - `domainDistanceMatrix`

它已经综合使用：

- domain distance
- brainstorm 的 domain-aware community profile
- bridge evidence
- takeaway / mechanism 支撑信息

### 4. Brainstorm 的 domain-aware 输出

- MCP tool: `brainstorm`
- 当 `mode=diverge` 时：
  - 第一个 content item 仍然是人类可读文本
  - 第二个 content item 是 JSON 文本，包含：
    - `domainProfile`
    - `communityAnalysis`

`domainProfile` 当前可以直接提供：

- `topBridgeDomains`
- `domainBridgeScores`
- `domainLatentNeighborCounts`
- `domainBoundaryCounts`
- `communityDomains`

### 5. Transferable edges

`PaperNexus` 现在会在 post-ingestion refinement 中自动补 `TRANSFERABLE_TO`，不再只限于 `Method -> Problem`。

只要跨域节点共享同一个 `AbstractMechanism`，就会生成 transfer enrichment。当前覆盖的节点类型包括：

- `Problem`
- `ResearchQuestion`
- `Challenge`
- `Method`
- `Takeaway`
- `IdeaFragment`
- `Limitation`
- `Assumption`

这意味着 `openclaw-research` 不需要再在流程层手工推断“哪些跨域概念可迁移”，可以直接消费图上的 transfer 结构。

## 必须由 openclaw-research 实现的部分

这些不是 `PaperNexus` 的职责，应该放在 `openclaw-research`：

### 1. `scout-adapter.ts`

目标：

- 用真实的 `domain_distance` 替换当前伪造或静态的领域距离
- 把 `brainstorm(mode=diverge)` 的结构化 `domainProfile` 接入 scout 结果
- 消费更强的 bridge evidence，而不是只靠浅层 keyword overlap

建议对接：

- `domain_distance`
- `brainstorm` 的 `domainProfile`
- `extract_takeaways`
- 如需更细粒度 bridge，可通过现有 PaperNexus adapter/API 暴露 `queryCrossDomainBridges(...)`

### 2. `integrator.ts`

目标：

- 不再把跨域 insight 当自由文本拼接
- 直接消费 `extract_takeaways` 产出的结构化 fragment

建议最少保留这些字段：

- `source_domain`
- `concept`
- `mechanism`
- `source_domain_formulation`
- `mechanism_explanation`
- `kg_evidence`
- `relevance_to_challenge`

### 3. `gatekeeper.ts`

目标：

- 用 `interdisciplinary_potential` 做 sufficiency judgment
- 不再只根据 scout 的浅层候选数判断“跨域证据是否够强”

建议消费：

- `rankedSourceDomains`
- ranking 分数明细
- domain distance
- domain profile summary

### 4. `materializers.ts`

目标：

- 订阅 `domain-taxonomy` resource
- 在 taxonomy 变化后刷新本地 distance / domain prior / routing cache

尤其要利用：

- `neighbors`
- `distances`
- `mechanismCoverage`

### 5. 论文获取与流程编排

这部分仍然不应放进 `PaperNexus`：

- 找论文
- 抓论文
- 多 agent 调度
- 问题分解 orchestration
- Storyline 编排与最终科研写作流程

`PaperNexus` 只负责：

- 对已提供论文做分析
- 生成结构化知识
- 维护图谱
- 提供 bridge / takeaway / ranking 能力

## 对接注意事项

### 1. 优先消费结构化字段，不要解析人类可读文本

优先顺序：

1. MCP JSON/resource
2. API JSON payload
3. 文本渲染结果

### 2. 把 contractVersion 当作消费边界

当前至少有这些版本字段值得记录：

- `idea-catalyst-domain-distance-v1`
- `idea-catalyst-domain-community-profile-v1`
- `idea-catalyst-takeaways-v1`
- `idea-catalyst-interdisciplinary-potential-v1`

### 3. 接受“PaperNexus 不负责找论文”的边界

如果 `openclaw-research` 没先准备好候选论文集合，`PaperNexus` 也不会替它补上这一步。

## 推荐落地顺序

1. `scout-adapter.ts` 接入 `domain_distance`
2. `integrator.ts` 改用 `extract_takeaways`
3. `gatekeeper.ts` 接入 `interdisciplinary_potential`
4. `materializers.ts` 消费 `domain-taxonomy` resource
5. 再做更高层的 storyline / orchestration 调整
