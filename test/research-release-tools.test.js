import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const script = path.resolve('scripts/research-release-files.py');
async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pn-release-tools-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;
}
async function put(file,text) {await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);}

test('release preview, backup, apply and rollback preserve unrelated state and refuse drift',async t=>{
 const root=await fixture(t);const stage=path.join(root,'stage'),app=path.join(root,'app'),backup=path.join(root,'backup');
 for(const dir of [stage,app]) {await put(path.join(dir,'package.json'),'{}');await put(path.join(dir,'package-lock.json'),'{}');}
 await put(path.join(app,'src/main.js'),'old');await put(path.join(stage,'src/main.js'),'new');
 await put(path.join(stage,'src/added.js'),'added');await put(path.join(app,'config.json'),'private');
 const run=(operation)=>exec('python3',[script,operation,'--app',app,'--stage',stage,'--backup',backup]);
 await run('preview');assert.equal(await fs.readFile(path.join(app,'src/main.js'),'utf8'),'old');
 await run('apply');assert.equal(await fs.readFile(path.join(app,'src/main.js'),'utf8'),'new');
 await put(path.join(app,'src/main.js'),'later user edit');
 await assert.rejects(run('rollback'),/Changed since deployment/);
 assert.equal(await fs.readFile(path.join(app,'src/added.js'),'utf8'),'added');
 await put(path.join(app,'src/main.js'),'new');await run('rollback');
 assert.equal(await fs.readFile(path.join(app,'src/main.js'),'utf8'),'old');
 await assert.rejects(fs.access(path.join(app,'src/added.js')));
 assert.equal(await fs.readFile(path.join(app,'config.json'),'utf8'),'private');
});

test('release rejects paths escaping the application via symlinks',async t=>{
 const root=await fixture(t);const stage=path.join(root,'stage'),app=path.join(root,'app'),outside=path.join(root,'outside');
 await put(path.join(stage,'package.json'),'{}');await put(path.join(stage,'package-lock.json'),'{}');await put(path.join(stage,'src/file.js'),'new');
 await fs.mkdir(app);await fs.mkdir(outside);await fs.symlink(outside,path.join(app,'src'));
 await assert.rejects(exec('python3',[script,'preview','--stage',stage,'--app',app]),/Unsafe release path/);
 assert.deepEqual(await fs.readdir(outside),[]);
});

test('skill installation previews, preserves client gates, resolves sibling links and is idempotent',async t=>{
 const root=await fixture(t);const dest=path.join(root,'skills'),backup=path.join(root,'backup');
 await put(path.join(dest,'autoreskill-papernexus-innovation/SKILL.md'),'# Existing skill\nStrict original scientific gates.\n');
 const args=[path.resolve('scripts/install-research-skills.py'),'--destination',dest];
 await exec('python3',args);await assert.rejects(fs.access(path.join(dest,'papernexus/SKILL.md')));
 await exec('python3',[...args,'--apply','--backup-dir',backup]);
 const client=await fs.readFile(path.join(dest,'autoreskill-papernexus-innovation/SKILL.md'),'utf8');
 assert.match(client,/Strict original scientific gates/);assert.match(client,/needs_actions/);
 const again=JSON.parse((await exec('python3',args)).stdout);assert.deepEqual(again.changed_files,[]);
 for(const name of ['papernexus','papernexus-ingest-maintain','papernexus-reflection']) {
  const file=path.join(dest,name,'SKILL.md');const text=await fs.readFile(file,'utf8');
  for(const link of text.matchAll(/\]\(([^)]+)\)/g)) await fs.access(path.resolve(path.dirname(file),link[1]));
 }
 await exec('python3',[path.join(dest,'papernexus/scripts/pn_import_queue.py'),'--help']);
});
