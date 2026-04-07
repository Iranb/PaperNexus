#!/usr/bin/env python3

import argparse
import sys
import tempfile
from pathlib import Path


def ensure_markdown_output(result_root: Path, input_path: Path) -> str:
    markdown_files = sorted(result_root.rglob("*.md"))
    if not markdown_files:
        raise RuntimeError("OpenDataLoader PDF completed but did not emit any markdown files.")

    preferred = None
    basename = input_path.stem
    for markdown_file in markdown_files:
        if markdown_file.stem == basename:
            preferred = markdown_file
            break
    selected = preferred or markdown_files[0]
    text = selected.read_text(encoding="utf-8").strip()
    if not text:
        raise RuntimeError("OpenDataLoader PDF emitted markdown, but it was empty.")

    # `format="markdown"` is already text-only. This is a final guard in case
    # a future runtime starts emitting image references into the plain markdown path.
    filtered_lines = [
        line for line in text.splitlines()
        if not line.strip().startswith("![")
        and "<img" not in line.lower()
        and "<figure" not in line.lower()
    ]
    filtered = "\n".join(filtered_lines).strip()
    return f"{filtered}\n" if filtered else ""


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a PDF to markdown using OpenDataLoader PDF.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        import opendataloader_pdf
    except Exception as exc:  # pragma: no cover - exercised from Node wrapper tests
        raise RuntimeError(
            "OpenDataLoader PDF is not available. Install `opendataloader-pdf` in the selected Python environment."
        ) from exc

    try:
        with tempfile.TemporaryDirectory(prefix="papernexus-opendataloader-") as temp_dir:
            temp_root = Path(temp_dir)
            opendataloader_pdf.convert(
                input_path=[str(input_path)],
                output_dir=str(temp_root),
                format="markdown",
            )
            output_path.write_text(ensure_markdown_output(temp_root, input_path), encoding="utf-8")
    except Exception as exc:  # pragma: no cover - exercised through Node integration
        raise RuntimeError(f"Failed to run OpenDataLoader PDF inference: {exc}") from exc

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
