import { resolveCorpusForApi } from '../server/api.js';
import { DECISION_VERSION, MUTATIONS, OPERATIONS, REQUEST_FIELDS, REQUEST_PROPERTIES, PAYLOAD_SCHEMAS, validateDecisionRequest } from '../core/research/decision-contracts.js';
import { executeResearchDecisionOperation } from '../core/research/decision-service.js';
import { summarizeResearchEnvelope } from './research-summary.js';

export const RESEARCH_DECISION_TOOL = {
  name: 'research_decision',
  description: 'Maintain a project research decision loop: register competing hypotheses, quantitative prediction grounds and mechanism controls, record external attempts and original/control/paper comparisons, assess scoped explanations, retrieve source-backed paths with evidence_view, reuse equivalent assessed designs, and recommend actions under evidence and resource limits. init/register/record/assess/update/refresh write only project state; status/recommend/evidence_view read; export writes reports only with outputDir. No training, provider calls, resource reservations or execution authorization. Use requestId and expectedRevision for mutations; recover lost responses with status(requestId).',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  inputSchema: {
    type: 'object', additionalProperties: false, properties: REQUEST_PROPERTIES, required: ['operation', 'project'],
    allOf: OPERATIONS.map(operation => ({
      if: { properties: { operation: { const: operation } } },
      then: {
        required: MUTATIONS.includes(operation) ? ['requestId', ...(operation === 'init' ? [] : ['expectedRevision']), ...(['refresh_evidence'].includes(operation) ? [] : ['payload'])] : [],
        properties: { ...Object.fromEntries(Object.keys(REQUEST_PROPERTIES).filter(field => !REQUEST_FIELDS[operation].includes(field)).map(field => [field, false])),
          ...(PAYLOAD_SCHEMAS[operation] ? { payload: PAYLOAD_SCHEMAS[operation] } : {}) }
      }
    }))
  }
};

export async function executeResearchDecisionTool(args, options = {}) {
  validateDecisionRequest(args);
  const rootPath = await resolveCorpusForApi(args.corpus, options);
  const response = await executeResearchDecisionOperation(rootPath, args, options);
  const effect = args.dryRun ? 'dry_run' : MUTATIONS.includes(args.operation) ? 'project_state_write'
    : args.operation === 'export' && args.outputDir ? 'report_write' : 'project_read';
  const result = { ...response.result, execution_authority: 'The external executor owns execution authorization and admission. This response does not launch or reserve resources.', based_on_revision: response.result.based_on_revision ?? response.revision };
  const envelope = { contractVersion: DECISION_VERSION, tool: 'research_decision', operation: args.operation, project: args.project,
    ...response, result, effect,
    evidenceBoundary: { basis: effect, statusAuthority: 'research-decision-state.json owns project decisions; external manifests own run and measurement facts.',
      limitation: 'Source eligibility, scientific support, execution completion and authorization are separate. Synthetic behavior tests do not establish real research utility.' },
    nextActions: [{ tool: 'research_decision', arguments: { operation: 'status', ...(args.corpus ? { corpus: args.corpus } : {}), project: args.project,
      ...(MUTATIONS.includes(args.operation) && !args.dryRun ? { requestId: args.requestId } : {}) } }]
  };
  return args.responseMode === 'summary' ? summarizeResearchEnvelope(envelope, args) : envelope;
}
