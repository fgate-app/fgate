"""Controlled IPv4 TTL study. Root, empty unshare -n only; no public traffic.

Reuses the existing child-netns pattern from dns-ipv6-native.py and the production
traceEndpointRoute implementation. Captures only correlated ICMP header metadata.
"""
import argparse
import json
import os
import pathlib
import select
import socket
import struct
import subprocess
import sys
import threading
import time

TARGET = '198.18.3.2'
PORT = 31081
PAYLOAD = b'FG-TTL-CONTROL\n'
TIMEOUT = .25
REPEATS = 3


def peer(role):
    print('namespace-ready', flush=True)
    if role != 'target':
        sys.stdin.read()
        return
    assert sys.stdin.readline().strip() == 'configured'
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((TARGET, PORT))
    listener.listen(128)

    def handle(conn):
        with conn:
            conn.settimeout(1)
            try:
                data = b''
                while len(data) < len(PAYLOAD):
                    part = conn.recv(len(PAYLOAD) - len(data))
                    if not part:
                        return
                    data += part
                if data == PAYLOAD:
                    conn.sendall(b'OK:' + data)
            except OSError:
                pass

    def serve():
        while True:
            try:
                conn, _ = listener.accept()
            except OSError:
                return
            threading.Thread(target=handle, args=(conn,), daemon=True).start()

    threading.Thread(target=serve, daemon=True).start()
    print('server-ready', flush=True)
    sys.stdin.read()
    listener.close()


def run(*args, input=None):
    result = subprocess.run(args, input=input, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=15)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed: {result.stderr.strip()}')
    return result.stdout


def in_peer(child, *args, input=None):
    return run('nsenter', '-t', str(child.pid), '-n', *args, input=input)


def icmp_metadata(data, source, source_port, started):
    if len(data) < 56 or data[0] >> 4 != 4:
        return None
    ihl = (data[0] & 15) * 4
    if ihl < 20 or len(data) < ihl + 8 + 20 + 4:
        return None
    kind, code = data[ihl:ihl + 2]
    if kind not in (3, 11):
        return None
    inner = data[ihl + 8:]
    inner_ihl = (inner[0] & 15) * 4
    if inner[0] >> 4 != 4 or inner_ihl < 20 or len(inner) < inner_ihl + 4 or inner[9] != 6:
        return None
    if socket.inet_ntoa(inner[12:16]) != source or socket.inet_ntoa(inner[16:20]) != TARGET:
        return None
    sport, dport = struct.unpack('!HH', inner[inner_ihl:inner_ihl + 4])
    if sport != source_port or dport != PORT:
        return None
    return {'type': kind, 'code': code, 'from': socket.inet_ntoa(data[12:16]),
            'collectedAfterMs': round((time.monotonic() - started) * 1000, 2),
            'tupleMatched': True}


def attempt(ttl):
    with socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP) as capture, socket.socket() as conn:
        capture.setblocking(False)
        conn.settimeout(TIMEOUT)
        conn.setsockopt(socket.IPPROTO_IP, socket.IP_TTL, ttl)
        conn.bind(('198.18.1.2', 0))
        source, source_port = conn.getsockname()
        started = time.monotonic()
        result = {'ttl': ttl, 'sourcePort': source_port, 'tcp': 'not-started',
                  'applicationReply': False, 'icmp': []}
        try:
            conn.connect((TARGET, PORT))
            result['tcp'] = 'connected'
            conn.sendall(PAYLOAD)
            answer = b''
            expected = b'OK:' + PAYLOAD
            while len(answer) < len(expected):
                part = conn.recv(len(expected) - len(answer))
                if not part:
                    break
                answer += part
            result['applicationReply'] = answer == expected
        except TimeoutError:
            result['tcp'] = 'timeout' if result['tcp'] != 'connected' else 'data-timeout'
        except OSError as error:
            result['tcp'] = 'socket-error'
            result['errno'] = error.errno
        # ICMP often arrives before connect() returns. Only exact quoted tuples
        # are retained, never the packet or its payload. The bounded local queue
        # is empty at creation and the fixture sends no unrelated traffic.
        deadline = time.monotonic() + .03
        while time.monotonic() < deadline:
            if not select.select([capture], [], [], max(0, deadline - time.monotonic()))[0]:
                break
            packet, _ = capture.recvfrom(4096)
            metadata = icmp_metadata(packet, source, source_port, started)
            if metadata:
                result['icmp'].append(metadata)
        result['elapsedMs'] = round((time.monotonic() - started) * 1000, 2)
        return result


def signature(row):
    if row['applicationReply']:
        return 'application-reply'
    exceeded = [item for item in row['icmp'] if item['type'] == 11 and item['code'] == 0]
    return 'ttl-exceeded:' + exceeded[0]['from'] if exceeded else 'no-confirmed-reply'


def study(report, trace_module):
    links = json.loads(run('ip', '-j', 'link', 'show'))
    assert len(links) == 1 and links[0]['ifname'] == 'lo', 'Run under an empty unshare -n; host networking is prohibited.'
    assert pathlib.Path('/proc/self/ns/net').readlink() != pathlib.Path('/proc/1/ns/net').readlink(), 'A private network namespace is required.'
    children = []
    rows = []
    try:
        for role in ['router1', 'router2', 'target']:
            child = subprocess.Popen(['unshare', '-n', sys.executable, __file__, '--peer', role],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            children.append(child)
            assert child.stdout.readline().strip() == 'namespace-ready'
            assert pathlib.Path(f'/proc/{child.pid}/ns/net').readlink() != pathlib.Path('/proc/self/ns/net').readlink()
            in_peer(child, 'ip', 'link', 'set', 'lo', 'up')
        r1, r2, target = children

        def link(first, second, left, right, a, b):
            command = lambda *args: in_peer(first, *args) if first else run(*args)
            command('ip', 'link', 'add', left, 'type', 'veth', 'peer', 'name', right)
            command('ip', 'link', 'set', right, 'netns', str(second.pid))
            command('ip', 'addr', 'add', a, 'dev', left)
            command('ip', 'link', 'set', left, 'up')
            in_peer(second, 'ip', 'addr', 'add', b, 'dev', right)
            in_peer(second, 'ip', 'link', 'set', right, 'up')

        link(None, r1, 'ttl-c', 'ttl-r1c', '198.18.1.2/30', '198.18.1.1/30')
        link(r1, r2, 'ttl-r1r2', 'ttl-r2r1', '198.18.2.1/30', '198.18.2.2/30')
        link(r2, target, 'ttl-r2s', 'ttl-s', '198.18.3.1/30', '198.18.3.2/30')
        run('ip', 'route', 'add', 'default', 'via', '198.18.1.1')
        in_peer(r1, 'ip', 'route', 'add', '198.18.3.0/30', 'via', '198.18.2.2')
        in_peer(r2, 'ip', 'route', 'add', '198.18.1.0/30', 'via', '198.18.2.1')
        in_peer(target, 'ip', 'route', 'add', 'default', 'via', '198.18.3.1')
        for router in [r1, r2]:
            in_peer(router, 'sysctl', '-qw', 'net.ipv4.ip_forward=1', 'net.ipv4.icmp_ratelimit=0')
        for child, chain in [(r2, 'forward'), (target, 'input')]:
            in_peer(child, 'nft', 'add', 'table', 'inet', 'fg_ttl')
            in_peer(child, 'nft', '-f', '-', input=f'add chain inet fg_ttl {chain} {{ type filter hook {chain} priority 0; policy accept; }}\n')
        in_peer(r2, 'nft', '-f', '-', input='add chain inet fg_ttl output { type filter hook output priority 0; policy accept; }\n')
        target.stdin.write('configured\n'); target.stdin.flush()
        assert target.stdout.readline().strip() == 'server-ready'

        def configure(mode):
            in_peer(r2, 'nft', 'flush', 'chain', 'inet', 'fg_ttl', 'forward')
            in_peer(r2, 'nft', 'flush', 'chain', 'inet', 'fg_ttl', 'output')
            in_peer(target, 'nft', 'flush', 'chain', 'inet', 'fg_ttl', 'input')
            in_peer(target, 'nft', '-f', '-', input=f'add rule inet fg_ttl input tcp dport {PORT} tcp flags & (syn | ack) == syn counter\n')
            if mode == 'silent-router':
                in_peer(r2, 'nft', '-f', '-', input='add rule inet fg_ttl output icmp type time-exceeded counter drop\n')
            elif mode == 'router-drop':
                in_peer(r2, 'nft', '-f', '-', input=f'add rule inet fg_ttl forward ip daddr {TARGET} tcp dport {PORT} counter drop\n')
            elif mode == 'target-drop':
                in_peer(target, 'nft', '-f', '-', input=f'add rule inet fg_ttl input tcp dport {PORT} counter drop\n')

        def counters(child, chain):
            rules = json.loads(in_peer(child, 'nft', '-j', 'list', 'chain', 'inet', 'fg_ttl', chain))
            return [expr['counter']['packets'] for obj in rules['nftables'] for expr in obj.get('rule', {}).get('expr', []) if 'counter' in expr]

        trace_code = "import {traceEndpointRoute} from '" + pathlib.Path(trace_module).resolve().as_uri() + "';console.log(JSON.stringify(await traceEndpointRoute({addresses:['" + TARGET + "'],port:" + str(PORT) + ",interfaceName:'ttl-c'})));"
        for mode in ['baseline', 'silent-router', 'router-drop', 'target-drop', 'intermittent']:
            print('Phase: ' + mode, file=sys.stderr, flush=True)
            configure(mode)
            phase = {'mode': mode, 'attempts': []}
            for repeat in range(REPEATS):
                if mode == 'intermittent':
                    configure('router-drop' if repeat == 1 else 'baseline')
                for ttl in [1, 2, 3, 4]:
                    pair = {'repeat': repeat + 1, 'limited': attempt(ttl), 'control': attempt(64)}
                    pair['limited']['observation'] = signature(pair['limited'])
                    pair['control']['observation'] = signature(pair['control'])
                    phase['attempts'].append(pair)
            phase['targetSynCounters'] = counters(target, 'input')
            phase['counterScope'] = 'last repeat' if mode == 'intermittent' else 'all paired attempts before traceroute'
            if mode != 'intermittent':
                phase['existingTraceroute'] = json.loads(run('node', '--input-type=module', '-e', trace_code))
            rows.append(phase)

        by_mode = {row['mode']: row for row in rows}
        for mode in ['baseline', 'silent-router']:
            for pair in by_mode[mode]['attempts']:
                assert pair['control']['applicationReply']
                assert pair['limited']['applicationReply'] == (pair['limited']['ttl'] >= 3)
        baseline_ttl2 = [p['limited'] for p in by_mode['baseline']['attempts'] if p['limited']['ttl'] == 2]
        silent_ttl2 = [p['limited'] for p in by_mode['silent-router']['attempts'] if p['limited']['ttl'] == 2]
        assert all(row['icmp'] for row in baseline_ttl2)
        assert all(not row['icmp'] for row in silent_ttl2)
        signatures = lambda mode: [(p['limited']['ttl'], p['limited']['observation'], p['control']['observation']) for p in by_mode[mode]['attempts']]
        assert signatures('router-drop') == signatures('target-drop'), 'Two different drop locations should have identical client observations in this fixture.'
        assert by_mode['router-drop']['targetSynCounters'][0] == 0
        assert by_mode['target-drop']['targetSynCounters'][0] > 0
        assert {p['limited']['applicationReply'] for p in by_mode['intermittent']['attempts'] if p['limited']['ttl'] >= 3} == {True, False}
        assert by_mode['baseline']['existingTraceroute']['results'][0]['targetReached']
        assert by_mode['silent-router']['existingTraceroute']['results'][0]['targetReached']
        result = {'task': 'FG-08.1', 'passed': True, 'architecture': os.uname().machine,
                  'target': {'address': TARGET, 'port': PORT, 'payloadBytes': len(PAYLOAD), 'minimumSuccessfulTtl': 3},
                  'timeoutSeconds': TIMEOUT, 'repeats': REPEATS, 'tcpAttempts': sum(len(row['attempts']) * 2 for row in rows),
                  'phases': rows, 'conclusions': {'silentHopCanForwardTraffic': True,
                  'differentDropLocationsCanLookIdentical': True, 'repeatsRevealIntermittence': True,
                  'exactBlockingNodeIdentifiedFromClientOnly': False},
                  'scope': 'IPv4 TCP, controlled namespaces and deliberately injected faults; no public provider or DPI diagnosed.'}
        pathlib.Path(report).write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'passed': True, 'tcpAttempts': result['tcpAttempts'], 'report': report}))
    finally:
        for child in reversed(children):
            if child.stdin:
                try:
                    child.stdin.close()
                except BrokenPipeError:
                    pass
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait()
        # Child namespace destruction also removes their private veth peers.
        for _ in range(40):
            remaining = json.loads(run('ip', '-j', 'link', 'show'))
            if all(row['ifname'] == 'lo' for row in remaining):
                break
            time.sleep(.05)
        assert all(row['ifname'] == 'lo' for row in remaining), 'Test veth cleanup failed.'


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--peer':
        peer(sys.argv[2])
    else:
        parser = argparse.ArgumentParser()
        parser.add_argument('--report', required=True)
        parser.add_argument('--trace-module', required=True)
        args = parser.parse_args()
        study(args.report, args.trace_module)
