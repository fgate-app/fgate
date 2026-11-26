import os
import json
import tempfile
import asyncio
import socket
import struct
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tests/fixtures/legacy-ss-relay/vendor'))
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tests/fixtures/legacy-ss-relay'))
from udp import PacketCipher, socks_handler
from core import target_address
from service import Application
NODE={'cipher':'chacha20-ietf-poly1305','password':'fixture-only','prefix_hex':'16030100a80101','server':'127.0.0.1'}

class Peer(asyncio.DatagramProtocol):
    def __init__(self):self.received=[];self.transport=None
    def connection_made(self,t):self.transport=t
    def datagram_received(self,data,addr):
        _,payload=PacketCipher(NODE).decrypt(data)
        self.received.append(payload)
        reply=PacketCipher(NODE).encrypt(payload)
        self.transport.sendto(reply,addr)
        self.transport.sendto(reply,addr) # replay must not reach the client
        self.transport.sendto(bytes(len(reply)),addr) # invalid authentication

class Tests(unittest.IsolatedAsyncioTestCase):
    async def test_cipher_variants_and_authentication(self):
        for cipher in ['chacha20-ietf-poly1305','aes-256-gcm','aes-128-gcm']:
            codec=PacketCipher({**NODE,'cipher':cipher})
            payload=target_address('example.com',443)+b'QUIC fixture'
            packet=codec.encrypt(payload);salt,plain=codec.decrypt(packet)
            self.assertEqual(plain,payload)
            self.assertNotEqual(packet,codec.encrypt(payload))
            self.assertFalse(salt.startswith(bytes.fromhex(NODE['prefix_hex'])))
            with self.assertRaises(Exception):codec.decrypt(packet[:-1]+bytes([packet[-1]^1]))

    async def test_socks_udp_association_lifetime_source_lock_and_fragments(self):
        loop=asyncio.get_running_loop();peer=Peer()
        remote,_=await loop.create_datagram_endpoint(lambda:peer,local_addr=('127.0.0.1',0))
        node={**NODE,'port':remote.get_extra_info('sockname')[1]}
        app=Application(type('Config',(),{'nodes':[node],'settings':{'timeout':8}})(),interface='')
        server=None; child=None; folder=None
        if os.environ.get('FREEDOMGATE_OUTLINE'):
            folder=tempfile.TemporaryDirectory()
            with socket.socket() as port_socket:
                port_socket.bind(('127.0.0.1',0));listen_port=port_socket.getsockname()[1]
            config=Path(folder.name)/'config.json';config.write_text(json.dumps({'node':node,'port':listen_port}))
            child=await asyncio.create_subprocess_exec(os.environ['FREEDOMGATE_OUTLINE'],str(config),stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL)
            for _ in range(100):
                try:
                    ready_r,ready_w=await asyncio.open_connection('127.0.0.1',listen_port);ready_w.close();await ready_w.wait_closed();break
                except OSError:await asyncio.sleep(.02)
        else:
            server=await asyncio.start_server(socks_handler(app,node),'127.0.0.1',0)
            listen_port=server.sockets[0].getsockname()[1]
        client=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);client.bind(('127.0.0.1',0));client.setblocking(False)
        other=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);other.bind(('127.0.0.1',0));other.setblocking(False)
        reader,writer=await asyncio.open_connection('127.0.0.1',listen_port)
        try:
            writer.write(b'\x05\x01\x00');await writer.drain();self.assertEqual(await reader.readexactly(2),b'\x05\x00')
            writer.write(bytes.fromhex('05030001000000000000'));await writer.drain()
            response=await reader.readexactly(10);self.assertEqual(response[:4],bytes.fromhex('05000001'))
            relay=('127.0.0.1',struct.unpack('!H',response[-2:])[0]);payload=target_address('example.com',443)+b'QUIC payload';packet=bytes(3)+payload
            await loop.sock_sendto(client,packet,relay)
            received,_=await asyncio.wait_for(loop.sock_recvfrom(client,4096),1);self.assertEqual(received,packet)
            with self.assertRaises(TimeoutError):await asyncio.wait_for(loop.sock_recvfrom(client,4096),.1)
            await loop.sock_sendto(other,packet,relay)
            await loop.sock_sendto(client,b'\x00\x00\x01'+payload,relay)
            await loop.sock_sendto(client,bytes(3)+b'\x03\xff',relay)
            await asyncio.sleep(.1);self.assertEqual(peer.received,[payload])
            writer.close();await writer.wait_closed();await asyncio.sleep(.1)
            await loop.sock_sendto(client,packet,relay);await asyncio.sleep(.1);self.assertEqual(peer.received,[payload])
        finally:
            writer.close();client.close();other.close();remote.close()
            if server:server.close();await server.wait_closed()
            if child:child.terminate();await asyncio.wait_for(child.wait(),3)
            if folder:folder.cleanup()

if __name__=='__main__':unittest.main()
