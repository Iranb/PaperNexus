import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PAPERNEXUS_TOOLS } from '../src/mcp/tools.js';
import { EDGE_TYPES, GRAPH_LAYERS, NODE_TYPES, NODE_TYPE_TO_LAYER } from '../src/core/graph/schema.js';
import { RELATION_COMPATIBILITY_RULES } from '../src/core/graph/rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const docsRoot = path.join(repoRoot, 'docs');
const generatedRoot = path.join(docsRoot, 'reference', 'generated');
const srcRoot = path.join(repoRoot, 'src');
const scriptsRoot = path.join(repoRoot, 'scripts');
const skillRoot = path.join(repoRoot, 'SKILL');
const REPO_BLOB_BASE = process.env.PAPERNEXUS_REPO_BLOB_BASE
  || 'https://github.com/papernexus/PaperNexus/blob/main/';

function heading(text, level = 1) {
  return `${'#'.repeat(level)} ${text}\n`;
}

function fenced(code, lang = '') {
  return `\`\`\`${lang}\n${String(code || '').trimEnd()}\n\`\`\`\n`;
}

function toTitleCase(value) {
  return String(value || '')
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function slugToLabel(slug) {
  return toTitleCase(slug)
    .replace(/\bLlm\b/g, 'LLM')
    .replace(/\bMcp\b/g, 'MCP')
    .replace(/\bApi\b/g, 'API')
    .replace(/\bUi\b/g, 'UI')
    .replace(/\bPm2\b/g, 'PM2');
}

function renderTable(headers, rows) {
  const escapeCell = (value) => String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const normalizedRows = rows.map((row) => row.map((cell) => escapeCell(cell)));
  const lines = [
    `| ${headers.map((header) => escapeCell(header)).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...normalizedRows.map((row) => `| ${row.join(' | ')} |`)
  ];
  return `${lines.join('\n')}\n`;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeDoc(relativePath, content) {
  const fullPath = path.join(docsRoot, relativePath);
  await ensureDir(path.dirname(fullPath));
  await fs.writeFile(fullPath, `${content.trim()}\n`, 'utf8');
}

function repoFileLink(relativePath, label = null) {
  const normalized = relativePath.replace(/\\/g, '/');
  return `[${label || `\`${normalized}\``}](${REPO_BLOB_BASE}${normalized})`;
}

function getCliHelpText() {
  return execFileSync('node', ['./src/cli/index.js', 'help'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
}

function parseCliHelp(helpText) {
  const commands = [];
  let inCommands = false;
  for (const line of helpText.split('\n')) {
    if (line.startsWith('Commands:')) {
      inCommands = true;
      continue;
    }
    if (inCommands && !line.trim()) break;
    if (!inCommands) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith('papernexus ')) continue;
    const match = trimmed.match(/^papernexus\s+([a-z0-9-]+)\b(.*)$/i);
    if (!match) continue;
    commands.push({
      name: match[1],
      synopsis: trimmed
    });
  }
  return commands;
}

const CLI_COMMAND_NOTES = {
  init: 'Interactive bootstrap for runtime config, paths, and provider setup.',
  analyze: 'Full end-to-end build for one provided corpus: materialize, optimize, build, merge, and write.',
  materialize: 'Stage 1 only: convert PDFs or cache Markdown, then write reusable snapshots.',
  'llm-optimize': 'Stage 2 only: refresh semantic extraction and relation quality without re-parsing source files.',
  'build-graph': 'Stage 3 only: project semantic snapshots into a staged multilayer graph.',
  'merge-graph': 'Stage 4 only: canonicalize near-duplicate datasets and benchmarks before commit.',
  'write-index': 'Stage 5 only: commit staged graph state, lite view, meta, and registries.',
  stage1: 'Alias for `materialize`.',
  stage2: 'Alias for `llm-optimize`.',
  stage3: 'Alias for `build-graph`.',
  stage4: 'Alias for `write-index` plus staged commit compatibility path.',
  optimize: 'Resume from existing snapshots and run stages 2-5 together.',
  watch: 'Long-running rebuild loop for already-provided paper directories.',
  probe: 'Connectivity check for the configured LLM provider.',
  clean: 'Remove or reset stored corpus state.',
  catalyst: 'Run graph-native Idea-Catalyst style interdisciplinary ideation over an indexed corpus.',
  'catalyst-backfill': 'Backfill catalyst metadata for older corpora that predate the newer graph layers.',
  'backup-export': 'Pack the current corpus environment into a portable archive.',
  'backup-unpack': 'Unpack a backup archive into an inspectable directory.',
  'backup-load': 'Restore a backup archive into a fresh output directory.',
  logs: 'Inspect local service and watch logs.',
  update: 'Self-update the repository checkout.',
  apikey: 'Store or rotate provider API keys in secure local storage.',
  setup: 'Print connection snippets and setup guidance for MCP clients.',
  serve: 'Run the browser UI, authenticated HTTP API, and remote HTTP MCP surface.',
  mcp: 'Run PaperNexus as a local stdio MCP server.'
};

function classifyCommand(commandName) {
  if (['init', 'analyze', 'optimize', 'watch', 'materialize', 'llm-optimize', 'build-graph', 'merge-graph', 'write-index', 'stage1', 'stage2', 'stage3', 'stage4'].includes(commandName)) return 'Build Pipeline';
  if (['serve', 'mcp', 'setup', 'logs'].includes(commandName)) return 'Interfaces & Services';
  if (['catalyst', 'catalyst-backfill'].includes(commandName)) return 'Idea Catalyst';
  if (['backup-export', 'backup-unpack', 'backup-load', 'clean', 'update', 'apikey', 'probe'].includes(commandName)) return 'Operations';
  return 'Other';
}

function renderCliReference() {
  const helpText = getCliHelpText();
  const commands = parseCliHelp(helpText);
  const groups = new Map();
  for (const command of commands) {
    const group = classifyCommand(command.name);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(command);
  }

  const sections = [
    heading('CLI Reference'),
    'This page is generated from the live `papernexus help` output plus a thin layer of command notes. Run `npm run docs:generate` after changing CLI behavior so the docs stay aligned with the code.\n',
    heading('Global Help Snapshot', 2),
    fenced(helpText, 'text')
  ];

  for (const [groupName, groupCommands] of groups) {
    sections.push(heading(groupName, 2));
    sections.push(renderTable(
      ['Command', 'Purpose', 'Synopsis'],
      groupCommands.map((command) => [
        `\`${command.name}\``,
        CLI_COMMAND_NOTES[command.name] || 'See synopsis and in-command help.',
        `\`${command.synopsis}\``
      ])
    ));
  }

  return sections.join('\n');
}

function renderSchemaProperties(properties = {}, required = []) {
  const rows = Object.entries(properties).map(([name, definition]) => {
    const type = definition.enum
      ? `${definition.type || 'string'} (${definition.enum.join(', ')})`
      : definition.oneOf
        ? definition.oneOf.map((entry) => entry.type || 'object').join(' | ')
        : definition.type || 'object';
    return [
      `\`${name}\``,
      required.includes(name) ? 'required' : 'optional',
      type,
      definition.description || ''
    ];
  });
  if (!rows.length) return 'This tool takes no arguments.\n';
  return renderTable(['Field', 'Required', 'Type', 'Description'], rows);
}

function renderMcpReference() {
  const sections = [
    heading('MCP Tool Reference'),
    `This page is generated from ${repoFileLink('src/mcp/tools.js')}. It documents the public MCP surface that remote and local clients should rely on.\n`,
    heading('Tool Index', 2),
    renderTable(
      ['Tool', 'Description'],
      PAPERNEXUS_TOOLS.map((tool) => [`[\`${tool.name}\`](#tool-${tool.name})`, tool.description])
    )
  ];

  for (const tool of PAPERNEXUS_TOOLS) {
    sections.push(heading(`Tool: ${tool.name}`, 2));
    sections.push(`<a id="tool-${tool.name}"></a>\n`);
    sections.push(`${tool.description}\n`);
    sections.push(heading('Input Schema', 3));
    sections.push(renderSchemaProperties(tool.inputSchema?.properties, tool.inputSchema?.required || []));
  }

  return sections.join('\n');
}

function flattenConfigEntries(obj, prefix = '') {
  const rows = [];
  for (const [key, value] of Object.entries(obj || {})) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      rows.push([`\`${nextKey}\``, 'array', `\`${JSON.stringify(value)}\``]);
    } else if (value && typeof value === 'object') {
      rows.push([`\`${nextKey}\``, 'object', 'section']);
      rows.push(...flattenConfigEntries(value, nextKey));
    } else {
      rows.push([`\`${nextKey}\``, typeof value, `\`${String(value)}\``]);
    }
  }
  return rows;
}

function renderConfigReference() {
  const config = JSON.parse(execFileSync('node', ['-e', "const fs=require('fs');process.stdout.write(fs.readFileSync('config.example.json','utf8'))"], {
    cwd: repoRoot,
    encoding: 'utf8'
  }));
  return [
    heading('Configuration Reference'),
    `This page is generated from ${repoFileLink('config.example.json')}. The example file is the maintained default source of truth for shipped runtime settings.\n`,
    heading('Example Config', 2),
    fenced(JSON.stringify(config, null, 2), 'json'),
    heading('Flattened Field Map', 2),
    renderTable(['Path', 'Type', 'Example'], flattenConfigEntries(config)),
    heading('Maintenance Notes', 2),
    '- Keep `config.example.json` updated whenever new runtime keys are introduced.\n- Run `npm run docs:generate` after changing config defaults so this page stays current.\n'
  ].join('\n');
}

function renderGraphSchemaReference() {
  const nodeRows = Object.entries(NODE_TYPES).map(([, nodeType]) => [
    `\`${nodeType}\``,
    `\`${NODE_TYPE_TO_LAYER[nodeType] || 'DocumentLayer'}\``
  ]);
  const edgeRows = Object.entries(EDGE_TYPES).map(([, edgeType]) => [`\`${edgeType}\``]);
  const compatibilityRows = RELATION_COMPATIBILITY_RULES.map((rule) => [
    `\`${rule.type}\``,
    rule.sources.map((item) => `\`${item}\``).join(', '),
    rule.targets.map((item) => `\`${item}\``).join(', ')
  ]);

  return [
    heading('Graph Schema Reference'),
    `This page is generated from ${repoFileLink('src/core/graph/schema.js')} and ${repoFileLink('src/core/graph/rules.js')}. It reflects the actual node, layer, edge, and compatibility definitions used by the graph engine.\n`,
    heading('Graph Layers', 2),
    renderTable(
      ['Layer', 'Identifier'],
      Object.entries(GRAPH_LAYERS).map(([, layer]) => [layer, `\`${layer}\``])
    ),
    heading('Node Types', 2),
    renderTable(['Node Type', 'Layer'], nodeRows),
    heading('Edge Types', 2),
    renderTable(['Edge Type'], edgeRows),
    heading('Relation Compatibility Rules', 2),
    renderTable(['Relation', 'Allowed Sources', 'Allowed Targets'], compatibilityRows)
  ].join('\n');
}

async function walkFiles(rootDir) {
  const results = [];
  async function visit(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else {
        results.push(fullPath);
      }
    }
  }
  await visit(rootDir);
  return results;
}

function modulePurpose(relativePath) {
  const direct = {
    'src/cli/index.js': 'Primary CLI entrypoint and command dispatcher.',
    'src/server/http.js': 'Authenticated HTTP server, browser UI host, and remote MCP bootstrap.',
    'src/server/api.js': 'Payload builders and request handlers behind the HTTP routes.',
    'src/mcp/server.js': 'MCP server assembly for stdio and streamable HTTP transports.',
    'src/mcp/http.js': 'Streamable HTTP MCP transport adapter and request dispatch.',
    'src/mcp/stdio.js': 'Local stdio MCP transport entrypoint.',
    'src/mcp/resources.js': 'MCP resource definitions, including domain-taxonomy style resource payloads.',
    'src/mcp/tool-idea-catalyst.js': 'Handler for the one-shot idea-catalyst MCP tool.',
    'src/mcp/tool-agent-materials.js': 'Handler for the Agent-facing material backend MCP tool.',
    'src/mcp/tool-import-workflow.js': 'Handler for submit, progress, queue, and wait operations over the import queue.',
    'src/mcp/tool-research-briefing.js': 'Typed chain and brief retrieval surface for remote callers.',
    'src/mcp/tool-research-lookup.js': 'Lookup and brainstorming surface for remote callers.',
    'src/mcp/tools.js': 'Public MCP tool catalog and input schemas.',
    'src/storage/corpus-store.js': 'Persistent corpus graph, meta, manifest, and mutation write path.',
    'src/storage/authoritative-sync-store.js': 'Persistent job queue for authoritative sync work.',
    'src/storage/enhancement-store.js': 'Persistent enhancement queue and overlay job state.',
    'src/storage/registry.js': 'Global registry of indexed corpora.',
    'src/storage/lite-view.js': 'Incremental lite-graph materialized view and token index maintenance.',
    'src/storage/import-store.js': 'Queued import task persistence, logs, progress, and queue snapshots.',
    'src/core/ingestion/pipeline.js': 'Main staged build pipeline from sources to graph commit.',
    'src/core/ingestion/pdf-parser.js': 'PDF-to-markdown parser integration layer for MarkItDown, Docling, Marker, MinerU, and related helpers.',
    'src/core/imports/worker.js': 'Asynchronous upload/import queue worker.',
    'src/core/enhancements/worker.js': 'Background enhancement worker and metadata backfill loop.',
    'src/core/authoritative-sync/worker.js': 'Authoritative sync queue processor for full graph state.',
    'src/core/search/search.js': 'Query, context, impact, idea, and brainstorming retrieval logic.',
    'src/core/materials/agent-materials.js': 'Agent-facing material pack, paper material view, source discovery plan, and import requisition assembly.',
    'src/core/materials/project-overlay.js': 'Project-level Agent overlay storage for paper roles, evidence carts, and workflow state.',
    'src/core/graph/catalyst-adapter.js': 'Idea-Catalyst graph adapter and higher-order ideation contract.',
    'src/core/graph/bridge-retrieval.js': 'Challenge-aware cross-domain bridge retrieval.',
    'src/core/graph/analogy.js': 'Structural analogy and motif matching over graph-native concepts.',
    'src/core/graph/interdisciplinary-ranking.js': 'Explainable interdisciplinary potential ranking.',
    'src/core/graph/domain-taxonomy.js': 'Graph-derived domain taxonomy and distance computation.',
    'src/core/graph/domain-bridges.js': 'Cross-domain bridge construction, takeaways, and transferable edge enrichment.',
    'src/core/graph/takeaways.js': 'Graph-native Takeaway and IdeaFragment normalization helpers.',
    'src/core/graph/research-questions.js': 'Research question normalization and graph projection helpers.',
    'src/core/graph/challenges.js': 'Challenge normalization and graph projection helpers.',
    'web/app.js': 'Single-page browser UI client logic.',
    'web/styles.css': 'Dashboard styling.',
    'scripts/install-service.sh': 'Install platform-specific background services for watch and serve.',
    'scripts/manage-service.sh': 'Inspect and control installed services on supported platforms.',
    'scripts/pm2-papernexus-serve.sh': 'Run the serve process under PM2 and inspect recent import-focused logs.',
    'scripts/markitdown_to_markdown.py': 'Standalone MarkItDown PDF-to-markdown bridge.',
    'scripts/opendataloader_pdf_to_markdown.py': 'Standalone OpenDataLoader PDF-to-markdown bridge.',
    'scripts/paddleocr_vl_to_markdown.py': 'Standalone PaddleOCR-VL PDF-to-markdown bridge.',
    'scripts/generate-docs-reference.mjs': 'Generate VitePress reference pages from code, config, and repository structure.',
    'SKILL/PaperNexus/scripts/pn_stage_sync.py': 'Canonical skill wrapper for staging local files to a remote PaperNexus server.',
    'SKILL/PaperNexus/scripts/pn_import_submit.py': 'Canonical skill wrapper for remote import submission.',
    'SKILL/PaperNexus/scripts/pn_import_queue.py': 'Canonical skill wrapper for queue status, progress, logs, and wait operations.',
    'SKILL/PaperNexus/scripts/pn_batch_import.py': 'Canonical skill wrapper for manifest-based batch imports.',
    'SKILL/PaperNexus/scripts/pn_graph_query.py': 'Canonical skill wrapper for remote query, context, impact, ideas, and brainstorming.',
    'SKILL/PaperNexus/scripts/pn_research_chains.py': 'Canonical skill wrapper for evidence, reflection, and research brief retrieval.',
    'SKILL/PaperNexus/scripts/pn_agent_materials.py': 'Canonical skill wrapper for read-only Agent material packs and paper material views.',
    'SKILL/PaperNexusMainGraphName/scripts/pn_main_graph_name.py': 'Resolve the current live corpus name through remote HTTP MCP.',
    'SKILL/PaperNexusIdeaCatalyst/scripts/pn_idea_catalyst.py': 'Run one-shot cross-domain ideation through the remote MCP surface.'
  };
  if (direct[relativePath]) return direct[relativePath];
  const fileName = path.basename(relativePath, path.extname(relativePath));
  return `${slugToLabel(fileName)} implementation.`;
}

async function renderModuleMapReference() {
  const roots = ['src/cli', 'src/mcp', 'src/server', 'src/storage', 'src/core', 'web'];
  const sections = [
    heading('Module Map Reference'),
    'This page is generated from the repository file tree. It is intended as a system map for maintainers who need to find where a behavior actually lives.\n'
  ];

  for (const root of roots) {
    const fullRoot = path.join(repoRoot, root);
    const files = (await walkFiles(fullRoot)).map((filePath) => path.relative(repoRoot, filePath));
    sections.push(heading(slugToLabel(root.replace(/^src\//, '').replace(/\//g, ' ')), 2));
    sections.push(renderTable(
      ['File', 'Responsibility'],
      files.map((relativePath) => [repoFileLink(relativePath), modulePurpose(relativePath)])
    ));
  }

  return sections.join('\n');
}

async function renderScriptsReference() {
  const scriptFiles = (await walkFiles(scriptsRoot))
    .filter((filePath) => /\.(mjs|js|sh|py)$/.test(filePath))
    .map((filePath) => path.relative(repoRoot, filePath));
  const skillScripts = (await walkFiles(skillRoot))
    .filter((filePath) => /\/scripts\/.*\.(py|sh|js|mjs)$/.test(filePath))
    .map((filePath) => path.relative(repoRoot, filePath));

  const scriptRows = [...scriptFiles, ...skillScripts].sort().map((relativePath) => [
    repoFileLink(relativePath),
    modulePurpose(relativePath)
  ]);

  return [
    heading('Scripts Reference'),
    'This page is generated from the top-level `scripts/` directory plus skill-local script wrappers under `SKILL/**/scripts`.\n',
    renderTable(['Script', 'Purpose'], scriptRows)
  ].join('\n');
}

function parseHttpRoutes(sourceText) {
  const routes = [];
  const routePattern = /request\.method === '([A-Z]+)'\s*&&\s*url\.pathname === '([^']+)'/g;
  let match;
  while ((match = routePattern.exec(sourceText)) !== null) {
    routes.push({ method: match[1], path: match[2] });
  }
  return routes;
}

async function renderHttpServeReference() {
  const source = await fs.readFile(path.join(srcRoot, 'server', 'http.js'), 'utf8');
  const routes = parseHttpRoutes(source);
  return [
    heading('HTTP Serve Reference'),
    `This page is generated from route declarations in ${repoFileLink('src/server/http.js')}. It focuses on the authenticated HTTP server rather than the preferred remote MCP control plane.\n`,
    heading('Routes', 2),
    renderTable(
      ['Method', 'Path'],
      routes.map((route) => [`\`${route.method}\``, `\`${route.path}\``])
    ),
    heading('Notes', 2),
    '- All `/api/*` routes require the configured bearer token.\n- Live graph automation should prefer the remote HTTP MCP surface at `/mcp` even when these routes exist.\n'
  ].join('\n');
}

async function renderGeneratedIndex() {
  return [
    heading('Generated Reference Pages'),
    'These pages are rebuilt by `npm run docs:generate` and should not be edited directly. Update the source code or the generator script instead.\n',
    renderTable(['Page', 'Source Of Truth'], [
      ['[CLI Reference](./cli)', '`papernexus help` output plus curated command notes'],
      ['[MCP Tool Reference](./mcp-tools)', '`src/mcp/tools.js`'],
      ['[Configuration Reference](./config)', '`config.example.json`'],
      ['[Graph Schema Reference](./graph-schema)', '`src/core/graph/schema.js` and `src/core/graph/rules.js`'],
      ['[HTTP Serve Reference](./http-serve)', '`src/server/http.js` route declarations'],
      ['[Module Map Reference](./module-map)', 'Repository source tree under `src/` and `web/`'],
      ['[Scripts Reference](./scripts)', 'Top-level `scripts/` and `SKILL/**/scripts`']
    ])
  ].join('\n');
}

async function main() {
  await ensureDir(generatedRoot);
  await writeDoc('reference/generated/index.md', await renderGeneratedIndex());
  await writeDoc('reference/generated/cli.md', renderCliReference());
  await writeDoc('reference/generated/mcp-tools.md', renderMcpReference());
  await writeDoc('reference/generated/config.md', renderConfigReference());
  await writeDoc('reference/generated/graph-schema.md', renderGraphSchemaReference());
  await writeDoc('reference/generated/module-map.md', await renderModuleMapReference());
  await writeDoc('reference/generated/scripts.md', await renderScriptsReference());
  await writeDoc('reference/generated/http-serve.md', await renderHttpServeReference());
  process.stdout.write('Generated PaperNexus reference docs.\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
