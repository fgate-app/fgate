"""Bounded Linux header-only capture for one helper-owned TCP control socket.

The kernel filter matches both directions of the exact tuple and returns only
IP/TCP headers. No pcap, payload, promiscuous mode or firewall changes.
IPv6 extension headers and fragmented IPv4 are deliberately not accepted.
"""
import ctypes
import ipaddress
import socket
import struct
import threading
import time

LIMITS = {'maxSeconds': 10, 'maxPackets': 64, 'payloadBytes': 0}


def header_filter(local, local_port, peer, peer_port):
    version = ipaddress.ip_address(local).version
    if version != ipaddress.ip_address(peer).version:
        raise ValueError('Address family mismatch')
    code, labels, jumps = [], {}, []

    def emit(op, value=0):
        code.append([op, 0, 0, value])

    def equal(value, failure):
        jumps.append((len(code), failure))
        code.append([0x15, 0, 0, value])

    emit(0x30, 0)  # ldb [0]
    emit(0x54, 0xf0)
    equal(version << 4, 'drop')
    emit(0x30, 9 if version == 4 else 6)
    equal(6, 'drop')
    if version == 4:
        emit(0x28, 6)
        emit(0x54, 0x3fff)  # fragments cannot be correlated by ports
        equal(0, 'drop')
        emit(0xb1, 0)  # X = IP header length
    for direction, source, sport, dest, dport in [
            ('outbound', local, local_port, peer, peer_port),
            ('inbound', peer, peer_port, local, local_port)]:
        labels[direction] = len(code)
        failure = 'inbound' if direction == 'outbound' else 'drop'
        for address, offset in [(source, 12 if version == 4 else 8),
                                (dest, 16 if version == 4 else 24)]:
            packed = ipaddress.ip_address(address).packed
            for index in range(0, len(packed), 4):
                emit(0x20, offset + index)
                equal(struct.unpack('!I', packed[index:index+4])[0], failure)
        for offset, port in [(0, sport), (2, dport)]:
            emit(0x48 if version == 4 else 0x28, offset if version == 4 else 40 + offset)
            equal(port, failure)
        # Return precisely IP header length + TCP data offset, never payload.
        emit(0x50 if version == 4 else 0x30, 12 if version == 4 else 52)
        emit(0x54, 0xf0)
        emit(0x74, 2)
        emit(0x0c if version == 4 else 0x04, 0 if version == 4 else 40)
        emit(0x16)
    labels['drop'] = len(code)
    emit(0x06)
    for index, label in jumps:
        code[index][2] = labels[label] - index - 1
    return code


def attach_filter(sock, instructions):
    class Filter(ctypes.Structure):
        _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte),
                    ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint32)]

    class Program(ctypes.Structure):
        _fields_ = [('len', ctypes.c_ushort), ('filter', ctypes.POINTER(Filter))]

    filters = (Filter * len(instructions))(*(Filter(*row) for row in instructions))
    sock.setsockopt(socket.SOL_SOCKET, 26, bytes(Program(len(instructions), filters)))  # SO_ATTACH_FILTER


def packet_metadata(data, local, local_port, peer, peer_port, elapsed_ms):
    if not data:
        return None
    version = data[0] >> 4
    if version == 4:
        if len(data) < 20 or data[9] != 6 or struct.unpack('!H', data[6:8])[0] & 0x3fff:
            return None
        offset = (data[0] & 15) * 4
        if offset < 20:
            return None
        source, dest = (socket.inet_ntop(socket.AF_INET, data[a:b]) for a, b in [(12, 16), (16, 20)])
        ttl, size = data[8], struct.unpack('!H', data[2:4])[0]
    elif version == 6:
        if len(data) < 40 or data[6] != 6:
            return None
        offset = 40
        source, dest = (socket.inet_ntop(socket.AF_INET6, data[a:b]) for a, b in [(8, 24), (24, 40)])
        ttl, size = data[7], 40 + struct.unpack('!H', data[4:6])[0]
    else:
        return None
    if len(data) < offset + 20:
        return None
    sport, dport, sequence, ack = struct.unpack('!HHII', data[offset:offset+12])
    header_bytes = offset + (data[offset+12] >> 4) * 4
    if header_bytes < offset + 20 or len(data) != header_bytes or size < header_bytes:
        return None
    if (source, sport, dest, dport) == (local, local_port, peer, peer_port):
        direction = 'outbound'
    elif (source, sport, dest, dport) == (peer, peer_port, local, local_port):
        direction = 'inbound'
    else:
        return None
    bits = data[offset+13]
    return {'direction': direction, 'timeMs': round(elapsed_ms, 3), 'ttl': ttl,
            'sequence': sequence, 'ack': ack, 'ipBytes': size, 'headerBytes': header_bytes,
            'flags': [name for mask, name in [(2, 'SYN'), (16, 'ACK'), (4, 'RST'), (1, 'FIN')]
                      if bits & mask]}


class TcpCapture:
    def __init__(self, interface, local, local_port, peer, peer_port, max_packets=64):
        self.tuple = (str(ipaddress.ip_address(local)), local_port, str(ipaddress.ip_address(peer)), peer_port)
        self.interface, self.rows, self.failure = interface, [], None
        self.limits = {**LIMITS, 'maxPackets': min(64, max(1, max_packets))}
        self.finished = False
        self.started = time.monotonic()
        self.stopped = threading.Event()
        self.sock = None
        try:
            # A protocol-zero socket receives nothing until the filter is attached.
            self.sock = socket.socket(socket.AF_PACKET, socket.SOCK_DGRAM, 0)
            attach_filter(self.sock, header_filter(*self.tuple))
            self.sock.bind((interface, 3))  # ETH_P_ALL, one applied interface
            self.sock.settimeout(.05)
        except (OSError, AttributeError, ValueError):
            if self.sock:
                self.sock.close()
            raise
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        try:
            while not self.stopped.is_set() and time.monotonic() - self.started < LIMITS['maxSeconds'] and len(self.rows) < self.limits['maxPackets']:
                try:
                    data = self.sock.recv(120)  # max IPv4+TCP headers (60+60)
                except socket.timeout:
                    continue
                row = packet_metadata(data, *self.tuple, (time.monotonic() - self.started) * 1000)
                if row:
                    self.rows.append(row)
        except OSError:
            self.failure = 'capture-read-failed'

    def snapshot(self):
        rows = list(self.rows)
        syn = any(row['direction'] == 'outbound' and 'SYN' in row['flags'] and 'ACK' not in row['flags'] for row in rows)
        verified = syn and not self.failure
        return {'state': 'observed' if verified else 'unavailable',
                'reason': self.failure or (None if verified else 'probe-syn-not-observed'),
                'scope': 'direct-endpoint-control', 'probeCorrelated': verified,
                'routeVerified': False, 'interface': self.interface, 'limits': dict(self.limits),
                'tuple': dict(zip(['localAddress', 'localPort', 'peerAddress', 'peerPort'], self.tuple)),
                'packets': rows, 'packetLimitReached': len(rows) == self.limits['maxPackets'],
                'timeLimitReached': time.monotonic() - self.started >= LIMITS['maxSeconds'],
                'durationMs': round((time.monotonic() - self.started) * 1000)}

    def finish(self):
        if not self.finished:
            self.finished = True
            self.stopped.set()
            self.thread.join(timeout=.2)
            self.sock.close()
            self.thread.join(timeout=.2)
        return self.snapshot()
