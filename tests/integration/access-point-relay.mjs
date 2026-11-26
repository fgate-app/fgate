// Isolated test: no production configs, routes, interfaces or listeners are changed.
import {spawn} from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import {randomBytes} from 'node:crypto';
import {relayConfig} from '../../server/cloud/broker.js';
import {policyUsers} from '../../server/access-points/identity.js';
import {connectGatewayTcp} from '../../server/gateway-tunnel.js';
const dual=process.argv.includes('--cloud-dual');
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {newServer,clientConfig} from '../../server/access-points/model.js';
import {ingressConfig,frpcConfig} from '../../server/access-points/runtime.js';
import {frpsConfig,tlsIdentity} from '../../server/access-points/provision.js';
import {buildMihomoConfig} from '../../server/mihomo.js';
import {defaultDnsSettings} from '../../server/dns-resolvers.js';
import {unusedPort} from '../../server/xray.js';
import {execute} from '../../server/access-points/ssh.js';
const diagnostics=[];
const folder=mkdtempSync(join(tmpdir(),'fg-access-e2e-')),children=[],sockets=new Set(),servers=[];
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function track(socket){socket.setTimeout(10000,()=>socket.destroy());sockets.add(socket);socket.once('close',()=>sockets.delete(socket));return socket;}
function reader(socket){let bytes=Buffer.alloc(0),pending=null,closed=false;const flush=()=>{if(!pending)return;if(bytes.length>=pending.size){const {size,resolve}=pending;pending=null;const data=bytes.subarray(0,size);bytes=bytes.subarray(size);resolve(data);}else if(closed){const {reject}=pending;pending=null;reject(Error('Connection closed'));}};socket.on('data',data=>{bytes=Buffer.concat([bytes,data]);flush();});socket.on('close',()=>{closed=true;flush();});socket.on('error',()=>{closed=true;flush();});return size=>new Promise((resolve,reject)=>{pending={size,resolve,reject};flush();});}
async function connect(port){const socket=track(net.connect(port,'127.0.0.1'));await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});return socket;}
async function ready(port){for(let n=0;n<80;n++){try{const socket=await connect(port);socket.destroy();return;}catch{await wait(100);}}throw Error('Listener did not open');}
async function listen(server){servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port;}
function launch(binary,args){const child=spawn(binary,args,{stdio:['ignore','pipe','pipe']});for(const pipe of [child.stdout,child.stderr])pipe.on('data',data=>{diagnostics.push(binary.split('/').at(-1)+': '+data.toString().trim());if(diagnostics.length>30)diagnostics.shift();});children.push(child);child.once('error',()=>{});return child;}
async function socks(socket,address){const read=reader(socket);socket.write(Buffer.from([5,1,0]));assert.deepEqual([...await read(2)],[5,0]);const ip=address.split('.').map(Number);socket.write(Buffer.from([5,1,0,1,...ip,0,80]));const reply=await read(4);if(reply[1]!==0)return {ok:false,read};if(reply[3]===1)await read(6);else if(reply[3]===4)await read(18);else await read((await read(1))[0]+2);return {ok:true,read};}
try{
 const addresses=[];
 const fakePort=await listen(net.createServer(socket=>{track(socket);const read=reader(socket);(async()=>{const hello=await read(2);await read(hello[1]);socket.write(Buffer.from([5,0]));const head=await read(4);let address;if(head[3]===1)address=[...await read(4)].join('.');else if(head[3]===3)address=(await read((await read(1))[0])).toString();else address=(await read(16)).toString('hex');await read(2);addresses.push(address);socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));await read(3);socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK');})().catch(()=>socket.destroy());}));
 const point=newServer({name:'Isolated test',host:'127.0.0.1',sshPort:22,transportPort:await unusedPort(),publicPort:await unusedPort(),fingerprint:'SHA256:'+'a'.repeat(43)});Object.assign(point.secrets,await tlsIdentity(point.host));
 const certResult=await execute('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','1','-keyout',join(folder,'target.key'),'-out',join(folder,'target.crt'),'-subj','/CN=www.microsoft.com','-addext','subjectAltName=DNS:www.microsoft.com']);assert.equal(certResult.code,0);const {readFileSync}=await import('node:fs');
 const targetPort=await listen(tls.createServer({key:readFileSync(join(folder,'target.key')),cert:readFileSync(join(folder,'target.crt')),minVersion:'TLSv1.3',ecdhCurve:'X25519',ALPNProtocols:['h2','http/1.1']},socket=>{track(socket);socket.on('error',()=>{});}));
 point.clients=[{id:'00000000-0000-4000-8000-000000000001',enabled:true,...(dual?{password:randomBytes(32).toString('base64url')}: {})}];
 if(dual){if(process.argv.includes('--external-target'))point.serverName=process.env.FG_REALITY_TEST_SNI || 'www.microsoft.com';point.managed=true;point.protocol='shadowsocks';point.vlessPort=await unusedPort();}
 const mixed=await unusedPort(),remote=await unusedPort(),ingress=await unusedPort(),client=await unusedPort(),vlessLocal=dual?await unusedPort():null,ssClient=dual?await unusedPort():null,mihomoClient=dual?await unusedPort():null;
 const dns=dual?dgram.createSocket('udp4'):null;let dnsSeen=0;
 if(dns){const answer=q=>{dnsSeen++;const reply=Buffer.concat([q,Buffer.from([192,12,0,1,0,1,0,0,0,60,0,4,203,0,113,9])]);reply.writeUInt16BE(0x8180,2);reply.writeUInt16BE(1,6);return reply;};dns.on('message',(q,peer)=>dns.send(answer(q),peer.port,peer.address));await new Promise(r=>dns.bind(0,'127.0.0.1',r));servers.push({close:r=>dns.close(r)});const tcpDns=net.createServer(s=>{track(s);let pending=Buffer.alloc(0);s.on('data',b=>{pending=Buffer.concat([pending,b]);while(pending.length>=2 && pending.length>=pending.readUInt16BE()+2){const n=pending.readUInt16BE(),reply=answer(pending.subarray(2,n+2)),head=Buffer.alloc(2);head.writeUInt16BE(reply.length);s.write(Buffer.concat([head,reply]));pending=pending.subarray(n+2);}});});servers.push(tcpDns);await new Promise(r=>tcpDns.listen(dns.address().port,'127.0.0.1',r));}

 const routes={devices:[],profiles:[{id:'11111111-1111-4111-8111-111111111111',engine:'socks5',enabled:true}],configs:[{profile_id:'11111111-1111-4111-8111-111111111111',engine:'socks5',config:'socks5://127.0.0.1:'+fakePort}],groups:[{id:'positive',routeId:'11111111-1111-4111-8111-111111111111',entries:['203.0.113.55']},{id:'blocked',routeId:'block',entries:['203.0.113.56']}]};
 const mihomo=buildMihomoConfig(defaultDnsSettings,{mixedPort:mixed,remotePort:remote,remoteAccessEnabled:true,remoteUsers:policyUsers([point]),dnsPort:await unusedPort(),controllerPort:await unusedPort()},routes).replace('tun:\n  enable: true','tun:\n  enable: false');
 const inbound=ingressConfig(point,ingress,{mixedPort:remote,...(dual?{vlessPort:vlessLocal,adguardPort:dns.address().port}:{})});inbound.log.loglevel='debug';if(!process.argv.includes('--external-target'))inbound.inbounds.find(x=>x.protocol==='vless').streamSettings.realitySettings.target='127.0.0.1:'+targetPort;
 const outbound={log:{loglevel:'debug'},inbounds:[{listen:'127.0.0.1',port:client,protocol:'socks',settings:{auth:'noauth'}}],outbounds:[{protocol:'vless',settings:{vnext:[{address:'127.0.0.1',port:dual?point.vlessPort:point.publicPort,users:[{id:point.clients[0].id,encryption:'none',flow:'xtls-rprx-vision'}]}]},streamSettings:{network:'tcp',security:'reality',realitySettings:{serverName:point.serverName,fingerprint:'chrome',publicKey:point.secrets.realityPublic,shortId:point.secrets.shortId}}}]};
 const relay=dual?relayConfig({...point,token:point.secrets.token}):frpsConfig(point);relay.bindAddr='127.0.0.1';relay.proxyBindAddr='127.0.0.1';relay.transport.tls.certFile=join(folder,'tls.crt');relay.transport.tls.keyFile=join(folder,'tls.key');
 writeFileSync(join(folder,'tls.crt'),point.secrets.tlsCert,{mode:0o600});writeFileSync(join(folder,'tls.key'),point.secrets.tlsKey,{mode:0o600});
 const configs={'mihomo.yaml':mihomo,'inbound.json':JSON.stringify(inbound),'client.json':JSON.stringify(outbound),'frps.json':JSON.stringify(relay),'frpc.json':JSON.stringify(frpcConfig(point,ingress,folder,{statusPort:await unusedPort(),statusPassword:'isolated-test',vlessLocalPort:vlessLocal}))};if(dual){const exported=clientConfig(point,point.clients[0]).alternatives[0].mihomo;exported.tun={enable:false};exported['mixed-port']=mihomoClient;configs['mihomo-client.yaml']=JSON.stringify(exported);}if(dual)configs['ss-client.json']=JSON.stringify({log:{loglevel:'error'},inbounds:[{listen:'127.0.0.1',port:ssClient,protocol:'socks',settings:{auth:'noauth',udp:true}}],outbounds:[{protocol:'shadowsocks',settings:{servers:[{address:'127.0.0.1',port:point.publicPort,method:'chacha20-ietf-poly1305',password:point.clients[0].password}]}}]});outbound.inbounds[0].settings.udp=true;configs['client.json']=JSON.stringify(outbound);for(const [name,value] of Object.entries(configs))writeFileSync(join(folder,name),value,{mode:0o600});
 const xray=process.env.FREEDOMGATE_XRAY || '/opt/freedomgate/modules/xray/v26.10.31/xray',mihomoBin=process.env.FREEDOMGATE_MIHOMO || '/opt/freedomgate/modules/mihomo/v1.19.33/mihomo',frp=new URL('../../server/access-points/bin/'+process.platform+'-'+(process.arch==='x64'?'amd64':process.arch)+'/',import.meta.url).pathname;
 for(const name of ['inbound.json','client.json'])assert.equal((await execute(xray,['run','-test','-config',join(folder,name)])).code,0,'valid Xray '+name);
 launch(mihomoBin,['-f',join(folder,'mihomo.yaml'),'-d',folder]);await ready(remote);
 launch(xray,['run','-config',join(folder,'inbound.json')]);await ready(ingress);launch(frp+'frps',['-c',join(folder,'frps.json')]);await ready(point.transportPort);launch(frp+'frpc',['-c',join(folder,'frpc.json')]);await ready(point.publicPort);if(dual){await ready(point.vlessPort);launch(xray,['run','-config',join(folder,'ss-client.json')]);await ready(ssClient);launch(mihomoBin,['-f',join(folder,'mihomo-client.yaml'),'-d',folder]);await ready(mihomoClient);}launch(xray,['run','-config',join(folder,'client.json')]);await ready(client);
 for(const currentClient of dual?[client,ssClient,mihomoClient]:[client]){
 const socket=await connect(currentClient);const connected=await socks(socket,'203.0.113.55');assert.ok(connected.ok);socket.write('GET / HTTP/1.1\r\nHost: 203.0.113.55\r\n\r\n');assert.equal((await connected.read(15)).toString(),'HTTP/1.1 200 OK');socket.destroy();assert.ok(addresses.includes('203.0.113.55'));
 for(const address of ['203.0.113.56','127.0.0.1']){
  const socket=await connect(currentClient);let blocked=false;
  try{const result=await socks(socket,address);if(!result.ok)blocked=true;else{socket.write('GET / HTTP/1.1\r\n\r\n');try{await Promise.race([result.read(1),wait(2000).then(()=>{throw Error('rejected or timed out');})]);}catch{blocked=true;}}}catch{blocked=true;}
  socket.destroy();assert.ok(blocked,'policy/private network rejected '+address);assert.ok(!addresses.includes(address),'blocked destination did not reach upstream');
 }
 if(dual){
  const association=await connectGatewayTcp({port:currentClient},3,{address:'0.0.0.0',port:0},track),udp=dgram.createSocket('udp4');
  try{const q=Buffer.concat([Buffer.from([18,52,1,0,0,1,0,0,0,0,0,0]),...['dual-'+currentClient,'example'].map(label=>Buffer.concat([Buffer.from([label.length]),Buffer.from(label)])),Buffer.from([0,0,1,0,1])]);const reply=await new Promise((r,j)=>{const timer=setTimeout(()=>j(Error('UDP DNS timed out')),5000);udp.once('error',j);udp.once('message',b=>{clearTimeout(timer);r(b);});udp.send(Buffer.concat([Buffer.from([0,0,0,1,8,8,8,8,0,53]),q]),association.port,'127.0.0.1');});assert.equal(reply.subarray(10).readUInt16BE(),0x1234);assert.equal(reply.subarray(10).readUInt16BE(6),1);}finally{udp.close();association.socket.destroy();}
 }
 }
 if(dual)assert.equal(dnsSeen,3);
 console.log(dual?'PASS: real dual Cloud access: SS + VLESS/REALITY, independent public ports, TLS frp, authenticated policy, TCP/UDP DNS and private-network rejection.':'PASS: real Xray VLESS/REALITY → frps/frpc TLS → Xray → isolated mihomo rules → controlled SOCKS upstream; REJECT and loopback denied. Production network unchanged.');
}catch(error){console.error(diagnostics.join('\n'));throw error;}finally{
 for(const socket of sockets)socket.destroy();for(const child of children)child.kill('SIGTERM');
 await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));
 await Promise.all(children.map(child=>new Promise(resolve=>{if(child.exitCode!==null || child.signalCode!==null || !child.pid)return resolve();const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},2000);child.once('exit',()=>{clearTimeout(timer);resolve();});})));
 rmSync(folder,{recursive:true,force:true});
}
