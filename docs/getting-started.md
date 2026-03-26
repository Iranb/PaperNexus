# Getting Started

This guide is the detailed companion to the shorter flow in the repository [README](../README.md).

## Default Paths

PaperNexus assumes these defaults unless your config overrides them:

- paper source directory: `/Users/iranb/.papernexus/papers`
- index root: `/Users/iranb/.papernexus/index-store`
- runtime config: `/Users/iranb/.papernexus/config.json`
- service logs: `/Users/iranb/.papernexus/logs`

## Install

From the project root:

```bash
npm install
npm link
```

Parser dependencies:

```bash
pip install docling marker-pdf
```

## First-Time Setup

Run:

```bash
papernexus init
```

Recommended answers:

- paper source directory: `/Users/iranb/.papernexus/papers`
- corpus name: a short stable name such as `gcd`
- index directory: `/Users/iranb/.papernexus/index-store`

If you configure a cloud model, the macOS Keychain prompt is asking for your API key, not your login password.

## Prepare Papers

Put one paper per `.md`, `.markdown`, or `.pdf` file under the source tree.

Example:

```text
/Users/iranb/.papernexus/papers/
  gcd/
    office-home.md
    domainnet.pdf
```

Markdown should be full-paper markdown, not personal notes.

## First Build

For a clean first run:

```bash
papernexus analyze --force
```

For staged control:

```bash
papernexus materialize --continue
papernexus llm-optimize --continue --semantic-extraction llm-primary
papernexus build-graph --continue
papernexus merge-graph --continue
papernexus write-index --continue
```

## Inspect the Result

```bash
papernexus status
papernexus query "experiment planning"
papernexus brainstorm "semi-supervised learning" --mode diverge
```

Open the dashboard:

```bash
papernexus serve
```

Then visit `http://127.0.0.1:4821`.

## Background Mode

Install the default services:

```bash
papernexus service install
papernexus service status
papernexus logs watch
```

By default this installs both:

- `watch`
- `serve`

## Recommended First-Day Path

```bash
papernexus init
papernexus analyze --force
papernexus status
papernexus query "experiment planning"
papernexus enhance --once
papernexus serve
papernexus service install
```
