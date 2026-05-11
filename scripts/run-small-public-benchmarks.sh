#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

RUN_ROOT="${PAPERNEXUS_SMALL_BENCH_ROOT:-${HOME}/papernexus-small-benchmarks}"
DATA_ROOT="${PAPERNEXUS_SMALL_BENCH_DATA:-${RUN_ROOT}/datasets}"
OUTPUT_ROOT="${PAPERNEXUS_SMALL_BENCH_OUTPUT:-${RUN_ROOT}/results}"
ISOLATED_HOME="${PAPERNEXUS_HOME_OVERRIDE:-${RUN_ROOT}/papernexus-home}"
SECURE_ENV_FILE="${PAPERNEXUS_SECURE_ENV_FILE:-}"
DATASET_LIST="${PAPERNEXUS_DATASETS:-scifact,csfcube,scholarqa-single}"
K_VALUES="${PAPERNEXUS_BENCHMARK_K:-1,5,10,20}"
BENCHMARK_LIMIT="${PAPERNEXUS_BENCHMARK_LIMIT:-}"
NODE_BIN="${PAPERNEXUS_NODE_BIN:-}"
SCHOLARQA_SAMPLE_FILE="${PAPERNEXUS_SCHOLARQA_SAMPLE_FILE:-scifact_test.jsonl}"
SCHOLARQA_BENCHMARK_LIMIT="${PAPERNEXUS_SCHOLARQA_BENCHMARK_LIMIT:-20}"
DISCOVERY_CACHE_TTL_MS="${PAPERNEXUS_DISCOVERY_CACHE_TTL_MS:-2592000000}"
DISCOVERY_FAILURE_CACHE_TTL_MS="${PAPERNEXUS_DISCOVERY_FAILURE_CACHE_TTL_MS:-600000}"
DISCOVERY_CIRCUIT_BREAKER_COOLDOWN_MS="${PAPERNEXUS_DISCOVERY_CIRCUIT_BREAKER_COOLDOWN_MS:-600000}"
DISCOVERY_CIRCUIT_BREAKER_FAILURE_THRESHOLD="${PAPERNEXUS_DISCOVERY_CIRCUIT_BREAKER_FAILURE_THRESHOLD:-3}"

SCIFACT_URL="https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip"
CSFCUBE_REPO_URL="https://github.com/iesl/CSFCube.git"
SCHOLARQA_REPO_URL="https://github.com/AkariAsai/ScholarQABench.git"

timestamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

log() {
  printf '[%s] %s\n' "$(timestamp)" "$*" >&2
}

fail() {
  printf '[%s] ERROR: %s\n' "$(timestamp)" "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

resolve_node_bin() {
  if [[ -n "$NODE_BIN" && -x "$NODE_BIN" ]]; then
    printf '%s\n' "$NODE_BIN"
    return
  fi

  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi

  local candidate
  for candidate in \
    "${HOME}/papernexus-runtime/node-current/bin/node" \
    "${HOME}/papernexus-runtime/node/bin/node" \
    "/usr/local/bin/node" \
    "/usr/bin/node"
  do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  fail "Missing required command: node"
}

clone_or_update_repo() {
  local repo_url="$1"
  local target_dir="$2"

  if [[ -d "${target_dir}/.git" ]]; then
    log "Updating ${target_dir}"
    git -C "$target_dir" fetch --depth 1 origin >&2
    git -C "$target_dir" reset --hard origin/HEAD >&2
    return
  fi

  rm -rf "$target_dir"
  log "Cloning ${repo_url} -> ${target_dir}"
  git clone --depth 1 "$repo_url" "$target_dir" >&2
}

ensure_scifact() {
  local archive_path="${DATA_ROOT}/scifact.zip"
  local dataset_dir="${DATA_ROOT}/scifact"

  mkdir -p "$DATA_ROOT"
  if [[ ! -f "$archive_path" ]]; then
    log "Downloading SciFact"
    curl -L --fail --retry 3 "$SCIFACT_URL" -o "$archive_path"
  fi

  if [[ ! -f "${dataset_dir}/corpus.jsonl" ]]; then
    log "Extracting SciFact"
    rm -rf "$dataset_dir"
    unzip -q -o "$archive_path" -d "$DATA_ROOT"
  fi

  [[ -f "${dataset_dir}/corpus.jsonl" ]] || fail "SciFact corpus.jsonl not found after extraction"
  [[ -f "${dataset_dir}/queries.jsonl" ]] || fail "SciFact queries.jsonl not found after extraction"
  [[ -f "${dataset_dir}/qrels/test.tsv" ]] || fail "SciFact qrels/test.tsv not found after extraction"
  printf '%s\n' "$dataset_dir"
}

ensure_csfcube() {
  local dataset_dir="${DATA_ROOT}/CSFCube"

  mkdir -p "$DATA_ROOT"
  clone_or_update_repo "$CSFCUBE_REPO_URL" "$dataset_dir"

  [[ -f "${dataset_dir}/abstracts-csfcube-preds.jsonl" ]] || fail "CSFCube abstracts-csfcube-preds.jsonl missing"
  [[ -f "${dataset_dir}/test-pid2anns-csfcube-background.json" ]] || fail "CSFCube background annotations missing"
  [[ -f "${dataset_dir}/test-pid2anns-csfcube-method.json" ]] || fail "CSFCube method annotations missing"
  [[ -f "${dataset_dir}/test-pid2anns-csfcube-result.json" ]] || fail "CSFCube result annotations missing"
  printf '%s\n' "$dataset_dir"
}

ensure_scholarqa_single() {
  local repo_dir="${DATA_ROOT}/ScholarQABench"
  local dataset_dir="${repo_dir}/data/single_paper_tasks"
  local dataset_path="${dataset_dir}/${SCHOLARQA_SAMPLE_FILE}"

  mkdir -p "$DATA_ROOT"
  clone_or_update_repo "$SCHOLARQA_REPO_URL" "$repo_dir"

  [[ -d "$dataset_dir" ]] || fail "ScholarQABench single_paper_tasks directory missing"
  [[ -f "$dataset_path" ]] || fail "ScholarQABench sample file missing: ${dataset_path}"
  printf '%s\n' "$dataset_path"
}

run_benchmark() {
  local dataset_key="$1"
  local dataset_path="$2"
  local format_name="$3"
  local eval_mode="$4"
  local dataset_limit="$5"
  local extra_args=("${@:6}")
  local dataset_output_dir="${OUTPUT_ROOT}/${dataset_key}"
  local report_path="${dataset_output_dir}/report.json"
  local log_path="${dataset_output_dir}/run.log"

  mkdir -p "$dataset_output_dir"
  : >"$log_path"

  local cmd=(
    "$NODE_BIN" "${REPO_ROOT}/src/cli/index.js"
    benchmark-retrieval "$dataset_path"
    --format "$format_name"
    --evaluation-mode "$eval_mode"
    --task-evaluation off
    --k "$K_VALUES"
    --output "$dataset_output_dir"
    --json
  )

  if [[ -n "$dataset_limit" ]]; then
    cmd+=(--benchmark-limit "$dataset_limit")
  elif [[ -n "$BENCHMARK_LIMIT" ]]; then
    cmd+=(--benchmark-limit "$BENCHMARK_LIMIT")
  fi
  if [[ "${#extra_args[@]}" -gt 0 ]]; then
    cmd+=("${extra_args[@]}")
  fi

  log "Running ${dataset_key} benchmark"
  (
    export PAPERNEXUS_HOME="$ISOLATED_HOME"
    if [[ -n "$SECURE_ENV_FILE" ]]; then
      export PAPERNEXUS_SECURE_ENV_FILE="$SECURE_ENV_FILE"
    fi
    export PAPERNEXUS_DISCOVERY_CACHE_TTL_MS="$DISCOVERY_CACHE_TTL_MS"
    export PAPERNEXUS_DISCOVERY_FAILURE_CACHE_TTL_MS="$DISCOVERY_FAILURE_CACHE_TTL_MS"
    export PAPERNEXUS_DISCOVERY_CIRCUIT_BREAKER_COOLDOWN_MS="$DISCOVERY_CIRCUIT_BREAKER_COOLDOWN_MS"
    export PAPERNEXUS_DISCOVERY_CIRCUIT_BREAKER_FAILURE_THRESHOLD="$DISCOVERY_CIRCUIT_BREAKER_FAILURE_THRESHOLD"
    cd "$REPO_ROOT"
    printf '{}\n' >"${ISOLATED_HOME}/config.json"
    "${cmd[@]}"
  ) >"$report_path" 2>"$log_path"

  log "Saved ${dataset_key} report to ${report_path}"
  log "Saved ${dataset_key} stderr log to ${log_path}"
}

main() {
  need_cmd bash
  need_cmd curl
  need_cmd git
  need_cmd unzip
  NODE_BIN="$(resolve_node_bin)"

  [[ -d "$REPO_ROOT" ]] || fail "Repo root not found: $REPO_ROOT"
  [[ -f "${REPO_ROOT}/src/cli/index.js" ]] || fail "PaperNexus CLI entrypoint missing under ${REPO_ROOT}"

  mkdir -p "$DATA_ROOT" "$OUTPUT_ROOT" "$ISOLATED_HOME"
  if [[ -z "$SECURE_ENV_FILE" && -f "${HOME}/.papernexus/secure-env.enc.json" ]]; then
    SECURE_ENV_FILE="${HOME}/.papernexus/secure-env.enc.json"
  fi
  printf '{}\n' >"${ISOLATED_HOME}/config.json"
  log "Using node binary: ${NODE_BIN}"
  if [[ -n "$SECURE_ENV_FILE" ]]; then
    log "Using secure env file: ${SECURE_ENV_FILE}"
  else
    log "No secure env file configured; live providers will use only process environment and explicit CLI flags"
  fi
  log "Using discovery cache TTL: ${DISCOVERY_CACHE_TTL_MS} ms"
  log "Using discovery failure cache TTL: ${DISCOVERY_FAILURE_CACHE_TTL_MS} ms"
  log "Using discovery circuit breaker: threshold=${DISCOVERY_CIRCUIT_BREAKER_FAILURE_THRESHOLD}, cooldown=${DISCOVERY_CIRCUIT_BREAKER_COOLDOWN_MS} ms"

  IFS=',' read -r -a requested_datasets <<<"$DATASET_LIST"
  for raw_name in "${requested_datasets[@]}"; do
    dataset_name="$(printf '%s' "$raw_name" | tr '[:upper:]' '[:lower:]' | xargs)"
    case "$dataset_name" in
      scifact)
        run_benchmark "scifact" "$(ensure_scifact)" "beir" "fixed-corpus" ""
        ;;
      csfcube)
        run_benchmark "csfcube" "$(ensure_csfcube)" "csfcube" "fixed-corpus" ""
        ;;
      scholarqa-single|scholarqa_single|scholarqa)
        run_benchmark "scholarqa-single" "$(ensure_scholarqa_single)" "scholarqa" "live" "$SCHOLARQA_BENCHMARK_LIMIT"
        ;;
      "")
        ;;
      *)
        fail "Unsupported dataset key: ${dataset_name}"
        ;;
    esac
  done

  log "All requested benchmarks completed. Reports are under ${OUTPUT_ROOT}"
}

main "$@"
