"""Bound direct-path controls. No caller-supplied destinations or firewall changes."""
import ipaddress
import json
import re
import socket
import ssl
import subprocess
import sys
import time

MARK = 0x40000000
TARGETS = [('1.1.1.1', 'cloudflare-dns.com'), ('8.8.8.8', 'dns.google')]


def route_to(address, interface):
    result = subprocess.run(['ip', '-j', 'route', 'get', address, 'mark', hex(MARK),
                             'oif', interface], check=True, capture_output=True,
                            timeout=2, text=True)
    routes = json.loads(result.stdout)
    route = routes[0] if routes else {}
    if route.get('dev') != interface or route.get('type', 'unicast') != 'unicast':
        raise OSError('Route does not use the requested uplink')
    return {key: route[key] for key in ('dev', 'gateway', 'prefsrc', 'table') if key in route}


def probe(interface, address, name):
    if not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,15}', interface):
        raise ValueError('Invalid interface')
    if (address, name) not in TARGETS:
        raise ValueError('Invalid control target')
    started = time.monotonic()
    result = {'address': address, 'port': 443, 'servername': name, 'mark': MARK,
              'interface': interface, 'routeVerified': False, 'stages': []}
    stage = 'route'
    try:
        result['route'] = route_to(address, interface)
        result['stages'].append({'id': 'route', 'state': 'ok'})
        stage = 'tcp'
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, MARK)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, interface.encode() + b'\0')
            sock.settimeout(3)
            sock.connect((address, 443))
            bound = sock.getsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, 32).rstrip(b'\0').decode()
            actual_mark = sock.getsockopt(socket.SOL_SOCKET, socket.SO_MARK)
            if bound != interface or actual_mark != MARK:
                raise OSError('Socket binding mismatch')
            result['localAddress'] = str(ipaddress.ip_address(sock.getsockname()[0]))
            result['peerAddress'] = str(ipaddress.ip_address(sock.getpeername()[0]))
            result['routeVerified'] = True
            result['evidence'] = 'kernel-route-and-connected-bound-socket'
            result['stages'].append({'id': 'tcp', 'state': 'ok',
                                     'durationMs': round((time.monotonic() - started) * 1000)})
            stage = 'tls'
            context = ssl.create_default_context()
            with context.wrap_socket(sock, server_hostname=name) as secure:
                result['tlsVersion'] = secure.version()
                result['stages'].append({'id': 'tls', 'state': 'ok'})
        result['outcome'] = 'ok'
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        result['outcome'] = 'failed'
        result['observation'] = ('timeout' if isinstance(error, (TimeoutError, subprocess.TimeoutExpired))
                                 else 'certificate-error' if isinstance(error, ssl.SSLCertVerificationError)
                                 else 'tls-error' if isinstance(error, ssl.SSLError)
                                 else 'route-unavailable' if stage == 'route' else 'connect-error')
        result['stages'].append({'id': stage, 'state': 'failed'})
    result['durationMs'] = round((time.monotonic() - started) * 1000)
    return result


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'mode': 'direct', 'limits':{'attempts':len(TARGETS),'routeSeconds':2,'connectSeconds':3,'tlsSeconds':3}, 'attempts':
                          [probe(sys.argv[1], address, name) for address, name in TARGETS]}))
    except (IndexError, ValueError):
        print(json.dumps({'ok': False, 'error': 'Invalid uplink configuration'}))
