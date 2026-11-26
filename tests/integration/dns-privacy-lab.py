#!/usr/bin/env python3
"""Root-only, opt-in real VPN fault lab. Never changes host routes/firewall.

A private namespace reaches the real VPN through a TCP byte relay on a veth.
Namespace nftables permits only that relay and loopback. All direct DNS/DoH/DoT
and other egress is rejected. This proves isolation of this chain, not LAN TUN.
Raw captures/logs are private temporary files and are removed after analysis.
"""
import argparse
import concurrent.futures
import copy
import ipaddress
import json
import os
import pathlib
import re
import socket
import signal
import select
import socketserver
import struct
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import urlsplit


def command(*args, **kw):
    return subprocess.run(list(args), capture_output=True, text=True, timeout=kw.pop('timeout', 15), **kw)


class TransportUnreachable(RuntimeError):
    """The real VPN endpoint refused or blackholed TCP before any scenario ran."""


def checked(*args, **kw):
    result = command(*args, **kw)
    if result.returncode:
        raise RuntimeError('Infrastructure command failed: ' + args[0])
    return result.stdout.strip()


def dns_query(name, ident=12345, qtype=1):
    labels = b''.join(bytes([len(x)]) + x.encode() for x in name.split('.'))
    return struct.pack('!HHHHHH', ident, 0x0100, 1, 0, 0, 0) + labels + b'\0' + struct.pack('!HH',qtype,1)


def dns_ok(data):
    return len(data) >= 12 and struct.unpack('!H', data[:2])[0] == 12345 and data[3] & 15 == 0 and struct.unpack('!H', data[6:8])[0] > 0


def dns_addresses(data, qtype=1):
    if not dns_ok(data):return []
    def skip_name(offset):
        while data[offset]:
            if data[offset]&0xc0==0xc0:return offset+2
            offset+=data[offset]+1
        return offset+1
    offset=12
    for _ in range(struct.unpack('!H',data[4:6])[0]):offset=skip_name(offset)+4
    addresses=[]
    for _ in range(struct.unpack('!H',data[6:8])[0]):
        offset=skip_name(offset)
        rtype,rclass,ttl,length=struct.unpack('!HHIH',data[offset:offset+10]);offset+=10
        if rtype==qtype and rclass==1:
            if qtype==1 and length==4:addresses.append(socket.inet_ntoa(data[offset:offset+4]))
            if qtype==28 and length==16:addresses.append(socket.inet_ntop(socket.AF_INET6,data[offset:offset+16]))
        offset+=length
    return addresses


def readiness_state(transport_ok, dns_ok):
    """Map two independent observations to an explicit supervisor state.

    An open listener is never treated as health: transport must carry TLS first,
    and DNS must answer a real query. This mirrors what a supervisor should show.
    """
    if not transport_ok:return 'down'
    return 'ready' if dns_ok else 'degraded'


def first_success(rows, layer):
    """Earliest timeline offset where a layer answered; None if it never did."""
    for row in rows:
        value=row.get(layer)
        if isinstance(value,dict) and value.get('ok') is True:return row['t']
    return None


def summarize_timeline(rows, layers=None):
    layers=layers or ['endpoint_tcp','xray_tls_ip','doh_cloudflare','doh_google','mihomo_dns']
    summary={'ticks':len(rows),'first_success':{layer:first_success(rows,layer) for layer in layers},'transitions':[]}
    state=None
    for row in rows:
        transport=(row.get('xray_tls_ip') or {}).get('ok') is True
        dns=(row.get('mihomo_dns') or {}).get('ok') is True
        current=readiness_state(transport,dns)
        if current!=state:
            summary['transitions'].append({'t':row['t'],'state':current});state=current
    summary['final_state']=state
    return summary


def receive(sock, size):
    data = b''
    while len(data) < size:
        part = sock.recv(size - len(data))
        if not part:
            raise OSError('Short SOCKS response')
        data += part
    return data


def relay_server(config_path):
    config=json.loads(pathlib.Path(config_path).read_text())
    class Relay(socketserver.BaseRequestHandler):
        def handle(self):
            try:
                with socket.create_connection((config['endpoint'],config['port']),timeout=5) as upstream:
                    upstream.settimeout(10);self.request.settimeout(10)
                    peers=[self.request,upstream]
                    while True:
                        readable,_,_=select.select(peers,[],[],30)
                        for source in readable:
                            data=source.recv(65536)
                            if not data:return
                            (upstream if source is self.request else self.request).sendall(data)
            except OSError:
                # Do not log remote endpoints or protocol material.
                pass
    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address=True
        daemon_threads=True
    with Server((config['bind'],config['listen']),Relay) as server:
        print('relay_ready',flush=True)
        server.serve_forever()


def worker(kind, domain=None):
    if kind == 'poison':
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
            udp.bind(('127.0.0.1',15354))
            print('ready',flush=True)
            while True:
                query, address = udp.recvfrom(4096)
                if len(query)<12: continue
                end=12
                while end<len(query) and query[end]: end += query[end]+1
                if end+5>len(query): continue
                question=query[12:end+5]
                answer=query[:2]+struct.pack('!HHHHH',0x8180,1,1,0,0)+question+b'\xc0\x0c'+struct.pack('!HHIH',1,1,0,4)+socket.inet_aton('203.0.113.99')
                udp.sendto(answer,address)
                print('poison_answer',flush=True)
        return
    try:
        if kind in ['udp','udp-google','stun']:
            with socket.create_connection(('127.0.0.1', 17891), timeout=10) as tcp, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
                udp.bind(('127.0.0.1', 0)); udp.settimeout(10)
                tcp.sendall(b'\5\1\0')
                assert receive(tcp, 2) == b'\5\0'
                tcp.sendall(b'\5\3\0\1' + socket.inet_aton('127.0.0.1') + struct.pack('!H', udp.getsockname()[1]))
                head = receive(tcp, 4)
                assert head[:2] == b'\5\0' and head[3] == 1
                address = socket.inet_ntoa(receive(tcp, 4)); port = struct.unpack('!H', receive(tcp, 2))[0]
                if kind=='stun':
                    with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as resolver:
                        resolver.settimeout(7)
                        resolver.sendto(dns_query('stun.cloudflare.com'),('127.0.0.1',15353))
                        addresses=dns_addresses(resolver.recv(4096))
                    if not addresses:
                        print(json.dumps({'ok':False,'stage':'stun_dns_bootstrap'}));return
                    tid=os.urandom(12)
                    request=struct.pack('!HHI',1,0,0x2112a442)+tid
                    destination=b'\1'+socket.inet_aton(addresses[0])+struct.pack('!H',3478)
                else:
                    request=dns_query('example.com')
                    destination=b'\1'+socket.inet_aton('8.8.8.8' if kind=='udp-google' else '1.1.1.1')+b'\0\x35'
                udp.sendto(b'\0\0\0'+destination+request,(address,port))
                packet=udp.recv(4096)
                assert packet[:3]==b'\0\0\0'
                offset={1:10,4:22}.get(packet[3])
                if packet[3]==3:offset=7+packet[4]
                assert offset is not None
                data=packet[offset:]
                if kind=='stun':
                    ok=len(data)>=20 and data[:2]==b'\1\1' and data[4:8]==request[4:8] and data[8:20]==tid
                    print(json.dumps({'ok':bool(ok),'protocol':'STUN'}));return
                ok=dns_ok(data)
        else:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
                # 'dnsq' bounds a single probe so a layered timeline stays dense.
                udp.settimeout(4 if kind=='dnsq' else 10)
                udp.sendto(dns_query(domain or ('example.org' if kind == 'dns2' else 'example.com'),qtype=28 if kind=='resolve6' else 1), ('127.0.0.1', 15353))
                data = udp.recv(4096)
                ok = dns_ok(data)
                if kind in ['resolve','resolve6']:
                    addresses=dns_addresses(data,28 if kind=='resolve6' else 1)
                    print(json.dumps({'ok':bool(ok and addresses),'addresses':addresses}));return
        print(json.dumps({'ok': bool(ok), 'rcode':(data[3]&15) if len(data)>=12 else None, 'response_id':struct.unpack('!H',data[:2])[0] if len(data)>=12 else None}))
    except (OSError, AssertionError, IndexError, struct.error) as error:
        print(json.dumps({'ok': False,'error_type':type(error).__name__}))


def capture_summary(path, allowed_address, allowed_port, source_mac=None):
    raw = pathlib.Path(path).read_bytes()
    if len(raw) < 24:
        raise RuntimeError('Empty capture file')
    if raw[:4] not in [b'\xd4\xc3\xb2\xa1', b'\x4d\x3c\xb2\xa1', b'\xa1\xb2\xc3\xd4', b'\xa1\xb2\x3c\x4d']:
        raise RuntimeError('Unknown capture format')
    endian = '<' if raw[:4] in [b'\xd4\xc3\xb2\xa1', b'\x4d\x3c\xb2\xa1'] else '>'
    linktype = struct.unpack(endian+'I', raw[20:24])[0]
    if linktype != 1:
        raise RuntimeError('Expected Ethernet capture')
    offset = 24
    counts = {'packets': 0, 'ipv4': 0, 'ipv6': 0, 'dns53': 0, 'dot853': 0, 'unexpected_ip': 0, 'tcp_payload_packets': 0, 'outbound_ipv6': 0, 'unexpected_outbound': 0}
    while offset + 16 <= len(raw):
        length = struct.unpack(endian+'I', raw[offset+8:offset+12])[0]
        if offset+16+length>len(raw): raise RuntimeError('Truncated capture record')
        packet = raw[offset+16:offset+16+length]; offset += 16 + length
        counts['packets'] += 1
        if len(packet) < 14: continue
        kind = packet[12:14]
        outbound_frame = source_mac is not None and packet[6:12] == bytes.fromhex(source_mac.replace(':',''))
        if kind == b'\x86\xdd':
            counts['ipv6'] += 1
            if outbound_frame: counts['outbound_ipv6'] += 1
            continue
        if kind != b'\x08\0' or len(packet) < 34: continue
        counts['ipv4'] += 1
        ihl = (packet[14] & 15) * 4
        protocol = packet[23]
        src, dst = socket.inet_ntoa(packet[26:30]), socket.inet_ntoa(packet[30:34])
        start = 14+ihl
        if protocol not in [6, 17] or len(packet) < start+4:
            counts['unexpected_ip'] += 1
            if outbound_frame: counts['unexpected_outbound'] += 1
            continue
        sport, dport = struct.unpack('!HH', packet[start:start+4])
        if 53 in [sport, dport]: counts['dns53'] += 1
        if 853 in [sport, dport]: counts['dot853'] += 1
        if protocol != 6 or not ((dst == allowed_address and dport == allowed_port) or (src == allowed_address and sport == allowed_port)):
            counts['unexpected_ip'] += 1
            if outbound_frame: counts['unexpected_outbound'] += 1
        elif len(packet) >= start+20:
            tcp_header = (packet[start+12] >> 4)*4
            total = struct.unpack('!H', packet[16:18])[0]
            if total > ihl+tcp_header: counts['tcp_payload_packets'] += 1
    if offset != len(raw): raise RuntimeError('Truncated capture header')
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--xray-config', type=pathlib.Path, required=True)
    parser.add_argument('--modules', type=pathlib.Path, default='/opt/freedomgate/modules')
    parser.add_argument('--report', type=pathlib.Path, required=True)
    parser.add_argument('--recovery-only',action='store_true',help='Compare functional readiness after mihomo-only and Xray restarts')
    parser.add_argument('--recovery-budget',type=float,default=60,help='Functional DNS readiness budget in seconds (5..120)')
    parser.add_argument('--udp-control-only',action='store_true',help='Only healthy DNS/HTTPS and numeric-target UDP STUN, with captures')
    parser.add_argument('--layered',action='store_true',help='Sample transport/DoH/DNS layers over time across controlled restarts')
    parser.add_argument('--layered-budget',type=float,default=60,help='Seconds of layered sampling per scenario (10..180)')
    args = parser.parse_args()
    if sum([args.recovery_only,args.udp_control_only,args.layered])>1:parser.error('Choose one scoped mode')
    if not 5<=args.recovery_budget<=120:parser.error('Recovery budget must be 5..120 seconds')
    if not 10<=args.layered_budget<=180:parser.error('Layered budget must be 10..180 seconds')
    if os.geteuid() != 0: raise SystemExit('Requires root on test Linux')
    os.umask(0o077)
    config = json.loads(args.xray_config.read_text())
    outbound = copy.deepcopy(config['outbounds'][0])
    if len(config['outbounds']) != 1 or outbound['protocol'] != 'vless': raise ValueError('One VLESS outbound required')
    node = outbound['settings']['vnext'][0]
    endpoint = str(ipaddress.IPv4Address(node['address'])); endpoint_port = int(node['port'])
    suffix = uuid.uuid4().hex[:7]; ns = 'fg-dns-'+suffix
    hostlink, peer = 'fh'+suffix, 'fn'+suffix
    hostip, childip = '198.18.77.1', '198.18.77.2'
    # Only this isolated veth uses these addresses. Refuse collisions, including other labs.
    addresses = json.loads(checked('ip','-j','addr'))
    if any(a.get('local','').startswith('198.18.77.') for i in addresses for a in i.get('addr_info', [])):
        raise RuntimeError('Lab subnet already in use')
    original_routes = checked('ip','-4','route','show','default')
    original_firewall = checked('nft','list','ruleset')
    temporary = tempfile.TemporaryDirectory(prefix='fg-private-dns-')
    base = pathlib.Path(temporary.name); processes = []; module_processes = []
    report = {'scope': 'isolated SOCKS/DNS chain, not whole LAN or TUN', 'mode':'recovery' if args.recovery_only else ('udp-control' if args.udp_control_only else ('layered-readiness' if args.layered else 'full-fault-matrix')), 'matrix_completed':False, 'tests': [], 'probes': [], 'captures': {}, 'limitations': [
        'No claim of invisibility to ISP or universal DPI bypass.',
        'Host TCP relay replaces endpoint address only; REALITY authentication settings unchanged.',
        'No IPv6 uplink on the test host; IPv6-over-VPN is a separate remote-egress test.',
        'Captured DNS observations cover this namespace only, not other host processes.',
        'Layered endpoint TCP probes are short direct TCP connects to the VPN port from the host, matching what the relay itself does.']}
    def record(name, passed, **details):
        row = {'test': name, 'passed': bool(passed), **details}
        report['tests'].append(row); print(json.dumps(row), flush=True)
    def inside(*cmd, **kw): return command('ip','netns','exec',ns,*cmd,**kw)
    def spawn(cmd, logfile):
        f = (base/logfile).open('w')
        try: p = subprocess.Popen(cmd, stdout=f, stderr=f, start_new_session=True)
        finally: f.close()
        processes.append(p); return p
    def stop(p):
        try: os.killpg(p.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try: os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            p.wait()
    def kill_hard(p):
        try: os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        p.wait(timeout=5)
    def ready(port, process, namespace=True):
        for _ in range(150):
            if process.poll() is not None: raise RuntimeError('Module exited before readiness')
            cmd = ['python3','-c', f'import socket;socket.create_connection(("127.0.0.1",{port}),.2).close()']
            r = inside(*cmd) if namespace else command(*cmd)
            if r.returncode == 0: return
            time.sleep(.1)
        raise RuntimeError('Listener not ready')
    def worker_ok(kind):
        started=time.monotonic()
        result = inside('python3', str(pathlib.Path(__file__).resolve()), '--worker', kind, timeout=25)
        try: details=json.loads(result.stdout);ok=result.returncode==0 and details['ok']
        except (ValueError, KeyError):ok=False;details={'error_type':'WorkerOutputError'}
        report['probes'].append({'kind':kind,**details,'ok':bool(ok),'seconds':round(time.monotonic()-started,2)})
        return ok
    def https(url='https://www.gstatic.com/generate_204', expected='204', proxy=True, local_dns=True, ipv6=False):
        cmd = ['curl','--noproxy','','--silent','--output','/dev/null','--write-out','%{http_code}', '--max-time','8']
        if proxy:
            target=urlsplit(url).hostname
            try: ipaddress.ip_address(target); is_ip=True
            except ValueError: is_ip=False
            if local_dns and not is_ip:
                lookup=inside('python3',str(pathlib.Path(__file__).resolve()),'--worker','resolve6' if ipv6 else 'resolve',target,timeout=15)
                try: resolved=json.loads(lookup.stdout)
                except ValueError:return False
                if not resolved.get('ok'):return False
                address=resolved['addresses'][0]
                cmd += ['--resolve',f'{target}:443:'+('['+address+']' if ipv6 else address)]
            cmd += ['--proxy',('socks5' if local_dns else 'socks5h')+'://127.0.0.1:17891']
        else: cmd += ['--noproxy','*']
        started=time.monotonic()
        result = inside(*cmd,url,timeout=12)
        ok=result.returncode==0 and result.stdout==expected
        report['probes'].append({'kind':'https','ok':ok,'curl_exit':result.returncode,'http':result.stdout,'seconds':round(time.monotonic()-started,2)})
        return ok
    def bounded_check(name, probe, attempts=3, budget=None):
        results=[];started=time.monotonic()
        for index in range(attempts):
            results.append(bool(probe()))
            if results[-1] or (budget is not None and time.monotonic()-started>=budget):break
            if index+1<attempts:time.sleep(1)
        record(name,any(results),attempts=results,seconds=round(time.monotonic()-started,2),budget_seconds=budget)
        return any(results)
    def drop_counters():
        data=json.loads(inside('nft','-j','list','table','inet','fg_lab').stdout)
        return {entry['rule']['comment']:sum(e.get('counter',{}).get('packets',0) for e in entry['rule']['expr']) for entry in data['nftables'] if entry.get('rule',{}).get('comment')}
    def no_direct_attempts(name, before):
        after=drop_counters()
        delta={key:after.get(key,0)-value for key,value in before.items()}
        record(name,all(value==0 for value in delta.values()),blocked_egress_attempts=delta)
    def start_modules(resolver=None, poison_bootstrap=False, ipv6=False, keep_xray=False, keep_mihomo=False):
        nonlocal module_processes
        if resolver is None:resolver=['https://cloudflare-dns.com/dns-query#xray','https://dns.google/dns-query#xray']
        old_xray=module_processes[0] if module_processes and keep_xray and module_processes[0].poll() is None else None
        old_mihomo=module_processes[1] if len(module_processes)>1 and keep_mihomo and module_processes[1].poll() is None else None
        for p in reversed(module_processes):
            if p is not old_xray and p is not old_mihomo:stop(p)
        module_processes=[]
        folder = base/uuid.uuid4().hex; folder.mkdir(mode=0o700)
        xconfig = {'log':{'loglevel':'warning'},'inbounds':[{'listen':'127.0.0.1','port':17892,'protocol':'socks','settings':{'auth':'noauth','udp':True}}],'outbounds':[outbound]}
        mconfig = {'mixed-port':17891,'allow-lan':False,'bind-address':'127.0.0.1','mode':'rule','log-level':'warning','ipv6':ipv6,
            'profile':{'store-selected':False,'store-fake-ip':False}, 'tun':{'enable':False},
            'dns':{'enable':True,'listen':'127.0.0.1:15353','ipv6':ipv6,'use-hosts':False,'use-system-hosts':False,
                'enhanced-mode':'redir-host','nameserver':([resolver] if isinstance(resolver,str) else resolver)},
            'proxies':[{'name':'xray','type':'socks5','server':'127.0.0.1','port':17892,'udp':True}], 'rules':['MATCH,xray']}
        if poison_bootstrap:
            xconfig=copy.deepcopy(xconfig)
            xconfig['outbounds'][0]['settings']['vnext'][0]['address']='fg-bootstrap.invalid'
            xconfig['outbounds'][0]['streamSettings'].setdefault('sockopt',{})['domainStrategy']='UseIPv4'
            xconfig['dns']={'servers':[{'address':'127.0.0.1','port':15354}],'queryStrategy':'UseIPv4'}
            xconfig['outbounds'].append({'tag':'bootstrap-fixture','protocol':'freedom'})
            xconfig['routing']={'rules':[{'type':'field','ip':['127.0.0.1/32'],'port':'15354','network':'udp','outboundTag':'bootstrap-fixture'}]}
        xf, mf = folder/'xray.json', folder/'mihomo.json'; xf.write_text(json.dumps(xconfig)); mf.write_text(json.dumps(mconfig))
        xp=old_xray or spawn(['ip','netns','exec',ns,str(args.modules/'xray/v26.10.31/xray'),'run','-config',str(xf)],'xray.log')
        module_processes.append(xp);ready(17892,xp)
        mp = old_mihomo or spawn(['ip','netns','exec',ns,str(args.modules/'mihomo/v1.19.33/mihomo'),'-d',str(folder),'-f',str(mf)],'mihomo.log'); module_processes.append(mp); ready(17891,mp)
        return xp, mp
    def worker_raw(kind):
        result = inside('python3', str(pathlib.Path(__file__).resolve()), '--worker', kind, timeout=20)
        try: details=json.loads(result.stdout)
        except ValueError: details={'error_type':'WorkerOutputError'}
        return result.returncode==0 and bool(details.get('ok')), details
    def probe_endpoint_tcp():
        started=time.monotonic()
        try:
            with socket.create_connection((endpoint,endpoint_port),timeout=3):stage='connected'
            ok=True
        except OSError as error:ok=False;stage=type(error).__name__
        return {'ok':ok,'stage':stage,'seconds':round(time.monotonic()-started,2)}
    def probe_xray_tls_ip():
        # TLS to a known resolver by literal IP: transport only, no DNS involvement.
        started=time.monotonic()
        result=inside('curl','--noproxy','','--silent','--output','/dev/null','--write-out','%{http_code}','--max-time','4','--connect-timeout','3',
            '--proxy','socks5://127.0.0.1:17892','--resolve','dns.google:443:8.8.8.8','https://dns.google/resolve?name=example.com',timeout=8)
        return {'ok':result.returncode==0 and result.stdout=='200','stage':result.stdout or result.returncode,'seconds':round(time.monotonic()-started,2)}
    def probe_doh(host):
        # One DoH exchange through Xray, exactly like mihomo's nameserver with #xray.
        started=time.monotonic(); output=base/f'doh-{host}.bin'
        result=inside('curl','--noproxy','','--silent','--max-time','4','--connect-timeout','3','--proxy','socks5h://127.0.0.1:17892',
            '--output',str(output),'--write-out','%{http_code}','--header','content-type: application/dns-message',
            '--data-binary','@'+str(doh_query),'https://'+host+'/dns-query',timeout=8)
        try:payload=output.read_bytes()
        except OSError:payload=b''
        return {'ok':result.returncode==0 and result.stdout=='200' and dns_ok(payload),'stage':result.stdout or result.returncode,
            'rcode':(payload[3]&15) if len(payload)>=12 else None,'seconds':round(time.monotonic()-started,2)}
    def probe_mihomo_dns():
        started=time.monotonic(); ok,details=worker_raw('dnsq')
        return {'ok':ok,'stage':'rcode=%s'%details.get('rcode'),'seconds':round(time.monotonic()-started,2)}
    def layered_timeline(name,budget):
        probes={'endpoint_tcp':probe_endpoint_tcp,'xray_tls_ip':probe_xray_tls_ip,'doh_cloudflare':lambda:probe_doh('cloudflare-dns.com'),
            'doh_google':lambda:probe_doh('dns.google'),'mihomo_dns':probe_mihomo_dns}
        rows=[];started=time.monotonic();tick=2.0
        while True:
            offset=round(time.monotonic()-started,2)
            if offset>budget:break
            with concurrent.futures.ThreadPoolExecutor(max_workers=len(probes)) as pool:
                futures={layer:pool.submit(fn) for layer,fn in probes.items()}
                results={}
                for layer,future in futures.items():
                    try:results[layer]=future.result(timeout=9)
                    except Exception:results[layer]={'ok':None,'stage':'probe_timeout'}
            rows.append({'t':offset,**{layer:{'ok':value.get('ok'),'stage':value.get('stage')} for layer,value in results.items()}})
            print(json.dumps(rows[-1]),flush=True)
            remaining=tick-(time.monotonic()-started-offset)
            if remaining>0:time.sleep(remaining)
        summary=summarize_timeline(rows)
        report.setdefault('timelines',{})[name]={'budget_seconds':budget,'rows':rows,'summary':summary}
        record(name+'_transport',summary['first_success']['xray_tls_ip'] is not None,first_success=summary['first_success'])
        record(name+'_dns',summary['first_success']['mihomo_dns'] is not None,first_success=summary['first_success'],states=summary['transitions'])
        return summary
    doh_query = base/'doh-query.bin'; doh_query.write_bytes(dns_query('example.com'))
    created = False
    try:
        checked('ip','netns','add',ns); created = True
        checked('ip','-n',ns,'link','set','lo','up')
        checked('ip','link','add',hostlink,'type','veth','peer','name',peer)
        checked('ip','link','set',peer,'netns',ns)
        checked('nmcli','device','set',hostlink,'managed','no')
        checked('sysctl','-qw',f'net.ipv6.conf.{hostlink}.disable_ipv6=1')
        checked('ip','addr','add',hostip+'/30','dev',hostlink); checked('ip','link','set',hostlink,'up')
        checked('ip','-n',ns,'addr','add',childip+'/30','dev',peer); checked('ip','-n',ns,'link','set',peer,'up')
        checked('ip','-n',ns,'route','add','default','via',hostip)
        checked('ip','netns','exec',ns,'sysctl','-qw','net.ipv6.conf.all.disable_ipv6=1')
        checked('ip','netns','exec',ns,'sysctl','-qw','net.ipv6.conf.default.disable_ipv6=1')
        relayport = 18443
        relay_config=base/'relay.json'
        relay_config.write_text(json.dumps({'bind':hostip,'listen':relayport,'endpoint':endpoint,'port':endpoint_port}))
        relay = spawn(['python3',str(pathlib.Path(__file__).resolve()),'--relay',str(relay_config)],'relay.log')
        for _ in range(50):
            if 'relay_ready' in (base/'relay.log').read_text():break
            time.sleep(.1)
        if 'relay_ready' not in (base/'relay.log').read_text():raise RuntimeError('Relay not ready')
        node['address'], node['port'] = hostip, relayport
        rules = f'''table inet fg_lab {{
 chain output {{ type filter hook output priority 0; policy drop;
 oifname "lo" accept
 ip daddr {hostip} tcp dport {relayport} counter accept
 udp dport 53 counter drop comment "plain_udp_dns"
 tcp dport 53 counter drop comment "plain_tcp_dns"
 tcp dport 853 counter drop comment "direct_dot"
 tcp dport 443 counter drop comment "direct_doh"
 counter drop comment "other_direct"
 }}
}}'''
        result = inside('nft','-f','-',input=rules)
        if result.returncode: raise RuntimeError('Namespace firewall setup failed')
        cap = spawn(['ip','netns','exec',ns,'tcpdump','-i',peer,'-U','-w',str(base/'namespace.pcap')],'capture.log')
        uplink = json.loads(checked('ip','-j','route','get',endpoint))[0]['dev']
        wan = spawn(['tcpdump','-i',uplink,'-U','-w',str(base/'wan.pcap'),'host',endpoint,'and','tcp','port',str(endpoint_port)],'wan-capture.log')
        time.sleep(1)
        if cap.poll() is not None or wan.poll() is not None: raise RuntimeError('Capture did not start')
        # Positive controls: forbidden probes must fail and increment firewall counters.
        for name, cmd in [
            ('direct_udp53_blocked',['dig','@1.1.1.1','example.com','+time=1','+tries=1']),
            ('direct_tcp53_blocked',['dig','+tcp','@8.8.8.8','example.com','+time=1','+tries=1']),
            ('direct_dot_blocked',['curl','--noproxy','*','-s','--max-time','2','telnet://1.1.1.1:853']),
            ('direct_doh_blocked',['curl','--noproxy','*','-s','--max-time','2','https://1.1.1.1/dns-query'])]:
            r = inside(*cmd,timeout=5); record(name,r.returncode != 0)
        # A dead endpoint makes every later scenario meaningless; say so early.
        precheck=probe_endpoint_tcp()
        for _ in range(2):
            if precheck['ok']:break
            time.sleep(1); precheck=probe_endpoint_tcp()
        record('endpoint_tcp_reachable_precheck',precheck['ok'],seconds=precheck['seconds'])
        if not precheck['ok']:raise TransportUnreachable('VPN endpoint TCP unreachable')
        if args.layered:
            before=drop_counters()
            xp,mp=start_modules()
            record('layered_cold_start_dns',worker_ok('dns'))
            no_direct_attempts('layered_cold_start_no_direct_attempts',before)
            layered_timeline('cold_start',args.layered_budget)
            # Replace mihomo only: Xray and its session to the endpoint stay up.
            xp,mp=start_modules(keep_xray=True)
            layered_timeline('mihomo_only_restart',args.layered_budget)
            # Replace Xray only: mihomo and its DNS listener stay up.
            xp,mp=start_modules(keep_mihomo=True)
            layered_timeline('xray_graceful_restart',args.layered_budget)
            kill_hard(xp)
            xp,mp=start_modules(keep_mihomo=True)
            layered_timeline('xray_abrupt_restart',args.layered_budget)
            # Each DoH upstream on its own must still resolve names.
            xp,mp=start_modules('https://cloudflare-dns.com/dns-query#xray',keep_xray=True)
            bounded_check('layered_dns_cloudflare_only',lambda:worker_ok('dns'),attempts=8,budget=20)
            record('layered_https_cloudflare_only',https())
            xp,mp=start_modules('https://dns.google/dns-query#xray',keep_xray=True)
            bounded_check('layered_dns_google_only',lambda:worker_ok('dns'),attempts=8,budget=20)
            record('layered_https_google_only',https())
        elif args.recovery_only:
            def functional(name):
                return bounded_check(name,lambda:worker_ok('dns'),attempts=30,budget=args.recovery_budget)
            before=drop_counters()
            xp,mp=start_modules()
            functional('functional_dns_cold_start')
            record('https_after_functional_cold_start',https())
            no_direct_attempts('cold_start_no_direct_attempts',before)
            xp,mp=start_modules(keep_xray=True)
            functional('functional_dns_mihomo_only_restart')
            record('https_after_mihomo_only_restart',https())
            before=drop_counters();stop(xp)
            record('xray_down_uncached_dns_fails_closed',not worker_ok('dns2'))
            no_direct_attempts('xray_down_no_direct_attempts',before)
            start_modules()
            functional('functional_dns_xray_restart')
            record('https_after_xray_restart',https())
            start_modules('https://192.0.2.1/dns-query#xray',keep_xray=True)
            record('unavailable_doh_fails_closed',not worker_ok('dns'))
            start_modules(keep_xray=True)
            functional('functional_dns_resolver_restore')
            record('https_after_resolver_restore',https())
        else:
            before=drop_counters()
            xp, mp = start_modules()
            bounded_check('cold_start_dns_through_vpn',lambda:worker_ok('dns'))
            bounded_check('cold_start_https_through_vpn',https)
            bounded_check('second_https_target',lambda:https('https://www.cloudflare.com/cdn-cgi/trace','200'))
            no_direct_attempts('cold_start_no_direct_bootstrap_attempts',before)
            bounded_check('udp_stun_via_socks_vpn',lambda:worker_ok('stun'),attempts=2)
            if not args.udp_control_only:
                bounded_check('udp_cloudflare_via_socks_vpn',lambda:worker_ok('udp'),attempts=2)
                bounded_check('udp_google_via_socks_vpn',lambda:worker_ok('udp-google'),attempts=2)
                # A failing resolver must not trigger automatic direct DNS or a successful direct path.
                before=drop_counters()
                start_modules('https://192.0.2.1/dns-query#xray')
                record('unavailable_doh_fails_closed',not worker_ok('dns'))
                record('unavailable_doh_client_resolved_https_fails_closed',not https())
                report['remote_dns_https_can_bypass_local_resolver_failure'] = https(local_dns=False)
                no_direct_attempts('resolver_failure_no_direct_attempts',before)
                xp, mp = start_modules()
                bounded_check('resolver_recovery_after_cold_restart',lambda:worker_ok('dns'))
                before=drop_counters()
                stop(xp)
                record('xray_down_uncached_dns_fails_closed',not worker_ok('dns2'))
                record('xray_down_https_fails_closed',not https('https://1.1.1.1/cdn-cgi/trace','200'))
                no_direct_attempts('xray_failure_no_direct_attempts',before)
                start_modules()
                bounded_check('xray_recovery_https',https)
                poison = spawn(['ip','netns','exec',ns,'python3',str(pathlib.Path(__file__).resolve()),'--worker','poison'],'poison.log')
                for _ in range(50):
                    if 'ready' in (base/'poison.log').read_text():break
                    time.sleep(.1)
                if 'ready' not in (base/'poison.log').read_text():raise RuntimeError('Poison fixture not ready')
                start_modules(poison_bootstrap=True)
                record('poisoned_bootstrap_https_fails_closed',not https('https://1.1.1.1/cdn-cgi/trace','200'))
                record('poison_fixture_was_queried','poison_answer' in (base/'poison.log').read_text())
                stop(poison)
                start_modules()
                bounded_check('ip_bootstrap_recovery_after_spoof',https)
                record('direct_ipv6_unavailable',inside('curl','--noproxy','*','-g','-s','--max-time','2','https://[2606:4700:4700::1111]/cdn-cgi/trace').returncode != 0)
                # Target is an IPv6 literal: no local AAAA lookup and no IPv6 on uplink is needed.
                start_modules(ipv6=True)
                ipv6 = https('https://www.cloudflare.com/cdn-cgi/trace','200',ipv6=True)
                report['ipv6_over_vpn_supported'] = ipv6
                print(json.dumps({'observation':'ipv6_over_vpn_https','supported':ipv6}),flush=True)
        report['module_error_categories'] = {name: {token: token in (base/name).read_text() for token in ['authentication failed','timeout','refused','unreachable']} for name in ['xray.log','mihomo.log','relay.log']}
        report['firewall'] = json.loads(inside('nft','-j','list','table','inet','fg_lab').stdout)
        counter_values = {}
        for entry in report['firewall']['nftables']:
            rule = entry.get('rule', {})
            if rule.get('comment'):
                counter_values[rule['comment']] = sum(expr.get('counter',{}).get('packets',0) for expr in rule['expr'])
        report['blocked_packet_counters'] = counter_values
        record('blocked_probes_hit_firewall',all(counter_values.get(key,0)>0 for key in ['plain_udp_dns','plain_tcp_dns','direct_dot','direct_doh']))
        for p in reversed(module_processes): stop(p)
        stop(cap); stop(wan)
        source_mac = json.loads(checked('ip','-j','-n',ns,'link','show',peer))[0]['address']
        summary = capture_summary(base/'namespace.pcap',hostip,relayport,source_mac)
        report['captures']['namespace'] = summary
        record('capture_contains_real_tunnel_payload',summary['tcp_payload_packets']>0)
        record('capture_no_plain_dns_or_dot',summary['dns53']==0 and summary['dot853']==0)
        record('capture_only_relay_ipv4_no_ipv6',summary['unexpected_outbound']==0 and summary['outbound_ipv6']==0)
        external = capture_summary(base/'wan.pcap',endpoint,endpoint_port)
        report['captures']['wan_endpoint_only'] = external
        record('wan_real_endpoint_tcp_payload',external['tcp_payload_packets']>0)
        report['matrix_completed']=True
    except (Exception,KeyboardInterrupt) as error:
        # Never serialize command output/exception values which could contain credentials.
        report['infrastructure_error_type'] = type(error).__name__
        print(json.dumps({'infrastructure_error_type':type(error).__name__}),flush=True)
    finally:
        for p in reversed(processes): stop(p)
        if created: command('ip','netns','del',ns)
        command('ip','link','del',hostlink)
        temporary.cleanup()
        report['host_default_route_unchanged'] = checked('ip','-4','route','show','default') == original_routes
        report['host_firewall_unchanged'] = checked('nft','list','ruleset') == original_firewall
        report['namespace_removed'] = not any(row.split()[0] == ns for row in checked('ip','netns','list').splitlines())
        report['passed'] = report['matrix_completed'] and bool(report['tests']) and all(row['passed'] for row in report['tests']) and not report.get('infrastructure_error_type') and report['host_default_route_unchanged'] and report['host_firewall_unchanged'] and report['namespace_removed']
        args.report.write_text(json.dumps(report,indent=2)+'\n'); args.report.chmod(0o600)
        print(json.dumps({k:report[k] for k in ['passed','host_default_route_unchanged','host_firewall_unchanged','namespace_removed']}),flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    if len(sys.argv)==3 and sys.argv[1]=='--relay':relay_server(sys.argv[2])
    elif len(sys.argv)>=3 and sys.argv[1]=='--worker':worker(sys.argv[2],sys.argv[3] if len(sys.argv)>3 else None)
    else:sys.exit(main())
