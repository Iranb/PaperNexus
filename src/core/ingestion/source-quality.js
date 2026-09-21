// Deterministic admission checks. These do not turn an unverified source into a publication.
export function assessSourceContent(markdown = '') {
  const start = String(markdown).replace(/^\uFEFF/, '').trimStart().slice(0, 8192);
  if (/^(?:<!--[^]*?-->\s*)*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(start)) {
    return { valid: false, reason: 'html-document-instead-of-paper-markdown' };
  }
  if (/^(?:#{1,6}\s*)?(?:403 forbidden|404 not found|access denied|just a moment\.\.\.|sign in to continue|checking your browser)(?:\s|$)/i.test(start)) {
    return { valid: false, reason: 'access-or-error-page' };
  }
  return { valid: true, reason: null };
}

export function invalidPaperTitleReason(title = '') {
  const value = String(title).trim().replace(/^#{1,6}\s+/, '');
  if (/<(?:!doctype|html|head|body|script|title)\b/i.test(value)) return 'html-title';
  if (/^(undefined|null|nan|none|unknown|untitled|n\/a)$/i.test(value)) return 'placeholder-title';
  if (/^(403 forbidden|404 not found|access denied|just a moment\.*|sign in to continue)$/i.test(value)) return 'access-or-error-title';
  return null;
}

// "However", "only", "drop", or a limitations section heading alone is not evidence.
export function assessLimitationRecord(record = {}) {
  const text = String(record.evidenceText || record.text || record.name || '').replace(/\s+/g, ' ').trim();
  const meaningfulBoundary = /\b(?:cannot|can\s+not|unable\s+to|fails?\s+to|failure\s+(?:on|under|when|to)|suffers?\s+from|struggles?\s+(?:with|on|to)|limited\s+(?:to|by)|sensitive\s+to|lack(?:s|ing)?\s+|does\s+not\s+(?:generaliz|improv|handle|support|scale|account|address)|do\s+not\s+(?:generaliz|handle|support|address)|not\s+(?:evaluated|tested|validated)|remains?\s+(?:unclear|unexplored|challenging)|may\s+(?:fail|be\s+violated)|requires?\s+(?:access|manual|labelled|labeled)|computationally\s+(?:expensive|costly)|performance\s+(?:degrades?|drops?)|accuracy\s+(?:decreases?|drops?)|restricted\s+to|depends?\s+on|reli(?:es|ant)\s+on|only\s+(?:works?|supports?|applies)\s+(?:for|on|with|to))\b/i.test(text);
  const observedFailure = /\b(?:drop|decline|decrease|degradation)\s+in\b[^.!?]{0,65}\b(?:accuracy|performance|recall|precision)|\b(?:accuracy|performance)\b[^.!?]{0,40}\b(?:declines?|degrades?|drops?)\b/i.test(text);
  const explicitLimitation = /\b(?:limitation|drawback|shortcoming)s?\b[^.!?]{5,}\b(?:is|are|include|concern|due|because|when|that|of)\b/i.test(text);
  if (meaningfulBoundary || explicitLimitation || observedFailure) return { decision: 'keep', reason: 'explicit-boundary-or-failure', text };
  if (/^(?:table|figure)\s+|gain\s*\/\s*drop/i.test(text)) return { decision: 'review', reason: 'caption-without-limitation', text };
  if (/\b(?:outperforms?|improves?|achieves?|gains?|results?\s+(?:show|demonstrate|confirm)|these\s+gains\s+confirm)\b/i.test(text)) {
    return { decision: 'finding', reason: 'result-without-stated-boundary', text };
  }
  return { decision: 'review', reason: 'no-explicit-limitation-evidence', text };
}
