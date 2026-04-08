#!/usr/bin/env python3

import argparse
import os
import sys
from pathlib import Path


def configure_environment(args: argparse.Namespace) -> None:
    os.environ["MODEL_NAME"] = str(args.model_name).strip()
    os.environ["TEMPERATURE"] = str(args.temperature)
    os.environ["MAX_TOKENS"] = str(args.max_tokens)
    os.environ["RETRY_TIMES"] = str(args.retry_times)

    provider = str(args.provider or "").strip().lower()
    base_url = str(args.base_url or "").strip()
    api_key = str(args.api_key or "").strip()

    if provider == "openai":
        if api_key:
            os.environ["OPENAI_API_KEY"] = api_key
        if base_url:
            os.environ["OPENAI_BASE_URL"] = base_url
            os.environ["OPENAI_API_BASE"] = base_url
    elif provider == "anthropic":
        if api_key:
            os.environ["ANTHROPIC_API_KEY"] = api_key
        if base_url:
            os.environ["ANTHROPIC_BASE_URL"] = base_url
            os.environ["ANTHROPIC_API_BASE"] = base_url
    elif provider == "ollama":
        if base_url:
            os.environ["OLLAMA_API_BASE"] = base_url


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a PDF to markdown using MarkPDFDown.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--model-name", required=True)
    parser.add_argument("--base-url", default="")
    parser.add_argument("--api-key", default="")
    parser.add_argument("--temperature", type=float, default=0.3)
    parser.add_argument("--max-tokens", type=int, default=8192)
    parser.add_argument("--retry-times", type=int, default=3)
    parser.add_argument("--start-page", type=int, default=1)
    parser.add_argument("--end-page", type=int, default=0)
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if not input_path.exists():
      raise RuntimeError(f"Input PDF not found: {input_path}")

    configure_environment(args)

    try:
        from markpdfdown.main import convert_from_file
    except Exception as exc:  # pragma: no cover - exercised from Node wrapper tests
        raise RuntimeError(
            "MarkPDFDown is not available. Install `markpdfdown` in the selected Python environment."
        ) from exc

    try:
        markdown = convert_from_file(
            str(input_path),
            start_page=max(1, int(args.start_page)),
            end_page=max(0, int(args.end_page)),
        )
    except Exception as exc:  # pragma: no cover - exercised through Node integration
        raise RuntimeError(f"Failed to run MarkPDFDown inference: {exc}") from exc

    normalized = str(markdown or "").strip()
    if not normalized:
        raise RuntimeError("MarkPDFDown returned empty markdown.")

    output_path.write_text(f"{normalized}\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
