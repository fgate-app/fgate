"""Shared SOCKS5, echo and resource helpers for isolated native acceptance tests."""
import os, pathlib, socket, struct, subprocess, threading
def run(*args,**kw):return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kw).stdout
def exact(s,n):
    b=b''
    while len(b)<n:
        d=s.recv(n-len(b))
        if not d:raise OSError('Unexpected EOF')
        b+=d
    return b
def reply(s):
    h=exact(s,4)
    if h[1]!=0:raise OSError('SOCKS request failed')
    exact(s,{1:4,4:16}.get(h[3],0));return struct.unpack('!H',exact(s,2))[0]
def socks(command,port,proxy_port=18080):
    s=socket.create_connection(('127.0.0.1',proxy_port),timeout=4);s.sendall(b'\x05\x01\x00');assert exact(s,2)==b'\x05\x00'
    s.sendall(bytes([5,command,0,1])+socket.inet_aton('0.0.0.0' if command==3 else '127.0.0.2')+struct.pack('!H',port));return s,reply(s)
counts={'tcp':0,'udp':0}
def tcp_loop(listener):
    def client(s):
        with s:
            try:
                while True:
                    b=s.recv(65536)
                    if not b:return
                    counts['tcp']+=len(b);s.sendall(b)
            except OSError:pass
    while True:
        try:s,_=listener.accept();threading.Thread(target=client,args=(s,),daemon=True).start()
        except OSError:return
def udp_loop(s):
    while True:
        try:b,addr=s.recvfrom(65535);counts['udp']+=len(b);s.sendto(b,addr)
        except OSError:return
def terminate(p):
    if p and p.poll() is None:
        p.terminate()
        try:p.wait(4)
        except subprocess.TimeoutExpired:p.kill();p.wait()
def resource(p):
    st=pathlib.Path('/proc/'+str(p.pid)+'/stat').read_text().split();status=pathlib.Path('/proc/'+str(p.pid)+'/status').read_text().splitlines()
    return {'cpuSeconds':(int(st[13])+int(st[14]))/os.sysconf('SC_CLK_TCK'),'rssKiB':int(next(x for x in status if x.startswith('VmRSS:')).split()[1])}
