"""Shadowsocks AEAD transport, Outline prefixes and automatic server selection."""
import asyncio
import base64
from collections import deque
from dataclasses import dataclass, field
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import struct
import tempfile
import time
from urllib.parse import parse_qs, unquote, urlsplit

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM, ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

VERSION = "0.1.0"
CIPHERS = {"chacha20-ietf-poly1305": (32, ChaCha20Poly1305), "aes-256-gcm": (32, AESGCM), "aes-128-gcm": (16, AESGCM)}
PROBES = ("https://www.gstatic.com/generate_204", "https://www.cloudflare.com/cdn-cgi/trace")
DEFAULTS = {"interval": 60, "timeout": 8, "failure_threshold": 2, "switch_margin": 20}


class InputError(Exception):
    pass


def decode64(value):
    raw = value.encode("ascii")
    return base64.b64decode(raw + b"=" * (-len(raw) % 4), altchars=b"-_", validate=True)


def parse_ss(uri):
    """Parse SIP002/legacy ss://. Prefix is a byte string, not UTF-8 on the wire."""
    try:
        if not uri.startswith("ss://") or len(uri) > 16384:
            raise InputError("Expected an ss:// link.")
        body, _, fragment = uri[5:].partition("#")
        if "@" not in body:
            encoded, separator, query = body.partition("?")
            body = decode64(encoded).decode("utf-8") + (("?" + query) if separator else "")
        authority, separator, query = body.partition("?")
        user, sep, endpoint = authority.rpartition("@")
        if not sep:
            raise InputError("The link has no server address.")
        if ":" not in user:
            user = decode64(user).decode("utf-8")
        cipher, sep, password = user.partition(":")
        cipher, password = unquote(cipher), unquote(password)
        if not sep or not password:
            raise InputError("The link has no password.")
        if cipher not in CIPHERS:
            raise InputError("Supported ciphers: chacha20-ietf-poly1305, aes-256-gcm, aes-128-gcm.")
        address = urlsplit("//" + endpoint.rstrip("/"))
        host, port = address.hostname, address.port
        if not host or not port or not 1 <= port <= 65535 or address.path:
            raise InputError("Invalid server address or port.")
        options = parse_qs(query, keep_blank_values=True)
        if any(len(v) != 1 for v in options.values()):
            raise InputError("Repeated link parameters are unsupported.")
        unknown = set(options) - {"outline", "prefix"}
        if unknown:
            raise InputError("The link contains unsupported transport options.")
        prefix_text = options.get("prefix", [""])[0]
        # Some providers encode the entire escaped byte sequence twice.
        # Decode one additional layer only for a complete sequence of escapes;
        # do not recursively reinterpret ordinary text prefixes.
        if re.fullmatch(r'(?:%[0-9a-fA-F]{2})+', prefix_text):
            prefix_text = unquote(prefix_text, errors="strict")
        prefix = prefix_text.encode("latin-1")
        # Always preserve at least 128 random bits in the salt.
        if len(prefix) > min(16, CIPHERS[cipher][0] - 16):
            raise InputError("Prefix is too long for this cipher; use a 32-byte-salt cipher and at most 16 prefix bytes.")
        name = unquote(fragment).strip() or host
        if len(name) > 150 or any(ord(c) < 32 for c in name):
            raise InputError("Invalid node name.")
        return {"id": secrets.token_hex(8), "name": name, "server": host, "port": port,
                "cipher": cipher, "password": password, "prefix_hex": prefix.hex(), "enabled": True}
    except InputError:
        raise
    except Exception:
        # URL, base64 and Unicode errors may otherwise echo credentials.
        raise InputError("Invalid Shadowsocks link.") from None


def parse_links(text):
    if not isinstance(text, str) or len(text.encode()) > 256 * 1024:
        raise InputError("Paste SS links or a subscription smaller than 256 KiB.")
    text = text.strip()
    if text and not text.startswith("ss://"):
        try:
            text = decode64("".join(text.split())).decode("utf-8")
        except Exception:
            raise InputError("Expected SS links or a base64 SS subscription.") from None
    results, errors = [], []
    for index, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            results.append(parse_ss(line.strip()))
        except InputError as error:
            errors.append({"line": index, "error": str(error)})
    if not results and not errors:
        raise InputError("Paste at least one SS link.")
    return results, errors


def identity(node):
    return (node["server"].lower(), node["port"], node["cipher"], node["password"], node["prefix_hex"])


class Store:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.directory / "config.json"
        self.backups = self.directory / "backups"
        self.backups.mkdir(exist_ok=True, mode=0o700)
        self.settings = dict(DEFAULTS)
        self.nodes = []
        if self.path.exists():
            data = json.loads(self.path.read_text())
            self.nodes = data["nodes"]
            self.settings.update(data.get("settings", {}))
            self.validate_settings(self.settings)
            if len(self.nodes) > 200:
                raise InputError("At most 200 nodes are supported.")
            for node in self.nodes:
                self.validate_node(node)

    @staticmethod
    def validate_settings(settings):
        bounds = {"interval": (15, 3600), "timeout": (3, 30), "failure_threshold": (1, 5), "switch_margin": (5, 80)}
        if set(settings) != set(bounds):
            raise InputError("Unknown setting.")
        for key, (low, high) in bounds.items():
            if type(settings[key]) is not int or not low <= settings[key] <= high:
                raise InputError(f"{key} must be an integer from {low} to {high}.")

    @staticmethod
    def validate_node(node):
        if node.get("cipher") not in CIPHERS or not isinstance(node.get("password"), str) or not node["password"]:
            raise InputError("Invalid stored node.")
        prefix = bytes.fromhex(node["prefix_hex"])
        if len(prefix) > min(16, CIPHERS[node["cipher"]][0] - 16):
            raise InputError("Invalid stored prefix.")
        if type(node.get("port")) is not int or not 1 <= node["port"] <= 65535:
            raise InputError("Invalid stored port.")
        if type(node.get("enabled")) is not bool or not node.get("id") or not node.get("server"):
            raise InputError("Invalid stored node.")

    def save(self):
        payload = json.dumps({"version": 1, "settings": self.settings, "nodes": self.nodes}, ensure_ascii=False, indent=2).encode() + b"\n"
        temporary = None
        try:
            fd, temporary = tempfile.mkstemp(dir=self.directory, prefix=".config-")
            with os.fdopen(fd, "wb") as handle:
                os.fchmod(handle.fileno(), 0o600)
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            if self.path.exists():
                backup = self.backups / (str(time.time_ns()) + ".json")
                with backup.open("xb") as handle:
                    os.fchmod(handle.fileno(), 0o600)
                    handle.write(self.path.read_bytes())
                    handle.flush()
                    os.fsync(handle.fileno())
            fd = os.open(self.backups, os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(temporary, self.path)
            fd = os.open(self.directory, os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
            for old in sorted(self.backups.glob("*.json"))[:-10]:
                old.unlink()
        finally:
            if temporary:
                Path(temporary).unlink(missing_ok=True)

    def import_text(self, text):
        parsed, errors = parse_links(text)
        candidates = list(self.nodes)
        known = {identity(n) for n in candidates}
        added, skipped = [], 0
        for node in parsed:
            if identity(node) in known:
                skipped += 1
                continue
            if len(candidates) >= 200:
                raise InputError("At most 200 nodes are supported.")
            known.add(identity(node))
            candidates.append(node)
            added.append(node["id"])
        previous = self.nodes
        self.nodes = candidates
        try:
            if added:
                self.save()
        except Exception:
            self.nodes = previous
            raise
        return {"added": len(added), "skipped": skipped, "errors": errors}


def master_key(password, length):
    result, last = b"", b""
    while len(result) < length:
        last = hashlib.md5(last + password.encode("utf-8")).digest()
        result += last
    return result[:length]


class SSStream:
    """AEAD stream with independent sending/receiving salts and nonce counters."""
    def __init__(self, reader, writer, node, destination=b""):
        self.reader, self.writer = reader, writer
        self.salt_size, self.factory = CIPHERS[node["cipher"]]
        self.master = master_key(node["password"], self.salt_size)
        self.prefix = bytes.fromhex(node.get("prefix_hex", ""))
        self.destination = destination
        self.encryptor = self.decryptor = None
        self.send_nonce = self.recv_nonce = 0
        self.write_lock = asyncio.Lock()

    def cipher(self, salt):
        subkey = HKDF(algorithm=hashes.SHA1(), length=self.salt_size, salt=salt, info=b"ss-subkey").derive(self.master)
        return self.factory(subkey)

    def encrypt(self, data):
        result = self.encryptor.encrypt(self.send_nonce.to_bytes(12, "little"), data, None)
        self.send_nonce += 1
        return result

    def decrypt(self, data):
        result = self.decryptor.decrypt(self.recv_nonce.to_bytes(12, "little"), data, None)
        self.recv_nonce += 1
        return result

    async def write(self, data):
        async with self.write_lock:
            if self.encryptor is None:
                salt = self.prefix + os.urandom(self.salt_size - len(self.prefix))
                self.encryptor = self.cipher(salt)
                self.writer.write(salt)
                data = self.destination + data
                self.destination = b""
            for index in range(0, len(data), 0x3fff):
                part = data[index:index + 0x3fff]
                self.writer.write(self.encrypt(len(part).to_bytes(2, "big")) + self.encrypt(part))
            await self.writer.drain()

    async def read(self):
        if self.decryptor is None:
            try:
                salt = await self.reader.readexactly(self.salt_size)
            except asyncio.IncompleteReadError as error:
                if not error.partial:
                    return b""
                raise
            self.decryptor = self.cipher(salt)
        while True:
            try:
                encrypted_length = await self.reader.readexactly(18)
            except asyncio.IncompleteReadError as error:
                if not error.partial:
                    return b""
                raise
            length = int.from_bytes(self.decrypt(encrypted_length), "big")
            if length > 0x3fff:
                raise ValueError("Invalid AEAD frame size")
            data = self.decrypt(await self.reader.readexactly(length + 16))
            if data:
                return data

    async def close(self):
        self.writer.close()
        try:
            await self.writer.wait_closed()
        except (OSError, asyncio.CancelledError):
            pass


def target_address(host, port):
    try:
        address = ipaddress.ip_address(host)
        return bytes([1 if address.version == 4 else 4]) + address.packed + struct.pack("!H", port)
    except ValueError:
        encoded = host.encode("idna")
        if not 0 < len(encoded) <= 255:
            raise InputError("Invalid destination.")
        return b"\x03" + bytes([len(encoded)]) + encoded + struct.pack("!H", port)


class Resolver:
    """Resolve proxy endpoints outside mihomo's system fake-IP resolver."""
    def __init__(self, interface):
        self.interface = interface
        self.cache = {}

    def bind(self, sock):
        if self.interface:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, self.interface.encode() + b"\0")

    async def resolve(self, host):
        try:
            return [str(ipaddress.ip_address(host))]
        except ValueError:
            pass
        cached = self.cache.get(host)
        if cached and cached[0] > time.monotonic():
            return cached[1]
        loop = asyncio.get_running_loop()
        labels = host.rstrip(".").encode("idna").split(b".")
        if any(not x or len(x) > 63 for x in labels):
            raise OSError("Invalid DNS name")
        for resolver in ("1.1.1.1", "8.8.8.8"):
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                self.bind(sock)
                sock.setblocking(False)
                ident = secrets.randbelow(65536)
                name = b"".join(bytes([len(x)]) + x for x in labels) + b"\0"
                packet = struct.pack("!HHHHHH", ident, 0x100, 1, 0, 0, 0) + name + struct.pack("!HH", 1, 1)
                await loop.sock_connect(sock, (resolver, 53))
                await loop.sock_sendall(sock, packet)
                raw = await asyncio.wait_for(loop.sock_recv(sock, 65535), 2)
                addresses, ttl = self.parse(raw, ident)
                if addresses:
                    self.cache[host] = (time.monotonic() + max(5, min(ttl, 300)), addresses)
                    return addresses
            except (OSError, ValueError, IndexError, struct.error, asyncio.TimeoutError):
                pass
            finally:
                sock.close()
        raise OSError("Direct DNS resolution failed")

    @staticmethod
    def parse(raw, ident):
        tx, flags, questions, answers, _, _ = struct.unpack("!HHHHHH", raw[:12])
        if tx != ident or not flags & 0x8000 or flags & 0x020f:
            raise ValueError("Invalid DNS reply")
        def skip(offset):
            for _ in range(128):
                size = raw[offset]
                if size & 0xc0 == 0xc0:
                    return offset + 2
                offset += 1
                if size == 0:
                    return offset
                if size > 63:
                    raise ValueError("Invalid DNS label")
                offset += size
            raise ValueError("Invalid DNS name")
        offset = 12
        for _ in range(questions):
            offset = skip(offset) + 4
        addresses, ttl = [], 300
        for _ in range(answers):
            offset = skip(offset)
            kind, cls, expiry, size = struct.unpack("!HHIH", raw[offset:offset+10])
            offset += 10
            if kind == 1 and cls == 1 and size == 4:
                address = socket.inet_ntop(socket.AF_INET, raw[offset:offset+size])
                if ipaddress.ip_address(address) not in ipaddress.ip_network("198.18.0.0/15"):
                    addresses.append(address)
                    ttl = min(ttl, expiry)
            offset += size
        return list(dict.fromkeys(addresses)), ttl

    async def connect(self, node, host, port):
        addresses = await self.resolve(node["server"])
        last = None
        for address in addresses:
            sock = socket.socket(socket.AF_INET6 if ":" in address else socket.AF_INET, socket.SOCK_STREAM)
            try:
                self.bind(sock)
                sock.setblocking(False)
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                await asyncio.get_running_loop().sock_connect(sock, (address, node["port"]))
                reader, writer = await asyncio.open_connection(sock=sock)
                return SSStream(reader, writer, node, target_address(host, port))
            except asyncio.CancelledError:
                sock.close()
                raise
            except Exception as error:
                sock.close()
                last = error
        raise last or OSError("No server address")


class TLSStream:
    """Verified TLS over an encrypted SS stream, without a second listening socket."""
    def __init__(self, stream, host):
        self.stream = stream
        self.incoming, self.outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()
        self.tls = ssl.create_default_context().wrap_bio(self.incoming, self.outgoing, server_side=False, server_hostname=host)

    async def flush(self):
        while self.outgoing.pending:
            await self.stream.write(self.outgoing.read())

    async def feed(self):
        await self.flush()
        data = await self.stream.read()
        if not data:
            raise EOFError("TLS peer closed")
        self.incoming.write(data)

    async def handshake(self):
        while True:
            try:
                self.tls.do_handshake()
                await self.flush()
                return
            except ssl.SSLWantReadError:
                await self.feed()
            except ssl.SSLWantWriteError:
                await self.flush()

    async def write(self, data):
        offset = 0
        while offset < len(data):
            try:
                offset += self.tls.write(data[offset:])
                await self.flush()
            except ssl.SSLWantReadError:
                await self.feed()
            except ssl.SSLWantWriteError:
                await self.flush()

    async def read(self):
        while True:
            try:
                return self.tls.read(65536)
            except ssl.SSLWantReadError:
                await self.feed()
            except ssl.SSLWantWriteError:
                await self.flush()


def error_code(error):
    if isinstance(error, (asyncio.TimeoutError, TimeoutError)):
        return "timeout"
    if isinstance(error, InvalidTag):
        return "authentication_failed"
    if isinstance(error, ssl.SSLError):
        return "tls_failed"
    if isinstance(error, (EOFError, asyncio.IncompleteReadError)):
        return "connection_closed"
    if isinstance(error, OSError):
        return "network_error"
    return "probe_failed"


@dataclass
class Health:
    healthy: bool = False
    latency: float | None = None
    last_delay: int | None = None
    checked_at: float | None = None
    failures: int = 0
    successes: int = 0
    error: str | None = None
    target: str | None = None
    history: deque = field(default_factory=lambda: deque(maxlen=20))


class Engine:
    def __init__(self, store, interface="eth0", connector=None):
        self.store = store
        self.resolver = Resolver(interface)
        self.connector = connector or self.resolver.connect
        self.health = {}
        self.selected = None
        self.candidate = None
        self.candidate_rounds = 0
        self.switch_reason = "No healthy nodes yet"
        self.switched_at = None
        self.check_task = None
        self.check_again = False
        self.check_lock = asyncio.Lock()
        self.active = 0
        self.tx = self.rx = 0
        self.started = time.time()
        self.interface = interface

    def enabled(self):
        return [n for n in self.store.nodes if n["enabled"]]

    def pick(self):
        available = [n for n in self.enabled() if self.health.get(n["id"], Health()).healthy]
        available.sort(key=lambda n: self.health[n["id"]].latency if self.health[n["id"]].latency is not None else float("inf"))
        return available

    def select(self, evaluate_speed=True):
        available = self.pick()
        best = available[0]["id"] if available else None
        current = next((n for n in available if n["id"] == self.selected), None)
        reason = None
        if current is None:
            reason = "Current node unavailable" if self.selected else "Fastest healthy node"
        elif best != self.selected and evaluate_speed:
            old, new = self.health[self.selected].latency, self.health[best].latency
            improvement = max(30, old * self.store.settings["switch_margin"] / 100)
            if old - new >= improvement:
                self.candidate_rounds = self.candidate_rounds + 1 if self.candidate == best else 1
                self.candidate = best
                if self.candidate_rounds >= 2:
                    reason = "Faster node confirmed in two checks"
            else:
                self.candidate, self.candidate_rounds = None, 0
        elif best == self.selected:
            self.candidate, self.candidate_rounds = None, 0
        if reason and best != self.selected:
            self.selected, self.switch_reason, self.switched_at = best, reason, time.time()
            self.candidate, self.candidate_rounds = None, 0
        if best is None:
            self.selected = None
            self.switch_reason = "No healthy enabled nodes"

    async def probe_once(self, node, url):
        target = urlsplit(url)
        stream = None
        start = time.monotonic()
        try:
            stream = await self.connector(node, target.hostname, target.port or (443 if target.scheme == "https" else 80))
            channel = stream
            if target.scheme == "https":
                channel = TLSStream(stream, target.hostname)
                await channel.handshake()
            request = f"GET {target.path or '/'} HTTP/1.1\r\nHost: {target.hostname}\r\nUser-Agent: SS-Relay/{VERSION}\r\nConnection: close\r\n\r\n".encode()
            await channel.write(request)
            data = b""
            while b"\r\n\r\n" not in data:
                part = await channel.read()
                if not part or len(data) + len(part) > 32768:
                    raise EOFError("No valid HTTP response")
                data += part
            status = data.split(b"\r\n", 1)[0].split()
            if len(status) < 2 or status[0] not in (b"HTTP/1.0", b"HTTP/1.1") or status[1] not in (b"200", b"204"):
                raise ValueError("Unexpected HTTP status")
            return max(1, round((time.monotonic() - start) * 1000))
        finally:
            if stream:
                await stream.close()

    async def probe(self, node):
        last = None
        for url in PROBES:
            try:
                delay = await asyncio.wait_for(self.probe_once(node, url), self.store.settings["timeout"])
                return delay, None, url
            except asyncio.CancelledError:
                raise
            except Exception as error:
                last = error_code(error)
        return None, last, None

    async def check_all(self):
        async with self.check_lock:
            semaphore = asyncio.Semaphore(4)
            async def check(node):
                async with semaphore:
                    result = await self.probe(node)
                if not any(n["id"] == node["id"] and n["enabled"] for n in self.store.nodes):
                    return
                delay, error, url = result
                health = self.health.setdefault(node["id"], Health())
                health.checked_at, health.last_delay, health.error, health.target = time.time(), delay, error, url
                health.history.append({"time": health.checked_at, "delay": delay, "error": error})
                if delay is not None:
                    health.latency = delay if health.latency is None else round(health.latency * .6 + delay * .4, 1)
                    health.healthy, health.failures = True, 0
                    health.successes += 1
                else:
                    health.failures += 1
                    health.successes = 0
                    if health.failures >= self.store.settings["failure_threshold"]:
                        health.healthy = False
            await asyncio.gather(*(check(n.copy()) for n in self.enabled()))
            self.select()

    def trigger(self, queue=False):
        async def cycles():
            while True:
                self.check_again = False
                await self.check_all()
                if not self.check_again:
                    break
        if self.check_task is None or self.check_task.done():
            self.check_task = asyncio.create_task(cycles())
        elif queue:
            self.check_again = True
        return self.check_task

    async def periodic(self):
        while True:
            try:
                await self.trigger()
            except asyncio.CancelledError:
                raise
            except Exception:
                # No raw errors: crypto/URL exceptions may include secrets.
                pass
            await asyncio.sleep(self.store.settings["interval"])

    async def connect(self, host, port):
        if not self.pick():
            task = self.trigger()
            try:
                await asyncio.wait_for(asyncio.shield(task), self.store.settings["timeout"] * 2 + 2)
            except asyncio.TimeoutError:
                pass
        self.select(False)
        choices = self.pick()
        choices.sort(key=lambda n: n["id"] != self.selected)
        for node in choices[:3]:
            try:
                stream = await asyncio.wait_for(self.connector(node, host, port), self.store.settings["timeout"])
                return node["id"], stream
            except asyncio.CancelledError:
                raise
            except Exception:
                h = self.health[node["id"]]
                h.healthy, h.error = False, "connect_failed"
                h.failures = self.store.settings["failure_threshold"]
                self.select(False)
        raise OSError("No reachable healthy SS node")

    def state(self, socks_port):
        checking = bool(self.check_task and not self.check_task.done())
        nodes = []
        for node in self.store.nodes:
            h = self.health.get(node["id"], Health())
            public = {k: node[k] for k in ("id", "name", "server", "port", "cipher", "prefix_hex", "enabled")}
            public.update({"status": "disabled" if not node["enabled"] else "unknown" if h.checked_at is None else "degraded" if h.healthy and h.error else "healthy" if h.healthy else "unavailable",
                           "latency": h.latency, "last_delay": h.last_delay, "checked_at": h.checked_at,
                           "failures": h.failures, "error": h.error, "target": h.target,
                           "history": list(h.history), "selected": node["id"] == self.selected})
            nodes.append(public)
        return {"version": VERSION, "settings": dict(self.store.settings), "nodes": nodes,
                "checking": checking, "selected": self.selected, "switch_reason": self.switch_reason,
                "switched_at": self.switched_at, "active_connections": self.active, "tx_bytes": self.tx,
                "rx_bytes": self.rx, "uptime": round(time.time() - self.started), "interface": self.interface,
                "socks": {"host": "127.0.0.1", "port": socks_port, "udp": False}}
