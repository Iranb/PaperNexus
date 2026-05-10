# PaddleOCR-VL Local Parser Design

## Summary

This design adds a new local PDF-to-Markdown parser option to PaperNexus based on PaddleOCR-VL, using the official Python API with high-performance inference enabled.

The recommended shape is:

- add a new `pdfParser` value: `paddleocr-vl`
- keep parser selection configuration-driven through `config.json`
- invoke a bundled Python wrapper that calls official `PaddleOCRVL`
- enable PaddleOCR high-performance inference through config
- fail fast when PaddleOCR-VL is unavailable or inference fails
- keep all existing parser and markdown-cache behavior unchanged for other parsers

## Context

PaperNexus already supports multiple Stage 1 PDF parsers in [src/core/ingestion/marker.js](../../../src/core/ingestion/marker.js):

- `docling`
- `marker`
- `mineru`

That layer already provides the right integration seam:

- parser-specific cache directories
- reusable markdown cache paths
- parser command metadata flowing into the manifest
- a single `convertPdfToMarkdown(...)` dispatch point used by the ingestion pipeline

The new requirement is to let users opt into PaddleOCR-VL high-performance local inference for PDF-to-Markdown conversion during materialization, without changing the current default parser behavior.

## Goals

- add a first-class `paddleocr-vl` parser option to Stage 1 materialization
- support local official PaddleOCR-VL Python inference
- support `enable_hpi=True` as part of the normal parser flow
- expose the feature through runtime config under `analyze`
- reuse the existing markdown cache and manifest machinery
- fail with a clear actionable error when PaddleOCR-VL is unavailable

## Non-Goals

- changing the default parser from the current default
- adding remote PaddleOCR-VL inference service support in this pass
- adding automatic fallback to `mineru`, `docling`, or any other parser
- exposing the full PaddleOCR-VL tuning surface in v1
- redesigning the ingestion pipeline around PaddleOCR-native artifacts

## External Constraints

According to the official PaddleOCR documentation:

- high-performance inference is enabled by passing `enable_hpi=True`
- PaddleOCR-VL supports PDF prediction through the official Python API
- high-performance GPU inference requires PaddleOCR HPI dependencies and compatible CUDA/cuDNN or Docker images
- PaddleOCR-VL can emit Markdown through the official result objects after page restructuring

Primary sources used for this design:

- [PaddleOCR High-Performance Inference](https://www.paddleocr.ai/latest/en/version3.x/deployment/high_performance_inference.html)
- [PaddleOCR-VL Usage Tutorial](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PaddleOCR-VL.html)
- [PaddleOCR-VL-1.5 Model Card](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.5)

## Recommended Approach

### 1. Add A New Dedicated Parser Value

Extend parser normalization so the system recognizes:

- `paddleocr-vl`

This parser should participate in the same cache path pattern as the current parsers:

- markdown cache under `.papernexus/markdown/paddleocr-vl/`
- parser run artifacts under `.papernexus/marker/paddleocr-vl/`

This keeps cache invalidation and parser isolation consistent with the existing design.

### 2. Use A Bundled Python Wrapper

Do not shell out to an opaque user-provided script in v1.

Instead, add a small repository-owned Python wrapper script that:

- imports `PaddleOCRVL` from `paddleocr`
- initializes it with config-driven options
- runs prediction on the provided PDF path
- restructures multi-page output
- writes Markdown to a target path

This wrapper should be called by the Node parser layer and should return a clear non-zero exit status with useful stderr when:

- `paddleocr` is not installed
- PaddleOCR-VL initialization fails
- inference fails
- Markdown output is empty or missing

### 3. Keep The Parser Thin In Node

The Node-side parser adapter in [src/core/ingestion/marker.js](../../../src/core/ingestion/marker.js) should:

- resolve the parser cache paths
- skip work when cached Markdown already exists and `force` is not set
- invoke the Python wrapper with a precise set of flags
- copy or preserve the generated Markdown at the expected cache path
- surface a fail-fast error message with install guidance

The Node layer should not attempt to reimplement PaddleOCR-VL inference semantics.

### 4. Make The Feature Config-Driven

Expose the parser through runtime config under `analyze`.

Recommended minimal v1 config shape:

```json
{
  "analyze": {
    "pdfParser": "paddleocr-vl",
    "paddleocrVlPython": "python3",
    "paddleocrVlEnableHpi": true,
    "paddleocrVlDevice": "gpu:0",
    "paddleocrVlUseTensorRt": false
  }
}
```

Recommended v1 behavior:

- `pdfParser` default remains unchanged from current behavior
- `paddleocrVlPython` default: `python3`
- `paddleocrVlEnableHpi` default: `true`
- `paddleocrVlDevice` default: unset
  - allow PaddleOCR to choose local `gpu:0` when available, otherwise CPU, per the official docs
- `paddleocrVlUseTensorRt` default: `false`

These values should flow through the same analyze/materialize/watch option builders already used for other parsers.

### 5. Fail Fast Instead Of Falling Back

If `pdfParser` is `paddleocr-vl`, failures should stop materialization for that source.

Do not automatically fall back to:

- `mineru`
- `docling`
- `marker`

The error message should explicitly suggest:

- install `paddleocr[doc-parser]`
- install PaddleOCR high-performance inference dependencies for GPU when intended
- verify the selected Python executable and device configuration

## Wrapper Contract

The Python wrapper should accept explicit arguments for:

- input PDF path
- output Markdown path
- `enable_hpi`
- `device`
- `use_tensorrt`

The wrapper should:

1. initialize `PaddleOCRVL(...)`
2. run `predict(pdf_path)`
3. collect results into a list
4. restructure pages for coherent document-level Markdown
5. write Markdown text to the requested output file

The Node layer should treat the wrapper as successful only if the output Markdown file exists and is non-empty.

## Testing Strategy

### Unit Coverage

Extend parser tests to verify:

- `normalizePdfParser('paddleocr-vl')` is accepted
- unexpected parser values still normalize the same way as before

### Integration Coverage

Add a focused parser integration test that:

- points `paddleocrVlPython` at a fake local Python shim
- simulates successful Markdown generation
- verifies the generated Markdown lands in the parser-specific cache path
- verifies returned parser metadata identifies `paddleocr-vl`

### Failure Coverage

Add a failing-path test that:

- simulates a wrapper failure
- confirms no fallback parser is invoked
- asserts the surfaced error mentions PaddleOCR-VL setup guidance

### Config Coverage

Add CLI/config coverage to confirm:

- config values under `analyze` are forwarded into materialization options
- `pdfParser: "paddleocr-vl"` is preserved through config loading

## Risks

### 1. Environment Fragility

PaddleOCR-VL local execution depends on Python environment health, GPU runtime compatibility, and optional TensorRT availability.

Mitigation:

- keep the Node integration thin
- keep errors explicit and actionable
- do not silently fall back

### 2. Wrapper Result Shape Drift

If PaddleOCR-VL result APIs evolve, a wrapper tightly coupled to one output method could break.

Mitigation:

- isolate all PaddleOCR-specific logic in the Python wrapper
- test only the wrapper contract from Node

### 3. Large-PDF Runtime Costs

PaddleOCR-VL may be slower or more memory-intensive than other parsers on some documents.

Mitigation:

- keep it opt-in
- preserve existing parsers unchanged
- document the hardware and dependency expectations

## Success Criteria

This design is successful when:

- `config.json` can select `pdfParser: "paddleocr-vl"`
- Stage 1 materialization generates reusable Markdown cache through PaddleOCR-VL
- failures surface clear setup guidance and do not fall back
- existing parser behavior and existing tests remain green
