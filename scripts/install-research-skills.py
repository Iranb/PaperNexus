#!/usr/bin/env python3
"""Install the research skill bundle; dry-run by default, back up before applying."""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
MAPPING = {'PaperNexus': 'papernexus', 'PaperNexusMaintenance': 'papernexus-ingest-maintain',
           'PaperNexusReflection': 'papernexus-reflection'}
CLIENTS = ['autoreskill-literature-review', 'autoreskill-papernexus-innovation',
           'autoreskill-papernexus-research-controller']
BEGIN = '<!-- papernexus-shared-contract:start -->'
END = '<!-- papernexus-shared-contract:end -->'
BLOCK = f'''{BEGIN}
## PaperNexus shared contract

Read [the shared adapter](../papernexus/references/autoresearch-adapter.md) and
[proposal action contract](../papernexus/references/advanced.md). Retain existing
project evidence gates. Before proposal_graph_session, construct actions/slates;
problem/evidenceRefs alone returns needs_actions. Empty slates do not generate ideas.
Use server outputDir paths and explicitly transfer artifacts to local project paths.
Reuse source/version evidence and select one generator; do not bypass independent review.
{END}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, default=Path.home()/'.codex/skills')
    parser.add_argument('--backup-dir', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.apply and not args.backup_dir:
        parser.error('--apply requires a new --backup-dir')
    tracked = subprocess.check_output(['git', '-C', str(ROOT), 'ls-files', 'SKILL'], text=True).splitlines()
    desired = {}
    for rel in tracked:
        parts = Path(rel).parts
        if len(parts) < 3 or parts[1] not in MAPPING:
            continue
        dest = args.destination / MAPPING[parts[1]] / Path(*parts[2:])
        raw = (ROOT/rel).read_bytes()
        if dest.suffix == '.md':
            text = raw.decode()
            for old, new in MAPPING.items():
                text = text.replace('../'+old+'/', '../'+new+'/')
            text = text.replace('`SKILL/PaperNexus/scripts`', '`scripts/` (relative to the installed papernexus skill)')
            raw = text.encode()
        desired[dest] = raw
    for name in CLIENTS:
        dest = args.destination/name/'SKILL.md'
        if not dest.exists():
            continue  # Never fabricate an absent AutoResearch installation.
        text = dest.read_text()
        pattern = re.escape(BEGIN)+r'.*?'+re.escape(END)+r'\n?'
        text = re.sub(pattern, '', text, flags=re.S).rstrip()+'\n\n'+BLOCK
        desired[dest] = text.encode()
    changed = {p:raw for p,raw in desired.items() if not p.exists() or p.read_bytes()!=raw}
    print(json.dumps({'apply': args.apply, 'changed_files': [str(p) for p in changed]}, indent=2))
    if not args.apply or not changed:
        return
    backup = args.backup_dir.resolve()
    backup.mkdir(parents=True, exist_ok=False)
    records = []
    for dest in changed:
        rel = dest.relative_to(args.destination)
        records.append({'path': str(rel), 'existed': dest.exists()})
        if dest.exists():
            (backup/rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dest, backup/rel)
    (backup/'manifest.json').write_text(json.dumps(records, indent=2))
    for dest, raw in changed.items():
        dest.parent.mkdir(parents=True, exist_ok=True)
        temp = dest.with_name(dest.name+'.install-tmp')
        temp.write_bytes(raw)
        temp.replace(dest)


if __name__ == '__main__':
    main()
