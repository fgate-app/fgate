import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dnsMatrixCatalog,dnsMatrixProviders,normalizeDnsMatrixName} from '../server/dns-matrix-catalog.js';
import {resolvers} from '../server/dns-resolvers.js';
import {exportDiagnosticReport} from '../shared/diagnostic-report.js';

test('matrix endpoints come from the existing resolver catalog and preserve policy',()=>{
 const catalog=dnsMatrixCatalog();assert.ok(catalog.providers.length>2);
 for(const row of catalog.providers){
  const original=resolvers.find(entry=>entry.id===row.id),[provider]=dnsMatrixProviders([row.id]);
  assert.equal(provider.filtering,original.filtering);assert.equal(provider.name,original.name);
  for(const transport of ['udp','tcp','dot','doh'])assert.ok(original.ips.includes(provider.endpoints[transport].address));
  assert.equal(provider.endpoints.doh.servername,new URL(original.protocols.doh).hostname);
 }
 assert.deepEqual(catalog.defaults,dnsMatrixProviders().map(row=>row.id));
 for(const value of [[],['cloudflare','cloudflare'],['missing'],['google','cloudflare','quad9']])assert.throws(()=>dnsMatrixProviders(value));
 assert.equal(normalizeDnsMatrixName('EXAMPLE.COM.'),'example.com');
 for(const value of ['localhost','example.com\r\nHost: x','-bad.example','a..com','a'.repeat(64)+'.com',1])assert.throws(()=>normalizeDnsMatrixName(value));
});

test('DNS parser validates identity, bounded compression, records, RCODE and truncation',()=>{
 const result=spawnSync('python3',['-c',String.raw`
import importlib.util,struct,copy
spec=importlib.util.spec_from_file_location('matrix','server/dns-matrix.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
name='example.com';identifier=123
query=m.query(name,1,identifier)
def response(rcode=0,answers=b'',count=0,flags=0x8180):
 return struct.pack('!6H',identifier,flags|rcode,1,count,0,0)+query[12:]+answers
rr=b'\xc0\x0c'+struct.pack('!HHIH',1,1,60,4)+bytes([203,0,113,7])
packet=response(answers=rr,count=1)
r=m.parse_response(packet,name,1,identifier);assert r['rcode']==0 and r['answers'][0]['value']=='203.0.113.7' and r['answers'][0]['ttl']==60
for rcode in (2,3,5): assert m.parse_response(response(rcode),name,1,identifier)['rcode']==rcode
assert m.parse_response(response(flags=0x8380),name,1,identifier)['truncated']
for data,n,t,i in [(packet,name,1,124),(packet,'other.example',1,identifier),(packet,name,28,identifier),(packet[:-1],name,1,identifier),(packet+b'x',name,1,identifier),(b'\0'*5000,name,1,identifier),(response(answers=b'\xc0\x1d'+rr[2:],count=1),name,1,identifier)]:
 try:m.parse_response(data,n,t,i);raise AssertionError('must reject')
 except (ValueError,UnicodeError):pass
# Self-referencing name pointer must not hang.
try:m.read_name(b'\xc0\0',0);raise AssertionError('must reject')
except ValueError:pass
providers=[{'id':'one'},{'id':'two'}]
rows=[{'provider':p['id'],'qtype':q,'state':'ok','routeVerified':True,'truncated':False,'rcode':0,'answers':[{'name':name,'type':'A','value':'203.0.113.7','ttl':n}]} for p in providers for q in ('A','AAAA') for n in range(8)]
assert all(row['state']=='matched' for row in m.comparisons(rows,providers))
rows[0]['answers'][0]['value']='203.0.113.8'
assert m.comparisons(rows,providers)[0]['state']=='different'
assert m.comparisons(rows,providers)[0]['cause'] is None
rows[0]['state']='failed';assert m.comparisons(rows,providers)[0]['state']=='incomplete'
assert m.comparisons(rows,providers)[2]['state']=='matched'
`],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);
});

test('DNS transport binds before connect, validates TLS and never falls back after permission failure',()=>{
 const provider=dnsMatrixProviders(['google'])[0];
 const result=spawnSync('python3',['-c',String.raw`
import importlib.util,socket,time,json,sys,struct,io,ssl
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('matrix','server/dns-matrix.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p=json.loads(sys.argv[1])
class Sock:
 def __init__(self):self.options={};self.payload=b'';self.closed=False;self.connected=False
 def setsockopt(self,l,k,v):self.options[k]=v
 def getsockopt(self,l,k,*a):return self.options[k]
 def settimeout(self,n):assert 0<n<=3
 def connect(self,peer):assert self.options[36]==m.MARK and self.options[25]==b'eth0\0';self.connected=True
 def getsockname(self):return ('192.168.1.86',45678)
 def getpeername(self):return ('8.8.8.8',53)
 def send(self,payload):self.payload=payload
 def sendall(self,payload):self.payload=payload
 def recv(self,n):
  if self.payload[0:2]==b'\0\x01':return self.reply() # UDP ID fixed to 1
  if not hasattr(self,'buffer'):self.buffer=struct.pack('!H',len(self.reply()))+self.reply()
  out=self.buffer[:n];self.buffer=self.buffer[n:];return out
 def reply(self):return struct.pack('!6H',1,0x8183,1,0,0,0)+m.query('example.com',1,1)[12:]
 def close(self):self.closed=True
 def version(self):return 'TLSv1.3'
 def makefile(self,*args):
  body=self.reply()
  return io.BytesIO(b'HTTP/1.1 200 OK\r\nContent-Type: application/dns-message\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body)
for transport in ('udp','tcp','dot','doh'):
 s=Sock()
 with patch.object(m.socket,'SO_MARK',36,create=True),patch.object(m.socket,'SO_BINDTODEVICE',25,create=True),patch.object(m.socket,'socket',return_value=s),patch.object(m,'route_to',return_value={'dev':'eth0'}),patch.object(m.secrets,'randbelow',return_value=1),patch.object(m.ssl,'create_default_context') as context:
  context.return_value.wrap_socket.return_value=s
  r=m.attempt('eth0',p,transport,'example.com',1,1,time.monotonic()+10)
  assert r['state']=='ok' and r['rcode']==3 and r['routeVerified'] and s.closed,r
  if transport in ('dot','doh'):context.return_value.wrap_socket.assert_called_once_with(s,server_hostname='dns.google')
  if transport=='doh':assert b'POST /dns-query HTTP/1.1' in s.payload and b'Host: dns.google' in s.payload
s=Sock()
with patch.object(m.socket,'SO_MARK',36,create=True),patch.object(m.socket,'SO_BINDTODEVICE',25,create=True),patch.object(m.socket,'socket',return_value=s),patch.object(m,'route_to',return_value={'dev':'eth0'}),patch.object(s,'setsockopt',side_effect=PermissionError('denied')):
 r=m.attempt('eth0',p,'udp','example.com',1,1,time.monotonic()+10)
 assert r['state']=='unavailable' and r['reason']=='permission-denied' and not s.connected and s.closed
with patch.object(m,'route_to') as route:
 r=m.attempt('eth0',p,'udp','example.com',1,1,time.monotonic()-1);assert r['reason']=='budget-exhausted';route.assert_not_called()
` ,JSON.stringify(provider)],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);
});

test('DNS export removes local socket and route addresses while retaining wire answers',()=>{
 const report={dnsMatrix:{attempts:[{localAddress:'192.168.1.86',address:'1.1.1.1',rawBase64:'AAAA',route:{dev:'eth0',gateway:'192.168.1.1',prefsrc:'192.168.1.86'}}]}};
 const copy=exportDiagnosticReport(report);assert.equal(copy.dnsMatrix.attempts[0].rawBase64,'AAAA');assert.doesNotMatch(JSON.stringify(copy),/192\.168/);assert.ok(report.dnsMatrix.attempts[0].localAddress);
});

test('DNS fault fixtures preserve RCODE, truncated packets, timeout, TLS refusal and DoH errors independently',()=>{
 const provider=dnsMatrixProviders(['google'])[0];
 const result=spawnSync('python3',['-c',String.raw`
import importlib.util,struct,time,socket,ssl,io,json,sys,base64
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('matrix','server/dns-matrix.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
provider=json.loads(sys.argv[1]);name='example.com'
class Sock:
 def __init__(self):self.options={};self.closed=False;self.rcode=0;self.truncated=False;self.status=200;self.body_type='application/dns-message'
 def setsockopt(self,l,k,v):self.options[k]=v
 def getsockopt(self,l,k,*a):return self.options[k]
 def settimeout(self,n):pass
 def connect(self,peer):pass
 def getsockname(self):return ('192.168.1.86',45000)
 def getpeername(self):return ('8.8.8.8',53)
 def send(self,payload):pass
 def sendall(self,payload):pass
 def packet(self):return struct.pack('!6H',1,0x8180|self.rcode|(0x200 if self.truncated else 0),1,0,0,0)+m.query(name,1,1)[12:]
 def recv(self,n):return self.packet()
 def makefile(self,*args):
  body=self.packet()
  return io.BytesIO(('HTTP/1.1 '+str(self.status)+' Fixture\r\nContent-Type: '+self.body_type+'\r\nContent-Length: '+str(len(body))+'\r\n\r\n').encode()+body)
 def version(self):return 'TLSv1.3'
 def close(self):self.closed=True
s=Sock()
with patch.object(m.socket,'SO_MARK',36,create=True),patch.object(m.socket,'SO_BINDTODEVICE',25,create=True),patch.object(m.socket,'socket',return_value=s),patch.object(m,'route_to',return_value={'dev':'eth0'}),patch.object(m.secrets,'randbelow',return_value=1),patch.object(m.ssl,'create_default_context') as context:
 context.return_value.wrap_socket.return_value=s
 def run(transport):return m.attempt('eth0',provider,transport,name,1,1,time.monotonic()+7)
 for rcode in (0,2,3):
  s.rcode=rcode;r=run('udp');assert r['state']=='ok' and r['rcode']==rcode and base64.b64decode(r['rawBase64'])==s.packet(),r
 s.rcode=0;s.truncated=True;r=run('udp');assert r['state']=='ok' and r['truncated'];s.truncated=False
 with patch.object(s,'recv',side_effect=TimeoutError('timeout')):
  r=run('udp');assert r['reason']=='timeout' and r['state']=='failed' and r['failedStage']=='dns',r
 context.return_value.wrap_socket.side_effect=ssl.SSLCertVerificationError('bad certificate')
 r=run('dot');assert r['reason']=='certificate-error' and r['state']=='failed' and r['failedStage']=='tls',r
 context.return_value.wrap_socket.side_effect=None
 # An available DoH response does not rewrite or hide the earlier UDP timeout.
 r=run('doh');assert r['state']=='ok' and r['rcode']==0,r
 for status,body_type in [(503,'application/dns-message'),(302,'application/dns-message'),(200,'text/html')]:
  s.status=status;s.body_type=body_type;r=run('doh');assert r['state']=='failed' and r['reason']=='invalid-response' and r['httpStatus']==status,r
` ,JSON.stringify(provider)],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);
});
