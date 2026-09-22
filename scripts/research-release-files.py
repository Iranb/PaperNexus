#!/usr/bin/env python3
"""Preview/apply/rollback a PaperNexus application file release without restarting it."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

SCOPES = ('src', 'web', 'SKILL', 'docs/operations', 'docs/interfaces')


def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None


def safe_path(root, rel):
    candidate = root / rel
    if Path(rel).is_absolute() or '..' in Path(rel).parts or not candidate.resolve().is_relative_to(root.resolve()):
        raise ValueError('Unsafe release path: '+rel)
    return candidate


def replace(source, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp = dest.with_name(dest.name+'.release-tmp')
    shutil.copy2(source, temp)
    temp.replace(dest)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('operation', choices=['preview', 'apply', 'rollback'])
    p.add_argument('--stage', type=Path)
    p.add_argument('--app', type=Path, required=True)
    p.add_argument('--backup', type=Path)
    a = p.parse_args()
    if a.operation == 'rollback':
        if not a.backup:
            p.error('rollback requires --backup')
        entries = json.loads((a.backup/'manifest.json').read_text())
        # Validate the entire restore before any mutation. Accept an interrupted apply.
        for e in entries:
            target = safe_path(a.app,e['path'])
            if digest(target) not in (e['before'], e['after']):
                raise ValueError('Changed since deployment: '+e['path'])
            if e['before'] and digest(safe_path(a.backup/'files',e['path'])) != e['before']:
                raise ValueError('Invalid backup: '+e['path'])
        for e in entries:
            target = safe_path(a.app,e['path'])
            if e['before']:
                replace(safe_path(a.backup/'files',e['path']),target)
            elif target.exists():
                target.unlink()
        print(json.dumps({'restored_files':len(entries)}))
        return
    if not a.stage or not (a.stage/'package.json').is_file():
        p.error('preview/apply requires a staged application with package.json')
    paths = [p for scope in SCOPES for p in (a.stage/scope).rglob('*') if p.is_file()]
    paths += [a.stage/'package.json', a.stage/'package-lock.json']
    entries = []
    for source in sorted(paths):
        rel = source.relative_to(a.stage).as_posix()
        source = safe_path(a.stage,rel)
        target = safe_path(a.app,rel)
        before, after = digest(target), digest(source)
        if after is None:
            raise ValueError('Missing staged file: '+rel)
        if before != after:
            entries.append({'path':rel,'before':before,'after':after})
    print(json.dumps({'operation':a.operation,'changed_files':entries},indent=2))
    if a.operation == 'preview' or not entries:
        return
    if not a.backup:
        p.error('apply requires a fresh --backup directory')
    a.backup.mkdir(parents=True,exist_ok=False)
    for e in entries:
        if e['before']:
            replace(safe_path(a.app,e['path']),safe_path(a.backup/'files',e['path']))
    # Write the recovery journal before touching application files.
    (a.backup/'manifest.json').write_text(json.dumps(entries,indent=2))
    for e in entries:
        source = safe_path(a.stage,e['path'])
        target = safe_path(a.app,e['path'])
        if digest(source)!=e['after'] or digest(target)!=e['before']:
            raise ValueError('File changed during deployment: '+e['path'])
        replace(source,target)
        if digest(target)!=e['after']:
            raise ValueError('Deployment checksum mismatch: '+e['path'])


if __name__ == '__main__':
    main()
