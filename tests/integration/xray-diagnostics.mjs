// Controlled real Xray tests. No private profiles or production routes required.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import https from 'node:https';
import {once} from 'node:events';
import {XraySupervisor,unusedPort} from '../../server/xray.js';
import {diagnoseXrayConnection} from '../../server/xray-diagnostics.js';
const folder=mkdtempSync(join(tmpdir(),'fg-xray-native-')),binary=new XraySupervisor().binary;
const uuid='c761077e-69c6-4f67-a18f-f94cc4b22426';let server,origin;
try{
 const cert=join(folder,'cert.pem'),key=join(folder,'key.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
 origin=https.createServer({key:readFileSync(key),cert:readFileSync(cert)},(_req,res)=>{res.writeHead(204);res.end();});origin.listen(0,'127.0.0.1');await once(origin,'listening');
 const port=await unusedPort(),plainPort=await unusedPort(),closed=await unusedPort(),config=join(folder,'server.json');
 writeFileSync(config,JSON.stringify({log:{loglevel:'info'},inbounds:[{listen:'127.0.0.1',port:plainPort,protocol:'vless',settings:{clients:[{id:uuid}],decryption:'none'},streamSettings:{network:'tcp',security:'none'}},{listen:'127.0.0.1',port,protocol:'vless',settings:{clients:[{id:uuid}],decryption:'none'},streamSettings:{network:'tcp',security:'tls',tlsSettings:{certificates:[{certificateFile:cert,keyFile:key}]}}}],outbounds:[{protocol:'freedom',settings:{finalRules:[{action:'allow',ip:['127.0.0.1/32']}]}}]}),{mode:0o600});
 server=spawn(binary,['run','-config',config],{stdio:'ignore'});
 for(let n=0;n<50;n++){try{await fetch('http://127.0.0.1:'+port,{signal:AbortSignal.timeout(100)});break;}catch{}await new Promise(r=>setTimeout(r,50));if(n===49)assert.equal(server.exitCode,null);}
 const request=async endpoint=>{
  const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
  try{const {stdout}=await promisify(execFile)('curl',['--disable','--silent','--noproxy','','--proxy','socks5h://127.0.0.1:'+endpoint.port,'--cacert',cert,'--max-time','5','--output','/dev/null','--write-out','%{json}','https://127.0.0.1:'+origin.address().port+'/'],{timeout:7000,maxBuffer:65536});const raw=JSON.parse(stdout);return {...raw,exitCode:0};}
  catch(error){let raw={};try{raw=JSON.parse(error.stdout);}catch{}return {...raw,exitCode:Number(error.code)||1};}
 };
 const reports=[];
 for(const [name,p,sni,expected] of [['success',plainPort,'localhost','secure-response'],['unreachable',closed,'localhost','server-connect-failed'],['tls-mismatch',port,'wrong.example','secure-handshake-failed'],['reality-mismatch',port,'localhost','secure-handshake-failed']]){
  const row={engine:'xray',config:JSON.stringify({outbounds:[{protocol:'vless',settings:{vnext:[{address:'127.0.0.1',port:p,users:[{id:uuid,encryption:'none'}]}]},streamSettings:{network:'tcp',security:name==='success'?'none':name==='reality-mismatch'?'reality':'tls',...(name==='success'?{}:name==='reality-mismatch'?{realitySettings:{serverName:sni,fingerprint:'chrome',publicKey:Buffer.alloc(32,1).toString('base64url'),shortId:'00'}}:{tlsSettings:{serverName:sni}})}}]})};
  const result=await diagnoseXrayConnection({row,binary,stateDir:folder,target:'https://example.com/',request});assert.equal(result.reason,expected,name+': '+JSON.stringify(result));reports.push({name,...result});
 }
 assert.ok(!JSON.stringify(reports).includes(uuid));console.log(JSON.stringify({platform:process.arch,passed:true,reports}));
}finally{
 if(server && server.exitCode===null){const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;}
 if(origin)await new Promise(r=>origin.close(r));rmSync(folder,{recursive:true,force:true});
}
