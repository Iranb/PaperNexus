⏺ All changes complete. Here's the full summary:                                                                                                                                                         
                                                                                                                                                                                                         
  ---                                                                                                                                                                                                    
  PaperNexus Integration Fixes — Complete                                                                                                                                                                
                                                                                                                                                                                                         
  PaperNexus Changes (4 files)                                                                                                                                                                           
                                                                                                                                                                                                         
  ┌─────────────────────────────┬─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐  
  │            File             │                                                                               Change                                                                                │  
  ├─────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤  
  │ src/core/graph/schema.js    │ Added FALSIFIED_BY edge type                                                                                                                                        │
  ├─────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤  
  │ src/core/graph/rules.js     │ Added compatibility rule: Finding/Claim can have FALSIFIED_BY edges to Claim/Finding                                                                                │  
  ├─────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤  
  │ src/core/graph/mutations.js │ Added create and create_edge action aliases; normalizeAction() now auto-detects node vs relationship from operation fields; nodeType alias for type; edgeType alias │  
  │                             │  for type; from/to aliases for source/target — applied in prepareNodeDraft, prepareRelationshipDraft, upsertRelationship, and deleteRelationship                    │  
  ├─────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤  
  │ src/mcp/tools.js            │ Added refresh_corpus tool definition; documented nodeType/edgeType/from/to field aliases; added create/create_edge to action enum                                   │  
  ├─────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤  
  │ src/mcp/server.js           │ Added refresh_corpus handler that calls analyzeCorpus() with incremental mode                                                                                       │
  └─────────────────────────────┴─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘  
                                                            
  openclaw-research Changes (4 files)                                                                                                                                                                    
                                                            
  ┌───────────────────────────────────────────────┬─────────────────────────────────────────────────────────────────────────────────────┐                                                                
  │                     File                      │                                       Change                                        │
  ├───────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────┤
  │ tools/workflow-guard-state/paper-ingestion.ts │ Added dryRun: false to mutate_graph call (PaperNexus defaults to dryRun=true)       │
  ├───────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────┤
  │ tools/research-writing/citation-grounding.ts  │ Fixed layers parameter from ["DocumentLayer"] (array) to "DocumentLayer" (string)   │                                                                
  ├───────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────┤                                                                
  │ tools/papernexus-packets/mcp-client.ts        │ Added "refresh_corpus" to PapernexusMcpToolName union type                          │                                                                
  ├───────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────┤                                                                
  │ tools/graph-presence.ts                       │ Changed triggerGraphRefreshIfNeeded to call refresh_corpus instead of corpus_status │
  └───────────────────────────────────────────────┴─────────────────────────────────────────────────────────────────────────────────────┘                                                                
                                                            
  Plan saved to                                                                                                                                                                                          
                                                            
  openclaw-research/plan/PAPERNEXUS_INTEGRATION_FIXES.md — documents all 7 problems found, fixes applied, and the 2 future-proofing notes for extract_takeaways and interdisciplinary_potential parameter
   names (no active call sites yet, documented for Phase 2B implementation).
                                                                                                   