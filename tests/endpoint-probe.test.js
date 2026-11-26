import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('bound endpoint checks cover IPv4/IPv6, exact ports, refusal, mark failures, repeats and budget exhaustion',()=>{
 const result=spawnSync('python3',['-c',String.raw`
import importlib.util,socket,errno
from unittest.mock import patch,Mock
spec=importlib.util.spec_from_file_location('m','server/endpoint_probe.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Sock:
 def __init__(self):self.options={};self.connected=False;self.target=None;self.fail=None
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def setsockopt(self,level,key,value):
  if self.fail=='mark':raise PermissionError('denied')
  self.options[key]=value
 def getsockopt(self,level,key,*args):return self.options[key]
 def settimeout(self,value):assert 0<value<=2
 def connect(self,target):
  self.target=target
  if self.fail=='refused':raise ConnectionRefusedError(errno.ECONNREFUSED,'refused')
  self.connected=True
 def getsockname(self):return ('192.168.1.86',45000)
 def getpeername(self):return self.target
s=Sock()
with patch.object(m.socket,'SO_MARK',36,create=True),patch.object(m.socket,'SO_BINDTODEVICE',25,create=True),patch.object(m.socket,'socket',return_value=s),patch.object(m.subprocess,'run',return_value=Mock(stdout='[{"dev":"eth0"}]')) as run:
 r=m.attempt('eth0','203.0.113.7',44127,m.time.monotonic()+5);assert r['state']=='ok' and r['routeVerified'];assert s.target==('203.0.113.7',44127);assert s.options[36]==0x40000000;assert s.options[25]==b'eth0\0'
 assert '-4' in run.call_args.args[0]
 m.attempt('eth0','2001:db8::7',443,m.time.monotonic()+5);assert '-6' in run.call_args.args[0]
 s.fail='refused';r=m.attempt('eth0','203.0.113.7',44127,m.time.monotonic()+5);assert r['reason']=='refused'
 s.fail='mark';s.connected=False;r=m.attempt('eth0','203.0.113.7',44127,m.time.monotonic()+5);assert not s.connected and not r['routeVerified'];assert r['state']=='unavailable' and r['reason']=='permission-denied'
 r=m.attempt('eth0','203.0.113.7',44127,m.time.monotonic()-1);assert r['state']=='skipped'
with patch.object(m,'attempt',side_effect=[{'state':'ok'},{'state':'failed'},{'state':'failed'},{'state':'failed'}]) as attempt:
 r=m.probe('eth0',['203.0.113.7','2001:db8::7'],443);assert attempt.call_count==4;assert r['state']=='partial';assert r['results'][0]['state']=='unstable';assert len(r['results'][1]['attempts'])==2
with patch.object(m,'attempt',return_value={'state':'skipped'}):
 r=m.probe('eth0',['203.0.113.7'],443);assert r['state']=='unavailable' and not r['complete']
for interface,addresses,port in [('eth0;bad',['1.1.1.1'],443),('eth0',['hostname'],443),('eth0',['1.1.1.1']*9,443),('eth0',['1.1.1.1'],0)]:
 try:m.probe(interface,addresses,port);raise AssertionError('validation')
 except ValueError:pass
`],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
