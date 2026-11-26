// Explicit native acceptance. Public requests use one already configured gateway;
// credentials remain on-device. The worker has only loopback/dummy/TUN networking.
import assert from 'node:assert/strict';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,cpSync,chmodSync,chownSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const root=process.env.FG_CODE_ROOT;
assert.ok(root,'Set FG_CODE_ROOT to the isolated release.');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const listen=server=>new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const freePort=async()=>{const s=net.createServer(),port=await listen(s);await new Promise(resolve=>s.close(resolve));return port;};
const track=(set,s)=>{set.add(s);s.on('error',()=>{});s.once('close',()=>set.delete(s));return s;};
const bounded=async(fn,label,seconds=120)=>{const start=Date.now();let error;while(Date.now()-start<seconds*1000){try{const value=await fn();if(value)return value;}catch(e){error=e.message;}await wait(300);}throw Error(label+(error?': '+error:''));};

if(process.argv.includes('--worker')){
 const {LanternGateway,waitForLantern}=await import(root+'/server/lantern/runtime.js');
 const {buildMihomoConfig}=await import(root+'/server/mihomo.js');const {defaultDnsSettings}=await import(root+'/server/dns-resolvers.js');
 const {parse}=await import(root+'/node_modules/yaml/dist/index.js');
 const initialLinks=JSON.parse(execFileSync('ip',['-j','link','show']).toString());assert.ok(initialLinks.every(row=>['lo','lanwan'].includes(row.ifname)),'Native worker must run in an isolated network namespace');
 const work=process.env.FG_WORK,options=JSON.parse(readFileSync(join(work,'private.json'))),sockets=new Set(),servers=[],children=[];
 let lantern;
 const terminate=async()=>{await lantern?.stop();for(const child of children)child.kill('SIGTERM');for(const socket of sockets)socket.destroy();for(const server of servers)server.close();process.exit(143);};
 process.once('SIGTERM',terminate);process.once('SIGINT',terminate);
 const emit=value=>console.log(JSON.stringify(value));
 try{
  const bridge=net.createServer(client=>{const upstream=track(sockets,net.connect(join(work,'outer.sock')));track(sockets,client);const close=()=>{client.destroy();upstream.destroy();};client.on('close',close);upstream.on('close',close);client.pipe(upstream);upstream.pipe(client);});servers.push(bridge);const bridgePort=await listen(bridge);
  const wrapPort=await freePort(),mixed=await freePort(),controller=await freePort(),state=join(work,'state');
  lantern=new LanternGateway({id:'lantern-live',stateDir:state,wrapEndpoint:{port:wrapPort,username:'fg-wrap',password:'fixture-wrapper-password'},spawnProcess:(binary,args,opts)=>spawn(binary,args,{...opts,uid:options.uid,gid:options.gid})});
  await lantern.start({deferLaunch:true});execFileSync('chown',['-R',options.uid+':'+options.gid,state]);
  const profiles=[{id:'outer-live',engine:'socks5',enabled:true},{id:'lantern-live',engine:'lantern',enabled:true,gatewayId:'outer-live'}];
  const routes={profiles,configs:[{profile_id:'outer-live',engine:'socks5',config:'socks5://fg-geo:'+options.secret+'@127.0.0.1:'+bridgePort},{profile_id:'lantern-live',engine:'lantern',config:'{}'}],groups:[],devices:[],bridges:{'lantern-live':{port:lantern.port}},connectionGroups:[]};
  let yaml=buildMihomoConfig(defaultDnsSettings,{mixedPort:mixed,controllerPort:controller,controllerSecret:'isolated-controller',wrapperEndpoints:new Map([['outer-live',{port:wrapPort,username:'fg-wrap',password:'fixture-wrapper-password'}]])},routes);
  assert.ok(yaml.includes('PROCESS-NAME,lantern-headless,p-outer-li-grp'));assert.ok(yaml.includes('AND,((PROCESS-NAME,lantern-headless),(NETWORK,udp)),REJECT'));
  yaml=yaml.replace('MATCH,DIRECT','MATCH,REJECT');const file=join(work,'mihomo.yaml');writeFileSync(file,yaml,{mode:0o600});
  const core=spawn(options.mihomo,['-d',work,'-f',file],{stdio:['ignore','ignore','ignore']});children.push(core);core.on('error',()=>{});
  const api=async path=>{const response=await fetch('http://127.0.0.1:'+controller+path,{headers:{Authorization:'Bearer isolated-controller'},signal:AbortSignal.timeout(2000)});assert.equal(response.status,200);return response.json();};
  await bounded(()=>api('/version'),'Isolated TUN core unavailable',15);lantern.activate();const ready=await waitForLantern(lantern,{timeoutMs:90000});assert.equal(ready.outcome,'ok');
  emit({type:'ready',state:ready.state,tun:true});
  const curl=options.curl;
  const runCurl=(args,timeout=21000)=>new Promise(resolve=>{const child=spawn(curl,args,{uid:options.uid,gid:options.gid,stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',data=>out+=data);child.stderr.resume();child.on('error',()=>resolve({ok:false,code:'spawn'}));const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);child.once('exit',code=>{clearTimeout(timer);resolve({ok:code===0,code,output:out.trim()});});});
  for await(const line of createInterface({input:process.stdin})){
   const command=JSON.parse(line);if(command.op==='stop')break;
   if(command.op==='service-route'){
    const services=[];for(const target of options.serviceTargets){const result=await runCurl(['--silent','--show-error','--noproxy','*','--max-time','12','--resolve',target.host+':443:'+target.address,'--output','/dev/null','--write-out','%{http_code}','https://'+target.host+'/']);services.push({host:target.host,tlsResponse:result.ok,httpStatus:Number(result.output)});}emit({type:'service-route',services});continue;
   }
   if(command.op==='process-route'){
    const result=await runCurl(['--silent','--show-error','--fail','--noproxy','*','--max-time','12','--resolve','www.gstatic.com:443:'+options.gstaticIp,'--output','/dev/null','--write-out','%{http_code}','https://www.gstatic.com/generate_204']);emit({type:'process-route',ok:result.ok,httpStatus:Number(result.output)});continue;
   }
   const websites=[];
   for(const url of ['https://www.gstatic.com/generate_204','https://api.ipify.org']){
    // Normal curl has no matching process name here; it reaches Lantern explicitly.
    const child=spawn('/usr/bin/curl',['--silent','--show-error','--fail','--noproxy','','--max-time','18','--proxy','http://127.0.0.1:'+lantern.port,'--write-out','\n%{http_code}',url],{uid:options.uid,gid:options.gid,stdio:['ignore','pipe','pipe']});
    const result=await new Promise(resolve=>{let output='';child.stdout.on('data',data=>output+=data);child.stderr.resume();const timer=setTimeout(()=>child.kill('SIGKILL'),21000);child.on('error',()=>resolve({ok:false}));child.once('exit',code=>{clearTimeout(timer);resolve({ok:code===0,output});});});
    const parts=(result.output||'').trim().split('\n'),status=Number(parts.pop());websites.push({host:new URL(url).hostname,ok:result.ok,httpStatus:status,...(url.includes('ipify')&&result.ok?{exitDiffersFromOuter:parts.join('')!==options.outerExit}:{})});
   }
   emit({type:'probe',phase:command.phase,websites});
  }
 }finally{
  await lantern?.stop();for(const child of children){if(child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;}}
  for(const s of sockets)s.destroy();await Promise.all(servers.map(s=>new Promise(resolve=>s.close(resolve))));emit({type:'stopped',openConnections:sockets.size});
 }
}else{
 assert.equal(process.getuid(),0,'Run the native acceptance harness as root.');
 const {parse}=await import(root+'/node_modules/yaml/dist/index.js');const {createResourceFetch}=await import(root+'/server/resource-fetch.js');
 const production=parse(readFileSync('/var/lib/freedomgate/mihomo/config.yaml','utf8')),db=new DatabaseSync('/var/lib/freedomgate/freedomgate.sqlite',{readOnly:true});
 const profiles=db.prepare('SELECT id,name,engine FROM profiles WHERE enabled=1').all();db.close();profiles.sort((a,b)=>Number(/amnezia/i.test(b.name))-Number(/amnezia/i.test(a.name)));
 let selected,outerExit;
 for(const profile of profiles.filter(p=>!['direct','zapret','tor','lantern'].includes(p.engine)).slice(0,16)){
  if(process.env.FG_OUTER_GATEWAY_ID&&profile.id!==process.env.FG_OUTER_GATEWAY_ID)continue;
  const row=production.listeners?.find(row=>row.name==='fg-geo-'+profile.id);if(!row?.users?.[0])continue;
  const gateway={id:profile.id,port:row.port,secret:row.users[0].password};
  try{const fetchResource=createResourceFetch({gateways:()=>[gateway],allowDirect:false});const response=await fetchResource('https://api.ipify.org',{timeoutMs:8000,maxBytes:4096});outerExit=(await response.text()).trim();assert.ok(net.isIP(outerExit));selected=gateway;break;}catch{}
 }
 assert.ok(selected,'No working outer gateway was found.');
 const resource=createResourceFetch({gateways:()=>[selected],allowDirect:false});const dns=await(await resource('https://dns.google/resolve?name=www.gstatic.com&type=A',{timeoutMs:12000,maxBytes:65536})).json();const gstaticIp=dns.Answer?.find(row=>row.type===1&&net.isIPv4(row.data))?.data;assert.ok(gstaticIp);
 const serviceTargets=[];for(const host of ['df.iantem.io','globalconfig.flashlightproxy.com','api.getiantem.org']){try{const answer=await(await resource('https://dns.google/resolve?name='+host+'&type=A',{timeoutMs:12000,maxBytes:65536})).json();const address=answer.Answer?.find(row=>row.type===1&&net.isIPv4(row.data))?.data;if(address)serviceTargets.push({host,address});}catch{}}assert.ok(serviceTargets.length,'No Lantern service endpoint could be resolved through the outer gateway');
 const work=mkdtempSync('/var/lib/freedomgate/.lantern-wrap-lab-'),uid=Number(execFileSync('id',['-u','freedomgate']).toString()),gid=Number(execFileSync('id',['-g','freedomgate']).toString());chownSync(work,uid,gid);
 const sockets=new Set(),destinations=[],report={gateway:'existing-working-gateway',phases:[],freshState:true},servers=[];let worker,enabled=true;
 try{
  const curl=join(work,'lantern-headless');cpSync(realpathSync('/usr/bin/curl'),curl);chmodSync(curl,0o755);
  writeFileSync(join(work,'private.json'),JSON.stringify({uid,gid,secret:selected.secret,outerExit,gstaticIp,serviceTargets,curl,mihomo:'/opt/freedomgate/modules/mihomo/current/mihomo'}),{mode:0o600});chownSync(join(work,'private.json'),uid,gid);
  const broker=net.createServer(client=>{
   if(!enabled){client.destroy();return;}track(sockets,client);const remote=track(sockets,net.connect(selected.port,'127.0.0.1'));let buffer=Buffer.alloc(0),state=0;
   client.on('data',chunk=>{if(state===3)return;buffer=Buffer.concat([buffer,chunk]);if(buffer.length>4096){state=3;buffer=Buffer.alloc(0);return;}
    if(state===0&&buffer.length>=2+buffer[1]){buffer=buffer.subarray(2+buffer[1]);state=1;}
    if(state===1&&buffer.length>=2+buffer[1]+1){const n=2+buffer[1],total=n+1+buffer[n];if(buffer.length>=total){buffer=buffer.subarray(total);state=2;}}
    if(state===2&&buffer.length>=5){const size=buffer[3]===1?10:buffer[3]===4?22:7+buffer[4];if(buffer.length>=size){const host=buffer[3]===3?buffer.subarray(5,5+buffer[4]).toString():buffer[3]===1?[...buffer.subarray(4,8)].join('.'):'IPv6';destinations.push({host,port:buffer.readUInt16BE(size-2)});state=3;buffer=Buffer.alloc(0);}}
   });const close=()=>{client.destroy();remote.destroy();};client.on('close',close);remote.on('close',close);client.pipe(remote);remote.pipe(client);
  });servers.push(broker);await new Promise(resolve=>broker.listen(join(work,'outer.sock'),resolve));chownSync(join(work,'outer.sock'),uid,gid);chmodSync(join(work,'outer.sock'),0o600);
  worker=spawn('unshare',['--net','sh','-c','ip link set lo up; ip link add lanwan type dummy; ip addr add 198.19.23.1/24 dev lanwan; ip link set lanwan up; ip route add default dev lanwan; exec "$1" "$2" --worker','sh',process.execPath,new URL(import.meta.url).pathname],{stdio:['pipe','pipe','pipe'],env:{...process.env,FG_CODE_ROOT:root,FG_WORK:work}});let errors='';worker.stderr.on('data',data=>errors=(errors+data.toString()).slice(-2000));
  const exited=new Promise(resolve=>worker.once('close',code=>resolve(code)));
  const queue=[],waiters=[];createInterface({input:worker.stdout}).on('line',line=>{try{const value=JSON.parse(line);if(waiters.length)waiters.shift()(value);else queue.push(value);}catch{}});
  const receive=()=>Promise.race([queue.length?Promise.resolve(queue.shift()):new Promise(resolve=>waiters.push(resolve)),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('Native Lantern worker timed out')),100000);t.unref();}),exited.then(()=>{throw Error('Native Lantern worker exited: '+errors);})]);
  assert.equal((await receive()).type,'ready');
  worker.stdin.write(JSON.stringify({op:'process-route'})+'\n');report.processRouting=await receive();assert.equal(report.processRouting.ok,true,'Generated PROCESS-NAME route did not reach the outer proxy under TUN');
  worker.stdin.write(JSON.stringify({op:'service-route'})+'\n');report.serviceRouting=await receive();assert.ok(report.serviceRouting.services.every(row=>row.tlsResponse&&row.httpStatus>=200&&row.httpStatus<500));
  let consecutive=0;
  for(let attempt=1;attempt<=5&&consecutive<2;attempt++){worker.stdin.write(JSON.stringify({op:'probe',phase:'wrapped-'+attempt})+'\n');const phase=await receive();report.phases.push(phase);consecutive=phase.websites.every(row=>row.ok)?consecutive+1:0;if(consecutive<2)await wait(8000);}
  assert.equal(consecutive,2,'Lantern must pass two consecutive full probes through the wrapper');
  enabled=false;for(const s of sockets)s.destroy();worker.stdin.write(JSON.stringify({op:'probe',phase:'outer-disabled'})+'\n');const blocked=await receive();report.phases.push(blocked);assert.ok(blocked.websites.every(row=>!row.ok),'Disabled outer path leaked direct traffic');
  enabled=true;consecutive=0;
  for(let attempt=1;attempt<=5&&consecutive<2;attempt++){worker.stdin.write(JSON.stringify({op:'probe',phase:'restored-'+attempt})+'\n');const phase=await receive();report.phases.push(phase);consecutive=phase.websites.every(row=>row.ok)?consecutive+1:0;if(consecutive<2)await wait(8000);}
  assert.equal(consecutive,2,'Lantern did not recover through the restored outer path');
  report.audit={connections:destinations.length,serviceHosts:[...new Set(destinations.filter(d=>/iantem|flashlightproxy/.test(d.host)).map(d=>d.host))],nonServiceConnections:destinations.filter(d=>!/iantem|flashlightproxy/.test(d.host)).length};assert.ok(destinations.length>2);
  worker.stdin.end(JSON.stringify({op:'stop'})+'\n');report.stopped=await receive();assert.equal(report.stopped.type,'stopped');assert.equal(await exited,0);worker=null;report.passed=true;
 }finally{
  if(worker){worker.stdin.end();worker.kill('SIGTERM');await new Promise(resolve=>worker.once('exit',resolve));}
  for(const s of sockets)s.destroy();await Promise.all(servers.map(s=>new Promise(resolve=>s.close(resolve))));rmSync(work,{recursive:true,force:true});report.cleaned=true;if(process.env.FG_REPORT)writeFileSync(process.env.FG_REPORT,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
 }
}
