# 删图和索引，保留 Markdown cache
# 且怀疑 snapshot 也有问题，那就再深一层，保留 markdown cache，但把 paper snapshot 也删掉，然后从缓存 markdown 重新做一轮：
papernexus service uninstall --services watch,serve
rm -rf /Users/iranb/.papernexus/index-store/.papernexus.lock

rm -f /Users/iranb/.papernexus/index-store/.papernexus/graph.json
rm -rf /Users/iranb/.papernexus/index-store/.papernexus/graph.kuzu
rm -f /Users/iranb/.papernexus/index-store/.papernexus/graph.lite.json
rm -f /Users/iranb/.papernexus/index-store/.papernexus/graph.lite.state.json
rm -f /Users/iranb/.papernexus/index-store/.papernexus/meta.json
rm -f /Users/iranb/.papernexus/index-store/.papernexus/sources.json
rm -rf /Users/iranb/.papernexus/index-store/.papernexus/papers

papernexus analyze --force

papernexus service install