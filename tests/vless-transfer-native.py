"""Manual VLESS client/server configs, independent of importer and editor (FG-16.2).
Run as root under unshare -n, lo up. Both Xray processes use freedomgate UID.
"""
import argparse, base64, hashlib, json, os, pathlib, platform, pwd, secrets, socket, subprocess, tempfile, threading, time
from native_proxy_fixture import run, exact, socks, counts, tcp_loop, udp_loop, terminate
p=argparse.ArgumentParser();p.add_argument('--xray',required=True);p.add_argument('--node',default='node');p.add_argument('--case',dest='case_filter');p.add_argument('--advanced-security',action='store_true');p.add_argument('--mux-acceptance',action='store_true');p.add_argument('--mux-udp443',action='store_true');p.add_argument('--encryption',action='store_true');a=p.parse_args()
assert pathlib.Path('/proc/self/ns/net').readlink()!=pathlib.Path('/proc/1/ns/net').readlink(),'Use unshare -n'
assert [name for _,name in socket.if_nameindex()]==['lo'],'Only loopback is allowed'
assert platform.machine() in ('aarch64','arm64'),'ARM64 acceptance requires ARM64'
uid=pwd.getpwnam('freedomgate');rows=[];server=client=None;payload_timeout=4
with tempfile.TemporaryDirectory(prefix='fg-vless-transfer-') as directory:
 base=pathlib.Path(directory);os.chown(base,uid.pw_uid,uid.pw_gid)
 run('openssl','req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout',str(base/'tls.key'),'-out',str(base/'tls.crt'),'-days','1','-subj','/CN=fixture.test','-addext','subjectAltName=DNS:fixture.test')
 run('openssl','genpkey','-algorithm','X25519','-out',str(base/'reality.key'))
 encode=lambda b:base64.urlsafe_b64encode(b).decode().rstrip('=')
 private=encode(run('openssl','pkey','-in',str(base/'reality.key'),'-outform','DER')[-32:]);public=encode(run('openssl','pkey','-in',str(base/'reality.key'),'-pubout','-outform','DER')[-32:])
 pin=hashlib.sha256(run('openssl','x509','-in',str(base/'tls.crt'),'-outform','DER')).hexdigest();ca_pin=pin;mldsa_seed=mldsa_verify='';advanced_case='';mux_enabled=False;mux_policy='allow';enc_appearance='native';enc_rtt='0rtt';enc_key='x25519'
 if a.advanced_security:
  (base/'ca.crt').write_bytes((base/'tls.crt').read_bytes());(base/'ca.key').write_bytes((base/'tls.key').read_bytes())
  run('openssl','req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout',str(base/'tls.key'),'-out',str(base/'leaf.csr'),'-subj','/CN=fixture.test')
  (base/'ext').write_text('subjectAltName=DNS:fixture.test,'+','.join('DNS:pad'+str(i)+'.fixture.test' for i in range(220))+'\nbasicConstraints=CA:FALSE\n')
  run('openssl','x509','-req','-in',str(base/'leaf.csr'),'-CA',str(base/'ca.crt'),'-CAkey',str(base/'ca.key'),'-CAcreateserial','-days','1','-extfile',str(base/'ext'),'-out',str(base/'tls.crt'))
  pin=hashlib.sha256(run('openssl','x509','-in',str(base/'tls.crt'),'-outform','DER')).hexdigest();(base/'tls.crt').write_bytes((base/'tls.crt').read_bytes()+(base/'ca.crt').read_bytes())
  material=dict(line.split(': ',1) for line in run(a.xray,'mldsa65').decode().splitlines() if ': ' in line);mldsa_seed=material['Seed'];mldsa_verify=material['Verify']
 enc_keys={}
 if a.encryption:
  for kind in ('x25519','mlkem768'):
   material=dict(line.split(': ',1) for line in run(a.xray,kind).decode().splitlines() if ': ' in line)
   enc_keys[kind]=(material['PrivateKey'] if kind=='x25519' else material['Seed'],material['Password (PublicKey)'] if kind=='x25519' else material['Client'])
 identity='00000000-0000-4000-8000-'+secrets.token_hex(6)
 for f in base.iterdir():os.chown(f,uid.pw_uid,uid.pw_gid);os.chmod(f,0o600)
 def stream(network,security,inbound=False,mode='auto',negative=None):
  cfg={'network':network,'security':security}
  if network=='ws':cfg['wsSettings']={'path':'/fixture','headers':{'Host':'fixture.test'}}
  if network=='httpupgrade':cfg['httpupgradeSettings']={'path':'/fixture','host':'fixture.test'}
  if network=='grpc':cfg['grpcSettings']={'serviceName':'fixture','authority':'fixture.test'}
  if network in ('xhttp','splithttp'):cfg['xhttpSettings']={'path':'/fixture','host':'fixture.test','mode':'auto' if inbound else mode}
  if security=='tls':cfg['tlsSettings']={'certificates':[{'certificateFile':str(base/'tls.crt'),'keyFile':str(base/'tls.key')}],'alpn':['http/1.1'] if network=='ws' else ['h2','http/1.1']} if inbound else {'serverName':'wrong.test' if negative=='wrong-name' else 'fixture.test','allowInsecure':False,'certificates':[{'certificateFile':str(base/'tls.crt'),'usage':'verify'}],'fingerprint':'chrome','alpn':['http/1.1'] if network=='ws' else ['h2','http/1.1']}
  if security=='reality':cfg['realitySettings']={'target':'127.0.0.1:18555','serverNames':['fixture.test'],'privateKey':private,'shortIds':['0123456789abcdef']} if inbound else {'serverName':'wrong.test' if negative=='wrong-name' else 'fixture.test','publicKey':encode(bytes([2])*32) if negative=='wrong-key' else public,'shortId':'fedcba9876543210' if negative=='wrong-short-id' else '0123456789abcdef','fingerprint':'chrome'}
  return cfg
 def configs(network,security,flow='',mode='auto',negative=None):
  user={'id':identity,**({'flow':flow} if flow else {})}
  servercfg={'log':{'loglevel':'debug'},'inbounds':[{'listen':'127.0.0.1','port':18443,'protocol':'vless','settings':{'clients':[{**user,**({'flow':'xtls-rprx-vision'} if flow else {})}],'decryption':'none'},'streamSettings':stream(network,security,True,mode)}],'outbounds':[{'tag':'echo','protocol':'freedom','settings':{'finalRules':[{'action':'allow','ip':['127.0.0.2/32']}]}}]}
  clientcfg={'log':{'loglevel':'debug'},'inbounds':[{'tag':'local','listen':'127.0.0.1','port':18080,'protocol':'socks','settings':{'auth':'noauth','udp':True,'ip':'127.0.0.1'}}],'outbounds':[{'tag':'vpn','protocol':'vless','settings':{'vnext':[{'address':'127.0.0.1','port':18443,'users':[{**user,'id':'00000000-0000-4000-8000-000000000000' if negative=='wrong-id' else identity,'encryption':'none'}]}]},'streamSettings':stream(network,security,False,mode,negative)}],'routing':{'rules':[{'type':'field','inboundTag':['local'],'outboundTag':'vpn'}]}}
  if a.encryption:
   secret,auth=enc_keys[enc_key]
   servercfg['inbounds'][0]['settings']['decryption']=f'mlkem768x25519plus.{enc_appearance}.600s.{secret}'
   auth=encode(bytes([7])*32) if negative=='wrong-encryption-key' else auth
   appearance='random' if negative=='wrong-encryption-appearance' else enc_appearance
   clientcfg['outbounds'][0]['settings']['vnext'][0]['users'][0]['encryption']=f'mlkem768x25519plus.{appearance}.{enc_rtt}.{auth}'
   if security=='tls':clientcfg['outbounds'][0]['streamSettings']['tlsSettings']['pinnedPeerCertSha256']=pin
   edited=json.loads(run(a.node,'tests/vless-encryption-native-config.mjs',input=json.dumps({'outbound':clientcfg['outbounds'][0]}).encode()));clientcfg['outbounds'][0]={**edited['outbounds'][0],'tag':'vpn'}
  if a.advanced_security:
   settings=clientcfg['outbounds'][0]['streamSettings'].get('tlsSettings')
   if security=='tls':
    settings.pop('certificates',None);settings['pinnedPeerCertSha256']=ca_pin if advanced_case=='ca-name' else pin
    if advanced_case=='ca-name':settings['verifyPeerCertByName']='wrong.test' if negative else 'fixture.test'
    if negative=='wrong-pin':settings['pinnedPeerCertSha256']='ff'*32
    if negative=='untrusted-cert':settings.pop('pinnedPeerCertSha256')
   else:
    servercfg['inbounds'][0]['streamSettings']['realitySettings']['mldsa65Seed']=mldsa_seed
    clientcfg['outbounds'][0]['streamSettings']['realitySettings'].update({'spiderX':'/fixture','mldsa65Verify':encode(bytes([3])*1952) if negative else mldsa_verify})
   edited=json.loads(run(a.node,'tests/xray-security-native-config.mjs',input=json.dumps({'outbound':clientcfg['outbounds'][0]}).encode()));clientcfg['outbounds'][0]={**edited,'tag':'vpn'}
  if a.mux_acceptance:
   if security=='tls':clientcfg['outbounds'][0]['streamSettings']['tlsSettings']['pinnedPeerCertSha256']=pin
   mux={'enabled':True,'concurrency':-1 if flow or network in ('xhttp','splithttp') else 128,'xudpConcurrency':8,'xudpProxyUDP443':mux_policy} if mux_enabled else None
   edited=json.loads(run(a.node,'tests/xray-mux-native-config.mjs',input=json.dumps({'outbound':clientcfg['outbounds'][0],'mux':mux}).encode()));clientcfg['outbounds'][0]={**edited,'tag':'vpn'}
  for name,value in [('server',servercfg),('client',clientcfg)]:
   file=base/(name+'.json');file.write_text(json.dumps(value));os.chown(file,uid.pw_uid,uid.pw_gid);os.chmod(file,0o600)
 def launch(name,port):
  env={**os.environ,'SSL_CERT_FILE':str(base/'tls.crt')}
  child=subprocess.Popen([a.xray,'run','-c',str(base/(name+'.json'))],stdout=log,stderr=log,env=env,user=uid.pw_uid,group=uid.pw_gid,extra_groups=[])
  for _ in range(60):
   if child.poll() is not None:raise RuntimeError(name+' exited before readiness')
   try:
    with socket.create_connection(('127.0.0.1',port),timeout=.1):return child
   except OSError:time.sleep(.05)
  terminate(child);raise RuntimeError(name+' readiness timeout')
 def tcp(payload):
  s,_=socks(1,t.getsockname()[1])
  with s:s.settimeout(payload_timeout);s.sendall(payload);assert exact(s,len(payload))==payload
 def udp(payload,destination_port=None):
  ctl,port=socks(3,0)
  with ctl,socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
   s.settimeout(payload_timeout);header=b'\x00\x00\x00\x01'+socket.inet_aton('127.0.0.2')+(u.getsockname()[1] if destination_port is None else destination_port).to_bytes(2,'big');s.sendto(header+payload,('127.0.0.1',port));data,_=s.recvfrom(65535);assert data[10:]==payload
 def check(network,security,flow='',mode='auto',negative=None):
  global server,client,payload_timeout
  if a.case_filter and a.case_filter!=network+'/'+security:return
  configs(network,security,flow,mode);started=time.monotonic();payload_timeout=15 if security=='reality' else 4
  try:
   server=launch('server',18443);client=launch('client',18080)
   if negative:
    tcp(b'positive-control');udp(b'positive-control');terminate(client)
    configs(network,security,flow,mode,negative);client=launch('client',18080);payload_timeout=4
   before=dict(counts);results=[]
   for kind,fn,size in [('tcp',tcp,65536),('udp',udp,1024)]:
    try:fn(os.urandom(size));ok=True
    except (OSError,AssertionError):ok=False
    # Preserve all outcomes so one failed variant does not hide the rest of the matrix.
    results.append({'payload':kind,'bytes':size if ok else 0,'outcome':'success' if ok else 'rejected'})
   if negative:assert counts==before,'Rejected credentials reached echo origin'
   rows.append({'network':network,'security':security,'flow':flow,'mode':mode if network in ('xhttp','splithttp') else None,'encryption':{'appearance':enc_appearance,'rtt':enc_rtt,'keyType':enc_key} if a.encryption else None,'advancedCase':advanced_case if a.advanced_security else None,'negative':negative,'positiveControlVerified':bool(negative),'passed':all((r['outcome']=='success')==(negative is None) for r in results),'seconds':round(time.monotonic()-started,3),'results':results,'originBytes':{k:counts[k]-before[k] for k in counts}})
   print(f'{"Passed" if rows[-1]["passed"] else "Failed"} {network}/{security}/{flow or "no-flow"}/{mode}/{negative or "valid"}',file=__import__('sys').stderr,flush=True)
  finally:terminate(client);terminate(server);client=server=None
 def mux_check(network,security,flow):
  global server,client,payload_timeout
  import concurrent.futures
  configs(network,security,flow);payload_timeout=15 if security=='reality' else 4
  start=time.monotonic();streams=[]
  def one(index):
   data=os.urandom(65536);s,_=socks(1,t.getsockname()[1]);s.settimeout(payload_timeout);s.sendall(data);assert exact(s,len(data))==data;return s
  try:
   server=launch('server',18443);client=launch('client',18080)
   # Warm REALITY's target probe before the simultaneous traffic measurement.
   tcp(b'warmup')
   with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    streams=list(pool.map(one,range(8)));list(pool.map(lambda i:udp(os.urandom(1024)),range(8)))
   policy_result=None
   if a.mux_udp443:
    before=dict(counts);payload_timeout=3
    try:udp(b'udp443',443);allowed=True
    except OSError:allowed=False
    assert allowed==(mux_policy!='reject'),'Unexpected UDP/443 policy result'
    if not allowed:assert counts==before,'Rejected UDP/443 reached origin'
    policy_result={'policy':mux_policy,'allowed':allowed}
   established=sum(1 for line in pathlib.Path('/proc/net/tcp').read_text().splitlines()[1:] if line.split()[2].endswith(':480B') and line.split()[3]=='01')
   for s in streams:s.close()
   streams=[];terminate(server);payload_timeout=3
   for fn in (tcp,udp):
    before=dict(counts)
    try:fn(b'blocked');raise AssertionError('Stopped server unexpectedly forwarded traffic')
    except OSError:pass
    assert counts==before,'Traffic bypassed stopped server'
   server=launch('server',18443);payload_timeout=15 if security=='reality' else 4
   deadline=time.monotonic()+20;retries=0
   while True:
    try:tcp(b'recovery');udp(b'recovery');break
    except OSError:
     retries+=1
     if time.monotonic()>deadline:raise
     time.sleep(.2)
   rows.append({'network':network,'security':security,'flow':flow,'muxEnabled':mux_enabled,'udp443':policy_result,'tcpStreams':8,'udpSessions':8,'serverTcpConnections':established,'recoveryRetries':retries,'passed':True,'seconds':round(time.monotonic()-start,3)})
   print(f'Passed {network}/{security}/mux={mux_enabled}',file=__import__('sys').stderr,flush=True)
  finally:
   for s in streams:s.close()
   terminate(client);terminate(server);client=server=None
 with socket.socket() as t,socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as u,socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as u443,open(base/'private.log','wb') as log:
  t.bind(('127.0.0.2',0));t.listen();u.bind(('127.0.0.2',0))
  if a.mux_udp443:u443.bind(('127.0.0.2',443));threading.Thread(target=udp_loop,args=(u443,),daemon=True).start()
  threading.Thread(target=tcp_loop,args=(t,),daemon=True).start();threading.Thread(target=udp_loop,args=(u,),daemon=True).start()
  target=subprocess.Popen([a.node,'tests/vless-tls-target.mjs',str(base/'tls.key'),str(base/'tls.crt')],stdout=subprocess.PIPE,stderr=log,user=uid.pw_uid,group=uid.pw_gid,extra_groups=[])
  assert target.stdout.readline().strip()==b'ready','TLS target failed to start'
  try:
   if a.encryption:
    for enc_appearance in ('native','xorpub','random'):
     for enc_rtt in ('0rtt','1rtt'):
      for enc_key in ('x25519','mlkem768'):check('tcp','none')
    enc_appearance='native';enc_rtt='0rtt';enc_key='x25519'
    for security in ('tls','reality'):
     check('tcp',security);check('tcp',security,'xtls-rprx-vision')
    check('tcp','none','xtls-rprx-vision')
    check('tcp','none',negative='wrong-encryption-key');check('tcp','none',negative='wrong-encryption-appearance')
   elif a.mux_udp443:
    mux_enabled=True
    for mux_policy in ('allow','reject','skip'):mux_check('tcp','tls','')
   elif a.mux_acceptance:
    for network,security,flow in [('tcp','tls',''),('ws','tls',''),('grpc','tls',''),('xhttp','tls',''),('tcp','reality','xtls-rprx-vision')]:
     for mux_enabled in (False,True):mux_check(network,security,flow)
   elif a.advanced_security:
    for advanced_case,security,negative in [('leaf-pin','tls',None),('leaf-pin','tls','wrong-pin'),('leaf-pin','tls','untrusted-cert'),('ca-name','tls',None),('ca-name','tls','wrong-certificate-name'),('mldsa','reality',None),('mldsa','reality','wrong-mldsa')]:check('tcp',security,negative=negative)
   else:
    for network in ('tcp','raw','ws','grpc','httpupgrade','xhttp','splithttp'):
     for security in ('none','tls','reality'):
      if security=='reality' and network in ('ws','httpupgrade'):continue
      check(network,security)
    for network in ('tcp','raw'):
     for security in ('tls','reality'):
      for flow in ('xtls-rprx-vision','xtls-rprx-vision-udp443'):check(network,security,flow)
    for security in ('tls','reality'):
     for mode in ('packet-up','stream-up','stream-one'):check('xhttp',security,mode=mode)
    for network in ('tcp','grpc','xhttp'):
     for security in ('tls','reality'):
      check(network,security,negative='wrong-name')
      check(network,security,negative='wrong-id')
      if security=='reality':
       check(network,security,negative='wrong-key');check(network,security,negative='wrong-short-id')
  except BaseException:
   log.flush();print((base/'private.log').read_text(errors='replace').replace(private,'[redacted]').replace(mldsa_seed or '[absent]', '[redacted]').replace(identity,'[redacted]').replace(enc_keys.get(enc_key, ('[absent]',''))[0], '[redacted]')[-8000:],file=__import__('sys').stderr);raise
  finally:terminate(client);terminate(server);terminate(target)
 assert rows,'No test cases matched the requested filter'
 print(json.dumps({'task':'FG-51.1' if a.encryption else 'FG-51.4' if a.mux_acceptance else 'FG-51.3' if a.advanced_security else 'FG-16.2','architecture':platform.machine(),'kernel':platform.release(),'clientVersion':run(a.xray,'version').decode().splitlines()[0],'serverVersion':run(a.xray,'version').decode().splitlines()[0],'binarySha256':hashlib.sha256(pathlib.Path(a.xray).read_bytes()).hexdigest(),'tlsTargetRuntime':run(a.node,'--version').decode().strip(),'manualConfigurations':True,'caseFilter':a.case_filter,'cases':rows,'privateKeysExported':False,'publicTraffic':False,'productionStateChanged':False},indent=2))

 if any(not row['passed'] for row in rows):raise SystemExit(1)
