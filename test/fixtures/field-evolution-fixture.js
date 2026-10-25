import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

// Fictional research history for deterministic software and browser acceptance.
export function createFieldEvolutionFixture() {
  const graph = createKnowledgeGraph();
  const add = (id, name, year, domain = 'Education') => {
    graph.addNode({ id: `p-${id}`, type: 'Paper', name: `${name}: feedback calibration`,
      properties: { year, fieldOfStudy: domain, abstract: `A fictional study of ${name.toLowerCase()} for feedback calibration.`,
        authors: ['Example Researcher'] } });
    graph.addNode({ id, type: 'Method', name, properties: { paperId: `p-${id}`, year, fieldOfStudy: domain } });
    graph.addRelationship({ id: `owns-${id}`, type: 'USES', sourceId: `p-${id}`, targetId: id });
  };
  const link = (newer, older, type = 'EXTENDS_METHOD', extra = {}) => {
    const id = `${newer}-${older}`;
    graph.addRelationship({ id, type, sourceId: newer, targetId: older, properties: {
      methodEvolution: true, validationStatus: 'accepted', exactMatch: true, confidence: 0.9,
      sourcePaperId: `p-${newer}`, targetPaperId: `p-${older}`, paperId: `p-${newer}`,
      exactQuote: `${newer} extends ${older} by calibrating sparse feedback.`,
      citationContext: `${newer} extends ${older} by calibrating sparse feedback.`,
      sourceSpanId: `span-${id}`, sectionHeading: 'Method', bottleneckDescription: 'Sparse observations',
      mechanismDescription: 'Calibrate feedback before updating the controller', tradeoffDescription: 'Additional calibration cost',
      ...extra
    } });
  };
  const names = ['Feedback controller', 'Adaptive feedback', 'Sparse feedback', 'Calibrated feedback',
    'Robust calibration', 'Delayed calibration', 'Online calibration', 'Structured feedback',
    'Selective feedback', 'Unified calibration'];
  names.forEach((name, i) => { add(`m${i}`, name, 2010 + i); if (i) link(`m${i}`, `m${i - 1}`); });
  add('branch', 'Budgeted calibration', 2015); link('branch', 'm2', 'IMPROVES_METHOD');
  add('merge', 'Joint calibration', 2021); link('merge', 'm9'); link('merge', 'branch', 'USES_COMPONENT_METHOD');
  add('replace', 'Direct feedback estimator', 2023); link('replace', 'merge', 'REPLACES_METHOD');
  add('unknown', 'Undated calibration', null); link('unknown', 'replace');
  add('spectral', 'Spectral feedback', 2014); add('spectral2', 'Adaptive spectral feedback', 2022); link('spectral2', 'spectral');
  add('external', 'Control prior', 2008, 'Engineering'); link('m0', 'external', 'ADAPTS_METHOD');
  graph.addNode({ id: 'p-isolated', type: 'Paper', name: 'Feedback calibration observations', properties: { year: 2024, fieldOfStudy: 'Education' } });
  graph.addNode({ id: 'p-unrelated', type: 'Paper', name: 'Protein structure recovery', properties: { year: 2020, fieldOfStudy: 'Biology' } });
  graph.addRelationship({ id: 'ordinary-citation', type: 'CITES', sourceId: 'p-spectral', targetId: 'p-m0' });
  graph.addRelationship({ id: 'candidate-edge', type: 'IMPROVES_METHOD', sourceId: 'm0', targetId: 'replace', properties: { validationStatus: 'candidate' } });
  const original = graph.getRelationship('merge-branch');
  graph.updateRelationship({ ...original, properties: { ...original.properties, candidateId: 'shared-component' } });
  graph.addRelationship({ id: 'component-projection', type: 'COMPONENT_OF', sourceId: 'branch', targetId: 'merge',
    properties: { ...original.properties, candidateId: 'shared-component', methodEvolutionProjection: true,
      relationshipRole: 'method-dag', citationRelationshipId: original.id, paperEdgeType: 'USES_COMPONENT_METHOD' } });
  return graph;
}
