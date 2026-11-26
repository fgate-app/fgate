import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SystemUpdates,sourceCommit} from '../server/system-updates.js';
const commit='a'.repeat(40);
async function fixture(run){const state=await mkdtemp(join(tmpdir(),'fg-system-'));try{const manager=new SystemUpdates({state,release:join(state,'release'),supported:true,minimumFreeBytes:0,fetchImpl:async()=>new Response(JSON.stringify({sha:commit})),execute:async()=>{}});await run(manager);}finally{await rm(state,{recursive:true,force:true});}}
test('system update pins the official commit and compares the installed manifest',()=>fixture(async m=>{
 const calls=[];m.fetchImpl=async(url,options)=>{calls.push(url);options.validate(Buffer.from(JSON.stringify({sha:commit})));return new Response(JSON.stringify({sha:commit}));};
 m.start('check');assert.throws(()=>m.start('check'),/Wait/);await m.task;assert.equal(m.snapshot().state,'available');assert.equal(m.snapshot().candidate.commit,commit);assert.equal(calls[0],'https://api.github.com/repos/fgate-app/fgate/commits/main');
 await mkdir(m.release);await writeFile(join(m.release,'system-release.json'),JSON.stringify({commit}));await m.check();assert.equal(m.snapshot().state,'current');assert.equal(m.snapshot().current,commit.slice(0,7));
}));
test('system update rejects unsupported deployments, malformed revisions and stale selections',()=>fixture(async m=>{
 for(const value of ['main','../other','a'.repeat(39),null])assert.throws(()=>sourceCommit(value),/revision/);
 assert.throws(()=>m.start('delete'),/operation/);assert.throws(()=>m.start('update',commit),/first/);
 await m.check();assert.throws(()=>m.start('update','b'.repeat(40)),/first/);m.supported=false;assert.throws(()=>m.start('check'),/native/);
}));
test('system update extracts before launching an independent worker and persists its running state',()=>fixture(async m=>{
 await m.check();const calls=[];m.fetchImpl=async url=>{assert.equal(url,'https://codeload.github.com/fgate-app/fgate/tar.gz/'+commit);return new Response('archive');};m.execute=async(command,args)=>{calls.push({command,args});};
 m.start('update',commit);await m.task;assert.equal(m.snapshot().state,'installing');assert.equal(m.busy,true);assert.equal(calls[0].command,'python3');assert.equal(calls[1].command,'systemd-run');assert.ok(calls[1].args.includes('--unit=freedomgate-update'));assert.throws(()=>m.start('check'),/Wait/);
 const restored=new SystemUpdates({state:m.state,release:m.release,supported:true,execute:async()=>{}});await restored.recover();assert.equal(restored.snapshot().state,'installing');
 restored.execute=async()=>{throw Error();};await restored.recover();assert.equal(restored.snapshot().state,'error');
}));
test('invalid archive or download never launches installer and preserves a visible failure',()=>fixture(async m=>{
 await m.check();m.fetchImpl=async()=>new Response('bad');m.execute=async(command)=>{assert.equal(command,'python3');throw Error('fixture');};m.start('update',commit);await m.task;assert.equal(m.snapshot().state,'error');assert.equal(m.snapshot().error.includes('fixture'),false);assert.equal(m.busy,false);
}));
test('system source extraction rejects links and traversal',async()=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 await promisify(execFile)('python3',['-c',`
import io,pathlib,subprocess,tarfile,tempfile,sys
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp)
 for i,(name,link) in enumerate([('fgate-${commit}/../escape',False),('fgate-${commit}/link',True)]):
  archive=root/(str(i)+'.tgz')
  with tarfile.open(archive,'w:gz') as out:
   member=tarfile.TarInfo(name)
   if link:member.type=tarfile.SYMTYPE;member.linkname='/etc'
   out.addfile(member,io.BytesIO())
  result=subprocess.run([sys.executable,'scripts/extract-system.py',str(archive),str(root/('out'+str(i))),'${commit}'],capture_output=True)
  assert result.returncode!=0
 assert not (root/'escape').exists()
 `]);
});

test('independent system job records success and restores on failed post-install readiness',async()=>{
 const {runSystemUpdate}=await import('../server/system-update-job.js');
 for(const ready of [true,false])await fixture(async m=>{
  const work=join(m.state,'system-work-fixture'),backup=join(m.state,'backup');await mkdir(join(work,'source'),{recursive:true});await mkdir(backup);await mkdir(m.release);
  await writeFile(join(work,'job.json'),JSON.stringify({commit}));await m.set({state:'installing'});const commands=[];
  await runSystemUpdate({work,prepare:false,release:m.release,execute:async(command,args)=>{commands.push([command,...args]);return {stdout:args.includes('snapshot')?backup:'installer output',stderr:''};},healthFetch:async()=>new Response(JSON.stringify({ready}))});
  assert.equal(m.snapshot().state,ready?'updated':'error');assert.equal(commands.some(args=>args.includes('restore')),!ready);if(ready)assert.equal(m.snapshot().current,commit.slice(0,7));
 });
});

test('module reuse checks source inputs, version, architecture and binary integrity',async()=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');const result=await promisify(execFile)('python3',['-m','unittest','discover','-s','tests','-p','test_module_reuse.py']);assert.match(result.stderr,/OK/);
});
test('installer progress accepts only fixed stages and changes stage percentages',async()=>{
 const {installerProgress}=await import('../server/system-update-progress.js');let previous=0;
 for(const stage of ['dependencies','runtime','reuse','tor','lantern','outline','backup','web','frp','modules','package','activate','restart','health']){const row=installerProgress('FG_UPDATE_STAGE '+stage);assert.ok(row.progress>previous);previous=row.progress;}
 assert.equal(installerProgress('secret arbitrary log'),null);assert.equal(installerProgress('FG_UPDATE_STAGE injected'),null);
});
test('resource downloader can prohibit every direct attempt',async()=>{
 const {createResourceFetch}=await import('../server/resource-fetch.js');const paths=[];const gateway={id:'known',port:28001,secret:'a'.repeat(20)};
 const get=createResourceFetch({gateways:()=>[gateway],allowDirect:false,request:async(_url,{gateway})=>{paths.push(gateway?.id);return {status:200,headers:new Headers(),body:Buffer.from('ok')};}});await get('https://example.com/');assert.deepEqual(paths,['known']);
 await assert.rejects(createResourceFetch({allowDirect:false})('https://example.com/'),/unavailable/);
});
