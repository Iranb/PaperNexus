---
name: papernexus-batch-import
description: Compatibility entry for PaperNexusBatchImport; delegates to the canonical PaperNexus research or maintenance workflow.
---

# PaperNexusBatchImport compatibility entry

Read [the canonical workflow](../PaperNexusMaintenance/SKILL.md) for this task. For research routing start with [PaperNexus Research](../PaperNexus/SKILL.md); do not load unrelated stages.

Existing skill names and scripts remain supported. Shared remote/auth/path/timeout rules are maintained in [one contract](../PaperNexus/references/remote-contract.md). Canonical script implementations live in `SKILL/PaperNexus/scripts`; preserve existing specialized wrappers instead of copying protocol logic.
