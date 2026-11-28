"""Isolated ARM64 acceptance. Run as root under unshare -n with lo up.
Only the parent controls namespace-local firewall; both engines run as freedomgate.
Required: --server official Hysteria binary, --mihomo installed binary, --node.
No production state is read or modified. JSON stdout contains no credentials.
"""
import argparse, hashlib, json, os, pathlib, platform, pwd, secrets, socket, struct, subprocess, tempfile, threading, time
p=argparse.ArgumentParser();p.add_argument('--server',required=True);p.add_argument('--mihomo',required=True);p.add_argument('--node',default='node');a=p.parse_args()
from native_proxy_fixture import run, exact, socks, counts, tcp_loop, udp_loop, terminate, resource
# Refuse accidental use of the host network namespace.
assert pathlib.Path('/proc/self/ns/net').readlink()!=pathlib.Path('/proc/1/ns/net').readlink(),'Use unshare -n'
assert [name for _,name in socket.if_nameindex()]==['lo'],'Only loopback is allowed in this fixture'
assert platform.machine() in ('aarch64','arm64'),'ARM64 acceptance requires ARM64'
uid=pwd.getpwnam('freedomgate');rows=[];resources=[];server=engine=None
with tempfile.TemporaryDirectory(prefix='fg-hy2-') as base:
    os.chown(base,uid.pw_uid,uid.pw_gid);base=pathlib.Path(base)
    run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(base/'key'),'-out',str(base/'cert'),'-days','1','-subj','/CN=hy2.fixture.test','-addext','subjectAltName=DNS:hy2.fixture.test')
    pin=hashlib.sha256(run('openssl','x509','-in',str(base/'cert'),'-outform','DER')).hexdigest();password=secrets.token_hex(24);obfs=secrets.token_hex(24)
    def config(mode):
        cfg={'listen':'127.0.0.1:18443','tls':{'cert':str(base/'cert'),'key':str(base/'key')},'auth':{'type':'password','password':password},'quic':{'maxIdleTimeout':'4s'},'disableUDP':mode=='udp-disabled'}
        if mode=='salamander':cfg['obfs']={'type':'salamander','salamander':{'password':obfs}}
        (base/'server.json').write_text(json.dumps(cfg));uri='hy2://'+password+'@127.0.0.1:18443?sni=hy2.fixture.test&pinSHA256='+pin
        if mode=='salamander':uri+='&obfs=salamander&obfs-password='+obfs
        yaml=run(a.node,'tests/hysteria2-native-config.mjs',input=uri.encode());(base/'mihomo.yaml').write_bytes(yaml)
        for f in base.iterdir():os.chown(f,uid.pw_uid,uid.pw_gid);os.chmod(f,0o600)
    def start_server():
        return subprocess.Popen([a.server,'server','-c',str(base/'server.json')],stdout=log,stderr=log,user=uid.pw_uid,group=uid.pw_gid,extra_groups=[])
    def start_engine():
        env={**os.environ,'SSL_CERT_FILE':str(base/'cert')}
        child=subprocess.Popen([a.mihomo,'-d',str(base),'-f',str(base/'mihomo.yaml')],stdout=log,stderr=log,env=env,user=uid.pw_uid,group=uid.pw_gid,extra_groups=[])
        for _ in range(60):
            if child.poll() is not None:raise RuntimeError('Mihomo exited; inspect private fixture log')
            try:
                with socket.create_connection(('127.0.0.1',18080),timeout=.1):return child
            except OSError:time.sleep(.1)
        raise RuntimeError('Mihomo listener timeout')
    def tcp(payload):
        s,_=socks(1,t.getsockname()[1])
        with s:s.sendall(payload);assert exact(s,len(payload))==payload
    def udp(payload):
        ctl,port=socks(3,0)
        with ctl,socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
            s.settimeout(4);header=b'\x00\x00\x00\x01'+socket.inet_aton('127.0.0.2')+struct.pack('!H',u.getsockname()[1]);s.sendto(header+payload,('127.0.0.1',port));data,_=s.recvfrom(65535);assert data[10:]==payload
    def check(name,fn,works=True):
        before=dict(counts);started=time.monotonic()
        try:fn();ok=True
        except (OSError,AssertionError):ok=False
        assert ok==works,name+': unexpected result'
        if not works:assert counts==before,name+': traffic reached origin unexpectedly'
        rows.append({'name':name,'expected': 'success' if works else 'failure','passed':True,'seconds':round(time.monotonic()-started,3),'originBytes':{k:counts[k]-before[k] for k in counts}})
    with socket.socket() as t,socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as u,open(base/'private.log','wb') as log:
        t.bind(('127.0.0.2',0));t.listen();u.bind(('127.0.0.2',0));threading.Thread(target=tcp_loop,args=(t,),daemon=True).start();threading.Thread(target=udp_loop,args=(u,),daemon=True).start()
        try:
            for mode in ('plain','salamander','udp-disabled'):
                config(mode);server=start_server();engine=start_engine();time.sleep(.3)
                check(mode+' TCP',lambda:tcp(os.urandom(262144)))
                check(mode+' UDP',lambda:udp(os.urandom(1024)),mode!='udp-disabled')
                if mode=='plain':
                    start=time.monotonic();r0=[resource(engine),resource(server)]
                    for _ in range(80):tcp(os.urandom(65536));udp(os.urandom(1024))
                    r1=[resource(engine),resource(server)];elapsed=time.monotonic()-start
                    resources=[{'process':name,'cpuSeconds':round(y['cpuSeconds']-x['cpuSeconds'],3),'averageOneCorePercent':round(100*(y['cpuSeconds']-x['cpuSeconds'])/elapsed,2),'rssKiB':y['rssKiB']} for name,x,y in zip(('mihomo','hysteria'),r0,r1)]
                    # Existing TCP stream must fail when the tunnel dies.
                    stream,_=socks(1,t.getsockname()[1]);stream.sendall(b'before');assert exact(stream,6)==b'before';terminate(server)
                    check('server stopped TCP',lambda:tcp(b'blocked'),False);check('server stopped UDP',lambda:udp(b'blocked'),False)
                    try:stream.sendall(b'after');assert stream.recv(5)!=b'after'
                    except OSError:pass
                    stream.close();rows.append({'name':'existing stream interrupted','passed':True})
                    server=start_server();time.sleep(.4)
                    # Same client process, no reload or restart.
                    check('server restart TCP',lambda:tcp(b'recovered'));check('server restart UDP',lambda:udp(b'recovered'))
                    run('nft','-f','-',input=b'table inet fg_hy2_fixture {\n chain output {\n type filter hook output priority 0; policy accept;\n udp dport 18443 drop\n }\n}\n')
                    try:
                        check('transport UDP blocked TCP',lambda:tcp(b'blocked'),False);check('transport UDP blocked UDP',lambda:udp(b'blocked'),False)
                    finally:run('nft','delete','table','inet','fg_hy2_fixture')
                    # QUIC may need its previous connection timeout before redial.
                    time.sleep(5)
                    check('transport restored TCP',lambda:tcp(b'recovered'));check('transport restored UDP',lambda:udp(b'recovered'))
                terminate(engine);terminate(server);engine=server=None
        finally:terminate(engine);terminate(server)
    print(json.dumps({'task':'FG-12.2','architecture':platform.machine(),'kernel':platform.release(),'mihomo':run(a.mihomo,'-v').decode().splitlines()[0],'hysteria':dict(line.split(':',1) for line in run(a.server,'version').decode().splitlines() if line.startswith(('Version:','BuildDate:','CommitHash:','Architecture:'))),'serverSha256':hashlib.sha256(pathlib.Path(a.server).read_bytes()).hexdigest(),'cases':rows,'load':{'tcpBytes':80*65536,'udpBytes':80*1024,'seconds':round(elapsed,3),'resources':resources},'productionStateChanged':False,'publicTraffic':False},indent=2))
