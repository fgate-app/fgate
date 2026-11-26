import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('socket snapshot selects only the exact managed PID and peer; process reuse and failed route lookup are explicit',()=>{
 const result=spawnSync('python3',['-c',String.raw`
import importlib.util,json
from unittest.mock import patch,Mock
spec=importlib.util.spec_from_file_location('m','server/socket-route.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
lines='''ESTAB 0 0 192.168.1.86:41000 203.0.113.7:443 users:(("xray",pid=200,fd=8)) uid:999 fwmark:0x10000007
ESTAB 0 0 192.168.1.86:41001 203.0.113.7:443 users:(("xray",pid=2000,fd=8))
ESTAB 0 0 192.168.1.86:41002 203.0.113.8:443 users:(("xray",pid=200,fd=8))
ESTAB 0 0 192.168.1.86:41003 203.0.113.7:8443 users:(("xray",pid=200,fd=8))
ESTAB 0 0 [2001:db8::1]:41004 [2001:db8::7]:443 users:(("xray",pid=200,fd=8))
'''
rows=m.parse_sockets(lines,200,'203.0.113.7',443);assert len(rows)==1;assert rows[0]['mark']==0x10000007
rows6=m.parse_sockets(lines,200,'2001:db8::7',443);assert len(rows6)==1 and rows6[0]['mark']==0
hidden='ESTAB 0 0 192.168.1.86:41000 203.0.113.7:443 uid:999 ino:12345 fwmark:0x40000000'
assert len(m.parse_sockets(hidden,200,'203.0.113.7',443,999,{'12345'}))==1
assert not m.parse_sockets(hidden,200,'203.0.113.7',443,999,{'12346'})
assert not m.parse_sockets(hidden,200,'203.0.113.7',443,1000,{'12345'})
with patch.object(m,'managed_process',return_value=('identity',999)),patch.object(m.subprocess,'run') as run:
 run.side_effect=[Mock(stdout=hidden),Mock(stdout='[{"dev":"eth0"}]')]
 assert m.snapshot(200,'203.0.113.7',443,'freedomgate','identity',['12345'])['state']=='observed'
 try:m.snapshot(200,'203.0.113.7',443,'freedomgate','other',['12345']);raise AssertionError('identity')
 except ValueError:pass
with patch.object(m,'managed_process',return_value=('identity',999)),patch.object(m.subprocess,'run') as run:
 run.side_effect=[Mock(stdout=lines),Mock(stdout='[{"dev":"eth0","gateway":"192.168.1.1"}]')]
 r=m.snapshot(200,'203.0.113.7',443,'freedomgate');assert r['state']=='observed';assert r['probeCorrelated'] is False;assert r['sockets'][0]['route']['dev']=='eth0'
 assert run.call_args.args[0]==['ip','-j','route','get','203.0.113.7','from','192.168.1.86','mark',str(0x10000007),'ipproto','tcp','sport','41000','dport','443','uid','999']
with patch.object(m,'managed_process',side_effect=['before','after']),patch.object(m.subprocess,'run',return_value=Mock(stdout='')):
 try:m.snapshot(200,'203.0.113.7',443,'freedomgate');raise AssertionError('PID reuse')
 except ValueError:pass
with patch.object(m,'managed_process',return_value=('id',999)),patch.object(m.subprocess,'run') as run:
 run.side_effect=[Mock(stdout=lines),OSError('route unavailable')]
 assert m.snapshot(200,'203.0.113.7',443,'freedomgate')['sockets'][0]['route'] is None
for address,port in [('127.0.0.1;reboot',443),('1.1.1.1',0),('1.1.1.1',65536)]:
 try:m.snapshot(200,address,port,'freedomgate');raise AssertionError('validation')
 except ValueError:pass
`],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});

test('privileged snapshot rejects foreign owners and arbitrary executables',()=>{
 const result=spawnSync('python3',['-c',String.raw`
import importlib.util,pathlib,tempfile,os
from unittest.mock import patch,Mock
spec=importlib.util.spec_from_file_location('m','server/socket-route.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
Path=pathlib.Path
with tempfile.TemporaryDirectory() as folder:
 root=Path(folder);proc=root/'200';proc.mkdir()
 (proc/'stat').write_text('200 (xray) '+' '.join(['S']+['0']*18+['12345']))
 (proc/'comm').write_text('xray\n');(proc/'cmdline').write_bytes(b'/opt/freedomgate/xray\0run\0')
 with patch.object(m.pathlib,'Path',side_effect=lambda p:root if p=='/proc' else Path(p)),patch.object(m.pwd,'getpwnam',return_value=Mock(pw_uid=os.getuid())):
  assert m.managed_process(200,'freedomgate')==('12345',os.getuid())
  (proc/'cmdline').write_bytes(b'/usr/bin/python3\0')
  try:m.managed_process(200,'freedomgate');raise AssertionError('executable')
  except ValueError:pass
 with patch.object(m.pathlib,'Path',side_effect=lambda p:root if p=='/proc' else Path(p)),patch.object(m.pwd,'getpwnam',return_value=Mock(pw_uid=os.getuid()+1)):
  try:m.managed_process(200,'freedomgate');raise AssertionError('owner')
  except ValueError:pass
`],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
