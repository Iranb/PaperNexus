#!/usr/bin/env python3

import argparse
import sys
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="Convert a PDF to markdown using Microsoft MarkItDown.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if not input_path.exists():
        raise RuntimeError(f"Input PDF not found: {input_path}")

    try:
        from markitdown import MarkItDown
    except Exception as exc:  # pragma: no cover - exercised through Node integration
        raise RuntimeError(
            "MarkItDown is not available. Install `markitdown[pdf]` in the selected Python environment."
        ) from exc

    try:
        converter = MarkItDown(enable_plugins=False)
        result = converter.convert(str(input_path))
    except Exception as exc:  # pragma: no cover - exercised through Node integration
        raise RuntimeError(f"Failed to run MarkItDown inference: {exc}") from exc

    markdown = str(getattr(result, "text_content", "") or "").strip()
    if not markdown:
        raise RuntimeError("MarkItDown returned empty markdown.")

    output_path.write_text(f"{markdown}\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
