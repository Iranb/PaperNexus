# PaperNexus Manual Walkthrough

This guide is for manually trying the full PaperNexus workflow as a user.

It is organized as a checklist. Run each step in order.

## Goal

By the end of this walkthrough, you will have manually exercised:

- global CLI installation
- first-run config
- corpus indexing
- graph exploration commands
- enhancement overlays
- dashboard and API
- background services
- optional remote Ollama configuration
- optional MCP usage

## 0. Start Here

Open a terminal in the project root:

```bash
cd "/Users/iranb/Library/Mobile Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus"
```

## 1. Install And Expose The CLI

Install dependencies:

```bash
npm install
```

Register the CLI as a global command:

```bash
npm link
```

Check that the command is available:

```bash
papernexus help
```

If `papernexus` is not found, run:

```bash
npm bin -g
```

and add that directory to your shell `PATH`.

## 2. Prepare A Paper Source Folder

The recommended default paper source directory is:

```bash
/Users/iranb/.papernexus/papers
```

Create it if needed:

```bash
mkdir -p /Users/iranb/.papernexus/papers
```

You can start in either of these ways:

1. Quick demo with the built-in examples:

```bash
mkdir -p /Users/iranb/.papernexus/papers/demo
cp ./examples/*.md /Users/iranb/.papernexus/papers/demo/
```

2. Your own real paper corpus:

- put one full paper per `.md` or `.pdf` file
- prefer a clean directory tree
- for Markdown, keep title and section structure intact

## 3. Run The First-Run Wizard

Launch the interactive setup:

```bash
papernexus init
```

Recommended answers:

- Paper source directory: `/Users/iranb/.papernexus/papers`
- Corpus name: choose a short name such as `demo` or `gcd`
- Index directory: `/Users/iranb/.papernexus/index-store`

Optional LLM setup:

- if you want a local Ollama-only flow, choose `ollama`
- if you want cloud APIs, choose `openai` or `anthropic`
- if Keychain prompts appear on macOS, enter your provider API key, not your login password

This writes the runtime config under:

```bash
/Users/iranb/.papernexus/config.json
```

## 4. Build The First Corpus

Run:

```bash
papernexus analyze --force
```

This should:

- parse the papers
- build the main graph
- store the authoritative graph in Kuzu by default
- write the lite graph index
- enqueue enhancement overlays

Useful output to confirm:

- corpus name
- node count
- relationship count
- storage mode

## 5. Inspect Corpus Status

List corpora:

```bash
papernexus list
```

Inspect the active corpus:

```bash
papernexus status
```

Or inspect a named corpus:

```bash
papernexus status --corpus <your-corpus-name>
```

## 6. Manually Explore The Graph

Run all of these once.

Search:

```bash
papernexus query "experiment planning" --corpus <your-corpus-name>
```

Inspect neighborhood:

```bash
papernexus context "knowledge graph" --corpus <your-corpus-name>
```

Inspect upstream support:

```bash
papernexus impact "knowledge graph" --corpus <your-corpus-name> --direction upstream
```

Inspect downstream implications:

```bash
papernexus impact "knowledge graph" --corpus <your-corpus-name> --direction downstream
```

Generate research directions:

```bash
papernexus ideas "evidence tracing for experiment planning" --corpus <your-corpus-name>
```

Run brainstorming:

```bash
papernexus brainstorm "experiment planning" --corpus <your-corpus-name> --mode diverge
papernexus brainstorm "experiment planning" --corpus <your-corpus-name> --mode converge
```

## 7. Refresh And Inspect Enhancement Overlays

Run enhancement processing once:

```bash
papernexus enhance --once --corpus <your-corpus-name>
```

This should populate:

- theory overlay
- storyline overlay
- reflection overlay

The reflection overlay includes:

- `Innovation`
- `Experiment`
- `Outcome`
- `Reflection`

If you want to inspect them through the web UI, continue to the next step.

## 8. Open The Dashboard

Run:

```bash
papernexus serve
```

Then open:

```text
http://127.0.0.1:4821
```

Use the dashboard to manually inspect:

- corpus metadata
- graph structure
- enhancement summaries
- paper-level overlays
- current LLM provider/model settings

## 9. Turn On Background Mode

Install the default background services:

```bash
papernexus service install
```

This now installs both:

- `watch` for file monitoring and incremental index refresh
- `serve` for the dashboard/API and enhancement worker

Check status:

```bash
papernexus service status
```

After installation, the command output should also print the dashboard URL.

Logs live under:

```bash
/Users/iranb/.papernexus/logs
```

## 10. Verify Dynamic Updates

With background services running:

1. Add or edit a paper file under `/Users/iranb/.papernexus/papers`
2. Wait a moment
3. Run:

```bash
papernexus status --corpus <your-corpus-name>
```

4. Refresh the dashboard

You should see:

- the graph update
- lite view update
- enhancement queue refresh

## 11. Optional: Configure Remote Ollama

If you have your own Ollama server on a remote machine, put this in `config.json`:

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

Then rebuild:

```bash
papernexus analyze --force
```

Use direct remote HTTP instead of `sshHost` if the Ollama API is directly reachable from your machine.

## 12. Optional: Try MCP Mode

Start the MCP server:

```bash
papernexus mcp
```

Use `papernexus setup` if you want ready-to-paste MCP config snippets for other tools.

## 13. Optional: Exercise Reflection-Oriented Reasoning

If you want to explicitly try the new reflection layer:

1. Run:

```bash
papernexus enhance --once --corpus <your-corpus-name>
```

2. Open the dashboard
3. Inspect paper-level enhancement overlays
4. For each paper, manually check:

- what the system marked as `Innovation`
- what it grouped as `Experiment`
- whether the `Outcome` verdict looks right
- whether the `Reflection` takeaway is useful

## 14. Optional: Clean Up

To remove a corpus index:

```bash
papernexus clean --corpus <your-corpus-name>
```

To remove background services:

```bash
papernexus service uninstall
```

## Suggested Manual Test Order

If you want the shortest end-to-end path, do this:

1. `npm install`
2. `npm link`
3. `papernexus init`
4. `papernexus analyze --force`
5. `papernexus status`
6. `papernexus query ...`
7. `papernexus context ...`
8. `papernexus impact ...`
9. `papernexus ideas ...`
10. `papernexus brainstorm ...`
11. `papernexus enhance --once`
12. `papernexus serve`
13. `papernexus service install`

## What Counts As “Everything Worked”

You have successfully exercised the full PaperNexus flow when:

- `papernexus` runs globally
- the corpus indexes without errors
- query/context/impact/ideas/brainstorm all return results
- enhancement overlays are generated
- the dashboard opens
- background services show as loaded
- adding a paper causes an incremental update
