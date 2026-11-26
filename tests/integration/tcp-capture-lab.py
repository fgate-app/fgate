#!/usr/bin/env python3
"""Opt-in root Linux lab. All links/firewall rules live in temporary namespaces.

Usage: sudo python3 tests/integration/tcp-capture-lab.py /path/to/server
The server directory needs endpoint_probe.py and tcp-capture.py only.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def run(*args, **options):
    return subprocess.run(list(args), check=True, text=True, capture_output=True,
                          timeout=options.pop('timeout', 15), **options).stdout


def main():
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise RuntimeError('This isolated lab requires root on Linux')
    worker = str(Path(sys.argv[1]).resolve() / 'endpoint_probe.py')
    suffix = str(os.getpid())
    client, server = 'fg-cap-c-' + suffix, 'fg-cap-s-' + suffix
    left, right = 'fc' + suffix, 'fs' + suffix
    namespaces, children, checks = [], [], {}
    try:
        for ns in [client, server]:
            run('ip', 'netns', 'add', ns);namespaces.append(ns)
            run('ip', '-n', ns, 'link', 'set', 'lo', 'up')
        run('ip', 'link', 'add', left, 'type', 'veth', 'peer', 'name', right)
        for ns, interface, address in [(client, left, '198.19.200.1/30'), (server, right, '198.19.200.2/30')]:
            run('ip', 'link', 'set', interface, 'netns', ns)
            run('ip', '-n', ns, 'addr', 'add', address, 'dev', interface)
            run('ip', '-n', ns, '-6', 'addr', 'add', 'fd00:fc::1/64' if ns == client else 'fd00:fc::2/64', 'dev', interface, 'nodad')
            run('ip', '-n', ns, 'link', 'set', interface, 'up')
        run('ip', 'netns', 'exec', server, 'nft', 'add', 'table', 'inet', 'cap_lab')
        run('ip', 'netns', 'exec', server, 'nft', 'add', 'chain', 'inet', 'cap_lab', 'input', '{ type filter hook input priority 0; policy accept; }')
        run('ip', 'netns', 'exec', server, 'nft', 'add', 'rule', 'inet', 'cap_lab', 'input', 'tcp', 'dport', '44302', 'drop')
        listener = subprocess.Popen(['ip', 'netns', 'exec', server, 'python3', '-u', '-c',
            "import socket; s=socket.socket(); s.bind(('198.19.200.2',44300)); s.listen(); print('ready',flush=True); c,_=s.accept(); c.recv(1); c.shutdown(socket.SHUT_WR); c.close(); s.close()"], stdout=subprocess.PIPE, text=True)
        children.append(listener)
        assert listener.stdout.readline().strip() == 'ready'
        reports = {}
        for name, port in [('close', 44300), ('reset', 44301), ('syn-only', 44302)]:
            report = json.loads(run('ip', 'netns', 'exec', client, 'python3', worker, left,
                                    json.dumps({'addresses': ['198.19.200.2'], 'port': port, 'capture': True})))
            attempt = report['results'][0]['attempts'][0]
            cap = attempt['tcpCapture']
            assert cap['state'] == 'observed' and cap['probeCorrelated'], report
            assert cap['interface'] == left and cap['tuple']['peerPort'] == port, report
            assert cap['tuple']['localAddress'] == '198.19.200.1' and cap['tuple']['peerAddress'] == '198.19.200.2'
            assert len(cap['packets']) <= 64 and cap['durationMs'] < 10000
            flags = [(p['direction'], p['flags']) for p in cap['packets']]
            assert any(d == 'outbound' and 'SYN' in f for d, f in flags), flags
            if name == 'close':
                assert any(d == 'inbound' and 'SYN' in f and 'ACK' in f for d, f in flags), flags
                assert any(d == 'outbound' and 'FIN' in f for d, f in flags), flags
                assert any(d == 'inbound' and 'FIN' in f for d, f in flags), flags
            elif name == 'reset':
                assert any(d == 'inbound' and 'RST' in f for d, f in flags), flags
            else:
                assert not any(d == 'inbound' for d, f in flags), flags
                assert attempt['reason'] == 'timeout'
            assert all(set(row) == {'direction', 'timeMs', 'ttl', 'sequence', 'ack', 'ipBytes', 'headerBytes', 'flags'} for row in cap['packets'])
            assert cap['limits']['payloadBytes'] == 0
            reports[name] = cap
            checks[name] = 'passed'
        child = subprocess.Popen(['ip', 'netns', 'exec', client, 'python3', worker, left,
                                  json.dumps({'addresses': ['198.19.200.2'], 'port': 44302, 'capture': True})], stdout=subprocess.PIPE)
        children.append(child)
        time.sleep(.3)
        assert child.poll() is None
        assert len(run('ip', 'netns', 'exec', client, 'cat', '/proc/net/packet').splitlines()) > 1
        child.kill();child.wait(timeout=2)
        assert len(run('ip', 'netns', 'exec', client, 'cat', '/proc/net/packet').splitlines()) == 1
        checks['cancel-releases-packet-socket'] = 'passed'
        ipv6 = json.loads(run('ip', 'netns', 'exec', client, 'python3', worker, left,
                             json.dumps({'addresses': ['fd00:fc::2'], 'port': 44301, 'capture': True})))
        cap = ipv6['results'][0]['attempts'][0]['tcpCapture']
        assert cap['state'] == 'observed' and cap['probeCorrelated'], ipv6
        assert any(p['direction'] == 'inbound' and 'RST' in p['flags'] for p in cap['packets']), cap
        checks['ipv6-kernel-filter'] = 'passed'
        reports['ipv6-reset'] = cap
        print(json.dumps({'checks': checks, 'captures': reports, 'hostNetworkChanges': False}))
    finally:
        for child in children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=2)
        for ns in reversed(namespaces):
            subprocess.run(['ip', 'netns', 'del', ns], capture_output=True)
        subprocess.run(['ip', 'link', 'del', left], capture_output=True)


if __name__ == '__main__':
    main()
