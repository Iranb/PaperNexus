# Engineering Release Evidence

`papernexus-engineering-release-evidence-v1` captures the local engineering tests explicitly required by the deep-research release definition.

## Command

```bash
npm run eval:engineering-release-evidence -- \
  --output-dir artifacts/engineering-release-evidence/run-001 \
  --run-id engineering-run-001 \
  --require-passed
```

By default the command runs:

```json
[
  "test/mcp.test.js",
  "test/mcp-http.test.js",
  "test/pipeline-invariants.test.js",
  "test/engineering-control-acceptance.test.js"
]
```

Outputs:

- `engineering-release-evidence.json`
- `engineering-release-evidence.md`
- `manifest.json`

The report records each test command, exit status, duration, Node version, and SHA-256 hashes for the required test files. It is marked `passed` only when every required test ran successfully and every required test file has an input hash.

Pass the full report to the release gate:

```bash
npm run eval:idea-catalyst-release-gate -- \
  --output-dir artifacts/idea-catalyst-release-gate/run-001 \
  --engineering-evidence artifacts/engineering-release-evidence/run-001/engineering-release-evidence.json
```

This evidence covers only the named engineering test requirement. It does not replace external benchmark evidence, human blind labels, graph reasoning evidence, graph link-prediction evidence, or structural ablations.
