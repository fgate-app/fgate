#!/usr/bin/env python3
"""One local SOCKS5 endpoint, a private SS pool and a same-origin management UI."""
import argparse
import asyncio
import contextlib
import copy
import ipaddress
import json
import mimetypes
import os
from pathlib import Path
import signal
import socket
import struct
from urllib.parse import unquote, urlsplit

from core import Engine, InputError, Store, VERSION


async def read_destination(reader):
    kind = (await reader.readexactly(1))[0]
    if kind == 1:
        host = socket.inet_ntop(socket.AF_INET, await reader.readexactly(4))
    elif kind == 4:
        host = socket.inet_ntop(socket.AF_INET6, await reader.readexactly(16))
    elif kind == 3:
        size = (await reader.readexactly(1))[0]
        if not size:
            raise ValueError("Empty destination")
        host = (await reader.readexactly(size)).decode("ascii")
    else:
        raise ValueError("Unsupported address type")
    port = struct.unpack("!H", await reader.readexactly(2))[0]
    if not port:
        raise ValueError("Empty destination port")
    return host, port


class Application:
    def __init__(self, store, interface="eth0", socks_port=10880, origins=(), web=None):
        self.engine = Engine(store, interface)
        self.store, self.socks_port = store, socks_port
        self.origins = set(origins)
        self.hosts = {urlsplit(origin).netloc for origin in origins}
        self.web = Path(web or Path(__file__).parent / "dist").resolve()
        self.clients = set()

    async def socks(self, reader, writer):
        task = asyncio.current_task()
        self.clients.add(task)
        stream = None
        active = False
        greeted = replied = False
        try:
            if self.engine.active >= 256:
                return
            async with asyncio.timeout(12):
                version, count = await reader.readexactly(2)
                if version != 5 or not count:
                    return
                methods = await reader.readexactly(count)
                if 0 not in methods:
                    writer.write(b"\x05\xff")
                    await writer.drain()
                    return
                writer.write(b"\x05\x00")
                await writer.drain()
                greeted = True
                version, command, reserved = await reader.readexactly(3)
                if version != 5 or reserved != 0:
                    return
                if command != 1:
                    writer.write(b"\x05\x07\x00\x01" + bytes(6))
                    await writer.drain()
                    replied = True
                    return
                host, port = await read_destination(reader)
            _, stream = await self.engine.connect(host, port)
            await stream.write(b"")
            writer.write(b"\x05\x00\x00\x01" + bytes(6))
            await writer.drain()
            replied = True
            self.engine.active += 1
            active = True

            async def upload():
                while data := await reader.read(65536):
                    await stream.write(data)
                    self.engine.tx += len(data)
                if stream.writer.can_write_eof():
                    stream.writer.write_eof()
                    await stream.writer.drain()

            async def download():
                while data := await stream.read():
                    writer.write(data)
                    await writer.drain()
                    self.engine.rx += len(data)
                if writer.can_write_eof():
                    writer.write_eof()
                    await writer.drain()

            up, down = asyncio.create_task(upload()), asyncio.create_task(download())
            try:
                done, pending = await asyncio.wait((up, down), return_when=asyncio.FIRST_COMPLETED)
                for job in done:
                    job.result()
                # Allow response data after a client TCP half-close.
                if up in done and down not in done:
                    await asyncio.wait_for(down, 60)
            finally:
                for job in (up, down):
                    if not job.done():
                        job.cancel()
                await asyncio.gather(up, down, return_exceptions=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            if greeted and not replied:
                with contextlib.suppress(Exception):
                    writer.write(b"\x05\x01\x00\x01" + bytes(6))
                    await writer.drain()
        finally:
            if active:
                self.engine.active -= 1
            if stream:
                await stream.close()
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()
            self.clients.discard(task)

    def mutate(self, action):
        nodes, settings = copy.deepcopy(self.store.nodes), dict(self.store.settings)
        try:
            result = action()
            self.store.save()
            return result
        except Exception:
            self.store.nodes, self.store.settings = nodes, settings
            raise

    async def route(self, method, path, body):
        if path == "/api/state" and method == "GET":
            return 200, self.engine.state(self.socks_port)
        if path == "/api/import" and method == "POST":
            result = self.store.import_text(body.get("text"))
            if result["added"]:
                self.engine.trigger(queue=True)
            return 200, result
        if path == "/api/check" and method == "POST":
            self.engine.trigger()
            return 202, {"checking": True}
        if path == "/api/settings" and method == "PUT":
            self.store.validate_settings(body)
            self.mutate(lambda: setattr(self.store, "settings", dict(body)))
            self.engine.select(False)
            return 200, {"settings": self.store.settings}
        if path.startswith("/api/nodes/") and method in ("PATCH", "DELETE"):
            ident = path.removeprefix("/api/nodes/")
            node = next((n for n in self.store.nodes if n["id"] == ident), None)
            if not node:
                return 404, {"error": "Node not found."}
            if method == "DELETE":
                self.mutate(lambda: self.store.nodes.remove(node))
                self.engine.health.pop(ident, None)
            else:
                if not body or set(body) - {"name", "enabled"}:
                    raise InputError("Only name and enabled can be changed.")
                if "name" in body and (not isinstance(body["name"], str) or not body["name"].strip() or len(body["name"]) > 150 or any(ord(c) < 32 for c in body["name"])):
                    raise InputError("Invalid node name.")
                if "enabled" in body and type(body["enabled"]) is not bool:
                    raise InputError("enabled must be a boolean.")
                self.mutate(lambda: node.update(body))
                if body.get("enabled"):
                    # A re-enabled node must pass a fresh check.
                    self.engine.health.pop(ident, None)
                    self.engine.trigger(queue=True)
            self.engine.select(False)
            return 200, {"ok": True}
        return 404, {"error": "Unknown endpoint."}

    async def http(self, reader, writer):
        task = asyncio.current_task()
        self.clients.add(task)
        try:
            async with asyncio.timeout(15):
                raw = await reader.readuntil(b"\r\n\r\n")
                if len(raw) > 16384:
                    return await self.reply(writer, 431, {"error": "Headers too large."})
                lines = raw.decode("iso-8859-1").split("\r\n")
                method, target, version = lines[0].split(" ")
                if version not in ("HTTP/1.0", "HTTP/1.1"):
                    raise InputError("Unsupported HTTP version.")
                headers = {}
                for line in lines[1:]:
                    if not line:
                        continue
                    key, _, value = line.partition(":")
                    key = key.lower()
                    if not _ or key in headers:
                        raise InputError("Invalid or repeated header.")
                    headers[key] = value.strip()
                host, origin = headers.get("host"), headers.get("origin")
                if host not in self.hosts or (origin and origin not in self.origins):
                    return await self.reply(writer, 403, {"error": "Untrusted host or origin."})
                if headers.get("sec-fetch-site") in ("cross-site", "same-site"):
                    return await self.reply(writer, 403, {"error": "Same-origin request required."})
                if method not in ("GET", "HEAD") and origin not in self.origins:
                    return await self.reply(writer, 403, {"error": "Same-origin request required."})
                if headers.get("transfer-encoding"):
                    raise InputError("Transfer-Encoding is unsupported.")
                length = int(headers.get("content-length", "0"))
                if not 0 <= length <= 262144:
                    return await self.reply(writer, 413, {"error": "Request too large."})
                body = {}
                if method not in ("GET", "HEAD"):
                    if headers.get("content-type", "").split(";")[0] != "application/json":
                        return await self.reply(writer, 415, {"error": "Expected application/json."})
                    try:
                        body = json.loads(await reader.readexactly(length))
                    except (ValueError, UnicodeError):
                        raise InputError("Invalid JSON body.") from None
                    if not isinstance(body, dict):
                        raise InputError("Expected a JSON object.")
                path = urlsplit(target).path
                if path.startswith("/ss-adapter/"):
                    path = path[len("/ss-adapter"): ]
                if path.startswith("/api/"):
                    code, result = await self.route(method, path, body)
                    return await self.reply(writer, code, result)
                if method not in ("GET", "HEAD"):
                    return await self.reply(writer, 405, {"error": "Method not allowed."})
                relative = unquote(path).lstrip("/") or "index.html"
                asset = (self.web / relative).resolve()
                if not asset.is_relative_to(self.web) or not asset.is_file() or asset.stat().st_size > 2 * 1024 * 1024:
                    return await self.reply(writer, 404, {"error": "File not found."})
                return await self.reply(writer, 200, asset.read_bytes(), mimetypes.guess_type(asset.name)[0] or "application/octet-stream", method == "HEAD")
        except asyncio.CancelledError:
            raise
        except InputError as error:
            with contextlib.suppress(Exception):
                await self.reply(writer, 400, {"error": str(error)})
        except ValueError:
            with contextlib.suppress(Exception):
                await self.reply(writer, 400, {"error": "Invalid request."})
        except (asyncio.LimitOverrunError, asyncio.IncompleteReadError, TimeoutError, ConnectionError):
            pass
        except Exception:
            with contextlib.suppress(Exception):
                await self.reply(writer, 500, {"error": "Operation failed. Reload the page before retrying."})
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()
            self.clients.discard(task)

    @staticmethod
    async def reply(writer, code, data, content_type="application/json; charset=utf-8", head=False):
        payload = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False).encode()
        titles = {200: "OK", 202: "Accepted", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 413: "Content Too Large", 415: "Unsupported Media Type", 431: "Headers Too Large", 500: "Internal Server Error"}
        headers = {"Content-Type": content_type, "Content-Length": str(len(payload)), "Connection": "close", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"}
        writer.write((f"HTTP/1.1 {code} {titles.get(code, 'Error')}\r\n" + "".join(k + ": " + v + "\r\n" for k, v in headers.items()) + "\r\n").encode("ascii"))
        if not head:
            writer.write(payload)
        await writer.drain()


async def run(args):
    os.umask(0o077)
    store = Store(args.data)
    origins = args.origin or ["http://127.0.0.1:" + str(args.http_port)]
    app = Application(store, args.interface, args.socks_port, origins)
    socks = await asyncio.start_server(app.socks, "127.0.0.1", args.socks_port, limit=65536)
    http = await asyncio.start_server(app.http, "127.0.0.1", args.http_port, limit=16384)
    periodic = asyncio.create_task(app.engine.periodic())
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)
    print(f"SS Relay {VERSION} ready; SOCKS5 127.0.0.1:{args.socks_port}; UI/API 127.0.0.1:{args.http_port}", flush=True)
    try:
        await stop.wait()
    finally:
        socks.close()
        http.close()
        periodic.cancel()
        if app.engine.check_task:
            app.engine.check_task.cancel()
        for task in list(app.clients):
            task.cancel()
        await asyncio.gather(periodic, *(list(app.clients)), *([app.engine.check_task] if app.engine.check_task else []), return_exceptions=True)
        # Python 3.13 waits for accepted connections too: close clients first.
        await socks.wait_closed()
        await http.wait_closed()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", default="/var/lib/ss-prefix-adapter")
    parser.add_argument("--interface", default="eth0")
    parser.add_argument("--socks-port", type=int, default=10880)
    parser.add_argument("--http-port", type=int, default=9781)
    parser.add_argument("--origin", action="append")
    args = parser.parse_args()
    for port in (args.socks_port, args.http_port):
        if not 1024 <= port <= 65535:
            parser.error("Ports must be in 1024..65535.")
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
