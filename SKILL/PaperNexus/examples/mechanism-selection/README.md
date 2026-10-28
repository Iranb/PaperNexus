# Mechanism selection requests

These are complete synthetic inputs. The intervals are test-oracle values, not research findings.

Create a local corpus with the normal PaperNexus corpus setup. Put `quality.json` and `count.json` at the corpus root. Replace `/absolute/server/path/mechanism-example` in all requests with that server-readable corpus path.

Send `init.json`, `register-hypotheses.json`, then `register-actions.json` with `pn_research_decision.py --request-file FILE --json`. Read `recommend-next.json` and `evidence-view.json` through the same client. Use a fresh project or retain the returned revisions when adapting the example.

The expected recommendation is `execute_action` for E1. Its mechanism test has source-backed proposed paths and two planned count checks. The source and prediction rationale remain explicitly synthetic. The request registers a plan; it launches no job.

For a fully automated local example with temporary fixture setup, run `node scripts/evaluate-mechanism-selection.mjs --output /tmp/pn-mechanism-selection` from the repository root.
