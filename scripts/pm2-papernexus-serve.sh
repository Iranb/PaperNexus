#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_NAME="${PAPERNEXUS_PM2_APP_NAME:-papernexus-serve}"
LOG_DIR="${PAPERNEXUS_LOG_DIR:-$HOME/.papernexus/log}"
PM2_BIN="${PM2_BIN:-pm2}"
NODE_BIN="${NODE_BIN:-node}"
SLEEP_BIN="${SLEEP_BIN:-sleep}"

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
  filtered_output="$(
    awk \
      -v focus_pattern="${focus_pattern}" \
      -v task_id="${task_id}" \
      -v paper_id="${paper_id}" \
      -v grep_text="${grep_text}" \
      '
        function contains(haystack, needle) {
          return needle == "" || index(haystack, needle) > 0
        }
        {
          if ($0 !~ focus_pattern) next
          if (!contains($0, task_id)) next
          if (!contains($0, paper_id)) next
          if (!contains($0, grep_text)) next
          print
        }
      ' "${log_file}" | tail -n "${lines}"
  )"

  if [[ -z "${filtered_output}" ]]; then
    printf 'No matching recent import lines found.\n'
    return
  fi
  printf '%s\n' "${filtered_output}"
}

run_serve() {
  local child_pid=""
  local stop_requested="0"

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
    } >> "${log_file}"

    (
      cd "${REPO_ROOT}"
      exec "${NODE_BIN}" ./src/cli/index.js serve "$@"
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
  "${PM2_BIN}" start "${BASH_SOURCE[0]}" \
    --name "${APP_NAME}" \
    --interpreter /bin/bash \
    --cwd "${REPO_ROOT}" \
    --output /dev/null \
    --error /dev/null \
    -- run "$@"
  "${PM2_BIN}" save
}

pm2_restart() {
  if "${PM2_BIN}" describe "${APP_NAME}" >/dev/null 2>&1; then
    "${PM2_BIN}" restart "${APP_NAME}" --update-env
  else
    pm2_start "$@"
    return
  fi
  "${PM2_BIN}" save
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
      "${PM2_BIN}" stop "${APP_NAME}"
      "${PM2_BIN}" save
      ;;
    delete)
      "${PM2_BIN}" delete "${APP_NAME}"
      "${PM2_BIN}" save
      ;;
    status)
      "${PM2_BIN}" status "${APP_NAME}"
      ;;
    logs)
      "${PM2_BIN}" logs "${APP_NAME}"
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
