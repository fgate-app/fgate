#!/usr/bin/env python3
"""Opt-in real VPN test. Supply a private, already imported Xray client JSON.

Never embeds credentials or changes host routes. DNS goes through Xray DoH.
Only HTTP status/timing is printed; module output remains in a private tempdir.
"""
import argparse
import ipaddress
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import time


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def ready(number, process):
    for _ in range(300):
        if process.poll() is not None:
            raise RuntimeError('Module exited before readiness')
        try:
            with socket.create_connection(('127.0.0.1', number), timeout=.1):
                return
        except OSError:
            time.sleep(.1)
    raise TimeoutError('Module listener not ready')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--xray-config', required=True, type=pathlib.Path)
    parser.add_argument('--modules', default='/opt/freedomgate/modules', type=pathlib.Path)
    args = parser.parse_args()
    os.umask(0o077)
    original = json.loads(args.xray_config.read_text())
    # This test deliberately needs no provider-visible DNS to bootstrap the VPN.
    outbounds = original.get('outbounds', [])
    if len(outbounds) != 1 or outbounds[0].get('protocol') != 'vless':
        raise ValueError('Test expects exactly one VLESS outbound')
    outbound = outbounds[0]
    ipaddress.ip_address(outbound['settings']['vnext'][0]['address'])
    xray_port, mihomo_port = port(), port()
    while xray_port == mihomo_port:
        mihomo_port = port()
    xconfig = {'log': {'loglevel': 'error'}, 'inbounds': [{
        'listen': '127.0.0.1', 'port': xray_port, 'protocol': 'socks',
        'settings': {'auth': 'noauth', 'udp': True}}], 'outbounds': [outbound]}
    mconfig = {'mixed-port': mihomo_port, 'allow-lan': False,
        'bind-address': '127.0.0.1', 'log-level': 'error', 'ipv6': False,
        'tun': {'enable': False}, 'mode': 'rule',
        'dns': {'enable': True, 'ipv6': False,
                'nameserver': ['https://1.1.1.1/dns-query#xray']},
        'proxies': [{'name': 'xray', 'type': 'socks5', 'server': '127.0.0.1',
                     'port': xray_port, 'udp': True}], 'rules': ['MATCH,xray']}
    xray = args.modules / 'xray/v26.10.31/xray'
    mihomo = args.modules / 'mihomo/v1.19.33/mihomo'
    with tempfile.TemporaryDirectory(prefix='fg-private-vpn-') as folder:
        base = pathlib.Path(folder)
        xf, mf = base/'xray.json', base/'mihomo.json'
        xf.write_text(json.dumps(xconfig))
        mf.write_text(json.dumps(mconfig))
        processes = []
        with (base/'modules.log').open('w') as log:
            try:
                for command in [[str(xray), 'run', '-test', '-config', str(xf)],
                                [str(mihomo), '-t', '-d', folder, '-f', str(mf)]]:
                    result = subprocess.run(command, stdout=log, stderr=log, timeout=30)
                    if result.returncode:
                        raise RuntimeError('Module configuration rejected')
                xp = subprocess.Popen([str(xray), 'run', '-config', str(xf)], stdout=log, stderr=log)
                processes.append(xp)
                ready(xray_port, xp)
                mp = subprocess.Popen([str(mihomo), '-d', folder, '-f', str(mf)], stdout=log, stderr=log)
                processes.append(mp)
                ready(mihomo_port, mp)
                for url, expected in [('https://www.gstatic.com/generate_204', '204'),
                                      ('https://www.cloudflare.com/cdn-cgi/trace', '200')]:
                    result = subprocess.run(['curl', '--noproxy', '', '--silent',
                        '--output', '/dev/null', '--write-out', '%{http_code} %{time_total}',
                        '--max-time', '20', '--proxy', f'socks5h://127.0.0.1:{mihomo_port}', url],
                        capture_output=True, text=True, timeout=25)
                    status = result.stdout.split()
                    passed = result.returncode == 0 and status and status[0] == expected
                    print(json.dumps({'target': url, 'passed': bool(passed),
                        'curl_exit': result.returncode, 'http_and_seconds': result.stdout}), flush=True)
                    if not passed:
                        raise RuntimeError('VPN HTTPS check failed')
            finally:
                for process in reversed(processes):
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
    print(json.dumps({'chain': 'mihomo-Xray-VPN', 'dns': 'DoH via Xray',
        'host_routes_changed': False, 'packet_capture_verified': False}))


if __name__ == '__main__':
    main()
