"""Offline validation of capture evidence analysis; no root/network needed."""
import importlib.util
import pathlib
import socket
import struct
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('lab',pathlib.Path(__file__).with_name('dns-privacy-lab.py'))
lab=importlib.util.module_from_spec(spec);spec.loader.exec_module(lab)
MAC=bytes.fromhex('020000000002');HOST=bytes.fromhex('020000000001')

def packet(protocol=6,port=18443,destination='198.18.77.1',source_mac=MAC,ipv6=False):
    ethernet=HOST+source_mac+(b'\x86\xdd' if ipv6 else b'\x08\0')
    if ipv6:return ethernet+bytes(40)
    transport=struct.pack('!HH',40000,port)+(bytes(8)+b'\x50'+bytes(7)+b'abc' if protocol==6 else bytes(4)+b'dns')
    header=b'\x45\0'+struct.pack('!H',20+len(transport))+bytes(5)+bytes([protocol])+bytes(2)+socket.inet_aton('198.18.77.2')+socket.inet_aton(destination)
    return ethernet+header+transport

class CaptureEvidence(unittest.TestCase):
    def analyse(self,packets,truncate=0):
        data=struct.pack('<IHHIIII',0xa1b2c3d4,2,4,0,0,65535,1)
        for p in packets:data+=struct.pack('<IIII',0,0,len(p),len(p))+p
        if truncate:data=data[:-truncate]
        with tempfile.TemporaryDirectory() as folder:
            path=pathlib.Path(folder)/'capture.pcap';path.write_bytes(data)
            return lab.capture_summary(path,'198.18.77.1',18443,'02:00:00:00:00:02')
    def test_tunnel_payload(self):
        s=self.analyse([packet()]);self.assertEqual(s['tcp_payload_packets'],1);self.assertEqual(s['unexpected_outbound'],0)
    def test_dns_escape_detected(self):
        s=self.analyse([packet(17,53,'1.1.1.1')]);self.assertEqual(s['dns53'],1);self.assertEqual(s['unexpected_outbound'],1)
    def test_direction_of_ipv6(self):
        s=self.analyse([packet(ipv6=True,source_mac=HOST)]);self.assertEqual(s['ipv6'],1);self.assertEqual(s['outbound_ipv6'],0)
        self.assertEqual(self.analyse([packet(ipv6=True)])['outbound_ipv6'],1)
    def test_dns_response_validation(self):
        response=struct.pack('!HHHHHH',12345,0x8180,1,1,0,0)
        self.assertTrue(lab.dns_ok(response))
        self.assertFalse(lab.dns_ok(struct.pack('!HHHHHH',12345,0x8182,1,0,0,0)))
        self.assertFalse(lab.dns_ok(struct.pack('!HHHHHH',12346,0x8180,1,1,0,0)))
    def test_query_address_families(self):
        self.assertEqual(lab.dns_query('example.com')[-4:],b'\0\1\0\1')
        self.assertEqual(lab.dns_query('example.com',qtype=28)[-4:],b'\0\x1c\0\1')
    def test_compressed_dns_address_answers(self):
        for qtype,address,family in [(1,'192.0.2.8',socket.AF_INET),(28,'2001:db8::8',socket.AF_INET6)]:
            query=lab.dns_query('example.com',qtype=qtype)
            raw=socket.inet_pton(family,address)
            reply=struct.pack('!HHHHHH',12345,0x8180,1,1,0,0)+query[12:]+b'\xc0\x0c'+struct.pack('!HHIH',qtype,1,30,len(raw))+raw
            self.assertEqual(lab.dns_addresses(reply,qtype),[address])
    def test_dns_address_parser_rejects_servfail(self):
        reply=struct.pack('!HHHHHH',12345,0x8182,0,0,0,0)
        self.assertEqual(lab.dns_addresses(reply),[])
    def test_truncated_capture_cannot_pass(self):
        with self.assertRaises(RuntimeError):self.analyse([packet()],truncate=1)

class ReadinessModel(unittest.TestCase):
    """An open listener is not health: transport and DNS are separate layers."""
    def test_state_matrix(self):
        self.assertEqual(lab.readiness_state(False,False),'down')
        self.assertEqual(lab.readiness_state(False,True),'down')
        self.assertEqual(lab.readiness_state(True,False),'degraded')
        self.assertEqual(lab.readiness_state(True,True),'ready')
    def test_first_success_and_transitions(self):
        rows=[{'t':0,'xray_tls_ip':{'ok':False},'mihomo_dns':{'ok':False}},
              {'t':2,'xray_tls_ip':{'ok':True},'mihomo_dns':{'ok':False}},
              {'t':4,'xray_tls_ip':{'ok':True},'mihomo_dns':{'ok':True}}]
        summary=lab.summarize_timeline(rows)
        self.assertEqual(summary['first_success']['xray_tls_ip'],2)
        self.assertEqual(summary['first_success']['mihomo_dns'],4)
        self.assertIsNone(summary['first_success']['doh_google'])
        self.assertEqual([row['state'] for row in summary['transitions']],['down','degraded','ready'])
        self.assertEqual(summary['final_state'],'ready')
    def test_unanswered_probe_is_not_success(self):
        summary=lab.summarize_timeline([{'t':0,'xray_tls_ip':{'ok':None},'mihomo_dns':{'ok':None}}])
        self.assertIsNone(summary['first_success']['xray_tls_ip'])
        self.assertIsNone(summary['first_success']['mihomo_dns'])
        self.assertEqual(summary['final_state'],'down')
    def test_missing_layer_keys_do_not_raise(self):
        summary=lab.summarize_timeline([{'t':0}])
        self.assertEqual(summary['ticks'],1)
        self.assertEqual(summary['final_state'],'down')

if __name__=='__main__':unittest.main()
