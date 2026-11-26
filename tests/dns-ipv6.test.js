import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dnsMatrixProviders} from '../server/dns-matrix-catalog.js';
import {diagnoseGatewayDns,compareDnsPaths} from '../server/gateway-dns-matrix.js';
import {dnsEvidence} from '../shared/diagnostic-evidence.js';

test('IPv6 endpoints use the common catalog without falling back to IPv4 or changing DNS policy',()=>{
 for(const id of ['cloudflare','cloudflare-family','google','quad9']){
  const [v4]=dnsMatrixProviders([id]),[v6]=dnsMatrixProviders([id],6);
  assert.equal(v6.filtering,v4.filtering);
  for(const transport of ['udp','tcp','dot','doh']){assert.match(v6.endpoints[transport].address,/:/);assert.equal(v6.endpoints[transport].servername,v4.endpoints[transport].servername);}
 }
 assert.throws(()=>dnsMatrixProviders(['google'],5));
});

test('gateway IPv6 matrix preserves transport family separately from A/AAAA and verifies its listener',async()=>{
 const rows=[];
 const report=await diagnoseGatewayDns({id:'gateway',profiles:[{id:'gateway',engine:'xray'}],endpoint:{port:28000},name:'example.com',providers:['google'],family:6,allocatePort:async()=>45000,
  observe:async context=>{assert.match(context.url,/https:\/\/\[2001:4860/);return {finish:async()=>({state:'verified'})};},
  request:async request=>{rows.push(request);return {state:'ok',rcode:0,answers:[],localAddress:'127.0.0.1',localPort:45000};}});
 assert.equal(report.family,6);assert.equal(rows.length,16);assert.ok(rows.every(row=>row.provider.family===6));assert.equal(report.state,'ok');
 assert.ok(dnsEvidence(report).rows.every(row=>row.target.includes('IPv6')));
 assert.deepEqual(compareDnsPaths({...report,family:4},report),[]);
});

test('Python IPv6 sockets, CONNECT authority and SOCKS UDP framing never use IPv4 destinations',()=>{
 const result=spawnSync('python3',['-c',String.raw`
import importlib.util,socket,struct,time
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('m','server/dns-matrix.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Sock:
 def __init__(self):self.data=b'';self.options={};self.reply=b'HTTP/1.1 200 OK\r\n\r\n'
 def settimeout(self,*args):pass
 def bind(self,*args):pass
 def connect(self,peer):self.peer=peer
 def sendall(self,data):self.data+=data
 def recv(self,n):out=self.reply[:n];self.reply=self.reply[n:];return out
 def close(self):pass
s=Sock()
with patch.object(m.socket,'socket',return_value=s):
 m.proxy_socket({'port':12345,'localPort':45000,'secret':'fixture'},'2001:db8::7',853,time.monotonic()+5)
 assert b'CONNECT [2001:db8::7]:853' in s.data,s.data
class Udp(Sock):
 def send(self,data):self.data=data
u=Udp();c=Sock();c.reply=bytes.fromhex('05020100050000017f0000013039')
with patch.object(m.socket,'socket',side_effect=[u,c]):
 relay=m.ProxyUdpSocket({'port':12345,'localPort':45000,'secret':'fixture'},'2001:db8::7',53,time.monotonic()+5)
 relay.send(b'dns');assert u.data[:4]==bytes.fromhex('00000004') and u.data[4:20]==socket.inet_pton(socket.AF_INET6,'2001:db8::7')
 u.reply=u.data;assert relay.recv(10)==b'dns';relay.close()
p={'id':'fixture','family':6,'endpoints':{'udp':{'address':None,'servername':'dns.example','port':53}}}
with patch.object(m.socket,'socket',side_effect=AssertionError('No fallback allowed')):
 r=m.attempt('eth0',p,'udp','example.com',1,1,time.monotonic()+5);assert r['state']=='unavailable' and r['reason']=='resolver-ipv6-unavailable',r
with patch.object(m.subprocess,'run') as run:
 run.return_value.stdout='[{"dev":"eth0"}]';m.route_to('2001:db8::7','eth0');assert run.call_args[0][0][1]=='-6'
`],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);
});
