# 图谱查询前已有分析

依据本次查询前已存在的 `papernexus_fsgcd_v1/REPORT.md`、`MECHANISM_REVIEW.json` 与 `research/optimization_review.md`。这些原始资料保持不变。

相同 CUB 划分、初始化和 200 个 epoch 样本顺序下，complete 相对 sampled：NEW −3.4422 pp、OLD +7.0833 pp、ALL −3.0165 pp；迁移伪标签平均精度 +11.2474 pp。只有一个配对 seed。

已知内容：

- 早期优化综述已经引用 SimGCD §3.3–§3.4、§5.3–§5.4，并建议区分伪标签可靠性、old/new prediction bias 与优化动态。SimGCD 和“类别偏置”不是本次图谱带来的新发现。
- 正确 known 伪标签平均数量增加；novel 被误标为 known 的平均数量基本不变（48.850 → 48.655）。
- `train.py` 的 `pseudo_mask` 同时改变 SupCon 监督成员和 triplet 参与成员。这是代码路径事实，尚无因果干预证据。
- complete 的峰值后 NEW 下降更大；独立 heldout 聚类也下降。
- 已有候选后续实验：保留 complete 候选池和伪标签监督，只恢复伪标签样本的 triplet 参与。这个想法在本次图谱检索前已经存在。

本轮实际新增项是：通过图谱定位可追溯的错误定义，把上述竞争解释落实为四类错误的实测分解，再用不依赖 Hungarian 映射的聚类指标检查结果，形成更具体的后续诊断优先级。未设置“图谱 vs 直接阅读相同论文”的随机对照，因此不能声称图谱结构本身产生了独立增益。
