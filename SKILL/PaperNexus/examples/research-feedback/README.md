# Project feedback requests

Send `evidence-view.json` to `research_decision` with `pn_research_decision.py --request-file`. Send `evaluate-mechanism.json` to `idea_generation`. Replace corpus with the registered corpus name or server-local root produced by the replay.

For complete init/register/record/assess requests with measured source artifacts, run `scripts/evaluate-research-feedback.mjs`; its output contains `requests.json`, manifests and an isolated corpus. The local request file and server-local artifact paths have separate roles.
