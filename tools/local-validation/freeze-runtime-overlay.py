#!/usr/bin/env python3
"""Freeze a reviewed small patch on an exact earlier candidate, excluding concurrent drafts."""
import argparse, datetime, hashlib, json, pathlib, re, shutil

p = argparse.ArgumentParser()
p.add_argument('--base-manifest', required=True)
p.add_argument('--name', required=True)
p.add_argument('--overlay', nargs='+', required=True)
a = p.parse_args()
assert re.fullmatch(r'[a-zA-Z0-9_-]+', a.name)
workspace = pathlib.Path('.')
editable = workspace / 'personal-ai-deskpet-electron-work/electron/minecraft-runtime'
parent = workspace / '.minecraft-local-test/runtime-candidates'
manifest_path = parent / (a.name + '.manifest.json')
target = parent / a.name
assert not target.exists() and not manifest_path.exists(), 'Earlier candidates must never be overwritten'
base_file = pathlib.Path(a.base_manifest)
base = json.loads(base_file.read_text())
origin = pathlib.Path(base['candidate'])
def sha(q):
    return hashlib.sha256(q.read_bytes()).hexdigest()
for name, expected in base['files'].items():
    assert sha(origin / name) == expected, 'Earlier candidate changed: ' + name
overlays = {}
for name in a.overlay:
    q = pathlib.PurePosixPath(name)
    assert not q.is_absolute() and '..' not in q.parts and q.parts[0] != 'node_modules'
    assert (editable / name).is_file() and not (editable / name).is_symlink()
    overlays[name] = sha(editable / name)
target.mkdir()
try:
    for name in sorted(set(base['files']) | set(overlays)):
        source = editable / name if name in overlays else origin / name
        expected = overlays.get(name, base['files'].get(name))
        out = target / name
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, out)
        assert sha(out) == expected and sha(source) == expected, 'Source changed during freeze: ' + name
        out.chmod(0o444)
    assert all(sha(editable / name) == expected for name, expected in overlays.items())
    files = {**base['files'], **overlays}
    (target / 'node_modules').symlink_to(editable / 'node_modules', target_is_directory=True)
    report = {'schema': 1, 'status': 'FROZEN_CANDIDATE_NOT_WHOLE_ACCEPTED',
        'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'candidate': str(target),
        'editableRoot': str(editable), 'engineSha256': files['vendor/server/minecraftTaskAgent.js'],
        'files': files, 'basedOn': {'manifest': str(base_file), 'sha256': sha(base_file)},
        'reviewedEditableOverlays': overlays, 'nodeModulesSymlink': str(editable / 'node_modules'),
        'scope': 'Only explicit reviewed overlays; concurrent drafts are excluded. Whole acceptance is separate.'}
    with manifest_path.open('x') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(json.dumps({'candidate': str(target), 'manifest': str(manifest_path),
        'manifestSha256': sha(manifest_path), 'files': len(files), 'overlays': len(overlays)}))
except Exception as error:
    with (target / 'FREEZE_FAILED.json').open('x') as f:
        json.dump({'status': 'FAILED_NEVER_RUN', 'error': str(error)}, f)
    raise
