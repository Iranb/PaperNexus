# Configuration Reference

This page is generated from [`config.example.json`](https://github.com/Iranb/PaperNexus/blob/main/config.example.json). The example file is the maintained default source of truth for shipped runtime settings.

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
    "name": "GCD",
    "semanticExtraction": "llm-primary",
    "pdfParser": "markpdfdown",
    "pythonCommand": "python3",
    "mineruHttpUrl": "http://127.0.0.1:30000",
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
    "doclingVlmPreset": "granite_docling"
  },
  "global": {
    "corpus": "GCD"
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
    "model": "qwen3.5-plus",
    "baseUrl": "https://coding.dashscope.aliyuncs.com/v1",
    "relations": true,
    "apiKeyEnv": "DASHSCOPE_API_KEY"
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
| `analyze.name` | string | `GCD` |
| `analyze.semanticExtraction` | string | `llm-primary` |
| `analyze.pdfParser` | string | `markpdfdown` |
| `analyze.pythonCommand` | string | `python3` |
| `analyze.mineruHttpUrl` | string | `http://127.0.0.1:30000` |
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
| `global` | object | section |
| `global.corpus` | string | `GCD` |
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
| `llm.model` | string | `qwen3.5-plus` |
| `llm.baseUrl` | string | `https://coding.dashscope.aliyuncs.com/v1` |
| `llm.relations` | boolean | `true` |
| `llm.apiKeyEnv` | string | `DASHSCOPE_API_KEY` |

## Maintenance Notes

- Keep `config.example.json` updated whenever new runtime keys are introduced.
- Run `npm run docs:generate` after changing config defaults so this page stays current.
