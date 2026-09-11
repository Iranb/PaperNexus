export const PAPERNEXUS_PROMPTS = [
  {
    name: 'survey_literature',
    description: 'Read corpus metadata, search a topic, and map problems, methods, claims, limitations, datasets, and evidence.'
  },
  {
    name: 'trace_claim',
    description: 'Trace which evidence, datasets, metrics, and limitations support or constrain a specific claim across the corpus.'
  },
  {
    name: 'generate_research_ideas',
    description: 'Generate research directions from limitation reversal, method transfer, and evidence-gap patterns.'
  },
  {
    name: 'brainstorm_topic',
    description: 'Run a diverge/converge brainstorming workflow over the multilayer graph for topic selection and innovation design.'
  }
];

const RESEARCH_PROMPT_STEPS = {
  survey_literature: [
    '1. Call literature_review with operation=corpora when the corpus is unknown.',
    '2. Call literature_review/search for committed papers, paper for source reading, and survey to group the evidence.',
    '3. If coverage is insufficient, explicitly call literature_review/discover, then discovery_status and discovery_report with the returned runId.',
    '4. Import only when requested, using literature_review/import; follow import_status by jobId/taskId and verify authoritative synchronization before treating discovered papers as graph evidence.',
    '5. Summarize source-backed findings and coverage limits; use lineage_analysis for evolution.'
  ],
  trace_claim: [
    '1. Call literature_review/search to find the claim and paper anchors.',
    '2. Use lineage_analysis/context and impact to inspect supporting and downstream graph connections.',
    '3. Use lineage_analysis/evidence for exact method-edge quotes or path for a connection between two anchors.',
    '4. Distinguish source evidence from graph connectivity; a path alone is not causal support.'
  ],
  generate_research_ideas: [
    '1. Use literature_review/survey and lineage_analysis/overview to inspect existing evidence.',
    '2. Call idea_generation/gaps to identify bounded structural opportunities.',
    '3. Call idea_generation/generate with query; add targetDomain for cross-domain catalyst candidates.',
    '4. Call idea_generation/evaluate with query and a concrete candidateMechanism; inspect novelty and evidence sufficiency limits.',
    '5. Use idea_generation/experiment_materials for experiment anchors and costs. Present hypotheses and required validation, not proven novelty or gains.'
  ],
  brainstorm_topic: [
    '1. Inspect literature_review/search and lineage_analysis/overview for the target topic.',
    '2. Call idea_generation with operation=diverge to explore graph-grounded possibilities.',
    '3. Inspect lineage_analysis/context or evidence for the strongest anchors.',
    '4. Call idea_generation with operation=converge, then evaluate a concrete candidateMechanism.',
    '5. Report supporting papers, coverage limits, and validation gaps.'
  ]
};

export function getPrompt(name, options = {}) {
  if (options.toolProfile !== 'legacy' && Object.hasOwn(RESEARCH_PROMPT_STEPS, name)) {
    return {
      description: name === 'brainstorm_topic'
        ? 'A workflow for divergent exploration followed by convergent topic selection.'
        : PAPERNEXUS_PROMPTS.find((prompt) => prompt.name === name).description,
      messages: [{ role: 'user', content: { type: 'text', text: RESEARCH_PROMPT_STEPS[name].join('\n') } }]
    };
  }
  if (name === 'survey_literature') {
    return {
      description: 'A lightweight workflow for corpus-level literature review.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              '1. Call list_corpora to discover available corpora.',
              '2. Read papernexus://corpus/{name}/context for the target corpus.',
              '3. Use query to find relevant problems, methods, limitations, datasets, and claims for the topic.',
              '4. Use context and impact on the strongest problems, claims, methods, and limitation hubs.',
              '5. Summarize methods, assumptions, evidence setup, and cross-paper links.'
            ].join('\n')
          }
        }
      ]
    };
  }

  if (name === 'trace_claim') {
    return {
      description: 'A workflow for evidence tracing.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              '1. Use query with the claim or key phrase.',
              '2. Inspect context for candidate claim, evidence, dataset, metric, and limitation nodes.',
              '3. Use impact upstream to see what supports the claim and downstream to see what it informs.',
              '4. Summarize supporting and conflicting evidence by paper, method, and evaluation setting.'
            ].join('\n')
          }
        }
      ]
    };
  }

  if (name === 'generate_research_ideas') {
    return {
      description: 'A workflow for research topic selection and innovation hypothesis generation.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              '1. Use query to find the main problems, methods, claims, and limitations related to the topic.',
              '2. Use context on the strongest problems and limitations to inspect assumptions, evidence, and future directions.',
              '3. Call ideas with the target topic.',
              '4. Compare the returned opportunities by novelty, feasibility, evidence, risk, and cost.',
              '5. Output the top directions together with the supporting papers and the main validation gap.'
            ].join('\n')
          }
        }
      ]
    };
  }

  if (name === 'brainstorm_topic') {
    return {
      description: 'A workflow for divergent exploration followed by convergent topic selection.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              '1. Use query to identify the main papers, problems, and methods around the topic.',
              '2. Call brainstorm with mode diverge to surface similar problems, related concepts, transferable methods, combinable methods, and potential constraints.',
              '3. Inspect context or impact for the strongest constraint and method candidates if the graph looks noisy.',
              '4. Call brainstorm with mode converge on the same topic.',
              '5. Summarize the top converged directions with their focus terms, supporting papers, and the main validation or evidence gap.'
            ].join('\n')
          }
        }
      ]
    };
  }

  throw new Error(`Unknown prompt: ${name}`);
}
