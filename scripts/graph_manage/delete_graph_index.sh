# 只删图和索引，保留 Markdown cache, 重建图

papernexus service uninstall --services watch,serve
INDEX_ROOT="${PAPERNEXUS_INDEX_DIR:-${HOME}/.papernexus/index-store}"
GRAPH_DIR="${INDEX_ROOT}/.papernexus"

rm -rf "${INDEX_ROOT}/.papernexus.lock"

rm -f "${GRAPH_DIR}/graph.json"
rm -rf "${GRAPH_DIR}/graph.kuzu"
rm -f "${GRAPH_DIR}/graph.lite.json"
rm -f "${GRAPH_DIR}/graph.lite.state.json"
rm -f "${GRAPH_DIR}/meta.json"
rm -f "${GRAPH_DIR}/sources.json"

papernexus optimize --force
