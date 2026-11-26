"""ForceCommand for a private namespace SSH fixture; redirect every install write."""
import base64,hashlib,json,os,pathlib,re,subprocess,sys
base=pathlib.Path(sys.argv[1]);script=sys.stdin.read()
if 'FREEDOMGATE_VPN_INSTALLED' in script:
    match=re.search(r"printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d",script)
    data=json.loads(base64.b64decode(match[1]));blob=(base/'xray.zip').read_bytes()
    data['url']=(base/'xray.zip').as_uri();data['sha256']=hashlib.sha256(blob).hexdigest()
    if data['config']['inbounds'][0]['protocol']=='vless':data['config']['inbounds'][0]['streamSettings']['realitySettings']['target']='127.0.0.1:'+str(json.loads((base/'fixture.json').read_text())['realityTarget'])
    if (base/'corrupt-next').exists():
        (base/'corrupt-next').unlink();data['sha256']='0'*64
    data['unit']=data['unit'].replace('/opt/freedomgate-vpn',str(base/'vpn')).replace('User=freedomgate-vpn','User=freedomgate').replace('Group=freedomgate-vpn','Group=freedomgate')
    script=script.replace(match[1],base64.b64encode(json.dumps(data).encode()).decode()).replace('/opt/freedomgate-vpn',str(base/'vpn')).replace('/etc/systemd/system',str(base/'units'))
    script=re.sub(r'getent passwd freedomgate-vpn[^\n]+',':',script).replace('-g freedomgate-vpn','-g freedomgate')
    if '/etc/ufw' in script:script=script.replace('/etc/ufw',str(base/'ufw'))
env={**os.environ,'PATH':str(base/'bin')+':/usr/sbin:/usr/bin:/sbin:/bin','FG_VPS_FIXTURE':str(base)}
sys.exit(subprocess.run(['/bin/sh','-s'],input=script,text=True,env=env).returncode)
