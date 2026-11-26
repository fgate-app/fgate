import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const lock=JSON.parse(readFileSync(new URL('../packaging/modules.lock.json',import.meta.url)));

test('every binary module has pinned assets for ARM64 and x86-64',()=>{
 for(const m of lock.modules)for(const arch of ['linux-arm64','linux-amd64']){
  assert.match(m.platforms[arch].sha256,/^[a-f0-9]{64}$/);assert.ok(m.platforms[arch].asset);
 }
 const runtimes=JSON.parse(readFileSync(new URL('../packaging/runtime.lock.json',import.meta.url)));
 for(const runtime of Object.values(runtimes))for(const arch of ['linux-arm64','linux-amd64']){
  assert.match(runtime.platforms[arch].url,/^https:\/\/(nodejs.org|go.dev)\//);assert.match(runtime.platforms[arch].sha256,/^[a-f0-9]{64}$/);
 }
 assert.match(lock.sourceModules.find(m=>m.id==='zapret2').sourceSha256,/^[a-f0-9]{64}$/);
});

test('architecture aliases are explicit and unsupported targets fail before mutation',()=>{
 for(const [name,expected] of [['aarch64','arm64'],['arm64','arm64'],['x86_64','amd64'],['amd64','amd64'],['armv7l',null],['riscv64',null]]){
  const result=spawnSync('sh',['-c','. scripts/platform-support.sh; platform_arch "$1"','fixture',name],{encoding:'utf8'});assert.equal(result.status,expected?0:1,result.stderr);if(expected)assert.equal(result.stdout.trim(),expected);
 }
});

test('native unit has portable Host validation and preserves an external environment file',()=>{
 const unit=readFileSync(new URL('../packaging/systemd/freedomgate.service',import.meta.url),'utf8');
 assert.ok(!unit.includes('192.168.'));assert.match(unit,/EnvironmentFile=-\/etc\/freedomgate\/freedomgate.env/);
 const installer=readFileSync(new URL('../scripts/install.sh',import.meta.url),'utf8');
 assert.ok(!installer.includes('rm -f /etc/systemd/system'));
});

test('only the unprivileged web unit manages ownership of shared SQLite state',()=>{
 const web=readFileSync(new URL('../packaging/systemd/freedomgate.service',import.meta.url),'utf8');
 const helper=readFileSync(new URL('../packaging/systemd/freedomgate-network.service',import.meta.url),'utf8');
 assert.match(web,/^User=freedomgate$/m);
 assert.match(web,/^StateDirectory=freedomgate$/m);
 assert.match(web,/^StateDirectoryMode=0700$/m);
 assert.doesNotMatch(helper,/^StateDirectory=/m);
 assert.match(helper,/^ReadWritePaths=.*\/var\/lib\/freedomgate/m);
});

test('native platform matrix rejects unsupported releases and 32-bit userspace before installation',()=>{
 for(const [id,version,bits,arch,accepted] of [['debian','13','64','arm64',true],['debian','13','64','amd64',true],['ubuntu','24.04','64','amd64',true],['ubuntu','26.04','64','arm64',true],['raspbian','13','64','arm64',true],['debian','12','64','arm64',false],['ubuntu','22.04','64','amd64',false],['ubuntu','24.10','64','amd64',false],['fedora','43','64','amd64',false],['debian','13','32','arm64',false],['raspbian','13','64','amd64',false]]){
  const result=spawnSync('sh',['-c','. scripts/platform-support.sh; native_platform "$1" "$2" "$3" "$4"','fixture',id,version,bits,arch],{encoding:'utf8'});assert.equal(result.status,accepted?0:1,result.stderr);
 }
 const result=spawnSync('sh',['-n','scripts/install.sh'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
test('installer rollback and permission fixtures execute without touching host services',()=>{
 const result=spawnSync('python3',['-m','unittest','discover','-s','tests','-p','test_installation.py'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/OK/);
});

test('container compatibility rejects Desktop, rootless, remote, cgroup v1 and mismatched architectures',()=>{
 const base=['linux','Debian GNU/Linux','aarch64','2','["name=seccomp"]','unix:///var/run/docker.sock','arm64'];
 for(const change of [null,{0:'windows'},{1:'Docker Desktop'},{4:'["name=rootless"]'},{5:'ssh://remote'},{5:'tcp://127.0.0.1:2375'},{3:'1'},{2:'x86_64'},{2:'armv7l'}]){
  const values=base.map((value,index)=>change?.[index] ?? value),result=spawnSync('sh',['-c','. scripts/platform-support.sh; container_platform "$1" "$2" "$3" "$4" "$5" "$6" "$7"','fixture',...values],{encoding:'utf8'});assert.equal(result.status,change?1:0,result.stderr);
 }
});

test('Compose baseline rejects old versions before build or up',()=>{
 for(const [version,accepted] of [['v2.19.1',false],['2.20.0',true],['v5.8.0',true],['1.29.2',false],['invalid',false]]){
  const result=spawnSync('sh',['-c','. scripts/platform-support.sh; compose_platform "$1"','fixture',version],{encoding:'utf8'});assert.equal(result.status,accepted?0:1,result.stderr);
 }
});

test('managed HTTP readiness uses actual service port and requires both runtime health and admin API',async()=>{
 const {managedHttpAddress,installHealth}=await import('../scripts/install-health.mjs');const calls=[];
 const address=managedHttpAddress({run:(_binary,args)=>{calls.push(args);return args[0]==='show'?'1234\n':'';},read:path=>{assert.equal(path,'/proc/1234/environ');return 'PORT=8088\0HOST=::\0IGNORED=$(do-not-execute)\0';}});
 assert.equal(address,'http://[::1]:8088');assert.equal(calls.length,3);
 assert.equal(await installHealth({address:()=>address,fetchImpl:async url=>({ok:true,json:async()=>url.endsWith('/api/health')?{ready:true}:{setupRequired:false}})}),true);
 let requests=0;assert.equal(await installHealth({address:()=>address,fetchImpl:async()=>{requests++;return {ok:true,json:async()=>({ready:false})};}}),false);assert.equal(requests,1);
 assert.equal(await installHealth({address:()=>address,fetchImpl:async url=>({ok:url.endsWith('/api/health'),json:async()=>({ready:true})})}),false);
 assert.throws(()=>managedHttpAddress({run:()=> '0',read:()=>''}),/not running/);
 assert.throws(()=>managedHttpAddress({run:()=> '1234',read:()=> 'PORT=abc\0'}),/port/);
 const {createServer}=await import('node:http');let ready=false;
 const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/api/health'?{ready}:{setupRequired:true}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const address=()=>`http://127.0.0.1:${server.address().port}`;assert.equal(await installHealth({address}),false);ready=true;assert.equal(await installHealth({address}),true);}finally{await new Promise(resolve=>server.close(resolve));}

});

test('Docker script exceptions match the release allowlist and exclude local diagnostic scripts',()=>{
 const scripts=JSON.parse(readFileSync('packaging/release-scripts.json','utf8'));const ignore=readFileSync('.dockerignore','utf8').split('\n');
 assert.ok(ignore.includes('scripts/*'));assert.deepEqual(ignore.filter(line=>line.startsWith('!scripts/')).map(line=>line.slice(9)).sort(),scripts.slice().sort());
 for(const file of ['test-blanc-all.py','debug-one-wg.py','check-xray.py','diagnose-dns.py'])assert.ok(!scripts.includes(file));
 const dockerfile=readFileSync('Dockerfile','utf8');assert.ok(dockerfile.includes('release-bundles.py'));assert.ok(dockerfile.includes('module-seed'));assert.ok(dockerfile.includes('container-entrypoint.sh'));assert.ok(dockerfile.includes('COPY --from=web-build /build/node_modules/yaml ./node_modules/yaml'));
});

test('health CLI also probes when invoked through the current-release symlink',()=>{
 const folder=mkdtempSync(join(tmpdir(),'fg-health-cli-'));
 try{
  writeFileSync(join(folder,'systemctl'),'#!/bin/sh\nprintf "called\\n" >> "$FREEDOMGATE_HEALTH_CALL_LOG"\nexit 1\n',{mode:0o755});
  const script=join(folder,'health.mjs');symlinkSync(new URL('../scripts/install-health.mjs',import.meta.url),script);
  const result=spawnSync(process.execPath,[script],{env:{...process.env,PATH:folder+':'+process.env.PATH,FREEDOMGATE_HEALTH_CALL_LOG:join(folder,'called')},encoding:'utf8'});
  assert.equal(result.status,1,result.stderr);assert.match(readFileSync(join(folder,'called'),'utf8'),/called/);
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test('native install prepares upstream modules with pinned Go before runtime activation',()=>{
 const source=readFileSync('scripts/install.sh','utf8');assert.ok(source.indexOf('apt-get install')<source.indexOf('go_dir=$(ensure_runtime go)'));assert.ok(source.indexOf('go_dir=$(ensure_runtime go)')<source.indexOf('python3 scripts/release-bundles.py'));assert.ok(source.includes('scripts/release-bundles.py --platform "linux-$arch" --prepare'));assert.ok(source.indexOf('python3 scripts/release-bundles.py')<source.indexOf('activation_started=1'));
 const pack=readFileSync('scripts/package-release.sh','utf8');assert.ok(pack.includes('--installer'));assert.ok(!pack.includes('build-outline.sh'));assert.ok(!pack.includes('--prepare'));
 const docker=readFileSync('Dockerfile','utf8');assert.ok(docker.includes('fetch-runtime.py go'));assert.ok(docker.includes('scripts/release-bundles.py --platform linux-${TARGETARCH} --prepare'));

});
