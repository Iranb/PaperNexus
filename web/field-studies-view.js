const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const statusLabel = value => ({ reviewed: 'Coverage reviewed', in_progress: 'Coverage review in progress',
  needs_attention: 'Graph evidence needs attention', pending: 'Pending review', limited: 'Reviewed with gaps' }[value] || value);

export function renderFieldStudySummary(response, branchId = '') {
  const { study, coverageAssessment: coverage } = response;
  const selected = study.papers.filter(paper => paper.role !== 'excluded' && (!branchId || paper.branchIds.includes(branchId)));
  const excluded = study.papers.filter(paper => paper.role === 'excluded');
  const sourceLink = search => /^https?:\/\//.test(search.reference)
    ? `<a href="${escape(search.reference)}" target="_blank" rel="noreferrer">Source record</a>` : escape(search.reference);
  return `<div class="field-study-heading"><div><span class="field-kicker">Saved field study</span><h3>${escape(study.title)}</h3></div><span class="field-study-status">${escape(statusLabel(coverage.status))}</span></div>
    <p>${selected.length} selected papers · ${new Set(selected.flatMap(paper => paper.methodIds)).size} selected methods and variants · ${study.searches.length} recorded searches · Updated ${escape(response.updatedAt?.slice(0, 10))}</p>
    <div class="field-study-branches" role="group" aria-label="Research branches"><button type="button" class="action-button" data-study-branch="" aria-pressed="${!branchId}">All branches</button>
      ${coverage.branches.map(branch => `<button type="button" class="action-button" data-study-branch="${escape(branch.id)}" aria-pressed="${branch.id === branchId}">${escape(branch.label)} · ${branch.paperCount}</button>`).join('')}</div>
    <details class="field-study-overview"><summary>Study scope and evidence coverage</summary>
    <p>${escape(study.scope)}</p><p>${escape(coverage.summary)}</p>
    <details class="field-study-review"><summary>Branch coverage, search records and selection decisions</summary>
      ${coverage.branches.filter(branch => !branchId || branch.id === branchId).map(branch => `<article><h4>${escape(branch.label)} · ${escape(statusLabel(branch.reviewStatus))}</h4><p>${escape(branch.description)}</p><p>${escape(branch.reviewSummary)}</p><p>${branch.paperCount} papers · ${branch.methodCount} methods · ${branch.searchCount} searches</p></article>`).join('')}
      <h4>Search records</h4><ul>${study.searches.filter(search => !branchId || search.branchIds.includes(branchId)).map(search => `<li>${escape(search.query)} · ${escape(search.source)} · ${search.candidateCount} candidates · ${sourceLink(search)}</li>`).join('')}</ul>
      <h4>Selection decisions</h4><ul>${study.papers.filter(paper => !branchId || paper.branchIds.includes(branchId)).map(paper => `<li>${escape(paper.role)} · ${escape(paper.reason)} · ${escape(paper.evidenceRefs.join(' · '))}</li>`).join('')}</ul>
      <p>${excluded.length} papers excluded by the recorded selection decisions.</p></details>
    ${coverage.gaps.length ? `<details class="field-study-gaps"><summary>Known coverage and evidence gaps (${coverage.gaps.length})</summary><ul>${coverage.gaps.map(gap => `<li>${escape(gap)}</li>`).join('')}</ul></details>` : ''}
    ${coverage.nextActions.length ? `<details><summary>Remaining research</summary><ul>${coverage.nextActions.map(action => `<li>${escape(action)}</li>`).join('')}</ul></details>` : ''}</details>`;
}

export function mountFieldStudies({ host, getCorpus, getJson, open, showAnalysis }) {
  const select = document.getElementById('field-study-select');
  const button = document.getElementById('field-study-open');
  const status = document.getElementById('field-study-status');
  const summary = host.querySelector('.field-study-summary');
  let sequence = 0;
  let selectedId = '';
  let selectedCorpus = '';
  const load = async (studyId, branchId = '') => {
    const corpus = getCorpus();
    if (!corpus || !studyId) return false;
    const token = ++sequence;
    selectedId = studyId; selectedCorpus = corpus;
    button.disabled = true;
    status.textContent = 'Loading the saved study and its current graph…';
    open(corpus);
    try {
      const response = await getJson('/api/field-studies?name=' + encodeURIComponent(corpus)
        + '&studyId=' + encodeURIComponent(studyId) + (branchId ? '&branchId=' + encodeURIComponent(branchId) : ''));
      if (token !== sequence || getCorpus() !== corpus) return false;
      showAnalysis({ ...response.analysis, study: { ...response, analysis: undefined } }, corpus, response.study.title);
      summary.innerHTML = renderFieldStudySummary(response, branchId); summary.hidden = false;
      select.value = studyId;
      status.textContent = response.study.title + ' · ' + statusLabel(response.coverageAssessment.status);
      document.getElementById('topic-query').value = response.study.query;
      const url = new URL(window.location.href);
      url.searchParams.set('corpus', corpus); url.searchParams.set('study', studyId);
      if (branchId) url.searchParams.set('branch', branchId); else url.searchParams.delete('branch');
      window.history.replaceState(null, '', url);
      return true;
    } catch (error) {
      if (token !== sequence || getCorpus() !== corpus) return false;
      status.textContent = 'Study unavailable: ' + error.message;
      summary.hidden = false; summary.textContent = status.textContent;
      return false;
    } finally { if (token === sequence) button.disabled = false; }
  };
  const restore = async () => {
    const corpus = getCorpus();
    if (!corpus) return false;
    const token = ++sequence;
    try {
      const response = await getJson('/api/field-studies?name=' + encodeURIComponent(corpus));
      if (token !== sequence || getCorpus() !== corpus) return false;
      select.innerHTML = '<option value="">Choose a saved study</option>' + response.studies.map(study => `<option value="${escape(study.studyId)}">${escape(study.title)} · ${study.paperCount} papers</option>`).join('');
      button.disabled = !response.studies.length;
      status.textContent = response.studies.length ? `${response.studies.length} studies saved in this corpus.` : 'No field studies saved in this corpus.';
      const params = new URLSearchParams(window.location.search);
      const studyId = params.get('study');
      if (studyId && (!params.get('corpus') || params.get('corpus') === corpus)) {
        await load(studyId, params.get('branch') || '');
        return true;
      }
    } catch (error) {
      if (token === sequence) status.textContent = 'Saved studies unavailable: ' + error.message;
    }
    return false;
  };
  const pause = () => { sequence++; selectedId = ''; selectedCorpus = ''; summary.hidden = true; };
  const close = () => {
    pause();
    const url = new URL(window.location.href); url.searchParams.delete('study'); url.searchParams.delete('branch');
    window.history.replaceState(null, '', url);
  };
  button.addEventListener('click', () => load(select.value));
  summary.addEventListener('click', event => {
    const branch = event.target.closest('[data-study-branch]');
    if (branch && selectedId && getCorpus() === selectedCorpus) void load(selectedId, branch.dataset.studyBranch);
  });
  return { restore, pause, close };
}
