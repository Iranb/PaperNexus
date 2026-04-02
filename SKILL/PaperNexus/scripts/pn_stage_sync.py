#!/usr/bin/env python3
import argparse
import os

from pn_common import RemoteScriptError, emit_result, fail, stage_local_path


def parse_args():
    parser = argparse.ArgumentParser(description="Sync local PDF/Markdown files to a remote staging directory.")
    parser.add_argument("--ssh-target", default=os.environ.get("PAPERNEXUS_SSH_TARGET", ""))
    parser.add_argument("--remote-dir", default="")
    parser.add_argument("--remote-staging-root", default=os.environ.get("PAPERNEXUS_REMOTE_STAGING_ROOT", ""))
    parser.add_argument("--ssh-bin", default=os.environ.get("PAPERNEXUS_SSH_BIN", "ssh"))
    parser.add_argument("--rsync-bin", default=os.environ.get("PAPERNEXUS_RSYNC_BIN", "rsync"))
    parser.add_argument("--corpus", default="")
    parser.add_argument("--corpus-root", default="")
    parser.add_argument("--source", default="")
    parser.add_argument("--mode", choices=["full", "incremental"], default="incremental")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("local_path", nargs="?")
    return parser.parse_args()


def resolve_local_path(args) -> str:
    value = (args.source or args.corpus_root or args.local_path or "").strip()
    if not value:
        raise RemoteScriptError("Missing local source path. Pass --source, --corpus-root, or a positional path.")
    return value


def main() -> int:
    args = parse_args()
    try:
        if not args.ssh_target.strip():
            raise RemoteScriptError("Missing SSH target. Pass --ssh-target or set PAPERNEXUS_SSH_TARGET.")
        local_path = resolve_local_path(args)
        payload = stage_local_path(
            local_path,
            ssh_target=args.ssh_target.strip(),
            remote_dir=(args.remote_dir or "").strip(),
            remote_root=(args.remote_staging_root or "").strip(),
            ssh_bin=args.ssh_bin,
            rsync_bin=args.rsync_bin
        )
        payload["mode"] = args.mode
        return emit_result(payload, args.json)
    except RemoteScriptError as exc:
        return fail(str(exc), args.json)


if __name__ == "__main__":
    raise SystemExit(main())
