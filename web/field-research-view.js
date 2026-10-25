const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const stages = { queued: 'Queued', discovery: 'Searching literature', full_text: 'Resolving full text',
  import_submission: 'Submitting papers', evidence: 'Waiting for evidence', importing: 'Importing papers',
  extracting: 'Extracting relation evidence', synchronizing: 'Synchronizing the graph', needs_attention: 'Needs attention', map: 'Evolution map ready' };

export function mountFieldResearch({ host, getCorpus, getJson, postJson, readRequest, open, showAnalysis }) {
  const startButton = document.getElementById('field-research');
  const resumeButton = document.getElementById('field-research-resume');
  const summary = host.querySelector('.field-research-summary');
  const memory = new Map();
  let sequence = 0;
  let timer;
  let selected = '';
  let latest = null;
  const storageKey = corpus => 'papernexus-field-research:' + corpus;
  const read = corpus => {
    try { return JSON.parse(localStorage.getItem(storageKey(corpus))) || memory.get(corpus); }
    catch { return memory.get(corpus); }
  };
  const save = (corpus, record) => {
    memory.set(corpus, record);
    try { localStorage.setItem(storageKey(corpus), JSON.stringify(record)); } catch { /* Session memory remains available. */ }
  };
  const pause = (close = false) => {
    sequence++; clearTimeout(timer); startButton.disabled = false;
    if (close && selected) { const record = read(selected); if (record) save(selected, { ...record, open: false }); }
    selected = ''; latest = null;
  };
  const current = (token, corpus) => token === sequence && getCorpus() === corpus;
  const render = response => {
    latest = response;
    const counts = response.imports?.counts;
    const selection = response.survey?.candidateSelection;
    const sources = response.survey?.sources || [];
    const status = response.status === 'failed' ? 'Research failed'
      : response.status === 'partial' ? 'Map ready · coverage gaps' : stages[response.stage] || response.status;
    summary.hidden = false;
    summary.innerHTML = `<div class="field-research-heading"><strong>${escape(status)}</strong><span>${escape(response.runId || '')}</span></div>
      <p>Literature search → full text → relation evidence → graph synchronization → evolution map</p>
      ${counts ? `<p>${counts.ready}/${counts.total} imports ready · ${counts.queued + counts.importing} importing · ${counts.extracting} extracting · ${counts.syncing} synchronizing · ${counts.failed} failed · ${counts.unknown} unconfirmed</p>` : '<p>The task continues on the server. You can leave this view and resume it later.</p>'}
      ${selection ? `<p>${selection.reviewedCount} candidates reviewed · ${selection.selectedCount} selected · ${selection.counts.already_indexed || 0} already indexed · ${selection.counts.budget_omitted || 0} outside the paper budget</p>` : ''}
      ${sources.length ? `<p>${sources.filter(source => source.resolutionStatus === 'fulltext_ready').length}/${sources.length} selected papers have available full text.</p>` : ''}
      ${(response.issues || []).length ? `<details open><summary>Coverage gaps and unresolved work (${response.issues.length})</summary><ul>${response.issues.map(issue => `<li>${escape(issue.message)}</li>`).join('')}</ul></details>` : ''}
      <details><summary>Search scope and sources</summary><p>${escape(response.execution?.boundary || '')}</p><p>Providers: ${escape((response.execution?.providers || []).join(', '))} · Up to ${escape(response.request?.maxPapers)} papers</p>
        <p>${escape(response.request?.query || response.request?.targetDomain || '')} · Years ${response.request?.fromYear || 'any'}–${response.request?.toYear || 'any'}</p>
        <ul>${sources.map(source => `<li>${escape(source.year || 'Undated')} · ${escape(source.title)} · ${escape(source.resolutionStatus)}</li>`).join('')}</ul></details>`;
  };
  const failure = (error, retry) => {
    summary.hidden = false;
    summary.innerHTML = `<strong>Research status unavailable</strong><p>${escape(error.message)}</p><button class="action-button" data-research-retry="${retry}">Retry ${retry === 'submit' ? 'the same request' : 'status check'}</button>`;
  };
  const poll = async (corpus, token) => {
    const record = read(corpus);
    try {
      const response = await getJson('/api/field-research?name=' + encodeURIComponent(corpus) + (record?.runId ? '&runId=' + encodeURIComponent(record.runId) : ''));
      if (!current(token, corpus)) return;
      if (response.status === 'not_found') {
        failure(new Error(record?.request ? 'This request has not been accepted by the server. Retry uses its saved request key.' : 'No research task was found for this corpus.'), record?.request ? 'submit' : 'status');
        return;
      }
      save(corpus, { ...record, runId: response.runId, request: record?.request, accepted: true, open: true });
      render(response);
      if (response.analysis) showAnalysis({ ...response.analysis, research: { ...response, analysis: undefined } }, corpus, response.request.query || response.request.targetDomain);
      else host.querySelector('.field-scope').textContent = `${corpus} · ${stages[response.stage] || response.status}`;
      if (!response.terminal) timer = setTimeout(() => poll(corpus, token), 2000);
    } catch (error) { if (current(token, corpus)) failure(error, 'status'); }
  };
  const submit = async (corpus, token) => {
    const record = read(corpus);
    startButton.disabled = true;
    summary.hidden = false;
    summary.textContent = 'Starting the saved research request…';
    try {
      const response = await postJson('/api/field-research?name=' + encodeURIComponent(corpus), record.request);
      if (read(corpus)?.runId === record.runId) save(corpus, { ...record, runId: response.runId, accepted: true, open: current(token, corpus) });
      if (!current(token, corpus)) return;
      await poll(corpus, token);
    } catch (error) { if (current(token, corpus)) failure(error, 'submit'); }
    finally { if (current(token, corpus)) startButton.disabled = false; }
  };
  const activate = corpus => {
    pause(); selected = corpus;
    open(corpus);
    summary.hidden = false;
    return sequence;
  };
  const start = () => {
    const corpus = getCorpus();
    const request = readRequest();
    if (!corpus || !request) return;
    const token = activate(corpus);
    const maxPapers = Number(document.getElementById('field-max-papers').value);
    const idempotencyKey = crypto.randomUUID();
    save(corpus, { runId: 'field-' + idempotencyKey, request: { ...request, maxPapers, idempotencyKey }, open: true, accepted: false });
    void submit(corpus, token);
  };
  const restore = (force = false) => {
    const corpus = getCorpus();
    if (!corpus) return;
    const record = read(corpus);
    if (!force && !record?.open) return;
    const token = activate(corpus);
    void poll(corpus, token);
  };
  summary.addEventListener('click', event => {
    const button = event.target.closest('[data-research-retry]');
    if (!button || !selected) return;
    if (button.dataset.researchRetry === 'submit') void submit(selected, sequence);
    else void poll(selected, sequence);
  });
  startButton.addEventListener('click', start);
  resumeButton.addEventListener('click', () => restore(true));
  return { pause, restore, getResult: () => latest };
}
