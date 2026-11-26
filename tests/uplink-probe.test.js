import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('direct controls require the physical route, socket mark and binding with no unmarked fallback',()=>{
 const result=spawnSync('python3',['-c',`
import importlib.util,socket,ssl
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('probe','server/uplink-probe.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Sock:
 def __init__(self): self.options={};self.connected=False;self.deny=False
 def __enter__(self): return self
 def __exit__(self,*args): pass
 def setsockopt(self,level,key,value):
  if self.deny: raise PermissionError('denied')
  self.options[key]=value
 def getsockopt(self,level,key,*args): return self.options[key]
 def settimeout(self,value): assert value==3
 def connect(self,address): assert address==('1.1.1.1',443);self.connected=True
 def getsockname(self): return ('192.168.1.86',12345)
 def getpeername(self): return ('1.1.1.1',443)
 def version(self): return 'TLSv1.3'
s=Sock()
class Context:
 def wrap_socket(self,sock,server_hostname): assert server_hostname=='cloudflare-dns.com';return sock
with patch.object(m.socket,'SO_MARK',36,create=True),patch.object(m.socket,'SO_BINDTODEVICE',25,create=True),patch.object(m.socket,'socket',return_value=s),patch.object(m.ssl,'create_default_context',return_value=Context()),patch.object(m,'route_to',return_value={'dev':'eth0'}):
 r=m.probe('eth0','1.1.1.1','cloudflare-dns.com');assert r['outcome']=='ok';assert r['routeVerified'];assert r['peerAddress']=='1.1.1.1'
 assert s.options[36]==0x40000000 and s.options[25]==b'eth0\\0'
 s.connected=False;s.deny=True
 r=m.probe('eth0','1.1.1.1','cloudflare-dns.com');assert not r['routeVerified'];assert not s.connected
 s.deny=False
 with patch.object(m,'route_to',side_effect=OSError('tun route')):
  r=m.probe('eth0','1.1.1.1','cloudflare-dns.com');assert r['observation']=='route-unavailable';assert not s.connected
 with patch.object(m.ssl,'create_default_context') as context:
  context.return_value.wrap_socket.side_effect=ssl.SSLCertVerificationError('bad certificate')
  r=m.probe('eth0','1.1.1.1','cloudflare-dns.com');assert r['routeVerified'];assert r['observation']=='certificate-error'
for interface,address,name in [('eth0;reboot','1.1.1.1','cloudflare-dns.com'),('eth0','127.0.0.1','localhost')]:
 try:m.probe(interface,address,name);raise AssertionError('must reject')
 except ValueError:pass
with patch.object(m.subprocess,'run') as run:
 run.return_value.stdout='[{"dev":"tun0"}]'
 try:m.route_to('1.1.1.1','eth0');raise AssertionError('must reject TUN')
 except OSError:pass
 assert run.call_args.args[0]==['ip','-j','route','get','1.1.1.1','mark','0x40000000','oif','eth0']
`],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
