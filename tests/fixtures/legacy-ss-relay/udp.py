"""SOCKS5 UDP associations and SIP004 AEAD datagrams for the pinned SS peer.

Integration code only: the vendored parser and TCP transport stay unchanged.
Prefixes from ss:// are TCP-only, as in Outline. UDP uses fresh random salts.
"""
import asyncio
from collections import OrderedDict
import ipaddress
import os
import socket
import struct
from core import CIPHERS, master_key
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def address_end(data):
    if not data:
        raise ValueError('Missing address')
    if data[0] == 1:
        end = 7
    elif data[0] == 4:
        end = 19
    elif data[0] == 3 and len(data) > 1 and data[1]:
        end = 4 + data[1]
    else:
        raise ValueError('Invalid address')
    if len(data) < end or data[end-2:end] == b'\0\0':
        raise ValueError('Invalid destination port')
    return end


class PacketCipher:
    def __init__(self, node):
        self.size, self.factory = CIPHERS[node['cipher']]
        self.master = master_key(node['password'], self.size)

    def cipher(self, salt):
        key = HKDF(algorithm=hashes.SHA1(), length=self.size, salt=salt,
                   info=b'ss-subkey').derive(self.master)
        return self.factory(key)

    def encrypt(self, payload):
        salt = os.urandom(self.size)
        return salt + self.cipher(salt).encrypt(bytes(12), payload, None)

    def decrypt(self, packet):
        if len(packet) < self.size + 16:
            raise ValueError('Truncated datagram')
        salt = packet[:self.size]
        return salt, self.cipher(salt).decrypt(bytes(12), packet[self.size:], None)


class Association(asyncio.DatagramProtocol):
    def __init__(self, node, client_port=0):
        self.peer = (node['server'], node['port'])
        self.cipher = PacketCipher(node)
        self.client_port = client_port
        self.client = None
        self.local = self.remote = None
        self.seen = OrderedDict()

    async def start(self):
        loop = asyncio.get_running_loop()
        try:
            self.remote, _ = await loop.create_datagram_endpoint(
                lambda: Reply(self), remote_addr=self.peer,
                family=socket.AF_INET6 if ':' in self.peer[0] else socket.AF_INET)
            self.local, _ = await loop.create_datagram_endpoint(
                lambda: self, local_addr=('127.0.0.1', 0))
            return self.local.get_extra_info('sockname')
        except BaseException:
            self.close()
            raise

    def datagram_received(self, data, addr):
        # The relay is loopback-only and owned by its TCP association. Lock to
        # one UDP source; never forward fragments or invalid destination headers.
        if addr[0] != '127.0.0.1' or (self.client_port and addr[1] != self.client_port):
            return
        if self.client is not None and addr != self.client:
            return
        if len(data) < 4 or data[:3] != bytes(3):
            return
        try:
            address_end(data[3:])
            packet = self.cipher.encrypt(data[3:])
            if len(packet) > 65507:
                return
            self.client = addr
            self.remote.sendto(packet)
        except (ValueError, OSError):
            return

    def reply(self, packet):
        if self.client is None or self.local is None:
            return
        try:
            salt, payload = self.cipher.decrypt(packet)
            address_end(payload)
            if salt in self.seen:
                return
            self.seen[salt] = True
            if len(self.seen) > 4096:
                self.seen.popitem(last=False)
            if len(payload) + 3 <= 65507:
                self.local.sendto(bytes(3) + payload, self.client)
        except Exception:
            # Authentication failures, malformed replies and ICMP errors must
            # never fall back to sending the client payload directly.
            return

    def close(self):
        for transport in (self.local, self.remote):
            if transport:
                transport.close()
        self.local = self.remote = None
        self.seen.clear()


class Reply(asyncio.DatagramProtocol):
    def __init__(self, association):
        self.association = association

    def datagram_received(self, data, addr):
        self.association.reply(data)


class ReplayReader:
    def __init__(self, prefix, reader):
        self.prefix, self.reader = prefix, reader

    async def readexactly(self, count):
        head, self.prefix = self.prefix[:count], self.prefix[count:]
        return head + (await self.reader.readexactly(count-len(head)) if len(head) < count else b'')

    async def read(self, count=-1):
        if self.prefix:
            size = len(self.prefix) if count < 0 else count
            head, self.prefix = self.prefix[:size], self.prefix[size:]
            return head
        return await self.reader.read(count)


class GreetedWriter:
    def __init__(self, writer):
        self.writer, self.greeted = writer, False

    def write(self, data):
        if not self.greeted:
            self.greeted = True
            if data == b'\x05\x00':
                return
        self.writer.write(data)

    def __getattr__(self, name):
        return getattr(self.writer, name)


def socks_handler(app, node):
    active = set()

    async def handle(reader, writer):
        association = None
        delegated = False
        try:
            if len(active) >= 256:
                return
            active.add(writer)
            async with asyncio.timeout(12):
                greeting = await reader.readexactly(2)
                if greeting[0] != 5 or not greeting[1]:
                    return
                methods = await reader.readexactly(greeting[1])
                if 0 not in methods:
                    writer.write(b'\x05\xff')
                    await writer.drain()
                    return
                writer.write(b'\x05\x00')
                await writer.drain()
                request = await reader.readexactly(3)
                if request[0] != 5 or request[2] != 0:
                    return
                if request[1] == 1:
                    delegated = True
                elif request[1] == 3:
                    kind = (await reader.readexactly(1))[0]
                    if kind not in (1, 4):
                        raise ValueError('UDP client address must be IP')
                    raw = await reader.readexactly(4 if kind == 1 else 16)
                    ip = ipaddress.ip_address(raw)
                    port = struct.unpack('!H', await reader.readexactly(2))[0]
                    if not (ip.is_unspecified or str(ip) == '127.0.0.1'):
                        raise ValueError('UDP client must be loopback')
                    association = Association(node, port)
                    _, port = await association.start()
                    writer.write(b'\x05\x00\x00\x01\x7f\x00\x00\x01' + struct.pack('!H', port))
                    await writer.drain()
                else:
                    writer.write(b'\x05\x07\x00\x01' + bytes(6))
                    await writer.drain()
                    return
            if delegated:
                await app.socks(ReplayReader(greeting + methods + request, reader), GreetedWriter(writer))
            else:
                # UDP lifetime is bounded by its authenticated local TCP owner.
                while await reader.read(1024):
                    pass
        except Exception:
            pass
        finally:
            active.discard(writer)
            if association:
                association.close()
            if not delegated:
                writer.close()
                try:
                    await writer.wait_closed()
                except Exception:
                    pass
    return handle
