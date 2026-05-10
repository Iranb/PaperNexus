function normalizeVenueText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const VENUE_REGISTRY = [
  {
    venueFamily: 'neurips',
    venueType: 'conference',
    tier: 'top',
    domain: 'ml',
    aliases: ['neurips', 'nips', 'advances in neural information processing systems'],
    packs: ['cs_ml_core']
  },
  {
    venueFamily: 'icml',
    venueType: 'conference',
    tier: 'top',
    domain: 'ml',
    aliases: ['icml', 'international conference on machine learning'],
    packs: ['cs_ml_core']
  },
  {
    venueFamily: 'iclr',
    venueType: 'conference',
    tier: 'top',
    domain: 'ml',
    aliases: ['iclr', 'international conference on learning representations'],
    packs: ['cs_ml_core']
  },
  {
    venueFamily: 'aaai',
    venueType: 'conference',
    tier: 'top',
    domain: 'ai',
    aliases: ['aaai', 'aaai conference on artificial intelligence'],
    packs: ['cs_ml_core']
  },
  {
    venueFamily: 'ijcai',
    venueType: 'conference',
    tier: 'top',
    domain: 'ai',
    aliases: ['ijcai', 'international joint conference on artificial intelligence'],
    packs: ['cs_ml_core']
  },
  {
    venueFamily: 'cvpr',
    venueType: 'conference',
    tier: 'top',
    domain: 'cv',
    aliases: ['cvpr', 'conference on computer vision and pattern recognition'],
    packs: ['cv_core']
  },
  {
    venueFamily: 'iccv',
    venueType: 'conference',
    tier: 'top',
    domain: 'cv',
    aliases: ['iccv', 'international conference on computer vision'],
    packs: ['cv_core']
  },
  {
    venueFamily: 'eccv',
    venueType: 'conference',
    tier: 'top',
    domain: 'cv',
    aliases: ['eccv', 'european conference on computer vision'],
    packs: ['cv_core']
  },
  {
    venueFamily: 'acl',
    venueType: 'conference',
    tier: 'top',
    domain: 'nlp',
    aliases: ['acl', 'annual meeting of the association for computational linguistics'],
    packs: ['nlp_core']
  },
  {
    venueFamily: 'emnlp',
    venueType: 'conference',
    tier: 'top',
    domain: 'nlp',
    aliases: ['emnlp', 'conference on empirical methods in natural language processing'],
    packs: ['nlp_core']
  },
  {
    venueFamily: 'naacl',
    venueType: 'conference',
    tier: 'top',
    domain: 'nlp',
    aliases: ['naacl', 'north american chapter of the association for computational linguistics'],
    packs: ['nlp_core']
  },
  {
    venueFamily: 'sigir',
    venueType: 'conference',
    tier: 'top',
    domain: 'ir',
    aliases: ['sigir', 'international acm sigir conference on research and development in information retrieval'],
    packs: ['ir_dm_core']
  },
  {
    venueFamily: 'kdd',
    venueType: 'conference',
    tier: 'top',
    domain: 'dm',
    aliases: ['kdd', 'acm sigkdd conference on knowledge discovery and data mining'],
    packs: ['ir_dm_core']
  },
  {
    venueFamily: 'vldb',
    venueType: 'conference',
    tier: 'top',
    domain: 'db',
    aliases: ['vldb', 'very large data bases', 'pvldb', 'proceedings of the vldb endowment'],
    packs: ['db_core']
  },
  {
    venueFamily: 'sigmod',
    venueType: 'conference',
    tier: 'top',
    domain: 'db',
    aliases: ['sigmod', 'international conference on management of data', 'acm sigmod'],
    packs: ['db_core']
  },
  {
    venueFamily: 'sosp',
    venueType: 'conference',
    tier: 'top',
    domain: 'systems',
    aliases: ['sosp', 'symposium on operating systems principles'],
    packs: ['systems_core']
  },
  {
    venueFamily: 'osdi',
    venueType: 'conference',
    tier: 'top',
    domain: 'systems',
    aliases: ['osdi', 'operating systems design and implementation'],
    packs: ['systems_core']
  },
  {
    venueFamily: 'chi',
    venueType: 'conference',
    tier: 'top',
    domain: 'hci',
    aliases: ['chi', 'conference on human factors in computing systems'],
    packs: ['hci_core']
  },
  {
    venueFamily: 'jmlr',
    venueType: 'journal',
    tier: 'top',
    domain: 'ml',
    aliases: ['jmlr', 'journal of machine learning research'],
    packs: ['cs_ml_core']
  },
  {
    venueFamily: 'tpami',
    venueType: 'journal',
    tier: 'top',
    domain: 'cv',
    aliases: ['tpami', 'ieee transactions on pattern analysis and machine intelligence'],
    packs: ['cv_core', 'cs_ml_core']
  },
  {
    venueFamily: 'nature',
    venueType: 'journal',
    tier: 'top',
    domain: 'science',
    aliases: ['nature'],
    packs: ['general_science_core']
  },
  {
    venueFamily: 'science',
    venueType: 'journal',
    tier: 'top',
    domain: 'science',
    aliases: ['science'],
    packs: ['general_science_core']
  },
  {
    venueFamily: 'cell',
    venueType: 'journal',
    tier: 'top',
    domain: 'biomed',
    aliases: ['cell'],
    packs: ['biomed_core', 'general_science_core']
  },
  {
    venueFamily: 'nejm',
    venueType: 'journal',
    tier: 'top',
    domain: 'biomed',
    aliases: ['nejm', 'new england journal of medicine'],
    packs: ['biomed_core', 'general_science_core']
  },
  {
    venueFamily: 'the_lancet',
    venueType: 'journal',
    tier: 'top',
    domain: 'biomed',
    aliases: ['the lancet', 'lancet'],
    packs: ['biomed_core', 'general_science_core']
  }
];

const NORMALIZED_REGISTRY = VENUE_REGISTRY.map((entry) => ({
  ...entry,
  normalizedAliases: entry.aliases.map(normalizeVenueText).filter(Boolean)
}));

function packScore(entry, preferredPacks = []) {
  const overlap = entry.packs.filter((pack) => preferredPacks.includes(pack)).length;
  return overlap * 100 + (entry.tier === 'top' ? 10 : entry.tier === 'strong' ? 5 : 0);
}

export function matchVenueRegistry(params = {}) {
  const normalizedVenue = normalizeVenueText(params.venue);
  if (!normalizedVenue) {
    return {
      venueFamily: null,
      venueType: 'unknown',
      venuePackHits: [],
      venueAliasesMatched: []
    };
  }
  const preferredPacks = Array.isArray(params.preferredPacks) ? params.preferredPacks : [];
  const matches = NORMALIZED_REGISTRY.filter((entry) => (
    entry.normalizedAliases.some((alias) => normalizedVenue.includes(alias) || alias.includes(normalizedVenue))
  )).sort((left, right) => packScore(right, preferredPacks) - packScore(left, preferredPacks));
  const best = matches[0];
  if (!best) {
    return {
      venueFamily: null,
      venueType: 'unknown',
      venuePackHits: [],
      venueAliasesMatched: []
    };
  }
  return {
    venueFamily: best.venueFamily,
    venueType: best.venueType,
    venuePackHits: [...new Set(matches.flatMap((entry) => entry.packs))],
    venueAliasesMatched: [...new Set(matches.flatMap((entry) => (
      entry.normalizedAliases.filter((alias) => normalizedVenue.includes(alias) || alias.includes(normalizedVenue))
    )))]
  };
}

export function inferVenuePacksFromTopic(topic = '') {
  const normalized = normalizeVenueText(topic);
  const packs = new Set();
  const addIfMatch = (pattern, pack) => {
    if (pattern.test(normalized)) packs.add(pack);
  };
  addIfMatch(/\bvision|image|video|detection|segmentation|multimodal\b/, 'cv_core');
  addIfMatch(/\blanguage|llm|text|translation|summarization|reasoning|nlp\b/, 'nlp_core');
  addIfMatch(/\bretrieval|search|ranking|recommendation|query\b/, 'ir_dm_core');
  addIfMatch(/\bdatabase|sql|data engineering|transaction|olap\b/, 'db_core');
  addIfMatch(/\bsystem|distributed|network|kernel|storage|os\b/, 'systems_core');
  addIfMatch(/\bhci|interaction|ui|ux|human\b/, 'hci_core');
  addIfMatch(/\bbiomed|medical|clinical|genomics|protein|drug|patient\b/, 'biomed_core');
  addIfMatch(/\bmachine learning|deep learning|representation|graph neural|reinforcement|agent\b/, 'cs_ml_core');
  if (packs.size === 0 && /\b(llm|learning|neural|algorithm|benchmark|dataset)\b/.test(normalized)) {
    packs.add('cs_ml_core');
  }
  return [...packs];
}

export function listVenueRegistryEntries() {
  return VENUE_REGISTRY.map((entry) => ({
    ...entry,
    aliases: [...entry.aliases],
    packs: [...entry.packs]
  }));
}
