// Run in an isolated network namespace; only synthetic keys and loopback servers.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,openSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {parse} from 'yaml';
import {nativeFixtures} from './fixtures/mihomo-proxies.js';
import {normalizeMihomoProxy} from '../shared/mihomo-proxy.js';
import {Store} from '../server/store.js';
import {buildMihomoConfig} from '../server/mihomo.js';
import {defaultDnsSettings} from '../server/dns-resolvers.js';
import {unusedPort} from '../server/xray.js';
const mihomo=process.env.FREEDOMGATE_MIHOMO,xray=process.env.FREEDOMGATE_XRAY;
assert.ok(mihomo && xray,'Set explicit installed-engine paths.');
const root=mkdtempSync(join(tmpdir(),'fg-mihomo-native-')),children=[],servers=[],checks=[],traffic=[];
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const launch=(binary,args)=>{const fd=openSync(join(root,'engine.log'),'a',0o600);try{const child=spawn(binary,args,{stdio:['ignore',fd,fd]});children.push(child);return child;}finally{closeSync(fd);}};
async function ready(port,child){for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('Fixture engine exited.');if(await new Promise(resolve=>{const s=net.connect(port,'127.0.0.1');s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));}))return;await wait(50);}throw Error('Fixture engine did not listen.');}
const listen=async server=>{servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port;};
try{
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem'),'-days','1','-subj','/CN=fixture'],{stdio:'ignore'});
 for(const [type,fields] of Object.entries(nativeFixtures)){
  const dir=mkdtempSync(join(root,'check-')),node={type,server:'192.0.2.1',port:443,...fields};
  if(['tailscale','zerotier','easytier'].includes(type)){delete node.server;delete node.port;}
  if(type==='openvpn')node.ca=readFileSync(join(root,'cert.pem'),'utf8');
  const config={mode:'rule','log-level':'silent',dns:{enable:false},proxies:[{...normalizeMihomoProxy(node),name:'fixture'}],rules:['MATCH,fixture']};
  const file=join(dir,'config.json');writeFileSync(file,JSON.stringify(config),{mode:0o600});
  try{execFileSync(mihomo,['-t','-d',dir,'-f',file],{timeout:10000,stdio:'pipe'});checks.push({type,passed:true});}
  catch(error){checks.push({type,passed:false,error:String(error.stdout || '')+String(error.stderr || '')});}
 }
 const body=Buffer.alloc(32768,97),targetPort=await listen(http.createServer((_req,res)=>res.end(body)));let fixtureRelayPort;
 for(const type of ['http','socks5','ss','vmess','vless','trojan']){
  const port=type==='http'?null:await unusedPort();let proxyPort=port,upstream,child,httpRequests=0;
  const password='synthetic-native-fixture',uuid=nativeFixtures.vmess.uuid;
  if(type==='http'){
   upstream=http.createServer((req,res)=>{if(req.headers['proxy-authorization']!=='Basic '+Buffer.from('fixture:'+password).toString('base64')){res.writeHead(407);res.end();return;}const url=new URL(req.url);assert.equal(url.hostname,'127.0.0.1');assert.equal(Number(url.port),targetPort);const out=http.request(url,{method:req.method},incoming=>{res.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(res);});out.on('error',()=>res.destroy());req.pipe(out);});
   upstream.on('connect',(req,socket,head)=>{
    const address=new URL('http://'+req.url);assert.equal(address.hostname,'127.0.0.1');assert.equal(Number(address.port),targetPort);
    if(req.headers['proxy-authorization']!=='Basic '+Buffer.from('fixture:'+password).toString('base64')){socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');return;}
    httpRequests++;const remote=net.connect(targetPort,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);socket.pipe(remote);remote.pipe(socket);});
    remote.on('error',()=>socket.destroy());socket.on('error',()=>remote.destroy());socket.on('close',()=>remote.destroy());
   });
   proxyPort=await listen(upstream);fixtureRelayPort=proxyPort;
  }else{
   const settings=type==='socks5'?{auth:'password',accounts:[{user:'fixture',pass:password}]}:type==='ss'?{method:'aes-128-gcm',password,network:'tcp'}:type==='vless'?{clients:[{id:uuid}],decryption:'none'}:type==='vmess'?{clients:[{id:uuid,alterId:0}]}:{clients:[{password}]};
   const inbound={listen:'127.0.0.1',port,protocol:type==='socks5'?'socks':type==='ss'?'shadowsocks':type,settings};
   if(type==='trojan')inbound.streamSettings={network:'tcp',security:'tls',tlsSettings:{certificates:[{certificateFile:join(root,'cert.pem'),keyFile:join(root,'key.pem')}]}};
   // Delegate fixture loopback traffic: Xray's built-in SS final rule blocks
   // private targets on a freedom outbound. No production policy is changed.
   const outbound={protocol:'http',settings:{servers:[{address:'127.0.0.1',port:fixtureRelayPort,users:[{user:'fixture',pass:password}]}]}};
   const file=join(root,type+'-server.json');writeFileSync(file,JSON.stringify({log:{loglevel:'warning',access:join(root,type+'-access.log')},inbounds:[inbound],outbounds:[outbound]}),{mode:0o600});child=launch(xray,['run','-c',file]);await ready(port,child);
  }
  const node={type,server:'127.0.0.1',port:proxyPort,...(type==='ss'?{cipher:'aes-128-gcm',password}:['vmess','vless'].includes(type)?{uuid,...(type==='vmess'?{alterId:0,cipher:'auto'}:{})}:type==='trojan'?{password,'skip-cert-verify':true,sni:'fixture'}:{username:'fixture',password})};
  const store=new Store(':memory:');
  try{
   const profile=store.importProfiles({value:JSON.stringify({proxies:[{...node,name:'Fixture '+type}]})})[0];
   store.addRouteGroup({name:'Fixture route',entries:['127.0.0.1/32'],routeId:profile.id});
   const mixedPort=await unusedPort(),config=parse(buildMihomoConfig({...defaultDnsSettings,enhancedMode:'redir-host'},{mixedPort},{profiles:store.profiles(),configs:store.db.prepare('SELECT * FROM profile_configs').all(),groups:store.routeGroups(),devices:[]}));
   config.tun.enable=false;config.dns.enable=false;config.listeners=[];delete config['external-controller'];
   const dir=mkdtempSync(join(root,'traffic-')),file=join(dir,'config.json');writeFileSync(file,JSON.stringify(config),{mode:0o600});
   const core=launch(mihomo,['-d',dir,'-f',file]);await ready(mixedPort,core);
   const result=await new Promise((resolve,reject)=>{const c=spawn('curl',['-fsS','--max-time','10','--noproxy','','--proxy','socks5h://127.0.0.1:'+mixedPort,'http://127.0.0.1:'+targetPort+'/fixture']);const data=[];c.stdout.on('data',chunk=>data.push(chunk));c.once('error',reject);c.once('exit',code=>code===0?resolve(Buffer.concat(data)):reject(Error('Native traffic failed: '+type)));});
   assert.ok(body.equals(result));
   if(type==='http')assert.ok(httpRequests>0,'The fixture proxy must receive the request.');
   else assert.ok(readFileSync(join(root,type+'-access.log'),'utf8').includes('tcp:127.0.0.1:'+targetPort),'The request must traverse the fixture proxy.');
   traffic.push({type,passed:true,bytes:result.length});core.kill('SIGTERM');
  }finally{store.close();child?.kill('SIGTERM');}
 }
 const report={configuration:checks,traffic};
 if(process.env.FREEDOMGATE_NATIVE_REPORT)writeFileSync(process.env.FREEDOMGATE_NATIVE_REPORT,JSON.stringify(report,null,2)+'\n');
 assert.ok(checks.every(row=>row.passed),JSON.stringify(checks.filter(row=>!row.passed)));
 console.log('PASS: '+checks.length+' native configurations; '+traffic.length+' imported proxy transports returned the exact 32 KiB fixture.');
}catch(error){
 console.error(readFileSync(join(root,'engine.log'),'utf8').slice(-6000));
 throw error;
}finally{
 await Promise.all(children.map(child=>new Promise(resolve=>{if(child.exitCode!==null || child.signalCode!==null)return resolve();const timer=setTimeout(()=>child.kill('SIGKILL'),2000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');})));
 for(const server of servers)await new Promise(resolve=>server.close(resolve));
 rmSync(root,{recursive:true,force:true});
}
