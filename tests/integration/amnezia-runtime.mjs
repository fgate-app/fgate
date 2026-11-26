// Opt-in test of the real private profile. Prints HTTP statuses only.
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {spawn,execFile,execFileSync} from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';
import {XraySupervisor} from '../../server/xray.js';
import {normalizeXrayProfile} from '../../server/xray-profile.js';
import {buildMihomoConfig} from '../../server/mihomo.js';
import {defaultDnsSettings} from '../../server/dns-resolvers.js';
const run=promisify(execFile);
const source=process.env.FREEDOMGATE_PRIVATE_XRAY;
const fixtureMode=process.env.FREEDOMGATE_XRAY_FIXTURE==='1';
if(!source && !fixtureMode)throw Error('Set FREEDOMGATE_PRIVATE_XRAY to a private Amnezia or Xray JSON file.');
const folder=mkdtempSync(join(tmpdir(),'fg-amnezia-acceptance-'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function port(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;}
const xray=new XraySupervisor({stateDir:folder});let core, fixtureCore, fixtureServer;
try{
 let input, targets;
 if(fixtureMode){
  fixtureServer=http.createServer((_req,res)=>{res.writeHead(204);res.end();});
  await new Promise(resolve=>fixtureServer.listen(0,'127.0.0.1',resolve));
  targets=[[`http://127.0.0.1:${fixtureServer.address().port}/probe`,'204']];
  const serverPort=await port(),uuid='c761077e-69c6-4f67-a18f-f94cc4b22426';
  const serverFile=join(folder,'fixture-server.json');
  writeFileSync(serverFile,JSON.stringify({log:{loglevel:'error'},inbounds:[{listen:'127.0.0.1',port:serverPort,protocol:'vless',settings:{clients:[{id:uuid}],decryption:'none'},streamSettings:{network:'tcp',security:'none'}}],outbounds:[{protocol:'freedom',settings:{finalRules:[{action:'allow',ip:['127.0.0.1/32']}]}}]}),{mode:0o600});
  fixtureCore=spawn(xray.binary,['run','-config',serverFile],{stdio:'ignore'});
  input={outbounds:[{protocol:'vless',settings:{vnext:[{address:'127.0.0.1',port:serverPort,users:[{id:uuid,encryption:'none'}]}]},streamSettings:{network:'tcp',security:'none'}}]};
  await wait(500);
 }else{input=readFileSync(source,'utf8');targets=[['https://www.gstatic.com/generate_204','204'],['https://www.cloudflare.com/cdn-cgi/trace','200']];}
 const config=normalizeXrayProfile(input);
 const id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',row={profile_id:id,engine:'xray',config:JSON.stringify(config)};
 const prepared=await xray.prepare([row]);await prepared.commit();
 const {stdout:directResult}=await run('curl',['--noproxy','','--silent','--output','/dev/null','--write-out','%{http_code}','--max-time','20','--proxy',`socks5h://127.0.0.1:${prepared.bridges[id].port}`,targets[0][0]],{encoding:'utf8',timeout:25000});
 assert.equal(directResult,'204');console.log('Direct managed Xray: HTTP '+directResult);
 const again=await xray.prepare([row]);assert.equal(again.bridges[id].port,prepared.bridges[id].port);await again.rollback();
 const mixedPort=await port(),controllerPort=await port(),dnsPort=await port();
 const settings=structuredClone(defaultDnsSettings);
 let yaml=buildMihomoConfig(settings,{mixedPort,controllerPort,dnsPort,controllerSecret:'isolated-test'},{profiles:[{id,engine:'xray'}],configs:[row],devices:[],groups:[],connectionGroups:[{id:'auto',members:[id]}],bridges:prepared.bridges});
 yaml=yaml.replace('tun:\n  enable: true','tun:\n  enable: false').replace('MATCH,DIRECT','MATCH,cg-auto');
 // DNS to the test target must also travel through the imported VPN.
 yaml=yaml.replace(/  nameserver:\n(?:    - .*\n)+/,'  nameserver:\n    - "https://1.1.1.1/dns-query#cg-auto"\n');
 const file=join(folder,'mihomo.yaml');writeFileSync(file,yaml,{mode:0o600});
 const binary=process.env.FREEDOMGATE_MIHOMO || '/opt/freedomgate/modules/mihomo/v1.19.33/mihomo';
 execFileSync(binary,['-t','-d',folder,'-f',file],{stdio:'ignore',timeout:15000});
 core=spawn(binary,['-d',folder,'-f',file],{stdio:'ignore'});
 for(let n=0;n<100;n++){try{const response=await fetch(`http://127.0.0.1:${controllerPort}/version`,{headers:{Authorization:'Bearer isolated-test'},signal:AbortSignal.timeout(500)});if(response.ok)break;}catch{}if(n===99)throw Error('Mihomo not ready');await wait(100);}
 for(const [url,expected] of targets){
  const {stdout:result}=await run('curl',['--noproxy','','--silent','--output','/dev/null','--write-out','%{http_code}','--max-time','25','--proxy',`socks5h://127.0.0.1:${mixedPort}`,url],{encoding:'utf8',timeout:30000});
  assert.equal(result,expected);console.log('Amnezia → Xray → mihomo group: '+new URL(url).hostname+' HTTP '+result);
 }
 // Exercise the watchdog without changing system networking.
 const entry=xray.entries.get(id),old=entry.process.pid;entry.process.kill('SIGKILL');
 for(let n=0;n<100;n++){if(entry.process?.pid && entry.process.pid!==old)break;await wait(100);}
 assert.notEqual(entry.process?.pid,old);await xray.ready(entry);
 console.log('Xray listener reuse and watchdog restart passed.');
}catch(error){if(fixtureMode){for(const entry of xray.entries.values()){console.error(readFileSync(join(entry.folder,'xray.log'),'utf8'));}}throw error;
}finally{
 if(core){core.kill('SIGTERM');await new Promise(resolve=>core.once('exit',resolve));}
 await xray.stop();
 if(fixtureCore){fixtureCore.kill('SIGTERM');await new Promise(resolve=>fixtureCore.once('exit',resolve));}
 if(fixtureServer)await new Promise(resolve=>fixtureServer.close(resolve));
 rmSync(folder,{recursive:true,force:true});
}
