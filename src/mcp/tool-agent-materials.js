import { executeAgentMaterialsOperation } from '../core/materials/agent-materials.js';

export async function executeAgentMaterialsTool(args = {}, options = {}) {
  return executeAgentMaterialsOperation(args, options);
}
