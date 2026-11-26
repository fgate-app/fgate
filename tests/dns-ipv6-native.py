"""Run as root under unshare -n. A second netns hosts IPv6 DNS/TLS fixtures."""
import argparse, importlib.util, json, os, pathlib, socket, ssl, struct, subprocess, sys, tempfile, threading, time
spec=importlib.util.spec_from_file_location('matrix',str(pathlib.Path(__file__).parents[1]/'server/dns-matrix.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def serve(base):
    sys.stdin.readline()  # Parent configures the private veth before binding.
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(base+'/cert.pem',base+'/key.pem')
    sockets=[];ports={}
    def answer(data):return data[:2]+struct.pack('!5H',0x8183,1,0,0,0)+data[12:]
    def client(sock,kind):
        try:
            sock.settimeout(3)
            if kind in ('dot','doh'):sock=context.wrap_socket(sock,server_side=True)
            if kind=='doh':
                header=b''
                while not header.endswith(b'\r\n\r\n'):header+=m.exact(sock,1)
                length=int(next(x.split(b':',1)[1] for x in header.split(b'\r\n') if x.lower().startswith(b'content-length:')))
                data=answer(m.exact(sock,length));sock.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/dns-message\r\nContent-Length: '+str(len(data)).encode()+b'\r\nConnection: close\r\n\r\n'+data)
            else:
                data=answer(m.exact(sock,struct.unpack('!H',m.exact(sock,2))[0]));sock.sendall(struct.pack('!H',len(data))+data)
        except (OSError,ValueError):pass
        finally:sock.close()
    def loop(sock,kind):
        while True:
            try:
                if kind=='udp':data,peer=sock.recvfrom(4096);sock.sendto(answer(data),peer)
                else:conn,_=sock.accept();threading.Thread(target=client,args=(conn,kind),daemon=True).start()
            except OSError:return
    for kind in m.TRANSPORTS:
        sock=socket.socket(socket.AF_INET6,socket.SOCK_DGRAM if kind=='udp' else socket.SOCK_STREAM);sock.bind(('fd42:37::2',0))
        if kind!='udp':sock.listen()
        sockets.append(sock);ports[kind]=sock.getsockname()[1];threading.Thread(target=loop,args=(sock,kind),daemon=True).start()
    print(json.dumps(ports),flush=True);sys.stdin.read()

if len(sys.argv)>1 and sys.argv[1]=='--serve':serve(sys.argv[2]);sys.exit(0)
parser=argparse.ArgumentParser();parser.add_argument('--mihomo',required=True);args=parser.parse_args()
def run(*command):return subprocess.run(command,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True).stdout
with tempfile.TemporaryDirectory(prefix='fg-dns6-') as base:
    run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',base+'/key.pem','-out',base+'/cert.pem','-days','1','-subj','/CN=fixture.test','-addext','subjectAltName=DNS:fixture.test')
    os.environ['SSL_CERT_FILE']=base+'/cert.pem'
    os.chmod(base,0o755);os.chmod(base+'/cert.pem',0o644)
    peer=subprocess.Popen(['unshare','-n',sys.executable,__file__,'--serve',base],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    engine=None
    try:
        # unshare execs Python without changing PID; nsenter joins only this child.
        for _ in range(50):
            try:
                if pathlib.Path('/proc/'+str(peer.pid)+'/ns/net').readlink()!=pathlib.Path('/proc/self/ns/net').readlink():break
            except OSError:pass
            time.sleep(.02)
        run('ip','link','add','fg6a','type','veth','peer','name','fg6b');run('ip','link','set','fg6b','netns',str(peer.pid))
        run('ip','-6','addr','add','fd42:37::1/64','dev','fg6a','nodad');run('ip','link','set','fg6a','up')
        run('nsenter','-t',str(peer.pid),'-n','ip','link','set','lo','up');run('nsenter','-t',str(peer.pid),'-n','ip','-6','addr','add','fd42:37::2/64','dev','fg6b','nodad');run('nsenter','-t',str(peer.pid),'-n','ip','link','set','fg6b','up')
        peer.stdin.write('ready\n');peer.stdin.flush();ports=json.loads(peer.stdout.readline())
        provider={'id':'fixture','name':'Fixture','filtering':'none','family':6,'endpoints':{kind:{'address':'fd42:37::2','family':6,'servername':'fixture.test','port':port,'path':'/dns-query'} for kind,port in ports.items()}}
        with socket.socket() as s:s.bind(('127.0.0.1',0));mixed=s.getsockname()[1]
        cfg={'mixed-port':mixed,'bind-address':'127.0.0.1','authentication':['fg-geo:fixture-secret'],'ipv6':True,'mode':'rule','log-level':'error','rules':['MATCH,DIRECT']}
        pathlib.Path(base+'/mihomo.json').write_text(json.dumps(cfg))
        engine=subprocess.Popen([args.mihomo,'-d',base,'-f',base+'/mihomo.json'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                with socket.create_connection(('127.0.0.1',mixed),timeout=.2):break
            except OSError:time.sleep(.1)
        rows=[]
        for mode in ('direct','gateway'):
            for transport in m.TRANSPORTS:
                for qtype in (1,28):
                    with socket.socket() as s:s.bind(('127.0.0.1',0));local=s.getsockname()[1]
                    proxy={'port':mixed,'secret':'fixture-secret','localPort':local} if mode=='gateway' else None
                    if mode=='gateway':
                        child=subprocess.run(['runuser','-u','freedomgate','--','env','SSL_CERT_FILE='+base+'/cert.pem',sys.executable,str(pathlib.Path(__file__).parents[1]/'server/dns-matrix.py'),'--gateway-attempt'],input=json.dumps({'provider':provider,'transport':transport,'name':'example.com','qtype':qtype,'repeat':1,'proxy':proxy}),text=True,capture_output=True,timeout=10,check=True)
                        row=json.loads(child.stdout)
                    else:row=m.attempt('fg6a',provider,transport,'example.com',qtype,1,time.monotonic()+7)
                    assert row['state']=='ok' and row['rcode']==3 and row['family']==6,(mode,row)
                    if mode=='direct':assert row['routeVerified'] and row['peerAddress']=='fd42:37::2'
                    rows.append({'mode':mode,'transport':transport,'qtype':row['qtype'],'state':row['state']})
        unavailable=json.loads(json.dumps(provider));unavailable['endpoints']['udp']['address']='2001:db8:ffff::1'
        row=m.attempt('fg6a',unavailable,'udp','example.com',1,1,time.monotonic()+5);assert row['state']=='unavailable' and row['reason']=='route-unavailable',row
        print(json.dumps({'passed':len(rows),'rows':rows,'missingIpv6Route':'unavailable, no IPv4 fallback','scope':'real IPv6 veth, isolated DNS UDP/TCP/DoT/DoH directly and through authenticated mihomo mixed listener; no public traffic'}))
    finally:
        for child in (engine,peer):
            if child is not None:
                child.terminate()
                try:child.wait(timeout=3)
                except subprocess.TimeoutExpired:child.kill();child.wait()
