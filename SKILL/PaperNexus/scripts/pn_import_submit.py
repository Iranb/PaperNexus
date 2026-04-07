#!/usr/bin/env python3
import typing
import argparse
import os
from pathlib import Path

from pn_common import (
    RemoteScriptError,
    add_connection_args,
    call_mcp_tool_json,
    emit_result,
    fail,
    infer_source_kind,
    mcp_host_is_local,
    normalize_mcp_url,
    resolve_corpus,
    resolve_token,
    stage_local_path,
    update_registry_from_task_payload
)


def parse_args():
    parser = argparse.ArgumentParser(description="Submit a staged server-side file to PaperNexus imports.")
    add_connection_args(parser)
    parser.add_argument("--server-file-path", default="")
    parser.add_argument("--paper-id", default="")
    parser.add_argument("--source", default="")
    parser.add_argument("--source-kind", default="")
    parser.add_argument("--ssh-target", default=os.environ.get("PAPERNEXUS_SSH_TARGET", ""))
    parser.add_argument("--remote-dir", default="")
    parser.add_argument("--remote-staging-root", default=os.environ.get("PAPERNEXUS_REMOTE_STAGING_ROOT", ""))
    parser.add_argument("--ssh-bin", default=os.environ.get("PAPERNEXUS_SSH_BIN", "ssh"))
    parser.add_argument("--rsync-bin", default=os.environ.get("PAPERNEXUS_RSYNC_BIN", "rsync"))
    parser.add_argument("--trigger", default="mcp")
    return parser.parse_args()


def infer_paper_id(explicit: str, source_value: str) -> str:
    if (explicit or "").strip():
        return explicit.strip()
    stem = Path(source_value).stem.strip()
    if stem:
        return stem
    return ""


def resolve_submission_source(args, mcp_url: str) -> tuple[str, typing.Optional[dict], str]:
    server_file_path = (args.server_file_path or "").strip()
    if server_file_path:
        if not server_file_path.startswith("/"):
            raise RemoteScriptError("--server-file-path must be an absolute path on the PaperNexus server.")
        return server_file_path, None, ""

    source = (args.source or "").strip()
    if not source:
        raise RemoteScriptError("Missing source. Pass --source or --server-file-path.")

    local_candidate = Path(source).expanduser()
    if local_candidate.exists():
        local_candidate = local_candidate.resolve()
        if local_candidate.is_dir():
            raise RemoteScriptError("--source must point to a single PDF or Markdown file.")
        if mcp_host_is_local(mcp_url):
            return str(local_candidate), None, str(local_candidate)
        if not args.ssh_target.strip():
            raise RemoteScriptError("Local source requires remote staging. Pass --ssh-target or set PAPERNEXUS_SSH_TARGET.")
        staged = stage_local_path(
            str(local_candidate),
            ssh_target=args.ssh_target.strip(),
            remote_dir=(args.remote_dir or "").strip(),
            remote_root=(args.remote_staging_root or "").strip(),
            ssh_bin=args.ssh_bin,
            rsync_bin=args.rsync_bin
        )
        return staged["remoteFiles"][0], staged, str(local_candidate)

    if local_candidate.is_absolute():
        return str(local_candidate), None, source

    raise RemoteScriptError(
        "Source path does not exist locally. Pass a local file path, or use --server-file-path for a PaperNexus-server path."
    )


def main() -> int:
    args = parse_args()
    try:
        mcp_url = normalize_mcp_url(args.mcp_url, args.api_base)
        token = resolve_token(args.token)
        corpus = resolve_corpus(args.corpus, mcp_url, token, timeout=args.request_timeout)
        server_file_path, staging_payload, source_value = resolve_submission_source(args, mcp_url)
        paper_id = infer_paper_id(args.paper_id, source_value or server_file_path)
        source_kind = infer_source_kind(source_value or server_file_path, args.source_kind)
        payload = call_mcp_tool_json(
            mcp_url,
            token,
            "import_workflow",
            {
                "operation": "submit",
                "corpus": corpus,
                "serverFilePath": server_file_path,
                "trigger": args.trigger
            },
            timeout=args.request_timeout
        )
        registry_path = update_registry_from_task_payload(
            payload,
            paper_id=paper_id,
            source=source_value or args.source or args.server_file_path,
            source_kind=source_kind,
            remote_file=server_file_path,
            corpus=corpus
        )
        task = payload.get("task", {})
        result = {
            **payload,
            "paperId": paper_id,
            "source": source_value or args.source or args.server_file_path,
            "sourceKind": source_kind,
            "remoteFile": server_file_path,
            "submitted": True,
            "synced": str(task.get("status") or "").lower() == "completed" and str(task.get("stage") or "").lower() == "completed",
            "registry": {
                "path": str(registry_path),
                "saved": True
            },
            "message": "Upload accepted but graph sync is still in progress." if str(task.get("status") or "").lower() != "completed" else "Import completed."
        }
        if staging_payload:
            result["staging"] = staging_payload
        return emit_result(result, args.json)
    except RemoteScriptError as exc:
        return fail(str(exc), args.json)


if __name__ == "__main__":
    raise SystemExit(main())
