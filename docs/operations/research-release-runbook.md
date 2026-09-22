# Research release handoff

This runbook uses the deployed service owner's existing SSH access, Node runtime,
authentication configuration and startup script. No secrets belong in a release archive.
Run repository commands from its root. Replace placeholders before execution.

## Install the skills reproducibly

    python3 scripts/install-research-skills.py --destination "$HOME/.codex/skills"
    python3 scripts/install-research-skills.py --destination "$HOME/.codex/skills" --apply --backup-dir /absolute/new/skill-backup

The first command previews changes. The second copies only tracked canonical research,
maintenance and reflection files, rewrites installed sibling links, and adds a managed
adapter section to already-installed AutoResearch literature/innovation/controller skills.
Existing scientific gates and other skill content remain intact. Repeating installation
with unchanged input is a no-op. A missing AutoResearch installation is not created.
Old repository skill names and wrapper paths remain supported in the checkout.
For installed wrappers use the absolute `<skills>/papernexus/scripts/<script>.py` path.

Restore overwritten files from the backup paths listed in manifest.json. Remove only
entries with existed=false that still belong to this installation; do not replace an
entire skills directory or remove later user changes. Keep the backup until acceptance.

## Build and stage a release

Record `git rev-parse HEAD`, `git status --short`, the deployment target, service script,
active process, corpus path and raw graph hash. Do not include unrelated working changes.
For a committed release, prepare an application archive locally:

    git archive --format=tar HEAD src web SKILL package.json package-lock.json docs/operations docs/interfaces test scripts/research-release-files.py scripts/install-research-skills.py > /tmp/papernexus-release.tar
    shasum -a 256 /tmp/papernexus-release.tar
    scp /tmp/papernexus-release.tar <ssh-target>:<new-staging-dir>/release.tar

On the server create a new staging directory first. Extract the archive there, link its
node_modules to the current application's dependencies, and use the deployed Node runtime.
Do not run npm install or change configuration when dependencies are unchanged.

    tar -xf release.tar
    ln -s <application-dir>/node_modules node_modules
    <node> --test test/material-quality-admission.test.js test/proposal-controller.test.js test/research-pipeline-contract.test.js test/agent-materials-tool.test.js test/research-quality.test.js

Expected: zero failures. This exercises synthetic temporary corpora and does not import
papers, invoke models or change the production graph. Compare staged and deployed paths
before copying. Investigate unknown deployment drift; do not overwrite it silently.

## Backup, apply and restore

Use `scripts/research-release-files.py` on the server. It does not restart services.
Preview first; apply requires a fresh backup directory:

    python3 scripts/research-release-files.py preview --stage <staging-dir> --app <application-dir>
    python3 scripts/research-release-files.py apply --stage <staging-dir> --app <application-dir> --backup <new-backup-dir>

The script includes only src/web/SKILL/package and the shipped operations/interface docs;
excludes tests, config, node_modules and all corpus files; backs up overwritten files and
records newly added files; checks source and target hashes. Existing extra files remain.
Run the existing service startup script once, then verify service health and MCP calls.
On failure, restore only the changed paths and restart with the same service script:

    python3 scripts/research-release-files.py rollback --app <application-dir> --backup <backup-dir>

Rollback refuses files changed since deployment. Resolve any conflict by inspection,
not by force. After interruption inspect manifest.json and current hashes before retrying.
Do not retry service starts, import submissions or paid discovery blindly.

## Acceptance on the real HTTP MCP

Use the configured authenticated client or canonical pn_common.py transport; never print
tokens. Save request parameters and sanitized response assertions with the release SHA:

- tools/list advertises literature_review, lineage_analysis, idea_generation by default.
- literature_review/capabilities reports full/summary and caller_supplied_actions.
- literature_review/paper: known-good paper has source text; known-quarantined record has
  status=quarantined, eligible=false, no source text/context, and admission reasons.
- For a version alias, paper.identifiers describe the canonical record;
  paper.selected_source describes the actual read version. Abstract/source/context agree.
- agent_materials/proposal_graph_session with problem and empty actions/slates returns
  needs_actions, round_count=0, graph and validation_report; outputDir is not written.
- idea_generation/evaluate with a concrete candidate and responseMode=summary stays within
  32768 bytes for the workflow JSON envelope. Read full gates; omission is never approval.
- Existing agent_materials/paper_material_view still works. Browser login, session and
  /api/health pass using the existing account, without saving cookies in the release receipt.
- Raw graph SHA256 is unchanged; deployment hashes match staged files and committed source.

Retain the release SHA, archive hash, manifest/backup path, assertions and test counts.
These engineering checks do not establish a scientific novelty or performance claim.
