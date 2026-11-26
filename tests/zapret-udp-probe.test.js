import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('marked UDP probe validates replies and never falls back after a privilege failure',()=>{
 const result=spawnSync('python3',['-c',`
import importlib.util,struct,socket
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('probe','server/zapret-udp-probe.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class FakeSocket:
 def __init__(self): self.options=[];self.sent=None;self.bad=False;self.fail=False
 def __enter__(self): return self
 def __exit__(self,*args): pass
 def setsockopt(self,*args):
  self.options.append(args)
  if self.fail: raise PermissionError('mark denied')
 def settimeout(self,value): assert value==2.5
 def connect(self,target): assert target==('1.1.1.1',53)
 def send(self,value): self.sent=value
 def recv(self,size):
  reply=bytearray(self.sent);reply[2]=0x81;reply[3]=0x80
  if self.bad: reply[0]^=1
  return bytes(reply)
s=FakeSocket()
with patch.object(module.socket,'SO_MARK',36,create=True), patch.object(module.socket,'SO_BINDTODEVICE',25,create=True), patch.object(module.socket,'socket',return_value=s):
 assert module.probe('eth0')['status']=='ok'
 assert s.options[0]==(socket.SOL_SOCKET,socket.SO_MARK,0x10000000)
 assert s.options[1]==(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,b'eth0\\0')
 s.bad=True;assert module.probe('eth0')['status']=='error'
 s.fail=True;s.sent=None
 try: module.probe('eth0');raise AssertionError('must not fall back')
 except PermissionError: pass
 assert s.sent is None
`],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
