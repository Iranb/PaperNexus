import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateRetrievalResults,
  loadRetrievalBenchmark,
  renderRetrievalBenchmarkReport,
  runRetrievalBenchmark
} from '../src/core/benchmarks/retrieval.js';

async function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-retrieval-benchmark-'));
}

test('custom retrieval benchmark runs discovery and computes macro metrics', async () => {
  const tempDir = await createTempDir();
  const benchmarkPath = path.join(tempDir, 'custom.json');

  try {
    await fs.writeFile(benchmarkPath, `${JSON.stringify({
      queries: [
        {
          id: 'q1',
          query: 'graph augmented literature mapping',
          relevant: [{ title: 'Graph-Augmented Literature Mapping', doi: '10.1234/graph.map' }]
        },
        {
          id: 'q2',
          query: 'retrieval augmented experiment planning',
          relevant: [{ title: 'Retrieval-Augmented Experiment Planning', arxivId: '2401.01234' }]
        }
      ]
    }, null, 2)}\n`);

    const report = await runRetrievalBenchmark({
      datasetPath: benchmarkPath,
      rootPath: tempDir,
      cutoffs: [1, 2],
      runDiscovery: async ({ topic }) => {
        if (topic.includes('graph augmented')) {
          return {
            runId: 'run-q1',
            candidates: [
              { title: 'Unrelated Search Result' },
              { title: 'Graph-Augmented Literature Mapping', identifiers: { doi: '10.1234/graph.map' } }
            ]
          };
        }
        return {
          runId: 'run-q2',
          candidates: [
            { title: 'Retrieval-Augmented Experiment Planning', identifiers: { arxivId: '2401.01234' } },
            { title: 'Another Result' }
          ]
        };
      }
    });

    assert.equal(report.benchmark.evaluatedQueries, 2);
    assert.equal(report.metrics['hit@1'], 0.5);
    assert.equal(report.metrics['recall@1'], 0.5);
    assert.equal(report.metrics['recall@2'], 1);
    assert.equal(report.results[0].firstRelevantRank, 2);
    assert.equal(report.results[1].firstRelevantRank, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('BEIR-style corpus, queries, and qrels load into benchmark cases', async () => {
  const tempDir = await createTempDir();
  const qrelsDir = path.join(tempDir, 'qrels');

  try {
    await fs.mkdir(qrelsDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, 'corpus.jsonl'), [
      JSON.stringify({ _id: 'd1', title: 'Scientific Fact Checking', text: 'Evidence retrieval benchmark.' }),
      JSON.stringify({ _id: 'd2', title: 'Neural IR Systems', text: 'Dense retrieval methods.' })
    ].join('\n'));
    await fs.writeFile(path.join(tempDir, 'queries.jsonl'), [
      JSON.stringify({ _id: 'q1', text: 'scientific fact verification retrieval' }),
      JSON.stringify({ _id: 'q2', text: 'neural information retrieval systems' })
    ].join('\n'));
    await fs.writeFile(path.join(qrelsDir, 'test.tsv'), [
      'query-id\tcorpus-id\tscore',
      'q1\td1\t1',
      'q2\td2\t1'
    ].join('\n'));

    const benchmark = await loadRetrievalBenchmark(tempDir, { format: 'beir' });

    assert.equal(benchmark.format, 'beir');
    assert.equal(benchmark.queryCount, 2);
    assert.equal(benchmark.queries[0].query, 'scientific fact verification retrieval');
    assert.equal(benchmark.queries[0].relevant[0].title, 'Scientific Fact Checking');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('LitSearch-style exported query and corpus files resolve corpus id gold labels', async () => {
  const tempDir = await createTempDir();

  try {
    await fs.writeFile(path.join(tempDir, 'corpus_clean.jsonl'), [
      JSON.stringify({ corpusid: '100', title: 'LitSearch: A Retrieval Benchmark for Scientific Literature Search' }),
      JSON.stringify({ corpusid: '101', title: 'Other Paper' })
    ].join('\n'));
    await fs.writeFile(path.join(tempDir, 'query.jsonl'), [
      JSON.stringify({
        id: 'ls1',
        query: 'benchmark for scientific literature search',
        corpusids: ['100']
      })
    ].join('\n'));

    const benchmark = await loadRetrievalBenchmark(tempDir, { format: 'litsearch' });

    assert.equal(benchmark.format, 'litsearch');
    assert.equal(benchmark.queryCount, 1);
    assert.equal(benchmark.queries[0].relevant[0].title, 'LitSearch: A Retrieval Benchmark for Scientific Literature Search');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('BioASQ official question JSON maps PubMed documents to retrieval cases', async () => {
  const tempDir = await createTempDir();
  const benchmarkPath = path.join(tempDir, 'bioasq.json');

  try {
    await fs.writeFile(benchmarkPath, `${JSON.stringify({
      questions: [{
        id: 'bio1',
        body: 'Which drugs treat EGFR mutant lung cancer?',
        type: 'factoid',
        documents: ['http://www.ncbi.nlm.nih.gov/pubmed/22853635']
      }]
    })}\n`);

    const benchmark = await loadRetrievalBenchmark(benchmarkPath, { format: 'bioasq' });

    assert.equal(benchmark.format, 'bioasq');
    assert.equal(benchmark.queries[0].metadata.taskType, 'biomedical_qa_retrieval');
    assert.equal(benchmark.queries[0].relevant[0].identifiers.pmid, '22853635');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('TREC topics and qrels load without requiring BEIR conversion', async () => {
  const tempDir = await createTempDir();

  try {
    await fs.writeFile(path.join(tempDir, 'topics.xml'), [
      '<topics>',
      '  <topic number="1">',
      '    <disease>melanoma</disease>',
      '    <gene>BRAF</gene>',
      '    <demographic>adult</demographic>',
      '  </topic>',
      '</topics>'
    ].join('\n'));
    await fs.writeFile(path.join(tempDir, 'qrels.txt'), '1 0 12345678 2\n');

    const benchmark = await loadRetrievalBenchmark(tempDir, { format: 'trec' });

    assert.equal(benchmark.format, 'trec');
    assert.match(benchmark.queries[0].query, /melanoma/);
    assert.equal(benchmark.queries[0].relevant[0].relevance, 2);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('CSFCube annotations become faceted query-by-example cases', async () => {
  const tempDir = await createTempDir();

  try {
    await fs.writeFile(path.join(tempDir, 'corpus.jsonl'), [
      JSON.stringify({ id: 'q-paper', title: 'Neural ranking for scientific papers', abstract: 'Search models for papers.' }),
      JSON.stringify({ id: 'rel-paper', title: 'Facet aware scientific paper retrieval', abstract: 'Methods for ranking.' })
    ].join('\n'));
    await fs.writeFile(path.join(tempDir, 'pid2anns.json'), `${JSON.stringify({
      'q-paper': {
        method: { 'rel-paper': 3 }
      }
    })}\n`);

    const benchmark = await loadRetrievalBenchmark(tempDir, { format: 'csfcube' });

    assert.equal(benchmark.format, 'csfcube');
    assert.equal(benchmark.queries[0].metadata.facet, 'method');
    assert.equal(benchmark.queries[0].relevant[0].relevance, 3);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('CSFCube official split facet files are loaded together', async () => {
  const tempDir = await createTempDir();

  try {
    await fs.writeFile(path.join(tempDir, 'abstracts-csfcube-preds.jsonl'), [
      JSON.stringify({ paper_id: 'q-paper', title: 'Neural ranking for scientific papers', abstract: 'Search models for papers.' }),
      JSON.stringify({ paper_id: 'bg-paper', title: 'Background aware retrieval', abstract: 'Background framing.' }),
      JSON.stringify({ paper_id: 'method-paper', title: 'Facet aware scientific paper retrieval', abstract: 'Methods for ranking.' }),
      JSON.stringify({ paper_id: 'result-paper', title: 'Evaluation results for retrieval', abstract: 'Results and findings.' })
    ].join('\n'));
    await fs.writeFile(path.join(tempDir, 'test-pid2anns-csfcube-background.json'), `${JSON.stringify({
      'q-paper': { 'bg-paper': 1 }
    })}\n`);
    await fs.writeFile(path.join(tempDir, 'test-pid2anns-csfcube-method.json'), `${JSON.stringify({
      'q-paper': { 'method-paper': 3 }
    })}\n`);
    await fs.writeFile(path.join(tempDir, 'test-pid2anns-csfcube-result.json'), `${JSON.stringify({
      'q-paper': { 'result-paper': 2 }
    })}\n`);

    const benchmark = await loadRetrievalBenchmark(tempDir, { format: 'csfcube' });
    assert.equal(benchmark.queryCount, 3);
    assert.deepEqual(benchmark.queries.map((query) => query.metadata.facet).sort(), ['background', 'method', 'result']);
    assert.equal(benchmark.queries.find((query) => query.metadata.facet === 'method').relevant[0].title, 'Facet aware scientific paper retrieval');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SAGE-style flexible schema loads query, corpus, and weighted gold ids', async () => {
  const tempDir = await createTempDir();

  try {
    await fs.writeFile(path.join(tempDir, 'corpus.jsonl'), [
      JSON.stringify({ id: 'd1', title: 'Agentic scientific search', abstract: 'Deep research retrieval.' }),
      JSON.stringify({ id: 'd2', title: 'Other paper' })
    ].join('\n'));
    await fs.writeFile(path.join(tempDir, 'queries.jsonl'), [
      JSON.stringify({
        id: 'sage1',
        question: 'Which paper studies agentic scientific search?',
        relevant: [{ id: 'd1', title: 'Agentic scientific search', relevance: 2 }]
      })
    ].join('\n'));

    const benchmark = await loadRetrievalBenchmark(tempDir, { format: 'sage' });

    assert.equal(benchmark.format, 'sage');
    assert.equal(benchmark.corpusSize, 2);
    assert.equal(benchmark.queries[0].metadata.taskType, 'agentic_literature_retrieval');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SAGE official short-form and open-ended directories load graded gold papers', async () => {
  const tempDir = await createTempDir();

  try {
    await fs.mkdir(path.join(tempDir, 'Sage_Short_Form_Questions'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'Sage_Open_Ended_Questions'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'Sage_Short_Form_Questions', 'computer_science.json'), `${JSON.stringify([{
      paper_id: 'sage-short-1',
      paper_title: 'Round-Table Conference Improves Reasoning',
      complete_query: 'Find me the paper whose title ends with LLMs and shares reasoning citations.',
      ground_truth: {
        paperId: 'sage-short-1',
        title: 'Round-Table Conference Improves Reasoning'
      }
    }], null, 2)}\n`);
    await fs.writeFile(path.join(tempDir, 'Sage_Open_Ended_Questions', 'computer_science.json'), `${JSON.stringify({
      questions: [{
        question: 'Which papers explain temporal coherence limits in diffusion video generation?',
        source_paper_id: 'sage-open-source',
        cited_paper_id: 'sage-open-cited',
        ground_truth: {
          most_relevant: [
            { paperId: 'sage-open-source', title: 'ControlVideo' },
            { paperId: 'sage-open-cited', title: 'AnimateDiff' }
          ],
          relevant: [
            { paperId: 'sage-open-background', title: 'Denoising Diffusion Probabilistic Models' }
          ]
        }
      }]
    }, null, 2)}\n`);

    const benchmark = await loadRetrievalBenchmark(tempDir, { format: 'sage' });
    assert.equal(benchmark.queryCount, 2);
    const shortCase = benchmark.queries.find((query) => query.id === 'sage-short-1');
    const openCase = benchmark.queries.find((query) => query.metadata.taskType === 'open_ended_paper_recommendation');
    assert.equal(shortCase.query, 'Find me the paper whose title ends with LLMs and shares reasoning citations.');
    assert.equal(shortCase.metadata.taskType, 'short_form_paper_finding');
    assert.equal(shortCase.relevant[0].id, 'sage-short-1');
    assert.equal(openCase.relevant.length, 3);
    assert.equal(openCase.expectedStructuredAnswer, null);
    assert.deepEqual(openCase.relevant.map((paper) => paper.relevance), [2, 2, 1]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SPARBench answers with paperID normalize as relevant papers', async () => {
  const tempDir = await createTempDir();
  const benchmarkPath = path.join(tempDir, 'sparbench.json');

  try {
    await fs.writeFile(benchmarkPath, `${JSON.stringify([{
      query: 'Find academic search systems that use agentic paper retrieval.',
      answers: [{
        paperID: 'sparbench-paper-1',
        title: 'Scholar Paper Retrieval with LLM-based Agents',
        abstract: 'An academic search benchmark with expert-verified answers.'
      }]
    }], null, 2)}\n`);

    const benchmark = await loadRetrievalBenchmark(benchmarkPath, { format: 'sparbench' });
    assert.equal(benchmark.queryCount, 1);
    assert.equal(benchmark.queries[0].relevant[0].id, 'sparbench-paper-1');

    const evaluation = evaluateRetrievalResults(benchmark.queries[0], [
      { paperID: 'sparbench-paper-1', title: 'Scholar Paper Retrieval with LLM-based Agents' }
    ], { cutoffs: [1] });
    assert.equal(evaluation.metrics['recall@1'], 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('ScholarQA task evaluation scores answer overlap and citation evidence', async () => {
  const report = await runRetrievalBenchmark({
    benchmark: {
      name: 'scholarqa-mini',
      format: 'scholarqa',
      queryCount: 1,
      queries: [{
        id: 'sq1',
        query: 'What does graph augmented literature mapping improve?',
        referenceAnswers: ['It improves retrieval by grounding search in graph evidence.'],
        relevant: [{ id: 'd1', title: 'Graph Evidence Search' }],
        systemAnswer: {
          answer: 'Graph augmented literature mapping improves retrieval with graph evidence.',
          citations: [{ id: 'd1', title: 'Graph Evidence Search' }]
        },
        metadata: { taskType: 'citation_grounded_qa_retrieval' }
      }]
    },
    cutoffs: [1],
    runDiscovery: async () => ({
      candidates: [{ id: 'd1', title: 'Graph Evidence Search', abstract: 'Graph evidence improves retrieval.' }]
    })
  });

  assert.equal(report.taskEvaluation.evaluatedQueries, 1);
  assert.equal(report.taskEvaluation.metrics.citation_recall, 1);
  assert.ok(report.taskEvaluation.metrics.answer_correctness > 0);
});

test('ScholarQABench rubric-only configs load and can be LLM judged', async () => {
  const tempDir = await createTempDir();
  const benchmarkPath = path.join(tempDir, 'test_configs_snippets.json');

  try {
    await fs.writeFile(benchmarkPath, `${JSON.stringify([
      {
        initial_prompt: 'What datasets evaluate Python type inference systems?',
        metric_config: {
          config: {
            question: 'What datasets evaluate Python type inference systems?',
            other_properties: [{
              name: 'must_include_datasets',
              criterion: 'The answer should mention ManyTypes4Py and TypeEvalPy.',
              weight: 0.5,
              evidence: ['ManyTypes4Py and TypeEvalPy are common evaluation datasets.']
            }]
          }
        }
      }
    ], null, 2)}\n`);

    const benchmark = await loadRetrievalBenchmark(benchmarkPath, { format: 'scholarqa' });
    assert.equal(benchmark.queryCount, 1);
    assert.equal(benchmark.queries[0].query, 'What datasets evaluate Python type inference systems?');
    assert.equal(benchmark.queries[0].referenceRubrics.length, 1);
    assert.equal(benchmark.queries[0].relevant.length, 0);

    const report = await runRetrievalBenchmark({
      benchmark,
      cutoffs: [1],
      taskEvaluation: 'llm',
      generateTaskAnswers: true,
      answerGenerator: async () => ({
        answer: 'ManyTypes4Py and TypeEvalPy are common evaluation datasets.',
        citations: []
      }),
      taskJudge: async () => ({
        answerCorrectness: 1,
        answerGroundedness: 0.8,
        citationFaithfulness: 0,
        taskSuccess: 1,
        rationale: 'Matches the rubric.'
      }),
      runDiscovery: async () => ({ candidates: [] })
    });

    assert.equal(report.taskEvaluation.evaluatedQueries, 1);
    assert.equal(report.taskEvaluation.metrics.answer_correctness, 1);
    assert.equal(report.results[0].taskEvaluation.diagnostics.referenceRubricCount, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('ScholarQABench single-paper task schema loads input, answer label, and gold contexts', async () => {
  const tempDir = await createTempDir();
  const benchmarkPath = path.join(tempDir, 'qasa_test.jsonl');

  try {
    await fs.writeFile(benchmarkPath, `${JSON.stringify({
      input: 'What are the side effects of group convolution?',
      answer: 'Blocked cross-group information flow.',
      ctxs: [
        { id: 'ctx0', title: 'ShuffleNet', text: 'Unrelated opening.' },
        { id: 'ctx1', title: 'ShuffleNet', text: 'Group convolutions block information flow between channel groups.' }
      ],
      gold_ctxs: [1]
    })}\n${JSON.stringify({
      input: 'Aspirin reduces fever.',
      answer: 'true',
      gold_ctx: [{ title: 'Aspirin Study', text: 'Aspirin is an antipyretic.' }]
    })}\n`);

    const benchmark = await loadRetrievalBenchmark(benchmarkPath, { format: 'scholarqa' });
    assert.equal(benchmark.queryCount, 2);
    assert.equal(benchmark.queries[0].query, 'What are the side effects of group convolution?');
    assert.equal(benchmark.queries[0].referenceAnswers[0], 'Blocked cross-group information flow.');
    assert.equal(benchmark.queries[0].relevant[0].abstract, 'Group convolutions block information flow between channel groups.');
    assert.equal(benchmark.queries[1].query, 'Aspirin reduces fever.');
    assert.equal(benchmark.queries[1].expectedLabel, 'true');
    assert.equal(benchmark.queries[1].relevant[0].title, 'Aspirin Study');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('ScholarQABench multi human-answer schema treats output as reference answer', async () => {
  const tempDir = await createTempDir();
  const benchmarkPath = path.join(tempDir, 'human_answers.json');

  try {
    await fs.writeFile(benchmarkPath, `${JSON.stringify([{
      id: 'norman_bio_1',
      input: 'What are the key mechanisms for lipid nanoparticles to form biomolecular corona?',
      output: 'Protein adsorption and surface-charge interactions drive corona formation.',
      subject: 'bio',
      annotator: 'norman',
      ctxs: {
        title: 'The sweet side of the protein corona',
        text: 'Electrostatic interaction between nanoparticles and proteins drives corona formation.',
        url: 'https://www.semanticscholar.org/paper/90b3eb94139217e45986958d1a1083a1ad8dbb5c'
      }
    }], null, 2)}\n`);

    const benchmark = await loadRetrievalBenchmark(benchmarkPath, { format: 'scholarqa' });
    assert.equal(benchmark.queryCount, 1);
    assert.equal(benchmark.queries[0].referenceAnswers[0], 'Protein adsorption and surface-charge interactions drive corona formation.');
    assert.equal(benchmark.queries[0].systemAnswer, null);
    assert.equal(benchmark.queries[0].relevant[0].title, 'The sweet side of the protein corona');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('ScholarQABench official repo-style directories load supported data files recursively', async () => {
  const tempDir = await createTempDir();

  try {
    await fs.mkdir(path.join(tempDir, 'data', 'single_paper_tasks'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'data', 'scholarqa_cs', 'src_answers'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'data', 'scholarqa_multi'), { recursive: true });

    await fs.writeFile(path.join(tempDir, 'data', 'single_paper_tasks', 'scifact_test.jsonl'), `${JSON.stringify({
      input: 'The system supports citation grounding.',
      answer: 'true',
      gold_ctx: [{ title: 'Citation Grounding', text: 'The system supports citation grounding.' }]
    })}\n`);
    await fs.writeFile(path.join(tempDir, 'data', 'scholarqa_cs', 'test_configs_snippets.json'), `${JSON.stringify([{
      case_id: 'cs1',
      initial_prompt: 'What datasets evaluate type inference systems?',
      metric_config: { config: { question: 'What datasets evaluate type inference systems?', other_properties: ['Mention TypeEvalPy.'] } }
    }], null, 2)}\n`);
    await fs.writeFile(path.join(tempDir, 'data', 'scholarqa_multi', 'human_answers.json'), `${JSON.stringify([{
      id: 'multi1',
      input: 'How does retrieval grounding help scholarly QA?',
      output: 'It links claims to cited evidence.',
      subject: 'cs',
      ctxs: [{ title: 'Grounded QA', text: 'Grounded QA links claims to cited evidence.' }]
    }], null, 2)}\n`);
    await fs.writeFile(path.join(tempDir, 'data', 'scholarqa_cs', 'src_answers', 'gpt.jsonl'), `${JSON.stringify({
      case_id: 'cs1',
      answer_text: 'This is a prediction file and should not be loaded as a benchmark input.'
    })}\n`);

    const benchmark = await loadRetrievalBenchmark(tempDir, { format: 'scholarqa' });
    assert.equal(benchmark.queryCount, 3);
    assert.ok(benchmark.queries.some((query) => query.id === 'cs1'));
    assert.ok(benchmark.queries.some((query) => query.id === 'multi1'));
    assert.ok(benchmark.queries.some((query) => query.expectedLabel === 'true'));
    assert.ok(benchmark.queries.every((query) => !query.query.includes('prediction file')));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('PaperAsk claim verification records claim accuracy with rule metrics', async () => {
  const report = await runRetrievalBenchmark({
    benchmark: {
      name: 'paperask-mini',
      format: 'paperask',
      queryCount: 1,
      queries: [{
        id: 'pa1',
        query: 'Claim: the paper reports stronger retrieval accuracy.',
        expectedLabel: 'supported',
        relevant: [{ id: 'd1', title: 'Retrieval Accuracy Study' }],
        systemAnswer: {
          verdict: 'supported',
          citations: [{ id: 'd1', title: 'Retrieval Accuracy Study' }]
        },
        metadata: { taskType: 'scholarly_assistant_reliability' }
      }]
    },
    cutoffs: [1],
    runDiscovery: async () => ({
      candidates: [{ id: 'd1', title: 'Retrieval Accuracy Study', abstract: 'The method is stronger.' }]
    })
  });

  assert.equal(report.taskEvaluation.metrics.claim_accuracy, 1);
  assert.equal(report.taskEvaluation.metrics.citation_f1, 1);
});

test('PaperAsk citation retrieval parses BibTeX answers and reports failure rate', async () => {
  const report = await runRetrievalBenchmark({
    benchmark: {
      name: 'paperask-citation-mini',
      format: 'paperask',
      queryCount: 1,
      queries: [{
        id: 'pa-cite-1',
        query: 'Return the BibTeX for this paper.',
        relevant: [{ title: 'Reliable Paper Search', doi: '10.1234/reliable.search' }],
        systemAnswer: {
          answer: '@article{reliable2026, title={Reliable Paper Search}, doi={10.1234/reliable.search}}'
        },
        metadata: { benchmarkFormat: 'paperask', taskType: 'citation_retrieval' }
      }]
    },
    cutoffs: [1],
    runDiscovery: async () => ({
      candidates: [{ title: 'Reliable Paper Search', doi: '10.1234/reliable.search' }]
    })
  });

  assert.equal(report.taskEvaluation.metrics.citation_success, 1);
  assert.equal(report.taskEvaluation.metrics.paperask_failure_rate, 0);
});

test('PaperAsk released task schemas load citation, content, discovery, and claim targets', async () => {
  const tempDir = await createTempDir();

  try {
    const citationPath = path.join(tempDir, 'batch_3_evaluation.json');
    await fs.writeFile(citationPath, `${JSON.stringify([{
      test_case: 'batch_test_001',
      prompt: 'Return BibTeX entries only for each paper.',
      papers: [
        { paper_title: 'When Less is More', arxiv_id: '2309.04564' },
        { paper_title: 'How to Train Data-Efficient LLMs', arxiv_id: '2402.09668' }
      ],
      num_papers: 2
    }], null, 2)}\n`);
    const citation = await loadRetrievalBenchmark(citationPath, { format: 'paperask' });
    assert.equal(citation.queries[0].id, 'batch_test_001');
    assert.equal(citation.queries[0].metadata.taskType, 'citation_retrieval');
    assert.equal(citation.queries[0].relevant[0].identifiers.arxivId, '2309.04564');

    const discoveryPath = path.join(tempDir, 'QA_evaluation.json');
    await fs.writeFile(discoveryPath, `${JSON.stringify([{
      test_case: 'open_qa_001',
      prompt: 'Please list all published paper in February 2024 on arXiv.',
      query_topic: 'robot decision making and task planning',
      expected_publication_date: 'February 2024',
      ground_truth_papers: [
        { paper_title: 'LoTa-Bench', arxiv_id: '2402.08178' }
      ]
    }], null, 2)}\n`);
    const discovery = await loadRetrievalBenchmark(discoveryPath, { format: 'paperask' });
    assert.equal(discovery.queries[0].metadata.taskType, 'paper_discovery');
    assert.equal(discovery.queries[0].relevant[0].title, 'LoTa-Bench');

    const claimPath = path.join(tempDir, 'claim.json');
    await fs.writeFile(claimPath, `${JSON.stringify([{
      test_case: 'fact_check_batch_001',
      prompt: 'Verify the claims based on the provided papers.',
      paper_url: ['https://arxiv.org/abs/2204.08689'],
      ground_truth: 'REFUTED'
    }], null, 2)}\n`);
    const claim = await loadRetrievalBenchmark(claimPath, { format: 'paperask' });
    assert.equal(claim.queries[0].metadata.taskType, 'claim_verification');
    assert.equal(claim.queries[0].expectedLabel, 'REFUTED');

    const contentReport = await runRetrievalBenchmark({
      benchmark: {
        name: 'paperask-content',
        format: 'paperask',
        queryCount: 1,
        queries: [{
          id: 'content-1',
          query: 'Extract structured fields from the paper.',
          expectedStructuredAnswer: {
            title: 'Dynamicasome',
            number_of_figures: '6'
          },
          systemAnswer: {
            answer: '{"url":"https://arxiv.org/pdf/2509.19766","answers":{"title":"Dynamicasome","number_of_figures":"6"}}'
          },
          metadata: { benchmarkFormat: 'paperask', taskType: 'content_extraction', hasTaskEvaluationTarget: true },
          relevant: []
        }]
      },
      cutoffs: [1],
      runDiscovery: async () => ({ candidates: [] })
    });
    assert.equal(contentReport.taskEvaluation.metrics.content_extraction_accuracy, 1);

    const contentPath = path.join(tempDir, 'task_ContentExtraction.json');
    await fs.writeFile(contentPath, `${JSON.stringify([{
      id: 0,
      paper_id: 1,
      url: 'https://arxiv.org/pdf/2509.19766',
      prompt: 'Please answer questions about the Paper URL.',
      fields_tested: ['title', 'number_of_figures'],
      ground_truth: {
        title: 'Dynamicasome',
        number_of_figures: '6'
      }
    }], null, 2)}\n`);
    const content = await loadRetrievalBenchmark(contentPath, { format: 'paperask' });
    assert.equal(content.queries[0].metadata.taskType, 'content_extraction');
    assert.equal(content.queries[0].expectedStructuredAnswer.title, 'Dynamicasome');
    assert.equal(content.queries[0].relevant[0].sourceUrl, 'https://arxiv.org/pdf/2509.19766');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('PaperAsk official test_cases tree loads all released task families recursively', async () => {
  const tempDir = await createTempDir();

  try {
    await fs.mkdir(path.join(tempDir, 'test_cases', 'citation_retrieval'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'test_cases', 'content_extraction'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'test_cases', 'open_domain_QA'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'test_cases', 'open_book_CF'), { recursive: true });

    await fs.writeFile(path.join(tempDir, 'test_cases', 'citation_retrieval', 'batch_3_evaluation.json'), `${JSON.stringify([{
      test_case: 'cite1',
      prompt: 'Return BibTeX entries only.',
      papers: [{ paper_title: 'Data-Efficient LLMs', arxiv_id: '2402.09668' }]
    }], null, 2)}\n`);
    await fs.writeFile(path.join(tempDir, 'test_cases', 'content_extraction', 'task_ContentExtraction.json'), `${JSON.stringify([{
      id: 0,
      url: 'https://arxiv.org/pdf/2509.19766',
      prompt: 'Extract fields.',
      fields_tested: ['title'],
      ground_truth: { title: 'Dynamicasome' }
    }], null, 2)}\n`);
    await fs.writeFile(path.join(tempDir, 'test_cases', 'open_domain_QA', 'QA_evaluation.json'), `${JSON.stringify([{
      test_case: 'qa1',
      prompt: 'List all published papers.',
      ground_truth_papers: [{ paper_title: 'LoTa-Bench', arxiv_id: '2402.08178' }]
    }], null, 2)}\n`);
    await fs.writeFile(path.join(tempDir, 'test_cases', 'open_book_CF', 'batch_3_evaluation.json'), `${JSON.stringify([{
      test_case: 'cf1',
      prompt: 'Verify the claims based on the provided papers.',
      paper_url: ['https://arxiv.org/abs/2204.08689'],
      ground_truth: 'REFUTED'
    }], null, 2)}\n`);

    const benchmark = await loadRetrievalBenchmark(tempDir, { format: 'paperask' });
    assert.equal(benchmark.queryCount, 4);
    assert.deepEqual(benchmark.queries.map((query) => query.metadata.taskType).sort(), [
      'citation_retrieval',
      'claim_verification',
      'content_extraction',
      'paper_discovery'
    ]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SciNetBench relation task evaluation scores predicted relation overlap', async () => {
  const report = await runRetrievalBenchmark({
    benchmark: {
      name: 'scinet-mini',
      format: 'scinetbench',
      queryCount: 1,
      queries: [{
        id: 'sn1',
        query: 'Find the method relation between graph retrieval and evidence ranking.',
        relevant: [{ id: 'd1', title: 'Evidence Ranking' }],
        goldRelations: [{ source: 'graph retrieval', type: 'improves', target: 'evidence ranking' }],
        systemAnswer: {
          relations: [{ source: 'graph retrieval', type: 'improves', target: 'evidence ranking' }]
        },
        metadata: { taskType: 'relation_aware_retrieval' }
      }]
    },
    cutoffs: [1],
    runDiscovery: async () => ({
      candidates: [{ id: 'd1', title: 'Evidence Ranking', abstract: 'Graph retrieval improves evidence ranking.' }]
    })
  });

  assert.equal(report.taskEvaluation.metrics.relation_recall, 1);
  assert.equal(report.taskEvaluation.metrics.relation_f1, 1);
});

test('ScholarQABench, PaperAsk, and SciNetBench reports mark official comparability as external', async () => {
  const makeReport = (format) => runRetrievalBenchmark({
    benchmark: {
      name: `${format}-alignment`,
      format,
      queryCount: 1,
      corpusSize: 1,
      corpus: [{ id: 'd1', title: 'Known Paper' }],
      queries: [{
        id: 'q1',
        query: 'Known Paper',
        relevant: [{ id: 'd1', title: 'Known Paper' }],
        metadata: { benchmarkFormat: format, taskType: 'alignment_test' }
      }]
    },
    evaluationMode: 'fixed-corpus',
    cutoffs: [1]
  });

  for (const format of ['scholarqa', 'paperask', 'scinetbench']) {
    const report = await makeReport(format);
    assert.equal(report.alignment.officialComparable, false);
    assert.ok(report.alignment.limitations.some((note) => /official/i.test(note)));
  }
});

test('SciNetBench official Queries tree loads task files recursively and infers tasks from filenames', async () => {
  const tempDir = await createTempDir();

  try {
    await fs.mkdir(path.join(tempDir, 'Queries', 'Task1'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'Queries', 'Task2'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'Queries', 'Task3'), { recursive: true });

    await fs.writeFile(path.join(tempDir, 'Queries', 'Task1', 'queries_task1_disruptive_AI.json'), `${JSON.stringify({
      'Machine Learning': 'Return the top disruptive papers.'
    }, null, 2)}\n`);
    await fs.writeFile(path.join(tempDir, 'Queries', 'Task2', 'queries_AI_cooccur.json'), `${JSON.stringify({
      'Attention|Transformers': 'Find the relation for this paper pair.'
    }, null, 2)}\n`);
    await fs.writeFile(path.join(tempDir, 'Queries', 'Task2', 'queries_AI_pncites.json'), `${JSON.stringify({
      'BERT|RoBERTa': 'Find the relation for this paper pair.'
    }, null, 2)}\n`);
    await fs.writeFile(path.join(tempDir, 'Queries', 'Task3', 'queries_task3_path_PHY.json'), `${JSON.stringify({
      'Quantum_Lineage': 'Find an influential path.'
    }, null, 2)}\n`);

    const benchmark = await loadRetrievalBenchmark(tempDir, { format: 'scinetbench' });
    assert.equal(benchmark.queryCount, 4);
    assert.deepEqual(benchmark.queries.map((query) => query.metadata.taskType), [
      'ego-centric relation retrieval',
      'pair-wise co-mention retrieval',
      'pair-wise citation sentiment',
      'path-wise evolutionary analysis'
    ]);
    assert.equal(benchmark.queries[0].metadata.sourceFile, 'Queries/Task1/queries_task1_disruptive_AI.json');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SciNetBench path-wise task reports consistency and connectivity', async () => {
  const report = await runRetrievalBenchmark({
    benchmark: {
      name: 'scinet-path-mini',
      format: 'scinetbench',
      queryCount: 1,
      queries: [{
        id: 'sn-path-1',
        query: 'Trace the technological evolution from Seq2Seq to LLMs.',
        relevant: [{ id: 'd1', title: 'Attention Is All You Need' }],
        goldRelations: [['Seq2Seq', 'Attention Is All You Need', 'Large Language Models']],
        systemAnswer: {
          relations: [['Seq2Seq', 'Attention Is All You Need', 'Large Language Models']]
        },
        metadata: { benchmarkFormat: 'scinetbench', taskType: 'path-wise evolutionary analysis' }
      }]
    },
    cutoffs: [1],
    runDiscovery: async () => ({
      candidates: [{ id: 'd1', title: 'Attention Is All You Need' }]
    })
  });

  assert.equal(report.taskEvaluation.metrics.scinet_path_consistency, 1);
  assert.equal(report.taskEvaluation.metrics.scinet_path_connectivity, 1);
});

test('SciNetBench released object-map query files expand to individual cases', async () => {
  const tempDir = await createTempDir();
  const benchmarkPath = path.join(tempDir, 'queries_task1_novel_AI.json');

  try {
    await fs.writeFile(benchmarkPath, `${JSON.stringify({
      'Reinforcement Learning (RL)': 'What are the top 5 most novel papers in the field of Reinforcement Learning (RL)?',
      Frustrated_Lewis_Pairs_Lineage: 'What is the most influential citation path from "Reversible, metal-free hydrogen activation" to "Metal-Free Heterogeneous Asymmetric Hydrogenation of Olefins Promoted by Chiral Frustrated Lewis Pair Framework" in the field of Frustrated Lewis Pairs Lineage?'
    }, null, 2)}\n`);

    const benchmark = await loadRetrievalBenchmark(benchmarkPath, { format: 'scinetbench' });
    assert.equal(benchmark.queryCount, 2);
    assert.equal(benchmark.queries[0].id, 'Reinforcement Learning (RL)');
    assert.equal(benchmark.queries[0].metadata.taskType, 'ego-centric relation retrieval');
    assert.equal(benchmark.queries[1].metadata.taskType, 'path-wise evolutionary analysis');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('LLM task evaluator can generate answers and aggregate judge scores without touching live providers', async () => {
  const report = await runRetrievalBenchmark({
    benchmark: {
      name: 'llm-task-mini',
      format: 'scholarqa',
      queryCount: 1,
      queries: [{
        id: 'llm1',
        query: 'What does the retrieved paper support?',
        referenceAnswers: ['The paper supports grounded scholarly answering.'],
        relevant: [{ id: 'd1', title: 'Grounded Scholarly Answering' }],
        metadata: { taskType: 'citation_grounded_qa_retrieval' }
      }]
    },
    cutoffs: [1],
    taskEvaluation: 'llm',
    generateTaskAnswers: true,
    answerGenerator: async () => ({
      answer: 'The paper supports grounded scholarly answering.',
      citations: [{ id: 'd1', title: 'Grounded Scholarly Answering' }]
    }),
    taskJudge: async () => ({
      answerCorrectness: 0.9,
      answerGroundedness: 0.8,
      citationFaithfulness: 0.7,
      taskSuccess: 1,
      rationale: 'Grounded answer with the right citation.'
    }),
    runDiscovery: async () => ({
      candidates: [{ id: 'd1', title: 'Grounded Scholarly Answering', abstract: 'Evidence for grounded answers.' }]
    })
  });

  assert.equal(report.taskEvaluation.evaluatedQueries, 1);
  assert.equal(report.taskEvaluation.metrics.answer_correctness, 0.9);
  assert.equal(report.taskEvaluation.metrics.citation_faithfulness, 0.7);
  assert.equal(report.results[0].taskEvaluation.systemAnswer.citations[0].id, 'd1');
});

test('retrieval evaluation deduplicates repeated hits for the same relevant paper', () => {
  const evaluation = evaluateRetrievalResults(
    {
      id: 'q1',
      query: 'paper nexus retrieval',
      relevant: [{ title: 'PaperNexus Retrieval Benchmarking', doi: '10.5555/pn.bench' }]
    },
    [
      { title: 'PaperNexus Retrieval Benchmarking', doi: '10.5555/pn.bench' },
      { title: 'PaperNexus Retrieval Benchmarking', identifiers: { doi: '10.5555/pn.bench' } }
    ],
    { cutoffs: [1, 2] }
  );

  assert.equal(evaluation.matchedCount, 1);
  assert.equal(evaluation.metrics['precision@2'], 0.5);
  assert.equal(evaluation.metrics['recall@2'], 1);
  assert.equal(evaluation.topMatches[1].duplicateRelevantMatch, true);
});

test('graded relevance reports weighted recall, f1, exact match, and graded ndcg', () => {
  const evaluation = evaluateRetrievalResults(
    {
      id: 'q1',
      query: 'graded retrieval',
      relevant: [
        { id: 'd1', title: 'Highly Relevant Paper', relevance: 3 },
        { id: 'd2', title: 'Relevant Paper', relevance: 1 }
      ]
    },
    [
      { id: 'd2', title: 'Relevant Paper' },
      { id: 'd1', title: 'Highly Relevant Paper' }
    ],
    { cutoffs: [1, 2] }
  );

  assert.equal(evaluation.metrics['exact_match@1'], 1);
  assert.equal(evaluation.metrics['weighted_recall@1'], 0.25);
  assert.equal(evaluation.metrics['f1@1'], 2 / 3);
  assert.ok(evaluation.metrics['ndcg@1'] < 1);
  assert.equal(evaluation.metrics['weighted_recall@2'], 1);
});

test('fixed-corpus evaluation ranks benchmark corpus without live providers', async () => {
  const report = await runRetrievalBenchmark({
    benchmark: {
      name: 'fixed',
      format: 'custom',
      corpus: [
        { id: 'd1', title: 'Graph augmented literature mapping', abstract: 'Knowledge graph search.' },
        { id: 'd2', title: 'Unrelated result', abstract: 'Noise.' }
      ],
      corpusSize: 2,
      queryCount: 1,
      queries: [{
        id: 'q1',
        query: 'graph augmented literature mapping',
        relevant: [{ id: 'd1', title: 'Graph augmented literature mapping' }]
      }]
    },
    evaluationMode: 'fixed-corpus',
    cutoffs: [1]
  });

  assert.equal(report.config.evaluationMode, 'fixed-corpus');
  assert.equal(report.config.fixedCorpusScorer, 'hybrid-bm25-v1');
  assert.equal(report.metrics['hit@1'], 1);
  assert.equal(report.alignment.officialComparable, true);
  assert.equal(report.results[0].discovery.providerCount, 1);
});

test('benchmark report renders concise markdown summary', () => {
  const markdown = renderRetrievalBenchmarkReport({
    generatedAt: '2026-05-10T00:00:00.000Z',
    benchmark: {
      name: 'synthetic',
      format: 'custom',
      loadedQueries: 1,
      evaluatedQueries: 1,
      relevantPapers: 1
    },
    config: {
      cutoffs: [1],
      depth: 'quick',
      resolveSources: false
    },
    metrics: {
      'hit@1': 1,
      'recall@1': 1,
      'precision@1': 1,
      'mrr@1': 1,
      'map@1': 1,
      'ndcg@1': 1
    },
    results: [{
      query: 'benchmark query',
      relevantCount: 1,
      retrievedCount: 3,
      firstRelevantRank: 1,
      metrics: { 'recall@1': 1 }
    }]
  });

  assert.match(markdown, /Retrieval Benchmark: synthetic/);
  assert.match(markdown, /\| recall@1 \| 1\.0000 \|/);
});
