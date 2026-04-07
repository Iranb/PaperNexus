#!/usr/bin/env python3

import argparse
import inspect
import sys
import tempfile
from pathlib import Path


def ensure_markdown_output(result_root: Path) -> str:
    markdown_files = sorted(result_root.rglob("*.md"))
    if not markdown_files:
        raise RuntimeError("PaddleOCR-VL completed but did not emit any markdown files.")

    chunks = []
    for markdown_file in markdown_files:
        text = markdown_file.read_text(encoding="utf-8").strip()
        if text:
            chunks.append(text)

    if not chunks:
        raise RuntimeError("PaddleOCR-VL emitted markdown files, but they were empty.")

    return "\n\n".join(chunks).strip() + "\n"


def normalize_results(value):
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return list(value)
    return [value]


def build_paddleocr_vl_kwargs(paddleocr_vl_type, args):
    kwargs = {
        "vl_rec_backend": "vllm-server",
        "vl_rec_server_url": args.server_url,
    }
    layout_model = str(args.layout_model or "").strip()
    if not layout_model:
        return kwargs

    candidate_names = (
        "layout_detection_model_name",
        "layout_model_name",
        "layout_model",
    )
    try:
        signature = inspect.signature(paddleocr_vl_type)
    except (TypeError, ValueError):
        signature = None

    if signature:
        for candidate in candidate_names:
            if candidate in signature.parameters:
                kwargs[candidate] = layout_model
                break
    return kwargs


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a PDF to markdown using PaddleOCR-VL.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--server-url", default="http://127.0.0.1:8080/v1")
    parser.add_argument("--layout-model", default="PP-DocLayout-S")
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        from paddleocr import PaddleOCRVL
    except Exception as exc:  # pragma: no cover - exercised from Node wrapper tests
        raise RuntimeError(
            "PaddleOCR-VL is not available. Install `paddleocr[doc-parser]` in the Python environment used to talk to the remote server."
        ) from exc

    try:
        pipeline = PaddleOCRVL(**build_paddleocr_vl_kwargs(PaddleOCRVL, args))
    except Exception as exc:  # pragma: no cover - environment dependent
        raise RuntimeError(f"Failed to initialize PaddleOCRVL: {exc}") from exc

    try:
        results = list(pipeline.predict(str(input_path)))
        if not results:
            raise RuntimeError("PaddleOCR-VL returned no results for the input PDF.")

        if hasattr(pipeline, "restructure_pages"):
            restructured = pipeline.restructure_pages(results, concatenate_pages=True)
            if restructured is not None:
                results = normalize_results(restructured)

        with tempfile.TemporaryDirectory(prefix="papernexus-paddleocr-vl-") as temp_dir:
            temp_root = Path(temp_dir)
            saveable_results = normalize_results(results)
            for result in saveable_results:
                save_to_markdown = getattr(result, "save_to_markdown", None)
                if not callable(save_to_markdown):
                    raise RuntimeError("PaddleOCR-VL result object does not support save_to_markdown().")
                save_to_markdown(save_path=str(temp_root))

            output_path.write_text(ensure_markdown_output(temp_root), encoding="utf-8")
    except Exception as exc:  # pragma: no cover - exercised through Node integration
        raise RuntimeError(f"Failed to run PaddleOCR-VL inference: {exc}") from exc

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
