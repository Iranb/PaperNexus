# 删图和索引，保留 Markdown cache
# 且怀疑 snapshot 也有问题，那就再深一层，保留 markdown cache，但把 paper snapshot 也删掉，然后从缓存 markdown 重新做一轮：
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
rm -rf "${GRAPH_DIR}/papers"

papernexus analyze --force

papernexus service install
