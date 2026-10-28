const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const stages = { queued: '排队中', review: '提取与审查', plan: '分析证据缺口', supplement: '检索与导入', done: '处理完成' };
const issueLabels = {
  missing_bottleneck: '缺少瓶颈或采用理由', missing_mechanismEvidence: '缺少机制解释', missing_tradeoff: '缺少条件或代价',
  bottleneck_repeats_mechanism: '瓶颈说明与机制重复', unmatched_bottleneck_quote: '瓶颈引句未匹配',
  unmatched_mechanismEvidence_quote: '机制引句未匹配', unmatched_tradeoff_quote: '条件或代价引句未匹配',
  child_method_not_supported: '后继方法尚未得到支持', parent_identity_ambiguous: '前驱论文身份存在歧义',
  parent_identity_unresolved: '前驱论文尚未解析', parent_source_unavailable: '前驱原文不可用',
  relation_quote_unmatched: '关系引句未匹配', parent_method_unverified: '前驱方法尚未确认', self_relation: '关系两端是同一方法',
  relation_context_mismatch: '原文语境不支持这类关系', relation_attribution_mismatch: '关系归属不一致',
  relation_not_established: '关系仍是假设或已被否定', direction_unconfirmed: '关系方向尚未确认',
  source_or_processing_failed: '来源读取或处理失败', no_supported_direct_relation: '缺少有证据的直接关系',
  relation_blocked: '关系尚不能发布', explanation_incomplete: '解释证据待补充'
};
const issueLabel = value => issueLabels[value] || value;

export function renderLineageRefinement(response) {
  const counts = response.counts || {};
  const relations = (response.entries || []).flatMap(entry => (entry.review?.relations || []).map(relation => ({ ...relation, paperId: entry.selection.paperId })));
  return `<p><strong>${escape(stages[response.stage] || response.status)}</strong> · ${escape(response.status)} · ${escape(response.runId)}</p>
    <p>已审查 ${counts.reviewed || 0}/${counts.selected || 0} 篇 · 可发布 ${counts.publishable || 0} 条 · 拒绝 ${counts.rejected || 0} 条 · 待解决 ${counts.uncertainOrBlocked || 0} 条 · 处理失败 ${counts.failed || 0} 篇</p>
    <p>累计检索 ${response.budget?.queries || 0}/${response.request?.maxQueries || 0} 次 · 新论文 ${response.budget?.newPapers || 0}/${response.request?.maxNewPapers || 0} 篇 · 未选入 ${response.omittedPaperCount || 0} 篇</p>
    <p>模型审查用于核对原文。处理完成不代表领域覆盖完整或科学结论已验证。</p>
    ${response.error ? `<p role="alert">${escape(response.error)}</p>` : ''}
    <details><summary>逐条裁决与解释（${relations.length}）</summary>${relations.map(relation => `<article class="field-evidence">
      <strong>${escape(relation.candidate.parentMethod)} → ${escape(relation.candidate.childMethod)}</strong>
      <p>${relation.publishable ? '支持发布' : '暂不发布'} · 模型裁决：${escape(relation.modelDecision)} · ${escape(relation.reason)}</p>
      <p>${escape(relation.blockers.map(issueLabel).join(' · '))}</p><blockquote>${escape(relation.exactQuote)}</blockquote>
      <dl>${[['瓶颈或采用理由', relation.bottleneck], ['机制', relation.mechanismEvidence], ['条件与代价', relation.tradeoff]]
        .map(([label, explanation]) => `<dt>${label}</dt><dd>${explanation ? `${escape(explanation.text)}<blockquote>${escape(explanation.exactQuote)}</blockquote><small>${escape(explanation.attribution)} · ${escape(explanation.epistemicStatus)}</small>` : '未知：当前没有足够原文证据'}</dd>`).join('')}</dl>
      <p>${escape(relation.explanationIssues.map(issueLabel).join(' · '))}</p></article>`).join('') || '<p>没有关系候选。</p>'}</details>
    <details><summary>证据缺口（${response.gaps?.length || 0}）</summary><ul>${(response.gaps || []).map(gap => `<li>${escape(gap.paperId)} · ${escape(gap.method || gap.parent || issueLabel(gap.kind))} · ${escape(gap.reason || gap.reasons?.map(issueLabel).join(', ') || issueLabel(gap.kind))}</li>`).join('')}</ul></details>`;
}

export function mountLineageRefinement({ host, getCorpus, getSelection, getJson, postJson, onPublished }) {
  const panel = host.querySelector('.lineage-refinement');
  panel.innerHTML = `<summary>完善谱系证据</summary><p>审查当前研究或图中论文。补查预算为 0 时，只处理现有来源。</p>
    <div class="lineage-refinement-budget"><label>论文数上限<input name="maxPapers" aria-label="审查论文数上限" type="number" min="1" max="100" value="20"/></label>
    <label>检索次数<input name="maxQueries" aria-label="补查检索次数" type="number" min="0" max="8" value="0"/></label>
    <label>新增论文数<input name="maxNewPapers" aria-label="新增论文数" type="number" min="0" max="20" value="0"/></label>
    <label>补查轮数<input name="maxRounds" aria-label="补查轮数" type="number" min="1" max="3" value="1"/></label></div>
    <div class="lineage-refinement-actions"><button class="action-button" data-refine="start">开始审查</button>
    <button class="action-button" data-refine="resume">读取上次任务</button><button class="action-button" data-refine="retry" hidden>重试未完成项</button>
    <button class="action-button" data-refine="preview" hidden>预览发布</button><button class="action-button" data-refine="apply" hidden>发布到图谱</button>
    <button class="action-button" data-refine="revoke" hidden>预览撤回</button></div>
    <div class="lineage-refinement-status" role="status" aria-live="polite"></div><div class="lineage-publication-preview"></div>`;
  const status = panel.querySelector('.lineage-refinement-status'), preview = panel.querySelector('.lineage-publication-preview');
  const storageKey = corpus => 'papernexus-lineage-refinement:' + corpus;
  const memory = new Map();
  let timer, sequence = 0, latest = null, staged = null, busy = false;
  const read = corpus => { try { return JSON.parse(localStorage.getItem(storageKey(corpus))) || memory.get(corpus); } catch { return memory.get(corpus); } };
  const save = (corpus, value) => { memory.set(corpus, value); try { localStorage.setItem(storageKey(corpus), JSON.stringify(value)); } catch { /* Keep the request in this session. */ } };
  const current = (corpus, token) => getCorpus() === corpus && token === sequence;
  const buttons = () => {
    panel.querySelectorAll('button').forEach(button => { button.disabled = busy; });
    panel.querySelector('[data-refine="retry"]').hidden = !(read(getCorpus())?.request && (!latest || latest.terminal && ['failed', 'partial'].includes(latest.status)));
    panel.querySelector('[data-refine="retry"]').textContent = latest ? '重试未完成项' : '重试原请求';
    panel.querySelector('[data-refine="preview"]').hidden = !latest?.terminal;
    panel.querySelector('[data-refine="apply"]').hidden = !staged;
    panel.querySelector('[data-refine="apply"]').textContent = staged?.revoke ? '撤回本次发布' : '发布到图谱';
    panel.querySelector('[data-refine="revoke"]').hidden = !read(getCorpus())?.published;
  };
  const poll = async (corpus, token) => {
    const record = read(corpus);
    if (!record?.runId) { status.textContent = '当前语料没有保存的审查任务。'; return; }
    try {
      const response = await getJson('/api/lineage-refinement?name=' + encodeURIComponent(corpus) + '&runId=' + encodeURIComponent(record.runId));
      if (!current(corpus, token)) return;
      latest = response; status.innerHTML = renderLineageRefinement(response); buttons();
      if (!response.terminal) timer = setTimeout(() => poll(corpus, token), 2000);
    } catch (error) { if (current(corpus, token)) { status.textContent = error.message; buttons(); } }
  };
  const pause = () => { sequence++; clearTimeout(timer); busy = false; latest = null; staged = null; buttons(); };
  const restore = () => { pause(); preview.innerHTML = ''; if (read(getCorpus())) void poll(getCorpus(), sequence); else status.textContent = ''; };
  const submit = async (corpus, token, retryFailed = false) => {
    const record = read(corpus);
    const response = await postJson('/api/lineage-refinement?name=' + encodeURIComponent(corpus), { ...record.request, ...(retryFailed ? { retryFailed: true } : {}) });
    save(corpus, { ...record, runId: response.runId });
    if (current(corpus, token)) await poll(corpus, token);
  };
  panel.addEventListener('click', async event => {
    const action = event.target.closest('[data-refine]')?.dataset.refine;
    if (!action || busy) return;
    const corpus = getCorpus();
    if (!corpus) return;
    clearTimeout(timer); const token = ++sequence; busy = true; buttons();
    try {
      if (action === 'start') {
        const selection = getSelection();
        if (!selection?.studyId && !selection?.papers?.length) throw new Error('请先打开一个研究或包含论文的领域图。');
        const budget = Object.fromEntries(['maxPapers', 'maxQueries', 'maxNewPapers', 'maxRounds'].map(name => [name, Number(panel.querySelector(`[name="${name}"]`).value)]));
        const idempotencyKey = crypto.randomUUID();
        const request = { ...selection, ...budget, idempotencyKey };
        await postJson('/api/lineage-refinement?name=' + encodeURIComponent(corpus), { ...request, dryRun: true });
        if (!current(corpus, token)) return;
        save(corpus, { request, runId: 'refine-' + idempotencyKey, requestId: idempotencyKey, published: false });
        latest = null; staged = null; preview.innerHTML = ''; await submit(corpus, token);
      } else if (action === 'resume') await poll(corpus, token);
      else if (action === 'retry') { staged = null; await submit(corpus, token, true); }
      else {
        const record = read(corpus);
        if (!record) throw new Error('没有可发布的审查任务。');
        const request = action === 'apply' ? staged : { runId: record.runId, requestId: record.requestId, apply: false, ...(action === 'revoke' ? { revoke: true } : {}) };
        if (!request) return;
        const response = await postJson('/api/lineage-publication?name=' + encodeURIComponent(corpus), { ...request, apply: action === 'apply' });
        if (!current(corpus, token)) return;
        preview.innerHTML = `<p><strong>${response.applied ? response.revoke ? '已撤回发布' : '发布记录已保存' : response.revoke ? '撤回预览' : '发布预览'}</strong> · ${response.items?.length || 0} 条 · ${response.excluded?.length || 0} 条排除 · ${response.duplicates?.length || 0} 条已存在</p>
          <ul>${(response.excluded || []).map(item => `<li>${escape(item.paperId)} · ${escape(item.reason)}</li>`).join('')}${(response.projection || []).map(item => `<li>${escape(item.status)} · ${escape(item.entityIds?.join(', ') || '')}</li>`).join('')}</ul>`;
        staged = response.applied || response.status === 'revoked' ? null : { ...request, apply: true };
        if (response.applied) {
          save(corpus, { ...record, published: !response.revoke });
          await onPublished?.();
        }
      }
    } catch (error) { if (current(corpus, token)) status.textContent = error.message; }
    finally { if (current(corpus, token)) { busy = false; buttons(); } }
  });
  buttons();
  return { pause, restore };
}
