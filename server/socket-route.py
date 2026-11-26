"""Read-only TCP socket/route evidence for one managed process and peer."""
import ipaddress
import json
import pathlib
import pwd
import re
import subprocess
import sys


def endpoint(value):
    address, sep, port = value.rpartition(':')
    if not sep:
        raise ValueError('Invalid endpoint')
    address = address.strip('[]').split('%')[0]
    return str(ipaddress.ip_address(address)), int(port)


def parse_sockets(output, pid, address, port, uid=None, inodes=None):
    result = []
    for line in output.splitlines():
        fields = line.split()
        if len(fields) < 5 or fields[0] not in ('ESTAB', 'SYN-SENT'):
            continue
        owner = re.search(r'\buid:(\d+)\b', line)
        if uid is not None and (int(owner.group(1)) if owner else 0) != uid:
            continue
        inode = re.search(r'\bino:(\d+)\b', line)
        matched_pid = re.search(r'\bpid=' + str(pid) + r'(?:,|\))', line)
        if not matched_pid and not (inode and inodes and inode.group(1) in inodes):
            continue
        try:
            local, local_port = endpoint(fields[3])
            peer, peer_port = endpoint(fields[4])
            if ipaddress.ip_address(peer) != ipaddress.ip_address(address) or peer_port != port:
                continue
            mark = re.search(r'\bfwmark:(0x[\da-fA-F]+|\d+)\b', line)
            result.append({'state': fields[0], 'localAddress': local, 'localPort': local_port,
                           'peerAddress': peer, 'peerPort': peer_port,
                           'mark': int(mark.group(1), 0) if mark else 0})
        except (ValueError, IndexError):
            continue
        if len(result) >= 4:
            break
    return result


def managed_process(pid, username):
    if not isinstance(pid, int) or pid < 2:
        raise ValueError('Invalid process')
    path = pathlib.Path('/proc') / str(pid)
    if path.stat().st_uid != pwd.getpwnam(username).pw_uid:
        raise ValueError('Process is not owned by the service')
    name = (path / 'comm').read_text().strip()
    command = (path / 'cmdline').read_bytes().split(b'\0')[0].decode()
    if name not in ('mihomo', 'xray', 'outline-bridge') or pathlib.Path(command).name != name:
        raise ValueError('Not a managed network engine')
    # Process start time detects PID reuse during the snapshot.
    return ((path / 'stat').read_text().rsplit(')', 1)[1].split()[19], path.stat().st_uid)


def snapshot(pid, address, port, username, process_started_at=None, inodes=None):
    address = str(ipaddress.ip_address(address))
    if not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError('Invalid port')
    if inodes is not None and (not isinstance(inodes, list) or len(inodes) > 1024 or
                               any(not isinstance(value, str) or not re.fullmatch(r'\d{1,20}', value) for value in inodes)):
        raise ValueError('Invalid inode list')
    identity = managed_process(pid, username)
    if process_started_at is not None and process_started_at != identity[0]:
        raise ValueError('Process identity mismatch')
    output = subprocess.run(['ss', '-Hntpe', f'( dst {address} and dport = :{port} )'],
                            check=True, capture_output=True, text=True, timeout=2).stdout
    if len(output) > 262144:
        raise ValueError('Socket snapshot too large')
    sockets = parse_sockets(output, pid, address, port, identity[1], set(inodes or []))
    for sock in sockets:
        try:
            args = ['ip', '-j', 'route', 'get', sock['peerAddress'], 'from', sock['localAddress'],
                    'mark', str(sock['mark']), 'ipproto', 'tcp',
                    'sport', str(sock['localPort']), 'dport', str(sock['peerPort']), 'uid', str(identity[1])]
            routes = json.loads(subprocess.run(args, check=True, capture_output=True,
                                               text=True, timeout=1).stdout)
            route = routes[0] if routes else {}
            sock['route'] = {key: route[key] for key in ('dev', 'gateway', 'prefsrc', 'table') if key in route}
        except (OSError, ValueError, subprocess.SubprocessError):
            sock['route'] = None
    if managed_process(pid, username) != identity:
        raise ValueError('Process changed during snapshot')
    return {'ok': True, 'state': 'observed' if sockets else 'unavailable',
            'evidence': 'managed-process-peer-socket-and-route-lookup',
            'probeCorrelated': False, 'sockets': sockets}


if __name__ == '__main__':
    try:
        identity = json.loads(sys.argv[5]) if len(sys.argv) > 5 else {}
        print(json.dumps(snapshot(int(sys.argv[1]), sys.argv[2], int(sys.argv[3]), sys.argv[4],
                                  identity.get('processStartedAt'), identity.get('inodes'))))
    except (OSError, ValueError, KeyError, IndexError, subprocess.SubprocessError):
        print(json.dumps({'ok': False, 'state': 'unavailable', 'reason': 'socket-evidence-unavailable'}))
