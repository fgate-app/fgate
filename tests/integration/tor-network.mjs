// Real public Tor plus local mihomo/Xray fixtures. Production routes are untouched.
import {TorGateway} from '../../server/tor/runtime.js';
import {buildMihomoConfig} from '../../server/mihomo.js';
import {defaultDnsSettings} from '../../server/dns-resolvers.js';
import {unusedPort,XraySupervisor} from '../../server/xray.js';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,writeFileSync,readFileSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import http from 'node:http';
import tls from 'node:tls';
import {generateKeyPairSync} from 'node:crypto';
import assert from 'node:assert/strict';
const execute=promisify(execFile),folder=process.env.TOR_STATE_DIR || mkdtempSync(join(tmpdir(),'fg-tor-network-'));
const children=[],servers=[],tor=new TorGateway({id:'native',stateDir:folder,bundle:process.env.FREEDOMGATE_TOR_BUNDLE,settings:{mode:process.env.TOR_MODE || 'auto',connectTimeout:120,retries:0}});
let client;
const listen=async server=>{servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port;};
const launch=(binary,args)=>{const fd=openSync(join(folder,'fixture-'+children.length+'.log'),'a',0o600);const child=spawn(binary,args,{stdio:['ignore',fd,fd]});closeSync(fd);children.push(child);return child;};
async function ready(port){for(let n=0;n<100;n++){try{await new Promise((resolve,reject)=>{const socket=net.connect(port,'127.0.0.1',()=>{socket.destroy();resolve();});socket.on('error',reject);});return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Local fixture did not start.');}
try{
 // Publish a controlled VLESS TCP target through an onion service. No VPS/public ports needed.
 const origin=await listen(http.createServer((_req,res)=>res.end('controlled Tor VLESS response')));
 await execute('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','1','-keyout',join(folder,'key'),'-out',join(folder,'cert'),'-subj','/CN=www.microsoft.com']);
 const tlsPort=await listen(tls.createServer({key:readFileSync(join(folder,'key')),cert:readFileSync(join(folder,'cert')),minVersion:'TLSv1.3',ecdhCurve:'X25519',ALPNProtocols:['h2','http/1.1']},socket=>socket.on('error',()=>{})));
 const keys=generateKeyPairSync('x25519'),privateKey=keys.privateKey.export({format:'jwk'}).d,publicKey=keys.publicKey.export({format:'jwk'}).x;
 const peer=await unusedPort(),uuid='00000000-0000-4000-8000-000000000024',serverFile=join(folder,'vless-server.json');
 writeFileSync(serverFile,JSON.stringify({log:{loglevel:'debug'},inbounds:[{listen:'127.0.0.1',port:peer,protocol:'vless',settings:{clients:[{id:uuid,flow:'xtls-rprx-vision'}],decryption:'none'},streamSettings:{network:'tcp',security:'reality',realitySettings:{target:'127.0.0.1:'+tlsPort,serverNames:['www.microsoft.com'],privateKey,shortIds:['0123456789abcdef']}}}],outbounds:[{protocol:'freedom',settings:{finalRules:[{action:'allow',ip:['127.0.0.1/32']}]}}]}),{mode:0o600});
 const xray='/opt/freedomgate/modules/xray/current/xray';launch(xray,['run','-config',serverFile]);await ready(peer);
 const makeOutbound=(address,port)=>({outbounds:[{protocol:'vless',settings:{vnext:[{address,port,users:[{id:uuid,encryption:'none',flow:'xtls-rprx-vision'}]}]},streamSettings:{network:'tcp',security:'reality',realitySettings:{serverName:'www.microsoft.com',fingerprint:'chrome',publicKey,shortId:'0123456789abcdef'}}}]});
 const control=new XraySupervisor({stateDir:join(folder,'control'),binary:xray});
 try{const prepared=await control.prepare([{profile_id:'control',engine:'xray',config:JSON.stringify(makeOutbound('127.0.0.1',peer))}]);await prepared.commit();const result=await execute('curl',['--silent','--show-error','--fail','--noproxy','','--socks5-hostname','127.0.0.1:'+control.entries.get('control').port,'--max-time','10','http://127.0.0.1:'+origin+'/']);assert.equal(result.stdout,'controlled Tor VLESS response');console.log(JSON.stringify({check:'direct-reality-fixture-control',result:'ok'}));}finally{await control.stop();}
 const original=tor.spawnProcess;tor.spawnProcess=(binary,args,options)=>{writeFileSync(args[1],readFileSync(args[1],'utf8')+`HiddenServiceDir ${JSON.stringify(join(folder,'onion'))}\nHiddenServicePort 443 127.0.0.1:${peer}\n`);return original(binary,args,options);};
 await tor.start();
 for(let n=0;n<250;n++){await new Promise(resolve=>setTimeout(resolve,1000));if(n%10===0)console.log(JSON.stringify(tor.snapshot()));if(tor.state==='ready')break;if(['failed','unavailable'].includes(tor.state))throw Error('Public Tor could not connect.');}
 assert.equal(tor.state,'ready');
 const wrapPort=await unusedPort(),mixedPort=await unusedPort(),controller=await unusedPort(),id='00000024-tor';
 const config=buildMihomoConfig(defaultDnsSettings,{mixedPort,dnsPort:await unusedPort(),controllerPort:controller,wrapperEndpoints:new Map([[id,{port:wrapPort,username:'fixture',password:'fixture-password'}]])},{profiles:[{id,engine:'tor',enabled:true},{id:'00000025-proxy',engine:'socks5',enabled:true,gatewayId:id}],configs:[{profile_id:id,engine:'tor',config:'{}'},{profile_id:'00000025-proxy',engine:'socks5',config:'socks5://127.0.0.1:1'}],devices:[],groups:[{id:'tor-test',entries:['check.torproject.org'],routeId:id}],bridges:{[id]:{port:tor.port,address:'127.0.0.1',udp:false}}}).replace('tun:\n  enable: true','tun:\n  enable: false');
 const file=join(folder,'mihomo.yaml');writeFileSync(file,config,{mode:0o600});launch('/opt/freedomgate/modules/mihomo/current/mihomo',['-d',folder,'-f',file]);await ready(mixedPort);
 const result=JSON.parse((await execute('curl',['--silent','--show-error','--fail','--noproxy','','--proxy',`http://127.0.0.1:${mixedPort}`,'--max-time','45','https://check.torproject.org/api/ip'])).stdout);assert.equal(result.IsTor,true);console.log(JSON.stringify({check:'mihomo-to-tor',result:'ok',mode:tor.mode}));
 const onion=readFileSync(join(folder,'onion/hostname'),'utf8').trim();
 // Use the real XraySupervisor and a selected SOCKS wrapper; local DNS must never run.
 client=new XraySupervisor({stateDir:folder,binary:xray,resolve:async()=>{throw Error('Local DNS must not resolve onion/proxy hostnames.');}});
 const outbound=makeOutbound(onion,443);
 // The Tor gate accepts no-auth SOCKS, matching the wrapper transport contract.
 const prepared=await client.prepare([{profile_id:'onion-vless',engine:'xray',config:JSON.stringify(outbound),wrapEndpoint:{port:wrapPort,username:'fixture',password:'fixture-password',remoteDns:true}}]);await prepared.commit();
 let success=false;
 for(let n=0;n<5;n++){try{const value=await execute('curl',['--silent','--show-error','--fail','--socks5-hostname',`127.0.0.1:${client.entries.get('onion-vless').port}`,'--max-time','40',`http://127.0.0.1:${origin}/`]);assert.equal(value.stdout,'controlled Tor VLESS response');success=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,5000));}}
 assert.equal(success,true);console.log(JSON.stringify({check:'real-vless-reality-over-tor-onion-controlled-target',result:'ok',localProxyDnsQueries:0}));
 await tor.stop();
 await assert.rejects(()=>execute('curl',['--silent','--fail','--proxy',`http://127.0.0.1:${mixedPort}`,'--max-time','5','https://check.torproject.org/api/ip']));console.log(JSON.stringify({check:'tor-down-no-direct-fallback',result:'ok'}));
}finally{await tor.stop();await client?.stop();for(const child of children)child.kill('SIGTERM');for(const server of servers)await new Promise(resolve=>server.close(resolve));}
