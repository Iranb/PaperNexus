const NODE_COLORS = {
  Corpus: '#8b5cf6',
  Paper: '#38bdf8',
  Problem: '#f43f5e',
  Method: '#22c55e',
  Claim: '#0ea5e9',
  Finding: '#06b6d4',
  Limitation: '#fb7185',
  Assumption: '#f59e0b',
  Evidence: '#14b8a6',
  Dataset: '#facc15',
  Benchmark: '#eab308',
  Metric: '#a78bfa',
  FutureDirection: '#e879f9'
};

const LAYER_COLORS = {
  CorpusLayer: '#8b5cf6',
  DocumentLayer: '#38bdf8',
  ProblemLayer: '#fb7185',
  MethodLayer: '#22c55e',
  ClaimLayer: '#0ea5e9',
  ConstraintLayer: '#f59e0b',
  EvidenceLayer: '#14b8a6',
  EvaluationLayer: '#facc15',
  FutureLayer: '#e879f9'
};

const TYPE_TO_LAYER = {
  Corpus: 'CorpusLayer',
  Paper: 'DocumentLayer',
  Problem: 'ProblemLayer',
  Method: 'MethodLayer',
  Claim: 'ClaimLayer',
  Finding: 'ClaimLayer',
  Limitation: 'ConstraintLayer',
  Assumption: 'ConstraintLayer',
  Evidence: 'EvidenceLayer',
  Dataset: 'EvaluationLayer',
  Benchmark: 'EvaluationLayer',
  Metric: 'EvaluationLayer',
  FutureDirection: 'FutureLayer'
};

const EDGE_COLORS = {
  CONTAINS: 'rgba(148, 163, 184, 0.24)',
  SOLVES: 'rgba(244, 63, 94, 0.4)',
  USES: 'rgba(245, 158, 11, 0.4)',
  EVALUATES_ON: 'rgba(250, 204, 21, 0.36)',
  BENCHMARKED_ON: 'rgba(234, 179, 8, 0.34)',
  REPORTS: 'rgba(167, 139, 250, 0.38)',
  REPORTS_FINDING: 'rgba(6, 182, 212, 0.36)',
  CLAIMS: 'rgba(14, 165, 233, 0.36)',
  HAS_LIMITATION: 'rgba(251, 113, 133, 0.36)',
  ASSUMES: 'rgba(245, 158, 11, 0.34)',
  SUGGESTS_FUTURE: 'rgba(232, 121, 249, 0.36)',
  SUPPORTED_BY: 'rgba(20, 184, 166, 0.42)',
  OBSERVED_ON: 'rgba(250, 204, 21, 0.34)',
  MEASURED_BY: 'rgba(167, 139, 250, 0.38)',
  APPLIES_TO: 'rgba(34, 197, 94, 0.34)',
  TRANSFERABLE_TO: 'rgba(74, 222, 128, 0.34)',
  REQUIRES: 'rgba(245, 158, 11, 0.3)',
  DEPENDS_ON: 'rgba(251, 191, 36, 0.28)',
  FAILS_UNDER: 'rgba(251, 113, 133, 0.28)',
  HAS_GAP: 'rgba(251, 113, 133, 0.32)',
  RELATED_TO: 'rgba(124, 58, 237, 0.38)',
  SIMILAR_TO: 'rgba(59, 130, 246, 0.32)',
  COMPATIBLE_WITH: 'rgba(34, 197, 94, 0.28)',
  COMBINES_WITH: 'rgba(16, 185, 129, 0.28)',
  MAY_BE_ADDRESSED_BY: 'rgba(16, 185, 129, 0.34)',
  CONTRADICTS: 'rgba(239, 68, 68, 0.38)',
  CITES: 'rgba(148, 163, 184, 0.22)'
};

const DEFAULT_NODE_TYPES = ['Corpus', 'Paper', 'Problem', 'Method', 'Claim', 'Finding', 'Limitation', 'Assumption', 'Evidence', 'Dataset', 'Benchmark', 'Metric', 'FutureDirection'];
const DEFAULT_RELATION_TYPES = ['CONTAINS', 'SOLVES', 'USES', 'EVALUATES_ON', 'BENCHMARKED_ON', 'REPORTS', 'REPORTS_FINDING', 'CLAIMS', 'HAS_LIMITATION', 'ASSUMES', 'SUGGESTS_FUTURE', 'SUPPORTED_BY', 'OBSERVED_ON', 'MEASURED_BY', 'APPLIES_TO', 'TRANSFERABLE_TO', 'REQUIRES', 'DEPENDS_ON', 'HAS_GAP', 'RELATED_TO', 'SIMILAR_TO', 'COMPATIBLE_WITH', 'COMBINES_WITH', 'MAY_BE_ADDRESSED_BY', 'CONTRADICTS', 'CITES'];
const FILTER_PRESETS = {
  all: {
    label: 'Full graph',
    description: 'All layers and node types',
    nodeTypes: DEFAULT_NODE_TYPES,
    relationTypes: DEFAULT_RELATION_TYPES
  },
  research: {
    label: 'Research core',
    description: 'Problems, methods, claims, constraints',
    nodeTypes: ['Paper', 'Problem', 'Method', 'Claim', 'Finding', 'Limitation', 'Assumption', 'FutureDirection'],
    layers: ['DocumentLayer', 'ProblemLayer', 'MethodLayer', 'ClaimLayer', 'ConstraintLayer', 'FutureLayer'],
    relationTypes: ['SOLVES', 'USES', 'CLAIMS', 'REPORTS_FINDING', 'HAS_LIMITATION', 'ASSUMES', 'SUGGESTS_FUTURE', 'APPLIES_TO', 'TRANSFERABLE_TO', 'REQUIRES', 'DEPENDS_ON', 'HAS_GAP', 'RELATED_TO', 'SIMILAR_TO', 'COMPATIBLE_WITH', 'COMBINES_WITH', 'MAY_BE_ADDRESSED_BY', 'CONTRADICTS', 'CITES']
  },
  evidence: {
    label: 'Evidence lens',
    description: 'Claims, evidence, datasets, metrics',
    nodeTypes: ['Paper', 'Claim', 'Finding', 'Evidence', 'Dataset', 'Benchmark', 'Metric', 'Assumption', 'Limitation'],
    layers: ['DocumentLayer', 'ClaimLayer', 'EvidenceLayer', 'EvaluationLayer', 'ConstraintLayer'],
    relationTypes: ['CLAIMS', 'REPORTS_FINDING', 'SUPPORTED_BY', 'OBSERVED_ON', 'BENCHMARKED_ON', 'MEASURED_BY', 'DEPENDS_ON', 'HAS_LIMITATION', 'ASSUMES', 'REPORTS', 'EVALUATES_ON']
  },
  transfer: {
    label: 'Transfer paths',
    description: 'Problem-method transfer and composition',
    nodeTypes: ['Paper', 'Problem', 'Method', 'Limitation', 'Assumption', 'FutureDirection'],
    layers: ['DocumentLayer', 'ProblemLayer', 'MethodLayer', 'ConstraintLayer', 'FutureLayer'],
    relationTypes: ['SOLVES', 'USES', 'APPLIES_TO', 'TRANSFERABLE_TO', 'COMPATIBLE_WITH', 'COMBINES_WITH', 'MAY_BE_ADDRESSED_BY', 'HAS_GAP', 'REQUIRES', 'DEPENDS_ON', 'RELATED_TO']
  },
  brainstorm: {
    label: 'Brainstorm view',
    description: 'High-signal ideation nodes only',
    nodeTypes: ['Corpus', 'Paper', 'Problem', 'Method', 'Claim', 'Finding', 'Limitation', 'Assumption', 'FutureDirection', 'Dataset', 'Benchmark'],
    layers: ['CorpusLayer', 'DocumentLayer', 'ProblemLayer', 'MethodLayer', 'ClaimLayer', 'ConstraintLayer', 'FutureLayer', 'EvaluationLayer'],
    relationTypes: ['CONTAINS', 'SOLVES', 'USES', 'CLAIMS', 'REPORTS_FINDING', 'HAS_LIMITATION', 'ASSUMES', 'SUGGESTS_FUTURE', 'SUPPORTED_BY', 'APPLIES_TO', 'TRANSFERABLE_TO', 'REQUIRES', 'DEPENDS_ON', 'HAS_GAP', 'RELATED_TO', 'SIMILAR_TO', 'COMPATIBLE_WITH', 'COMBINES_WITH', 'MAY_BE_ADDRESSED_BY', 'CONTRADICTS', 'CITES'],
    viewMode: 'brainstorm'
  }
};
const NAVIGATOR_TYPE_MAP = {
  problems: 'Problem',
  papers: 'Paper',
  claims: 'Claim',
  findings: 'Finding',
  methods: 'Method',
  benchmarks: 'Benchmark',
  limitations: 'Limitation',
  assumptions: 'Assumption',
  evidences: 'Evidence',
  datasets: 'Dataset',
  metrics: 'Metric',
  futures: 'FutureDirection'
};

const app = document.querySelector('.app-shell');
const canvas = document.getElementById('graph-canvas');
const ctx = canvas.getContext('2d');
const searchInput = document.getElementById('global-search');
const searchResults = document.getElementById('search-results');
const llmCurrentLabel = document.getElementById('llm-current-label');
const llmToggleButton = document.getElementById('llm-toggle-button');
const llmPopover = document.getElementById('llm-popover');
const llmProviderSelect = document.getElementById('llm-provider-select');
const llmModelInput = document.getElementById('llm-model-input');
const llmSaveButton = document.getElementById('llm-save-button');
const corpusSelect = document.getElementById('corpus-select');
const overviewCard = document.getElementById('overview-card');
const filterPresets = document.getElementById('filter-presets');
const filterSummary = document.getElementById('filter-summary');
const nodeFilterChips = document.getElementById('node-filter-chips');
const layerFilterChips = document.getElementById('layer-filter-chips');
const relationFilterChips = document.getElementById('relation-filter-chips');
const navigatorList = document.getElementById('navigator-list');
const navigatorPickerShell = document.getElementById('navigator-picker-shell');
const navigatorPickerInput = document.getElementById('navigator-picker-input');
const navigatorPickerClear = document.getElementById('navigator-picker-clear');
const navigatorPickerResults = document.getElementById('navigator-picker-results');
const navigatorMeta = document.getElementById('navigator-meta');
const detailPanel = document.getElementById('detail-panel');
const selectionBadge = document.getElementById('selection-badge');
const canvasStats = document.getElementById('canvas-stats');
const canvasLegend = document.getElementById('canvas-legend');
const canvasFocusCard = document.getElementById('canvas-focus-card');
const canvasTooltip = document.getElementById('canvas-tooltip');
const statusbar = document.getElementById('statusbar');
const depthRange = document.getElementById('depth-range');
const depthValue = document.getElementById('depth-value');
const backupButton = document.getElementById('backup-button');
const refreshButton = document.getElementById('refresh-button');
const zoomInButton = document.getElementById('zoom-in-button');
const zoomOutButton = document.getElementById('zoom-out-button');
const fitButton = document.getElementById('fit-button');
const focusButton = document.getElementById('focus-button');
const clearButton = document.getElementById('clear-button');
const API_TOKEN_STORAGE_KEY = 'papernexus.apiToken';

const state = {
  corpora: [],
  activeCorpusName: '',
  meta: null,
  graph: null,
  summary: null,
  runtime: null,
  selectedNodeId: null,
  hoveredNodeId: null,
  searchQuery: '',
  navigatorQuery: '',
  searchResults: [],
  llmConfig: null,
  llmEditorOpen: false,
  llmSaveInProgress: false,
  navigatorTab: 'problems',
  detailTab: 'details',
  impactDirection: 'upstream',
  visibleNodeTypes: new Set(DEFAULT_NODE_TYPES),
  visibleLayers: new Set(),
  visibleRelationTypes: new Set(DEFAULT_RELATION_TYPES),
  viewMode: 'all',
  depthFilter: 2,
  backupInProgress: false,
  apiToken: '',
  noticeMessage: '',
  camera: { x: 0, y: 0, scale: 1 },
  drag: null,
  cameraInteracted: false,
  navigatorPickerOpen: false
};

let corpusMetaPollHandle = null;
let pendingFitFrame = 0;

function loadApiTokenFromStorage() {
  try {
    return window.sessionStorage.getItem(API_TOKEN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function persistApiToken(token) {
  state.apiToken = String(token || '').trim();
  try {
    if (state.apiToken) {
      window.sessionStorage.setItem(API_TOKEN_STORAGE_KEY, state.apiToken);
    } else {
      window.sessionStorage.removeItem(API_TOKEN_STORAGE_KEY);
    }
  } catch {}
}

function captureApiTokenFromLocation() {
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('token');
    if (!token || !token.trim()) return '';
    persistApiToken(token.trim());
    url.searchParams.delete('token');
    window.history.replaceState({}, document.title, url.toString());
    return state.apiToken;
  } catch {
    return '';
  }
}

async function ensureApiToken(forcePrompt = false) {
  if (!forcePrompt) {
    if (state.apiToken) return state.apiToken;
    const fromLocation = captureApiTokenFromLocation();
    if (fromLocation) return fromLocation;
    const fromStorage = loadApiTokenFromStorage().trim();
    if (fromStorage) {
      state.apiToken = fromStorage;
      return fromStorage;
    }
  }

  const entered = window.prompt('Enter the PaperNexus API token for this server.');
  const token = String(entered || '').trim();
  if (!token) {
    throw new Error('A PaperNexus API token is required for API access.');
  }
  persistApiToken(token);
  return token;
}

async function apiFetch(url, options = {}) {
  const makeRequest = async (token) => {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(url, {
      ...options,
      headers
    });
  };

  let token = await ensureApiToken(false);
  let response = await makeRequest(token);
  if (response.status === 401 && !options._retriedAuth) {
    persistApiToken('');
    token = await ensureApiToken(true);
    response = await makeRequest(token);
  }
  return response;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(value, limit = 180) {
  const text = String(value ?? '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trim()}...`;
}

function formatDate(value) {
  if (!value) return 'Unknown';
  return new Date(value).toLocaleString();
}

function formatLayerName(value) {
  return String(value || 'Unknown')
    .replace(/Layer$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
}

function getLayerColor(layer) {
  return LAYER_COLORS[layer] || '#94a3b8';
}

function getNodeLayerName(node) {
  return node?.properties?.layer || TYPE_TO_LAYER[node?.type] || 'Unknown';
}

function getLayerCount(layer) {
  return state.summary?.nodeLayers?.[layer] || 0;
}

function getRelationCount(type) {
  return state.summary?.relationTypes?.[type] || 0;
}

function getNodePaperSupport(node) {
  if (Array.isArray(node.properties?.paperTitles)) return node.properties.paperTitles.length;
  return node.properties?.paperTitle ? 1 : 0;
}

function getNodeConfidence(node) {
  if (!Number.isFinite(Number(node.properties?.confidence))) return null;
  return Number(node.properties.confidence);
}

function getNodeSnippet(node, limit = 180) {
  return truncate(
    node.properties?.evidenceText
      || node.properties?.text
      || node.properties?.abstract
      || '',
    limit
  );
}

function getNodeBadges(node) {
  const badges = [];
  const layer = getNodeLayerName(node);
  if (layer && layer !== 'Unknown') {
    badges.push({
      label: formatLayerName(layer),
      color: getLayerColor(layer)
    });
  }
  const support = getNodePaperSupport(node);
  if (support > 1) {
    badges.push({
      label: `${support} papers`,
      muted: true
    });
  } else if (node.properties?.paperTitle && node.type !== 'Paper') {
    badges.push({
      label: 'paper-scoped',
      muted: true
    });
  }
  const confidence = getNodeConfidence(node);
  if (confidence !== null) {
    badges.push({
      label: `${Math.round(confidence * 100)}% confidence`,
      muted: true
    });
  }
  if (node.properties?.claimType) {
    badges.push({
      label: node.properties.claimType,
      muted: true
    });
  }
  if (node.properties?.findingType) {
    badges.push({
      label: node.properties.findingType,
      muted: true
    });
  }
  return badges;
}

function renderBadgeList(items, variant = 'meta-pill') {
  return items.map((item) => `
    <span class="${variant}${item.muted ? ' muted' : ''}"${item.color ? ` style="--pill-color:${item.color}"` : ''}>${escapeHtml(item.label)}</span>
  `).join('');
}

function normalizePresetValues(values, runtimeValues) {
  if (!values?.length) return [...runtimeValues];
  return values.filter((value) => runtimeValues.includes(value));
}

function setsMatch(left, right) {
  if (left.size !== right.size) return false;
  for (const item of left) {
    if (!right.has(item)) return false;
  }
  return true;
}

function presetIsActive(presetKey) {
  if (!state.runtime) return false;
  const preset = FILTER_PRESETS[presetKey];
  if (!preset) return false;
  const nodeSet = new Set(normalizePresetValues(preset.nodeTypes, state.runtime.nodeTypes));
  const relationSet = new Set(normalizePresetValues(preset.relationTypes, state.runtime.relationTypes));
  const layerSet = new Set(normalizePresetValues(preset.layers, state.runtime.layers));
  return (
    (preset.viewMode || 'all') === state.viewMode
    &&
    setsMatch(state.visibleNodeTypes, nodeSet)
    && setsMatch(state.visibleRelationTypes, relationSet)
    && setsMatch(state.visibleLayers, layerSet)
  );
}

function applyFilterPreset(presetKey) {
  if (!state.runtime) return;
  const preset = FILTER_PRESETS[presetKey];
  if (!preset) return;
  state.viewMode = preset.viewMode || 'all';
  state.visibleNodeTypes = new Set(normalizePresetValues(preset.nodeTypes, state.runtime.nodeTypes));
  state.visibleRelationTypes = new Set(normalizePresetValues(preset.relationTypes, state.runtime.relationTypes));
  state.visibleLayers = new Set(normalizePresetValues(preset.layers, state.runtime.layers));
  renderAll();
  state.cameraInteracted = false;
  scheduleCameraFit();
}

async function fetchJson(url) {
  const response = await apiFetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

async function postJson(url, body = null) {
  const response = await apiFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: body ? JSON.stringify(body) : null
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function formatLlmLabel(llmConfig) {
  if (!llmConfig?.provider || !llmConfig?.model) {
    return 'Disabled';
  }

  return `${llmConfig.provider} · ${llmConfig.model}`;
}

function syncLlmInputs() {
  const llmConfig = state.llmConfig?.llm;
  llmProviderSelect.value = llmConfig?.provider || 'ollama';
  llmModelInput.value = llmConfig?.model || '';
}

async function loadLlmConfig() {
  const payload = await fetchJson('/api/llm-config');
  state.llmConfig = payload;
  syncLlmInputs();
  renderTopbarActions();
}

function getNodeColor(type) {
  return NODE_COLORS[type] || '#94a3b8';
}

function getNodeSubtitle(node) {
  const layerName = getNodeLayerName(node);
  const layer = layerName && layerName !== 'Unknown' ? ` · ${layerName}` : '';
  if (node.type === 'Paper') {
    return `Paper${layer}`;
  }

  if (node.properties?.paperTitle) {
    return `${node.type}${layer} · ${node.properties.paperTitle}`;
  }

  if (Array.isArray(node.properties?.paperTitles) && node.properties.paperTitles.length) {
    return `${node.type}${layer} · ${node.properties.paperTitles.length} papers`;
  }

  return `${node.type}${layer}`;
}

function formatPropertyValue(value) {
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.length <= 5) return value.join(', ');
    return `${value.slice(0, 5).join(', ')} ... (+${value.length - 5})`;
  }

  if (value && typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}

function nodeSearchText(node) {
  return [
    node.name,
    node.type,
    node.properties?.paperTitle,
    node.properties?.abstract,
    node.properties?.sectionHeading,
    node.properties?.text,
    Array.isArray(node.properties?.paperTitles) ? node.properties.paperTitles.join(' ') : ''
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function worldToScreen(position) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  return {
    x: width / 2 + (position.x - state.camera.x) * state.camera.scale,
    y: height / 2 + (position.y - state.camera.y) * state.camera.scale
  };
}

function screenToWorld(x, y) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  return {
    x: state.camera.x + (x - width / 2) / state.camera.scale,
    y: state.camera.y + (y - height / 2) / state.camera.scale
  };
}

function nodeRadius(node) {
  const base = {
    Corpus: 16,
    Paper: 12,
    Problem: 12,
    Method: 10,
    Claim: 10,
    Finding: 10,
    Limitation: 9,
    Assumption: 9,
    Evidence: 9,
    Dataset: 9,
    Benchmark: 8,
    Metric: 8,
    FutureDirection: 8
  }[node.type] || 8;

  if (node.type === 'Problem') {
    const shared = Array.isArray(node.properties?.paperTitles) ? node.properties.paperTitles.length : 1;
    return Math.min(18, base + Math.max(0, shared - 1));
  }

  return base;
}

function isBrainstormNode(node) {
  return Boolean(node?.properties?.brainstormEligible);
}

function sortNodesForNavigator(nodes) {
  return [...nodes].sort((left, right) => {
    const leftShared = Array.isArray(left.properties?.paperTitles) ? left.properties.paperTitles.length : 0;
    const rightShared = Array.isArray(right.properties?.paperTitles) ? right.properties.paperTitles.length : 0;
    const leftPaper = left.properties?.paperTitle || '';
    const rightPaper = right.properties?.paperTitle || '';
    return (
      rightShared - leftShared
      || leftPaper.localeCompare(rightPaper)
      || left.name.localeCompare(right.name)
    );
  });
}

function getNavigatorTabLabel() {
  return document.querySelector(`#navigator-tabs [data-tab="${state.navigatorTab}"]`)?.textContent?.trim() || state.navigatorTab;
}

function getNavigatorItems() {
  const allItems = (state.runtime?.navigatorByType[state.navigatorTab] || [])
    .filter((node) => state.viewMode !== 'brainstorm' || isBrainstormNode(node));
  const query = state.navigatorQuery.trim().toLowerCase();
  const filteredItems = allItems.filter((node) => !query || nodeSearchText(node).includes(query));
  return {
    allItems,
    filteredItems,
    query
  };
}

function getSelectedNavigatorNode() {
  const selectedType = NAVIGATOR_TYPE_MAP[state.navigatorTab];
  const selectedNode = state.selectedNodeId ? state.runtime?.nodeMap.get(state.selectedNodeId) : null;
  if (!selectedNode || selectedNode.type !== selectedType) {
    return null;
  }
  return selectedNode;
}

function computePackedRingPositions(count, config = {}) {
  const positions = [];
  const baseRadius = config.baseRadius ?? 260;
  const ringGap = config.ringGap ?? 128;
  const itemSpacing = config.itemSpacing ?? 110;
  const minPerRing = config.minPerRing ?? 6;
  const startAngle = config.startAngle ?? -Math.PI / 2;
  let placed = 0;
  let ringIndex = 0;

  while (placed < count) {
    const radius = baseRadius + ringIndex * ringGap;
    const circumference = Math.max(1, Math.PI * 2 * Math.max(radius, 1));
    const capacity = Math.max(minPerRing, Math.floor(circumference / itemSpacing));
    const remaining = count - placed;
    const ringCount = Math.min(capacity, remaining);

    for (let index = 0; index < ringCount; index += 1) {
      const angle = ringCount === 1
        ? startAngle
        : startAngle + (index / ringCount) * Math.PI * 2;
      positions.push({
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius
      });
    }

    placed += ringCount;
    ringIndex += 1;
  }

  return positions;
}

function buildLayout(graph) {
  const positions = new Map();
  const corpusNodes = graph.nodes.filter((node) => node.type === 'Corpus');
  const problemNodes = graph.nodes.filter((node) => node.type === 'Problem');
  const datasetNodes = graph.nodes.filter((node) => node.type === 'Dataset');
  const metricNodes = graph.nodes.filter((node) => node.type === 'Metric');
  const paperGroups = new Map();

  const placeRing = (nodes, radius, startAngle = -Math.PI / 2, sweep = Math.PI * 2) => {
    if (!nodes.length) return;
    nodes.forEach((node, index) => {
      const angle = startAngle + (index / Math.max(nodes.length, 1)) * sweep;
      positions.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    });
  };

  const placeArc = (nodes, radius, startAngle, sweep) => {
    if (!nodes.length) return;
    nodes.forEach((node, index) => {
      const angle = nodes.length === 1
        ? startAngle + sweep / 2
        : startAngle + (index / Math.max(nodes.length - 1, 1)) * sweep;
      positions.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    });
  };

  const placeFan = (nodes, center, config) => {
    if (!nodes.length) return;
    const ordered = [...nodes].sort((left, right) => {
      const leftOrder = Number(left.properties?.storyOrder || 0);
      const rightOrder = Number(right.properties?.storyOrder || 0);
      return leftOrder - rightOrder || left.name.localeCompare(right.name);
    });

    ordered.forEach((node, index) => {
      const layer = Math.floor(index / 3) * 18;
      const slot = index % 3;
      const spread = ordered.length === 1 ? 0 : ((slot - 1) * config.spread);
      const angle = config.angle + spread;
      const radius = config.radius + layer;
      positions.set(node.id, {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius
      });
    });
  };

  corpusNodes.forEach((node, index) => {
    positions.set(node.id, { x: index * 120, y: 0 });
  });

  const problemPositions = computePackedRingPositions(problemNodes.length, {
    baseRadius: 260,
    ringGap: 120,
    itemSpacing: 110,
    minPerRing: 6
  });
  problemNodes.forEach((node, index) => {
    positions.set(node.id, problemPositions[index]);
  });
  const problemExtent = problemPositions.length
    ? Math.max(...problemPositions.map((position) => Math.hypot(position.x, position.y)))
    : 260;
  const evaluationRadius = Math.max(760, problemExtent + 280);
  placeArc(datasetNodes, evaluationRadius, Math.PI * 0.7, Math.PI * 0.58);
  placeArc(metricNodes, evaluationRadius, -Math.PI * 0.28, Math.PI * 0.58);

  graph.nodes.forEach((node) => {
    if (!node.properties?.paperId) return;
    const key = node.properties.paperId;
    if (!paperGroups.has(key)) {
      paperGroups.set(key, {
        paperId: key,
        paperTitle: node.properties.paperTitle || key,
        nodes: []
      });
    }
    paperGroups.get(key).nodes.push(node);
  });

  const paperEntries = [...paperGroups.values()].sort((left, right) => left.paperTitle.localeCompare(right.paperTitle));
  const paperCenters = computePackedRingPositions(paperEntries.length, {
    baseRadius: Math.max(680, problemExtent + 320),
    ringGap: 300,
    itemSpacing: 360,
    minPerRing: 5,
    startAngle: Math.PI / 2
  });

  paperEntries.forEach((group, index) => {
    const center = paperCenters[index];

    const byType = {};
    group.nodes.forEach((node) => {
      if (!byType[node.type]) byType[node.type] = [];
      byType[node.type].push(node);
    });

    (byType.Paper || []).forEach((node, paperIndex) => {
      const paperAngle = -Math.PI / 2 + paperIndex * 0.24;
      const paperRadius = paperIndex === 0 ? 0 : 28 + paperIndex * 14;
      positions.set(node.id, {
        x: center.x + Math.cos(paperAngle) * paperRadius,
        y: center.y + Math.sin(paperAngle) * paperRadius
      });
    });
    placeFan(byType.Method || [], center, { angle: Math.PI, radius: 108, spread: 0.24 });
    placeFan(byType.Claim || [], center, { angle: Math.PI / 2, radius: 128, spread: 0.28 });
    placeFan(byType.Finding || [], center, { angle: Math.PI * 0.28, radius: 142, spread: 0.24 });
    placeFan(byType.Evidence || [], center, { angle: 0, radius: 112, spread: 0.24 });
    placeFan(byType.Limitation || [], center, { angle: -Math.PI / 2, radius: 124, spread: 0.28 });
    placeFan(byType.Assumption || [], center, { angle: -Math.PI * 0.78, radius: 144, spread: 0.24 });
    placeFan(byType.Benchmark || [], center, { angle: -Math.PI * 0.18, radius: 166, spread: 0.22 });
    placeFan(byType.FutureDirection || [], center, { angle: Math.PI * 0.12, radius: 148, spread: 0.24 });
  });

  graph.nodes.forEach((node, index) => {
    if (positions.has(node.id)) return;
    const angle = (index / Math.max(graph.nodes.length, 1)) * Math.PI * 2;
    positions.set(node.id, {
      x: Math.cos(angle) * 520 + (index % 6) * 12,
      y: Math.sin(angle) * 520 + (index % 5) * 10
    });
  });

  return positions;
}

function createGraphRuntime(graph) {
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map();
  const incoming = new Map();
  const relationTypes = new Set();
  const nodeTypes = new Set();
  const layers = new Set();

  for (const node of graph.nodes) {
    nodeTypes.add(node.type);
    layers.add(getNodeLayerName(node));
  }

  for (const relationship of graph.relationships) {
    relationTypes.add(relationship.type);
    if (!outgoing.has(relationship.sourceId)) outgoing.set(relationship.sourceId, []);
    if (!incoming.has(relationship.targetId)) incoming.set(relationship.targetId, []);
    outgoing.get(relationship.sourceId).push(relationship);
    incoming.get(relationship.targetId).push(relationship);
  }

  const positions = buildLayout(graph);
  const navigatorByType = {};
  for (const [tab, type] of Object.entries(NAVIGATOR_TYPE_MAP)) {
    navigatorByType[tab] = sortNodesForNavigator(graph.nodes.filter((node) => node.type === type));
  }

  return {
    nodeMap,
    outgoing,
    incoming,
    positions,
    nodeTypes: [...nodeTypes].sort(),
    layers: [...layers].sort(),
    relationTypes: [...relationTypes].sort(),
    navigatorByType
  };
}

function computeDistances(startId, options = {}) {
  const maxDepth = options.maxDepth || state.depthFilter;
  const relationWhitelist = options.relationTypes || null;
  const distances = new Map([[startId, 0]]);
  const queue = [startId];

  while (queue.length) {
    const currentId = queue.shift();
    const depth = distances.get(currentId);
    if (depth >= maxDepth) continue;

    const outgoing = state.runtime.outgoing.get(currentId) || [];
    const incoming = state.runtime.incoming.get(currentId) || [];
    const relationships = [...outgoing, ...incoming];

    for (const relationship of relationships) {
      if (relationWhitelist && !relationWhitelist.has(relationship.type)) continue;
      const nextId = relationship.sourceId === currentId ? relationship.targetId : relationship.sourceId;
      if (distances.has(nextId)) continue;
      distances.set(nextId, depth + 1);
      queue.push(nextId);
    }
  }

  return distances;
}

function computeImpact(startId, direction, maxDepth = 3) {
  const buckets = [];
  const seen = new Set([startId]);
  let frontier = [{ id: startId, depth: 0 }];

  while (frontier.length) {
    const next = [];
    for (const item of frontier) {
      if (item.depth >= maxDepth) continue;
      const relationships = direction === 'upstream'
        ? (state.runtime.incoming.get(item.id) || [])
        : (state.runtime.outgoing.get(item.id) || []);

      for (const relationship of relationships) {
        if (!state.visibleRelationTypes.has(relationship.type)) continue;
        const nodeId = direction === 'upstream' ? relationship.sourceId : relationship.targetId;
        if (seen.has(nodeId)) continue;
        seen.add(nodeId);
        next.push({ id: nodeId, depth: item.depth + 1, via: relationship.type });
      }
    }

    if (!next.length) break;
    buckets.push({
      depth: next[0].depth,
      items: next.map((entry) => ({
        node: state.runtime.nodeMap.get(entry.id),
        via: entry.via
      }))
    });
    frontier = next;
  }

  return buckets;
}

function getVisibleNodes() {
  if (!state.graph || !state.runtime) return [];
  const selectedDistances = state.selectedNodeId ? computeDistances(state.selectedNodeId) : null;

  return state.graph.nodes.filter((node) => {
    if (!state.visibleLayers.has(getNodeLayerName(node))) return false;
    if (state.viewMode === 'brainstorm' && node.type !== 'Corpus' && node.type !== 'Paper' && !isBrainstormNode(node)) {
      return false;
    }
    if (selectedDistances?.has(node.id)) return true;
    return state.visibleNodeTypes.has(node.type);
  });
}

function getVisibleRelationships(visibleNodeIds) {
  if (!state.graph) return [];
  const selectedDistances = state.selectedNodeId ? computeDistances(state.selectedNodeId) : null;

  return state.graph.relationships.filter((relationship) => {
    if (!state.visibleRelationTypes.has(relationship.type)) return false;
    if (!visibleNodeIds.has(relationship.sourceId) || !visibleNodeIds.has(relationship.targetId)) return false;
    if (!selectedDistances) return true;
    return selectedDistances.has(relationship.sourceId) || selectedDistances.has(relationship.targetId);
  });
}

function colorWithAlpha(hex, alpha) {
  const clean = hex.replace('#', '');
  const bigint = parseInt(clean, 16);
  const red = (bigint >> 16) & 255;
  const green = (bigint >> 8) & 255;
  const blue = bigint & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function drawGrid(width, height) {
  const spacing = 42 * Math.max(0.6, Math.min(1.3, state.camera.scale));
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += spacing) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += spacing) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
}

function drawRoundedRect(x, y, width, height, radius) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.lineTo(x + width - safeRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  ctx.lineTo(x + width, y + height - safeRadius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  ctx.lineTo(x + safeRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  ctx.lineTo(x, y + safeRadius);
  ctx.quadraticCurveTo(x, y, x + safeRadius, y);
  ctx.closePath();
}

function drawEmptyCanvas(width, height) {
  ctx.fillStyle = '#8888a0';
  ctx.font = '600 24px "Avenir Next", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('No corpus loaded', width / 2, height / 2 - 10);
  ctx.font = '14px "Avenir Next", sans-serif';
  ctx.fillStyle = '#5a5a70';
  ctx.fillText('Run `papernexus analyze <path>` and refresh this page.', width / 2, height / 2 + 18);
}

function drawCanvas() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  } else {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#06060a');
  gradient.addColorStop(1, '#0a0a10');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  drawGrid(width, height);

  if (!state.graph || !state.runtime) {
    drawEmptyCanvas(width, height);
    return;
  }

  const visibleNodes = getVisibleNodes();
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleRelationships = getVisibleRelationships(visibleNodeIds);
  const selectedDistances = state.selectedNodeId ? computeDistances(state.selectedNodeId) : null;
  const activePreset = Object.keys(FILTER_PRESETS).find((key) => presetIsActive(key));

  visibleRelationships.forEach((relationship) => {
    const sourcePosition = state.runtime.positions.get(relationship.sourceId);
    const targetPosition = state.runtime.positions.get(relationship.targetId);
    if (!sourcePosition || !targetPosition) return;
    const source = worldToScreen(sourcePosition);
    const target = worldToScreen(targetPosition);
    const alpha = selectedDistances
      ? ((selectedDistances.has(relationship.sourceId) || selectedDistances.has(relationship.targetId)) ? 0.9 : 0.1)
      : 0.65;

    ctx.strokeStyle = (EDGE_COLORS[relationship.type] || 'rgba(148, 163, 184, 0.24)').replace(/[\d.]+\)$/g, `${alpha})`);
    ctx.lineWidth = relationship.type === 'RELATED_TO' ? 2 : 1.2;
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    const controlX = (source.x + target.x) / 2 + (target.y - source.y) * 0.05;
    const controlY = (source.y + target.y) / 2 - (target.x - source.x) * 0.05;
    ctx.quadraticCurveTo(controlX, controlY, target.x, target.y);
    ctx.stroke();
  });

  visibleNodes.forEach((node) => {
    const world = state.runtime.positions.get(node.id);
    if (!world) return;
    const screen = worldToScreen(world);
    const radius = nodeRadius(node);
    const isSelected = node.id === state.selectedNodeId;
    const isHovered = node.id === state.hoveredNodeId;
    const distance = selectedDistances?.get(node.id);
    const alpha = selectedDistances && distance === undefined && !isSelected ? 0.14 : 1;

    if (isSelected) {
      ctx.fillStyle = 'rgba(124, 58, 237, 0.18)';
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, radius + 10, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = colorWithAlpha(getNodeColor(node.type), alpha);
    ctx.fill();

    ctx.lineWidth = isHovered || isSelected ? 2.5 : 1;
    ctx.strokeStyle = isSelected ? '#f5f3ff' : colorWithAlpha('#ffffff', alpha * 0.24);
    ctx.stroke();

    if (state.camera.scale >= 0.56 || isSelected || ['Problem', 'Claim', 'Finding', 'Method', 'Limitation'].includes(node.type)) {
      const label = truncate(node.name, 34);
      const fontSize = Math.max(11, 10 + state.camera.scale * 1.5);
      ctx.font = `${isSelected ? 700 : 500} ${fontSize}px "Avenir Next", sans-serif`;
      const labelWidth = ctx.measureText(label).width + 16;
      const labelX = screen.x - labelWidth / 2;
      const labelY = screen.y - radius - 26;
      drawRoundedRect(labelX, labelY, labelWidth, 20, 10);
      ctx.fillStyle = isSelected
        ? colorWithAlpha('#08131d', Math.min(1, alpha))
        : colorWithAlpha('#0e1923', Math.max(0.4, alpha * 0.76));
      ctx.fill();
      if (isSelected || isHovered) {
        ctx.strokeStyle = colorWithAlpha(getNodeColor(node.type), Math.max(0.28, alpha * 0.48));
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.fillStyle = colorWithAlpha('#e4e4ed', alpha);
      ctx.textAlign = 'center';
      ctx.fillText(label, screen.x, labelY + 14);
    }
  });

  canvasStats.textContent = `${visibleNodes.length} nodes · ${visibleRelationships.length} edges · ${activePreset ? FILTER_PRESETS[activePreset].label : 'Custom scope'}`;
}

function fitCamera() {
  if (!state.runtime || !state.graph) return;
  const nodes = getVisibleNodes();
  if (!nodes.length) return;

  const bounds = nodes.reduce((acc, node) => {
    const position = state.runtime.positions.get(node.id);
    const radius = nodeRadius(node) + 18;
    return {
      minX: Math.min(acc.minX, position.x - radius),
      maxX: Math.max(acc.maxX, position.x + radius),
      minY: Math.min(acc.minY, position.y - radius),
      maxY: Math.max(acc.maxY, position.y + radius)
    };
  }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });

  const width = canvas.clientWidth || 1;
  const height = canvas.clientHeight || 1;
  const graphWidth = Math.max(1, bounds.maxX - bounds.minX);
  const graphHeight = Math.max(1, bounds.maxY - bounds.minY);
  const paddingX = Math.max(140, Math.min(width * 0.16, 240));
  const paddingY = Math.max(120, Math.min(height * 0.14, 220));
  const scale = Math.min(
    (width - paddingX * 2) / graphWidth,
    (height - paddingY * 2) / graphHeight,
    1.35
  );

  state.camera = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    scale: Math.max(0.16, scale)
  };
}

function scheduleCameraFit() {
  if (!state.runtime || !state.graph) return;
  if (pendingFitFrame) {
    window.cancelAnimationFrame(pendingFitFrame);
  }

  pendingFitFrame = window.requestAnimationFrame(() => {
    pendingFitFrame = 0;
    fitCamera();
    drawCanvas();
  });
}

function focusNode(nodeId) {
  const position = state.runtime?.positions.get(nodeId);
  if (!position) return;
  state.camera.x = position.x;
  state.camera.y = position.y;
  state.camera.scale = Math.max(state.camera.scale, 0.8);
  state.cameraInteracted = true;
  drawCanvas();
}

function updateSearchResults() {
  const query = state.searchQuery.trim().toLowerCase();
  if (!query || !state.graph) {
    state.searchResults = [];
    renderSearchResults();
    return;
  }

  state.searchResults = state.graph.nodes
    .filter((node) => nodeSearchText(node).includes(query))
    .sort((left, right) => {
      const leftExact = left.name.toLowerCase() === query ? 0 : 1;
      const rightExact = right.name.toLowerCase() === query ? 0 : 1;
      return leftExact - rightExact || left.name.localeCompare(right.name);
    })
    .slice(0, 12);

  renderSearchResults();
}

function renderSearchResults() {
  if (!state.searchResults.length) {
    searchResults.classList.add('hidden');
    searchResults.innerHTML = '';
    return;
  }

  searchResults.innerHTML = state.searchResults.map((node, index) => `
    <button class="search-result ${index === 0 ? 'active' : ''}" data-node-id="${escapeHtml(node.id)}">
      <span class="type-dot" style="background:${getNodeColor(node.type)}"></span>
      <span>
        <div>${escapeHtml(node.name)}</div>
        <small>${escapeHtml(getNodeSubtitle(node))}</small>
      </span>
      <small>${escapeHtml(node.id.split(':')[0])}</small>
    </button>
  `).join('');
  searchResults.classList.remove('hidden');
}

function renderNavigatorPicker() {
  const tabLabel = getNavigatorTabLabel();
  const placeholder = `Filter ${tabLabel.toLowerCase()}...`;
  if (navigatorPickerInput.placeholder !== placeholder) {
    navigatorPickerInput.placeholder = placeholder;
  }
  if (navigatorPickerInput.value !== state.navigatorQuery) {
    navigatorPickerInput.value = state.navigatorQuery;
  }
  navigatorPickerClear.classList.toggle('hidden', !state.navigatorQuery.trim());

  if (!state.runtime) {
    navigatorPickerResults.innerHTML = '';
    navigatorPickerResults.classList.add('hidden');
    return;
  }

  const { filteredItems, query } = getNavigatorItems();
  const items = filteredItems.slice(0, 10);

  if (!state.navigatorPickerOpen) {
    navigatorPickerResults.classList.add('hidden');
    return;
  }

  if (!items.length) {
    navigatorPickerResults.innerHTML = query
      ? `<div class="navigator-picker-empty">No ${escapeHtml(tabLabel.toLowerCase())} match "${escapeHtml(state.navigatorQuery)}".</div>`
      : `<div class="navigator-picker-empty">Start typing to narrow ${escapeHtml(tabLabel.toLowerCase())}.</div>`;
    navigatorPickerResults.classList.remove('hidden');
    return;
  }

  navigatorPickerResults.innerHTML = items.map((node, index) => `
    <button class="navigator-picker-result ${index === 0 ? 'active' : ''}" data-node-id="${escapeHtml(node.id)}">
      <div class="navigator-picker-result-head">
        <span class="type-dot" style="background:${getNodeColor(node.type)}"></span>
        <span class="item-title">${escapeHtml(node.name)}</span>
      </div>
      <small>${escapeHtml(getNodeSubtitle(node))}</small>
    </button>
  `).join('');
  navigatorPickerResults.classList.remove('hidden');
}

function getTypeCount(type) {
  return state.summary?.nodeTypes?.[type] || 0;
}

function renderOverview() {
  if (!state.meta) {
    overviewCard.innerHTML = '<div class="empty-copy">No corpus loaded.</div>';
    return;
  }

  const topProblems = (state.meta.topProblems || state.meta.topDomains || []).slice(0, 8);
  const layerEntries = Object.entries(state.summary?.nodeLayers || {});
  const maxLayerCount = Math.max(1, ...layerEntries.map(([, count]) => count));
  const topPaths = Object.entries(state.summary?.layerPaths || {}).slice(0, 6);
  const signalCards = [
    ['Problems', getTypeCount('Problem')],
    ['Methods', getTypeCount('Method')],
    ['Claims', getTypeCount('Claim') + getTypeCount('Finding')],
    ['Constraints', getTypeCount('Limitation') + getTypeCount('Assumption')],
    ['Evidence', getTypeCount('Evidence')],
    ['Evaluation', getTypeCount('Dataset') + getTypeCount('Benchmark') + getTypeCount('Metric')]
  ];

  overviewCard.innerHTML = `
    <div class="overview-hero">
      <div>
        <div class="detail-title">${escapeHtml(state.meta.name)}</div>
        <div class="detail-meta">Indexed ${escapeHtml(formatDate(state.meta.indexedAt))} · ${escapeHtml(state.meta.sourceMode)} · ${escapeHtml(state.meta.graphMode || 'graph')}</div>
      </div>
      <div class="overview-badge-row">
        <span class="overview-pill">${escapeHtml(state.meta.storageMode || 'local')}</span>
        ${state.meta.buildMode ? `<span class="overview-pill muted">${escapeHtml(state.meta.buildMode)}</span>` : ''}
        ${state.meta.llm?.enabled ? `<span class="overview-pill muted">${state.meta.llm.relationCount || 0} LLM edges</span>` : ''}
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-value">${state.meta.paperCount}</div>
        <div class="stat-label">Papers</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${state.meta.nodeCount}</div>
        <div class="stat-label">Nodes</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${state.meta.relationshipCount}</div>
        <div class="stat-label">Edges</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${Object.keys(state.summary?.nodeLayers || {}).length}</div>
        <div class="stat-label">Layers</div>
      </div>
    </div>
    <div class="signal-grid">
      ${signalCards.map(([label, value]) => `
        <div class="signal-card">
          <strong>${value}</strong>
          <span>${escapeHtml(label)}</span>
        </div>
      `).join('')}
    </div>
    <div class="overview-columns">
      <div>
        <div class="group-title">Layer distribution</div>
        <div class="layer-rows">
          ${layerEntries.map(([layer, count]) => `
            <div class="layer-row">
              <div class="layer-row-head">
                <span class="legend-row-label"><span class="legend-swatch" style="background:${getLayerColor(layer)}"></span>${escapeHtml(formatLayerName(layer))}</span>
                <span class="legend-row-count">${count}</span>
              </div>
              <div class="layer-bar-track">
                <div class="layer-bar-fill" style="width:${Math.max(8, (count / maxLayerCount) * 100)}%; --bar-color:${getLayerColor(layer)}"></div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
      <div>
        <div class="group-title">Dominant traversals</div>
        <div class="path-pill-grid">
          ${topPaths.length
            ? topPaths.map(([pathName, count]) => `<span class="path-pill">${escapeHtml(pathName)} · ${count}</span>`).join('')
            : '<div class="empty-copy">No layer-path summary available.</div>'}
        </div>
      </div>
    </div>
    <div>
      <div class="group-title">Top problems</div>
      <div>
        ${topProblems.length
          ? topProblems.map((problem) => `<button class="concept-chip" data-problem-name="${escapeHtml(problem)}">${escapeHtml(problem)}</button>`).join('')
          : '<div class="empty-copy">No problem summary available.</div>'}
      </div>
    </div>
  `;
}

function renderFilters() {
  if (!state.runtime) return;

  filterPresets.innerHTML = Object.entries(FILTER_PRESETS).map(([presetKey, preset]) => `
    <button class="preset-button ${presetIsActive(presetKey) ? 'active' : ''}" data-filter-preset="${escapeHtml(presetKey)}">
      <span>${escapeHtml(preset.label)}</span>
      <small>${escapeHtml(preset.description)}</small>
    </button>
  `).join('');

  const lensName = Object.keys(FILTER_PRESETS).find((key) => presetIsActive(key));
  filterSummary.innerHTML = `
    <div class="filter-summary-text">
      <strong>${escapeHtml(lensName ? FILTER_PRESETS[lensName].label : 'Custom scope')}</strong>
      <span>${state.visibleLayers.size} layers · ${state.visibleNodeTypes.size} node types · ${state.visibleRelationTypes.size} relation types</span>
    </div>
    <div class="filter-pill-row">
      <span class="filter-pill">${getTypeCount('Problem')} problems</span>
      <span class="filter-pill">${getTypeCount('Method')} methods</span>
      <span class="filter-pill">${getRelationCount('SUPPORTED_BY')} support edges</span>
    </div>
  `;

  nodeFilterChips.innerHTML = state.runtime.nodeTypes.map((type) => `
    <button class="chip ${state.visibleNodeTypes.has(type) ? 'active' : ''}" data-node-type="${escapeHtml(type)}">
      <span class="type-dot" style="background:${getNodeColor(type)}"></span>
      ${escapeHtml(type)}
    </button>
  `).join('');

  relationFilterChips.innerHTML = state.runtime.relationTypes.map((type) => `
    <button class="chip ${state.visibleRelationTypes.has(type) ? 'active' : ''}" data-relation-type="${escapeHtml(type)}">
      ${escapeHtml(type)}
    </button>
  `).join('');

  layerFilterChips.innerHTML = state.runtime.layers.map((layer) => `
    <button class="chip ${state.visibleLayers.has(layer) ? 'active' : ''}" data-layer-name="${escapeHtml(layer)}">
      ${escapeHtml(layer)}
    </button>
  `).join('');
}

function renderNavigator() {
  if (!state.runtime) {
    navigatorMeta.innerHTML = '';
    navigatorList.innerHTML = '<div class="empty-copy">No corpus loaded.</div>';
    return;
  }

  const { allItems, filteredItems, query } = getNavigatorItems();
  const tabLabel = getNavigatorTabLabel();
  const selectedNode = getSelectedNavigatorNode();
  const selectedMatchesQuery = selectedNode
    ? nodeSearchText(selectedNode).includes(query)
    : false;

  navigatorMeta.innerHTML = `
    <strong>${escapeHtml(tabLabel)}</strong>
    <span>${query ? `${filteredItems.length} match` : `${allItems.length} available`} · dropdown picker</span>
  `;

  if (!query && !selectedNode) {
    navigatorList.innerHTML = `
      <div class="empty-copy">
        Type in the picker above to jump to a ${escapeHtml(tabLabel.toLowerCase())}. The navigator stays collapsed until you choose one.
      </div>
    `;
    return;
  }

  if (query && !selectedNode) {
    navigatorList.innerHTML = `
      <div class="empty-copy">
        ${filteredItems.length
          ? `Use the dropdown above to choose from ${filteredItems.length} matching ${escapeHtml(tabLabel.toLowerCase())}.`
          : `No ${escapeHtml(tabLabel.toLowerCase())} match "${escapeHtml(state.navigatorQuery)}".`}
      </div>
    `;
    return;
  }

  if (query && selectedNode && !selectedMatchesQuery) {
    navigatorList.innerHTML = `
      <div class="empty-copy">
        Use the dropdown above to replace the current ${escapeHtml(tabLabel.toLowerCase())} selection.
      </div>
    `;
    return;
  }

  navigatorList.innerHTML = `
    <button class="navigator-item active" data-node-id="${escapeHtml(selectedNode.id)}">
      <div class="navigator-row">
        <div class="item-title-row">
          <span class="type-dot" style="background:${getNodeColor(selectedNode.type)}"></span>
          <span class="item-title">${escapeHtml(selectedNode.name)}</span>
        </div>
        <div class="navigator-row-end">
          <span class="navigator-count">${escapeHtml(getNodePaperSupport(selectedNode) > 1 ? `${getNodePaperSupport(selectedNode)} papers` : formatLayerName(getNodeLayerName(selectedNode)))}</span>
        </div>
      </div>
      <div class="item-subtitle">${escapeHtml(getNodeSubtitle(selectedNode))}</div>
      ${getNodeBadges(selectedNode).length ? `<div class="item-meta-row">${renderBadgeList(getNodeBadges(selectedNode), 'mini-pill')}</div>` : ''}
      ${getNodeSnippet(selectedNode, 120) ? `<div class="item-snippet">${escapeHtml(getNodeSnippet(selectedNode, 120))}</div>` : ''}
    </button>
  `;
}

function relationCard(node, relationship, direction) {
  const targetId = direction === 'outgoing' ? relationship.targetId : relationship.sourceId;
  const target = state.runtime.nodeMap.get(targetId);
  if (!target) return '';

  return `
    <button class="relation-item" data-node-id="${escapeHtml(target.id)}">
      <div class="relation-headline">
        <span class="type-dot" style="background:${getNodeColor(target.type)}"></span>
        <span class="item-title">${escapeHtml(target.name)}</span>
      </div>
      <div class="relation-chip-row">
        <span class="mini-pill relation">${escapeHtml(relationship.type)}</span>
        <span class="mini-pill muted">${escapeHtml(formatLayerName(getNodeLayerName(target)))}</span>
        ${relationship.properties?.relationSource ? `<span class="mini-pill muted">${escapeHtml(relationship.properties.relationSource)}</span>` : ''}
      </div>
      <div class="relation-meta">${escapeHtml(getNodeSubtitle(target))}</div>
      ${relationship.properties?.evidenceText ? `<div class="item-snippet">${escapeHtml(truncate(relationship.properties.evidenceText, 140))}</div>` : ''}
    </button>
  `;
}

function linkedNodesFromRelationships(relationships, direction, allowedTypes) {
  const seen = new Set();
  const items = [];

  for (const relationship of relationships) {
    if (allowedTypes?.length && !allowedTypes.includes(relationship.type)) continue;
    const nodeId = direction === 'incoming' ? relationship.sourceId : relationship.targetId;
    const node = state.runtime.nodeMap.get(nodeId);
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    items.push({
      node,
      meta: `${relationship.type} · ${getNodeSubtitle(node)}`
    });
  }

  return items;
}

function samePaperNodes(selectedNode) {
  if (!selectedNode.properties?.paperId || !state.graph) return [];
  return state.graph.nodes
    .filter((node) => node.id !== selectedNode.id && node.properties?.paperId === selectedNode.properties.paperId)
    .sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name))
    .slice(0, 12)
    .map((node) => ({
      node,
      meta: getNodeSubtitle(node)
    }));
}

function renderLinkedNodeButtons(items, emptyText) {
  if (!items.length) {
    return `<div class="empty-copy">${escapeHtml(emptyText)}</div>`;
  }

  return items.map(({ node, meta }) => `
    <button class="relation-item" data-node-id="${escapeHtml(node.id)}">
      <div class="relation-headline">
        <span class="type-dot" style="background:${getNodeColor(node.type)}"></span>
        <span class="item-title">${escapeHtml(node.name)}</span>
      </div>
      <div class="relation-meta">${escapeHtml(meta)}</div>
    </button>
  `).join('');
}

function detailCard(title, body) {
  return `
    <div class="detail-card">
      <h3>${escapeHtml(title)}</h3>
      <div class="list-stack">${body}</div>
    </div>
  `;
}

function buildSupplementalCards(selectedNode, outgoing, incoming) {
  const cards = [];
  const paperCluster = samePaperNodes(selectedNode);

  if (paperCluster.length) {
    cards.push(detailCard('Same paper neighborhood', renderLinkedNodeButtons(paperCluster, 'No nearby paper nodes found.')));
  }

  if (selectedNode.type === 'Problem') {
    const papers = linkedNodesFromRelationships(incoming, 'incoming', ['SOLVES']).slice(0, 12);
    const methods = linkedNodesFromRelationships(incoming, 'incoming', ['APPLIES_TO']).slice(0, 12);
    const gaps = linkedNodesFromRelationships(outgoing, 'outgoing', ['HAS_GAP']).slice(0, 12);
    cards.push(detailCard('Solved by papers', renderLinkedNodeButtons(papers, 'No papers linked to this problem yet.')));
    cards.push(detailCard('Applicable methods', renderLinkedNodeButtons(methods, 'No methods linked to this problem yet.')));
    cards.push(detailCard('Open gaps', renderLinkedNodeButtons(gaps, 'No explicit problem gaps linked yet.')));
  }

  if (selectedNode.type === 'Paper') {
    const problems = linkedNodesFromRelationships(outgoing, 'outgoing', ['SOLVES']).slice(0, 12);
    const methods = linkedNodesFromRelationships(outgoing, 'outgoing', ['USES']).slice(0, 12);
    const limitations = linkedNodesFromRelationships(outgoing, 'outgoing', ['HAS_LIMITATION']).slice(0, 12);
    cards.push(detailCard('Problems and methods', renderLinkedNodeButtons([...problems, ...methods], 'No linked problems or methods found.')));
    cards.push(detailCard('Limitations', renderLinkedNodeButtons(limitations, 'No explicit limitations linked yet.')));
  }

  if (selectedNode.type === 'Claim') {
    const supporters = linkedNodesFromRelationships(outgoing, 'outgoing', ['SUPPORTED_BY']).slice(0, 12);
    const metrics = linkedNodesFromRelationships(outgoing, 'outgoing', ['MEASURED_BY']).slice(0, 12);
    const datasets = linkedNodesFromRelationships(outgoing, 'outgoing', ['OBSERVED_ON']).slice(0, 12);
    const benchmarks = linkedNodesFromRelationships(outgoing, 'outgoing', ['BENCHMARKED_ON']).slice(0, 12);
    cards.push(detailCard('Supporting evidence', renderLinkedNodeButtons(supporters, 'No explicit supporting nodes found.')));
    cards.push(detailCard('Evaluation anchors', renderLinkedNodeButtons([...datasets, ...benchmarks, ...metrics], 'No dataset, benchmark, or metric links found for this claim.')));
  }

  if (selectedNode.type === 'Finding') {
    const paper = linkedNodesFromRelationships(incoming, 'incoming', ['REPORTS_FINDING']).slice(0, 12);
    const datasets = linkedNodesFromRelationships(outgoing, 'outgoing', ['OBSERVED_ON']).slice(0, 12);
    const benchmarks = linkedNodesFromRelationships(outgoing, 'outgoing', ['BENCHMARKED_ON']).slice(0, 12);
    const metrics = linkedNodesFromRelationships(outgoing, 'outgoing', ['MEASURED_BY']).slice(0, 12);
    const assumptions = linkedNodesFromRelationships(outgoing, 'outgoing', ['DEPENDS_ON']).slice(0, 12);
    cards.push(detailCard('Reported by papers', renderLinkedNodeButtons(paper, 'No papers linked to this finding yet.')));
    cards.push(detailCard('Evaluation anchors', renderLinkedNodeButtons([...datasets, ...benchmarks, ...metrics, ...assumptions], 'No anchors linked to this finding yet.')));
  }

  if (selectedNode.type === 'Method') {
    const papers = linkedNodesFromRelationships(incoming, 'incoming', ['USES']).slice(0, 12);
    const problems = [
      ...linkedNodesFromRelationships(outgoing, 'outgoing', ['APPLIES_TO']).slice(0, 12),
      ...linkedNodesFromRelationships(outgoing, 'outgoing', ['TRANSFERABLE_TO']).slice(0, 12)
    ];
    const assumptions = [
      ...linkedNodesFromRelationships(outgoing, 'outgoing', ['REQUIRES']).slice(0, 12),
      ...linkedNodesFromRelationships(outgoing, 'outgoing', ['DEPENDS_ON']).slice(0, 12)
    ];
    const combinations = linkedNodesFromRelationships(outgoing, 'outgoing', ['COMBINES_WITH', 'COMPATIBLE_WITH']).slice(0, 12);
    cards.push(detailCard('Used by papers', renderLinkedNodeButtons(papers, 'No papers linked to this method yet.')));
    cards.push(detailCard('Problems and assumptions', renderLinkedNodeButtons([...problems, ...assumptions], 'No linked problems or assumptions found.')));
    cards.push(detailCard('Combination paths', renderLinkedNodeButtons(combinations, 'No method-combination paths found yet.')));
  }

  if (selectedNode.type === 'Limitation') {
    const papers = linkedNodesFromRelationships(incoming, 'incoming', ['HAS_LIMITATION']).slice(0, 12);
    const remedies = linkedNodesFromRelationships(outgoing, 'outgoing', ['MAY_BE_ADDRESSED_BY']).slice(0, 12);
    cards.push(detailCard('Observed in papers', renderLinkedNodeButtons(papers, 'No papers linked to this limitation yet.')));
    cards.push(detailCard('Candidate remedy methods', renderLinkedNodeButtons(remedies, 'No candidate remedy methods found yet.')));
  }

  if (selectedNode.type === 'Assumption') {
    const papers = linkedNodesFromRelationships(incoming, 'incoming', ['ASSUMES']).slice(0, 12);
    const methods = linkedNodesFromRelationships(incoming, 'incoming', ['REQUIRES']).slice(0, 12);
    cards.push(detailCard('Assumed by', renderLinkedNodeButtons([...papers, ...methods], 'No papers or methods linked to this assumption yet.')));
  }

  if (selectedNode.type === 'Evidence') {
    const claims = linkedNodesFromRelationships(incoming, 'incoming', ['SUPPORTED_BY']).slice(0, 12);
    const anchors = [
      ...linkedNodesFromRelationships(outgoing, 'outgoing', ['OBSERVED_ON']).slice(0, 12),
      ...linkedNodesFromRelationships(outgoing, 'outgoing', ['MEASURED_BY']).slice(0, 12)
    ];
    cards.push(detailCard('Supports claims', renderLinkedNodeButtons(claims, 'No claims linked to this evidence yet.')));
    cards.push(detailCard('Observed on', renderLinkedNodeButtons(anchors, 'No dataset or metric anchors linked yet.')));
  }

  if (selectedNode.type === 'Dataset') {
    const consumers = [
      ...linkedNodesFromRelationships(incoming, 'incoming', ['EVALUATES_ON']).slice(0, 12),
      ...linkedNodesFromRelationships(incoming, 'incoming', ['OBSERVED_ON']).slice(0, 12),
      ...linkedNodesFromRelationships(incoming, 'incoming', ['DEPENDS_ON']).slice(0, 12)
    ];
    cards.push(detailCard('Observed in', renderLinkedNodeButtons(consumers, 'No papers, claims, or evidence nodes use this dataset yet.')));
  }

  if (selectedNode.type === 'Benchmark') {
    const consumers = [
      ...linkedNodesFromRelationships(incoming, 'incoming', ['BENCHMARKED_ON']).slice(0, 12),
      ...linkedNodesFromRelationships(incoming, 'incoming', ['DEPENDS_ON']).slice(0, 12)
    ];
    cards.push(detailCard('Used in evaluation', renderLinkedNodeButtons(consumers, 'No papers, methods, claims, or findings use this benchmark yet.')));
  }

  if (selectedNode.type === 'Metric') {
    const consumers = [
      ...linkedNodesFromRelationships(incoming, 'incoming', ['REPORTS']).slice(0, 12),
      ...linkedNodesFromRelationships(incoming, 'incoming', ['MEASURED_BY']).slice(0, 12)
    ];
    cards.push(detailCard('Measured by', renderLinkedNodeButtons(consumers, 'No papers, claims, or evidence nodes measure against this metric yet.')));
  }

  if (selectedNode.type === 'FutureDirection') {
    const problems = linkedNodesFromRelationships(outgoing, 'outgoing', ['RELATED_TO']).slice(0, 12);
    const papers = linkedNodesFromRelationships(incoming, 'incoming', ['SUGGESTS_FUTURE']).slice(0, 12);
    cards.push(detailCard('Suggested by papers', renderLinkedNodeButtons(papers, 'No papers linked to this future direction yet.')));
    cards.push(detailCard('Related problems', renderLinkedNodeButtons(problems, 'No related problems linked yet.')));
  }

  return cards.join('');
}

function renderDetailPanel() {
  if (!state.runtime || !state.meta) {
    detailPanel.innerHTML = '<div class="empty-copy">No corpus loaded.</div>';
    return;
  }

  const selectedNode = state.selectedNodeId ? state.runtime.nodeMap.get(state.selectedNodeId) : null;

  if (!selectedNode) {
    detailPanel.innerHTML = `
      <div class="detail-card">
        <div class="detail-headline">
          <div>
            <h2 class="detail-title">${escapeHtml(state.meta.name)}</h2>
            <div class="detail-meta">${escapeHtml(state.meta.rootPath)}</div>
          </div>
          <div class="pill"><span class="type-dot" style="background:${getNodeColor('Corpus')}"></span>Corpus</div>
        </div>
        <div class="detail-summary">
          This workspace is optimized for research graph reading: pick a problem, method, claim, or limitation, then follow constraints, evaluation anchors, and transfer paths before proposing an idea.
        </div>
      </div>
      <div class="detail-card">
        <h3>Semantic node counts</h3>
        <div class="property-grid">
          ${Object.entries(state.summary?.nodeTypes || {}).map(([type, count]) => `
            <div class="property-row">
              <div class="property-key">${escapeHtml(type)}</div>
              <div class="property-value">${count}</div>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="detail-card">
        <h3>Recommended lenses</h3>
        <div class="path-pill-grid">
          <span class="path-pill">Research core for topic selection</span>
          <span class="path-pill">Evidence lens for claim validation</span>
          <span class="path-pill">Transfer paths for method migration</span>
        </div>
      </div>
    `;
    return;
  }

  const outgoing = state.runtime.outgoing.get(selectedNode.id) || [];
  const incoming = state.runtime.incoming.get(selectedNode.id) || [];
  const selectedDistances = computeDistances(selectedNode.id);

  if (state.detailTab === 'details') {
    const properties = Object.entries(selectedNode.properties || {})
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .slice(0, 12);
    const nodeSummary = getNodeSnippet(selectedNode, 260);

    detailPanel.innerHTML = `
      <div class="detail-card detail-hero-card">
        <div class="detail-headline">
          <div>
            <h2 class="detail-title">${escapeHtml(selectedNode.name)}</h2>
            <div class="detail-meta">${escapeHtml(getNodeSubtitle(selectedNode))}</div>
          </div>
          <div class="pill"><span class="type-dot" style="background:${getNodeColor(selectedNode.type)}"></span>${escapeHtml(selectedNode.type)}</div>
        </div>
        <div class="detail-tag-row">${renderBadgeList(getNodeBadges(selectedNode))}</div>
        ${nodeSummary ? `<div class="detail-summary">${escapeHtml(nodeSummary)}</div>` : ''}
      </div>
      <div class="detail-card">
        <h3>Signals</h3>
        <div class="stat-grid">
          <div class="stat-card">
            <div class="stat-value">${incoming.length}</div>
            <div class="stat-label">Incoming</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${outgoing.length}</div>
            <div class="stat-label">Outgoing</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${selectedDistances.size - 1}</div>
            <div class="stat-label">Neighborhood</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${selectedNode.id.split(':')[0]}</div>
            <div class="stat-label">ID family</div>
          </div>
        </div>
      </div>
      <div class="detail-card">
        <h3>Properties</h3>
        <div class="property-grid">
          <div class="property-row">
            <div class="property-key">Node ID</div>
            <div class="property-value mono">${escapeHtml(selectedNode.id)}</div>
          </div>
          ${properties.length ? properties.map(([key, value]) => `
            <div class="property-row">
              <div class="property-key">${escapeHtml(key)}</div>
              <div class="property-value">${escapeHtml(truncate(formatPropertyValue(value), 280))}</div>
            </div>
          `).join('') : '<div class="empty-copy">No extra properties on this node.</div>'}
        </div>
      </div>
      ${buildSupplementalCards(selectedNode, outgoing, incoming)}
    `;
    return;
  }

  if (state.detailTab === 'relations') {
    detailPanel.innerHTML = `
      <div class="detail-card">
        <h3>Outgoing</h3>
        <div class="list-stack">
          ${outgoing.length ? outgoing.map((relationship) => relationCard(selectedNode, relationship, 'outgoing')).join('') : '<div class="empty-copy">No outgoing relationships.</div>'}
        </div>
      </div>
      <div class="detail-card">
        <h3>Incoming</h3>
        <div class="list-stack">
          ${incoming.length ? incoming.map((relationship) => relationCard(selectedNode, relationship, 'incoming')).join('') : '<div class="empty-copy">No incoming relationships.</div>'}
        </div>
      </div>
    `;
    return;
  }

  const buckets = computeImpact(selectedNode.id, state.impactDirection);
  detailPanel.innerHTML = `
    <div class="detail-card">
      <h3>Impact traversal</h3>
      <div class="impact-direction-row">
        <button class="impact-button ${state.impactDirection === 'upstream' ? 'active' : ''}" data-impact-direction="upstream">Upstream</button>
        <button class="impact-button ${state.impactDirection === 'downstream' ? 'active' : ''}" data-impact-direction="downstream">Downstream</button>
      </div>
      <div class="property-value subtle">
        Follow what supports this node, what it depends on, and which problems, methods, constraints, and evaluation anchors it influences across the graph.
      </div>
    </div>
    <div class="detail-card">
      <h3>Depth buckets</h3>
      ${buckets.length ? buckets.map((bucket) => `
        <div class="impact-bucket">
          <div class="impact-depth">Depth ${bucket.depth}</div>
          <div class="list-stack">
            ${bucket.items.map(({ node, via }) => `
              <button class="relation-item" data-node-id="${escapeHtml(node.id)}">
                <div class="relation-headline">
                  <span class="type-dot" style="background:${getNodeColor(node.type)}"></span>
                  <span class="item-title">${escapeHtml(node.name)}</span>
                </div>
                <div class="relation-meta">${escapeHtml(via)} · ${escapeHtml(getNodeSubtitle(node))}</div>
              </button>
            `).join('')}
          </div>
        </div>
      `).join('') : '<div class="empty-copy">No visible impact at the current depth.</div>'}
    </div>
  `;
}

function renderCanvasLegend() {
  if (!state.runtime || !state.graph) {
    canvasLegend.innerHTML = '';
    canvasLegend.classList.add('hidden');
    return;
  }

  const visibleNodes = getVisibleNodes();
  const visibleEdges = getVisibleRelationships(new Set(visibleNodes.map((node) => node.id)));
  const layerCounts = visibleNodes.reduce((acc, node) => {
    const layer = getNodeLayerName(node);
    acc[layer] = (acc[layer] || 0) + 1;
    return acc;
  }, {});
  const relationCounts = visibleEdges.reduce((acc, relationship) => {
    acc[relationship.type] = (acc[relationship.type] || 0) + 1;
    return acc;
  }, {});
  const topLayers = Object.entries(layerCounts).sort((left, right) => right[1] - left[1]).slice(0, 4);
  const topRelations = Object.entries(relationCounts).sort((left, right) => right[1] - left[1]).slice(0, 4);

  canvasLegend.innerHTML = `
    <div class="legend-section">
      <div class="legend-title">Visible layers</div>
      <div class="legend-stack">
        ${topLayers.map(([layer, count]) => `
          <div class="legend-row">
            <span class="legend-row-label"><span class="legend-swatch" style="background:${getLayerColor(layer)}"></span>${escapeHtml(formatLayerName(layer))}</span>
            <span class="legend-row-count">${count}</span>
          </div>
        `).join('')}
      </div>
    </div>
    <div class="legend-section">
      <div class="legend-title">Active relations</div>
      <div class="path-pill-grid compact">
        ${topRelations.length
          ? topRelations.map(([type, count]) => `<span class="path-pill">${escapeHtml(type)} · ${count}</span>`).join('')
          : '<span class="path-pill">No visible edges</span>'}
      </div>
    </div>
  `;
  canvasLegend.classList.remove('hidden');
}

function renderCanvasFocusCard() {
  if (!state.runtime || !state.graph) {
    canvasFocusCard.innerHTML = '';
    canvasFocusCard.classList.add('hidden');
    return;
  }

  if (!state.selectedNodeId) {
    const activePreset = Object.keys(FILTER_PRESETS).find((key) => presetIsActive(key));
    canvasFocusCard.innerHTML = `
      <div class="legend-title">Current scope</div>
      <div class="focus-title">${escapeHtml(activePreset ? FILTER_PRESETS[activePreset].label : 'Custom scope')}</div>
      <div class="focus-copy">Select a node to inspect its research role, evidence anchors, and transfer paths.</div>
    `;
    canvasFocusCard.classList.remove('hidden');
    return;
  }

  const node = state.runtime.nodeMap.get(state.selectedNodeId);
  if (!node) {
    canvasFocusCard.classList.add('hidden');
    return;
  }

  const distances = computeDistances(node.id);
  canvasFocusCard.innerHTML = `
    <div class="legend-title">Focus node</div>
    <div class="focus-title">${escapeHtml(node.name)}</div>
    <div class="detail-tag-row">${renderBadgeList(getNodeBadges(node), 'mini-pill')}</div>
    <div class="focus-copy">${escapeHtml(getNodeSnippet(node, 150) || getNodeSubtitle(node))}</div>
    <div class="focus-metrics">
      <span>${distances.size - 1} nearby nodes</span>
      <span>${(state.runtime.outgoing.get(node.id) || []).length} outgoing</span>
      <span>${(state.runtime.incoming.get(node.id) || []).length} incoming</span>
    </div>
  `;
  canvasFocusCard.classList.remove('hidden');
}

function renderSelectionBadge() {
  if (!state.runtime || !state.selectedNodeId) {
    selectionBadge.textContent = 'No node selected';
    return;
  }

  const node = state.runtime.nodeMap.get(state.selectedNodeId);
  const distances = computeDistances(state.selectedNodeId);
  selectionBadge.innerHTML = `
    <strong>${escapeHtml(node.name)}</strong>
    <span class="badge-copy"> · ${escapeHtml(node.type)} · ${escapeHtml(formatLayerName(getNodeLayerName(node)))} · ${distances.size - 1} nearby nodes</span>
  `;
}

function renderTopbarActions() {
  backupButton.disabled = !state.activeCorpusName || state.backupInProgress;
  backupButton.textContent = state.backupInProgress ? 'Backing up...' : 'Backup';
  llmCurrentLabel.textContent = formatLlmLabel(state.llmConfig?.llm);
  llmToggleButton.disabled = state.llmSaveInProgress;
  llmToggleButton.textContent = state.llmEditorOpen ? 'Close' : 'Switch';
  llmSaveButton.disabled = state.llmSaveInProgress;
  llmSaveButton.textContent = state.llmSaveInProgress ? 'Saving...' : 'Save';
  llmPopover.classList.toggle('hidden', !state.llmEditorOpen);
}

function renderStatusbar() {
  if (!state.meta) {
    statusbar.innerHTML = `
      <span>No graph loaded</span>
      <span class="mono">Run papernexus analyze &lt;path&gt;</span>
    `;
    return;
  }

  const visibleNodes = getVisibleNodes();
  const visibleEdges = getVisibleRelationships(new Set(visibleNodes.map((node) => node.id))).length;
  const secondaryMessage = state.noticeMessage
    ? escapeHtml(state.noticeMessage)
    : `${visibleNodes.length} visible nodes · ${visibleEdges} visible edges · ${state.visibleLayers.size} layers active · drag to pan · scroll to zoom`;
  statusbar.innerHTML = `
    <span>${escapeHtml(state.meta.name)} · ${escapeHtml(state.meta.sourceMode)} · ${state.meta.paperCount} papers · ${getTypeCount('Problem')} problems · ${getTypeCount('Method')} methods${state.meta.buildMode ? ` · ${escapeHtml(state.meta.buildMode)}` : ''}</span>
    <span>${secondaryMessage}</span>
  `;
}

function updateTooltip(event) {
  if (!state.hoveredNodeId || !state.runtime) {
    canvasTooltip.classList.add('hidden');
    return;
  }

  const node = state.runtime.nodeMap.get(state.hoveredNodeId);
  if (!node) {
    canvasTooltip.classList.add('hidden');
    return;
  }

  canvasTooltip.innerHTML = `
    <div><strong>${escapeHtml(node.name)}</strong></div>
    <div class="badge-copy">${escapeHtml(getNodeSubtitle(node))}</div>
  `;
  canvasTooltip.style.left = `${event.offsetX + 18}px`;
  canvasTooltip.style.top = `${event.offsetY + 18}px`;
  canvasTooltip.classList.remove('hidden');
}

function pickNodeAt(x, y) {
  if (!state.runtime) return null;
  const nodes = [...getVisibleNodes()].reverse();

  for (const node of nodes) {
    const screen = worldToScreen(state.runtime.positions.get(node.id));
    const radius = nodeRadius(node) + 6;
    const distance = Math.hypot(screen.x - x, screen.y - y);
    if (distance <= radius) {
      return node;
    }
  }

  return null;
}

function selectNode(nodeId, options = {}) {
  if (!nodeId) {
    clearSelection();
    return;
  }

  state.selectedNodeId = nodeId;
  renderAll();
  if (options.focus !== false) {
    focusNode(nodeId);
  }
}

function clearSelection() {
  state.selectedNodeId = null;
  renderAll();
}

function renderAll() {
  renderOverview();
  renderFilters();
  renderNavigator();
  renderNavigatorPicker();
  renderDetailPanel();
  renderCanvasLegend();
  renderCanvasFocusCard();
  renderSelectionBadge();
  renderTopbarActions();
  renderStatusbar();
  drawCanvas();
}

async function loadCorpora() {
  const [payload] = await Promise.all([
    fetchJson('/api/corpora'),
    loadLlmConfig().catch(() => {})
  ]);
  state.corpora = payload.corpora || [];
  renderCorpusOptions();

  const params = new URLSearchParams(window.location.search);
  const requestedCorpus = params.get('corpus');
  const initialCorpus = requestedCorpus || state.activeCorpusName || state.corpora[0]?.name || '';

  if (initialCorpus) {
    await loadCorpus(initialCorpus);
  } else {
    renderEmptyState();
  }
}

function stopCorpusAutoRefresh() {
  if (corpusMetaPollHandle) {
    window.clearInterval(corpusMetaPollHandle);
    corpusMetaPollHandle = null;
  }
}

async function checkForCorpusUpdates() {
  if (!state.activeCorpusName || !state.meta || document.hidden) return;

  try {
    const payload = await fetchJson(`/api/corpus-meta?name=${encodeURIComponent(state.activeCorpusName)}`);
    const nextMeta = payload.meta;
    if (!nextMeta) return;

    const changed = (
      nextMeta.indexedAt !== state.meta.indexedAt
      || nextMeta.nodeCount !== state.meta.nodeCount
      || nextMeta.relationshipCount !== state.meta.relationshipCount
    );

    if (!changed) return;

    await loadCorpus(state.activeCorpusName, {
      preserveSelection: true,
      preserveFilters: true,
      preserveView: true,
      skipAutoRefreshRestart: true
    });
  } catch (error) {
    // Ignore transient polling failures; the next interval will retry.
  }
}

function startCorpusAutoRefresh() {
  stopCorpusAutoRefresh();
  if (!state.activeCorpusName) return;

  corpusMetaPollHandle = window.setInterval(() => {
    checkForCorpusUpdates();
  }, 4000);
}

function renderCorpusOptions() {
  corpusSelect.innerHTML = state.corpora.map((corpus) => `
    <option value="${escapeHtml(corpus.name)}">${escapeHtml(corpus.name)}</option>
  `).join('');

  if (state.activeCorpusName) {
    corpusSelect.value = state.activeCorpusName;
  }
}

function renderEmptyState() {
  stopCorpusAutoRefresh();
  state.activeCorpusName = '';
  state.noticeMessage = '';
  state.navigatorQuery = '';
  state.navigatorPickerOpen = false;
  overviewCard.innerHTML = '<div class="empty-copy">No indexed corpus found yet.</div>';
  filterPresets.innerHTML = '';
  filterSummary.innerHTML = '';
  canvasLegend.innerHTML = '';
  canvasLegend.classList.add('hidden');
  canvasFocusCard.innerHTML = '';
  canvasFocusCard.classList.add('hidden');
  navigatorMeta.innerHTML = '';
  navigatorPickerInput.value = '';
  navigatorPickerResults.innerHTML = '';
  navigatorPickerResults.classList.add('hidden');
  navigatorList.innerHTML = `
    <div class="empty-state">
      <div>
        <h2>Index a corpus first</h2>
        <p>Run <span class="mono">papernexus analyze /path/to/papers --name my-corpus</span>, then refresh this workspace. The UI will automatically pick up the local semantic graph.</p>
      </div>
    </div>
  `;
  detailPanel.innerHTML = '<div class="empty-copy">Graph inspector will appear here.</div>';
  statusbar.innerHTML = '<span>No corpus indexed.</span><span class="mono">papernexus analyze &lt;path&gt;</span>';
  renderTopbarActions();
  drawCanvas();
}

async function loadCorpus(name, options = {}) {
  if (!name) return;
  const previousSelectedNodeId = options.preserveSelection ? state.selectedNodeId : null;
  const previousVisibleNodeTypes = options.preserveFilters ? new Set(state.visibleNodeTypes) : null;
  const previousVisibleLayers = options.preserveFilters ? new Set(state.visibleLayers) : null;
  const previousVisibleRelationTypes = options.preserveFilters ? new Set(state.visibleRelationTypes) : null;
  const previousViewMode = options.preserveFilters ? state.viewMode : 'all';
  const previousNavigatorQuery = options.preserveView ? state.navigatorQuery : '';
  const payload = await fetchJson(`/api/corpus?name=${encodeURIComponent(name)}`);
  state.activeCorpusName = payload.meta.name;
  state.meta = payload.meta;
  state.graph = payload.graph;
  state.summary = payload.summary;
  state.runtime = createGraphRuntime(payload.graph);
  state.navigatorQuery = previousNavigatorQuery;
  state.navigatorPickerOpen = false;

  const fallbackSelectedNodeId = payload.graph.nodes.find((node) => node.type === 'Corpus')?.id || null;
  state.selectedNodeId = (
    previousSelectedNodeId
    && state.runtime.nodeMap.has(previousSelectedNodeId)
      ? previousSelectedNodeId
      : fallbackSelectedNodeId
  );

  state.visibleNodeTypes = previousVisibleNodeTypes
    ? new Set([...previousVisibleNodeTypes].filter((type) => state.runtime.nodeTypes.includes(type)))
    : new Set(DEFAULT_NODE_TYPES.filter((type) => state.runtime.nodeTypes.includes(type)));
  state.visibleLayers = previousVisibleLayers
    ? new Set([...previousVisibleLayers].filter((layer) => state.runtime.layers.includes(layer)))
    : new Set(state.runtime.layers);
  state.visibleRelationTypes = previousVisibleRelationTypes
    ? new Set([...previousVisibleRelationTypes].filter((type) => state.runtime.relationTypes.includes(type)))
    : new Set(DEFAULT_RELATION_TYPES.filter((type) => state.runtime.relationTypes.includes(type)));
  state.viewMode = previousViewMode;

  corpusSelect.value = payload.meta.name;
  if (!options.preserveView) {
    state.cameraInteracted = false;
  }
  renderAll();
  if (!options.preserveView) {
    scheduleCameraFit();
  }
  if (!options.skipAutoRefreshRestart) {
    startCorpusAutoRefresh();
  }
}

async function triggerBackup() {
  if (!state.activeCorpusName || state.backupInProgress) return;

  state.backupInProgress = true;
  state.noticeMessage = `Creating backup for ${state.activeCorpusName}...`;
  renderTopbarActions();
  renderStatusbar();

  try {
    const payload = await postJson(`/api/backup?name=${encodeURIComponent(state.activeCorpusName)}`);
    const backupPath = payload.backup?.backupPath || '';
    state.noticeMessage = backupPath
      ? `Backup saved to ${truncate(backupPath, 140)}`
      : `Backup created for ${state.activeCorpusName}`;
  } catch (error) {
    state.noticeMessage = `Backup failed: ${error.message}`;
  } finally {
    state.backupInProgress = false;
    renderTopbarActions();
    renderStatusbar();
  }
}

async function saveLlmConfig() {
  const provider = llmProviderSelect.value;
  const model = llmModelInput.value.trim();
  if (!model) {
    state.noticeMessage = 'LLM model is required.';
    renderStatusbar();
    return;
  }

  state.llmSaveInProgress = true;
  state.noticeMessage = `Saving LLM config: ${provider} · ${model}`;
  renderTopbarActions();
  renderStatusbar();

  try {
    const payload = await postJson('/api/llm-config', {
      llm: {
        provider,
        model
      }
    });
    state.llmConfig = payload;
    state.llmEditorOpen = false;
    syncLlmInputs();
    state.noticeMessage = payload.message || `Saved LLM config: ${formatLlmLabel(payload.llm)}`;
  } catch (error) {
    state.noticeMessage = `Saving LLM config failed: ${error.message}`;
  } finally {
    state.llmSaveInProgress = false;
    renderTopbarActions();
    renderStatusbar();
  }
}

function bindEvents() {
  searchInput.addEventListener('input', () => {
    state.searchQuery = searchInput.value;
    updateSearchResults();
  });

  searchInput.addEventListener('focus', updateSearchResults);
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#search-shell')) {
      searchResults.classList.add('hidden');
    }
    if (!event.target.closest('#navigator-picker-shell')) {
      state.navigatorPickerOpen = false;
      renderNavigatorPicker();
    }
    if (!event.target.closest('#llm-shell')) {
      state.llmEditorOpen = false;
      renderTopbarActions();
    }
  });

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
    if (event.key === 'Escape') {
      clearSelection();
      searchResults.classList.add('hidden');
    }
  });

  searchResults.addEventListener('click', (event) => {
    const button = event.target.closest('[data-node-id]');
    if (!button) return;
    selectNode(button.dataset.nodeId);
    searchResults.classList.add('hidden');
  });

  navigatorPickerInput.addEventListener('focus', () => {
    state.navigatorPickerOpen = true;
    renderNavigatorPicker();
  });

  navigatorPickerInput.addEventListener('input', () => {
    state.navigatorQuery = navigatorPickerInput.value;
    state.navigatorPickerOpen = true;
    renderNavigator();
    renderNavigatorPicker();
  });

  navigatorPickerInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      state.navigatorPickerOpen = false;
      renderNavigatorPicker();
      return;
    }

    if (event.key !== 'Enter') return;
    const first = getNavigatorItems().filteredItems[0];
    if (!first) return;
    event.preventDefault();
    state.navigatorQuery = first.name;
    state.navigatorPickerOpen = false;
    renderNavigator();
    renderNavigatorPicker();
    selectNode(first.id);
  });

  navigatorPickerClear.addEventListener('click', () => {
    state.navigatorQuery = '';
    state.navigatorPickerOpen = true;
    renderNavigator();
    renderNavigatorPicker();
    navigatorPickerInput.focus();
  });

  navigatorPickerResults.addEventListener('click', (event) => {
    const button = event.target.closest('[data-node-id]');
    if (!button) return;
    const node = state.runtime?.nodeMap.get(button.dataset.nodeId);
    state.navigatorQuery = node?.name || '';
    state.navigatorPickerOpen = false;
    renderNavigator();
    renderNavigatorPicker();
    selectNode(button.dataset.nodeId);
  });

  corpusSelect.addEventListener('change', async () => {
    await loadCorpus(corpusSelect.value);
  });

  llmToggleButton.addEventListener('click', () => {
    state.llmEditorOpen = !state.llmEditorOpen;
    syncLlmInputs();
    renderTopbarActions();
  });
  llmSaveButton.addEventListener('click', saveLlmConfig);
  backupButton.addEventListener('click', triggerBackup);
  refreshButton.addEventListener('click', loadCorpora);

  filterPresets.addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter-preset]');
    if (!button) return;
    applyFilterPreset(button.dataset.filterPreset);
  });

  nodeFilterChips.addEventListener('click', (event) => {
    const button = event.target.closest('[data-node-type]');
    if (!button) return;
    const type = button.dataset.nodeType;
    if (state.visibleNodeTypes.has(type)) state.visibleNodeTypes.delete(type);
    else state.visibleNodeTypes.add(type);
    renderAll();
    state.cameraInteracted = false;
    scheduleCameraFit();
  });

  relationFilterChips.addEventListener('click', (event) => {
    const button = event.target.closest('[data-relation-type]');
    if (!button) return;
    const type = button.dataset.relationType;
    if (state.visibleRelationTypes.has(type)) state.visibleRelationTypes.delete(type);
    else state.visibleRelationTypes.add(type);
    renderAll();
    state.cameraInteracted = false;
    scheduleCameraFit();
  });

  layerFilterChips.addEventListener('click', (event) => {
    const button = event.target.closest('[data-layer-name]');
    if (!button) return;
    const layer = button.dataset.layerName;
    if (state.visibleLayers.has(layer)) state.visibleLayers.delete(layer);
    else state.visibleLayers.add(layer);
    renderAll();
    state.cameraInteracted = false;
    scheduleCameraFit();
  });

  document.getElementById('navigator-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (!button) return;
    state.navigatorTab = button.dataset.tab;
    state.navigatorQuery = '';
    state.navigatorPickerOpen = false;
    document.querySelectorAll('#navigator-tabs .tab-button').forEach((element) => {
      element.classList.toggle('active', element.dataset.tab === state.navigatorTab);
    });
    renderNavigator();
    renderNavigatorPicker();
  });

  document.getElementById('detail-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (!button) return;
    state.detailTab = button.dataset.tab;
    document.querySelectorAll('#detail-tabs .tab-button').forEach((element) => {
      element.classList.toggle('active', element.dataset.tab === state.detailTab);
    });
    renderDetailPanel();
  });

  navigatorList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-node-id]');
    if (!button) return;
    selectNode(button.dataset.nodeId);
  });

  overviewCard.addEventListener('click', (event) => {
    const button = event.target.closest('[data-problem-name]');
    if (!button || !state.graph) return;
    const problemNode = state.graph.nodes.find((node) => node.type === 'Problem' && node.name === button.dataset.problemName);
    if (problemNode) selectNode(problemNode.id);
  });

  detailPanel.addEventListener('click', (event) => {
    const nodeButton = event.target.closest('[data-node-id]');
    if (nodeButton) {
      selectNode(nodeButton.dataset.nodeId);
      return;
    }

    const impactButton = event.target.closest('[data-impact-direction]');
    if (impactButton) {
      state.impactDirection = impactButton.dataset.impactDirection;
      renderDetailPanel();
    }
  });

  depthRange.addEventListener('input', () => {
    state.depthFilter = Number(depthRange.value);
    depthValue.textContent = depthRange.value;
    renderAll();
    if (!state.cameraInteracted) {
      scheduleCameraFit();
    }
  });

  zoomInButton.addEventListener('click', () => {
    state.camera.scale = Math.min(3, state.camera.scale * 1.18);
    state.cameraInteracted = true;
    drawCanvas();
  });

  zoomOutButton.addEventListener('click', () => {
    state.camera.scale = Math.max(0.12, state.camera.scale / 1.18);
    state.cameraInteracted = true;
    drawCanvas();
  });

  fitButton.addEventListener('click', () => {
    state.cameraInteracted = false;
    fitCamera();
    drawCanvas();
  });

  focusButton.addEventListener('click', () => {
    if (state.selectedNodeId) {
      focusNode(state.selectedNodeId);
    }
  });

  clearButton.addEventListener('click', clearSelection);

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const pointerBefore = screenToWorld(event.offsetX, event.offsetY);
    const previous = state.camera.scale;
    state.camera.scale = Math.max(0.12, Math.min(3, state.camera.scale * (event.deltaY > 0 ? 0.92 : 1.08)));
    const pointerAfter = screenToWorld(event.offsetX, event.offsetY);
    state.camera.x += pointerBefore.x - pointerAfter.x;
    state.camera.y += pointerBefore.y - pointerAfter.y;
    state.cameraInteracted = true;
    if (previous !== state.camera.scale) drawCanvas();
  }, { passive: false });

  canvas.addEventListener('mousedown', (event) => {
    state.drag = {
      startX: event.clientX,
      startY: event.clientY,
      moved: false
    };
  });

  window.addEventListener('mousemove', (event) => {
    if (state.drag) {
      const deltaX = event.clientX - state.drag.startX;
      const deltaY = event.clientY - state.drag.startY;
      if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
        state.drag.moved = true;
      }
      state.camera.x -= deltaX / state.camera.scale;
      state.camera.y -= deltaY / state.camera.scale;
      state.drag.startX = event.clientX;
      state.drag.startY = event.clientY;
      state.cameraInteracted = true;
      drawCanvas();
    }

    const rect = canvas.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
      state.hoveredNodeId = null;
      canvasTooltip.classList.add('hidden');
      drawCanvas();
      return;
    }

    const node = pickNodeAt(event.clientX - rect.left, event.clientY - rect.top);
    const previous = state.hoveredNodeId;
    state.hoveredNodeId = node?.id || null;
    updateTooltip({ offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top });
    if (previous !== state.hoveredNodeId) drawCanvas();
  });

  window.addEventListener('mouseup', (event) => {
    if (!state.drag) return;
    const rect = canvas.getBoundingClientRect();
    const wasMoved = state.drag.moved;
    state.drag = null;

    if (!wasMoved && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
      const node = pickNodeAt(event.clientX - rect.left, event.clientY - rect.top);
      if (node) {
        selectNode(node.id, { focus: false });
      } else {
        clearSelection();
      }
    }
  });

  window.addEventListener('resize', () => {
    if (state.cameraInteracted) {
      drawCanvas();
      return;
    }
    scheduleCameraFit();
  });
}

bindEvents();
loadCorpora().catch((error) => {
  overviewCard.innerHTML = `<div class="empty-copy">${escapeHtml(error.message)}</div>`;
  renderEmptyState();
});
