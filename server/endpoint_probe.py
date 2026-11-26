"""Bound TCP checks of configured gateway addresses; no protocol authentication."""
import errno
import ipaddress
import json
import re
import socket
import subprocess
import sys
import time
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location('tcp_capture', Path(__file__).with_name('tcp-capture.py'))
_capture = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_capture)

MARK = 0x40000000


def attempt(interface, address, port, deadline, capture=False):
    family = socket.AF_INET6 if ipaddress.ip_address(address).version == 6 else socket.AF_INET
    result = {'address': address, 'family': 6 if family == socket.AF_INET6 else 4,
              'port': port, 'interface': interface, 'mark': MARK, 'routeVerified': False}
    start = time.monotonic()
    stage = 'route'
    reader = None
    if capture:
        result['tcpCapture'] = {'state': 'unavailable', 'reason': 'capture-not-started',
                                'scope': 'direct-endpoint-control', 'probeCorrelated': False,
                                'routeVerified': False, 'limits': dict(_capture.LIMITS), 'packets': []}
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return {**result, 'state': 'skipped', 'reason': 'budget-exhausted'}
        routes = json.loads(subprocess.run(['ip', '-6' if family == socket.AF_INET6 else '-4',
                                            '-j', 'route', 'get', address, 'mark', hex(MARK),
                                            'oif', interface], check=True, capture_output=True,
                                           text=True, timeout=min(2, remaining)).stdout)
        route = routes[0] if routes else {}
        if route.get('dev') != interface or route.get('type', 'unicast') != 'unicast':
            raise OSError('Route does not use the requested uplink')
        result['route'] = {key: route[key] for key in ('dev', 'gateway', 'prefsrc', 'table') if key in route}
        stage = 'socket-setup'
        with socket.socket(family, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, MARK)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, interface.encode() + b'\0')
            if capture:
                try:
                    source = str(ipaddress.ip_address(route['prefsrc']))
                    sock.bind((source, 0))
                    local, local_port = sock.getsockname()[:2]
                    reader = _capture.TcpCapture(interface, local, local_port, address, port)
                except (OSError, AttributeError, KeyError, ValueError):
                    result['tcpCapture']['reason'] = 'capture-unavailable'
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return {**result, 'state': 'skipped', 'reason': 'budget-exhausted'}
            sock.settimeout(min(2, remaining))
            target = (address, port, 0, socket.if_nametoindex(interface)) if family == socket.AF_INET6 and ipaddress.ip_address(address).is_link_local else (address, port)
            stage = 'tcp'
            sock.connect(target)
            bound = sock.getsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, 32).rstrip(b'\0').decode()
            if bound != interface or sock.getsockopt(socket.SOL_SOCKET, socket.SO_MARK) != MARK:
                raise PermissionError('Socket binding mismatch')
            result.update({'routeVerified': True, 'localAddress': sock.getsockname()[0],
                           'peerAddress': sock.getpeername()[0], 'state': 'ok'})
            if reader:
                sock.shutdown(socket.SHUT_WR)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        result.update({'state': 'unavailable' if isinstance(error, PermissionError) else 'failed',
                       'errorCode': getattr(error, 'errno', None),
                       'reason': 'permission-denied' if isinstance(error, PermissionError) else 'route-unavailable' if stage == 'route'
                       else 'timeout' if isinstance(error, TimeoutError)
                       else 'refused' if getattr(error, 'errno', None) == errno.ECONNREFUSED else 'connect-error'})
    finally:
        if reader:
            # Let the peer's closing packets arrive; never wait for a full session.
            time.sleep(.15)
            result['tcpCapture'] = reader.finish()
            result['tcpCapture']['routeVerified'] = result['routeVerified'] and result['tcpCapture']['probeCorrelated']
    result['durationMs'] = round((time.monotonic() - start) * 1000)
    return result


def probe(interface, addresses, port, capture=False):
    if not isinstance(interface, str) or not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,15}', interface):
        raise ValueError('Invalid interface')
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise ValueError('Invalid port')
    if not isinstance(capture, bool):
        raise ValueError('Invalid TCP capture option')
    if not isinstance(addresses, list) or not 1 <= len(addresses) <= 8 or any(not isinstance(value, str) or '%' in value for value in addresses):
        raise ValueError('Invalid address list')
    addresses = list(dict.fromkeys(str(ipaddress.ip_address(value)) for value in addresses))
    deadline = time.monotonic() + 35
    rows = [{'address': address, 'family': ipaddress.ip_address(address).version,
             'attempts': [attempt(interface, address, port, deadline, **({'capture': True} if capture and index == 0 else {}))]} for index, address in enumerate(addresses)]
    available = sum(row['attempts'][0]['state'] == 'ok' for row in rows)
    if available < len(rows):
        for row in rows:
            row['attempts'].append(attempt(interface, row['address'], port, deadline))
    for row in rows:
        states = {value['state'] for value in row['attempts']}
        row['state'] = 'unstable' if len(states) > 1 and 'ok' in states else 'ok' if states == {'ok'} else 'failed' if states == {'failed'} else 'unavailable'
    states = {row['state'] for row in rows}
    return {'limits':{'maxAddresses':8,'budgetSeconds':35,'connectSeconds':2,'maxAttemptsPerAddress':2,**({'tcpCapture':dict(_capture.LIMITS)} if capture else {})},'mode': 'direct-uplink', 'state': 'ok' if states == {'ok'} else 'failed' if states == {'failed'} else 'partial' if states.intersection({'ok', 'unstable'}) else 'unavailable',
            'complete': all(value['state'] != 'skipped' for row in rows for value in row['attempts']),
            'results': rows, 'diagnosis': {'cause': None, 'confidence': 'undetermined'}}


if __name__ == '__main__':
    try:
        request = json.loads(sys.argv[2])
        print(json.dumps({'ok': True, **probe(sys.argv[1], request['addresses'], request['port'], request.get('capture', False))}))
    except (OSError, ValueError, KeyError, IndexError):
        print(json.dumps({'ok': False, 'state': 'unavailable', 'error': 'Invalid endpoint probe configuration.'}))
