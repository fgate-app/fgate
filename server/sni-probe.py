"""Paired SNI experiments. A foreign SNI is never a normal TLS health check."""
import concurrent.futures
import importlib.util
import json
import ipaddress
import os
import socket
import ssl
import sys
import time

spec = importlib.util.spec_from_file_location('dns_matrix',os.path.join(os.path.dirname(__file__),'dns-matrix.py'))
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)


def attempt(interface, target, servername, experimental=False, proxy=None):
    address, port = target['address'], 443
    row = {'provider':target['provider'],'address':address,'port':port,'servername':servername,
           'experimental':experimental,'certificateVerification':not experimental,
           'routeVerified':False,'state':'unavailable','stages':[]}
    started = time.monotonic()
    deadline = started + 7
    sock = None
    stage = 'route'
    try:
        if proxy is not None:
            stage = 'proxy-connect'
            sock = transport.proxy_socket(proxy,address,port,time.monotonic()+8)
            row.update(localAddress=sock.getsockname()[0],localPort=sock.getsockname()[1])
        else:
            row['interface'] = interface
            row['mark'] = transport.MARK
            row['route'] = transport.route_to(address,interface)
            row['stages'].append({'id':'route','state':'ok'})
            stage = 'binding'
            sock = socket.socket(socket.AF_INET,socket.SOCK_STREAM)
            sock.setsockopt(socket.SOL_SOCKET,socket.SO_MARK,transport.MARK)
            sock.setsockopt(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,interface.encode()+b'\0')
            sock.settimeout(3)
            stage = 'tcp'
            sock.connect((address,port))
            if sock.getsockopt(socket.SOL_SOCKET,socket.SO_MARK)!=transport.MARK or sock.getsockopt(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,32).rstrip(b'\0').decode()!=interface:
                raise PermissionError('Socket binding mismatch.')
            row.update(routeVerified=True,localAddress=sock.getsockname()[0],peerAddress=sock.getpeername()[0])
        row['stages'].append({'id':stage,'state':'ok'})
        sock.settimeout(max(0.001,deadline-time.monotonic()))
        stage = 'tls'
        context = ssl.create_default_context()
        if experimental:
            context.check_hostname=False
            context.verify_mode=ssl.CERT_NONE
        context.set_alpn_protocols(['http/1.1'])
        sock = context.wrap_socket(sock,server_hostname=servername)
        row['tlsVersion'] = sock.version()
        row['stages'].append({'id':'tls','state':'ok'})
        stage = 'http'
        sock.sendall(f'HEAD / HTTP/1.1\r\nHost: {servername}\r\nConnection: close\r\n\r\n'.encode('ascii'))
        header=b''
        while not header.endswith(b'\r\n\r\n'):
            if len(header)>=8192:
                raise ValueError('HTTP header is too large.')
            if time.monotonic()>=deadline:raise TimeoutError('SNI probe timed out.')
            sock.settimeout(max(0.001,deadline-time.monotonic()))
            part=sock.recv(1)
            if not part:
                raise EOFError('The peer closed the response.')
            header+=part
        import re
        match=re.match(rb'HTTP/1\.[01] ([1-5][0-9]{2})(?: [^\r\n]*)?\r\n',header)
        if not match:
            raise ValueError('Invalid HTTP response.')
        row['httpStatus']=int(match[1])
        row.update(state='ok',observation='http-rejection' if row['httpStatus']>=400 else 'http-response')
        row['stages'].append({'id':'http','state':'ok','status':row['httpStatus']})
    except (OSError,ValueError,EOFError,transport.subprocess.SubprocessError) as error:
        row.update(state='unavailable' if stage in ('route','binding') or isinstance(error,PermissionError) else 'failed',failedStage=stage)
        row['observation']=('permission-denied' if isinstance(error,PermissionError) else
                            'timeout' if isinstance(error,(TimeoutError,transport.subprocess.TimeoutExpired)) else
                            'connection-reset' if isinstance(error,ConnectionResetError) else
                            'certificate-error' if isinstance(error,ssl.SSLCertVerificationError) else
                            'unexpected-eof' if isinstance(error,(ssl.SSLEOFError,EOFError)) else
                            'tls-alert' if isinstance(error,ssl.SSLError) and 'ALERT' in str(getattr(error,'reason','')) else
                            'tls-error' if isinstance(error,ssl.SSLError) else
                            'invalid-response' if isinstance(error,ValueError) else
                            'route-unavailable' if stage=='route' else 'transport-error')
        row['stages'].append({'id':stage,'state':'failed'})
    finally:
        row['durationMs']=round((time.monotonic()-started)*1000)
        if sock is not None:
            if proxy is not None and row['state']=='ok':time.sleep(0.15)
            sock.close()
    return row


def matrix(interface, targets, name, fake_ranges=None):
    transport.domain_name(name)
    if not transport.re.fullmatch(r'[a-zA-Z0-9_.:-]{1,15}',interface):raise ValueError('Invalid interface.')
    def pair(target):
        rows=[]
        dns=transport.attempt(interface,target['dnsProvider'],'doh',name,1,1,time.monotonic()+7)
        address=None
        if dns.get('state')=='ok' and dns.get('routeVerified') and dns.get('rcode')==0 and not dns.get('truncated'):
            for answer in dns.get('answers',[]):
                try:
                    ip=ipaddress.ip_address(answer.get('value',''))
                    if answer.get('type')=='A' and ip.version==4 and ip.is_global and not ip.is_multicast and not any(ip in ipaddress.ip_network(cidr) for cidr in (fake_ranges or [])):
                        address=str(ip);break
                except ValueError:pass
        resolution={'method':'doh','provider':target['provider'],'address':target['address'],'name':name,'state':'ok' if address else 'unavailable','selectedAddress':address,'rcode':dns.get('rcode'),'pathVerified':bool(dns.get('routeVerified')),'reason':None if address else dns.get('reason','dns-address-unavailable')}
        for kind,servername,experimental in [('baseline-before',target['servername'],False),('foreign-sni',name,True),('baseline-after',target['servername'],False),('target-own-ip',name,False),('control-on-target-ip',target['servername'],True)]:
            own=kind in ('target-own-ip','control-on-target-ip')
            destination={**target,'address':address} if own else target
            if own and not address:
                row={'provider':target['provider'],'address':None,'servername':servername,'experimental':experimental,'certificateVerification':not experimental,'state':'unavailable','routeVerified':False,'observation':'dns-address-unavailable'}
            elif experimental and (not rows or rows[0]['state']!='ok' or not rows[0].get('routeVerified')):
                row={**target,'port':443,'servername':servername,'experimental':True,'certificateVerification':False,'state':'unavailable','routeVerified':False,'observation':'baseline-unavailable'}
            else:
                row=attempt(interface,destination,servername,experimental)
            row.pop('dnsProvider',None)
            if own:row['resolution']=resolution
            row['kind']=kind
            rows.append(row)
        return rows
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        rows=[row for group in pool.map(pair,targets) for row in group]
    return {'ok':True,'mode':'direct','name':name,'limits':{'attempts':len(rows),'dnsQueries':len(targets),'parallel':2,'probeSeconds':7},'attempts':rows,'diagnosis':{'cause':None,'confidence':'undetermined'}}


if __name__=='__main__':
    try:
        if sys.argv[1]=='--gateway':
            request=json.load(sys.stdin)
            print(json.dumps(attempt(None,request['target'],request['servername'],request['experimental'],request['proxy'])))
        else:print(json.dumps(matrix(sys.argv[1],json.loads(sys.argv[2]),sys.argv[3],json.loads(sys.argv[4]) if len(sys.argv)>4 else [])))
    except (ValueError,IndexError):
        print(json.dumps({'ok':False,'state':'unavailable','error':'Invalid SNI diagnostic parameters.'}))
