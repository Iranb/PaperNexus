const docsBase = process.env.PAPERNEXUS_DOCS_BASE
  || (process.env.GITHUB_ACTIONS ? '/PaperNexus/' : '/');

function sidebarOverview() {
  return [
    {
      text: 'Overview',
      items: [
        { text: 'Open PaperNexus', link: '/overview/' }
      ]
    }
  ];
}

function sidebarGetStarted() {
  return [
    {
      text: 'Get Started',
      items: [
        { text: 'Install And First Corpus', link: '/get-started/' }
      ]
    }
  ];
}

function sidebarPipeline() {
  return [
    {
      text: 'Pipeline',
      items: [
        { text: 'Pipeline Overview', link: '/pipeline/' },
        { text: 'PDF Parsers And Runtime', link: '/pipeline/pdf-parsers-and-runtime' },
        { text: 'Imports And Queue', link: '/pipeline/imports-and-queue' },
        { text: 'Import Recovery And Performance', link: '/pipeline/import-recovery-and-performance' }
      ]
    }
  ];
}

function sidebarGraph() {
  return [
    {
      text: 'Graph',
      items: [
        { text: 'Graph Overview', link: '/graph/' },
        { text: 'Cross-Domain Intelligence', link: '/graph/cross-domain-intelligence' },
        { text: 'KG Innovation Discovery Review', link: '/graph/knowledge-graph-innovation-discovery-review.zh-CN' }
      ]
    }
  ];
}

function sidebarInterfaces() {
  return [
    {
      text: 'Interfaces',
      items: [
        { text: 'Interfaces Overview', link: '/interfaces/' },
        { text: 'Remote Import And Skills', link: '/interfaces/remote-import-and-skills' }
      ]
    }
  ];
}

function sidebarStorage() {
  return [
    {
      text: 'Storage',
      items: [
        { text: 'Storage Overview', link: '/storage/' }
      ]
    }
  ];
}

function sidebarOperations() {
  return [
    {
      text: 'Operations',
      items: [
        { text: 'Operations Overview', link: '/operations/' }
      ]
    }
  ];
}

function sidebarReference() {
  return [
    {
      text: 'Reference',
      items: [
        { text: 'Reference Hub', link: '/reference/' },
        { text: 'Generated Index', link: '/reference/generated/' },
        { text: 'CLI', link: '/reference/generated/cli' },
        { text: 'MCP Tools', link: '/reference/generated/mcp-tools' },
        { text: 'Config', link: '/reference/generated/config' },
        { text: 'Graph Schema', link: '/reference/generated/graph-schema' },
        { text: 'HTTP Serve', link: '/reference/generated/http-serve' },
        { text: 'Module Map', link: '/reference/generated/module-map' },
        { text: 'Scripts', link: '/reference/generated/scripts' }
      ]
    }
  ];
}

export default {
  title: 'PaperNexus',
  description: 'Detailed system documentation for the PaperNexus analysis and research knowledge graph engine.',
  base: docsBase,
  cleanUrls: true,
  srcExclude: [
    'superpowers/**'
  ],
  ignoreDeadLinks: [
    /^https:\/\/docs\.openclaw\.ai\//
  ],
  themeConfig: {
    logo: {
      text: 'PaperNexus'
    },
    nav: [
      { text: 'Overview', link: '/overview/' },
      { text: 'Get Started', link: '/get-started/' },
      { text: 'Pipeline', link: '/pipeline/' },
      { text: 'Graph', link: '/graph/' },
      { text: 'Interfaces', link: '/interfaces/' },
      { text: 'Storage', link: '/storage/' },
      { text: 'Operations', link: '/operations/' },
      { text: 'Reference', link: '/reference/' }
    ],
    sidebar: {
      '/overview/': sidebarOverview(),
      '/get-started/': sidebarGetStarted(),
      '/pipeline/': sidebarPipeline(),
      '/graph/': sidebarGraph(),
      '/interfaces/': sidebarInterfaces(),
      '/storage/': sidebarStorage(),
      '/operations/': sidebarOperations(),
      '/reference/': sidebarReference()
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Iranb/PaperNexus' }
    ],
    search: {
      provider: 'local'
    },
    outline: {
      level: [2, 3]
    },
    footer: {
      message: 'PaperNexus docs are generated and maintained from the repository source.',
      copyright: 'MIT'
    }
  },
  head: [
    ['meta', { name: 'theme-color', content: '#0b6bcb' }]
  ]
};
