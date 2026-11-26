"""Offline tests for the production classic BPF and header parser."""
import importlib.util
import ipaddress
from pathlib import Path
import struct
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('capture', Path(__file__).resolve().parents[2] / 'server/tcp-capture.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def bpf(code, data):
    a = x = pc = 0
    while pc < len(code):
        op, yes, no, k = code[pc]
        if op in (0x20, 0x28, 0x30, 0x48, 0x50, 0xb1):
            offset = k + (x if op in (0x48, 0x50) else 0)
            size = 4 if op == 0x20 else 2 if op in (0x28, 0x48) else 1
            if offset + size > len(data):
                return 0
            value = int.from_bytes(data[offset:offset+size], 'big')
            if op == 0xb1:
                x = (value & 15) * 4
            else:
                a = value
        elif op == 0x54:
            a &= k
        elif op == 0x74:
            a >>= k
        elif op == 0x04:
            a += k
        elif op == 0x0c:
            a += x
        elif op == 0x15:
            pc += yes if a == k else no
        elif op == 0x06:
            return min(k, len(data))
        elif op == 0x16:
            return min(a, len(data))
        else:
            raise AssertionError(op)
        pc += 1
    raise AssertionError('No return')


def packet(source, sport, dest, dport, flags=2, payload=b'', options=0):
    v = ipaddress.ip_address(source).version
    tcp = struct.pack('!HHIIBBHHH', sport, dport, 123, 456, (5 + options//4) << 4, flags, 8192, 0, 0) + b'\x01' * options
    src, dst = ipaddress.ip_address(source).packed, ipaddress.ip_address(dest).packed
    if v == 4:
        ip = struct.pack('!BBHHHBBH4s4s', 0x45 + options//4, 0, 20 + options + len(tcp) + len(payload), 0, 0x4000, 57, 6, 0, src, dst) + b'\x01' * options
    else:
        ip = struct.pack('!IHBB16s16s', 6 << 28, len(tcp) + len(payload), 6, 57, src, dst)
    return ip + tcp + payload


class CaptureTest(unittest.TestCase):
    def test_limit_missing_syn_and_failed_setup_release_resources(self):
        reader = m.TcpCapture.__new__(m.TcpCapture)
        reader.tuple = ('192.0.2.1', 45000, '203.0.113.2', 443)
        reader.interface, reader.failure = 'eth0', None
        reader.limits, reader.finished = dict(m.LIMITS), False
        reader.started, reader.stopped = m.time.monotonic(), m.threading.Event()
        reader.sock, reader.thread = Mock(), Mock()
        reader.thread.is_alive.return_value = False
        raw = packet(*reader.tuple)
        reader.sock.recv.return_value = raw
        reader.rows = []
        reader._read()
        self.assertEqual(len(reader.rows), 64)
        result = reader.finish()
        self.assertTrue(result['packetLimitReached'])
        self.assertTrue(reader.sock.close.called)
        reader.rows = [{'direction': 'inbound', 'flags': ['ACK']}]
        self.assertFalse(reader.finish()['probeCorrelated'])
        sock = Mock()
        with patch.object(m.socket, 'AF_PACKET', 17, create=True), patch.object(m.socket, 'socket', return_value=sock) as create, patch.object(m, 'attach_filter', side_effect=PermissionError()):
            with self.assertRaises(PermissionError):
                m.TcpCapture('eth0', *reader.tuple)
            self.assertEqual(create.call_args.args[-1], 0)
            sock.close.assert_called_once()

    def test_exact_tuple_both_directions_header_only_v4_v6_and_options(self):
        for local, peer in [('192.0.2.1', '203.0.113.2'), ('2001:db8::1', '2001:db8::2')]:
            code = m.header_filter(local, 45000, peer, 443)
            for options in [0, 4, 40]:
                for incoming in [False, True]:
                    args = (peer, 443, local, 45000) if incoming else (local, 45000, peer, 443)
                    raw = packet(*args, flags=18 if incoming else 2, payload=b'private-payload', options=options)
                    length = bpf(code, raw)
                    expected = (40 if ':' in local else 20 + options) + 20 + options
                    self.assertEqual(length, expected)
                    self.assertNotIn(b'private-payload', raw[:length])
                    row = m.packet_metadata(raw[:length], local, 45000, peer, 443, 1.25)
                    self.assertEqual(row['direction'], 'inbound' if incoming else 'outbound')
                    self.assertEqual(row['sequence'], 123)
                    self.assertEqual(row['ack'], 456)
                    self.assertEqual(row['ttl'], 57)
                    self.assertEqual(row['ipBytes'], len(raw))
                    self.assertEqual(row['headerBytes'], length)
                    self.assertIsNone(m.packet_metadata(raw, local, 45000, peer, 443, 0))
            for args in [(local, 45001, peer, 443), (local, 45000, peer, 444), (peer, 443, local, 45001), (peer, 444, local, 45000), (peer, 45000, local, 443)]:
                self.assertEqual(bpf(code, packet(*args)), 0)
            for length in range(40):
                raw = packet(local, 45000, peer, 443)[:length]
                kept = bpf(code, raw)
                self.assertIsNone(m.packet_metadata(raw[:kept], local, 45000, peer, 443, 0))

    def test_flags_fragments_extensions_and_no_correlation_without_syn(self):
        local, peer = '192.0.2.1', '203.0.113.2'
        for flags, expected in [(2, ['SYN']), (18, ['SYN', 'ACK']), (20, ['ACK', 'RST']), (17, ['ACK', 'FIN'])]:
            raw = packet(local, 45000, peer, 443, flags=flags)
            self.assertEqual(m.packet_metadata(raw, local, 45000, peer, 443, 0)['flags'], expected)
        raw = bytearray(packet(local, 45000, peer, 443));raw[6:8] = b'\x20\x00'
        self.assertEqual(bpf(m.header_filter(local, 45000, peer, 443), raw), 0)
        self.assertIsNone(m.packet_metadata(raw, local, 45000, peer, 443, 0))
        raw = bytearray(packet('2001:db8::1', 45000, '2001:db8::2', 443));raw[6] = 0
        self.assertEqual(bpf(m.header_filter('2001:db8::1', 45000, '2001:db8::2', 443), raw), 0)


if __name__ == '__main__':
    unittest.main()
