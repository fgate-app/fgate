// Controlled REALITY camouflage endpoint, equivalent to the Tor integration fixture.
import http2 from 'node:http2';
import {readFileSync} from 'node:fs';
const server=http2.createSecureServer({allowHTTP1:true,key:readFileSync(process.argv[2]),cert:readFileSync(process.argv[3]),minVersion:'TLSv1.3',ecdhCurve:'X25519',ALPNProtocols:['h2','http/1.1']});
server.on('stream',stream=>{stream.on('error',()=>{});stream.respond({':status':200});stream.end('camouflage');});
server.on('request',(req,res)=>{if(req.httpVersionMajor===1)res.end('camouflage');});
server.on('sessionError',()=>{});
server.on('tlsClientError',()=>{});server.listen(18555,'127.0.0.1',()=>console.log('ready'));
