export const RESEARCH_QUALITY_CONTRACT = [
  'Evidence and meaning contract for every research object and relation:',
  '- evidenceText must be a verbatim source passage, including the words that determine ownership, negation, uncertainty and comparison scope. Do not replace it with an object name, paraphrase, or ellipsis joining separate results. Use supportingSnippets for separate passages, with sectionHeading and sectionRole.',
  '- Add attribution: {"subject":"the named method or claim owner","role":"proposed|baseline|prior-work|experiment"}. A baseline assumption discussed or rejected by this paper is not an assumption made by the proposed method. Identify the owner in the object name too.',
  '- Add epistemicStatus: "asserted", "observed", "hypothesis", "refuted", or "uncertain". Preserve qualifications such as possibly in the name/text. explicitOrInferred describes whether the paper states something; it does not make an author hypothesis a proven explanation.',
  '- Keep negative ablations, limitations and null results. A tested component that does not help is an experiment finding, not evidence of adoption by the final method.',
  '- For each numerical observation, add experimentContext with only source-supported fields: {"dataset":"...","taskSplit":"...","backbone":"...","pretraining":"...","memoryBudget":"...","metric":"...","value":0,"unit":"...","baseline":"...","comparison":"...","variant":"...","sourceLocation":"table/section/..."}. Missing conditions stay absent. Separate results with different baselines, variants or protocols into separate records, and include the differing conditions in their names.',
  '- Example: an additional 15% gain from a scheduler and a 30% gain over baseline B are two observations with different comparisons. Do not label both as extra gains from the scheduler.',
  '- Research questions and open challenges also need evidenceText and source section. Reusable or domain-agnostic wording is an interpretation of that evidence, not a new source quote.',
  '- Return abstractMechanismObjects as structured records with name, description, evidenceText and source section. The description explains what is operated on, how it changes, and the relevant conditions. Do not repeat a topic name as its description. Use canonical names and aliases for the same mechanism.',
  '- Merge repeated objects only when they express the same content under the same owner and experiment conditions. Preserve distinct experiments and incompatible claims.',
  '- Treat heuristicCandidates/candidateEntities as search hints. Only the paper text supports extracted facts. Do not copy unsupported hints or fabricate missing fields.'
];

export const METHOD_RELATION_CONTRACT = [
  'Method relation contract:',
  '- Add relationContext: "method", "ablation", "comparison", "hypothesis", or "background". Use method for a component or predecessor actually adopted by the method being described.',
  '- USES_COMPONENT_METHOD is whole method -> adopted component; COMPONENT_OF is component -> whole method. Check the source and target names against the quoted sentence.',
  '- Do not emit USES, USES_COMPONENT_METHOD, COMPONENT_OF, EXTENDS_METHOD, IMPROVES_METHOD, REPLACES_METHOD or ADAPTS_METHOD solely because two methods are compared, a component is tested in an ablation, or transfer is proposed hypothetically. Record the experiment in findings instead.',
  '- Example: adding a predictor to method B reduced accuracy and did not help. Keep that negative finding; do not infer that B adopts the predictor, and never reverse the edge into predictor -> B for USES_COMPONENT_METHOD.'
];
