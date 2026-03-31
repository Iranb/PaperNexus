#!/usr/bin/env python3
import argparse
import os
import shlex
from pathlib import Path

from pn_common import RemoteScriptError, collect_supported_files, emit_result, fail, run_command


def parse_args():
    parser = argparse.ArgumentParser(description="Sync local PDF/Markdown files to a remote staging directory.")
    parser.add_argument("--ssh-target", required=True)
    parser.add_argument("--remote-dir", required=True)
    parser.add_argument("--ssh-bin", default=os.environ.get("PAPERNEXUS_SSH_BIN", "ssh"))
    parser.add_argument("--rsync-bin", default=os.environ.get("PAPERNEXUS_RSYNC_BIN", "rsync"))
    parser.add_argument("--json", action="store_true")
    parser.add_argument("local_path")
    return parser.parse_args()


def build_remote_paths(local_root: Path, files: list[Path], remote_dir: str) -> list[str]:
    remote_root = remote_dir.rstrip("/")
    if local_root.is_file():
        return [f"{remote_root}/{local_root.name}"]
    remote_files = []
    for file_path in files:
        relative = file_path.relative_to(local_root).as_posix()
        remote_files.append(f"{remote_root}/{relative}")
    return remote_files


def main() -> int:
    args = parse_args()
    try:
        local_root = Path(args.local_path).expanduser().resolve()
        files = collect_supported_files(args.local_path)
        if not args.remote_dir.startswith("/"):
            raise RemoteScriptError("Remote staging directory must be an absolute path.")

        run_command([args.ssh_bin, args.ssh_target, f"mkdir -p {shlex.quote(args.remote_dir)}"])

        rsync_source = str(local_root)
        if local_root.is_dir():
            rsync_source = f"{rsync_source.rstrip('/')}/"
        rsync_target = f"{args.ssh_target}:{args.remote_dir.rstrip('/')}/"
        run_command([
            args.rsync_bin,
            "-avz",
            "--partial",
            "--partial-dir=.rsync-partial",
            "--progress",
            "--checksum",
            "--timeout=60",
            rsync_source,
            rsync_target
        ], timeout=300.0)

        payload = {
            "localPath": str(local_root),
            "remoteDir": args.remote_dir.rstrip("/"),
            "fileCount": len(files),
            "remoteFiles": build_remote_paths(local_root, files, args.remote_dir)
        }
        return emit_result(payload, args.json)
    except RemoteScriptError as exc:
        return fail(str(exc), args.json)


if __name__ == "__main__":
    raise SystemExit(main())
