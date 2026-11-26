#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import http from 'node:http';import net from 'node:net';import dgram from 'node:dgram';
if(process.argv.includes('-t'))process.exit(0);
const text=readFileSync(process.argv[process.argv.indexOf('-f')+1],'utf8');
const port=Number(text.match(/^mixed-port: (\d+)/m)[1]);
const controller=Number(text.match(/^external-controller:.*:(\d+)/m)[1]);
const dns=Number(text.match(/^  listen:.*:(\d+)/m)[1]);
let loads=0;
http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
 if(req.method==='PUT'){if(readFileSync(JSON.parse(body).path,'utf8').includes('fail.invalid')){res.writeHead(500);res.end();return;}loads++;res.writeHead(204);res.end();return;}
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/rules'?{rules:[]}:req.url==='/connections'?{connections:[]}:{loads}));
});}).listen(controller,'127.0.0.1');
net.createServer(socket=>socket.on('data',data=>socket.write(data))).listen(port,'127.0.0.1');
const udp=dgram.createSocket('udp4');udp.on('message',(message,peer)=>{const reply=Buffer.from(message);reply[2]=0x81;reply[3]=0x80;udp.send(reply,peer.port,peer.address);});udp.bind(dns,'127.0.0.1');
