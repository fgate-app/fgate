import {spawn} from 'node:child_process';

// A server listen(0) enables SO_REUSEADDR and may select a TIME_WAIT port
// that curl cannot bind. Use the same plain client bind as the probe instead.
// The socket closes before handoff; a later competing bind still fails closed.
const script="import socket\ns=socket.socket(socket.AF_INET,socket.SOCK_STREAM)\ns.bind(('127.0.0.1',0))\nprint(s.getsockname()[1])\ns.close()";
export function allocateDiagnosticTcpPort({signal,spawnProcess=spawn,timeoutMs=2000}={}){
  return new Promise((resolve,reject)=>{
    const cancelled=()=>Object.assign(Error('Diagnostic cancelled.'),{code:'ABORTED'});
    if(signal?.aborted){reject(cancelled());return;}
    const child=spawnProcess('python3',['-I','-c',script],{stdio:['ignore','pipe','ignore']});
    let output='',failure;
    const stop=error=>{failure??=error;child.kill('SIGKILL');};
    const abort=()=>stop(cancelled());
    const timer=setTimeout(()=>stop(Error('Diagnostic port allocation timed out.')),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>32)stop(Error('Invalid diagnostic port allocation.'));});
    child.once('error',error=>{failure??=error;});
    child.once('close',code=>{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);
      const port=Number(output.trim());
      if(failure)reject(failure);
      else if(code!==0 || !/^\d+\s*$/.test(output) || !Number.isInteger(port) || port<1024 || port>65535)reject(Error('Invalid diagnostic port allocation.'));
      else resolve(port);
    });
  });
}
