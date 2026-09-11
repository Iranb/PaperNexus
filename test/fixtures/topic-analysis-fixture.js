import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

export function createTopicFixture() {
  const graph = createKnowledgeGraph();
  const node = (id, type, name, properties = {}) => graph.addNode({ id, type, name, properties });
  node('p1', 'Paper', 'Feedback calibration in tutoring', { paperId: 'p1', year: 2020, fieldOfStudy: 'Education' });
  node('p2', 'Paper', 'Feedback control with sparse observations', { paperId: 'p2', year: 2024, fieldOfStudy: 'Engineering' });
  node('q1', 'Problem', 'Sparse feedback calibration', { paperId: 'p1', fieldOfStudy: 'Education',
    evidenceText: 'Sparse feedback makes calibration difficult.' });
  node('q2', 'Challenge', 'Delayed feedback calibration', { paperId: 'p2', fieldOfStudy: 'Engineering',
    evidenceText: 'Feedback is delayed.' });
  node('m1', 'Method', 'Feedback controller', { paperId: 'p1', year: 2020, fieldOfStudy: 'Education',
    abstractMechanisms: ['feedback control'], assumptions: ['observations available'],
    requirements: { labelsAvailable: true }, evidenceText: 'The controller calibrates with observations.' });
  node('m2', 'Method', 'Sparse feedback controller', { paperId: 'p2', year: 2024, fieldOfStudy: 'Engineering',
    abstractMechanisms: ['feedback control'], assumptions: ['observations available'],
    requirements: { labelsAvailable: true }, evidenceText: 'The sparse controller calibrates with fewer observations.' });
  node('mech', 'AbstractMechanism', 'Feedback control');
  node('lim', 'Limitation', 'Calibration fails with delayed feedback', { paperId: 'p2', evidenceText: 'Calibration fails with delayed feedback.' });
  node('claim', 'Claim', 'Improves calibration', { paperId: 'p2' });
  node('undated', 'ResearchQuestion', 'Feedback without timestamps');
  node('unrelated', 'Method', 'Protein folding', { abstractMechanisms: ['molecular dynamics'] });
  const edge = (id, sourceId, targetId, type, properties = {}) => graph.addRelationship({ id, sourceId, targetId, type, properties });
  edge('a1', 'p1', 'q1', 'CONTAINS');
  edge('a2', 'p1', 'm1', 'USES');
  edge('a3', 'm1', 'q1', 'SOLVES');
  edge('a4', 'm2', 'q2', 'SOLVES');
  edge('a5', 'm1', 'mech', 'INSTANTIATES');
  edge('a6', 'm2', 'mech', 'INSTANTIATES');
  edge('a7', 'p2', 'q2', 'CONTAINS');
  edge('a8', 'p2', 'm2', 'USES');
  edge('a9', 'm2', 'lim', 'HAS_LIMITATION');
  edge('b1', 'p2', 'claim', 'CLAIMS');
  edge('b2', 'm2', 'undated', 'RELATED_TO');
  edge('evolution', 'm2', 'm1', 'IMPROVES_METHOD', {
    methodEvolution: true, validationStatus: 'accepted', exactMatch: true, confidence: 0.92,
    exactQuote: 'The sparse controller improves the feedback controller with fewer observations.',
    evidenceCompletenessStatus: 'complete', bottleneckDimension: 'sample-efficiency',
    mechanismDescription: 'sparse feedback', tradeoffDescription: 'delayed convergence', paperId: 'p2'
  });
  edge('invalid-evolution', 'm1', 'm2', 'EXTENDS_METHOD', { validationStatus: 'candidate' });
  return graph;
}
