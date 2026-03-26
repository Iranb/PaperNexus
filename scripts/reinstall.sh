#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLI_PATH="${PROJECT_ROOT}/src/cli/index.js"

SERVICES="watch,serve"
CONFIG_PATH=""
SKIP_INSTALL=0
SKIP_LINK=0
DRY_RUN=0

log() {
  printf '[reinstall] %s\n' "$1"
}

usage() {
  cat <<EOF
PaperNexus reinstall helper

Usage:
  $(basename "$0") [--config <path>] [--services watch,serve] [--skip-install] [--skip-link] [--dry-run]

What it does:
  1. uninstall current background services
  2. run npm install
  3. run npm link
  4. install the requested background services again
  5. print service status

Options:
  --config <path>      Use an explicit config JSON file for service install
  --services <list>    Services to reinstall, default: watch,serve
  --skip-install       Skip npm install
  --skip-link          Skip npm link
  --dry-run            Print the commands without executing them
  -h, --help           Show this help
EOF
}

print_cmd() {
  local first=1
  printf '[dry-run]'
  for arg in "$@"; do
    if [[ "${first}" -eq 1 ]]; then
      printf ' %s' "${arg}"
      first=0
    else
      printf ' %s' "${arg}"
    fi
  done
  printf '\n'
}

run_cmd() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    print_cmd "$@"
    return 0
  fi
  "$@"
}

run_cli() {
  local -a cmd
  cmd=(node "${CLI_PATH}")
  if [[ -n "${CONFIG_PATH}" ]]; then
    cmd+=(--config "${CONFIG_PATH}")
  fi
  cmd+=("$@")
  run_cmd "${cmd[@]}"
}

run_cli_quiet() {
  local -a cmd
  cmd=(node "${CLI_PATH}")
  if [[ -n "${CONFIG_PATH}" ]]; then
    cmd+=(--config "${CONFIG_PATH}")
  fi
  cmd+=("$@")
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    print_cmd "${cmd[@]}"
    return 0
  fi
  "${cmd[@]}" >/dev/null 2>&1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      CONFIG_PATH="${2:-}"
      shift 2
      ;;
    --services)
      SERVICES="${2:-}"
      shift 2
      ;;
    --skip-install)
      SKIP_INSTALL=1
      shift
      ;;
    --skip-link)
      SKIP_LINK=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -n "${CONFIG_PATH}" ]]; then
  CONFIG_PATH="$(cd "$(dirname "${CONFIG_PATH}")" && pwd)/$(basename "${CONFIG_PATH}")"
fi

cd "${PROJECT_ROOT}"

log "project root: ${PROJECT_ROOT}"
log "services: ${SERVICES}"
if [[ -n "${CONFIG_PATH}" ]]; then
  log "config: ${CONFIG_PATH}"
fi
if [[ "${DRY_RUN}" -eq 1 ]]; then
  log "dry-run: enabled"
fi

log "stopping existing background services (if installed)"
run_cli_quiet service uninstall --services "${SERVICES}" || true

if [[ "${SKIP_INSTALL}" -eq 0 ]]; then
  log "running npm install"
  run_cmd npm install
else
  log "skipping npm install"
fi

if [[ "${SKIP_LINK}" -eq 0 ]]; then
  log "running npm link"
  run_cmd npm link
else
  log "skipping npm link"
fi

log "installing background services"
run_cli service install --services "${SERVICES}"

log "current service status"
run_cli service status --services "${SERVICES}"

log "reinstall complete"
