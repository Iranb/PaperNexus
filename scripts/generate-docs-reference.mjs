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

function renderExampleBlock(example, lang = 'json') {
  const label = typeof example === 'object' && example.label ? `**${example.label}**\n\n` : '';
  const value = typeof example === 'object' && Object.hasOwn(example, 'value') ? example.value : example;
  const code = lang === 'json' && typeof value !== 'string'
    ? JSON.stringify(value, null, 2)
    : String(value);
  return `${label}${fenced(code, lang)}`;
}

function renderExampleList(examples = [], lang = 'json') {
  if (!examples.length) return 'No curated examples are defined for this entry yet.\n';
  return examples.map((example) => renderExampleBlock(example, lang)).join('\n');
}

function toTitleCase(value) {
  return String(value || '')
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function unique(values = []) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && String(value).trim()))];
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

function formatSchemaType(definition = {}) {
  if (definition.oneOf) {
    return unique(definition.oneOf.map((entry) => formatSchemaType(entry))).join(' | ');
  }
  const rawType = Array.isArray(definition.type)
    ? definition.type.join(' | ')
    : definition.type;
  const type = rawType || (definition.properties ? 'object' : 'object');
  if (definition.enum) {
    return `${type} (${definition.enum.map((entry) => String(entry)).join(', ')})`;
  }
  if (type === 'array') {
    return definition.items ? `array<${formatSchemaType(definition.items)}>` : 'array';
  }
  return type;
}

function formatSchemaDescription(definition = {}) {
  const parts = [];
  if (definition.description) parts.push(definition.description);
  if (definition.default !== undefined) parts.push(`Default: \`${JSON.stringify(definition.default)}\`.`);
  if (definition.enum?.length && !String(parts.join(' ')).includes('Allowed')) {
    parts.push(`Allowed values: ${definition.enum.map((entry) => `\`${entry}\``).join(', ')}.`);
  }
  return parts.join(' ');
}

function collectSchemaRows(properties = {}, required = [], prefix = '') {
  const rows = [];
  for (const [name, definition] of Object.entries(properties || {})) {
    const fieldPath = prefix ? `${prefix}.${name}` : name;
    const isRequired = required.includes(name);
    rows.push([
      `\`${fieldPath}\``,
      isRequired ? (prefix ? 'required in parent' : 'required') : 'optional',
      formatSchemaType(definition),
      formatSchemaDescription(definition)
    ]);

    if (definition.properties) {
      rows.push(...collectSchemaRows(definition.properties, definition.required || [], fieldPath));
    }

    if (definition.items?.properties) {
      rows.push(...collectSchemaRows(definition.items.properties, definition.items.required || [], `${fieldPath}[]`));
    }

    if (definition.items?.oneOf) {
      for (const option of definition.items.oneOf) {
        if (option.properties) {
          rows.push(...collectSchemaRows(option.properties, option.required || [], `${fieldPath}[]`));
        }
      }
    }

    if (definition.oneOf) {
      for (const option of definition.oneOf) {
        if (option.properties) {
          rows.push(...collectSchemaRows(option.properties, option.required || [], fieldPath));
        }
        if (option.items?.properties) {
          rows.push(...collectSchemaRows(option.items.properties, option.items.required || [], `${fieldPath}[]`));
        }
      }
    }
  }
  return rows;
}

function renderSchemaProperties(properties = {}, required = []) {
  const rows = collectSchemaRows(properties, required);
  if (!rows.length) return 'This tool takes no arguments.\n';
  return renderTable(['Field', 'Required', 'Type', 'Description'], rows);
}

function classifyMcpTool(toolName) {
  if (['list_corpora', 'corpus_status', 'corpus_sources', 'query', 'context', 'impact', 'ideas', 'brainstorm', 'domain_distance', 'extract_takeaways', 'interdisciplinary_potential', 'research_lookup', 'research_briefing'].includes(toolName)) {
    return 'Graph & Research Lookup';
  }
  if (['import_workflow', 'literature_discovery', 'literature_discovery_progress'].includes(toolName)) {
    return 'Discovery & Imports';
  }
  if (['idea_catalyst', 'agent_materials'].includes(toolName)) {
    return 'Ideation & Agent Materials';
  }
  if (['mutate_graph', 'runtime_init', 'create_corpus', 'refresh_corpus', 'refresh_paper_graph'].includes(toolName)) {
    return 'Operations & Maintenance';
  }
  return 'Other';
}

function formatRequiredArgs(tool = {}) {
  const required = tool.inputSchema?.required || [];
  if (!required.length) return 'None';
  return required.map((name) => `\`${name}\``).join(', ');
}

const MCP_TOOL_EXAMPLES = {
  list_corpora: [
    { label: 'List all indexed corpora', value: {} }
  ],
  corpus_status: [
    { label: 'Inspect one corpus', value: { corpus: 'demo-corpus' } }
  ],
  corpus_sources: [
    { label: 'List source files known to a corpus', value: { corpus: 'demo-corpus' } }
  ],
  query: [
    {
      label: 'Search committed graph knowledge',
      value: {
        corpus: 'demo-corpus',
        query: 'open-world semi-supervised learning',
        layers: 'ProblemLayer,MethodLayer',
        limit: 5
      }
    }
  ],
  context: [
    {
      label: 'Fetch a node neighborhood',
      value: {
        corpus: 'demo-corpus',
        query: 'Office-Home dataset',
        layers: 'EvaluationLayer',
        layerMode: 'any'
      }
    }
  ],
  impact: [
    {
      label: 'Traverse upstream evidence for an anchor',
      value: {
        corpus: 'demo-corpus',
        query: 'DomainNet',
        direction: 'upstream',
        maxDepth: 2,
        layerMode: 'cross'
      }
    }
  ],
  ideas: [
    {
      label: 'Generate graph-grounded research opportunities',
      value: {
        corpus: 'demo-corpus',
        query: 'robust open-set domain adaptation',
        limit: 6
      }
    }
  ],
  brainstorm: [
    {
      label: 'Run convergent brainstorming from graph evidence',
      value: {
        corpus: 'demo-corpus',
        query: 'long-tailed recognition under domain shift',
        mode: 'converge',
        maxHops: 2,
        limit: 6
      }
    }
  ],
  domain_distance: [
    {
      label: 'Rank source domains by graph distance',
      value: {
        corpus: 'demo-corpus',
        targetDomain: 'medical imaging'
      }
    }
  ],
  extract_takeaways: [
    {
      label: 'Extract transferable takeaways for a target domain',
      value: {
        corpus: 'demo-corpus',
        targetDomain: 'robot learning',
        agnosticChallenges: ['label scarcity', 'domain shift'],
        limit: 5
      }
    }
  ],
  interdisciplinary_potential: [
    {
      label: 'Score cross-domain transfer potential',
      value: {
        corpus: 'demo-corpus',
        targetDomain: 'medical imaging',
        query: 'uncertainty-aware adaptation with scarce labels',
        agnosticChallenges: ['uncertain pseudo-labels', 'domain shift'],
        excludeProximalDomains: true,
        limit: 5
      }
    }
  ],
  research_lookup: [
    {
      label: 'Graph query through the multiplexed lookup surface',
      value: {
        corpus: 'demo-corpus',
        operation: 'query',
        query: 'graph-based semi-supervised learning',
        limit: 5
      }
    },
    {
      label: 'Precise paper lookup by DOI',
      value: {
        corpus: 'demo-corpus',
        operation: 'paper_index',
        doi: '10.48550/arXiv.2401.12345'
      }
    },
    {
      label: 'Method lineage lookup',
      value: {
        corpus: 'demo-corpus',
        operation: 'method_lineage',
        method: 'FixMatch',
        direction: 'both',
        maxDepth: 3
      }
    }
  ],
  research_briefing: [
    {
      label: 'Build a concise research brief',
      value: {
        corpus: 'demo-corpus',
        operation: 'research_brief',
        query: 'open-set domain adaptation',
        options: {
          limit: 5,
          layers: 'ProblemLayer,MethodLayer,EvidenceLayer'
        }
      }
    },
    {
      label: 'Inspect one paper enhancement bundle',
      value: {
        corpus: 'demo-corpus',
        operation: 'paper_enhancement',
        paperId: 'paper:example'
      }
    }
  ],
  import_workflow: [
    {
      label: 'Submit one server-visible file',
      value: {
        corpus: 'demo-corpus',
        operation: 'submit',
        serverFilePath: '~/papernexus-import-staging/demo/paper.pdf',
        doi: '10.48550/arXiv.2401.12345',
        sourceProvider: 'manual'
      }
    },
    {
      label: 'Check queue progress',
      value: {
        corpus: 'demo-corpus',
        operation: 'queue_progress',
        limit: 20
      }
    },
    {
      label: 'Wait for one task before graph lookup',
      value: {
        corpus: 'demo-corpus',
        operation: 'wait',
        taskId: 'imp:example',
        timeout: 1800,
        interval: 15,
        waitForAuthoritativeSync: true
      }
    }
  ],
  literature_discovery: [
    {
      label: 'Fast metadata discovery',
      value: {
        corpus: 'demo-corpus',
        operation: 'search',
        topic: 'open-world semi-supervised learning',
        searchMode: 'balanced',
        maxQueries: 4,
        maxResultsPerQuery: 10,
        maxCandidates: 20
      }
    },
    {
      label: 'Resolve sources and submit imports with progressive batching',
      value: {
        corpus: 'demo-corpus',
        operation: 'import',
        topic: 'uncertainty-aware domain adaptation',
        importResolved: true,
        processImports: true,
        importBatchEnabled: true,
        importBatchInitialTasks: 4,
        importBatchMaxTasks: 16,
        importBatchProgressive: true,
        maxImported: 8
      }
    }
  ],
  idea_catalyst: [
    {
      label: 'Graph-grounded cross-domain idea generation',
      value: {
        corpus: 'demo-corpus',
        problem: 'open-world semi-supervised learning under domain shift',
        targetDomain: 'medical imaging',
        mode: 'graph',
        numSourceDomains: 3,
        numQuestions: 4,
        outputMode: 'idea_fragments',
        limit: 8
      }
    }
  ],
  agent_materials: [
    {
      label: 'Build a graph-first research material pack',
      value: {
        corpus: 'demo-corpus',
        operation: 'research_material_pack',
        project: 'openclaw-demo',
        targetDomain: 'medical imaging',
        targetProblem: 'domain-shifted semi-supervised segmentation',
        mode: 'planning',
        roles: ['problem', 'method', 'evidence', 'dataset'],
        limit: 6
      }
    },
    {
      label: 'Read one paper material view',
      value: {
        corpus: 'demo-corpus',
        operation: 'paper_material_view',
        doi: '10.48550/arXiv.2401.12345',
        chunkLimit: 8
      }
    },
    {
      label: 'Persist workflow state for an agent project',
      value: {
        corpus: 'demo-corpus',
        operation: 'workflow_state',
        action: 'update',
        project: 'openclaw-demo',
        workflowState: {
          currentStage: 'evidence_expansion',
          openQuestions: ['Which source domains provide robust pseudo-labeling evidence?']
        }
      }
    }
  ],
  mutate_graph: [
    {
      label: 'Dry-run a curated node write',
      value: {
        corpus: 'demo-corpus',
        actor: 'docs-example',
        dryRun: true,
        operations: [
          {
            action: 'upsert_node',
            type: 'Problem',
            name: 'Label scarcity under domain shift',
            properties: {
              source: 'manual-review',
              confidence: 'moderate'
            }
          }
        ]
      }
    },
    {
      label: 'Dry-run a relationship write',
      value: {
        corpus: 'demo-corpus',
        dryRun: true,
        operations: [
          {
            action: 'upsert_relationship',
            type: 'ADDRESSES',
            source: { type: 'Method', name: 'Consistency regularization' },
            target: { type: 'Problem', name: 'Label scarcity under domain shift' },
            properties: { evidence: 'manual-review' }
          }
        ]
      }
    }
  ],
  runtime_init: [
    {
      label: 'Initialize runtime metadata without raw secrets',
      value: {
        corpus: 'demo-corpus',
        indexDir: '~/.papernexus/index-store/demo-corpus',
        sourceInputs: ['~/papers/demo-corpus'],
        serveHost: '127.0.0.1',
        servePort: 4821,
        llm: {
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          baseUrl: 'https://api.deepseek.com',
          relations: true,
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          batchSize: 1
        }
      }
    }
  ],
  create_corpus: [
    {
      label: 'Submit an asynchronous corpus build',
      value: {
        operation: 'submit',
        corpus: 'demo-corpus',
        indexDir: '~/.papernexus/index-store/demo-corpus',
        sourceInputs: ['~/papers/demo-corpus'],
        semanticExtraction: 'llm-assisted',
        llmBatchSize: 16,
        executionMode: 'async'
      }
    },
    {
      label: 'Check an async build job',
      value: {
        operation: 'status',
        jobId: 'corpus-build:example'
      }
    }
  ],
  refresh_corpus: [
    {
      label: 'Run corpus LLM optimization with max batch 16',
      value: {
        corpus: 'demo-corpus',
        mode: 'llm_optimize',
        incremental: true,
        semanticExtraction: 'llm-assisted',
        llmBatchSize: 16
      }
    },
    {
      label: 'Refresh only changed source keys',
      value: {
        corpus: 'demo-corpus',
        mode: 'optimize',
        changedSourceKeys: ['source:paper-a.pdf', 'source:paper-b.pdf'],
        batchSize: 16
      }
    }
  ],
  refresh_paper_graph: [
    {
      label: 'Force-refresh one known paper',
      value: {
        corpus: 'demo-corpus',
        paperId: 'paper:example',
        includeDuplicateGroup: true,
        rebuildPdfMarkdown: true,
        semanticExtraction: 'llm-assisted'
      }
    },
    {
      label: 'Refresh by exact title when paperId is unknown',
      value: {
        corpus: 'demo-corpus',
        paperTitle: 'Example Paper Title',
        includeDuplicateGroup: true,
        semanticExtraction: 'llm-primary'
      }
    }
  ]
};

function renderMcpReference() {
  const sections = [
    heading('MCP Tool Reference'),
    `This page is generated from ${repoFileLink('src/mcp/tools.js')}. It documents the public MCP surface that remote and local clients should rely on.\n`,
    heading('How To Read This Page', 2),
    'Each tool section lists the tool purpose first, followed by every currently exposed input field from the JSON schema and one or more copyable JSON payload examples. Nested fields use dot notation, and array item fields use `[]`, for example `operations[].action` or `llm.provider`. Fields marked `required in parent` are required only when their containing object or array item is provided.\n',
    heading('Tool Index', 2),
    renderTable(
      ['Tool', 'Area', 'Required Args', 'Description'],
      PAPERNEXUS_TOOLS.map((tool) => [
        `[\`${tool.name}\`](#tool-${tool.name})`,
        classifyMcpTool(tool.name),
        formatRequiredArgs(tool),
        tool.description
      ])
    )
  ];

  for (const tool of PAPERNEXUS_TOOLS) {
    sections.push(heading(`Tool: ${tool.name}`, 2));
    sections.push(`<a id="tool-${tool.name}"></a>\n`);
    sections.push(`**Area:** ${classifyMcpTool(tool.name)}\n`);
    sections.push(`**Required top-level arguments:** ${formatRequiredArgs(tool)}\n`);
    sections.push(heading('Function', 3));
    sections.push(`${tool.description}\n`);
    sections.push(heading('Parameters', 3));
    sections.push(renderSchemaProperties(tool.inputSchema?.properties, tool.inputSchema?.required || []));
    sections.push(heading('Examples', 3));
    sections.push(renderExampleList(MCP_TOOL_EXAMPLES[tool.name] || [], 'json'));
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

function isReferenceScriptFile(filePath) {
  if (!/\.(mjs|js|sh|py)$/.test(filePath)) return false;
  return !/ \d+\.(mjs|js|sh|py)$/.test(path.basename(filePath));
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
  const byBasename = {
    'pn_agent_materials.py': 'Skill wrapper for Agent material packs, paper views, evidence carts, and workflow overlays.',
    'pn_batch_import.py': 'Skill wrapper for manifest-based multi-paper import submission, status, and wait workflows.',
    'pn_corpus_refresh.py': 'Skill wrapper for corpus-scale materialize, analyze, LLM optimize, and optimize refresh workflows.',
    'pn_graph_query.py': 'Skill wrapper for graph query, context, impact, ideas, and brainstorm lookup.',
    'pn_idea_catalyst.py': 'Skill wrapper for one-shot cross-domain idea generation through remote MCP.',
    'pn_import_queue.py': 'Skill wrapper for import queue list, status, log, and wait operations.',
    'pn_import_submit.py': 'Skill wrapper for submitting one local or staged paper into the remote import queue.',
    'pn_main_graph_name.py': 'Skill wrapper for resolving the active live corpus name through remote MCP.',
    'pn_paper_index.py': 'Skill wrapper for precise paper lookup by DOI, arXiv ID, source key, title, or canonical id.',
    'pn_paper_refresh.py': 'Skill wrapper for force-refreshing one already-indexed paper or duplicate group.',
    'pn_research_chains.py': 'Skill wrapper for path traces, evidence chains, reflection chains, and brief retrieval.',
    'pn_stage_sync.py': 'Skill wrapper for syncing local PDFs or Markdown files to a server-visible staging path.'
  };
  if (byBasename[path.basename(relativePath)]) return byBasename[path.basename(relativePath)];
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
    .filter((filePath) => isReferenceScriptFile(filePath))
    .map((filePath) => path.relative(repoRoot, filePath));
  const skillScripts = (await walkFiles(skillRoot))
    .filter((filePath) => /\/scripts\/.*\.(py|sh|js|mjs)$/.test(filePath) && isReferenceScriptFile(filePath))
    .map((filePath) => path.relative(repoRoot, filePath));

  const scriptRows = [...scriptFiles, ...skillScripts].sort().map((relativePath) => [
    repoFileLink(relativePath),
    modulePurpose(relativePath)
  ]);

  const skillExampleRows = skillScripts
    .sort()
    .map((relativePath) => [relativePath, skillScriptExampleTemplates(relativePath)])
    .filter(([, examples]) => examples.length);

  return [
    heading('Scripts & SKILL Wrapper Reference'),
    'This page is generated from the top-level `scripts/` directory plus skill-local script wrappers under `SKILL/**/scripts`. Examples use placeholder corpus names, paper ids, and paths; replace them with values from your active PaperNexus server.\n',
    renderTable(['Script', 'Purpose'], scriptRows),
    heading('Skill Wrapper Examples', 2),
    skillExampleRows.map(([relativePath, examples]) => [
      heading(relativePath, 3),
      `${modulePurpose(relativePath)}\n`,
      renderExampleList(examples, 'bash')
    ].join('\n')).join('\n')
  ].join('\n');
}

function skillScriptExampleTemplates(relativePath) {
  const script = relativePath;
  const fileName = path.basename(relativePath);
  const templates = {
    'pn_stage_sync.py': [
      'python3 {script} --corpus "<corpus>" --ssh-target "<user@server>" --remote-dir "~/papernexus-import-staging" "/absolute/path/paper.pdf"',
      'python3 {script} --corpus "<corpus>" --mode incremental "/absolute/path/paper-folder" --json'
    ],
    'pn_import_submit.py': [
      'python3 {script} --corpus "<corpus>" --source "/absolute/path/paper.pdf" --doi "10.48550/arXiv.2401.12345"',
      'python3 {script} --corpus "<corpus>" --server-file-path "~/papernexus-import-staging/paper.pdf" --source-provider manual --json'
    ],
    'pn_import_queue.py': [
      'python3 {script} --corpus "<corpus>" list --limit 20',
      'python3 {script} --corpus "<corpus>" status --paper-id "<paperId>"',
      'python3 {script} --corpus "<corpus>" wait --paper-id "<paperId>" --timeout 1800 --interval 15'
    ],
    'pn_batch_import.py': [
      'python3 {script} template > /absolute/path/batch-import.json',
      'python3 {script} --corpus "<corpus>" --manifest "/absolute/path/batch-import.json" submit',
      'python3 {script} --corpus "<corpus>" --manifest "/absolute/path/batch-import.json" status'
    ],
    'pn_graph_query.py': [
      'python3 {script} --corpus "<corpus>" query "open-world semi-supervised learning" --limit 8',
      'python3 {script} --corpus "<corpus>" context "Office-Home dataset" --layers EvaluationLayer --layer-mode any',
      'python3 {script} --corpus "<corpus>" brainstorm "domain-shifted semi-supervised learning" --mode converge --limit 6'
    ],
    'pn_research_chains.py': [
      'python3 {script} --corpus "<corpus>" evidence-chain "open-set domain adaptation" --limit 5',
      'python3 {script} --corpus "<corpus>" reflection-chain "failed pseudo-labeling assumptions" --limit 5',
      'python3 {script} --corpus "<corpus>" paper-enhancement --paper-id "<paperId>"'
    ],
    'pn_agent_materials.py': [
      'python3 {script} --corpus "<corpus>" research-material-pack --project "<project>" --target-domain "medical imaging" --target-problem "domain-shifted semi-supervised segmentation" --limit 6',
      'python3 {script} --corpus "<corpus>" paper-material-view --doi "10.48550/arXiv.2401.12345" --chunk-limit 8',
      'python3 {script} --corpus "<corpus>" workflow-state --project "<project>" --action update --current-stage "evidence_expansion"'
    ],
    'pn_corpus_refresh.py': [
      'python3 {script} --corpus "<corpus>" --mode llm_optimize --semantic-extraction llm-assisted --llm-batch-size 16',
      'python3 {script} --corpus "<corpus>" --mode optimize --changed-source-key "<sourceKey>" --batch-size 16 --json'
    ],
    'pn_paper_index.py': [
      'python3 {script} --corpus "<corpus>" --doi "10.48550/arXiv.2401.12345"',
      'python3 {script} --corpus "<corpus>" --source-key "<sourceKey>" --json',
      'python3 {script} --corpus "<corpus>" --paper-title "Example Paper Title"'
    ],
    'pn_idea_catalyst.py': [
      'python3 {script} --corpus "<corpus>" --problem "open-world semi-supervised learning under domain shift" --target-domain "medical imaging" --mode graph --limit 8',
      'python3 {script} --corpus "<corpus>" --problem "uncertainty-aware pseudo-labeling" --target-domain "robot learning" --mode hybrid --output-mode packet_bundle --include-analysis'
    ],
    'pn_main_graph_name.py': [
      'python3 {script} --json',
      'python3 {script} --corpus "<fallback-corpus>"'
    ],
    'pn_paper_refresh.py': [
      'python3 {script} --corpus "<corpus>" --paper-id "<paperId>" --semantic-extraction llm-assisted',
      'python3 {script} --corpus "<corpus>" --paper-title "Example Paper Title" --no-rebuild-pdf-markdown'
    ]
  };
  return (templates[fileName] || []).map((template) => template.replaceAll('{script}', script));
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
      ['[Scripts & SKILL Wrapper Reference](./scripts)', 'Top-level `scripts/` and `SKILL/**/scripts`, including callable wrapper examples']
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
