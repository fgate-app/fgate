"""FG-15.1 paired ARM64/VPS measurement. No application configuration changes.
Private metadata/CA are supplied by the operator; reports never contain credentials.
"""
import argparse,re,hashlib,http.client,json,os,pathlib,pwd,random,socket,struct,subprocess,tempfile,threading,time
from native_proxy_fixture import exact,terminate
p=argparse.ArgumentParser();p.add_argument('--naive',required=True);p.add_argument('--xray',required=True);p.add_argument('--private',required=True);p.add_argument('--user',default='freedomgate');p.add_argument('--ca',required=True);p.add_argument('--rounds',type=int,default=3);p.add_argument('--timeout',type=float,default=20);p.add_argument('--connect-host');p.add_argument('--path',default='public-ip');p.add_argument('--transports',nargs='+',choices=['naive-h2','naive-h3','vless-tls'],default=['naive-h2','naive-h3','vless-tls']);p.add_argument('--naive-port',type=int);p.add_argument('--vless-port',type=int);a=p.parse_args()
uid=pwd.getpwnam(a.user);meta=json.loads(pathlib.Path(a.private).read_text());payload=bytes(range(256))*16384;expected=hashlib.sha256(payload).hexdigest();attempts=[];processes={};samplings={};stop=threading.Event();names=a.transports;ports={};starts={}
def proc(pid):
 try:
  stat=pathlib.Path(f'/proc/{pid}/stat').read_text().split();status=pathlib.Path(f'/proc/{pid}/status').read_text().splitlines();rss=next(int(s.split()[1]) for s in status if s.startswith('VmRSS:'));return {'cpuSeconds':(int(stat[13])+int(stat[14]))/os.sysconf('SC_CLK_TCK'),'rssKiB':rss}
 except (OSError,StopIteration):return None
def sample():
 while not stop.wait(.02):
  for name,child in list(processes.items()):
   value=proc(child.pid)
   if value:samplings.setdefault(name,[]).append(value)
def connect(port):
 s=socket.socket();s.settimeout(a.timeout);s.connect(('127.0.0.1',port));s.sendall(b'\x05\x01\x00');assert exact(s,2)==b'\x05\x00';s.sendall(b'\x05\x01\x00\x01'+socket.inet_aton('127.0.0.1')+(18445).to_bytes(2,'big'));v,status,_,kind=exact(s,4);assert v==5 and status==0
 if kind==1:exact(s,4)
 elif kind==4:exact(s,16)
 elif kind==3:exact(s,exact(s,1)[0])
 else:raise OSError('Invalid SOCKS reply')
 exact(s,2);return s
def request(name,path,body=None):
 start=time.monotonic();s=None
 try:
  s=connect(ports[name]);verb='POST' if body is not None else 'GET';headers=f'{verb} {path} HTTP/1.1\r\nHost: 127.0.0.1:18445\r\nConnection: close\r\n'+(f'Content-Length: {len(body)}\r\n' if body is not None else '')+'\r\n';s.sendall(headers.encode());
  if body is not None:s.sendall(body)
  response=http.client.HTTPResponse(s);response.begin();data=response.read();seconds=time.monotonic()-start
  if response.status!=200:raise OSError('Unexpected HTTP status')
  if path=='/blob':assert len(data)==len(payload) and hashlib.sha256(data).hexdigest()==expected
  if path=='/upload':assert json.loads(data)=={'verified':True,'bytes':len(payload)}
  if path=='/health':assert data==b'ok'
  return {'ok':True,'seconds':round(seconds,6),'bytes':len(body) if body is not None else len(data)},data
 except (OSError,AssertionError,http.client.HTTPException) as e:return {'ok':False,'seconds':round(time.monotonic()-start,6),'errorType':type(e).__name__},None
 finally:
  if s:s.close()
def free_port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
with tempfile.TemporaryDirectory(prefix='fg-naive-client-',dir='/var/tmp') as directory:
 folder=pathlib.Path(directory);os.chown(folder,uid.pw_uid,uid.pw_gid);ca=folder/'ca.crt';ca.write_bytes(pathlib.Path(a.ca).read_bytes());ca.chmod(0o600);os.chown(ca,uid.pw_uid,uid.pw_gid)
 sampler=threading.Thread(target=sample,daemon=True);sampler.start()
 def launch(name,untrusted=False):
  port=free_port();ports[name]=port
  if name.startswith('naive'):
   from urllib.parse import quote
   proxy=('quic' if name=='naive-h3' else 'https')+'://'+quote(meta['username'],safe='')+':'+quote(meta['password'],safe='')+'@'+meta['host']+':'+str(a.naive_port or meta['naivePort']);config={'listen':'socks://127.0.0.1:'+str(port),'proxy':proxy,'log-net-log':str(folder/(name+('-untrusted' if untrusted else '')+'.netlog'))}
   if a.connect_host:config['host-resolver-rules']='MAP '+meta['host']+' '+a.connect_host
   args=[a.naive,str(folder/(name+'.json'))]
  else:
   config={'log':{'loglevel':'error'},'inbounds':[{'listen':'127.0.0.1','port':port,'protocol':'socks','settings':{'auth':'noauth'}}],'outbounds':[{'protocol':'vless','settings':{'vnext':[{'address':a.connect_host or meta['host'],'port':a.vless_port or meta['vlessPort'],'users':[{'id':meta['uuid'],'encryption':'none'}]}]},'streamSettings':{'network':'tcp','security':'tls','tlsSettings':{'serverName':meta['host'],'pinnedPeerCertSha256':meta['leafPin']}}}]};args=[a.xray,'run','-c',str(folder/(name+'.json'))]
  file=folder/(name+'.json');file.write_text(json.dumps(config));file.chmod(0o600);os.chown(file,uid.pw_uid,uid.pw_gid);log=(folder/(name+'.log')).open('wb');env={**os.environ,'SSL_CERT_FILE':'/dev/null' if untrusted else str(ca),'SSL_CERT_DIR':str(folder/'empty-trust')};(folder/'empty-trust').mkdir(exist_ok=True)
  child=subprocess.Popen(args,stdout=log,stderr=log,user=uid.pw_uid,group=uid.pw_gid,extra_groups=[],env=env);log.close();processes[name]=child
  for _ in range(100):
   if child.poll() is not None:break
   try:
    with socket.create_connection(('127.0.0.1',port),timeout=.05):return
   except OSError:time.sleep(.03)
 try:
  cold=[]
  for name in names:
   launch(name);before=proc(processes[name].pid);result,_=request(name,'/health');after=proc(processes[name].pid);result.update({'transport':name,'phase':'cold','clientBefore':before,'clientAfter':after});attempts.append(result);cold.append(result['ok']);print(json.dumps({'transport':name,'phase':'cold','ok':result['ok'],'seconds':result['seconds']}),file=__import__('sys').stderr,flush=True)
  active=[name for name,ok in zip(names,cold) if ok]
  for iteration in range(a.rounds):
   order=list(active);random.Random(iteration+151).shuffle(order)
   for name in order:
    backend='naive' if name.startswith('naive') else 'vless';metric_start,data=request(name,'/metrics');before=json.loads(data)[backend] if metric_start['ok'] else None;cpu_before=proc(processes[name].pid);start=time.monotonic();offset=len(samplings.get(name,[]));results=[]
    for _ in range(5):r,_=request(name,'/health');results.append({'kind':'latency',**r})
    for path,body in [('/blob',None),('/upload',payload)]:
     r,_=request(name,path,body);r['kind']='download' if body is None else 'upload'
     if r['ok']:r['mbps']=round(r['bytes']*8/r['seconds']/1e6,3)
     results.append(r)
    duration=time.monotonic()-start;cpu_after=proc(processes[name].pid);metric_end,data=request(name,'/metrics');after=json.loads(data)[backend] if metric_end['ok'] else None;samples=samplings.get(name,[])[offset:]
    row={'transport':name,'phase':'paired','round':iteration+1,'ok':all(r['ok'] for r in results),'durationSeconds':round(duration,6),'results':results,'clientCpuSeconds':round(cpu_after['cpuSeconds']-cpu_before['cpuSeconds'],6) if cpu_after and cpu_before else None,'clientPeakRssKiB':max((s['rssKiB'] for s in samples),default=0),'serverCpuSeconds':round(after['cpuSeconds']-before['cpuSeconds'],6) if after and before else None,'serverRssKiB':after['rssKiB'] if after else None};attempts.append(row);print(json.dumps({'transport':name,'phase':'paired','round':iteration+1,'ok':row['ok']}),file=__import__('sys').stderr,flush=True)
  # TLS negative controls use the same native client and no trusted research CA.
  for name in [n for n in active if n.startswith('naive')]:
   terminate(processes[name]);launch(name,True);r,_=request(name,'/health');attempts.append({'transport':name,'phase':'untrusted-ca','expectedFailure':True,**r})
 finally:
  stop.set();sampler.join(timeout=1)
  for child in processes.values():terminate(child)
 protocols={}
 for name in names:
  file=folder/(name+'.netlog')
  if file.exists():
   try:
    raw=file.read_text();decoder=json.JSONDecoder();first,_=decoder.raw_decode(raw);constants=first.get('constants',{});types={v:k for k,v in constants.get('logEventTypes',{}).items()};events=set()
    if 'events' in first:entries=first['events']
    else:
     entries=[]
     for line in raw.splitlines():
      try:entries.append(json.loads(line))
      except ValueError:pass
    for record in entries:
     event=record.get('event',record);events.add(types.get(event.get('type'),''))
    protocols[name]={'http2Events':any('HTTP2_SESSION' in e for e in events),'quicEvents':any('QUIC_SESSION' in e for e in events),'completeEventTypes':len(events)}
   except (ValueError,KeyError,AttributeError):protocols[name]={'netlogParsed':False}
 print(json.dumps({'task':'FG-15.1','platform':__import__('platform').machine(),'clientVersions':{'naive':subprocess.check_output([a.naive,'--version'],text=True).strip(),'xray':subprocess.check_output([a.xray,'version'],text=True).splitlines()[0]},'serverVersions':meta['serverVersions'],'timeoutSeconds':a.timeout,'bytesPerTransfer':len(payload),'rounds':a.rounds,'attempts':attempts,'protocolEvents':protocols,'path':a.path,'explicitOuterTunnel':not a.path.startswith('public'),'applicationConfigurationChanged':False,'credentialsExported':False},indent=2))
