import asyncio
import base64
import copy
import json
import os
from pathlib import Path
import socket
import struct
import sys
import tempfile
import unittest
from urllib.parse import quote
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests/fixtures/legacy-ss-relay/vendor"))
from core import Engine, Health, InputError, Resolver, SSStream, Store, parse_links, parse_ss, target_address
from service import Application


def link(host="127.0.0.1", port=12345, prefix="\x16\x03\x01\x00\xa8\x01\x01", name="Test node", password="test-only-password"):
    user = base64.urlsafe_b64encode(("chacha20-ietf-poly1305:" + password).encode()).decode()
    return f"ss://{user}@{host}:{port}/?outline=1&prefix={quote(prefix)}#{quote(name)}"


class ParsingTests(unittest.TestCase):
    def test_outline_prefix_is_bytes_not_utf8(self):
        node = parse_ss(link())
        self.assertEqual(node["prefix_hex"], "16030100a80101")
        self.assertEqual(node["password"], "test-only-password")
        self.assertEqual(node["name"], "Test node")
        self.assertEqual(parse_ss(link(prefix=""))["prefix_hex"], "")

    def test_subscription_partial_errors_and_no_secret_echo(self):
        text = link(name="Тест 🇳🇱") + "\nss://not-a-real-key#secret-marker"
        encoded = base64.b64encode(text.encode()).decode()
        nodes, errors = parse_links(encoded)
        self.assertEqual(nodes[0]["name"], "Тест 🇳🇱")
        self.assertEqual(len(errors), 1)
        self.assertNotIn("secret-marker", json.dumps(errors))
        self.assertNotIn("not-a-real-key", json.dumps(errors))

    def test_double_encoded_prefix_and_deduplication(self):
        original = link()
        doubled = original.replace('%', '%25')
        self.assertEqual(parse_ss(doubled)['prefix_hex'], '16030100a80101')
        with tempfile.TemporaryDirectory() as tmp:
            result = Store(tmp).import_text(original + '\n' + doubled)
            self.assertEqual((result['added'],result['skipped']),(1,1))
        # A plus sign is a literal byte after decoding, not query whitespace.
        self.assertEqual(parse_ss(link(prefix='%2B'))['prefix_hex'],'2b')
        self.assertEqual(parse_ss(link(prefix='GET %foo'))['prefix_hex'],b'GET %foo'.hex())

    def test_entropy_limits_and_unsupported_plugins(self):
        for uri in [link(prefix="x" * 17), link(prefix="☃"), link() + "&plugin=obfs", "vless://secret"]:
            # The plugin must be in the query, not in the display-name fragment.
            if "&plugin=" in uri:
                uri = uri.split("#")[0] + "&plugin=obfs#test"
            with self.assertRaises(InputError):
                parse_ss(uri)
        user = base64.b64encode(b"aes-128-gcm:test").decode()
        with self.assertRaises(InputError):
            parse_ss(f"ss://{user}@example.com:443/?prefix=POST%20")

    def test_ipv6_and_legacy_urls(self):
        uri = "ss://" + base64.b64encode(b"chacha20-ietf-poly1305:test@[::1]:1234").decode() + "#IPv6"
        node = parse_ss(uri)
        self.assertEqual((node["server"], node["port"]), ("::1", 1234))
        self.assertEqual(target_address("::1", 80)[0], 4)

    def test_store_deduplicates_and_keeps_private_backups(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(tmp)
            result = store.import_text(link() + "\n" + link(name="Duplicate"))
            self.assertEqual((result["added"], result["skipped"]), (1, 1))
            store.import_text(link(port=23456))
            self.assertEqual(len(Store(tmp).nodes), 2)
            self.assertEqual(store.path.stat().st_mode & 0o777, 0o600)
            backups = list(store.backups.iterdir())
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)

    def test_dns_parser_filters_fake_ip(self):
        query = b"\x01a\x00\x00\x01\x00\x01"
        def answer(ip):
            return b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 60, 4) + socket.inet_aton(ip)
        packet = struct.pack("!HHHHHH", 42, 0x8180, 1, 2, 0, 0) + query + answer("198.18.0.11") + answer("192.0.2.4")
        addresses, _ = Resolver.parse(packet, 42)
        self.assertEqual(addresses, ["192.0.2.4"])
        with self.assertRaises(ValueError):
            Resolver.parse(packet, 43)


class AsyncTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(self.temp.name)
        self.servers = []
        self.tasks = set()
        self.salts = []
        self.node = parse_ss(link())
        self.store.nodes = [self.node]

    async def asyncTearDown(self):
        for server in self.servers:
            server.close()
            await server.wait_closed()
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*list(self.tasks), return_exceptions=True)
        self.temp.cleanup()

    async def mock_ss(self, echo_size=None):
        async def handle(reader, writer):
            task = asyncio.current_task()
            self.tasks.add(task)
            stream = SSStream(reader, writer, {**self.node, "prefix_hex": ""})
            try:
                salt = await reader.readexactly(stream.salt_size)
                self.salts.append(salt)
                stream.decryptor = stream.cipher(salt)
                initial = await stream.read()
                if initial[0] == 3:
                    address_len = 2 + initial[1] + 2
                elif initial[0] == 1:
                    address_len = 7
                else:
                    address_len = 19
                payload = initial[address_len:]
                if echo_size:
                    while len(payload) < echo_size:
                        payload += await stream.read()
                    await stream.write(payload)
                else:
                    while b"\r\n\r\n" not in payload:
                        payload += await stream.read()
                    await stream.write(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
            except (Exception, asyncio.CancelledError):
                pass
            finally:
                await stream.close()
                self.tasks.discard(task)
        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        self.servers.append(server)
        self.node["port"] = server.sockets[0].getsockname()[1]
        return self.node["port"]

    async def test_aead_large_stream_and_prefix(self):
        size = 80000
        await self.mock_ss(size)
        stream = await Resolver("").connect(self.node, "example.com", 80)
        try:
            payload = os.urandom(size)
            await stream.write(payload)
            response = b""
            async with asyncio.timeout(3):
                while len(response) < size:
                    response += await stream.read()
            self.assertEqual(response, payload)
            self.assertTrue(self.salts[0].startswith(bytes.fromhex(self.node["prefix_hex"])))
        finally:
            await stream.close()

    async def test_aes_gcm_ciphers(self):
        for cipher in ('aes-256-gcm', 'aes-128-gcm'):
            self.node['cipher'] = cipher
            self.node['prefix_hex'] = '' if cipher == 'aes-128-gcm' else '504f535420'
            await self.mock_ss()
            engine = Engine(self.store, '')
            self.assertGreater(await engine.probe_once(self.node, 'http://probe.example/'), 0)

    async def test_import_during_check_gets_queued_cycle(self):
        engine = Engine(self.store, '')
        started, release = asyncio.Event(), asyncio.Event()
        async def probe(node):
            started.set()
            await release.wait()
            return 20, None, 'test'
        engine.probe = probe
        task = engine.trigger()
        await started.wait()
        added = {**self.node, 'id': 'added-during-check'}
        self.store.nodes.append(added)
        engine.trigger(queue=True)
        release.set()
        await task
        self.assertTrue(engine.health[added['id']].healthy)

    async def test_http_probe_authenticates_server_response(self):
        await self.mock_ss()
        engine = Engine(self.store, "")
        delay = await engine.probe_once(self.node, "http://probe.example/generate_204")
        self.assertGreater(delay, 0)
        wrong = {**self.node, "password": "wrong-key"}
        with self.assertRaises((EOFError, asyncio.IncompleteReadError, TimeoutError)):
            await asyncio.wait_for(engine.probe_once(wrong, "http://probe.example/"), 1)

    async def test_one_socks_endpoint_relays_through_ss(self):
        await self.mock_ss()
        app = Application(self.store, "")
        app.engine.health[self.node["id"]] = Health(healthy=True, latency=10, checked_at=1)
        app.engine.select()
        server = await asyncio.start_server(app.socks, "127.0.0.1", 0)
        self.servers.append(server)
        reader, writer = await asyncio.open_connection("127.0.0.1", server.sockets[0].getsockname()[1])
        try:
            writer.write(b"\x05\x01\x00")
            await writer.drain()
            self.assertEqual(await reader.readexactly(2), b"\x05\x00")
            writer.write(b"\x05\x01\x00" + target_address("example.com", 80))
            await writer.drain()
            self.assertEqual((await reader.readexactly(10))[1], 0)
            writer.write(b"GET / HTTP/1.1\r\nHost: example.com\r\n\r\n")
            await writer.drain()
            response = await asyncio.wait_for(reader.read(), 3)
            self.assertIn(b"204 No Content", response)
            self.assertGreater(app.engine.tx, 0)
            self.assertGreater(app.engine.rx, 0)
        finally:
            writer.close()
            await writer.wait_closed()
            for task in list(app.clients):
                task.cancel()
            await asyncio.gather(*list(app.clients), return_exceptions=True)

    async def test_udp_associate_is_explicitly_rejected(self):
        app = Application(self.store, "")
        server = await asyncio.start_server(app.socks, "127.0.0.1", 0)
        self.servers.append(server)
        reader, writer = await asyncio.open_connection("127.0.0.1", server.sockets[0].getsockname()[1])
        writer.write(b"\x05\x01\x00\x05\x03\x00" + target_address("0.0.0.0", 0))
        await writer.drain()
        self.assertEqual(await reader.readexactly(2), b"\x05\x00")
        self.assertEqual((await reader.readexactly(10))[1], 7)
        writer.close()
        await writer.wait_closed()

    async def test_speed_hysteresis_and_dead_current_failover(self):
        second = {**self.node, "id": "second", "name": "Second"}
        self.store.nodes.append(second)
        engine = Engine(self.store, "")
        engine.health = {self.node["id"]: Health(healthy=True, latency=100), "second": Health(healthy=True, latency=150)}
        engine.select()
        self.assertEqual(engine.selected, self.node["id"])
        engine.health["second"].latency = 40
        engine.select()
        self.assertEqual(engine.selected, self.node["id"])
        engine.select()
        self.assertEqual(engine.selected, "second")
        engine.health["second"].healthy = False
        engine.select()
        self.assertEqual(engine.selected, self.node["id"])

    async def test_unreachable_selected_retries_another_healthy_node(self):
        second = {**self.node, "id": "second", "name": "Second"}
        self.store.nodes.append(second)
        marker = object()
        async def connector(node, host, port):
            if node["id"] == self.node["id"]:
                raise OSError("unreachable")
            return marker
        engine = Engine(self.store, "", connector)
        engine.health = {self.node["id"]: Health(healthy=True, latency=10), "second": Health(healthy=True, latency=20)}
        engine.select()
        ident, stream = await engine.connect("example.com", 80)
        self.assertEqual(ident, "second")
        self.assertIs(stream, marker)
        self.assertEqual(engine.selected, "second")

    async def test_consecutive_failures_then_recovery(self):
        engine = Engine(self.store, "")
        async def ok(node):
            return 25, None, "test"
        engine.probe = ok
        await engine.check_all()
        self.assertEqual(engine.selected, self.node["id"])
        async def fail(node):
            return None, "timeout", None
        engine.probe = fail
        await engine.check_all()
        self.assertTrue(engine.health[self.node["id"]].healthy)
        await engine.check_all()
        self.assertIsNone(engine.selected)
        engine.probe = ok
        await engine.check_all()
        self.assertEqual(engine.selected, self.node["id"])

    async def test_api_omits_secrets_and_enforces_origin(self):
        app = Application(self.store, "", origins=["http://test.local"])
        server = await asyncio.start_server(app.http, "127.0.0.1", 0)
        self.servers.append(server)
        async def request(method, path, body=None, origin="http://test.local", host="test.local"):
            reader, writer = await asyncio.open_connection("127.0.0.1", server.sockets[0].getsockname()[1])
            payload = json.dumps(body).encode() if body is not None else b""
            writer.write((f"{method} {path} HTTP/1.1\r\nHost: {host}\r\nOrigin: {origin}\r\nContent-Type: application/json\r\nContent-Length: {len(payload)}\r\n\r\n").encode() + payload)
            await writer.drain()
            response = await reader.read()
            writer.close()
            await writer.wait_closed()
            head, data = response.split(b"\r\n\r\n", 1)
            return int(head.split()[1]), json.loads(data)
        status, state = await request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertNotIn(self.node["password"], json.dumps(state))
        self.assertNotIn('"password"', json.dumps(state))
        self.assertEqual((await request("GET", "/api/state", host="evil.local"))[0], 403)
        self.assertEqual((await request("POST", "/api/check", {}, origin=""))[0], 403)
        self.assertEqual((await request("POST", "/api/check", {}, origin="http://evil.local"))[0], 403)
        self.assertEqual((await request("PATCH", "/api/nodes/" + self.node["id"], {"enabled": False}))[0], 200)
        self.assertFalse(self.store.nodes[0]["enabled"])
        self.assertEqual((await request("PUT", "/api/settings", {"timeout": 0}))[0], 400)
        self.assertEqual((await request("DELETE", "/api/nodes/" + self.node["id"], {}))[0], 200)
        self.assertEqual(self.store.nodes, [])


if __name__ == "__main__":
    unittest.main()
