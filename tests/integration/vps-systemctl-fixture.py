"""Test-only service manager: owns only processes and files in a fixture directory."""
import json,os,pathlib,shlex,signal,subprocess,sys,time
base=pathlib.Path(os.environ['FG_VPS_FIXTURE']);args=sys.argv[1:];op=args[0]
if op=='daemon-reload':sys.exit(0)
unit=args[-1]
if not unit.startswith('freedomgate-vpn-') or not unit.endswith('.service'):sys.exit(9)
state=base/'state'/unit
try:data=json.loads(state.read_text())
except FileNotFoundError:data={}
def alive():
    try:os.kill(data.get('pid',0),0);return data.get('pid',0)>1
    except ProcessLookupError:return False
def stop():
    if alive():
        try:os.killpg(data['pid'],signal.SIGTERM)
        except ProcessLookupError:pass
        time.sleep(.15)
    data.pop('pid',None)
def start():
    text=(base/'units'/unit).read_text();command=next(line[10:] for line in text.splitlines() if line.startswith('ExecStart='))
    log=open(base/'state'/(unit+'.log'),'ab')
    process=subprocess.Popen(['runuser','-u','freedomgate','--',*shlex.split(command)],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    data['pid']=process.pid
if op=='is-active':sys.exit(0 if alive() else 3)
if op=='is-enabled':sys.exit(0 if data.get('enabled') else 1)
if op=='stop':stop()
elif op=='start':start()
elif op=='restart':stop();start()
elif op=='enable':
    data['enabled']=True
    if '--now' in args and not alive():start()
elif op=='disable':data['enabled']=False
else:sys.exit(9)
state.write_text(json.dumps(data))
