# Configuration Reference

This page is generated from [`config.example.json`](https://github.com/papernexus/PaperNexus/blob/main/config.example.json). The example file is the maintained default source of truth for shipped runtime settings.

## Example Config

```json
{
  "sources": {
    "inputs": [
      "~/.papernexus/papers"
    ]
  },
  "storage": {
    "indexDir": "~/.papernexus/index-store"
  },
  "analyze": {
    "name": "demo-corpus",
    "semanticExtraction": "llm-primary",
    "pdfParser": "markitdown",
    "pythonCommand": "python3",
    "mineruHttpUrl": "http://127.0.0.1:30000",
    "markitdownPython": "python3",
    "doclingCommand": "docling",
    "doclingDevice": "cuda",
    "doclingAutoGpu": true,
    "doclingGpuLockRoot": "/tmp/papernexus-gpu-locks",
    "doclingGpuMinFreeMb": 18000,
    "doclingGpuWaitTimeoutMs": 1800000,
    "doclingGpuPollIntervalMs": 5000,
    "doclingGpuLockStaleMs": 7200000,
    "doclingCpuThreads": 4,
    "doclingPdfBackend": "pdfplumber",
    "doclingImageExportMode": "placeholder",
    "doclingEnrichPictureClasses": false,
    "doclingEnrichPictureDescription": false,
    "doclingPreload": true,
    "doclingUseVlm": false,
    "doclingVlmPreset": "granite_docling",
    "identifierResolution": {
      "enabled": true,
      "providers": [
        "openalex",
        "crossref",
        "arxiv"
      ],
      "timeoutMs": 2500,
      "maxCandidates": 5,
      "missCacheTtlMs": 604800000,
      "allowInWatch": false,
      "mailto": "replace-with-contact@example.com"
    }
  },
  "global": {
    "corpus": "demo-corpus"
  },
  "imports": {
    "batchEnabled": true,
    "batchMaxTasks": 4,
    "batchMaxFiles": 16,
    "batchMaxBytes": 104857600
  },
  "serve": {
    "host": "0.0.0.0",
    "port": 4821,
    "apiToken": "replace-with-your-api-token",
    "mcp": {
      "enabled": true,
      "path": "/mcp",
      "transport": "streamable-http",
      "allowSseFallback": false
    }
  },
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "baseUrl": "https://api.openai.com/v1",
    "relations": true,
    "batchPromptMaxChars": 24000,
    "batchFailureSplitRetryCount": 3,
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  "literatureDiscovery": {
    "institutionalAccessMode": "hints-only",
    "browserChannel": "msedge",
    "browserExecutablePath": "",
    "browserProfileName": "Default",
    "browserHeadless": true,
    "browserDownloadTimeoutMs": 12000,
    "browserAuthHosts": [],
    "browserAuthUrlFragments": [],
    "browserAuthPageTitles": []
  }
}
```

## Flattened Field Map

| Path | Type | Example |
| --- | --- | --- |
| `sources` | object | section |
| `sources.inputs` | array | `["~/.papernexus/papers"]` |
| `storage` | object | section |
| `storage.indexDir` | string | `~/.papernexus/index-store` |
| `analyze` | object | section |
| `analyze.name` | string | `demo-corpus` |
| `analyze.semanticExtraction` | string | `llm-primary` |
| `analyze.pdfParser` | string | `markitdown` |
| `analyze.pythonCommand` | string | `python3` |
| `analyze.mineruHttpUrl` | string | `http://127.0.0.1:30000` |
| `analyze.markitdownPython` | string | `python3` |
| `analyze.doclingCommand` | string | `docling` |
| `analyze.doclingDevice` | string | `cuda` |
| `analyze.doclingAutoGpu` | boolean | `true` |
| `analyze.doclingGpuLockRoot` | string | `/tmp/papernexus-gpu-locks` |
| `analyze.doclingGpuMinFreeMb` | number | `18000` |
| `analyze.doclingGpuWaitTimeoutMs` | number | `1800000` |
| `analyze.doclingGpuPollIntervalMs` | number | `5000` |
| `analyze.doclingGpuLockStaleMs` | number | `7200000` |
| `analyze.doclingCpuThreads` | number | `4` |
| `analyze.doclingPdfBackend` | string | `pdfplumber` |
| `analyze.doclingImageExportMode` | string | `placeholder` |
| `analyze.doclingEnrichPictureClasses` | boolean | `false` |
| `analyze.doclingEnrichPictureDescription` | boolean | `false` |
| `analyze.doclingPreload` | boolean | `true` |
| `analyze.doclingUseVlm` | boolean | `false` |
| `analyze.doclingVlmPreset` | string | `granite_docling` |
| `analyze.identifierResolution` | object | section |
| `analyze.identifierResolution.enabled` | boolean | `true` |
| `analyze.identifierResolution.providers` | array | `["openalex","crossref","arxiv"]` |
| `analyze.identifierResolution.timeoutMs` | number | `2500` |
| `analyze.identifierResolution.maxCandidates` | number | `5` |
| `analyze.identifierResolution.missCacheTtlMs` | number | `604800000` |
| `analyze.identifierResolution.allowInWatch` | boolean | `false` |
| `analyze.identifierResolution.mailto` | string | `replace-with-contact@example.com` |
| `global` | object | section |
| `global.corpus` | string | `demo-corpus` |
| `imports` | object | section |
| `imports.batchEnabled` | boolean | `true` |
| `imports.batchMaxTasks` | number | `4` |
| `imports.batchMaxFiles` | number | `16` |
| `imports.batchMaxBytes` | number | `104857600` |
| `serve` | object | section |
| `serve.host` | string | `0.0.0.0` |
| `serve.port` | number | `4821` |
| `serve.apiToken` | string | `replace-with-your-api-token` |
| `serve.mcp` | object | section |
| `serve.mcp.enabled` | boolean | `true` |
| `serve.mcp.path` | string | `/mcp` |
| `serve.mcp.transport` | string | `streamable-http` |
| `serve.mcp.allowSseFallback` | boolean | `false` |
| `llm` | object | section |
| `llm.provider` | string | `openai` |
| `llm.model` | string | `gpt-4o-mini` |
| `llm.baseUrl` | string | `https://api.openai.com/v1` |
| `llm.relations` | boolean | `true` |
| `llm.batchPromptMaxChars` | number | `24000` |
| `llm.batchFailureSplitRetryCount` | number | `3` |
| `llm.apiKeyEnv` | string | `OPENAI_API_KEY` |
| `literatureDiscovery` | object | section |
| `literatureDiscovery.institutionalAccessMode` | string | `hints-only` |
| `literatureDiscovery.browserChannel` | string | `msedge` |
| `literatureDiscovery.browserExecutablePath` | string | `` |
| `literatureDiscovery.browserProfileName` | string | `Default` |
| `literatureDiscovery.browserHeadless` | boolean | `true` |
| `literatureDiscovery.browserDownloadTimeoutMs` | number | `12000` |
| `literatureDiscovery.browserAuthHosts` | array | `[]` |
| `literatureDiscovery.browserAuthUrlFragments` | array | `[]` |
| `literatureDiscovery.browserAuthPageTitles` | array | `[]` |

## Maintenance Notes

- Keep `config.example.json` updated whenever new runtime keys are introduced.
- Run `npm run docs:generate` after changing config defaults so this page stays current.
