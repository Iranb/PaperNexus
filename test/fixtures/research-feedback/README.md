# Research feedback fixtures

`measured/` contains copied historical FSGCD analysis artifacts. `source-map.json` preserves their original locations and source versions. The complete and sampled arms are one matched pair at seed 0. Accuracy is percent; differences are percentage points. Image bootstrap intervals condition on the trained models. They do not estimate training-seed uncertainty. The ongoing triplet restoration result is excluded from this time cut.

`scenarios.js` creates **synthetic** reference artifacts, intervals and interventions for contract tests. In particular, restoration to NEW=40.620653319283456 and the resulting +1 pp versus control are a counterfactual fixture, not an observed experiment.

The engineering replay reads measured inputs through a local HTTP MCP service. Historical GPU cost is recorded only in its isolated project. It does not launch training or claim that graph structure improves research outcomes. `prepare-ablation` exports equivalent facts as text, structured records and source-linked relationships for a separate controlled evaluation.
