import http from 'node:http';
import {connect as tlsConnect} from 'node:tls';

// Probe through the same mihomo route as clients; a bare TLS handshake is
// insufficient evidence even for page availability (and says nothing about video).
export function probeTarget(target, timeout = 10000) {
  return new Promise(resolve => {
    let socket, settled=false;
    const request=http.request({host:'127.0.0.1',port:7890,method:'CONNECT',path:`${target}:443`});
    const timer=setTimeout(()=>finish(false),timeout);
    function finish(ok) {
      if(settled)return;
      settled=true;clearTimeout(timer);socket?.destroy();request.destroy();resolve(ok);
    }
    request.once('connect',(response,tunnel)=>{
      if(response.statusCode!==200){tunnel.destroy();finish(false);return;}
      socket=tlsConnect({socket:tunnel,servername:target,rejectUnauthorized:true});
      socket.once('secureConnect',()=>socket.write(`HEAD / HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`));
      let headers='';
      socket.on('data',chunk=>{
        headers+=chunk.toString();
        if(headers.includes('\r\n'))finish(/^HTTP\/1\.[01] [23]\d\d /.test(headers));
        else if(headers.length>16384)finish(false);
      });
      socket.once('error',()=>finish(false));socket.once('end',()=>finish(false));
    });
    request.once('error',()=>finish(false));request.end();
  });
}

