"""Run on ARM64 as root under unshare -n with lo up. Engines use freedomgate UID.
Own server, no production configuration or network. stdout is an anonymized report.
"""
import argparse, hashlib, json, os, pathlib, platform, pwd, secrets, socket, subprocess, tempfile, threading, time
from native_proxy_fixture import run, exact, socks, counts, tcp_loop, udp_loop, terminate, resource
p=argparse.ArgumentParser();p.add_argument('--server',required=True);p.add_argument('--mihomo',required=True);p.add_argument('--node',default='node');p.add_argument('--multiplexing',choices=['MULTIPLEXING_OFF','MULTIPLEXING_LOW'],default='MULTIPLEXING_LOW');a=p.parse_args()
assert pathlib.Path('/proc/self/ns/net').readlink()!=pathlib.Path('/proc/1/ns/net').readlink(),'Use unshare -n'
assert [name for _,name in socket.if_nameindex()]==['lo'],'Only loopback is allowed'
assert platform.machine() in ('aarch64','arm64'),'ARM64 acceptance requires ARM64'
assert not pathlib.Path('/var/lib/mita').exists(),'Use a host without system mita state to protect existing metrics'
uid=pwd.getpwnam('freedomgate');rows=[];loads=[];server=engine=None
with tempfile.TemporaryDirectory(prefix='fg-mieru-') as directory:
 base=pathlib.Path(directory);os.chown(base,uid.pw_uid,uid.pw_gid)
 username='fixture';password=secrets.token_hex(24)
 (base/'server.json').write_text(json.dumps({'portBindings':[{'port':18443,'protocol':proto} for proto in ('TCP','UDP')],'users':[{'name':username,'password':password,'allowLoopbackIP':True,'allowPrivateIP':True}],'loggingLevel':'ERROR','listenIPAddress':'127.0.0.1'}))
 (base/'mihomo.yaml').write_bytes(run(a.node,'tests/mieru-native-config.mjs',input=json.dumps({'username':username,'password':password,'multiplexing':a.multiplexing}).encode()))
 for file in base.iterdir():os.chown(file,uid.pw_uid,uid.pw_gid);os.chmod(file,0o600)
 env={**os.environ,'MITA_CONFIG_JSON_FILE':str(base/'server.json'),'MITA_UDS_PATH':str(base/'mita.sock'),'MITA_INSECURE_UDS':'1'}
 def start_server():
  child=subprocess.Popen([a.server,'run'],cwd=base,env=env,stdout=log,stderr=log,user=uid.pw_uid,group=uid.pw_gid,extra_groups=[])
  for _ in range(60):
   if child.poll() is not None:raise RuntimeError('Mita exited before readiness')
   try:
    with socket.create_connection(('127.0.0.1',18443),timeout=.1):return child
   except OSError:time.sleep(.1)
  terminate(child);raise RuntimeError('Mita listener timeout')
 def start_engine():
  child=subprocess.Popen([a.mihomo,'-d',str(base),'-f',str(base/'mihomo.yaml')],stdout=log,stderr=log,user=uid.pw_uid,group=uid.pw_gid,extra_groups=[])
  for _ in range(60):
   if child.poll() is not None:raise RuntimeError('Mihomo exited before readiness')
   try:
    with socket.create_connection(('127.0.0.1',18081),timeout=.1):return child
   except OSError:time.sleep(.1)
  terminate(child);raise RuntimeError('Mihomo listener timeout')
 def tcp(transport,payload):
  s,_=socks(1,t.getsockname()[1],18080+(transport=='UDP'))
  with s:s.sendall(payload);assert exact(s,len(payload))==payload
 def udp(transport,payload):
  control,port=socks(3,0,18080+(transport=='UDP'))
  with control,socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
   s.settimeout(4);header=b'\x00\x00\x00\x01'+socket.inet_aton('127.0.0.2')+u.getsockname()[1].to_bytes(2,'big');s.sendto(header+payload,('127.0.0.1',port));data,_=s.recvfrom(65535);assert data[10:]==payload
 def check(name,fn,works=True):
  before=dict(counts);start=time.monotonic()
  try:fn();ok=True
  except (OSError,AssertionError):ok=False
  assert ok==works,name+': unexpected result'
  if not works:assert counts==before,name+': traffic reached origin unexpectedly'
  rows.append({'name':name,'expected':'success' if works else 'failure','passed':True,'seconds':round(time.monotonic()-start,3),'originBytes':{k:counts[k]-before[k] for k in counts}})
 def both(transport,label,works=True):
  check(transport+' transport '+label+' TCP',lambda:tcp(transport,os.urandom(65536) if works else b'blocked'),works)
  check(transport+' transport '+label+' UDP',lambda:udp(transport,os.urandom(1024) if works else b'blocked'),works)
 with socket.socket() as t,socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as u,open(base/'private.log','wb') as log:
  t.bind(('127.0.0.2',0));t.listen();u.bind(('127.0.0.2',0));threading.Thread(target=tcp_loop,args=(t,),daemon=True).start();threading.Thread(target=udp_loop,args=(u,),daemon=True).start()
  try:
   server=start_server();engine=start_engine()
   for transport in ('TCP','UDP'):
    both(transport,'baseline')
    start=time.monotonic();r0=[resource(engine),resource(server)]
    for _ in range(80):tcp(transport,os.urandom(65536));udp(transport,os.urandom(1024))
    r1=[resource(engine),resource(server)];elapsed=time.monotonic()-start
    loads.append({'transport':transport,'tcpBytes':80*65536,'udpBytes':80*1024,'seconds':round(elapsed,3),'resources':[{'process':name,'cpuSeconds':round(y['cpuSeconds']-x['cpuSeconds'],3),'averageOneCorePercent':round(100*(y['cpuSeconds']-x['cpuSeconds'])/elapsed,2),'rssKiB':y['rssKiB']} for name,x,y in zip(('mihomo','mita'),r0,r1)]})
   stream,_=socks(1,t.getsockname()[1]);stream.sendall(b'before');assert exact(stream,6)==b'before';terminate(server)
   for transport in ('TCP','UDP'):both(transport,'server stopped',False)
   try:stream.sendall(b'after');assert stream.recv(5)!=b'after'
   except OSError:pass
   stream.close();rows.append({'name':'existing TCP stream interrupted','passed':True})
   server=start_server()
   for transport in ('TCP','UDP'):both(transport,'server restarted')
   for blocked in ('UDP','TCP'):
    # Existing streams would survive a SYN-only refusal; drop all matching transport packets.
    rule=f'table inet fg_mieru_fixture {{\n chain output {{\n type filter hook output priority 0; policy accept;\n {blocked.lower()} dport 18443 drop\n }}\n}}\n'
    run('nft','-f','-',input=rule.encode())
    try:
     both(blocked,'blocked',False)
     both('TCP' if blocked=='UDP' else 'UDP','other transport blocked')
    finally:run('nft','delete','table','inet','fg_mieru_fixture')
    # A fresh request uses the same running mihomo process after restoration.
    both(blocked,'restored')
  except BaseException:
   log.flush();private=(base/'private.log').read_text(errors='replace').replace(password,'[redacted]')
   # Show only fixture logs, with ephemeral password removed, to make failures reproducible.
   import sys;print(private[-6000:],file=sys.stderr);raise
  finally:terminate(engine);terminate(server)
 print(json.dumps({'task':'FG-14.2','architecture':platform.machine(),'kernel':platform.release(),'mihomo':run(a.mihomo,'-v').decode().splitlines()[0],'mita':run(a.server,'version').decode().strip(),'serverSha256':hashlib.sha256(pathlib.Path(a.server).read_bytes()).hexdigest(),'settings':{'transport':['TCP','UDP'],'multiplexing':a.multiplexing,'handshakeMode':'HANDSHAKE_STANDARD'},'cases':rows,'load':loads,'productionStateChanged':False,'publicTraffic':False},indent=2))
