"""Root-only marked WAN controls, reusing the application's exact-tuple header capture."""
import importlib.util,ipaddress,json,os,pathlib,socket,subprocess,sys,time
root=pathlib.Path(os.environ.get('FG_CODE_ROOT','/opt/freedomgate/current'))/'server'
spec=importlib.util.spec_from_file_location('endpoint_probe',root/'endpoint_probe.py')
endpoint=importlib.util.module_from_spec(spec);spec.loader.exec_module(endpoint)
request=json.load(sys.stdin)
if os.geteuid()!=0:raise PermissionError('Root is required for marked WAN controls.')
targets=request['targets']
if not isinstance(targets,list) or not 1<=len(targets)<=3:raise ValueError('Select one to three observed relay endpoints.')
for row in [*targets,request['control']]:
 if not ipaddress.ip_address(row['address']).is_global or not isinstance(row['port'],int) or isinstance(row['port'],bool) or not 1<=row['port']<=65535:raise ValueError('Invalid public endpoint.')
routes=json.loads(subprocess.check_output(['ip','-j','route','show','table','main','default'],text=True))
interface=sorted(routes,key=lambda row:row.get('metric',0))[0]['dev']
report={'interface':interface,'targets':[],'payloadBytesCaptured':0}
for target in targets:
 attempts=[]
 for index in range(3):
  row=endpoint.attempt(interface,target['address'],target['port'],time.monotonic()+5,capture=True)
  attempts.append({key:row[key] for key in ['state','reason','durationMs','routeVerified','tcpCapture'] if key in row})
 report['targets'].append({**target,'attempts':attempts})
control=endpoint.attempt(interface,request['control']['address'],request['control']['port'],time.monotonic()+5)
report['control']={key:control.get(key) for key in ['address','port','state','routeVerified','durationMs']}
v6routes=json.loads(subprocess.check_output(['ip','-6','-j','route','show','table','main','default'],text=True))
links=json.loads(subprocess.check_output(['ip','-6','-j','addr','show','dev',interface],text=True))
global_addresses=sum(1 for link in links for row in link.get('addr_info',[]) if row.get('scope')=='global' and ipaddress.ip_address(row['local']).is_global)
report['ipv6']={'physicalDefaultRoutes':len(v6routes),'globalAddresses':global_addresses}
name=request.get('serviceName')
if name:
 addresses=sorted({row[4][0] for row in socket.getaddrinfo(name,443,type=socket.SOCK_STREAM) if row[0]==socket.AF_INET6})
 if addresses:
  result=subprocess.run(['ip','-6','route','get',addresses[0],'mark',hex(endpoint.MARK),'oif',interface],capture_output=True)
  report['ipv6']['markedServiceRouteAvailable']=result.returncode==0
print(json.dumps(report))
