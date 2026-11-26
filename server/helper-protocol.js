import {diagnosticActions} from './network-helper.js';

// Legacy operations are EOF-delimited and continue after disconnect. Only
// bounded diagnostics with owned temporary resources accept newline framing and cancellation on disconnect.
export function serveHelperConnection(socket, handle) {
  socket.setEncoding('utf8');
  let raw='',started=false,finished=false,cancellable=false;
  const controller=new AbortController();
  const cancel=()=>{if(cancellable && !finished)controller.abort();};
  const dispatch=async (text,framed)=>{
    if(started)return;
    started=true;
    try{
      const request=JSON.parse(text);
      if(!request || typeof request!=='object' || Array.isArray(request))throw Error('Invalid request.');
      cancellable=framed && diagnosticActions.has(request.action);
      if(framed && !cancellable)throw Error('Invalid framing.');
      const result=await handle(request,{signal:cancellable?controller.signal:undefined});
      if(!socket.destroyed && !controller.signal.aborted)socket.end(JSON.stringify(result));
    }catch(error){
      if(!socket.destroyed && !controller.signal.aborted)socket.end(JSON.stringify({ok:false,error:error.userFacing?error.message:'The helper request failed.'}));
    }finally{finished=true;}
  };
  socket.on('data',chunk=>{
    if(started){cancel();socket.destroy();return;}
    raw+=chunk;
    if(Buffer.byteLength(raw)>64*1024){socket.destroy();return;}
    const newline=raw.indexOf('\n');
    if(newline!==-1){
      if(raw.slice(newline+1).trim()){socket.destroy();return;}
      void dispatch(raw.slice(0,newline),true);
    }
  });
  socket.on('end',()=>{if(started){cancel();socket.destroy();}else void dispatch(raw,false);});
  socket.on('close',cancel);
  socket.on('error',cancel);
}
