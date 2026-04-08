#!/usr/bin/env python3
import argparse
import os
import sys


def parse_args():
    parser = argparse.ArgumentParser(description="Convert PDF to Markdown via Docling.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--ocr-engine", default="")
    parser.add_argument("--pdf-backend", default="")
    parser.add_argument("--use-vlm", action="store_true")
    parser.add_argument("--vlm-preset", default="granite_docling")
    parser.add_argument("--provider", default="openai")
    parser.add_argument("--model-name", default="")
    parser.add_argument("--base-url", default="")
    parser.add_argument("--max-tokens", type=int, default=4096)
    return parser.parse_args()


def normalize_chat_url(base_url: str) -> str:
    normalized = (base_url or "").strip().rstrip("/")
    if not normalized:
        return ""
    if normalized.endswith("/chat/completions"):
        return normalized
    return f"{normalized}/chat/completions"


def convert_standard(args):
    from docling.document_converter import DocumentConverter

    converter = DocumentConverter()
    result = converter.convert(args.input)
    return result.document.export_to_markdown()


def convert_vlm(args):
    try:
      from docling.datamodel.base_models import InputFormat
      from docling.datamodel.pipeline_options import VlmConvertOptions, VlmPipelineOptions
      from docling.datamodel.vlm_engine_options import ApiVlmEngineOptions, VlmEngineType
      from docling.document_converter import DocumentConverter, PdfFormatOption
      from docling.pipeline.vlm_pipeline import VlmPipeline
    except ImportError as error:
      raise RuntimeError(
          "Docling VLM mode requires Docling with VLM-capable dependencies. "
          "Install the appropriate extras and verify the runtime can import docling VLM modules."
      ) from error

    base_url = normalize_chat_url(args.base_url)
    if not base_url:
        raise RuntimeError("Docling VLM mode requires a base URL for an OpenAI-compatible chat completions endpoint.")
    if not args.model_name:
        raise RuntimeError("Docling VLM mode requires a model name.")

    headers = {}
    api_key = os.environ.get("PAPERNEXUS_DOCLING_VLM_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    engine_options = ApiVlmEngineOptions(
        runtime_type=VlmEngineType.API,
        url=base_url,
        headers=headers or None,
        params={
            "model": args.model_name,
            "max_tokens": args.max_tokens,
            "skip_special_tokens": True,
        },
        timeout=120,
    )
    vlm_options = VlmConvertOptions.from_preset(
        args.vlm_preset,
        engine_options=engine_options,
    )
    pipeline_options = VlmPipelineOptions(
        vlm_options=vlm_options,
        enable_remote_services=True,
    )

    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(
                pipeline_options=pipeline_options,
                pipeline_cls=VlmPipeline,
            )
        }
    )
    result = converter.convert(args.input)
    return result.document.export_to_markdown()


def main():
    args = parse_args()
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)

    try:
        markdown = convert_vlm(args) if args.use_vlm else convert_standard(args)
    except Exception as error:  # noqa: BLE001
        print(str(error), file=sys.stderr)
        sys.exit(1)

    with open(args.output, "w", encoding="utf-8") as handle:
        handle.write(markdown)


if __name__ == "__main__":
    main()
