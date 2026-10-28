import { createDecisionFixture } from './scenarios.js';

export async function createMechanismFixture(t, options = {}) {
  const fixture = await createDecisionFixture(t, options);
  for (const h of fixture.input.hypotheses) {
    const primary = h.predictions[0];
    h.mechanism_evidence = {
      components: [
        { id: 'selection', kind: 'code_component', statement: h.mechanism, evidence_refs: h.evidence_refs },
        { id: 'count', kind: 'sample_population', statement: 'Number of selected items', evidence_refs: h.evidence_refs }
      ],
      links: [{ from: 'selection', to: primary.prediction_id, relation: 'proposes_effect', status: 'hypothesized',
        evidence_refs: [], required_controls: ['count'] }]
    };
  }
  for (const action of fixture.input.actions) {
    action.intervention_components = action.hypothesis_versions.map(h => ({ hypothesis_id: h.hypothesis_id,
      hypothesis_version: h.version, component_id: 'selection', held_constant: ['count'] }));
    action.controlled_components = action.hypothesis_versions.map(h => ({ hypothesis_id: h.hypothesis_id,
      hypothesis_version: h.version, component_id: 'count', check: action.validity_checks[0] }));
  }
  return fixture;
}
