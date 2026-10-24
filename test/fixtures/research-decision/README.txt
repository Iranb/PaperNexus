Research decision fixtures (synthetic only)

Visibility: registration sees scenarioInputs, source files and candidate priorities.
OUTCOMES are revealed only through record_run after an action is selected.
The service must never receive expected decisions or unrevealed outcomes.

GCD case: quality filtering (Hq) predicts a matched-count effect >= 1 point.
Count-only (Hn) predicts an effect in [-0.5, 0.5]. Both predict that headline
accuracy can improve. E0 cannot distinguish them; E1 can. E2 requires support
for Hq. E3 replicates Hn after support; E4 improves precision after E1.
Negative control: effect 0.1, interval [-0.2, 0.4], valid implementation,
prespecified fixed analysis and externally reviewed synthetic interval.
Expected: Hq excluded only in its scope, Hn relatively supported, E3 next.
Cost: 1.2 of 6 fixture-GPU hours, leaving 4.8. Replays add no cost.
Wide interval: [-1.5, 1.6], both inconclusive; E4 is the precision follow-up.
Unexplained: [0.6, 0.8], neither explanation matches; retain unmodeled causes.

Retrieval case: relevance reranking versus retrieved-count effects. It uses
its own dataset and recall quantity with the same decision structure.
No GCD identifiers appear in the production decision policy.

Candidate-priority baseline: selects the action linked to the greatest
provided controller utility. These are frozen fixture priorities, not
measured controller performance or real research success probabilities.
The baseline and decision policy receive identical visible plans and costs.

Acceptance: A01/A10 opportunities, A02 contracts, A03/A09/A11 policy and
budget, A04-A08/A16/A18 assessment/protocol, A12 store, A13 MCP, A14 reflection,
A15 retrieval, A17 live dependency invalidation. Test files carry these IDs.
All source, measurement, review and cost numbers are invented fixture data.
