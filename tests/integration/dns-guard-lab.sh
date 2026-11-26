#!/bin/sh
# Root-only integration test for transparent client DNS interception.
# Creates an isolated veth/netns "client", applies the DNS guard on the host
# side and proves that DNS to 8.8.8.8 is redirected to the local listener while
# DoT is dropped. Never touches the host uplink.
set -eu
[ "$(id -u)" -eq 0 ] || { echo 'root required' >&2; exit 1; }
command -v nft >/dev/null || { echo 'nft required' >&2; exit 1; }
command -v ip >/dev/null || { echo 'iproute2 required' >&2; exit 1; }

NS=fg-guard-lab
HOSTV=fgv0
PEER=fgn0
HOSTIP=10.77.0.1
CLIENTIP=10.77.0.2
SERVER_PID=
OLD_FORWARD=$(sysctl -n net.ipv4.ip_forward)
cleanup() {
  nft delete table inet freedomgate_dns 2>/dev/null || true
  ip netns del "$NS" 2>/dev/null || true
  ip link del "$HOSTV" 2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  sysctl -qw net.ipv4.ip_forward="$OLD_FORWARD"
}
trap cleanup EXIT

sysctl -qw net.ipv4.ip_forward=1
ip netns add "$NS"
ip link add "$HOSTV" type veth peer name "$PEER"
ip link set "$PEER" netns "$NS"
ip addr add "$HOSTIP/24" dev "$HOSTV"
ip link set "$HOSTV" up
ip -n "$NS" link set lo up
ip -n "$NS" addr add "$CLIENTIP/24" dev "$PEER"
ip -n "$NS" link set "$PEER" up
ip -n "$NS" route add default via "$HOSTIP"

python3 - "$HOSTIP" <<'PY' &
import socket, sys
host = sys.argv[1]
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind((host, 53053))
while True:
    query, address = sock.recvfrom(4096)
    end = 12
    while query[end]:
        end += query[end] + 1
    end += 1
    question = query[12:end + 4]
    answer = query[:2] + bytes([0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]) + question + bytes([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 203, 0, 113, 7])
    sock.sendto(answer, address)
PY
SERVER_PID=$!
sleep 0.5

sh "$(dirname "$0")/../../scripts/freedomgate-dns-guard" on "$HOSTV" 10.77.0.0/24

ip netns exec "$NS" python3 - <<'PY'
import socket, struct
query = struct.pack('!HHHHHH', 0x1234, 0x0100, 1, 0, 0, 0) + b'\x07example\x03com\x00' + struct.pack('!HH', 1, 1)
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.settimeout(4)
sock.sendto(query, ('8.8.8.8', 53))
data = sock.recv(4096)
assert data[3] & 15 == 0, 'unexpected rcode'
assert data[-4:] == bytes([203, 0, 113, 7]), 'DNS was not redirected to the local listener'
print('dns redirect ok')
PY

ip netns exec "$NS" python3 - <<'PY'
import socket
try:
    connection = socket.create_connection(('1.1.1.1', 853), timeout=2)
    connection.close()
    raise SystemExit('DoT was not blocked')
except OSError:
    print('dot blocked')
PY

python3 - <<'PY'
import json, subprocess
data = json.loads(subprocess.check_output(['nft', '-j', 'list', 'table', 'inet', 'freedomgate_dns']))
counts = {}
for entry in data['nftables']:
    rule = entry.get('rule', {})
    comment = rule.get('comment')
    if not comment:
        continue
    counts[comment] = sum(expr.get('counter', {}).get('packets', 0) for expr in rule.get('expr', []))
assert counts.get('fg-dot-tcp', 0) > 0, 'DoT drop rule did not match'
assert counts.get('fg-dns-udp', 0) > 0, 'DNS redirect rule did not match'
print('counters', counts)
PY
echo 'dns guard lab passed'
