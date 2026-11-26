"""Explicit root-only, fixed-endpoint zapret sweep. Own mark/queue/table; no saved changes."""
import importlib.util,ipaddress,json,os,pathlib,shutil,signal,subprocess,sys,tempfile,time,pwd
ROOT=pathlib.Path(os.environ.get('FG_CODE_ROOT','/opt/freedomgate/current'))
MARK=0x20000009;QUEUE=313;PRIORITY=1803;TABLE='freedomgate_lantern_lab'
request=json.load(sys.stdin);address=str(ipaddress.ip_address(request['address']));port=request['port'];control=str(ipaddress.ip_address(request['control']))
if os.geteuid()!=0 or not ipaddress.ip_address(address).is_global or not ipaddress.ip_address(control).is_global or not isinstance(port,int) or isinstance(port,bool) or not 1<=port<=65535:raise ValueError('Invalid privileged sweep request.')
def run(args,**options):return subprocess.run(args,check=True,capture_output=True,text=True,timeout=5,**options)
if subprocess.run(['nft','list','table','inet',TABLE],capture_output=True).returncode==0:raise RuntimeError('The private laboratory table already exists.')
rules=json.loads(run(['ip','-j','rule','show']).stdout)
if any(row.get('priority')==PRIORITY for row in rules):raise RuntimeError('The private rule priority is already in use.')
if any(line.split()[0]==str(QUEUE) for line in pathlib.Path('/proc/net/netfilter/nfnetlink_queue').read_text().splitlines()):raise RuntimeError('The private queue is already in use.')
interface=sorted(json.loads(run(['ip','-j','route','show','table','main','default']).stdout),key=lambda row:row.get('metric',0))[0]['dev']
spec=importlib.util.spec_from_file_location('endpoint_probe',ROOT/'server/endpoint_probe.py');endpoint=importlib.util.module_from_spec(spec);spec.loader.exec_module(endpoint);endpoint.MARK=MARK
blob=ROOT/'server/zapret-assets/tls_clienthello_www_google_com.bin';module=pathlib.Path('/opt/freedomgate/modules/zapret/current');binary=module/'nfqws2';lua=module/'lua'
CANDIDATES=[
 ('split-1',['multisplit:pos=1:payload=all']),('disorder-1',['multidisorder:pos=1:payload=all']),('disorder-16',['multidisorder:pos=16:payload=all']),
 ('fake-md5-split',['fake:blob=0x00000000:tcp_md5:repeats=2:payload=all','multisplit:pos=1:payload=all']),('fake-md5-disorder',['fake:blob=0x00000000:tcp_md5:repeats=2:payload=all','multidisorder:pos=1:payload=all']),
 ('syndata-16',['syndata']),('syndata-1',['syndata:blob=0x00']),('syndata-4',['syndata:blob=0x00000000']),('syndata-tls',['syndata:blob=fg_tls_google']),('syndata-repeat3',['syndata:repeats=3']),
 ('synack',['synack']),('synack-syndata',['synack','syndata']),('syndata-split',['syndata','multisplit:pos=1:payload=all']),('syndata-disorder',['syndata','multidisorder:pos=1:payload=all']),
 ('syn-fragment8',['send:ipfrag:ipfrag_pos_tcp=8']),('syn-fragment24',['send:ipfrag:ipfrag_pos_tcp=24']),('syn-fragment8-only',['send:ipfrag:ipfrag_pos_tcp=8','drop']),('syn-fragment24-only',['send:ipfrag:ipfrag_pos_tcp=24','drop'])]
native=os.environ.get('FG_NATIVE_WORKER');UID=290999
scope=os.environ.get('FG_BYPASS_SCOPE','all')
if scope not in ['all','relays','services','primary']:raise ValueError('Invalid bypass scope.')
if os.environ.get('FG_NATIVE_ROUTE','raw') not in ['raw','system'] or os.environ.get('FG_NATIVE_IPV6','reject') not in ['reject','allow']:raise ValueError('Invalid native route or address-family mode.')
if native:
 try:pwd.getpwuid(UID);raise RuntimeError('The laboratory UID is assigned.')
 except KeyError:pass
 for path in pathlib.Path('/proc').glob('[0-9]*/status'):
  try:
   if any(line.startswith('Uid:') and int(line.split()[1])==UID for line in path.read_text().splitlines()):raise RuntimeError('The laboratory UID is in use.')
  except (FileNotFoundError,PermissionError):pass
 CANDIDATES=[row for row in CANDIDATES if row[0] in ['fake-md5-disorder','syndata-tls','syndata-disorder']]
 alternates=request.get('alternates',[])
 if not alternates or len(alternates)>4:raise ValueError('Supply the observed alternate relay endpoints.')
 for row in alternates:
  if not ipaddress.ip_address(row['address']).is_global or row['port']!=587:raise ValueError('Invalid alternate relay.')
 if shutil.disk_usage('/var/tmp').free<100*1024*1024:raise RuntimeError('Insufficient test storage.')
if os.environ.get('FG_SKIP_CANDIDATES')=='1':CANDIDATES=[]
if os.environ.get('FG_ONLY_CASES'):
 selected=set(os.environ['FG_ONLY_CASES'].split(','));CANDIDATES=[row for row in CANDIDATES if row[0] in selected]
 if {row[0] for row in CANDIDATES}!=selected:raise ValueError('Unknown laboratory strategy selection.')
work=pathlib.Path(tempfile.mkdtemp(prefix='.lantern-zapret-',dir='/var/tmp' if native else '/var/lib/freedomgate'));
child=None;created_rule=False;created_table=False;report={'address':address,'port':port,'mark':hex(MARK),'queue':QUEUE,'cases':[],'payloadBytesCaptured':0}
def shared():
 result={}
 for table in ['freedomgate','freedomgate_zapret']:
  p=subprocess.run(['nft','-s','list','table','inet',table],capture_output=True,text=True);result[table]=p.stdout if p.returncode==0 else None
 return result
before=shared()
if native:
 work.chmod(0o711);state=work/'state';(state/'lantern').mkdir(parents=True);shutil.copytree('/var/lib/freedomgate/lantern/data',state/'lantern/data',ignore=shutil.ignore_patterns('*.log','*.log.*','logs'),symlinks=True);
 if any(item.is_symlink() for item in state.rglob('*')):shutil.rmtree(work);raise ValueError('Symbolic links are not supported in laboratory state.')
 worker=work/'worker.mjs';shutil.copy2(native,worker);worker.chmod(0o644)
 for item in [state,*state.rglob('*')]:os.chown(item,UID,UID)
 state.chmod(0o700)
 report['bypassScope']=scope;report['primaryRejected']=os.environ.get('FG_BLOCK_PRIMARY')=='1';report['mode']='native-fallback-client';report['laboratoryUid']=UID;report['nativeRoute']=os.environ.get('FG_NATIVE_ROUTE','raw');report['nativeIpv6']=os.environ.get('FG_NATIVE_IPV6','reject')

def stop():
 global child,created_table
 if child is not None:
  child.terminate()
  try:child.wait(timeout=2)
  except subprocess.TimeoutExpired:child.kill();child.wait(timeout=2)
  child=None
 if created_table:subprocess.run(['nft','delete','table','inet',TABLE],capture_output=True);created_table=False

def stop_workers():
 if native:
  for path in pathlib.Path('/proc').glob('[0-9]*/status'):
   try:
    if any(line.startswith('Uid:') and int(line.split()[1])==UID for line in path.read_text().splitlines()):os.kill(int(path.parent.name),signal.SIGKILL)
   except (FileNotFoundError,PermissionError,ProcessLookupError):pass

def cleanup():
 stop_workers();stop()
 if created_rule:subprocess.run(['ip','rule','del','priority',str(PRIORITY),'fwmark',hex(MARK)+'/0xffffffff','lookup','main'],capture_output=True)
 shutil.rmtree(work,ignore_errors=True)
def interrupted(signum,frame):cleanup();raise SystemExit(128+signum)
for sig in [signal.SIGTERM,signal.SIGINT]:signal.signal(sig,interrupted)

def attempt(peer):
 value=endpoint.attempt(interface,peer,port,time.monotonic()+5,capture=True)
 # Never export the host's private tuple; keep the exact-tuple packet metadata.
 if 'tcpCapture' in value:value['tcpCapture'].pop('tuple',None)
 for key in ['localAddress','localPort','route']:value.pop(key,None)
 return value

def counter():
 data=json.loads(run(['nft','-j','list','table','inet',TABLE]).stdout)
 return sum(expr['counter'].get('packets',0) for item in data.get('nftables',[]) for expr in item.get('rule',{}).get('expr',[]) if 'counter' in expr)

def case(name,functions,peer=address):
 global child,created_table
 row={'strategy':name,'functions':functions,'address':peer,'attempts':[]};report['cases'].append(row)
 try:
  if functions:
   args=[str(binary),'--qnum='+str(QUEUE),'--fwmark=0x40000000','--bind-fix4','--user=root','--lua-init=@'+str(lua/'zapret-lib.lua'),'--lua-init=@'+str(lua/'zapret-antidpi.lua'),'--blob=fg_tls_google:@'+str(blob),'--filter-mark='+hex(MARK)+'/0xffffffff','--filter-tcp=1-65535','--reasm-disable','--out-range=-d10','--payload=all',*['--lua-desync='+value for value in functions]]
   dry=subprocess.run([*args,'--dry-run'],capture_output=True,text=True,timeout=5);row['dryRunPassed']=dry.returncode==0
   if dry.returncode:row.update(state='unavailable',reason='strategy-dry-run-failed');return
   with (work/'nfqws.log').open('w') as log:
    os.fchmod(log.fileno(),0o600);child=subprocess.Popen([*args,'--debug=1'],stdout=log,stderr=log)
   for _ in range(30):
    if child.poll() is not None:raise RuntimeError('The private daemon exited.')
    if any(line.split()[0]==str(QUEUE) for line in pathlib.Path('/proc/net/netfilter/nfnetlink_queue').read_text().splitlines()):break
    time.sleep(.05)
   else:raise RuntimeError('The private queue did not bind.')
  if functions or native:
   addresses=sorted({peer,*([row['address'] for row in alternates] if native else [])})
   nft='table inet '+TABLE+' {\n'
   if native:
    if os.environ.get('FG_NATIVE_ROUTE','raw')=='raw':nft+='chain route_output { type route hook output priority -150; policy accept; meta skuid '+str(UID)+' ip daddr != 127.0.0.0/8 '+('ip daddr '+('!= ' if scope=='services' else '')+'{ '+', '.join([address] if scope=='primary' else addresses)+' } ' if scope!='all' else '')+'meta mark set '+hex(MARK)+'; }\nchain source_nat { type nat hook postrouting priority 100; policy accept; oifname "'+interface+'" meta mark '+hex(MARK)+' masquerade; }\n'
    if os.environ.get('FG_BLOCK_PRIMARY')=='1':nft+='chain primary_guard { type filter hook output priority -151; policy accept; meta skuid '+str(UID)+' ip daddr '+address+' tcp dport '+str(port)+' reject with tcp reset; }\n'
    if os.environ.get('FG_NATIVE_IPV6','reject')=='reject':nft+='chain v6_guard { type filter hook output priority -151; policy accept; meta skuid '+str(UID)+' ip6 daddr != ::1 reject with icmpv6 type no-route; }\n'
   if functions:nft+='chain postrouting {\ntype filter hook postrouting priority 99; policy accept;\noifname "lo" return\nmeta mark '+hex(MARK)+' ip daddr { '+', '.join(addresses)+' } tcp dport { '+str(port)+(', 587' if native else '')+' } counter queue num '+str(QUEUE)+' bypass\n}\n'
   nft+='}\n';run(['nft','-f','-'],input=nft);created_table=True
  for _ in range(2):row['attempts'].append(attempt(peer))
  row['state']='ok' if all(value['state']=='ok' for value in row['attempts']) else 'partial' if any(value['state']=='ok' for value in row['attempts']) else 'failed'
  row['tcpQueuedPackets']=counter() if functions else 0
  if native and peer==address:
   if report.get('alternateTcpAvailable'):
    try:
     response=subprocess.run(['setpriv','--reuid='+str(UID),'--regid='+str(UID),'--clear-groups','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--no-new-privs','/opt/freedomgate/runtime/node/bin/node',str(worker)],cwd=state,env={**os.environ,'HOME':str(state),'FG_STATE':str(state),'FG_CODE_ROOT':str(ROOT)},capture_output=True,text=True,timeout=70)
     row['native']=json.loads(response.stdout.strip().splitlines()[-1]) if response.returncode==0 else {'state':'unavailable','reason':'native-worker-failed'}
    except (subprocess.TimeoutExpired,ValueError,IndexError):row['native']={'state':'unavailable','reason':'native-worker-unavailable'}
    finally:stop_workers()
   else:row['native']={'state':'skipped','reason':'no-reachable-alternate-tcp-endpoint'}
  row['queuedPackets']=counter() if functions else 0
  if functions and row['queuedPackets']==0:row.update(state='unavailable',reason='queue-not-observed')
 finally:
  stop()
  log=(work/'nfqws.log').read_text(errors='replace') if functions and (work/'nfqws.log').exists() else ''
  row['wireSynPayloadSizes']=sorted({max(0,p['ipBytes']-p['headerBytes']) for a in row['attempts'] for p in a.get('tcpCapture',{}).get('packets',[]) if p['direction']=='outbound' and 'SYN' in p['flags']})
  row['fragmentDispatches']=log.count('sending ip fragment')
  row['luaErrorObserved']='LUA ERROR' in log.upper() or 'stack traceback' in log
  if row['luaErrorObserved']:row.update(state='unavailable',reason='strategy-runtime-lua-error')
  print(json.dumps(row),flush=True)
try:
 run(['ip','rule','add','priority',str(PRIORITY),'fwmark',hex(MARK)+'/0xffffffff','lookup','main']);created_rule=True
 report['controlBefore']=attempt(control)
 if native:
  report['alternateTcpControls']=[]
  for target in alternates:
   value=endpoint.attempt(interface,target['address'],target['port'],time.monotonic()+5);report['alternateTcpControls'].append({k:value.get(k) for k in ['address','port','state','routeVerified']})
  report['alternateTcpAvailable']=any(row['state']=='ok' for row in report['alternateTcpControls'])
 case('baseline-before',[])
 for name,functions in CANDIDATES:case(name,functions)
 if os.environ.get('FG_BASELINE_ONCE')!='1':case('baseline-after',[])
 if os.environ.get('FG_SKIP_CANDIDATES')!='1':case('calibration-syndata',['syndata'],control)
 report['controlAfter']=attempt(control);report['complete']=True
finally:
 cleanup();report['sharedRulesUnchanged']=shared()==before;report['privateTableRemoved']=subprocess.run(['nft','list','table','inet',TABLE],capture_output=True).returncode!=0;report['privateQueueRemoved']=not any(line.split()[0]==str(QUEUE) for line in pathlib.Path('/proc/net/netfilter/nfnetlink_queue').read_text().splitlines());report['privateRuleRemoved']=not any(row.get('priority')==PRIORITY for row in json.loads(run(['ip','-j','rule','show']).stdout))
 if os.environ.get('FG_REPORT'):pathlib.Path(os.environ['FG_REPORT']).write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps({key:report[key] for key in ['complete','sharedRulesUnchanged','privateTableRemoved','privateQueueRemoved','privateRuleRemoved'] if key in report}),flush=True)
