#!/usr/bin/env python3
"""Freeze an exact local Minecraft runtime candidate; never replace a prior run."""
import argparse, datetime, hashlib, json, pathlib, re, shutil
p=argparse.ArgumentParser();p.add_argument('--name',required=True);args=p.parse_args()
assert re.fullmatch(r'[a-zA-Z0-9_-]+',args.name),'Unique filesystem name required'
base=pathlib.Path('.')
source=base/'personal-ai-deskpet-electron-work/electron/minecraft-runtime'
parent=base/'.minecraft-local-test/runtime-candidates';parent.mkdir(parents=True,exist_ok=True)
target=parent/args.name;manifest_file=parent/(args.name+'.manifest.json')
assert not target.exists() and not manifest_file.exists(),'Existing candidates are immutable'
skip={'node_modules','.git','.webpack','out','coverage','.cache','test-results','playwright-report'}
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def scan(folder):
 out={}
 def walk(here):
  for q in sorted(here.iterdir()):
   if q.name in skip:continue
   assert not q.is_symlink(),'Source symlinks must be explicitly reviewed: '+str(q)
   if q.is_dir():walk(q)
   elif q.is_file():out[str(q.relative_to(folder))]=digest(q)
 walk(folder);return out
before=scan(source);target.mkdir()
try:
 for name,sha in before.items():
  q=target/name;q.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source/name,q)
  assert digest(q)==sha,'Source changed during copy: '+name
  q.chmod(0o444)
 assert scan(source)==before,'Editable source changed during freeze'
 (target/'node_modules').symlink_to(source/'node_modules',target_is_directory=True)
 assert scan(target)==before,'Copy content differs'
 value={'schema':1,'status':'FROZEN_CANDIDATE_NOT_WHOLE_ACCEPTED','createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'candidate':str(target),'editableRoot':str(source),'engineSha256':before['vendor/server/minecraftTaskAgent.js'],'files':before,'nodeModulesSymlink':str(source/'node_modules'),'dependencyBoundary':'Installation lock and chosen native plugins must also be checked by each actual runner; dependencies were not copied or modified.'}
 with manifest_file.open('x') as f:json.dump(value,f,ensure_ascii=False,indent=2);f.write('\n')
 print(json.dumps({'candidate':str(target),'manifest':str(manifest_file),'files':len(before),'manifestSha256':digest(manifest_file)}))
except Exception as error:
 with (target/'FREEZE_FAILED.json').open('x') as f:json.dump({'status':'FAILED_NEVER_RUN','error':str(error)},f)
 raise
