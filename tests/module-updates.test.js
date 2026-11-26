import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readlink,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ModuleUpdates,releaseAsset} from '../server/module-updates.js';
const digest='a'.repeat(64);
const release=(version='v99.0.0')=>({tag_name:version,assets:[{name:`mihomo-linux-arm64-${version}.gz`,size:10,digest:'sha256:'+digest,browser_download_url:`https://github.com/MetaCubeX/mihomo/releases/download/${version}/mihomo-linux-arm64-${version}.gz`}]});
async function fixture(run,options={}){const dir=await mkdtemp(join(tmpdir(),'fg-updates-'));try{const manager=new ModuleUpdates({root:join(dir,'modules'),state:join(dir,'state'),platform:'linux',arch:'arm64',fetchImpl:async()=>({ok:true,json:async()=>release()}),...options});await run(manager,dir);}finally{await rm(dir,{recursive:true,force:true});}}
test('release selection rejects prereleases, missing digests, wrong hosts and architectures',()=>{
 assert.equal(releaseAsset('mihomo',release()).version,'v99.0.0');
 for(const mutate of [r=>r.prerelease=true,r=>r.assets[0].digest=null,r=>r.assets[0].browser_download_url='https://evil.example/malware',r=>r.assets[0].name='mihomo-linux-amd64-v99.0.0.gz']){const r=release();mutate(r);assert.throws(()=>releaseAsset('mihomo',r));}
});
test('checks run in the background and enforce one operation, verified candidate and platform',()=>fixture(async m=>{
 m.start('check','mihomo');assert.throws(()=>m.start('check','xray'),/Wait/);await m.task;assert.equal(m.rows.mihomo.state,'available');
 assert.throws(()=>m.start('update','mihomo','v98.0.0'),/updates first/);assert.throws(()=>m.start('update','../../etc','v99.0.0'),/with the application/);
 const restored=new ModuleUpdates({root:m.root,state:m.state});assert.equal(restored.rows.mihomo.candidate.version,'v99.0.0');m.arch='ia32';assert.throws(()=>m.start('update','mihomo','v99.0.0'),/ARM64/);
}));
test('checksum failure never creates an archive or activates a binary',()=>fixture(async(m,dir)=>{
 await assert.rejects(m.download({url:'https://github.com/test',sha256:digest,size:3},join(dir,'archive')),/checksum/);
},{fetchImpl:async()=>({ok:true,body:[Buffer.from('bad')]})}));
test('successful install activates the staged version and records completion',()=>fixture(async(m,dir)=>{
 await mkdir(join(m.root,'mihomo'),{recursive:true});const next=join(dir,'new');await mkdir(next);m.install=async()=>next;let restarted=0;m.restart=async()=>{restarted++;};
 await m.check('mihomo');m.start('update','mihomo','v99.0.0');await m.task;
 assert.equal(await readlink(join(m.root,'mihomo/current')),next);assert.equal(m.rows.mihomo.state,'updated');assert.equal(restarted,1);
}));
test('failed service restart restores the previous symlink',()=>fixture(async(m,dir)=>{
 await mkdir(join(m.root,'mihomo'),{recursive:true});const before=join(dir,'old'),next=join(dir,'new');await mkdir(before);await mkdir(next);await symlink(before,join(m.root,'mihomo/current'));
 m.install=async()=>next;let attempts=0;m.restart=async()=>{if(++attempts===1)throw new Error('fixture start failed');};
 await m.check('mihomo');m.start('update','mihomo','v99.0.0');await m.task;
 assert.equal(await readlink(join(m.root,'mihomo/current')),before);assert.equal(m.rows.mihomo.state,'error');assert.equal(attempts,2);assert.ok(!m.rows.mihomo.error.includes('fixture'));
}));
test('interrupted activation restores the journaled previous target on helper startup',()=>fixture(async(m,dir)=>{
 await mkdir(join(m.root,'mihomo'),{recursive:true});const before=join(dir,'old'),next=join(dir,'new');await symlink(next,join(m.root,'mihomo/current'));
 await m.set('mihomo',{state:'restarting',previous:before});const restored=new ModuleUpdates({root:m.root,state:m.state});await restored.recover();assert.equal(await readlink(join(m.root,'mihomo/current')),before);assert.equal(restored.rows.mihomo.state,'error');
}));

test('verified download writes exactly the expected archive',()=>fixture(async(m,dir)=>{
 const bytes=Buffer.from('verified');m.fetchImpl=async()=>({ok:true,body:[bytes]});
 await m.download({url:'https://github.com/test',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},join(dir,'archive'));
 const {readFile}=await import('node:fs/promises');assert.deepEqual(await readFile(join(dir,'archive')),bytes);
}));
test('failed rollback remains visible and journaled for recovery',()=>fixture(async(m,dir)=>{
 await mkdir(join(m.root,'mihomo'),{recursive:true});await symlink(join(dir,'old'),join(m.root,'mihomo/current'));m.install=async()=>join(dir,'new');m.restart=async()=>{throw new Error('fixture failed');};
 await m.check('mihomo');m.start('update','mihomo','v99.0.0');await m.task;assert.equal(m.rows.mihomo.rollbackPending,true);assert.match(m.rows.mihomo.error,/Could not restore/);assert.ok(m.rows.mihomo.previous);
}));

test('service restart waits for systemd stop job before checking readiness',()=>fixture(async m=>{
 const commands=[];m.execute=async(command,args,options)=>{commands.push({command,args,options});};
 m.fetchImpl=async()=>{throw Error('Public resource transport must not fetch localhost');};
 m.healthFetch=async url=>{assert.equal(url,'http://127.0.0.1/api/health');return {ok:true,json:async()=>({ready:true})};};
 await m.restartService('zapret');
 assert.ok(commands[0].options.timeout>90000);
 assert.deepEqual(commands[1].args,['is-active','--quiet','freedomgate.service']);
}));

 test('x86-64 uses compatible upstream binaries and updates are supported',()=>{
 const r=release();r.assets[0].name='mihomo-linux-amd64-compatible-v99.0.0.gz';r.assets[0].browser_download_url='https://github.com/MetaCubeX/mihomo/releases/download/v99.0.0/'+r.assets[0].name;
 assert.ok(releaseAsset('mihomo',r,'x64').url.includes('amd64-compatible'));
 assert.throws(()=>releaseAsset('mihomo',release(),'x64'),/archive/);
 const m=new ModuleUpdates({platform:'linux',arch:'x64',state:'/nonexistent-fg-test'});assert.ok(m.snapshot().every(row=>row.supported));
 });

test('module staging remains readable under a restrictive helper umask',()=>fixture(async(m,dir)=>{
 const {stat}=await import('node:fs/promises');const previous=process.umask(0o077);
 try{
  m.download=async(_candidate,path)=>writeFile(path,'fixture');m.execute=async()=>{};
  const staged=await m.stage('mihomo',{version:'fixture',sha256:digest});
  for(const path of [m.root,join(m.root,'mihomo'),staged])assert.equal((await stat(path)).mode & 0o777,0o755);
  assert.equal((await stat(join(staged,'manifest.json'))).mode & 0o777,0o644);
 }finally{process.umask(previous);}
}));
test('Tor archive extraction makes nested transport directories traversable under umask 077',async()=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 await promisify(execFile)('python3',['-c',`
import io,os,pathlib,subprocess,sys,tarfile,tempfile
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);archive=root/'bundle.tar.gz';target=root/'staged'
 names=['tor/tor','tor/libcrypto.so.3','tor/libssl.so.3','tor/libevent-2.1.so.7','tor/pluggable_transports/lyrebird','tor/pluggable_transports/pt_config.json','data/geoip','data/geoip6','docs/tor.txt','docs/lyrebird.txt','docs/openssl.txt','docs/libevent.txt','docs/zlib.txt']
 with tarfile.open(archive,'w:gz') as bundle:
  for name in names:
   member=tarfile.TarInfo(name);member.size=7;bundle.addfile(member,io.BytesIO(b'fixture'))
 os.umask(0o077)
 subprocess.run([sys.executable,'scripts/extract-module.py','tor','fixture',str(archive),str(target),'arm64'],check=True)
 for directory in [target,*[p for p in target.rglob('*') if p.is_dir()]]:assert directory.stat().st_mode & 0o777 == 0o755,directory
 for name in names:assert (target/name).stat().st_mode & 0o444 == 0o444,name
 `]);
});

test('release-managed modules cannot be independently checked or updated, including legacy state',()=>fixture(async(m,dir)=>{
 for(const id of ['system','outline','tor','lantern']){assert.throws(()=>m.start('check',id),/with the application/);assert.throws(()=>m.start('update',id,'99'),/with the application/);}
 assert.ok(!m.snapshot().some(row=>['tor','lantern','outline'].includes(row.id)));
 await writeFile(join(m.state,'status.json'),JSON.stringify({tor:{state:'installing',previous:'/old',rollbackPending:true}})).catch(async()=>{await mkdir(m.state,{recursive:true});await writeFile(join(m.state,'status.json'),JSON.stringify({tor:{state:'installing',previous:'/old',rollbackPending:true}}));});
 const restored=new ModuleUpdates({root:m.root,state:m.state});assert.equal(restored.rows.tor,undefined);assert.equal(restored.interrupted.length,0);
}));

test('AdGuard validator can migrate only an isolated copy and rollback restores private readable ownership',()=>fixture(async(m,dir)=>{
 const {readFile,stat,readdir,chmod}=await import('node:fs/promises');const previous=process.env.FREEDOMGATE_STATE_DIR;process.env.FREEDOMGATE_STATE_DIR=join(dir,'state-files');
 try{const folder=join(process.env.FREEDOMGATE_STATE_DIR,'adguard');await mkdir(folder,{recursive:true});const live=join(folder,'AdGuardHome.yaml');await writeFile(live,'original',{mode:0o600});const owner=await stat(live);let checked;
 m.execute=async(_binary,args)=>{checked=args.at(-1);assert.notEqual(checked,live);await writeFile(checked,'migrated');await chmod(checked,0o400);};
 await m.validateConfig('adguard','fixture-binary');assert.equal(await readFile(live,'utf8'),'original');assert.equal((await stat(live)).uid,owner.uid);assert.equal((await stat(live)).mode&0o777,0o600);assert.deepEqual(await readdir(m.state),[]);
 const backup=join(dir,'backup');await writeFile(backup,'restored',{mode:0o400});await writeFile(live,'broken');const {restoreModuleConfig}=await import('../server/module-updates.js');await restoreModuleConfig(backup,live);assert.equal(await readFile(live,'utf8'),'restored');assert.equal((await stat(live)).uid,(await stat(folder)).uid);assert.equal((await stat(live)).mode&0o777,0o600);
 }finally{if(previous===undefined)delete process.env.FREEDOMGATE_STATE_DIR;else process.env.FREEDOMGATE_STATE_DIR=previous;}
}));
test('module archive validation uses the shared download fallback before installation',async()=>{
 const {createResourceFetch}=await import('../server/resource-fetch.js');const bytes=Buffer.from('verified archive'),paths=[];
 const fetchImpl=createResourceFetch({gateways:()=>[{id:'working',port:28001,secret:'a'.repeat(64)}],request:async(url,{gateway})=>{paths.push(gateway?.id || 'direct');return {status:200,headers:new Headers(),body:gateway?bytes:Buffer.from('blocked HTTP 200')};}});
 await fixture(async(manager,dir)=>{const path=join(dir,'download');await manager.download({url:'https://github.com/fixture/archive',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},path);const {readFile}=await import('node:fs/promises');assert.deepEqual(await readFile(path),bytes);assert.deepEqual(paths,['direct','working']);},{fetchImpl});
});
