import test from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {realpathSync,mkdtempSync,mkdirSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
test('release bundle verification is offline, architecture-specific and rejects incomplete or changed binaries',()=>{execFileSync('python3',['tests/test_release_bundles.py'],{stdio:'pipe'});});
test('module versions follow the application release and ignore independently installed Tor/Lantern',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fg-release-path-'));try{
  for(const [name,version] of [['old','1.0.0'],['new','2.0.0']]){
   const root=join(dir,name);mkdirSync(join(root,'server'),{recursive:true});mkdirSync(join(root,'packaging'));writeFileSync(join(root,'package.json'),'{"type":"module"}');
   for(const file of ['release-modules.js','module-paths.js'])copyFileSync('server/'+file,join(root,'server',file));
   for(const id of ['tor','lantern'])writeFileSync(join(root,'packaging',id+'.lock.json'),JSON.stringify({version}));
   const {releaseModule}=await import(pathToFileURL(join(root,'server/release-modules.js')));const module=releaseModule('tor');assert.equal(module.version,version);assert.ok(module.root.startsWith(realpathSync(root)));mkdirSync(module.root,{recursive:true});writeFileSync(join(module.root,'manifest.json'),JSON.stringify({version}));
   const {installedModuleVersions}=await import(pathToFileURL(join(root,'server/module-paths.js')));assert.equal(installedModuleVersions({}).tor,version);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
