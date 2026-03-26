# 只删图和索引，保留 Markdown cache, 重建图

papernexus service uninstall --services watch,serve
rm -rf /Users/iranb/.papernexus/index-store/.papernexus.lock

rm -f /Users/iranb/.papernexus/index-store/.papernexus/graph.json
rm -rf /Users/iranb/.papernexus/index-store/.papernexus/graph.kuzu
rm -f /Users/iranb/.papernexus/index-store/.papernexus/graph.lite.json
rm -f /Users/iranb/.papernexus/index-store/.papernexus/graph.lite.state.json
rm -f /Users/iranb/.papernexus/index-store/.papernexus/meta.json
rm -f /Users/iranb/.papernexus/index-store/.papernexus/sources.json

papernexus optimize --force