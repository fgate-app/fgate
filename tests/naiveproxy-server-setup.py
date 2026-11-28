import argparse,hashlib,ipaddress,json,os,pathlib,pwd,secrets,subprocess,tarfile,zipfile
p=argparse.ArgumentParser();p.add_argument('--host',required=True);p.add_argument('--root',default='/var/tmp/fg-naive-research');p.add_argument('--caddy-archive',required=True);p.add_argument('--xray-archive',required=True);a=p.parse_args();a.host=str(ipaddress.ip_address(a.host))
root=pathlib.Path(a.root);root.mkdir(mode=0o700,exist_ok=True)
uid=pwd.getpwnam('nobody')
def run(*args):return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE).stdout
for port in (18443,18444,18445):assert not run('ss','-H','-lnt','sport','=',':'+str(port)).strip(),'Port is already in use'
with tarfile.open(a.caddy_archive) as t:(root/'caddy').write_bytes(t.extractfile('caddy-forwardproxy-naive/caddy').read())
with zipfile.ZipFile(a.xray_archive) as z:(root/'xray').write_bytes(z.read('xray'))
for name in ('caddy','xray'):(root/name).chmod(0o755)
run('openssl','req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout',str(root/'ca.key'),'-out',str(root/'ca.crt'),'-days','2','-subj','/CN=FG temporary research CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign')
run('openssl','req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout',str(root/'tls.key'),'-out',str(root/'leaf.csr'),'-subj','/CN=FG research endpoint')
(root/'ext').write_text(f'subjectAltName=IP:{a.host},DNS:naive-research.test\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n')
run('openssl','x509','-req','-in',str(root/'leaf.csr'),'-CA',str(root/'ca.crt'),'-CAkey',str(root/'ca.key'),'-CAcreateserial','-days','2','-extfile',str(root/'ext'),'-out',str(root/'tls.crt'))
password=secrets.token_urlsafe(32);identity=secrets.token_hex(16);identity=identity[:8]+'-'+identity[8:12]+'-'+identity[12:16]+'-'+identity[16:20]+'-'+identity[20:]
(root/'Caddyfile').write_text('''{
 admin off
 auto_https off
 order forward_proxy before respond
 servers {
  protocols h1 h2 h3
 }
}
:18443 {
 tls '''+str(root/'tls.crt')+' '+str(root/'tls.key')+'''
 forward_proxy {
  basic_auth research '''+password+'''
  ports 18445
  disable_insecure_upstreams_check
  hide_ip
  hide_via
  probe_resistance
  acl {
   allow 127.0.0.1/32
   deny all
  }
 }
 respond "Research endpoint" 200
}
''')
config={'log':{'loglevel':'error'},'inbounds':[{'listen':'0.0.0.0','port':18444,'protocol':'vless','settings':{'clients':[{'id':identity}],'decryption':'none'},'streamSettings':{'network':'tcp','security':'tls','tlsSettings':{'certificates':[{'certificateFile':str(root/'tls.crt'),'keyFile':str(root/'tls.key')}],'alpn':['h2','http/1.1']}}}],'outbounds':[{'tag':'origin','protocol':'freedom','settings':{'finalRules':[{'action':'allow','ip':['127.0.0.1/32']}]}},{'tag':'deny','protocol':'blackhole'}],'routing':{'rules':[{'type':'field','ip':['127.0.0.1/32'],'port':'18445','outboundTag':'origin'},{'type':'field','network':'tcp,udp','outboundTag':'deny'}]}}
(root/'xray.json').write_text(json.dumps(config));pin=hashlib.sha256(run('openssl','x509','-in',str(root/'tls.crt'),'-outform','DER')).hexdigest()
(root/'client.json').write_text(json.dumps({'host':a.host,'naivePort':18443,'vlessPort':18444,'username':'research','password':password,'uuid':identity,'leafPin':pin,'serverVersions':{'caddy':run(str(root/'caddy'),'version').decode().strip(),'xray':run(str(root/'xray'),'version').decode().splitlines()[0]}}))
run(str(root/'caddy'),'validate','--adapter','caddyfile','--config',str(root/'Caddyfile'));run(str(root/'xray'),'run','-test','-c',str(root/'xray.json'))
for f in root.iterdir():os.chown(f,uid.pw_uid,uid.pw_gid);f.chmod(0o755 if f.name in ('caddy','xray') else 0o600)
os.chown(root,uid.pw_uid,uid.pw_gid)
print(json.dumps({'prepared':True,'ports':[18443,18444],'originLoopback':18445,'configSecretPrinted':False}))
