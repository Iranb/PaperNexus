# PaddleOCR-VL Local Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a config-driven local `paddleocr-vl` PDF parser to PaperNexus Stage 1 materialization using the official PaddleOCR-VL Python API with high-performance inference support.

**Architecture:** Extend the existing parser dispatch layer in `marker.js` with a new `paddleocr-vl` branch, back it with a repository-owned Python wrapper script, and flow the new config values through analyze/materialize option builders. Keep the feature opt-in and fail-fast, with no automatic fallback.

**Tech Stack:** Node.js ingestion pipeline, Python wrapper script, official `paddleocr` Python package, Node test runner.

---

### Task 1: Add Red Tests For Parser Recognition And Failure Semantics

**Files:**
- Modify: `test/marker.test.js`
- Test: `test/marker.test.js`

- [ ] **Step 1: Write a failing parser-normalization test**

Add a test that expects `normalizePdfParser('paddleocr-vl')` to return `paddleocr-vl`.

- [ ] **Step 2: Run the focused parser test to verify it fails**

Run: `node --test test/marker.test.js`
Expected: FAIL because the parser is not recognized yet.

- [ ] **Step 3: Write a failing fail-fast test**

Add a test that simulates PaddleOCR-VL wrapper failure and expects:
- a thrown error
- no fallback parser behavior
- setup guidance mentioning PaddleOCR-VL

- [ ] **Step 4: Re-run the focused parser test to verify the new test still fails for the right reason**

Run: `node --test test/marker.test.js`
Expected: FAIL due to missing `paddleocr-vl` implementation.

### Task 2: Add Red Tests For Successful Materialization

**Files:**
- Modify: `test/marker.test.js`
- Test: `test/marker.test.js`

- [ ] **Step 1: Write a failing successful-conversion test**

Simulate a local PaddleOCR-VL wrapper run using a fake Python executable that writes Markdown to the expected output path.

Verify:
- returned parser is `paddleocr-vl`
- markdown cache path is under the parser-specific directory
- markdown text is preserved

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test test/marker.test.js`
Expected: FAIL because Node does not yet know how to invoke the wrapper.

### Task 3: Implement The Parser Wrapper Contract

**Files:**
- Create: `scripts/paddleocr_vl_to_markdown.py`
- Modify: `src/core/ingestion/marker.js`
- Test: `test/marker.test.js`

- [ ] **Step 1: Add the repository-owned Python wrapper**

Implement a script that accepts:
- `--input`
- `--output`
- `--enable-hpi`
- `--device`
- `--use-tensorrt`

Use official PaddleOCR-VL APIs to:
- initialize `PaddleOCRVL`
- run prediction on the PDF
- restructure pages
- emit Markdown to the requested output file

- [ ] **Step 2: Add `paddleocr-vl` parser normalization and cache routing**

Update `marker.js` constants and normalization logic so the parser value is first-class everywhere parser cache paths are derived.

- [ ] **Step 3: Add `convertPdfToMarkdownWithPaddleOcrVl(...)`**

Implement a Node adapter that:
- resolves the wrapper path
- invokes the configured Python executable
- writes or validates the cached Markdown file
- returns parser metadata consistent with the other parsers

- [ ] **Step 4: Make failures explicit**

Surface errors that mention:
- missing `paddleocr` / `PaddleOCRVL`
- `paddleocr install_hpi_deps gpu`
- invalid Python executable or device configuration

- [ ] **Step 5: Re-run parser tests**

Run: `node --test test/marker.test.js`
Expected: PASS

### Task 4: Flow Config Into Analyze And Materialize

**Files:**
- Modify: `src/cli/index.js`
- Modify: `src/core/ingestion/pipeline.js`
- Modify: `config.example.json`
- Modify: `docs/configuration.md`
- Test: `test/cli.test.js`

- [ ] **Step 1: Write a failing CLI/config test**

Add coverage that confirms `buildAnalyzeOptions` can carry:
- `pdfParser: "paddleocr-vl"`
- `paddleocrVlPython`
- `paddleocrVlEnableHpi`
- `paddleocrVlDevice`
- `paddleocrVlUseTensorRt`

- [ ] **Step 2: Run the CLI test to verify it fails**

Run: `node --test test/cli.test.js`
Expected: FAIL because the config fields are not yet wired.

- [ ] **Step 3: Wire new config fields through CLI option building**

Update `buildAnalyzeOptions(...)` so config-driven PaddleOCR-VL settings reach materialization.

- [ ] **Step 4: Thread the new options into `convertPdfToMarkdown(...)` calls**

Ensure `materializeSemanticPaper(...)` passes the PaddleOCR-VL options into the parser adapter.

- [ ] **Step 5: Document the config shape**

Update:
- `config.example.json`
- `docs/configuration.md`

- [ ] **Step 6: Re-run the CLI test**

Run: `node --test test/cli.test.js`
Expected: PASS

### Task 5: Update User-Facing Parser Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/cli-reference.md`
- Modify: `docs/pipeline-and-storage.md`

- [ ] **Step 1: Add `paddleocr-vl` to parser documentation**

Document that it is:
- local-only in v1
- config-driven
- fail-fast
- intended for environments with official PaddleOCR-VL support

- [ ] **Step 2: Add setup guidance**

Include:
- `python -m pip install -U "paddleocr[doc-parser]"`
- `paddleocr install_hpi_deps gpu`
- note that compatible GPU/HPI dependencies are required for best performance

### Task 6: Full Verification

**Files:**
- Test: `test/marker.test.js`
- Test: `test/cli.test.js`
- Test: `test/pipeline-marker-concurrency.test.js`

- [ ] **Step 1: Run parser tests**

Run: `node --test test/marker.test.js`
Expected: PASS

- [ ] **Step 2: Run CLI tests**

Run: `node --test test/cli.test.js`
Expected: PASS

- [ ] **Step 3: Run parser-concurrency regression tests**

Run: `node --test test/pipeline-marker-concurrency.test.js`
Expected: PASS

- [ ] **Step 4: Run combined targeted verification**

Run: `node --test test/marker.test.js test/cli.test.js test/pipeline-marker-concurrency.test.js`
Expected: PASS
