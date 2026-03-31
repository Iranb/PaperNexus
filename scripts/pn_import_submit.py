#!/usr/bin/env python3
import argparse
import urllib.parse

from pn_common import (
    RemoteScriptError,
    add_connection_args,
    emit_result,
    fail,
    normalize_api_base,
    request_json,
    require_corpus,
    resolve_token
)


def parse_args():
    parser = argparse.ArgumentParser(description="Submit a staged server-side file to PaperNexus imports.")
    add_connection_args(parser)
    parser.add_argument("--server-file-path", required=True)
    parser.add_argument("--trigger", default="api")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        api_base = normalize_api_base(args.api_base)
        token = resolve_token(args.token)
        corpus = require_corpus(args.corpus)
        if not args.server_file_path.startswith("/"):
            raise RemoteScriptError("--server-file-path must be an absolute path on the API server.")
        payload = request_json(
            "POST",
            api_base,
            f"/api/imports?name={urllib.parse.quote(corpus)}",
            token,
            payload={
                "serverFilePath": args.server_file_path,
                "trigger": args.trigger
            },
            timeout=args.request_timeout
        )
        return emit_result(payload, args.json)
    except RemoteScriptError as exc:
        return fail(str(exc), args.json)


if __name__ == "__main__":
    raise SystemExit(main())
