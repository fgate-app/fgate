"""Controlled AEAD peer; rejects missing prefix and returns HTTP fixture data."""
import asyncio
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'tests/fixtures/legacy-ss-relay/vendor'))
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'tests/fixtures/legacy-ss-relay'))
from core import SSStream
from udp import PacketCipher,address_end
NODE={'cipher':'chacha20-ietf-poly1305','password':'test-password','prefix_hex':''}
async def handle(reader,writer):
    stream=SSStream(reader,writer,NODE)
    try:
        salt=await reader.readexactly(32)
        assert salt.startswith(bytes.fromhex('160301'))
        stream.decryptor=stream.cipher(salt)
        data=await stream.read()
        skip=7 if data[0]==1 else 19 if data[0]==4 else 4+data[1]
        request=data[skip:]
        while b'\r\n\r\n' not in request: request+=await stream.read()
        body=b'freedomgate-ss-prefix-ok'
        await stream.write(b'HTTP/1.1 200 OK\r\nContent-Length: '+str(len(body)).encode()+b'\r\nConnection: close\r\n\r\n'+body)
    except Exception:
        pass
    finally:
        await stream.close()
class UdpPeer(asyncio.DatagramProtocol):
    def connection_made(self,transport):self.transport=transport
    def datagram_received(self,data,addr):
        try:
            _,payload=PacketCipher(NODE).decrypt(data)
            end=address_end(payload)
            response=PacketCipher(NODE).encrypt(payload[:end]+b'freedomgate-udp-ok')
            self.transport.sendto(response,addr)
        except Exception:pass
async def main():
    server=await asyncio.start_server(handle,'127.0.0.1',0)
    port=server.sockets[0].getsockname()[1]
    await asyncio.get_running_loop().create_datagram_endpoint(UdpPeer,local_addr=('127.0.0.1',port))
    print(port,flush=True)
    async with server: await server.serve_forever()
asyncio.run(main())
