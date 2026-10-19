"""One-shot deployment of the already tested debug70 bot patch; no server control."""
import hashlib
import json
import os
from pathlib import Path
import time

base = Path(__file__).resolve().parents[1]
world = base / 'worlds/cottage-development-from57'
control = world / 'development-control.json'
checkpoint = world / 'development-checkpoint.json'
console = base / 'evidence/estate-20261013/cottage-development-debug70-console.log'
runtime = base.parent / 'personal-ai-deskpet-electron-work/electron/minecraft-runtime'
paths = [runtime / p for p in ['vendor/server/minecraftTaskAgent.js',
    'vendor/server/minecraft/houseResourceReach.js', 'vendor/server/minecraft/houseResourceSight.js']]
digest = lambda: [hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]
expected = digest()
deadline = time.monotonic() + 900
print('Waiting once for debug70 camp arrival; control44 -> control45; server and observer retained', flush=True)
while time.monotonic() < deadline:
    command = json.loads(control.read_text())
    if command.get('session') != 'debug70' or command.get('seq') != 44 or digest() != expected:
        raise SystemExit('Cancelled: source or control changed; no reload issued')
    snapshot = json.loads(console.read_text().splitlines()[-1])
    state = json.loads(checkpoint.read_text())
    task = state.get('task', {})
    camp = task.get('materialSupply', {}).get('camp', {}).get('anchor')
    p = snapshot.get('position', {})
    if (state.get('session') == 'debug70' and task.get('taskId') == 'task-1'
        and camp and snapshot.get('health', 0) > 0
        and snapshot.get('status') in ('running', 'paused')
        and abs(p.get('y', -1000) - camp['y']) < .05
        and (p['x'] - camp['x']) ** 2 + (p['z'] - camp['z']) ** 2 <= 4):
        tmp = control.with_suffix('.camp-reload-tmp')
        tmp.write_text(json.dumps({'session': 'debug70', 'seq': 45, 'action': 'reload'}))
        os.replace(tmp, control)
        print(json.dumps({'issued': True, 'control': 45, 'actualSnapshot': snapshot}), flush=True)
        break
    time.sleep(2)
else:
    raise SystemExit('Timed out after15m; no reload issued')
