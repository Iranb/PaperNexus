import { buildContributionClaims } from './claim-linking.js';
import { buildCounterfactuals } from './counterfactual-search.js';
import { buildModelAssistedInnovationContext } from './model-assisted-innovation.js';
import { buildNoveltyCertificate } from './novelty-scoring.js';
import { buildMustCiteSet } from './prior-art-contrast.js';
import { buildReviewPacket } from './reviewer-simulation.js';
import { buildStorylineDAG } from './storyline-dag.js';

export const IDEA_CATALYST_PACKET_V2_VERSION = 'idea-catalyst-packet-bundle-v2';
export const LIVE_IDEA_CATALYST_V2_CONTRACT_VERSION = 'idea-catalyst-live-discovery-v2';
export const LIVE_IDEA_CATALYST_PACKET_V2_VERSION = 'idea-catalyst-live-packet-bundle-v2';
export const INNOVATION_ARTIFACTS_CONTRACT_VERSION = 'papernexus-innovation-artifacts-v1';

export { buildContributionClaims } from './claim-linking.js';
export {
  buildCounterfactuals,
  COUNTERFACTUAL_SEARCH_CONTRACT_VERSION
} from './counterfactual-search.js';
export {
  buildModelAssistedInnovationContext,
  MODEL_ASSISTED_INNOVATION_VERSION
} from './model-assisted-innovation.js';
export { buildNoveltyCertificate } from './novelty-scoring.js';
export { buildMustCiteSet } from './prior-art-contrast.js';
export { buildReviewPacket } from './reviewer-simulation.js';
export { buildStorylineDAG } from './storyline-dag.js';

export function buildIdeaCatalystInnovationArtifacts(payload = {}, options = {}) {
  const modelAssistedContext = buildModelAssistedInnovationContext(payload, options);
  const mustCiteSet = buildMustCiteSet(payload, options);
  const contributionClaims = buildContributionClaims(payload, options);
  const noveltyCertificate = buildNoveltyCertificate(payload, {
    ...options,
    modelAssistedContext,
    mustCiteSet,
    contributionClaims
  });
  const reviewPacket = buildReviewPacket(payload, {
    ...options,
    modelAssistedContext,
    mustCiteSet,
    contributionClaims,
    noveltyCertificate
  });
  const storylineDAG = buildStorylineDAG(payload, {
    ...options,
    modelAssistedContext,
    contributionClaims,
    reviewPacket
  });
  const counterfactuals = buildCounterfactuals(payload, {
    ...options,
    mustCiteSet,
    contributionClaims,
    noveltyCertificate,
    reviewPacket
  });

  return {
    innovation_contract_version: INNOVATION_ARTIFACTS_CONTRACT_VERSION,
    packet_version: IDEA_CATALYST_PACKET_V2_VERSION,
    must_cite_set: mustCiteSet,
    contribution_claims: contributionClaims,
    novelty_certificate: noveltyCertificate,
    review_packet: reviewPacket,
    storyline_dag: storylineDAG,
    ...(modelAssistedContext.enabled ? { model_assisted: modelAssistedContext } : {}),
    counterfactuals,
    falsification_plans: counterfactuals
  };
}
