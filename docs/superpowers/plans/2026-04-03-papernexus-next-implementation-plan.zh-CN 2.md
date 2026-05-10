# PaperNexus 下一阶段实施计划

**日期：** 2026-04-03
**作者：** Codex
**范围：** 仅针对 `PaperNexus` 仓库本身的下一阶段改动，不包含 `openclaw-research` 的 workflow 接线。
**关联文档：**

- `<repo-root>/IDEA_CATALYST_MultiAgent_Blueprint.md`
- `<projects-root>/openclaw-research/docs/superpowers/plans/2026-04-03-openclaw-research-system-status-summary.zh-CN.md`
- `<projects-root>/openclaw-research/docs/superpowers/plans/2026-04-03-idea-catalyst-kg-subpipeline.md`

---

## 0. 脱离聊天上下文时必须先知道的事实

这份计划不是从零开始。PaperNexus 侧已经有一批 IDEA-CATALYST 相关基础实现，后续工作应建立在它们之上，而不是重新造轮子。

### 0.1 当前已经存在的核心文件

下面这些文件已经存在，且已有第一版实现：

- `src/core/graph/schema.js`
- `src/core/graph/domain-taxonomy.js`
- `src/core/graph/abstract-mechanisms.js`
- `src/core/graph/domain-bridges.js`
- `src/core/ingestion/pipeline.js`
- `src/core/ingestion/graph-precompute.js`
- `src/core/llm/ollama.js`
- `test/semantic-extraction.test.js`
- `test/idea-catalyst-schema.test.js`

### 0.2 当前已经有的第一版能力

PaperNexus 不是“还没有 domain/mechanism”。当前已经有：

- `fieldOfStudy`
- `fieldCandidates`
- `domainTags`
- `abstractMechanisms`
- `NODE_TYPES.ABSTRACT_MECHANISM`
- `EDGE_TYPES.INSTANTIATES`
- `EDGE_TYPES.IMPLEMENTS`
- `EDGE_TYPES.CONSTRAINS`
- `enrichGraphWithDomainAndMechanismNodes(...)`
- `queryCrossDomainBridges(...)`
- semantic extraction 对 field/domain/mechanism 的第一版支持
- ingestion / graph precompute 对这些元数据的第一版持久化

这说明下一阶段的任务不是“创建这些概念”，而是：

- 稳定 contract
- 强化质量
- 减少 heuristic
- 提高可被上层 workflow 稳定消费的程度

### 0.3 当前尚未真正完成的地方

虽然已有第一版实现，但距离 blueprint 还差很远，主要差在：

1. taxonomy 还未最终定型
2. domain distance 仍是轻量 helper，不是强 contract
3. `AbstractMechanism` 还不是充分成熟的跨域桥接层
4. `queryCrossDomainBridges(...)` 仍偏第一版启发式，不是最终的 bridge-native retrieval
5. 还没有更强的 structural analogy / vector-backed bridge retrieval

### 0.4 当前不要误判的地方

不要把下面这些误认为“完全没做”：

- schema primitive
- extraction metadata
- bridge query helper
- tests for idea-catalyst schema

这些都已经存在。后续计划应写成：

- **在现有实现上补强**

而不是：

- **从零实现**

---

## 1. 目标

把 PaperNexus 从“已经有论文图谱、社区发现、brainstorm 支持”的系统，继续推进到：

**能够为 IDEA-CATALYST 提供稳定的 domain / mechanism / bridge KG primitive 的底层知识图谱平台。**

这份计划只处理 PaperNexus 侧的事情：

- schema
- extraction metadata
- graph primitive
- bridge query
- domain/method/mechanism normalization

不处理：

- workflow 阶段机
- agent/skill orchestration
- write/review/story contract

这些由 `openclaw-research` 负责。

---

## 2. PaperNexus 在整体架构中的职责

### 2.1 应负责

- 提供稳定的 graph schema primitive
- 提供 domain / field / mechanism 元数据承载
- 在 ingestion / extraction 过程中写回这些元数据
- 提供可被上层 workflow 消费的 bridge query / domain-distance / mechanism traversal contract
- 为跨域创新设计提供 graph-native grounding

### 2.2 不应负责

- IDEA 阶段的 owner routing
- catalyst packet 的 workflow 持久化
- requisition 的调度闭环
- paper story / review pressure / write package 的上层合同

### 2.3 当前给 openclaw-research 的实际输出面

PaperNexus 当前实际上已经能为上层提供这些基础字段或结果：

- `fieldOfStudy`
- `fieldCandidates`
- `domainTags`
- `abstractMechanisms`
- `candidateDomains`
- `bridgeNodes`
- `mechanismMatches`

但这些 contract 还不够稳定，因此后续工作重点不是“再多加几个字段”，而是让这些输出：

- 语义更稳定
- 归一化更可靠
- 更适合上层 Scout / Gatekeeper 消费

---

## 2.4 当前代码状态快照

### `src/core/graph/schema.js`

已经有：

- `NODE_TYPES.DOMAIN`
- `NODE_TYPES.ABSTRACT_MECHANISM`
- `EDGE_TYPES.BELONGS_TO_DOMAIN`
- `EDGE_TYPES.STUDIED_IN`
- `EDGE_TYPES.ORIGINATED_IN`
- `EDGE_TYPES.INSTANTIATES`
- `EDGE_TYPES.IMPLEMENTS`
- `EDGE_TYPES.CONSTRAINS`

因此 schema 的第一阶段不是空白。

### `src/core/graph/domain-taxonomy.js`

已经承担：

- domain normalization
- field/domain 标准化
- 基础 distance helper

后续应重点强化其 contract 与可替换性。

### `src/core/graph/abstract-mechanisms.js`

已经承担：

- mechanism name normalization
- abstract mechanism node 构建

后续应重点强化：

- canonicalization
- type/category
- supporting evidence / provenance

### `src/core/graph/domain-bridges.js`

已经承担：

- domain/mechanism enrichment
- graph 中 domain node 与 mechanism node 的连接
- `queryCrossDomainBridges(...)`

后续应重点强化：

- source-domain pruning
- domain relevance policy
- mechanism-level evidence quality
- target-domain exclusion 的稳定性

### `src/core/llm/ollama.js`

已经承担：

- field/domain/mechanism 元数据的 extraction prompt 与结果清洗

后续应重点强化：

- extraction 质量
- normalization 稳定性
- 对旧数据的兼容

### `src/core/ingestion/pipeline.js` / `src/core/ingestion/graph-precompute.js`

已经承担：

- semantic extraction metadata 合并
- graph precompute 中的字段保留
- enrich graph with domain/mechanism nodes

后续应重点强化：

- merge 策略
- retroactive enhancement / backfill
- 对现有图的低风险升级

---

## 3. 当前已具备的基础

PaperNexus 当前已经有：

- 论文级图谱存储与语义提取
- Problem / Method / Claim / Limitation / Finding 等节点类型
- 关系边和 brainstorm/community 工具
- wrapper 与 query 基础设施
- 一定程度的 graph-driven brainstorm 能力

当前最大的问题不是“完全没有图”，而是：

- 缺少 domain 层
- 缺少 abstract mechanism 层
- 缺少稳定的 bridge-first 查询 contract
- 缺少真正可支撑 IDEA-CATALYST 的跨域结构化对齐能力

### 3.1 当前已有测试覆盖

至少已有这些测试：

- `test/semantic-extraction.test.js`
- `test/idea-catalyst-schema.test.js`

它们已经覆盖了：

- schema primitive 是否暴露
- extraction 是否保留 field/domain/mechanism
- graph precompute 是否保留 metadata
- bridge query 是否能返回 candidate domain / mechanism match

因此下一步开发应优先扩这些测试，而不是另起一套全新的测试口径。

---

## 4. 总体实施策略

### 4.1 原则

1. **先 schema primitive，后高级 agent**
   - 先补图谱 primitive
   - 再让上层 workflow 消费这些 primitive
2. **保持向后兼容**
   - 不能破坏现有 graph API 和 ingestion merge 行为
3. **把 metadata 变成正式 contract**
   - 不能只停留在 prompt 或弱字段里
4. **先可解释 contract，再追求复杂检索**
   - 先稳定 domain / mechanism / bridge helper
   - 再继续做更强 structural analogy / vector bridge

### 4.2 推荐优先级

- **P0：** domain / field / taxonomy / distance
- **P1：** abstract mechanism layer
- **P2：** bridge query / source-domain matchmaking primitive
- **P3：** 更强的 structural analogy 与 vector-backed retrieval

---

## 5. Task A：确定并实现 domain / field 基础层

### 5.1 目标

让图谱第一次真正具备“学科/领域”这一层正式语义。

### 5.2 需要完成的能力

1. 为 `Paper`、`Problem`、`Method` 等实体引入 domain/field 表示
2. 提供 domain normalization helper
3. 提供 field candidate / canonical field 的稳定 contract
4. 提供上层可消费的 domain list / domain tags

### 5.3 文件建议

- `src/core/graph/schema.js`
- `src/core/graph/domain-taxonomy.js`
- `src/core/ingestion/pipeline.js`
- `src/core/llm/ollama.js`
- `test/semantic-extraction.test.js`
- `test/idea-catalyst-schema.test.js`

### 5.4 关键设计点

- taxonomy 不要在第一版写死到不可替换
- contract 先支持：
  - `fieldOfStudy`
  - `fieldCandidates`
  - `domainTags`
- 如果将来要换 taxonomy，尽量只改 taxonomy module，不改全图

### 5.4.1 当前真实状态

这里不是“新增一个 domain 层”这么简单，因为第一版已经存在。下一步要做的是：

- 统一 canonical field 表示
- 明确外部 contract
- 明确 taxonomy 来源是否可替换

也就是说，**重点是稳定与收口，而不是再随意新增字段。**

### 5.4.2 建议先补的内容

1. 把 `fieldOfStudy / fieldCandidates / domainTags` 的语义边界写清楚
2. 确定 canonical field 的计算规则
3. 在测试里增加“同一论文多来源 metadata 冲突时如何归一”的场景

### 5.5 完成标准

- ingestion 后图中稳定可见 domain/field 元数据
- test 能覆盖 extraction 与 merge
- 上层不需要再靠 LLM 猜 source domain

---

## 6. Task B：引入 AbstractMechanism 图层

### 6.1 目标

把“表面问题相似”提升为“底层机制可桥接”。

### 6.2 需要完成的能力

1. 新增 `AbstractMechanism` 语义层
2. 提供 `Problem -> INSTANTIATES -> AbstractMechanism`
3. 提供 `Method -> IMPLEMENTS -> AbstractMechanism`
4. 提供 `Limitation -> CONSTRAINS -> AbstractMechanism`
5. 为 mechanism description、mechanism type 提供标准化结构

### 6.3 文件建议

- `src/core/graph/schema.js`
- `src/core/graph/abstract-mechanisms.js`
- `src/core/llm/ollama.js`
- `src/core/ingestion/pipeline.js`
- `test/idea-catalyst-schema.test.js`

### 6.4 关键设计点

- mechanism 不能只是 free-form 标签
- 至少要有：
  - canonical id
  - description
  - type/category
  - supporting source nodes

### 6.4.1 当前真实状态

当前 `abstract-mechanisms.js` 已经有 node builder 与 normalize helper，但还不够像“真正的中间语义层”。
下一步重点不是把文件建出来，而是：

- 提高 canonicalization 稳定性
- 明确 mechanism type
- 增加 provenance / support
- 减少不同论文里同一机制被分裂成多个近义节点

### 6.5 完成标准

- 图中可以通过 mechanism 连接跨域问题/方法
- Scout 不再只能靠自然语言相似性

---

## 7. Task C：提供稳定的 domain distance 与 bridge query contract

### 7.1 目标

给上层一个稳定的“跨域选择”基础，而不是让 LLM 直接猜。

### 7.2 需要完成的能力

1. domain distance helper
2. target-domain exclusion
3. source-domain ranking primitive
4. bridge candidate query contract
5. domain-level relevance / pruning signal

### 7.3 文件建议

- `src/core/graph/domain-taxonomy.js`
- `src/core/graph/domain-bridges.js`
- 可能新增：
  - `src/core/graph/domain-distance.js`
  - `src/core/graph/bridge-queries.js`
- `test/idea-catalyst-schema.test.js`

### 7.4 关键设计点

- 不要求第一版就是最终最优算法
- 但必须先稳定 contract，例如：
  - `targetDomain`
  - `candidateSourceDomains`
  - `distanceScore`
  - `bridgeEvidence`
  - `relevanceRatio`
  - `pruned`

### 7.4.1 当前真实状态

`queryCrossDomainBridges(...)` 已经存在，但它更像第一版启发式 helper。
下一步不宜直接推倒，而应：

1. 保持已有返回结构兼容
2. 在其基础上补：
   - 更稳定的 source-domain ranking
   - 更清晰的 relevance/pruning 理由
   - 更可靠的 mechanism evidence
3. 让上层可以安全消费，而不是每次都猜字段含义

### 7.5 完成标准

- Scout 可以调用 bridge query，而不是自由提示挑领域
- domain pruning 可解释，可测试

---

## 8. Task D：把 semantic extraction 与 ingestion merge 正式接到新 primitive

### 8.1 目标

让新图层不是只存在于 schema，而是在真实导入中被填充。

### 8.2 需要完成的能力

1. semantic extraction prompt 支持 field/domain/mechanism
2. merge 路径支持这些 metadata 的持久化
3. 既支持新论文，也支持旧图增量增强

### 8.3 文件建议

- `src/core/llm/ollama.js`
- `src/core/ingestion/pipeline.js`
- 可能涉及：
  - `scripts/` 下已有导入工具
  - retroactive backfill helper

### 8.4 完成标准

- 新导入论文自动带出 domain/mechanism 元数据
- 旧论文可以通过 enhancement/backfill 被补齐

### 8.4.1 当前真实状态

`ollama.js`、`pipeline.js`、`graph-precompute.js` 已经接了第一版 metadata 流。
因此后续重点是：

- 提升提取质量
- 提升 merge 一致性
- 设计 backfill/enhancement 路径

而不是重新设计一套完全不同的 extraction interface。

---

## 9. Task E：提供 catalyst-oriented query / API adapter

### 9.1 目标

为 `openclaw-research` 的 Scout / Gatekeeper 提供稳定的消费接口。

### 9.2 需要完成的能力

1. bridge query adapter
2. mechanism traversal adapter
3. domain-ranked scouting query
4. requisition-friendly coverage query

### 9.3 文件建议

- `scripts/` 下的 query 工具
- `src/core/graph/domain-bridges.js`
- 可能新增 catalyst-oriented helper module
- 现有 CLI / query 输出 contract

### 9.4 完成标准

- `openclaw-research` 不必了解 PaperNexus 内部细节
- 只需消费明确的 query result contract

### 9.4.1 推荐的接口思路

为了让上层 workflow 稳定，建议把 adapter 输出收口为一个更明确的 contract，例如：

- `targetDomain`
- `abstractChallenge`
- `candidateDomains`
- `bridgeNodes`
- `mechanismMatches`
- `relevancePolicy`
- `prunedDomains`
- `contractVersion`

如果后面要升级算法，也尽量保持这个 contract 不大改。

---

## 10. Task F：为 IDEA-CATALYST 的强版本预留高级能力

### 10.1 目标

在基础 contract 稳定后，再逐步补更高级的跨域结构发现能力。

### 10.2 后续方向

1. vector-backed bridge retrieval
2. structural analogy detection
3. subgraph isomorphism / motif matching
4. mechanism-level community / bridge analysis

### 10.3 说明

这部分不建议在第一阶段就压进去，否则会拖慢主合同稳定化。

---

## 11. 推荐执行顺序

1. **Task A**：domain / field 基础层
2. **Task B**：AbstractMechanism 图层
3. **Task C**：domain distance + bridge query contract
4. **Task D**：semantic extraction / ingestion merge 接线
5. **Task E**：catalyst-oriented query adapter
6. **Task F**：更高阶 structural analogy / vector retrieval

---

## 12. 验证建议

每完成一个任务后，至少运行对应最小测试：

- schema / extraction：
  - `node --test test/semantic-extraction.test.js test/idea-catalyst-schema.test.js`
- pipeline / merge：
  - 运行 ingestion / pipeline 定向测试
- 最终：
  - 项目 build /现有回归测试

完成 Task C 之后，建议补一条明确的契约测试：

- 给定 target domain + abstract challenge
- 返回跨域 source domain 候选、distance、bridge evidence、prune signal

### 12.1 当前建议的最小回归组合

如果只是继续补强现有第一版实现，建议至少跑：

- `node --test test/semantic-extraction.test.js test/idea-catalyst-schema.test.js`

如果改动触及 ingestion / graph precompute：

- 再补对应 pipeline / graph 定向测试

### 12.2 推荐给接手 agent 的工作方式

建议接手 agent 按以下顺序工作：

1. 先读：
   - `IDEA_CATALYST_MultiAgent_Blueprint.md`
   - 当前这份 plan
2. 再看：
   - `src/core/graph/schema.js`
   - `src/core/graph/domain-taxonomy.js`
   - `src/core/graph/abstract-mechanisms.js`
   - `src/core/graph/domain-bridges.js`
   - `src/core/llm/ollama.js`
   - `src/core/ingestion/pipeline.js`
3. 再读测试：
   - `test/semantic-extraction.test.js`
   - `test/idea-catalyst-schema.test.js`
4. 先扩测试，再补强实现
5. 优先在现有模块上增强，不要平行新增另一套 schema/helper

---

## 13. 一句话总结

PaperNexus 下一阶段最重要的不是再堆更多 prompt，而是：

**把 domain、mechanism、bridge 这三层真正做成稳定的图谱 primitive，让上层 workflow 的 IDEA-CATALYST 可以建立在知识图谱能力之上，而不是建立在 LLM 猜测之上。**
