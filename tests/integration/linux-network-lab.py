#!/usr/bin/env python3
"""Isolated Linux kernel smoke test. Does not modify host routes/firewall."""
import json, os, subprocess, uuid

def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True).stdout.strip()

def main():
    if os.geteuid() != 0:
        raise SystemExit('Run with sudo on the Linux test device')
    suffix = uuid.uuid4().hex[:6]
    client, server = 'fg-client-' + suffix, 'fg-server-' + suffix
    a, b = 'fgc' + suffix, 'fgs' + suffix
    namespaces = []
    processes = []
    try:
        for ns in [client, server]:
            run('ip', 'netns', 'add', ns)
            namespaces.append(ns)
            run('ip', '-n', ns, 'link', 'set', 'lo', 'up')
        run('ip', 'link', 'add', a, 'type', 'veth', 'peer', 'name', b)
        run('ip', 'link', 'set', a, 'netns', client)
        run('ip', 'link', 'set', b, 'netns', server)
        for ns, interface, address in [(client, a, '198.19.0.2/30'), (server, b, '198.19.0.1/30')]:
            run('ip', '-n', ns, 'addr', 'add', address, 'dev', interface)
            run('ip', '-n', ns, 'link', 'set', interface, 'up')
        run('ip', 'netns', 'exec', client, 'ping', '-c', '2', '-W', '2', '198.19.0.1')
        run('ip', 'netns', 'exec', client, 'ip', 'tuntap', 'add', 'dev', 'fgtun', 'mode', 'tun')
        run('ip', '-n', client, 'link', 'set', 'fgtun', 'up')
        run('ip', 'netns', 'exec', client, 'nft', 'add', 'table', 'inet', 'fg_lab')
        run('ip', 'netns', 'exec', client, 'nft', 'add', 'chain', 'inet', 'fg_lab', 'output', '{ type filter hook output priority 0; policy accept; }')
        run('ip', 'netns', 'exec', client, 'nft', 'add', 'rule', 'inet', 'fg_lab', 'output', 'ip daddr 198.19.0.1 icmp type echo-request drop')
        denied = subprocess.run(['ip', 'netns', 'exec', client, 'ping', '-c', '1', '-W', '1', '198.19.0.1'], capture_output=True)
        assert denied.returncode != 0, 'Isolated firewall did not drop ICMP'
        run('ip', 'netns', 'exec', client, 'nft', 'delete', 'table', 'inet', 'fg_lab')
        run('ip', 'netns', 'exec', client, 'ping', '-c', '1', '-W', '2', '198.19.0.1')
        print(json.dumps({'namespace_connectivity':'passed', 'tun_device':'passed', 'isolated_nftables':'passed', 'host_network_changes':False}))
    finally:
        for ns in reversed(namespaces):
            subprocess.run(['ip', 'netns', 'del', ns], capture_output=True)
        subprocess.run(['ip', 'link', 'del', a], capture_output=True)
        subprocess.run(['ip', 'link', 'del', b], capture_output=True)

if __name__ == '__main__':
    main()
