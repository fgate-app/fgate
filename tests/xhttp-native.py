"""FG-51.2: isolated XHTTP editor, split downloads and actual managed wrapping.
Run as root under unshare -n with only lo; native engines run as freedomgate.
"""
import argparse,hashlib,json,os,pathlib,platform,pwd,select,socket,subprocess,tempfile,threading,time
from native_proxy_fixture import run,exact,socks,counts,tcp_loop,udp_loop,terminate
p=argparse.ArgumentParser();p.add_argument('--xray',required=True);p.add_argument('--node',default='node');a=p.parse_args()
assert pathlib.Path('/proc/self/ns/net').readlink()!=pathlib.Path('/proc/1/ns/net').readlink()
assert [name for _,name in socket.if_nameindex()]==['lo']
uid=pwd.getpwnam('freedomgate');rows=[];native=[];wrapped=[];proxy_sockets=[];captures=[]
def listener(port,host='127.0.0.1'):
 s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind((host,port));s.listen();return s
def relay(s,dest,wrapper=False):
 try:
  with s:
   if wrapper:
    version,n=exact(s,2);assert version==5 and 2 in exact(s,n);s.sendall(b'\x05\x02');version,n=exact(s,2);user=exact(s,n);password=exact(s,exact(s,1)[0]);assert version==1 and user==b'fixture' and password==b'fixture-password';s.sendall(b'\x01\x00')
    version,command,zero,kind=exact(s,4);assert version==5 and command==1 and kind==1
    host=socket.inet_ntoa(exact(s,4));port=int.from_bytes(exact(s,2),'big');assert host=='127.0.0.1' and port in (18443,18444);dest=(host,port);wrapped.append(port)
   with socket.create_connection(dest,timeout=2) as target:
    if wrapper:s.sendall(b'\x05\x00\x00\x01'+socket.inet_aton('127.0.0.1')+b'\x00\x00');proxy_sockets.extend([s,target])
    s.setblocking(False);target.setblocking(False)
    while True:
     ready,_,_=select.select([s,target],[],[],.2)
     for source in ready:
      data=source.recv(65536)
      if not data:return
      if not wrapper and source is s:captures.append(data)
      other=target if source is s else s;other.setblocking(True);other.sendall(data);other.setblocking(False)
 except (OSError,AssertionError,ValueError):pass
# These front ends share one XHTTP server/session map while using distinct ports.
def acceptor(s,dest=None,wrapper=False):
 while True:
  try:c,_=s.accept();threading.Thread(target=relay,args=(c,dest,wrapper),daemon=True).start()
  except OSError:return
with tempfile.TemporaryDirectory(prefix='fg-xhttp-native-') as directory:
 base=pathlib.Path(directory);os.chown(base,uid.pw_uid,uid.pw_gid)
 run('openssl','req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout',str(base/'tls.key'),'-out',str(base/'tls.crt'),'-days','1','-subj','/CN=fixture.test','-addext','subjectAltName=DNS:fixture.test')
 pin=hashlib.sha256(run('openssl','x509','-in',str(base/'tls.crt'),'-outform','DER')).hexdigest()
 material=dict(line.split(': ',1) for line in run(a.xray,'x25519').decode().splitlines() if ': ' in line)
 private,public=material['PrivateKey'],material['Password (PublicKey)'];identity='00000000-0000-4000-8000-000000000001'
 for f in base.iterdir():os.chown(f,uid.pw_uid,uid.pw_gid);os.chmod(f,0o600)
 def launch(name,config):
  path=base/(name+'.json');path.write_text(json.dumps(config));os.chown(path,uid.pw_uid,uid.pw_gid);os.chmod(path,0o600)
  child=subprocess.Popen([a.xray,'run','-c',str(path)],stdout=log,stderr=log,user=uid.pw_uid,group=uid.pw_gid,extra_groups=[]);native.append(child)
  port=config['inbounds'][0]['port']
  for _ in range(100):
   assert child.poll() is None,'Native process exited'
   try:
    with socket.create_connection(('127.0.0.1',port),timeout=.1):return child
   except OSError:time.sleep(.05)
  raise RuntimeError('Readiness timeout')
 t=listener(0,'127.0.0.2');u=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);u.bind(('127.0.0.2',0));threading.Thread(target=tcp_loop,args=(t,),daemon=True).start();threading.Thread(target=udp_loop,args=(u,),daemon=True).start()
 front=[listener(18443),listener(18444)];proxy=listener(18090)
 for s in front:threading.Thread(target=acceptor,args=(s,('127.0.0.1',18445)),daemon=True).start()
 threading.Thread(target=acceptor,args=(proxy,None,True),daemon=True).start()
 def firewall(action):
  if action=='-D':run('/usr/sbin/nft','delete','table','inet','fg_xhttp_test');return
  rules='add table inet fg_xhttp_test\nadd chain inet fg_xhttp_test output { type filter hook output priority 0; policy accept; }\nadd rule inet fg_xhttp_test output meta skuid '+str(uid.pw_uid)+' ip daddr 127.0.0.1 tcp dport { 18443, 18444 } counter reject\n'
  run('/usr/sbin/nft','-f','-',input=rules.encode())
 def check(mode,security,split,wrap,negative=False,offline=False):
  start=time.monotonic();children=[];wrapped.clear();captures.clear()
  settings={'path':'/fixture','host':'fixture.test','mode':'auto','xPaddingBytes':'100-200','noGRPCHeader':True,'scMinPostsIntervalMs':0,'scMaxEachPostBytes':16384}
  stream={'network':'xhttp','security':security,'xhttpSettings':settings}
  if security=='tls':stream['tlsSettings']={'certificates':[{'certificateFile':str(base/'tls.crt'),'keyFile':str(base/'tls.key')}],'alpn':['h2','http/1.1']}
  if security=='reality':stream['realitySettings']={'target':'127.0.0.1:18555','serverNames':['fixture.test'],'privateKey':private,'shortIds':['0123456789abcdef']}
  server={'log':{'loglevel':'error'},'inbounds':[{'listen':'127.0.0.1','port':18445,'protocol':'vless','settings':{'clients':[{'id':identity}],'decryption':'none'},'streamSettings':stream}],'outbounds':[{'protocol':'freedom','settings':{'finalRules':[{'action':'allow','ip':['127.0.0.2/32']}]}}]}
  fields={'server':'127.0.0.1','port':'18443','uuid':identity,'network':'xhttp','security':security,'sni':'fixture.test','fingerprint':'chrome','publicKey':public,'shortId':'0123456789abcdef','pinnedPeerCertSha256':pin if security=='tls' else '', 'path':'/fixture','host':'fixture.test'}
  edits={'xhttpMode':mode,'path':'/wrong' if negative else '/fixture','xhttpHeaders':json.dumps({'X-FG-Test':'fixture'}),'xhttpXmux':json.dumps({'maxConcurrency':4,'hMaxRequestTimes':100}),'xhttpExtra':json.dumps({'xPaddingBytes':'100-200','noGRPCHeader':True,'scMinPostsIntervalMs':0,'scMaxEachPostBytes':16384})}
  if split:
   dl={'address':'127.0.0.1','port':18444,'network':'xhttp','security':security,'xhttpSettings':{'path':'/fixture','host':'fixture.test','mode':'auto','xPaddingBytes':'100-200','noGRPCHeader':True,'xmux':{'maxConcurrency':4}}}
   if security=='tls':dl['tlsSettings']={'serverName':'fixture.test','fingerprint':'chrome','alpn':['h2'],'pinnedPeerCertSha256':pin}
   if security=='reality':dl['realitySettings']={'serverName':'fixture.test','fingerprint':'chrome','publicKey':public,'shortId':'0123456789abcdef'}
   edits['xhttpDownload']=json.dumps(dl)
  endpoint={'port':18091 if offline else 18090,'username':'fixture','password':'fixture-password','remoteDns':True} if wrap else None
  generated=json.loads(run(a.node,'tests/xhttp-native-config.mjs',input=json.dumps({'fields':fields,'edits':edits,'wrapEndpoint':endpoint}).encode(),user=uid.pw_uid,group=uid.pw_gid,extra_groups=[]));port=generated['inbounds'][0]['port']
  if wrap:firewall('-A')
  try:
   children.append(launch('server',server));children.append(launch('client',generated));before=dict(counts);results=[]
   for kind,size in [('tcp',65536),('udp',1024)]:
    ok=False
    try:
     control,relay_port=socks(1 if kind=='tcp' else 3,t.getsockname()[1] if kind=='tcp' else 0,port)
     with control:
      control.settimeout(15 if security=='reality' and not negative and not offline else 4);payload=os.urandom(size)
      if kind=='tcp':control.sendall(payload);assert exact(control,len(payload))==payload
      else:
       with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as datagram:
        datagram.settimeout(15 if security=='reality' and not negative and not offline else 4);header=b'\x00\x00\x00\x01'+socket.inet_aton('127.0.0.2')+u.getsockname()[1].to_bytes(2,'big');datagram.sendto(header+payload,('127.0.0.1',relay_port));assert datagram.recvfrom(65535)[0][10:]==payload
      ok=True
    except (OSError,AssertionError):pass
    results.append({'payload':kind,'bytes':size if ok else 0,'success':ok})
   failed=negative or offline;assert all(r['success']!=failed for r in results),'Unexpected transfer outcome'
   if failed:assert counts==before,'Rejected connection reached origin'
   if wrap and not failed:assert ({18443,18444} if split else {18443}) <= set(wrapped)
   if security=='none' and not failed:assert b'x-fg-test: fixture' in b''.join(captures).lower(),'Custom headers missing'
   rows.append({'mode':mode,'security':security,'separateDownload':split,'wrapped':wrap,'directConnectionsBlocked':wrap,'wrapperDestinations':sorted(set(wrapped)),'wrongPath':negative,'wrapperUnavailable':offline,'results':results,'passed':True,'seconds':round(time.monotonic()-start,3)})
   print('Passed '+mode+'/'+security+'/split='+str(split)+'/wrap='+str(wrap)+'/negative='+str(failed),file=__import__('sys').stderr,flush=True)
  finally:
   for child in children:terminate(child)
   for s in proxy_sockets:
    try:s.close()
    except OSError:pass
   proxy_sockets.clear()
   if wrap:firewall('-D')
 with (base/'private.log').open('wb') as log:
  target=subprocess.Popen([a.node,'tests/vless-tls-target.mjs',str(base/'tls.key'),str(base/'tls.crt')],stdout=subprocess.PIPE,stderr=log,user=uid.pw_uid,group=uid.pw_gid,extra_groups=[])
  assert target.stdout.readline().strip()==b'ready'
  try:
   for mode in ('auto','packet-up','stream-up','stream-one'):
    for split in ((False,) if mode=='stream-one' else (False,True)):
     for wrap in (False,True):check(mode,'tls',split,wrap)
   check('packet-up','none',True,True)
   check('auto','reality',True,True)
   check('packet-up','tls',True,True,negative=True)
   check('packet-up','tls',True,True,offline=True)
  except BaseException:
   log.flush();print((base/'private.log').read_text(errors='replace').replace(private,'[redacted]')[-5000:],file=__import__('sys').stderr);raise
  finally:
   terminate(target)
   for child in native:terminate(child)
   for s in front+[proxy,t,u]:s.close()
 print(json.dumps({'task':'FG-51.2','clientVersion':run(a.xray,'version').decode().splitlines()[0],'architecture':platform.machine(),'binarySha256':hashlib.sha256(pathlib.Path(a.xray).read_bytes()).hexdigest(),'cases':rows,'productionStateChanged':False,'publicTraffic':False,'privateKeysExported':False},indent=2))
