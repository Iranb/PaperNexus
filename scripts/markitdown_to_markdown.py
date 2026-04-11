#!/usr/bin/env python3

import argparse
import os
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

HEARTBEAT_INTERVAL_SECONDS = 10


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


def log(message: str) -> None:
    print(str(message), file=sys.stderr, flush=True)


def human_bytes(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    units = ["KB", "MB", "GB", "TB"]
    value = float(size_bytes)
    unit_index = -1
    while value >= 1024 and unit_index < len(units) - 1:
        value /= 1024
        unit_index += 1
    return f"{value:.1f} {units[unit_index]}"


def summarize_runtime() -> str:
    use_llm = env_flag("PAPERNEXUS_MARKITDOWN_USE_LLM", False)
    enable_plugins = env_flag("PAPERNEXUS_MARKITDOWN_ENABLE_PLUGINS", False)
    parts = [
        f"plugins={'enabled' if enable_plugins else 'disabled'}",
        f"llm={'enabled' if use_llm else 'disabled'}",
    ]
    if use_llm:
        model = os.environ.get("PAPERNEXUS_MARKITDOWN_LLM_MODEL", "").strip() or "unknown"
        base_url = os.environ.get("PAPERNEXUS_MARKITDOWN_LLM_BASE_URL", "").strip()
        host = urlparse(base_url).netloc or base_url or "unknown"
        prompt = os.environ.get("PAPERNEXUS_MARKITDOWN_LLM_PROMPT", "").strip()
        parts.append(f"model={model}")
        parts.append(f"endpoint={host}")
        parts.append(f"prompt={'custom' if prompt else 'default'}")
    return ", ".join(parts)


class Heartbeat:
    def __init__(self, label: str, interval_seconds: int = HEARTBEAT_INTERVAL_SECONDS):
        self.label = label
        self.interval_seconds = max(1, int(interval_seconds))
        self.started_at = time.monotonic()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.wait(self.interval_seconds):
            elapsed = int(time.monotonic() - self.started_at)
            log(f"{self.label} still running ({elapsed}s elapsed)")

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        self._stop.set()
        self._thread.join(timeout=0.2)


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

    input_size = input_path.stat().st_size
    log(f"Preparing MarkItDown conversion for {input_path.name} ({human_bytes(input_size)})")
    log(f"MarkItDown runtime: {summarize_runtime()}")

    try:
        log("Loading MarkItDown runtime")
        converter = build_converter()
        log("Starting PDF to markdown conversion")
        with Heartbeat("MarkItDown conversion"):
            result = converter.convert(str(input_path))
    except Exception as exc:  # pragma: no cover - exercised through Node integration
        raise RuntimeError(f"Failed to run MarkItDown inference: {exc}") from exc

    markdown = str(getattr(result, "text_content", "") or "").strip()
    if not markdown:
        raise RuntimeError("MarkItDown returned empty markdown.")

    log(f"Conversion finished, writing markdown output to {output_path}")
    output_path.write_text(f"{markdown}\n", encoding="utf-8")
    log(f"Wrote markdown output ({human_bytes(output_path.stat().st_size)})")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
