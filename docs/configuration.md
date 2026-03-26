# Configuration

PaperNexus can run with no config for simple local tests, but the normal setup is to keep a runtime config file under `~/.papernexus/config.json`.

## Config Discovery

When config loading is enabled, PaperNexus looks in this order:

1. `--config <path>` if you passed one
2. the default runtime config at `~/.papernexus/config.json`
3. `./config.json` in the current working directory

Disable config discovery with:

```bash
papernexus --no-config ...
```

## Recommended Default Paths

- papers: `/Users/iranb/.papernexus/papers`
- index root: `/Users/iranb/.papernexus/index-store`
- runtime config: `/Users/iranb/.papernexus/config.json`
- logs: `/Users/iranb/.papernexus/logs`

## Minimal Example

```json
{
  "sources": {
    "inputs": [
      "/Users/iranb/.papernexus/papers"
    ]
  },
  "storage": {
    "indexDir": "/Users/iranb/.papernexus/index-store"
  },
  "analyze": {
    "name": "GCD"
  },
  "serve": {
    "host": "127.0.0.1",
    "port": 4821
  }
}
```

## Main Sections

### `sources`

Controls where PaperNexus reads raw paper files from.

```json
{
  "sources": {
    "inputs": [
      "/Users/iranb/.papernexus/papers"
    ]
  }
}
```

Use this when you want `papernexus analyze` or `papernexus watch` to work without passing a directory every time.

### `storage`

Controls where PaperNexus stores corpus indexes and runtime state.

```json
{
  "storage": {
    "indexDir": "/Users/iranb/.papernexus/index-store"
  }
}
```

Notes:

- `indexDir` is not the paper source directory
- `~` is expanded correctly
- `PAPERNEXUS_HOME` can override the default runtime root

### `analyze`

Controls ingest, staged build defaults, parser behavior, and graph refinement defaults.

```json
{
  "analyze": {
    "name": "GCD",
    "concurrency": 8,
    "semanticExtraction": "llm-primary",
    "pdfParser": "docling",
    "doclingCommand": "docling",
    "doclingOcrEngine": "ocrmac",
    "doclingPdfBackend": "pypdfium2",
    "nodeLlmCheck": false
  }
}
```

Useful keys:

- `name`: default corpus name
- `concurrency`: parallelism for staged work
- `semanticExtraction`: `auto`, `heuristic-only`, `llm-assisted`, or `llm-primary`
- `pdfParser`: `docling`, `marker`, or `mineru`
- `doclingCommand`
- `doclingOcrEngine`
- `doclingPdfBackend`
- `markerCommand`
- `mineruHttpUrl`
- `mineruRemoteFailure`: `error` or `docling`
- `nodeLlmCheck`

### `llm`

Controls the model provider used for semantic extraction, relation extraction, and optional node checks.

```json
{
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "relations": true,
    "batchSize": 16
  }
}
```

Useful keys:

- `provider`: `ollama`, `openai`, or `anthropic`
- `model`
- `baseUrl`
- `apiKeyEnv`
- `relations`
- `batchSize`
- `sshHost` for remote Ollama over SSH forwarding

### `serve`

Controls the dashboard and local API binding.

```json
{
  "serve": {
    "host": "127.0.0.1",
    "port": 4821
  }
}
```

### `global`

Controls cross-command defaults such as the preferred corpus name.

```json
{
  "global": {
    "corpus": "GCD"
  }
}
```

## Parser Configuration

### Docling

Docling is the default PDF parser.

```json
{
  "analyze": {
    "pdfParser": "docling",
    "doclingCommand": "docling",
    "doclingOcrEngine": "ocrmac",
    "doclingPdfBackend": "pypdfium2"
  }
}
```

### Marker

```json
{
  "analyze": {
    "pdfParser": "marker",
    "markerCommand": "marker_single"
  }
}
```

### MinerU

```json
{
  "analyze": {
    "pdfParser": "mineru",
    "mineruHttpUrl": "http://211.71.76.29:30000",
    "mineruRemoteFailure": "error"
  }
}
```

If the remote MinerU backend is unreachable, the recommended default is `error` so the pipeline does not silently continue with an unclear parse result.

## Remote Ollama

If you run Ollama on a remote machine:

```json
{
  "llm": {
    "provider": "ollama",
    "model": "qwen2.5:0.5b",
    "baseUrl": "http://127.0.0.1:11434",
    "sshHost": "your-remote-host",
    "relations": true,
    "batchSize": 8
  }
}
```

If the remote Ollama endpoint is directly reachable, you can skip `sshHost` and point `baseUrl` at the remote HTTP address.

## API Key Storage

On macOS, the recommended flow is:

```bash
papernexus auth llm set --provider openai --base-url https://api.openai.com/v1
```

This stores the secret in Keychain and keeps `config.json` as a reference-only config when possible.

If a macOS prompt mentions `password`, it is asking for your API key, not your login password.

## A Practical Config For Daily Use

```json
{
  "sources": {
    "inputs": [
      "/Users/iranb/.papernexus/papers"
    ]
  },
  "storage": {
    "indexDir": "/Users/iranb/.papernexus/index-store"
  },
  "analyze": {
    "name": "GCD",
    "concurrency": 16,
    "semanticExtraction": "llm-primary",
    "pdfParser": "docling",
    "doclingCommand": "docling",
    "doclingOcrEngine": "ocrmac",
    "doclingPdfBackend": "pypdfium2",
    "nodeLlmCheck": false
  },
  "llm": {
    "provider": "openai",
    "model": "qwen3.5-plus",
    "baseUrl": "https://coding.dashscope.aliyuncs.com/v1",
    "apiKeyEnv": "DASHSCOPE_API_KEY",
    "relations": true,
    "batchSize": 16
  },
  "serve": {
    "host": "127.0.0.1",
    "port": 4821
  },
  "global": {
    "corpus": "GCD"
  }
}
```
