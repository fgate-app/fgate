import {spawn} from 'node:child_process';
const failure=code=>Object.assign(Error(code==='ABORTED'?'Diagnostic cancelled.':'Diagnostic worker failed.'),{code});
// One bounded JSON reply; optional body is consumed without retaining it.
// Neither raw output nor operating-system error details escape this boundary.
export function runJsonWorker(command,args,{input='',signal,timeoutMs,spawnProcess=spawn,jsonStream='stdout',onBody,maxBytes=65536}={}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(failure('ABORTED'));
  let child,timer,settled=false,size=0;const chunks=[];
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const kill=()=>{try{child?.kill('SIGKILL');}catch{}};
  const stop=code=>{finish(failure(code));kill();};
  const abort=()=>stop('ABORTED');
  try{child=spawnProcess(command,args,{stdio:['pipe','pipe','pipe']});}catch{return finish(failure('UNAVAILABLE'));}
  child.on('error',()=>finish(failure('UNAVAILABLE')));
  child.on('close',exitCode=>{if(settled)return;try{const value=JSON.parse(Buffer.concat(chunks).toString());if(!value || typeof value!=='object' || Array.isArray(value))throw Error();finish(null,{value,exitCode});}catch{finish(failure('INVALID_RESPONSE'));}});
  const metadata=jsonStream==='stderr'?child.stderr:child.stdout,body=jsonStream==='stderr'?child.stdout:child.stderr;
  metadata.on('data',chunk=>{if(settled)return;size+=chunk.length;if(size>maxBytes){finish(Object.assign(failure('INVALID_RESPONSE'),{limitExceeded:true}));kill();}else chunks.push(chunk);});
  if(onBody)body.on('data',chunk=>{if(settled)return;try{if(onBody(chunk)===false)kill();}catch{stop('INVALID_RESPONSE');}});else body.resume();
  child.stdin.on('error',()=>{});
  timer=setTimeout(()=>stop('TIMEOUT'),timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)return abort();
  try{child.stdin.end(input);}catch{stop('UNAVAILABLE');}
 });
}
export function gatewayCurlConfig(endpoint,url){
 return `proxy = "${endpoint.type==='socks5'?'socks5h':'http'}://127.0.0.1:${endpoint.port}"\n${endpoint.secret===undefined?'':`proxy-user = ${JSON.stringify('fg-geo:'+endpoint.secret)}\n`}url = ${JSON.stringify(url)}\n`;
}
