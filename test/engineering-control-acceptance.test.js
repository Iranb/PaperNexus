import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runEngineeringControlAcceptance } from '../scripts/run-engineering-control-acceptance.mjs';

test('engineering-control acceptance harness produces trace, Kuzu receipt, PROV, ledger, and evidence export', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-engineering-control-acceptance-'));

  try {
    const report = await runEngineeringControlAcceptance({
      outputDir,
      reset: true
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.authoritative_sync.processed, true);
    assert.equal(report.authoritative_sync.failed, false);
    assert.equal(report.kuzu_commit_receipt.status, 'committed');
    assert.equal(report.kuzu_commit_receipt.verification_ok, true);
    assert.equal(report.mcp_idea_catalyst.evidence_status, 'source_backed');
    assert.ok(report.mcp_idea_catalyst.idea_fragment_count >= 1);
    assert.equal(report.provenance.validation_ok, true);
    assert.equal(report.provenance.dangling_ref_count, 0);
    assert.ok(report.trace.span_count > 0);
    assert.equal(report.invariants.ok, true);

    const terminalReportPath = path.join(outputDir, 'artifacts', 'terminal-report.json');
    const evidenceExportPath = path.join(outputDir, 'artifacts', 'idea-catalyst-evidence-export.json');
    const llmResultsPath = path.join(outputDir, 'artifacts', 'idea-catalyst-ledger', 'llm-results.jsonl');
    await Promise.all([
      fs.access(terminalReportPath),
      fs.access(evidenceExportPath),
      fs.access(llmResultsPath)
    ]);
    const ledgerText = await fs.readFile(llmResultsPath, 'utf8');
    assert.match(ledgerText, /idea_fragments/);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
