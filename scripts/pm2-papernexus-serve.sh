#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_NAME="${PAPERNEXUS_PM2_APP_NAME:-papernexus-serve}"
LOG_DIR="${PAPERNEXUS_LOG_DIR:-$HOME/.papernexus/log}"
PM2_BIN="${PM2_BIN:-pm2}"
NODE_BIN="${NODE_BIN:-node}"
SLEEP_BIN="${SLEEP_BIN:-sleep}"
DISK0_ROOT="${PAPERNEXUS_DISK0_ROOT:-/home/disk0}"

resolve_first_executable() {
  local candidate=""
  for candidate in "$@"; do
    [[ -n "${candidate}" ]] || continue
    if [[ "${candidate}" == "~/"* ]]; then
      candidate="${HOME}/${candidate#~/}"
    fi
    if [[ -x "${candidate}" && ! -d "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
    if command -v "${candidate}" >/dev/null 2>&1; then
      command -v "${candidate}"
      return 0
    fi
  done
  return 1
}

resolve_node_bin() {
  local previous_nullglob_state
  local candidate=""
  previous_nullglob_state="$(shopt -p nullglob || true)"
  shopt -s nullglob

  if resolve_first_executable \
    "${NODE_BIN}" \
    node \
    "${HOME}/miniconda3/bin/node" \
    "${HOME}/mambaforge/bin/node" \
    "${DISK0_ROOT}/${USER:-}/miniconda3/bin/node" \
    "${DISK0_ROOT}/${USER:-}/mambaforge/bin/node" \
    "${HOME}/.npm-global/bin/node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node; then
    if [[ -n "${previous_nullglob_state}" ]]; then
      eval "${previous_nullglob_state}"
    else
      shopt -u nullglob
    fi
    return 0
  fi

  for candidate in "${HOME}"/.nvm/versions/node/*/bin/node; do
    if resolve_first_executable "${candidate}"; then
      if [[ -n "${previous_nullglob_state}" ]]; then
        eval "${previous_nullglob_state}"
      else
        shopt -u nullglob
      fi
      return 0
    fi
  done

  if [[ -n "${previous_nullglob_state}" ]]; then
    eval "${previous_nullglob_state}"
  else
    shopt -u nullglob
  fi
  return 1
}

resolve_pm2_bin() {
  local previous_nullglob_state
  local candidate=""
  previous_nullglob_state="$(shopt -p nullglob || true)"
  shopt -s nullglob

  if resolve_first_executable \
    "${PM2_BIN}" \
    pm2 \
    "${HOME}/miniconda3/bin/pm2" \
    "${HOME}/mambaforge/bin/pm2" \
    "${DISK0_ROOT}/${USER:-}/miniconda3/bin/pm2" \
    "${DISK0_ROOT}/${USER:-}/mambaforge/bin/pm2" \
    "${HOME}/.npm-global/bin/pm2" \
    /opt/homebrew/bin/pm2 \
    /usr/local/bin/pm2 \
    /usr/bin/pm2; then
    if [[ -n "${previous_nullglob_state}" ]]; then
      eval "${previous_nullglob_state}"
    else
      shopt -u nullglob
    fi
    return 0
  fi

  for candidate in "${HOME}"/.nvm/versions/node/*/bin/pm2; do
    if resolve_first_executable "${candidate}"; then
      if [[ -n "${previous_nullglob_state}" ]]; then
        eval "${previous_nullglob_state}"
      else
        shopt -u nullglob
      fi
      return 0
    fi
  done

  if [[ -n "${previous_nullglob_state}" ]]; then
    eval "${previous_nullglob_state}"
  else
    shopt -u nullglob
  fi
  return 1
}

usage() {
  cat <<'EOF'
Usage:
  scripts/pm2-papernexus-serve.sh start [papernexus serve args...]
  scripts/pm2-papernexus-serve.sh restart [papernexus serve args...]
  scripts/pm2-papernexus-serve.sh stop
  scripts/pm2-papernexus-serve.sh delete
  scripts/pm2-papernexus-serve.sh status
  scripts/pm2-papernexus-serve.sh logs
  scripts/pm2-papernexus-serve.sh recent [--lines <n>] [--task-id <id>] [--paper-id <text>] [--grep <text>] [--all]
  scripts/pm2-papernexus-serve.sh run [papernexus serve args...]

Behavior:
  - Uses PM2 to keep `papernexus serve` alive.
  - Writes application logs to ~/.papernexus/log/papernexus-serve-YYYY-MM-DD.log
  - Rotates to a new daily log file by restarting the child process after the date changes.
  - `recent` reads the newest daily log and shows upload/import-focused lines so recent paper processing status is easier to inspect.
EOF
}

current_log_file() {
  local day
  day="$(date '+%F')"
  printf '%s/%s-%s.log' "${LOG_DIR}" "${APP_NAME}" "${day}"
}

latest_existing_log_file() {
  local candidates=()
  local previous_nullglob_state
  previous_nullglob_state="$(shopt -p nullglob || true)"
  shopt -s nullglob
  candidates=("${LOG_DIR}/${APP_NAME}-"*.log)
  if [[ -n "${previous_nullglob_state}" ]]; then
    eval "${previous_nullglob_state}"
  else
    shopt -u nullglob
  fi
  if [[ "${#candidates[@]}" -eq 0 ]]; then
    return 1
  fi
  ls -1t "${candidates[@]}" | head -n 1
}

recent_log_focus_pattern() {
  printf '%s' '(\[imports\]|imp:|import worker|materialize|llm-optimize|fast-commit|completed task|failed|background preparse|authoritative sync|Stage [0-9]+/[0-9]+)'
}

show_recent_logs() {
  local lines="40"
  local task_id=""
  local paper_id=""
  local grep_text=""
  local show_all="0"
  local log_file=""

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --lines)
        lines="${2:-}"
        shift 2
        ;;
      --task-id)
        task_id="${2:-}"
        shift 2
        ;;
      --paper-id)
        paper_id="${2:-}"
        shift 2
        ;;
      --grep)
        grep_text="${2:-}"
        shift 2
        ;;
      --log-file)
        log_file="${2:-}"
        shift 2
        ;;
      --all)
        show_all="1"
        shift
        ;;
      *)
        printf 'Unknown recent option: %s\n' "$1" >&2
        exit 1
        ;;
    esac
  done

  if ! [[ "${lines}" =~ ^[0-9]+$ ]] || [[ "${lines}" -le 0 ]]; then
    printf 'recent requires --lines to be a positive integer.\n' >&2
    exit 1
  fi

  if [[ -z "${log_file}" ]]; then
    if ! log_file="$(latest_existing_log_file)"; then
      printf 'No PaperNexus daily logs found under %s\n' "${LOG_DIR}" >&2
      exit 1
    fi
  fi

  if [[ ! -f "${log_file}" ]]; then
    printf 'Log file not found: %s\n' "${log_file}" >&2
    exit 1
  fi

  printf 'Log file: %s\n' "${log_file}"
  if [[ "${show_all}" == "1" ]]; then
    printf 'Filter: all log lines\n'
    tail -n "${lines}" "${log_file}"
    return
  fi

  local focus_pattern
  focus_pattern="$(recent_log_focus_pattern)"
  printf 'Filter: import-focused recent lines'
  if [[ -n "${task_id}" ]]; then
    printf ' | task=%s' "${task_id}"
  fi
  if [[ -n "${paper_id}" ]]; then
    printf ' | paper=%s' "${paper_id}"
  fi
  if [[ -n "${grep_text}" ]]; then
    printf ' | grep=%s' "${grep_text}"
  fi
  printf '\n'

  local filtered_output
  filtered_output="$(grep -E "${focus_pattern}" "${log_file}" || true)"
  if [[ -n "${task_id}" && -n "${filtered_output}" ]]; then
    filtered_output="$(printf '%s\n' "${filtered_output}" | grep -F "${task_id}" || true)"
  fi
  if [[ -n "${paper_id}" && -n "${filtered_output}" ]]; then
    filtered_output="$(printf '%s\n' "${filtered_output}" | grep -F "${paper_id}" || true)"
  fi
  if [[ -n "${grep_text}" && -n "${filtered_output}" ]]; then
    filtered_output="$(printf '%s\n' "${filtered_output}" | grep -F "${grep_text}" || true)"
  fi
  if [[ -n "${filtered_output}" ]]; then
    filtered_output="$(printf '%s\n' "${filtered_output}" | tail -n "${lines}")"
  fi

  if [[ -z "${filtered_output}" ]]; then
    printf 'No matching recent import lines found.\n'
    return
  fi
  printf '%s\n' "${filtered_output}"
}

run_serve() {
  local child_pid=""
  local stop_requested="0"
  local resolved_node_bin=""

  if ! resolved_node_bin="$(resolve_node_bin)"; then
    printf '[%s] [pm2-wrapper] unable to locate a usable node binary\n' "$(date '+%F %T')" >&2
    exit 127
  fi

  forward_and_exit() {
    stop_requested="1"
    if [[ -n "${child_pid}" ]] && kill -0 "${child_pid}" 2>/dev/null; then
      kill -TERM "${child_pid}" 2>/dev/null || true
      wait "${child_pid}" || true
    fi
    exit 0
  }

  trap forward_and_exit INT TERM

  while true; do
    local log_file
    log_file="$(current_log_file)"
    mkdir -p "$(dirname "${log_file}")"
    {
      printf '[%s] [pm2-wrapper] starting papernexus serve\n' "$(date '+%F %T')"
      printf '[%s] [pm2-wrapper] repo=%s\n' "$(date '+%F %T') " "${REPO_ROOT}"
      printf '[%s] [pm2-wrapper] node=%s\n' "$(date '+%F %T') " "${resolved_node_bin}"
    } >> "${log_file}"

    (
      cd "${REPO_ROOT}"
      exec "${resolved_node_bin}" ./src/cli/index.js serve "$@"
    ) >> "${log_file}" 2>&1 &
    child_pid="$!"

    local started_day
    started_day="$(date '+%F')"
    local restart_for_rollover="0"

    while kill -0 "${child_pid}" 2>/dev/null; do
      "${SLEEP_BIN}" 30
      if [[ "${started_day}" != "$(date '+%F')" ]]; then
        restart_for_rollover="1"
        printf '[%s] [pm2-wrapper] day changed, restarting papernexus serve for log rollover\n' "$(date '+%F %T')" >> "${log_file}"
        kill -TERM "${child_pid}" 2>/dev/null || true
        break
      fi
    done

    wait "${child_pid}" || true
    local exit_code=$?
    child_pid=""

    if [[ "${stop_requested}" == "1" ]]; then
      exit 0
    fi

    if [[ "${restart_for_rollover}" == "1" ]]; then
      continue
    fi

    printf '[%s] [pm2-wrapper] papernexus serve exited with code %s, restarting in 2s\n' "$(date '+%F %T')" "${exit_code}" >> "${log_file}"
    "${SLEEP_BIN}" 2
  done
}

pm2_start() {
  local resolved_pm2_bin=""
  local resolved_node_bin=""
  if ! resolved_pm2_bin="$(resolve_pm2_bin)"; then
    printf 'Unable to locate pm2. Set PM2_BIN or install pm2 in a standard location.\n' >&2
    exit 127
  fi
  if ! resolved_node_bin="$(resolve_node_bin)"; then
    printf 'Unable to locate node. Set NODE_BIN or install node in a standard location.\n' >&2
    exit 127
  fi
  PATH="$(dirname "${resolved_node_bin}"):${PATH}" NODE_BIN="${resolved_node_bin}" PM2_BIN="${resolved_pm2_bin}" "${resolved_pm2_bin}" start "${BASH_SOURCE[0]}" \
    --name "${APP_NAME}" \
    --interpreter /bin/bash \
    --cwd "${REPO_ROOT}" \
    --output /dev/null \
    --error /dev/null \
    -- run "$@"
  PATH="$(dirname "${resolved_node_bin}"):${PATH}" NODE_BIN="${resolved_node_bin}" PM2_BIN="${resolved_pm2_bin}" "${resolved_pm2_bin}" save
}

pm2_restart() {
  local resolved_pm2_bin=""
  local resolved_node_bin=""
  if ! resolved_pm2_bin="$(resolve_pm2_bin)"; then
    printf 'Unable to locate pm2. Set PM2_BIN or install pm2 in a standard location.\n' >&2
    exit 127
  fi
  if ! resolved_node_bin="$(resolve_node_bin)"; then
    printf 'Unable to locate node. Set NODE_BIN or install node in a standard location.\n' >&2
    exit 127
  fi
  if PATH="$(dirname "${resolved_node_bin}"):${PATH}" NODE_BIN="${resolved_node_bin}" PM2_BIN="${resolved_pm2_bin}" "${resolved_pm2_bin}" describe "${APP_NAME}" >/dev/null 2>&1; then
    PATH="$(dirname "${resolved_node_bin}"):${PATH}" NODE_BIN="${resolved_node_bin}" PM2_BIN="${resolved_pm2_bin}" "${resolved_pm2_bin}" restart "${APP_NAME}" --update-env
  else
    pm2_start "$@"
    return
  fi
  PATH="$(dirname "${resolved_node_bin}"):${PATH}" NODE_BIN="${resolved_node_bin}" PM2_BIN="${resolved_pm2_bin}" "${resolved_pm2_bin}" save
}

pm2_stop() {
  local resolved_pm2_bin=""
  local resolved_node_bin=""
  if ! resolved_pm2_bin="$(resolve_pm2_bin)"; then
    printf 'Unable to locate pm2. Set PM2_BIN or install pm2 in a standard location.\n' >&2
    exit 127
  fi
  if ! resolved_node_bin="$(resolve_node_bin)"; then
    printf 'Unable to locate node. Set NODE_BIN or install node in a standard location.\n' >&2
    exit 127
  fi
  PATH="$(dirname "${resolved_node_bin}"):${PATH}" NODE_BIN="${resolved_node_bin}" PM2_BIN="${resolved_pm2_bin}" "${resolved_pm2_bin}" stop "${APP_NAME}"
  PATH="$(dirname "${resolved_node_bin}"):${PATH}" NODE_BIN="${resolved_node_bin}" PM2_BIN="${resolved_pm2_bin}" "${resolved_pm2_bin}" save
}

pm2_delete() {
  local resolved_pm2_bin=""
  local resolved_node_bin=""
  if ! resolved_pm2_bin="$(resolve_pm2_bin)"; then
    printf 'Unable to locate pm2. Set PM2_BIN or install pm2 in a standard location.\n' >&2
    exit 127
  fi
  if ! resolved_node_bin="$(resolve_node_bin)"; then
    printf 'Unable to locate node. Set NODE_BIN or install node in a standard location.\n' >&2
    exit 127
  fi
  PATH="$(dirname "${resolved_node_bin}"):${PATH}" NODE_BIN="${resolved_node_bin}" PM2_BIN="${resolved_pm2_bin}" "${resolved_pm2_bin}" delete "${APP_NAME}"
  PATH="$(dirname "${resolved_node_bin}"):${PATH}" NODE_BIN="${resolved_node_bin}" PM2_BIN="${resolved_pm2_bin}" "${resolved_pm2_bin}" save
}

pm2_status() {
  local resolved_pm2_bin=""
  local resolved_node_bin=""
  if ! resolved_pm2_bin="$(resolve_pm2_bin)"; then
    printf 'Unable to locate pm2. Set PM2_BIN or install pm2 in a standard location.\n' >&2
    exit 127
  fi
  if ! resolved_node_bin="$(resolve_node_bin)"; then
    printf 'Unable to locate node. Set NODE_BIN or install node in a standard location.\n' >&2
    exit 127
  fi
  PATH="$(dirname "${resolved_node_bin}"):${PATH}" NODE_BIN="${resolved_node_bin}" PM2_BIN="${resolved_pm2_bin}" "${resolved_pm2_bin}" status "${APP_NAME}"
}

pm2_logs() {
  local resolved_pm2_bin=""
  local resolved_node_bin=""
  if ! resolved_pm2_bin="$(resolve_pm2_bin)"; then
    printf 'Unable to locate pm2. Set PM2_BIN or install pm2 in a standard location.\n' >&2
    exit 127
  fi
  if ! resolved_node_bin="$(resolve_node_bin)"; then
    printf 'Unable to locate node. Set NODE_BIN or install node in a standard location.\n' >&2
    exit 127
  fi
  PATH="$(dirname "${resolved_node_bin}"):${PATH}" NODE_BIN="${resolved_node_bin}" PM2_BIN="${resolved_pm2_bin}" "${resolved_pm2_bin}" logs "${APP_NAME}"
}

main() {
  local command="${1:-}"
  if [[ -z "${command}" ]]; then
    usage
    exit 1
  fi
  shift || true

  case "${command}" in
    start)
      pm2_start "$@"
      ;;
    restart)
      pm2_restart "$@"
      ;;
    stop)
      pm2_stop
      ;;
    delete)
      pm2_delete
      ;;
    status)
      pm2_status
      ;;
    logs)
      pm2_logs
      ;;
    recent)
      show_recent_logs "$@"
      ;;
    run)
      run_serve "$@"
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
