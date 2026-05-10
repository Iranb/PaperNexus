export const PROMPT_VERSION = 'research-relations-v1';

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

export function createDisabledConfigSignature({ signatureVersion } = {}) {
  return `relations:${signatureVersion}:disabled:prompt:${PROMPT_VERSION}`;
}

export function createConfigSignature({
  signatureVersion,
  config = {}
} = {}) {
  return JSON.stringify({
    kind: 'relations',
    version: signatureVersion,
    promptVersion: PROMPT_VERSION,
    provider: config.provider || 'disabled',
    model: config.model || '',
    baseUrl: config.baseUrl || '',
    fallback: normalizeFallbackConfig(config.fallback)
  });
}
