import {startCloudSsh,cloudSshAvailable} from './cloud-ssh.js';
import {setTimeout as delay} from 'node:timers/promises';
import {validDownloadGateways} from '../resource-fetch.js';
import {accessUsername,accessPassword} from './identity.js';
import {moduleBinary} from '../module-paths.js';
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,writeFileSync,rmSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {XraySupervisor,unusedPort} from '../xray.js';
import {execute} from './ssh.js';
import {AccessPointError,cloudRealityAvailable} from './model.js';
export const privateNetworks=['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.168.0.0/16','198.18.0.0/15','224.0.0.0/4','240.0.0.0/4','::/128','::1/128','fc00::/7','fe80::/10','ff00::/8'];
export function ingressConfig(server,port,{mixedPort=17990,adguardPort=53053,metricsPort=null,vlessPort=null}={}){
 const inbound=server.protocol==='shadowsocks'?{tag:'remote',listen:'127.0.0.1',port,protocol:'shadowsocks',settings:{method:'chacha20-ietf-poly1305',network:'tcp,udp',clients:server.clients.filter(client=>client.enabled).map(client=>({email:client.id+'@freedomgate',method:'chacha20-ietf-poly1305',password:client.password}))},sniffing:{enabled:true,destOverride:['http','tls','quic'],routeOnly:false}}:null;
 // Recover HTTP/TLS/QUIC domain targets before private-IP filtering.
 // Keep domain targets intact: local DNS may return synthetic private fake IPs.
 // The policy listener resolves domains and enforces private-network restrictions.
 // Internal DNS bypasses the dispatcher: the client policy listener rejects loopback.
 const config={log:{loglevel:'none'},dns:{servers:['tcp+local://127.0.0.1:'+adguardPort]},inbounds:[{tag:'remote',listen:'127.0.0.1',port,protocol:'vless',settings:{clients:server.clients.filter(client=>client.enabled).map(client=>({id:client.id,email:client.id+'@freedomgate',flow:'xtls-rprx-vision'})),decryption:'none'},streamSettings:{network:'tcp',security:'reality',realitySettings:{show:false,target:server.serverName+':443',serverNames:[server.serverName],privateKey:server.secrets.realityPrivate,shortIds:[server.secrets.shortId]}},sniffing:{enabled:true,destOverride:['http','tls','quic'],routeOnly:false}}],outbounds:[{tag:'policy',protocol:'socks',settings:{servers:[{address:'127.0.0.1',port:mixedPort}]}},{tag:'dns',protocol:'dns',settings:{rewriteNetwork:'udp',rewriteAddress:'127.0.0.1',rewritePort:adguardPort}},{tag:'blocked',protocol:'blackhole'}],routing:{domainStrategy:'AsIs',rules:[{type:'field',inboundTag:['remote'],port:'53',outboundTag:'dns'},{type:'field',inboundTag:['remote'],ip:privateNetworks,outboundTag:'blocked'},{type:'field',inboundTag:['remote'],outboundTag:'policy'}]}};
 const vless=config.inbounds[0];
 if(inbound)config.inbounds=[inbound];
 if(inbound && vlessPort && cloudRealityAvailable(server)){config.inbounds.push({...vless,tag:'remote-vless',port:vlessPort});for(const rule of config.routing.rules)rule.inboundTag.push('remote-vless');}
 const clients=server.clients.filter(client=>client.enabled);
 config.outbounds=[...clients.map(client=>({tag:'policy-'+client.id,protocol:'socks',settings:{servers:[{address:'127.0.0.1',port:mixedPort,users:[{user:accessUsername(server.id,client.id),pass:accessPassword(server,client)}]}]}})),...config.outbounds];
 config.routing.rules.splice(2,0,...clients.map(client=>({type:'field',inboundTag:config.inbounds.map(inbound=>inbound.tag),user:[client.id+'@freedomgate'],outboundTag:'policy-'+client.id})));
 if(metricsPort){config.stats={};config.policy={levels:{'0':{statsUserUplink:true,statsUserDownlink:true}}};config.metrics={tag:'metrics',listen:'127.0.0.1:'+metricsPort};}
 return config;
}
function transportGateway(gateway){
 const upstream=gateway?validDownloadGateways([gateway])[0]:null;
 if(gateway && !upstream)throw new AccessPointError('The selected gateway is unavailable.',503);
 return upstream;
}
export function frpcConfig(server,localPort,folder,{statusPort,statusPassword,gateway,sshTransport,vlessLocalPort}){
 const upstream=transportGateway(gateway);
 const proxies=(server.protocol==='shadowsocks'?['tcp','udp']:['tcp']).map(type=>({name:'fg-'+server.id+'-'+type,type,localIP:'127.0.0.1',localPort,remotePort:server.publicPort}));
 if(vlessLocalPort && cloudRealityAvailable(server))proxies.push({name:'fg-'+server.id+'-vless',type:'tcp',localIP:'127.0.0.1',localPort:vlessLocalPort,remotePort:server.vlessPort});
 return {...(server.protocol==='shadowsocks'?{udpPacketSize:65535}:{}),serverAddr:sshTransport?'127.0.0.1':server.host,serverPort:sshTransport?.relayPort || server.transportPort,loginFailExit:false,auth:{method:'token',token:server.secrets.token,additionalScopes:['HeartBeats','NewWorkConns']},transport:{...(upstream?{proxyURL:`http://fg-geo:${encodeURIComponent(upstream.secret)}@127.0.0.1:${upstream.port}`} : {}),heartbeatInterval:5,heartbeatTimeout:15,tls:{enable:true,trustedCaFile:join(folder,'tls.crt'),serverName:server.host}},webServer:{addr:'127.0.0.1',port:statusPort,user:'freedomgate',password:statusPassword},log:{level:'error'},proxies};
}
export class AccessPointRuntime{
 constructor({stateDir,xray=process.env.FREEDOMGATE_XRAY || moduleBinary('xray','xray','/opt/freedomgate/modules/xray/v26.10.31/xray'),frpc=moduleBinary('frp','frpc',new URL('./bin/'+process.platform+'-'+(process.arch==='x64'?'amd64':process.arch)+'/frpc',import.meta.url).pathname),mixedPort=17990,diagnostics=false,sshStart=startCloudSsh}={}){this.sshStart=sshStart;this.supportsCloudSsh=true;this.supportsCloudVlessReality=true;this.diagnostics=diagnostics;this.dir=join(stateDir,'access-runtime');this.xray=xray;this.frpc=frpc;this.mixedPort=mixedPort;this.entries=new Map();}
 async start(server,{gateway,ssh=false,signal}={}){
  gateway=transportGateway(gateway);if(ssh && (gateway || !cloudSshAvailable(server)))throw Error('Cloud SSH fallback is unavailable');
  if(!existsSync(this.xray)||!existsSync(this.frpc))throw new AccessPointError('Install Xray and frp before starting access points.',503);
  const vlessLocalPort=cloudRealityAvailable(server)?await unusedPort():null;
  const port=await unusedPort(),statusPort=await unusedPort(),metricsPort=await unusedPort(),folder=join(this.dir,server.id+'-'+port),statusPassword=randomBytes(24).toString('hex');
  mkdirSync(folder,{recursive:true,mode:0o700});
  let sshTransport,entry;
  try{
   if(ssh)sshTransport=await this.sshStart(server,{stateDir:this.dir,signal});
   const config=join(folder,'xray.json'),frpc=join(folder,'frpc.json');
   const ingress=ingressConfig(server,port,{mixedPort:this.mixedPort,metricsPort,vlessPort:vlessLocalPort});if(this.diagnostics)ingress.log.loglevel='debug';
   writeFileSync(config,JSON.stringify(ingress),{mode:0o600});
   writeFileSync(join(folder,'tls.crt'),server.secrets.tlsCert,{mode:0o600});
   const tunnel=frpcConfig(server,port,folder,{statusPort,statusPassword,gateway,sshTransport,vlessLocalPort});if(this.diagnostics)tunnel.log.level='debug';
   writeFileSync(frpc,JSON.stringify(tunnel),{mode:0o600});
   const validator=new XraySupervisor({binary:this.xray,stateDir:this.dir});
   await validator.validate(config);const result=await execute(this.frpc,['verify','-c',frpc]);if(result.code!==0)throw new AccessPointError('frp rejected the relay configuration.',502);
   signal?.throwIfAborted();await this.stop(server.id);
   entry={generation:randomBytes(16).toString('hex'),metricsPort,folder,statusPort,statusPassword,protocol:server.protocol,expectedProxies:tunnel.proxies.map(({name,type})=>({name,type})),transport:ssh?'ssh':gateway?'gateway':'direct',sshTransport,processes:[],stopped:false};this.entries.set(server.id,entry);
   const launch=(binary,args)=>{const fd=this.diagnostics?openSync(join(folder,'transport.log'),'a',0o600):null;
    let child;try{child=spawn(binary,args,{stdio:fd===null?'ignore':['ignore',fd,fd]});}finally{if(fd!==null)closeSync(fd);}entry.processes.push(child);child.once('error',()=>{});return child;};
   entry.xray=launch(this.xray,['run','-config',config]);
   await validator.ready({process:entry.xray,port});if(vlessLocalPort)await validator.ready({process:entry.xray,port:vlessLocalPort});signal?.throwIfAborted();entry.frpc=launch(this.frpc,['-c',frpc]);
  }catch(error){
   if(entry && this.entries.get(server.id)===entry)await this.stop(server.id);
   else{await sshTransport?.close();rmSync(folder,{recursive:true,force:true});}
   throw error;
  }
 }

 async status(id,{signal}={}){
  const entry=this.entries.get(id);if(!entry)return 'stopped';
  if(entry.sshTransport && (entry.sshTransport.child.exitCode!==null || entry.sshTransport.child.signalCode!==null))return 'error';
  if(entry.processes.some(child=>child.exitCode!==null || child.signalCode!==null || !child.pid))return 'error';
  try{const response=await fetch('http://127.0.0.1:'+entry.statusPort+'/api/status',{headers:{Authorization:'Basic '+Buffer.from('freedomgate:'+entry.statusPassword).toString('base64')},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(2000)]):AbortSignal.timeout(2000)});if(!response.ok)return 'connecting';const result=await response.json();return (entry.expectedProxies?entry.expectedProxies.every(proxy=>result[proxy.type]?.some(item=>item.name===proxy.name && item.status==='running')):result.tcp?.some(item=>item.status==='running')) && (entry.protocol!=='shadowsocks'||result.udp?.some(item=>item.status==='running'))?'active':'connecting';}catch{return 'connecting';}
 }
 async waitActive(id,{signal,timeout=5000}={}){
  const deadline=Date.now()+timeout;
  do{
   signal?.throwIfAborted();const state=await this.status(id,{signal});
   if(state==='active')return true;
   if(state==='error'||state==='stopped')return false;
   await delay(200,undefined,{signal});
  }while(Date.now()<deadline);
  return false;
 }
 async sample(id){
  const entry=this.entries.get(id);if(!entry || entry.sampling)return entry?.sampling;
  entry.sampling=(async()=>{const response=await fetch('http://127.0.0.1:'+entry.metricsPort+'/debug/vars',{signal:AbortSignal.timeout(2000)});if(!response.ok)throw Error('Metrics unavailable');const data=await response.json();this.onTraffic?.(id,entry.generation,data.stats?.user || {});})().finally(()=>{entry.sampling=null;});return entry.sampling;
 }
 async stop(id){
  const entry=this.entries.get(id);if(!entry)return;await this.sample(id).catch(()=>{});this.entries.delete(id);entry.stopped=true;
  await Promise.all(entry.processes.map(child=>new Promise(resolve=>{if(child.exitCode!==null || child.signalCode!==null || !child.pid)return resolve();const timer=setTimeout(()=>{child.kill('SIGKILL');},2000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.once('error',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');})));
  await entry.sshTransport?.close();rmSync(entry.folder,{recursive:true,force:true});
 }
 async close(){await Promise.all([...this.entries.keys()].map(id=>this.stop(id)));}
}
