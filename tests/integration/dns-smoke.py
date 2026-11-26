#!/usr/bin/env python3
"""Local-only AdGuard -> mihomo DNS -> UDP fixture; no public DNS queries."""
import contextlib
import argparse, json, pathlib, socket, struct, subprocess, tempfile, threading, time

def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); return sock.getsockname()[1]

def query(name,target):
    qname=b''.join(bytes([len(part)])+part.encode() for part in name.split('.'))+b'\0'
    packet=struct.pack('!HHHHHH',1234,0x100,1,0,0,0)+qname+struct.pack('!HH',1,1)
    with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:
        sock.settimeout(2);sock.sendto(packet,('127.0.0.1',target));data=sock.recv(4096)
    return data

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--modules',required=True,type=pathlib.Path);args=parser.parse_args()
    fixture=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);fixture.bind(('127.0.0.1',0));fixture.settimeout(.2)
    queries=[];stop=threading.Event();processes=[]
    def serve():
        while not stop.is_set():
            try:data,address=fixture.recvfrom(4096)
            except socket.timeout:continue
            except OSError:return
            queries.append(data)
            offset=12
            while data[offset]:offset+=data[offset]+1
            end=offset+5
            qtype=struct.unpack('!H',data[end-4:end-2])[0]
            count=1 if qtype==1 else 0
            answer=data[:2]+struct.pack('!HHHHH',0x8180,1,count,0,0)+data[12:end]
            if count:answer+=b'\xc0\x0c'+struct.pack('!HHIH',1,1,60,4)+socket.inet_aton('198.51.100.10')
            fixture.sendto(answer,address)
    thread=threading.Thread(target=serve,daemon=True);thread.start()
    directory=tempfile.TemporaryDirectory(prefix='fg-dns-smoke-')
    try:
        with contextlib.nullcontext(directory.name) as folder:
            base=pathlib.Path(folder);(base/'adguard-data').mkdir();mdns,adns,webport=port(),port(),port()
            m={'allow-lan':False,'mode':'rule','log-level':'error','tun':{'enable':False},'dns':{'enable':True,'listen':f'127.0.0.1:{mdns}','enhanced-mode':'redir-host','ipv6':False,'nameserver':[f'udp://127.0.0.1:{fixture.getsockname()[1]}']},'rules':['MATCH,DIRECT']}
            a={'http':{'address':f'127.0.0.1:{webport}'},'users':[],'dns':{'bind_hosts':['127.0.0.1'],'port':adns,'upstream_dns':[f'127.0.0.1:{mdns}'],'bootstrap_dns':[],'cache_size':1048576,'blocking_mode':'null_ip'},'filtering':{'protection_enabled':True,'filtering_enabled':True},'filters':[],'user_rules':['||ads.example.test^'],'schema_version':34}
            (base/'mihomo.json').write_text(json.dumps(m));(base/'adguard.yaml').write_text(json.dumps(a))
            with (base/'module.log').open('w+') as log:
                commands=[[str(args.modules/'mihomo/v1.19.33/mihomo'),'-d',folder,'-f',str(base/'mihomo.json')],[str(args.modules/'adguard/v0.107.80/AdGuardHome'),'-c',str(base/'adguard.yaml'),'-w',str(base/'adguard-data'),'--no-check-update']]
                for command in commands:processes.append(subprocess.Popen(command,stdout=log,stderr=log))
                result=None
                for _ in range(50):
                    if any(p.poll() is not None for p in processes):
                        log.flush();raise RuntimeError('Module exited: '+(base/'module.log').read_text()[-2500:])
                    try:result=query('allowed.example.test',adns);break
                    except (TimeoutError,ConnectionRefusedError,OSError):time.sleep(.2)
                assert result and socket.inet_aton('198.51.100.10') in result, 'DNS chain did not resolve fixture domain'
                before=len(queries);blocked=query('ads.example.test',adns)
                assert socket.inet_aton('198.51.100.10') not in blocked, 'AdGuard did not filter blocked name'
                assert len(queries)==before, 'Blocked name reached upstream'
                print(json.dumps({'adguard_to_mihomo_to_fixture':'passed','adguard_blocking':'passed','public_dns_queries':False,'tun_enabled':False}))
    finally:
        for process in reversed(processes):
            process.terminate()
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.wait()
        stop.set();thread.join(timeout=1);fixture.close();directory.cleanup()

if __name__=='__main__':main()
