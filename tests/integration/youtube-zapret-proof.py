"""Root-only fixed-peer A/B/A probe; existing zapret only, header-only capture."""
import pathlib,subprocess,json,socket,ssl,time,importlib.util,struct,ipaddress,os
if os.geteuid()!=0:raise RuntimeError('Run this explicit packet proof as root.')
ROOT=pathlib.Path(os.environ.get('FG_CODE_ROOT','/opt/freedomgate/current'))
spec=importlib.util.spec_from_file_location('capture',ROOT/'server/tcp-capture.py');capture=importlib.util.module_from_spec(spec);spec.loader.exec_module(capture)
original=capture.packet_metadata

def metadata(data,*args):
 row=original(data,*args)
 if row and data[0]>>4==4:
  offset=(data[0]&15)*4;end=row['headerBytes'];p=offset+20;opts=[]
  while p<min(len(data),end):
   kind=data[p]
   if kind==0:break
   if kind==1:p+=1;continue
   if p+1>=len(data) or data[p+1]<2:break
   opts.append({'kind':kind,'length':data[p+1]});p+=data[p+1]
  row['tcpOptions']=opts;row['payloadLength']=max(0,row['ipBytes']-row['headerBytes'])
 return row
capture.packet_metadata=metadata
run=lambda args:subprocess.run(args,capture_output=True,text=True,timeout=6)
def nft():return run(['nft','-s','list','table','inet','freedomgate_zapret']).stdout
def counters():
 result=run(['nft','-j','list','table','inet','freedomgate_zapret']);r=json.loads(result.stdout)
 return sum(e['counter'].get('packets',0) for x in r.get('nftables',[]) for e in x.get('rule',{}).get('expr',[]) if 'counter' in e)
interface=sorted(json.loads(run(['ip','-j','route','show','table','main','default']).stdout),key=lambda r:r.get('metric',0))[0]['dev'];before=nft();report={'targets':[],'attempts':[],'capture':'Exact TCP tuples, IP/TCP headers only; no payload retained','sharedCounterScope':'Global queue counter, other host traffic may contribute'}
def resolve(name):
 r=subprocess.run(['curl','--disable','-4','--silent','--show-error','--fail','--interface',interface,'--noproxy','*','--resolve','dns.google:443:8.8.8.8','--max-time','8','https://dns.google/resolve?name='+name+'&type=A'],capture_output=True,text=True,timeout=10)
 if r.returncode:raise RuntimeError('The fixed IPv4 DNS control failed.')
 return next(str(ipaddress.ip_address(x['data'])) for x in json.loads(r.stdout).get('Answer',[]) if x.get('type')==1 and ipaddress.ip_address(x['data']).is_global)
def attempt(name,address,path,mode,version='auto'):
 mark=0x10000000 if mode=='zapret' else 0;row={'name':name,'address':address,'path':path,'mode':mode,'tlsVersionRequested':version,'queueBefore':counters()};start=time.monotonic();reader=None;s=None
 try:
  route=json.loads(run(['ip','-j','route','get',address,'oif',interface]).stdout)[0];s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_MARK,mark);s.setsockopt(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,interface.encode()+b'\0');s.bind((route['prefsrc'],0));s.settimeout(7);reader=capture.TcpCapture(interface,s.getsockname()[0],s.getsockname()[1],address,443)
  s.connect((address,443));row['tcp']=True;ctx=ssl.create_default_context();ctx.set_alpn_protocols(['http/1.1'])
  if version=='1.2':ctx.minimum_version=ctx.maximum_version=ssl.TLSVersion.TLSv1_2
  s=ctx.wrap_socket(s,server_hostname=name);row['tls']=s.version();row['certificateVerified']=True;s.sendall(('GET '+path+' HTTP/1.1\r\nHost: '+name+'\r\nUser-Agent: Mozilla/5.0\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n').encode());data=b'';deadline=time.monotonic()+5
  while len(data)<65536 and time.monotonic()<deadline:
   chunk=s.recv(min(16384,65536-len(data)))
   if not chunk:break
   data+=chunk
  head,sep,body=data.partition(b'\r\n\r\n');row['httpStatus']=int(head.split(b' ',2)[1]);row['receivedBodyBytes']=len(body);row['youtubeMarkup']=b'ytInitialData' in body or b'<yt-' in body;row['redirect']=next((line.split(b':',1)[1].strip().decode(errors='replace') for line in head.split(b'\r\n') if line.lower().startswith(b'location:')),None);row['state']='ok' if 200<=row['httpStatus']<400 else 'http-error'
 except Exception as e:row.update(state='failed',error=type(e).__name__,stage='tls-or-http' if row.get('tcp') else 'tcp')
 finally:
  if s:s.close()
  if reader:
   snap=reader.finish();snap.pop('tuple',None);row['capture']=snap;packets=snap['packets'];syn=next((p['sequence'] for p in packets if p['direction']=='outbound' and 'SYN' in p['flags']),0);row['outboundData']=[{'seqOffset':((p['sequence']-syn+2**31)%2**32)-2**31,'bytes':p['payloadLength'],'ttl':p['ttl'],'md5Option':any(o['kind']==19 for o in p['tcpOptions'])} for p in packets if p['direction']=='outbound' and p['payloadLength']>0]
  row['queueDelta']=counters()-row['queueBefore'];row['durationMs']=round((time.monotonic()-start)*1000);report['attempts'].append(row);print(json.dumps({k:v for k,v in row.items() if k!='capture'}),flush=True)
try:
 for name,path in [('youtube.com','/'),('www.youtube.com','/'),('i.ytimg.com','/vi/jNQXAC9IVRw/hqdefault.jpg'),('www.gstatic.com','/generate_204')]:
  address=resolve(name);report['targets'].append({'name':name,'address':address,'path':path})
  for mode in ['direct','zapret','direct']:attempt(name,address,path,mode)
 address=next(x['address'] for x in report['targets'] if x['name']=='www.youtube.com')
 for mode in ['direct','zapret']:attempt('www.youtube.com',address,'/',mode,'1.2')
 report['complete']=True
finally:
 report['sharedRulesUnchanged']=nft()==before;report['health']=run(['curl','--silent','--max-time','3','http://127.0.0.1/api/health']).stdout
 pathlib.Path(os.environ.get('FG_REPORT','/home/admin/youtube-zapret-proof.json')).write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps({'complete':report.get('complete',False),'sharedRulesUnchanged':report['sharedRulesUnchanged']}),flush=True)
