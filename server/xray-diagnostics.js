import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {XraySupervisor} from './xray.js';
import {requestDiagnostic} from './gateway-diagnostics.js';

// Only fixed classifications leave this collector. No raw log, destination,
// access ID, certificate or provider-controlled error text enters the report.
export function xrayEventCollector(){
 const events=new Set();let pending='',bytes=0,truncated=false;
 const line=value=>{
  if(/\bcore: Xray .* started\s*$/.test(value))return;
  if(/(?:REALITY|tls:|x509:|TLS handshake)/i.test(value) && /(?:failed|failure|invalid|error|mismatch|unknown authority|expired|cannot|rejected)/i.test(value))events.add('secure-handshake-failed');
  else if(/(?:dial tcp|failed to dial|failed to connect)/i.test(value) && /(?:connection refused|network is unreachable|no route to host|i\/o timeout|connection timed out)/i.test(value))events.add('server-connect-failed');
  else if(/\[(?:Warning|Error)\]/i.test(value))events.add('unrecognized-event');
 };
 return {push(chunk){if(bytes>=65536){truncated=true;return;}const text=chunk.toString();bytes+=Buffer.byteLength(text);pending=(pending+text).slice(-16384);let i;while((i=pending.indexOf('\n'))>=0){line(pending.slice(0,i));pending=pending.slice(i+1);}},snapshot(){if(pending)line(pending);return {events:[...events],truncated};}};
}
export function xrayConnectionFinding(evidence,{responseVerified=false,configChanged=false}={}){
 const events=evidence.events || [];
 // Real secure application data is required; silence and local port readiness
 // cannot establish a successful remote tunnel.
 const reason=configChanged?'configuration-changed':responseVerified?'secure-response':events.includes('secure-handshake-failed')?'secure-handshake-failed':events.includes('server-connect-failed')?'server-connect-failed':'insufficient-evidence';
 return {state:reason==='secure-response'?'ok':['secure-handshake-failed','server-connect-failed'].includes(reason)?'failed':'unavailable',reason,events:events.filter(value=>['secure-handshake-failed','server-connect-failed','unrecognized-event'].includes(value)),truncated:evidence.truncated===true,scope:'isolated-xray-connection'};
}

export async function diagnoseXrayConnection({row,binary,stateDir=tmpdir(),target,signal,request=requestDiagnostic,create=options=>new XraySupervisor(options)}){
 const collector=xrayEventCollector(),folder=mkdtempSync(join(stateDir,'xray-diagnostic-'));
 let client;
 try{
  client=create({binary,stateDir:folder,diagnosticLog:chunk=>collector.push(chunk)});
  if(signal?.aborted)throw Error('Diagnostic cancelled.');
  const prepared=await client.prepare([{...row,profile_id:'diagnostic'}]);await prepared.commit();
  if(signal?.aborted)throw Error('Diagnostic cancelled.');
  const raw=await request({port:prepared.bridges.diagnostic.port,type:'socks5',secret:''},target,{signal});
  return xrayConnectionFinding(collector.snapshot(),{responseVerified:raw.exitCode===0 && Number(raw.time_appconnect)>0 && Number(raw.response_code ?? raw.http_code)>0});
 }catch{
  if(signal?.aborted)throw Error('Diagnostic cancelled.');
  return xrayConnectionFinding(collector.snapshot());
 }finally{try{await client?.stop();}finally{rmSync(folder,{recursive:true,force:true});}}
}
