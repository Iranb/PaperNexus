import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPdfParseTracker } from '../src/storage/pdf-parse-store.js';

test('pdf parse tracker persists state and logs under PAPERNEXUS_HOME', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-pdf-parse-store-home-'));
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    const tracker = await createPdfParseTracker('/tmp/example-paper.pdf', 'markitdown', {
      selectedParser: 'markitdown',
      importTaskId: 'imp:test-task',
      importStage: 'preparse',
      sourceKey: '/tmp/example-paper.pdf'
    });

    await tracker.update({
      status: 'running',
      currentStep: 'running markitdown',
      message: 'Running MarkItDown'
    });
    await tracker.log('info', 'child parser started');
    await tracker.finish('completed', 'Completed markitdown parse', {
      parserCommand: 'python3 scripts/markitdown_to_markdown.py'
    });

    const state = JSON.parse(await fs.readFile(tracker.statePath, 'utf8'));
    const latest = JSON.parse(await fs.readFile(tracker.latestPath, 'utf8'));
    const events = await fs.readFile(tracker.eventsPath, 'utf8');

    assert.equal(state.status, 'completed');
    assert.equal(state.importTaskId, 'imp:test-task');
    assert.equal(state.importStage, 'preparse');
    assert.equal(state.selectedParser, 'markitdown');
    assert.equal(state.activeParser, 'markitdown');
    assert.equal(state.parserCommand, 'python3 scripts/markitdown_to_markdown.py');
    assert.equal(latest.runId, tracker.runId);
    assert.match(events, /created parser run/);
    assert.match(events, /child parser started/);
    assert.match(events, /Completed markitdown parse/);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('pdf parse tracker marks a previous in-flight run interrupted when a newer attempt starts', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-pdf-parse-store-restart-home-'));
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    const pdfPath = '/tmp/restart-paper.pdf';
    const first = await createPdfParseTracker(pdfPath, 'docling', {
      selectedParser: 'docling'
    });
    await first.update({
      status: 'running',
      currentStep: 'running local docling',
      message: 'Running local Docling'
    });

    const second = await createPdfParseTracker(pdfPath, 'docling', {
      selectedParser: 'docling'
    });

    const firstState = JSON.parse(await fs.readFile(first.statePath, 'utf8'));
    const secondState = JSON.parse(await fs.readFile(second.statePath, 'utf8'));

    assert.equal(firstState.status, 'interrupted');
    assert.equal(secondState.status, 'starting');
    assert.equal(secondState.attempt, 2);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
