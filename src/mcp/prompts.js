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

export function getPrompt(name) {
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
