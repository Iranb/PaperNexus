import { truncate } from './utils.js';

export function renderCorpusList(items) {
  if (!items.length) {
    return 'No indexed corpora found. Run `papernexus analyze <path>` first.';
  }

  const lines = ['Indexed corpora:'];
  for (const item of items) {
    const updated = item.indexedAt ? new Date(item.indexedAt).toLocaleString() : 'unknown';
    lines.push(`- ${item.name}: ${item.rootPath} (${item.paperCount || 0} papers, updated ${updated})`);
  }
  return lines.join('\n');
}

export function renderStatus(meta) {
  const lines = [
    `Corpus: ${meta.name}`,
    `Root: ${meta.rootPath}`,
    `Indexed at: ${meta.indexedAt}`,
    `Papers: ${meta.paperCount}`,
    `Nodes: ${meta.nodeCount}`,
    `Relationships: ${meta.relationshipCount}`,
    `Source mode: ${meta.sourceMode}`
  ];

  if (meta.buildMode) {
    lines.push(`Build mode: ${meta.buildMode}`);
  }

  if (meta.graphMode) {
    lines.push(`Graph mode: ${meta.graphMode}`);
  }

  if (meta.storageMode) {
    lines.push(`Storage mode: ${meta.storageMode}`);
  }

  if (meta.sourceCount !== undefined) {
    lines.push(`Tracked sources: ${meta.sourceCount}`);
  }

  if (meta.pdfParser) {
    lines.push(`PDF parser: ${meta.pdfParser}`);
  }

  if (meta.semanticExtractionMode) {
    lines.push(`Semantic extraction: ${meta.semanticExtractionMode}`);
  }

  const topFocus = meta.topProblems || meta.topDomains;
  if (topFocus?.length) {
    lines.push(`Top problems: ${topFocus.slice(0, 10).join(', ')}`);
  }

  if (meta.lastChangeSummary) {
    lines.push(
      `Last change summary: ${meta.lastChangeSummary.added} added, ${meta.lastChangeSummary.updated} updated, ${meta.lastChangeSummary.removed} removed, ${meta.lastChangeSummary.reused} reused`
    );
  }

  if (meta.lastMutationSummary) {
    lines.push(
      `Last mutation summary: +${meta.lastMutationSummary.nodesCreated} nodes, ~${meta.lastMutationSummary.nodesUpdated} nodes, -${meta.lastMutationSummary.nodesDeleted} nodes, +${meta.lastMutationSummary.relationshipsCreated} relationships, ~${meta.lastMutationSummary.relationshipsUpdated} relationships, -${meta.lastMutationSummary.relationshipsDeleted} relationships`
    );
  }

  if (meta.llm?.enabled) {
    if (meta.llm.providers?.length) {
      lines.push(`LLM providers: ${meta.llm.providers.join(', ')}`);
    }
    lines.push(`LLM relations: ${meta.llm.relationCount || 0}`);
    if (meta.llm.crossPaperAccepted !== undefined) {
      lines.push(`Cross-paper LLM edges: ${meta.llm.crossPaperAccepted}`);
    }
  }

  if (meta.llm?.semanticExtraction) {
    const extraction = meta.llm.semanticExtraction;
    lines.push(
      `LLM semantic extraction: ${extraction.participatedPaperCount || 0} participated, ${extraction.skippedPaperCount || 0} skipped`
    );
    if (extraction.effectiveModes && Object.keys(extraction.effectiveModes).length) {
      lines.push(
        `LLM semantic modes: ${Object.entries(extraction.effectiveModes).map(([mode, count]) => `${mode} ${count}`).join(', ')}`
      );
    }
  }

  if (meta.failedSourceCount) {
    lines.push(`Failed sources: ${meta.failedSourceCount}`);
  }

  if (meta.layers && Object.keys(meta.layers).length) {
    lines.push(`Layers: ${Object.entries(meta.layers).map(([layer, count]) => `${layer} ${count}`).join(', ')}`);
  }

  return lines.join('\n');
}

export function renderQueryResult(result) {
  if (!result.groups.length) {
    return `No graph matches found for "${result.query}".`;
  }

  const lines = [`Results for "${result.query}":`];
  for (const group of result.groups) {
    lines.push(`- ${group.title} (${group.scope}, ${group.matchCount} matches, score ${group.score.toFixed(2)})`);
    for (const match of group.matches) {
      lines.push(`  • ${match.nodeType}: ${match.nodeName}`);
      lines.push(`    ${truncate(match.excerpt, 180)}`);
    }
  }
  return lines.join('\n');
}

export function renderBrainstormResult(result) {
  const lines = [`Brainstorm for "${result.query}"`, `Mode: ${result.mode}`, `Explored hops: ${result.exploredHops}`];

  if (result.seedPapers?.length) {
    lines.push(`Seed papers: ${result.seedPapers.map((paper) => paper.title).join('; ')}`);
  }

  if (result.seedNodes?.length) {
    lines.push(`Seed nodes: ${result.seedNodes.map((node) => `${node.type}: ${node.name}`).join('; ')}`);
  }

  const sections = [
    ['Similar problems', result.similarProblems, (item) => `${item.name}${item.layer ? ` (${item.layer})` : ''}${item.support ? ` · ${item.support} papers` : ''}${item.via ? ` via ${item.via}` : ''}`],
    ['Related concepts', result.relatedConcepts, (item) => `${item.type}: ${item.name}${item.layer ? ` (${item.layer})` : ''}${item.via ? ` via ${item.via}` : ''}`],
    ['Potential constraints', result.potentialConstraints, (item) => `${item.type}: ${item.name}${item.layer ? ` (${item.layer})` : ''}${item.via ? ` via ${item.via}` : ''}`],
    ['Transferable methods', result.transferableMethods, (item) => `${item.name}${item.layer ? ` (${item.layer})` : ''}${item.paperCount ? ` · ${item.paperCount} papers` : ''}`],
    ['Combinable methods', result.combinableMethods, (item) => `${item.name}${item.layer ? ` (${item.layer})` : ''}${item.paperCount ? ` · ${item.paperCount} papers` : ''}`]
  ];

  for (const [label, items, formatItem] of sections) {
    if (!items?.length) continue;
    lines.push(`${label}:`);
    for (const item of items.slice(0, 8)) {
      lines.push(`- ${formatItem(item)}`);
    }
  }

  if (result.mode === 'converge') {
    if (result.convergedDirections?.length) {
      lines.push('Converged directions:');
      for (const [index, direction] of result.convergedDirections.entries()) {
        lines.push(`${index + 1}. ${direction.title}${direction.score ? ` (score ${direction.score.toFixed(2)})` : ''}`);
        lines.push(`   ${truncate(direction.summary, 220)}`);
        if (direction.focus?.length) {
          lines.push(`   Focus: ${direction.focus.join(', ')}`);
        }
        if (direction.evidencePapers?.length) {
          lines.push(`   Evidence papers: ${direction.evidencePapers.join('; ')}`);
        }
      }
    }

    if (result.ideas?.length) {
      lines.push('Idea candidates:');
      for (const [index, idea] of result.ideas.entries()) {
        lines.push(`${index + 1}. ${idea.title} (${idea.template}, score ${idea.totalScore.toFixed(2)})`);
        lines.push(`   ${truncate(idea.summary, 220)}`);
      }
    }
  }

  if (lines.length === 3) {
    lines.push('No brainstorming branches found. Try a broader topic, larger hop count, or index more papers first.');
  }

  return lines.join('\n');
}

export function renderIdeasResult(result) {
  if (!result.ideas?.length) {
    return `No research opportunities found for "${result.query}". Try a broader topic or index more papers first.`;
  }

  const lines = [`Research opportunities for "${result.query}":`];

  if (result.seedPapers?.length) {
    lines.push(`Seed papers: ${result.seedPapers.map((paper) => paper.title).join('; ')}`);
  }

  if (result.seedProblems?.length) {
    lines.push(`Seed problems: ${result.seedProblems.map((problem) => problem.name).join(', ')}`);
  }

  for (const [index, idea] of result.ideas.entries()) {
    lines.push(`${index + 1}. ${idea.title} (${idea.template}, score ${idea.totalScore.toFixed(2)})`);
    lines.push(`   ${truncate(idea.summary, 220)}`);

    if (idea.methodNames?.length) {
      lines.push(`   Methods: ${idea.methodNames.join(', ')}`);
    }

    if (idea.problemNames?.length) {
      lines.push(`   Problems: ${idea.problemNames.join(', ')}`);
    }

    if (idea.limitationNames?.length) {
      lines.push(`   Limitations: ${idea.limitationNames.join(', ')}`);
    }

    if (idea.supportingPapers?.length) {
      lines.push(`   Evidence papers: ${idea.supportingPapers.join('; ')}`);
    }

    lines.push(
      `   Scores: relevance ${idea.scores.relevance.toFixed(1)}, novelty ${idea.scores.novelty.toFixed(1)}, feasibility ${idea.scores.feasibility.toFixed(1)}, evidence ${idea.scores.evidence.toFixed(1)}, risk ${idea.scores.risk.toFixed(1)}, cost ${idea.scores.cost.toFixed(1)}`
    );
  }

  return lines.join('\n');
}

export function renderContextResult(result) {
  if (result.candidates?.length) {
    const lines = [`Multiple matches for "${result.query}":`];
    for (const candidate of result.candidates) {
      lines.push(`- ${candidate.type}: ${candidate.name} (${candidate.id})`);
    }
    return lines.join('\n');
  }

  if (!result.node) {
    return `No node found for "${result.query}".`;
  }

  const lines = [
    `${result.node.type}: ${result.node.name}`,
    `ID: ${result.node.id}`
  ];

  if (result.node.properties?.layer) {
    lines.push(`Layer: ${result.node.properties.layer}`);
  }

  if (result.node.properties?.paperTitle) {
    lines.push(`Paper: ${result.node.properties.paperTitle}`);
  }

  if (result.node.properties?.paperTitles?.length) {
    lines.push(`Shared across: ${result.node.properties.paperTitles.length} papers`);
  }

  if (result.node.properties?.sourcePath) {
    lines.push(`Source: ${result.node.properties.sourcePath}`);
  }

  if (result.node.properties?.text) {
    lines.push(`Excerpt: ${truncate(result.node.properties.text, 240)}`);
  }

  if (result.outgoing.length) {
    lines.push('Outgoing:');
    for (const item of result.outgoing.slice(0, 12)) {
      lines.push(`- ${item.type} -> ${item.targetName} (${item.targetType}${item.targetLayer ? ` · ${item.targetLayer}` : ''})`);
    }
  }

  if (result.incoming.length) {
    lines.push('Incoming:');
    for (const item of result.incoming.slice(0, 12)) {
      lines.push(`- ${item.type} <- ${item.sourceName} (${item.sourceType}${item.sourceLayer ? ` · ${item.sourceLayer}` : ''})`);
    }
  }

  return lines.join('\n');
}

export function renderImpactResult(result) {
  if (!result.node) {
    return `No node found for "${result.query}".`;
  }

  if (!result.byDepth.length) {
    return `No ${result.direction} impact found for ${result.node.name}.`;
  }

  const lines = [
    `Impact for ${result.node.name}`,
    `Direction: ${result.direction}`,
    `Risk: ${result.risk}`
  ];

  for (const bucket of result.byDepth) {
    lines.push(`Depth ${bucket.depth}:`);
    for (const item of bucket.nodes.slice(0, 12)) {
      lines.push(`- ${item.type}: ${item.name}${item.layer ? ` (${item.layer})` : ''} via ${item.via.join(', ')}`);
    }
  }

  return lines.join('\n');
}

export function renderMutationResult(result) {
  const lines = [
    `Graph mutation ${result.dryRun ? 'preview' : 'applied'} for "${result.corpusName}"`,
    `Root: ${result.rootPath}`,
    `Actor: ${result.actor}`,
    `Operations: ${result.operationsCount}`,
    `Nodes: ${result.countsBefore.nodes} -> ${result.countsAfter.nodes}`,
    `Relationships: ${result.countsBefore.relationships} -> ${result.countsAfter.relationships}`,
    `Summary: +${result.summary.nodesCreated} nodes, ~${result.summary.nodesUpdated} nodes, -${result.summary.nodesDeleted} nodes, +${result.summary.relationshipsCreated} relationships, ~${result.summary.relationshipsUpdated} relationships, -${result.summary.relationshipsDeleted} relationships`
  ];

  if (result.results?.length) {
    lines.push('Results:');
    for (const item of result.results) {
      lines.push(`- [${item.action}] ${item.message}`);
      if (item.label) {
        lines.push(`  ${item.label}`);
      }
      if (item.id) {
        lines.push(`  ID: ${item.id}`);
      }
    }
  }

  return lines.join('\n');
}

export function renderNodeList(label, nodes) {
  if (!nodes.length) {
    return `No ${label.toLowerCase()} found.`;
  }

  const lines = [`${label}:`];
  for (const node of nodes.slice(0, 80)) {
    if (node.properties?.paperTitle) {
      lines.push(`- ${node.name} (${node.properties.paperTitle})`);
      continue;
    }

    if (Array.isArray(node.properties?.paperTitles) && node.properties.paperTitles.length) {
      lines.push(`- ${node.name} (${node.properties.paperTitles.length} papers)`);
      continue;
    }

    lines.push(`- ${node.name}`);
  }
  return lines.join('\n');
}
