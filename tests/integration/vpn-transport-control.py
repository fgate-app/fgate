#!/usr/bin/env python3
"""Opt-in Xray control without mihomo, namespace or TCP relay. No host changes."""
import argparse
import ipaddress
import json
import os
import pathlib
import socket
import struct
import subprocess
import tempfile
import time


def read_exact(sock, size):
    data=b''
    while len(data)<size:
        chunk=sock.recv(size-len(data))
        if not chunk: raise OSError('Short SOCKS response')
        data+=chunk
    return data


def udp_exchange(proxy_port, address, port, payload):
    with socket.create_connection(('127.0.0.1',proxy_port),timeout=10) as tcp, socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as udp:
        udp.bind(('127.0.0.1',0));udp.settimeout(10)
        tcp.sendall(b'\5\1\0');assert read_exact(tcp,2)==b'\5\0'
        tcp.sendall(b'\5\3\0\1'+socket.inet_aton('127.0.0.1')+struct.pack('!H',udp.getsockname()[1]))
        head=read_exact(tcp,4);assert head[:2]==b'\5\0' and head[3]==1
        relay=socket.inet_ntoa(read_exact(tcp,4));relayport=struct.unpack('!H',read_exact(tcp,2))[0]
        udp.sendto(b'\0\0\0\1'+socket.inet_aton(address)+struct.pack('!H',port)+payload,(relay,relayport))
        response=udp.recv(4096);assert response[:4]==b'\0\0\0\1'
        return response[10:]


def mihomo_restart_control(xray_binary, xray_port, base, record):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));mixed_port=sock.getsockname()[1]
    with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:
        sock.bind(('127.0.0.1',0));dns_port=sock.getsockname()[1]
    mihomo=pathlib.Path(xray_binary).parents[2]/'mihomo/v1.19.33/mihomo'
    for phase in ['initial','mihomo-only-restart']:
        folder=base/phase;folder.mkdir()
        config={'mixed-port':mixed_port,'allow-lan':False,'bind-address':'127.0.0.1','mode':'rule','log-level':'warning','ipv6':False,'tun':{'enable':False},
            'dns':{'enable':True,'listen':f'127.0.0.1:{dns_port}','use-hosts':False,'use-system-hosts':False,'enhanced-mode':'redir-host','nameserver':['https://cloudflare-dns.com/dns-query#xray','https://dns.google/dns-query#xray']},
            'proxies':[{'name':'xray','type':'socks5','server':'127.0.0.1','port':xray_port,'udp':True}],'rules':['MATCH,xray']}
        mf=folder/'mihomo.json';mf.write_text(json.dumps(config))
        with (folder/'private.log').open('w') as log:
            process=subprocess.Popen([str(mihomo),'-d',str(folder),'-f',str(mf)],stdout=log,stderr=log)
            try:
                for _ in range(150):
                    if process.poll() is not None:raise RuntimeError('mihomo exited')
                    try:
                        with socket.create_connection(('127.0.0.1',mixed_port),.1):break
                    except OSError:time.sleep(.1)
                attempts=[];started=time.monotonic()
                for trial in range(3):
                    with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as udp:
                        udp.settimeout(7)
                        request=struct.pack('!HHHHHH',12345,0x100,1,0,0,0)+b'\7example\3com\0\0\1\0\1'
                        udp.sendto(request,('127.0.0.1',dns_port))
                        try:
                            response=udp.recv(4096)
                            ok=len(response)>=12 and response[:2]==request[:2] and response[3]&15==0 and struct.unpack('!H',response[6:8])[0]>0
                        except OSError:ok=False
                    attempts.append(ok)
                    if ok:break
                    if trial<2:time.sleep(1)
                record('functional_dns_'+phase,any(attempts),attempts=attempts,seconds=round(time.monotonic()-started,2))
            finally:
                process.terminate()
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:process.kill();process.wait()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--xray-config',required=True,type=pathlib.Path)
    parser.add_argument('--xray',default='/opt/freedomgate/modules/xray/v26.10.31/xray')
    parser.add_argument('--report',required=True,type=pathlib.Path)
    parser.add_argument('--mihomo-restart-check',action='store_true',help='Only compare initial/restarted mihomo with one persistent Xray in host network')
    args=parser.parse_args();os.umask(0o077)
    original=json.loads(args.xray_config.read_text())
    outbound=original['outbounds']
    assert len(outbound)==1 and outbound[0]['protocol']=='vless'
    ipaddress.ip_address(outbound[0]['settings']['vnext'][0]['address'])
    report={'scope':('mihomo restart, host network, no namespace or TCP relay' if args.mihomo_restart_check else 'original Xray control, no mihomo or namespace or TCP relay'),'tests':[]}
    def record(name,passed,**details):
        row={'test':name,'passed':bool(passed),**details};report['tests'].append(row);print(json.dumps(row),flush=True)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix='fg-private-control-') as folder:
        base=pathlib.Path(folder);f=base/'xray.json'
        f.write_text(json.dumps({'log':{'loglevel':'error'},'inbounds':[{'listen':'127.0.0.1','port':port,'protocol':'socks','settings':{'auth':'noauth','udp':True}}],'outbounds':outbound}))
        with (base/'private.log').open('w') as log:
            process=subprocess.Popen([args.xray,'run','-config',str(f)],stdout=log,stderr=log)
            def curl(url,*extra):
                return subprocess.run(['curl','--noproxy','','--silent','--max-time','12','--proxy',f'socks5h://127.0.0.1:{port}',*extra,url],capture_output=True,text=True,timeout=15)
            try:
                for _ in range(150):
                    if process.poll() is not None:raise RuntimeError('Xray exited')
                    try:
                        with socket.create_connection(('127.0.0.1',port),.1):break
                    except OSError:time.sleep(.1)
                if args.mihomo_restart_check:
                    mihomo_restart_control(args.xray,port,base,record)
                else:
                    for trial in range(3):
                        r=curl('https://1.1.1.1/cdn-cgi/trace','--output','/dev/null','--write-out','%{http_code} %{time_total}')
                        record('https_literal_ip',r.returncode==0 and r.stdout.startswith('200 '),trial=trial+1,curl_exit=r.returncode,http_seconds=r.stdout)
                    for address in ['1.1.1.1','8.8.8.8']:
                        query=struct.pack('!HHHHHH',12345,0x100,1,0,0,0)+b'\7example\3com\0\0\1\0\1'
                        try:
                            response=udp_exchange(port,address,53,query)
                            ok=len(response)>=12 and response[:2]==query[:2] and response[3]&15==0 and struct.unpack('!H',response[6:8])[0]>0
                            record('udp_dns',ok,resolver=address)
                        except (OSError,AssertionError) as error:record('udp_dns',False,resolver=address,error_type=type(error).__name__)
                    # Resolve the public STUN service through HTTPS inside the VPN.
                    r=curl('https://cloudflare-dns.com/dns-query?name=stun.cloudflare.com&type=A','--header','accept: application/dns-json','--fail')
                    try:
                        answers=json.loads(r.stdout).get('Answer',[])
                        addresses=[str(ipaddress.IPv4Address(x['data'])) for x in answers if x['type']==1]
                    except (ValueError,KeyError):addresses=[]
                    record('stun_bootstrap_doh',r.returncode==0 and bool(addresses),curl_exit=r.returncode)
                    if addresses:
                        tid=os.urandom(12);request=struct.pack('!HHI',1,0,0x2112a442)+tid
                        try:
                            response=udp_exchange(port,addresses[0],3478,request)
                            ok=len(response)>=20 and response[:2]==b'\1\1' and response[4:8]==request[4:8] and response[8:20]==tid
                            # Do not retain mapped addresses or response bodies.
                            record('udp_stun',ok)
                        except (OSError,AssertionError) as error:record('udp_stun',False,error_type=type(error).__name__)
                    else:report['stun_not_tested']='DoH bootstrap unavailable'
            finally:
                process.terminate()
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:process.kill();process.wait()
    report['passed']=all(row['passed'] for row in report['tests']) and not report.get('stun_not_tested')
    args.report.write_text(json.dumps(report,indent=2)+'\n');args.report.chmod(0o600)
    return 0 if report['passed'] else 1


if __name__=='__main__':raise SystemExit(main())
