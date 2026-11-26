// Explicit root-only native probe. Credentials and the copied identity stay on-host.
import {writeFileSync,mkdtempSync,mkdirSync,cpSync,rmSync,existsSync} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';import {createInterface} from 'node:readline';import {join} from 'node:path';import assert from 'node:assert/strict';
assert.equal(process.getuid(),0,'Run this explicit native integration probe as root');
const root=process.env.FG_CODE_ROOT,report={phases:[]},work=mkdtempSync('/var/lib/freedomgate/.lantern-uplink-');let child;
async function cleanup(){if(child)try{execFileSync('systemctl',['stop','freedomgate-lantern-lab-'+process.pid],{stdio:'ignore',timeout:10000});}catch{}child?.kill('SIGTERM');rmSync(work,{recursive:true,force:true});}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await cleanup();process.exit(143);});
try{
 mkdirSync(join(work,'state/lantern/data'),{recursive:true});if(existsSync('/var/lib/freedomgate/lantern/data'))cpSync('/var/lib/freedomgate/lantern/data',join(work,'state/lantern/data'),{recursive:true,filter:path=>!/(^|\/)logs?(\/|$)|\.log(?:\.\d+)?$/.test(path)});
 cpSync(join(root,'tests/integration/lantern-live-probe.mjs'),join(work,'probe.mjs'));execFileSync('chown',['-R','freedomgate:freedomgate',work]);
 child=spawn('systemd-run',['--unit=freedomgate-lantern-lab-'+process.pid,'--wait','--pipe','--collect','-p','User=freedomgate','-p','Group=freedomgate','-p','AmbientCapabilities=CAP_NET_RAW','-p','CapabilityBoundingSet=CAP_NET_RAW','-p','NoNewPrivileges=yes','--setenv=FG_CODE_ROOT='+root,'--setenv=FG_STATE='+join(work,'state'),'--setenv=FG_LANTERN_BINARY='+process.env.FG_LANTERN_BINARY,'/opt/freedomgate/runtime/node/bin/node',join(work,'probe.mjs')],{stdio:['pipe','pipe','pipe']});child.stderr.resume();
 const queue=[],waiters=[];createInterface({input:child.stdout}).on('line',line=>{const value=JSON.parse(line);if(waiters.length)waiters.shift()(value);else queue.push(value);});
 const receive=()=>Promise.race([queue.length?Promise.resolve(queue.shift()):new Promise(resolve=>waiters.push(resolve)),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('Native Lantern probe timed out')),85000);t.unref();})]);
 report.ready=await receive();assert.equal(report.ready.outcome,'ok');report.settleMs=12000;await new Promise(resolve=>setTimeout(resolve,report.settleMs));let id=0,consecutive=0;
 for(let attempt=1;attempt<=4 && consecutive<2;attempt++){const phase='bound-uplink-'+attempt;child.stdin.write(JSON.stringify({op:'probe',id:++id,phase})+'\n');const row=await receive();assert.equal(row.id,id);report.phases.push(row);console.log(JSON.stringify(row));consecutive=row.websites.every(row=>row.ok)?consecutive+1:0;}
 assert.equal(consecutive,2,'Native Lantern must pass two consecutive complete probes');
 child.stdin.end(JSON.stringify({op:'stop'})+'\n');report.stopped=await receive();await new Promise(resolve=>child.once('exit',resolve));report.complete=true;
}finally{await cleanup();report.cleaned=true;if(process.env.FG_REPORT)writeFileSync(process.env.FG_REPORT,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({complete:report.complete===true,cleaned:true}));}
