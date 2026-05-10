export const PROMPT_VERSION = 'semantic-objects-v2';

function normalizeFallbackConfig(fallback = null) {
  if (!fallback) return null;
  return {
    provider: fallback.provider || '',
    model: fallback.model || '',
    baseUrl: fallback.baseUrl || '',
    sshHost: fallback.sshHost || '',
    autoStart: Boolean(fallback.autoStart),
    autoPull: Boolean(fallback.autoPull),
    ollamaBootstrap: fallback.ollamaBootstrap?.mode || ''
  };
}

export function createDisabledConfigSignature({
  signatureVersion,
  requestedMode = 'heuristic-only',
  catalystMetadataContractVersion
} = {}) {
  return [
    'semantic',
    signatureVersion,
    'disabled',
    requestedMode,
    `catalyst:${catalystMetadataContractVersion}`,
    `prompt:${PROMPT_VERSION}`
  ].join(':');
}

export function createConfigSignature({
  signatureVersion,
  catalystMetadataContractVersion,
  requestedMode = 'heuristic-only',
  effectiveMode = requestedMode,
  config = {}
} = {}) {
  return JSON.stringify({
    kind: 'semantic',
    version: signatureVersion,
    promptVersion: PROMPT_VERSION,
    catalystMetadataContractVersion,
    requestedMode,
    effectiveMode,
    provider: config.provider || 'disabled',
    model: config.model || '',
    baseUrl: config.baseUrl || '',
    fallback: normalizeFallbackConfig(config.fallback)
  });
}
