#!/usr/bin/env python3

import argparse
import sys
import tempfile
from pathlib import Path


def parse_bool(raw: str) -> bool:
    normalized = str(raw or "").strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"Unsupported boolean value: {raw!r}")


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


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a PDF to markdown using PaddleOCR-VL.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--enable-hpi", default="true")
    parser.add_argument("--device", default="")
    parser.add_argument("--use-tensorrt", default="false")
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        from paddleocr import PaddleOCRVL
    except Exception as exc:  # pragma: no cover - exercised from Node wrapper tests
        raise RuntimeError(
            "PaddleOCR-VL is not available. Install `paddleocr[doc-parser]` and, for GPU HPI, run `paddleocr install_hpi_deps gpu`."
        ) from exc

    try:
        pipeline = PaddleOCRVL(
            enable_hpi=parse_bool(args.enable_hpi),
            device=(args.device or None),
            use_tensorrt=parse_bool(args.use_tensorrt),
        )
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
