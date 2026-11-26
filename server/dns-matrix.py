"""Bounded direct-uplink DNS matrix; no resolver/firewall configuration changes."""
import base64
import concurrent.futures
import http.client
import ipaddress
import json
import re
import secrets
import socket
import ssl
import struct
import subprocess
import sys
import time

MARK = 0x40000000
TRANSPORTS = ('udp', 'tcp', 'dot', 'doh')
MAX_MESSAGE = 4096


def domain_name(value):
    if not isinstance(value, str) or len(value) > 253:
        raise ValueError('Invalid DNS name.')
    value = value.rstrip('.').lower()
    if not value or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
                        for label in value.split('.')) or len(value.split('.')) < 2:
        raise ValueError('Invalid DNS name.')
    return value


def query(name, qtype, identifier):
    return struct.pack('!6H', identifier, 0x100, 1, 0, 0, 0) + b''.join(
        bytes([len(label)]) + label.encode('ascii') for label in name.split('.')) + b'\0' + struct.pack('!HH', qtype, 1)


def read_name(data, offset):
    labels, seen, end = [], set(), None
    while True:
        if offset >= len(data) or offset in seen:
            raise ValueError('Invalid DNS name encoding.')
        seen.add(offset)
        length = data[offset]
        if length & 0xc0 == 0xc0:
            if offset + 1 >= len(data):
                raise ValueError('Truncated DNS pointer.')
            if end is None:
                end = offset + 2
            offset = ((length & 63) << 8) | data[offset + 1]
            continue
        if length & 0xc0 or offset + 1 + length > len(data):
            raise ValueError('Invalid DNS label.')
        offset += 1
        if not length:
            break
        labels.append(data[offset:offset + length].decode('ascii').lower())
        if sum(len(label) + 1 for label in labels) > 254:
            raise ValueError('DNS name is too long.')
        offset += length
    return '.'.join(labels), end if end is not None else offset


def parse_response(data, name, qtype, identifier):
    if len(data) < 12 or len(data) > MAX_MESSAGE:
        raise ValueError('Invalid DNS response length.')
    ident, flags, questions, answers, authority, additional = struct.unpack('!6H', data[:12])
    if ident != identifier or not flags & 0x8000 or flags & 0x7800 or questions != 1:
        raise ValueError('Unexpected DNS response.')
    question, offset = read_name(data, 12)
    if offset + 4 > len(data) or question != name or struct.unpack('!HH', data[offset:offset+4]) != (qtype, 1):
        raise ValueError('Unexpected DNS question.')
    offset += 4
    if flags & 0x200:
        return {'rcode':flags & 15,'truncated':True,'answers':[]}
    records = []
    if answers + authority + additional > 256:
        raise ValueError('Too many DNS records.')
    for index in range(answers + authority + additional):
        owner, offset = read_name(data, offset)
        if offset + 10 > len(data):
            raise ValueError('Truncated DNS record.')
        kind, klass, ttl, length = struct.unpack('!HHIH', data[offset:offset+10])
        offset += 10
        if offset + length > len(data):
            raise ValueError('Truncated DNS data.')
        value = None
        if klass == 1 and kind in (1, 28):
            if length != (4 if kind == 1 else 16):
                raise ValueError('Invalid address record.')
            value = str(ipaddress.ip_address(data[offset:offset+length]))
        elif klass == 1 and kind == 5:
            value, record_end = read_name(data, offset)
            if record_end != offset + length:
                raise ValueError('Invalid CNAME record.')
        if index < answers and value is not None:
            records.append({'name': owner, 'type': {1:'A',28:'AAAA',5:'CNAME'}[kind], 'ttl': ttl, 'value': value})
        offset += length
    if offset != len(data):
        raise ValueError('Trailing DNS data.')
    return {'rcode': flags & 15, 'truncated': bool(flags & 0x200), 'answers': records}


def route_to(address, interface):
    result = subprocess.run(['ip', '-6' if ipaddress.ip_address(address).version == 6 else '-4', '-j', 'route', 'get', address, 'mark', hex(MARK), 'oif', interface],
                            check=True, capture_output=True, timeout=1, text=True)
    rows = json.loads(result.stdout)
    route = rows[0] if rows else {}
    if route.get('dev') != interface or route.get('type', 'unicast') != 'unicast':
        raise OSError('Unexpected uplink route.')
    return {key:route[key] for key in ('dev','gateway','prefsrc','table') if key in route}


def exact(sock, length):
    data = b''
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            raise OSError('Incomplete DNS stream.')
        data += chunk
    return data


def proxy_socket(proxy, address, port, deadline):
    # Only this loopback listener is reachable; never retry the destination directly.
    if not isinstance(proxy.get('port'),int) or not 1 <= proxy['port'] <= 65535 or not isinstance(proxy.get('localPort'),int) or not 1024 <= proxy['localPort'] <= 65535:
        raise ValueError('Invalid gateway listener.')
    sock = socket.socket(socket.AF_INET,socket.SOCK_STREAM)
    try:
        sock.settimeout(min(3,max(0.01,deadline-time.monotonic())))
        sock.bind(('127.0.0.1',proxy['localPort']))
        sock.connect(('127.0.0.1',proxy['port']))
        token = base64.b64encode(('fg-geo:'+proxy['secret']).encode()).decode()
        authority = f'[{address}]:{port}' if ':' in address else f'{address}:{port}'
        sock.sendall(f'CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Authorization: Basic {token}\r\n\r\n'.encode())
        header = b''
        while not header.endswith(b'\r\n\r\n'):
            if len(header) >= 8192:
                raise ValueError('Invalid CONNECT response.')
            header += exact(sock,1)
        if not re.fullmatch(rb'HTTP/1\.[01] 200(?: [^\r\n]*)?',header.split(b'\r\n',1)[0]):
            raise GatewayIpv6Unavailable('The gateway rejected IPv6 CONNECT.') if ':' in address else OSError('The gateway rejected CONNECT.')
        return sock
    except BaseException:
        sock.close()
        raise


class GatewayIpv6Unavailable(OSError):
    pass


class GatewayUdpUnavailable(OSError):
    pass


class ProxyUdpSocket:
    """SOCKS5 UDP ASSOCIATE, matching udp-telemetry.js loopback-only policy."""
    def __init__(self, proxy, address, port, deadline):
        self.control = None
        self.udp = None
        try:
            self.udp = socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
            self.udp.bind(('127.0.0.1',proxy['localPort']))
            self.udp.settimeout(min(3,max(0.01,deadline-time.monotonic())))
            self.control = socket.socket(socket.AF_INET,socket.SOCK_STREAM)
            self.control.settimeout(min(3,max(0.01,deadline-time.monotonic())))
            self.control.connect(('127.0.0.1',proxy['port']))
            self.control.sendall(bytes([5,1,2]))
            if exact(self.control,2) != bytes([5,2]):
                raise GatewayUdpUnavailable('SOCKS authentication is unavailable.')
            username,password = b'fg-geo',proxy['secret'].encode()
            if not 1 <= len(password) <= 255:
                raise ValueError('Invalid SOCKS credentials.')
            self.control.sendall(bytes([1,len(username)])+username+bytes([len(password)])+password)
            if exact(self.control,2) != bytes([1,0]):
                raise GatewayUdpUnavailable('SOCKS authentication failed.')
            self.control.sendall(bytes.fromhex('05030001000000000000'))
            if exact(self.control,4) != bytes([5,0,0,1]):
                raise GatewayUdpUnavailable('SOCKS UDP is unavailable.')
            relay = exact(self.control,6)
            host,relay_port = socket.inet_ntoa(relay[:4]),struct.unpack('!H',relay[4:])[0]
            if host not in ('127.0.0.1','0.0.0.0') or not relay_port:
                raise GatewayUdpUnavailable('Non-loopback UDP relay.')
            self.udp.connect(('127.0.0.1',relay_port))
            self.header = bytes([0,0,0,4])+socket.inet_pton(socket.AF_INET6,address)+struct.pack('!H',port) if ':' in address else bytes([0,0,0,1])+socket.inet_aton(address)+struct.pack('!H',port)
        except BaseException:
            self.close()
            raise

    def send(self,payload):
        return self.udp.send(self.header+payload)

    def recv(self,length):
        size = len(self.header)
        packet = self.udp.recv(length+size)
        if len(packet)<size or packet[:size] != self.header:
            raise ValueError('Unexpected SOCKS UDP source or fragment.')
        return packet[size:]

    def getsockname(self):
        return self.udp.getsockname()

    def close(self):
        if self.udp is not None:
            self.udp.close()
        if self.control is not None:
            self.control.close()


def attempt(interface, provider, transport, name, qtype, repeat, deadline, proxy=None):
    provider_id = provider['id']
    endpoint = provider['endpoints'][transport]
    address, hostname, port = endpoint['address'], endpoint['servername'], endpoint['port']
    started = time.monotonic()
    row = {'provider':provider_id,'address':address,'transport':transport,'qtype':'A' if qtype == 1 else 'AAAA',
           'repeat':repeat,'family':provider.get('family',4),'port':port,'interface':interface,'mark':MARK,'routeVerified':False,'state':'unavailable'}
    sock = None
    stage = 'route'
    try:
        if not address:
            row['reason'] = 'resolver-ipv6-unavailable'
            return row
        if deadline - started < 1:
            row['reason'] = 'budget-exhausted'
            return row
        if proxy is not None:
            row['mode'] = 'gateway'
            row['mark'] = None
            row['interface'] = None
            stage = 'proxy-connect'
            sock = ProxyUdpSocket(proxy,address,port,deadline) if transport == 'udp' else proxy_socket(proxy,address,port,deadline)
            row.update(localAddress=sock.getsockname()[0],localPort=sock.getsockname()[1])
        else:
            row['route'] = route_to(address, interface)
            stage = 'binding'
            sock = socket.socket(socket.AF_INET6 if ipaddress.ip_address(address).version == 6 else socket.AF_INET, socket.SOCK_DGRAM if transport == 'udp' else socket.SOCK_STREAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, MARK)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, interface.encode() + b'\0')
            sock.settimeout(min(3, deadline - time.monotonic()))
            stage = 'connect'
            sock.connect((address, port))
            if sock.getsockopt(socket.SOL_SOCKET, socket.SO_MARK) != MARK or sock.getsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, 32).rstrip(b'\0').decode() != interface:
                raise PermissionError('Socket binding mismatch.')
            row.update(routeVerified=True, localAddress=sock.getsockname()[0], peerAddress=sock.getpeername()[0],
                       evidence='kernel-route-and-connected-bound-socket')
        if transport in ('dot','doh'):
            stage = 'tls'
            context = ssl.create_default_context()
            if transport == 'doh':
                context.set_alpn_protocols(['http/1.1'])
            sock = context.wrap_socket(sock, server_hostname=hostname)
            row['tlsVersion'] = sock.version()
        stage = 'dns'
        identifier = secrets.randbelow(65536)
        payload = query(name, qtype, identifier)
        if transport == 'doh':
            # Fixed numeric peer, original Host/SNI, no bootstrap DNS or redirect.
            request = (f'POST {endpoint["path"]} HTTP/1.1\r\nHost: {hostname}\r\nContent-Type: application/dns-message\r\nAccept: application/dns-message\r\nContent-Length: {len(payload)}\r\nConnection: close\r\n\r\n').encode() + payload
            sock.sendall(request)
            response = http.client.HTTPResponse(sock)
            response.begin()
            row['httpStatus'] = response.status
            if response.status != 200 or response.getheader('Content-Type','').split(';')[0].strip().lower() != 'application/dns-message':
                raise ValueError('Invalid DoH response.')
            data = response.read(MAX_MESSAGE+1)
        elif transport == 'udp':
            sock.send(payload)
            data = sock.recv(MAX_MESSAGE+1)
        else:
            sock.sendall(struct.pack('!H',len(payload))+payload)
            length = struct.unpack('!H',exact(sock,2))[0]
            if length > MAX_MESSAGE:
                raise ValueError('DNS response is too large.')
            data = exact(sock,length)
        row['rawBase64'] = base64.b64encode(data[:MAX_MESSAGE]).decode()
        row.update(parse_response(data, name, qtype, identifier))
        row['state'] = 'ok'
    except (OSError, ValueError, UnicodeError, struct.error, subprocess.SubprocessError, http.client.HTTPException) as error:
        row['failedStage'] = stage
        row['state'] = 'unavailable' if stage in ('route','binding') or isinstance(error,(PermissionError,GatewayUdpUnavailable,GatewayIpv6Unavailable)) else 'failed'
        row['reason'] = ('gateway-ipv6-unavailable' if isinstance(error,GatewayIpv6Unavailable) else 'gateway-udp-unavailable' if isinstance(error,GatewayUdpUnavailable) else 'permission-denied' if isinstance(error,PermissionError) else
                         'timeout' if isinstance(error,(TimeoutError,subprocess.TimeoutExpired)) else
                         'certificate-error' if isinstance(error,ssl.SSLCertVerificationError) else
                         'route-unavailable' if stage == 'route' else
                         'invalid-response' if isinstance(error,(ValueError,UnicodeError,struct.error,http.client.HTTPException)) else
                         'transport-error')
    finally:
        row['durationMs'] = round((time.monotonic()-started)*1000)
        if sock is not None:
            # Retain completed gateway flows briefly for controller correlation;
            # this observation grace is excluded from the DNS timing above.
            if proxy is not None and row['state']=='ok':
                time.sleep(0.15)
            sock.close()
    return row


def comparisons(rows, providers):
    result = []
    for entry in providers:
        provider = entry['id']
        for qtype in ('A','AAAA'):
            group = [row for row in rows if row['provider'] == provider and row['qtype'] == qtype]
            valid = [row for row in group if row['state'] == 'ok' and row['routeVerified'] and not row.get('truncated')]
            signatures = {(row['rcode'],tuple(sorted((record['name'],record['type'],record['value']) for record in row['answers']))) for row in valid}
            result.append({'provider':provider,'qtype':qtype,'state':'incomplete' if len(valid) != 8 else 'different' if len(signatures)>1 else 'matched',
                           'responsesDiffer':len(signatures)>1,'validResponses':len(valid),'expectedResponses':8,'cause':None})
    return result


def matrix(interface, name, providers):
    if not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,15}',interface):
        raise ValueError('Invalid uplink interface.')
    name = domain_name(name)
    deadline = time.monotonic()+35
    jobs = [(interface,provider,transport,name,qtype,repeat,deadline)
            for repeat in (1,2) for provider in providers for qtype in (1,28) for transport in TRANSPORTS]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(lambda args:attempt(*args),jobs))
    return {'ok':True,'version':1,'mode':'direct','name':name,'family':providers[0].get('family',4),'state':'ok' if all(row['state']=='ok' and not row.get('truncated') for row in rows) else 'partial',
            'attempts':rows,'providers':[{'id':p['id'],'name':p['name'],'filtering':p['filtering']} for p in providers],'comparisons':comparisons(rows,providers),'diagnosis':{'cause':None,'confidence':'undetermined'},
            'limits':{'attempts':len(jobs),'parallel':4,'budgetSeconds':35,'maxResponseBytes':MAX_MESSAGE}}


def endpoint_resolution(interface,name,providers):
    if not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,15}',interface) or len(providers)!=1:raise ValueError('Invalid endpoint DNS parameters.')
    name=domain_name(name)
    deadline=time.monotonic()+7
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        rows=list(pool.map(lambda qtype:attempt(interface,providers[0],'doh',name,qtype,1,deadline),(1,28)))
    return {'ok':True,'name':name,'mode':'endpoint-doh','attempts':rows,'limits':{'attempts':2,'parallel':2,'budgetSeconds':7,'maxResponseBytes':MAX_MESSAGE}}


if __name__ == '__main__':
    try:
        if len(sys.argv)>1 and sys.argv[1]=='--gateway-attempt':
            request=json.load(sys.stdin)
            print(json.dumps(attempt(None,request['provider'],request['transport'],domain_name(request['name']),request['qtype'],request['repeat'],time.monotonic()+7,proxy=request['proxy'])))
        elif len(sys.argv)>1 and sys.argv[1]=='--endpoint':
            print(json.dumps(endpoint_resolution(sys.argv[2],sys.argv[3],json.loads(sys.argv[4]))))
        else:
            print(json.dumps(matrix(sys.argv[1],sys.argv[2],json.loads(sys.argv[3]))))
    except (IndexError,ValueError):
        print(json.dumps({'ok':False,'state':'unavailable','error':'Invalid DNS matrix parameters.'}))
