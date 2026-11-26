import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {diagnoseEndpoint} from '../server/endpoint-diagnostics.js';
import {exportDiagnosticReport} from '../shared/diagnostic-report.js';

test('production BPF filters exact IPv4/IPv6 tuples and excludes payload; parser preserves only header metadata',()=>{
  const result=spawnSync('python3',['tests/integration/test_tcp_capture.py'],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);
});

test('manual endpoint capture is opt-in, stays on configured peer and anonymizes its local tuple',async()=>{
  const peer={host:'203.0.113.7',port:44127};
  for(const capture of [false,true]){
    const report=await diagnoseEndpoint(peer,{capture,probe:async(request,{signal})=>{
      assert.deepEqual(request,{addresses:[peer.host],port:peer.port,...(capture?{capture:true}:{})});
      return {state:'ok',complete:true,results:[{address:peer.host,attempts:[{state:'ok',tcpCapture:{state:'observed',probeCorrelated:true,tuple:{localAddress:'192.168.1.86',localPort:45000,peerAddress:peer.host,peerPort:peer.port},packets:[{flags:['SYN'],sequence:123,ack:0}]}}]}]};
    }});
    const exported=exportDiagnosticReport({endpointControl:report});
    assert.doesNotMatch(JSON.stringify(exported),/192\.168\.1\.86|45000|localAddress|localPort/);
    assert.equal(exported.endpointControl.results[0].attempts[0].tcpCapture.tuple.peerPort,44127);
    assert.deepEqual(exported.endpointControl.results[0].attempts[0].tcpCapture.packets,[{flags:['SYN'],sequence:123,ack:0}]);
  }
});

test('capture permission failure preserves TCP result and only the first address attempt is captured',()=>{
  const result=spawnSync('python3',['-c',String.raw`
import importlib.util,socket
from unittest.mock import patch,Mock
spec=importlib.util.spec_from_file_location('probe','server/endpoint_probe.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Sock:
 def __init__(self):self.options={}
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def setsockopt(self,level,key,value):self.options[key]=value
 def getsockopt(self,level,key,*args):return self.options[key]
 def settimeout(self,value):pass
 def bind(self,address):assert address==('192.0.2.1',0)
 def connect(self,target):pass
 def getsockname(self):return ('192.0.2.1',45000)
 def getpeername(self):return ('203.0.113.7',443)
with patch.object(m.socket,'SO_MARK',36,create=True),patch.object(m.socket,'SO_BINDTODEVICE',25,create=True),patch.object(m.socket,'socket',return_value=Sock()),patch.object(m.subprocess,'run',return_value=Mock(stdout='[{"dev":"eth0","prefsrc":"192.0.2.1"}]')),patch.object(m._capture,'TcpCapture',side_effect=PermissionError('private failure')):
 r=m.attempt('eth0','203.0.113.7',443,m.time.monotonic()+5,capture=True)
 assert r['state']=='ok' and r['routeVerified'] and not r['tcpCapture']['probeCorrelated']
 assert r['tcpCapture']['state']=='unavailable' and r['tcpCapture']['reason']=='capture-unavailable'
 assert 'private failure' not in str(r)
with patch.object(m,'attempt',side_effect=[{'state':'ok'},{'state':'failed'},{'state':'failed'},{'state':'failed'}]) as attempt:
 result=m.probe('eth0',['203.0.113.7','2001:db8::7'],443,capture=True)
 assert result['limits']['tcpCapture']=={'maxSeconds':10,'maxPackets':64,'payloadBytes':0}
 assert result['limits']['connectSeconds']==2
 assert attempt.call_count==4
 assert [call.kwargs for call in attempt.call_args_list]==[{'capture':True},{},{},{}]
try:m.probe('eth0',['203.0.113.7'],443,capture='yes');raise AssertionError('invalid capture flag')
except ValueError:pass
`],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);
});
