# 实验反馈图谱工程验收

日期：2026-10-25。分支：`codex/experiment-aware-graph`。基线：`ea70833973108a485581cd44030faa14abd0b162`。

M0—M6 工程验收通过。项目实测可以从 `research_decision/evidence_view` 查询，并进入带 `project` 的 `idea_generation/generate`。比较、任务判定、机制证据、来源就绪与精度要求使用同一份项目决策状态。

## 交付行为

- 只读项目证据视图返回运行、预测、评估、机制引用、来源有效性及预算；显式绑定的候选使用实验反馈。
- 同一运行保留 original/control/paper 比较身份；部分恢复、指标取舍与范围内改进分别判定。
- `evaluate` 保留默认新颖性审查，新增 `mechanism_diagnosis` 和 `performance_validation`。设计就绪不授予执行权限。
- 代码观察、实测关联和预测路径分开表达；复合干预不自动得到单一机制归因。
- 来源可读但缺语义节点时返回 `source_only` 和具体补齐步骤；不自动导入。
- 下一步推荐使用有来源的预期精度和推断范围；精度未知时可选择诊断、请求信息或有预算上限的探索。

## 行为验收映射

下列测试均包含在通过的全量测试中。测试输入分为明确标注的合成案例和保留来源映射的真实历史材料。

| 验收 | 可复核测试 | 验证结果 |
| --- | --- | --- |
| F01 | `test/research-project-evidence.test.js`；`test/research-feedback-replay.test.js` | 重连后按项目检索，已保存结果进入研究重点 |
| F02 | `test/research-project-evidence.test.js`；`test/research-comparisons.test.js` | 新版本使旧评估失效，费用不重复 |
| F03 | `test/research-comparisons.test.js` | 多个比较共享一次物理 attempt |
| F04 | `test/research-comparisons.test.js` | 相对控制恢复、仍低于原始基线时为 partial_recovery |
| F05 | `test/research-comparisons.test.js` | 主指标与 guardrail 相反时保留 tradeoff |
| F06 | `test/research-comparisons.test.js` | 比较身份、数量、单位和协议精确绑定；次要读数不升级为主检验 |
| F07 | `test/research-comparisons.test.js` | 论文来源与协议未验证时不建立论文报告比较 |
| F08 | `test/research-purpose-gates.test.js` | 机制诊断可就绪，同时新颖性仍未建立 |
| F09 | `test/research-mechanism-evidence.test.js` | 词项与 Corpus 归属不充当机制或因果证据 |
| F10 | `test/research-mechanism-evidence.test.js` | 同时改变多个部件时保留 compound_intervention |
| F11 | `test/research-mechanism-evidence.test.js` | source_only 与补齐建议准确，读取无自动导入 |
| F12 | `test/research-feedback-integration.test.js` | 无可达精度依据的完整控制不能获得充分区分力；探索仍有界可用 |
| F13 | `test/research-comparisons.test.js` | 图像区间与相关 epoch 不增加独立训练单位 |
| F14 | `test/research-project-evidence.test.js`；`test/research-feedback-replay.test.js`；既有 store/policy/budget 测试 | 重读和丢失响应恢复不重复写入或计费；pending 运行保持等待/对账 |
| F15 | `test/research-feedback-integration.test.js` | 摘要保留任务判定、比较限制、预算和来源状态，提供只读展开 |
| F16 | `test/research-project-evidence.test.js`；`test/research-purpose-gates.test.js`；既有 MCP/合同测试 | 原 v1 与无项目工作流继续支持，未知副作用拒绝 |
| F17 | `test/research-project-evidence.test.js`；`test/research-comparisons.test.js`；`test/research-mechanism-evidence.test.js` | 来源、参考版本和测量更正使依赖失效，不能以刷新来源重用旧比较 |
| F18 | `test/research-comparisons.test.js` | 非 GCD 指标及 lower-is-better guardrail 使用同一规则 |

另已验证：登记且覆盖的调整分析能得到 `improved_in_scope`；缺少主指标或 guardrail 阈值时设计仍不完整；机制测量引用在运行被替代后失效。

## 运行证据

| 检查 | 结果 | 本地证据 |
| --- | --- | --- |
| `npm test` | 1,098 项；1,096 通过，0 失败，2 跳过；104.35 秒 | `M6/full-test-verified.log` |
| HTTP、stdio、Python 及恢复定向检查 | 16 项通过；包含 `evidence_view` 的真实客户端调用 | `M6/clients-and-recovery.log` |
| `npm run docs:build` | 成功；现有 bundle 大小提示不影响构建 | `M6/docs-build.log` |
| 真实历史 HTTP 回放 | 12/12 检查通过，服务重启后读取仍一致 | `M6/historical-verified/evaluation.json`、`requests.json`、`trace.json`、`report.md` |
| A/B/C 回放材料 | 3 个决策时点、9 份可见输入；标签独立保存 | `M6/ablation-final/evaluation.json` |
| GitNexus 变更范围 | 46 个文件、390 个符号、14 条流程；整体 HIGH，已核对为预期决策/MCP 流程 | `M6/gitnexus-detect-changes.json` |

两项跳过是既有 `PAPERNEXUS_THROUGHPUT_TEST=1` 才启用的吞吐基准。完整历史输入已纳入 `test/fixtures/research-feedback/measured/`，通过 `source-map.json` 标明来源。复现命令：

```sh
node scripts/evaluate-research-feedback.mjs --input test/fixtures/research-feedback/measured --output /tmp/papernexus-feedback-new --mode engineering --seed 17
```

输出目录必须为新目录。中断后使用原参数和 `--resume` 恢复；已完成输出保持不变。

真实历史回放保留 NEW −3.4422 pp、OLD +7.0833 pp、ALL −3.0165 pp（vs matched reproduced baseline）。两个历史 attempt 合计 29.158128 GPU 小时；回放仅核对该账本，不重新消耗历史训练预算。验证 GPU 小时和 provider 调用均为 0，CPU 与耗时由脚本记录。

## 限制与部署交接

未部署远端 41 服务，未修改现有训练或自动跟进。部署前应按仓库现有服务方式读取目标 capabilities/版本，备份将被写入项目的 overlay 和配置，再验证旧项目 status、新 evidence_view 及不带项目的原工作流。

A/B/C 材料已冻结，尚未调用外部模型或完成盲评。因此没有建立图结构独立效用或科研成功率提升。历史案例只有一组配对训练 seed，图像 bootstrap 仅覆盖固定模型范围；paper-report comparison not established。

缺少显式候选身份的既有图候选保持 unlinked。项目研究重点仍可使用有效实测，不能凭标题相似度补造关联。
