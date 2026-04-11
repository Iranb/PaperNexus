#!/usr/bin/env python3

import argparse
import os
import sys
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="Convert a PDF to markdown using Microsoft MarkItDown.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name, "")
    if raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def build_converter():
    try:
        from markitdown import MarkItDown
    except Exception as exc:  # pragma: no cover - exercised through Node integration
        raise RuntimeError(
            "MarkItDown is not available. Install `markitdown[pdf]` in the selected Python environment."
        ) from exc

    kwargs = {
        "enable_plugins": env_flag("PAPERNEXUS_MARKITDOWN_ENABLE_PLUGINS", False)
    }

    if env_flag("PAPERNEXUS_MARKITDOWN_USE_LLM", False):
        model = os.environ.get("PAPERNEXUS_MARKITDOWN_LLM_MODEL", "").strip()
        if not model:
            raise RuntimeError("MarkItDown LLM mode requires PAPERNEXUS_MARKITDOWN_LLM_MODEL.")

        try:
            from openai import OpenAI
        except Exception as exc:  # pragma: no cover - exercised through Node integration
            raise RuntimeError(
                "MarkItDown LLM mode requires the `openai` Python package for OpenAI-compatible clients."
            ) from exc

        client_kwargs = {}
        api_key = os.environ.get("PAPERNEXUS_MARKITDOWN_LLM_API_KEY", "").strip()
        base_url = os.environ.get("PAPERNEXUS_MARKITDOWN_LLM_BASE_URL", "").strip()
        prompt = os.environ.get("PAPERNEXUS_MARKITDOWN_LLM_PROMPT", "").strip()

        if api_key:
            client_kwargs["api_key"] = api_key
        if base_url:
            client_kwargs["base_url"] = base_url

        kwargs["llm_client"] = OpenAI(**client_kwargs)
        kwargs["llm_model"] = model
        if prompt:
            kwargs["llm_prompt"] = prompt

    return MarkItDown(**kwargs)


def main():
    args = parse_args()
    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if not input_path.exists():
        raise RuntimeError(f"Input PDF not found: {input_path}")

    try:
        converter = build_converter()
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
