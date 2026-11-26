import importlib.util
import pathlib
import struct
import unittest

spec = importlib.util.spec_from_file_location('ttl_study', pathlib.Path(__file__).with_name('ttl-boundary-native.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def packet(source='198.18.1.2', port=42001, protocol=6, kind=11):
    outer = bytearray(20)
    outer[0] = 0x45
    outer[12:16] = module.socket.inet_aton('198.18.2.2')
    inner = bytearray(20)
    inner[0] = 0x45
    inner[9] = protocol
    inner[12:16] = module.socket.inet_aton(source)
    inner[16:20] = module.socket.inet_aton(module.TARGET)
    return bytes(outer) + bytes([kind, 0]) + bytes(6) + bytes(inner) + struct.pack('!HHI', port, module.PORT, 1) + b'private-payload'


class TtlMetadata(unittest.TestCase):
    def test_matches_exact_flow_and_keeps_only_metadata(self):
        value = module.icmp_metadata(packet(), '198.18.1.2', 42001, module.time.monotonic())
        self.assertEqual(value['from'], '198.18.2.2')
        self.assertEqual((value['type'], value['code']), (11, 0))
        self.assertTrue(value['tupleMatched'])
        self.assertNotIn('private', module.json.dumps(value))
        self.assertEqual(set(value), {'from', 'type', 'code', 'collectedAfterMs', 'tupleMatched'})

    def test_ignores_other_flows_protocols_and_malformed_quotes(self):
        for data in [b'', bytes(56), packet(port=42002), packet(source='198.18.1.3'), packet(protocol=17), packet(kind=0), packet()[:45]]:
            self.assertIsNone(module.icmp_metadata(data, '198.18.1.2', 42001, module.time.monotonic()))

    def test_missing_reply_is_not_a_blocking_location(self):
        row = {'applicationReply': False, 'icmp': []}
        self.assertEqual(module.signature(row), 'no-confirmed-reply')
        row['applicationReply'] = True
        self.assertEqual(module.signature(row), 'application-reply')


if __name__ == '__main__':
    unittest.main()
