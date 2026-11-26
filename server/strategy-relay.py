"""Authenticated fixed-destination TCP relay; only its upstream sockets are marked."""
import asyncio
import hmac
import ipaddress
import json
import os
import socket
import sys
import threading
import time
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("tcp_capture", Path(__file__).with_name("tcp-capture.py"))
_capture = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_capture)


def output(value):
    print(json.dumps(value), flush=True)


async def main(config):
    address = str(ipaddress.ip_address(config['address']))
    port, mark = config['port'], config['mark']
    interface = config['interface']
    if not isinstance(port, int) or not 1 <= port <= 65535 or mark != 0x20000008:
        raise ValueError('Invalid relay target')
    if not isinstance(interface, str) or not 1 <= len(interface) <= 15:
        raise ValueError('Invalid relay interface')
    records, tasks = [], set()
    stop = asyncio.Event()
    parent, deadline = os.getppid(), time.monotonic() + 35
    loop = asyncio.get_running_loop()

    async def client(reader, writer):
        upstream, capture, row = None, None, None
        try:
            if len(records) >= 32:
                return
            async with asyncio.timeout(5):
                version, count = await reader.readexactly(2)
                methods = await reader.readexactly(count)
                if version != 5 or 2 not in methods:
                    return
                writer.write(b'\x05\x02'); await writer.drain()
                if (await reader.readexactly(1)) != b'\x01':
                    return
                user = await reader.readexactly((await reader.readexactly(1))[0])
                password = await reader.readexactly((await reader.readexactly(1))[0])
                if not hmac.compare_digest(user, config['username'].encode()) or not hmac.compare_digest(password, config['password'].encode()):
                    return
                writer.write(b'\x01\x00'); await writer.drain()
                version, command, reserved, kind = await reader.readexactly(4)
                if (version, command, reserved) != (5, 1, 0):
                    return
                if kind == 1:
                    target = str(ipaddress.ip_address(await reader.readexactly(4)))
                elif kind == 4:
                    target = str(ipaddress.ip_address(await reader.readexactly(16)))
                elif kind == 3:
                    target = str(ipaddress.ip_address((await reader.readexactly((await reader.readexactly(1))[0])).decode()))
                else:
                    return
                target_port = int.from_bytes(await reader.readexactly(2), 'big')
                if target != address or target_port != port:
                    return
                row = {'state': 'connecting', 'sentBytes': 0, 'receivedBytes': 0, 'routeVerified': False}
                records.append(row)
                family = socket.AF_INET6 if ':' in address else socket.AF_INET
                sock = socket.socket(family, socket.SOCK_STREAM)
                try:
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, mark)
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, interface.encode() + b'\0')
                    sock.setblocking(False)
                    # Choose the routed source without sending a TCP packet.
                    route_socket = socket.socket(family, socket.SOCK_DGRAM)
                    try:
                        route_socket.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, mark)
                        route_socket.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, interface.encode() + b'\0')
                        route_socket.connect((address, port))
                        local = route_socket.getsockname()[0]
                    finally:
                        route_socket.close()
                    sock.bind((local, 0))
                    local_port = sock.getsockname()[1]
                    row['routeVerified'] = (sock.getsockopt(socket.SOL_SOCKET, socket.SO_MARK) == mark and sock.getsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, 32).rstrip(b'\0').decode() == interface)
                    if not row['routeVerified']:
                        raise PermissionError('Binding mismatch')
                    if config.get('capture') and len(records) <= 4:
                        try:
                            capture = _capture.TcpCapture(interface, local, local_port, address, port, max_packets=16)
                            row['_capture'] = capture
                        except (OSError, ValueError):
                            row['tcpCapture'] = {'state': 'unavailable', 'reason': 'capture-unavailable', 'probeCorrelated': False}
                    await loop.sock_connect(sock, (address, port))
                    if sock.getsockopt(socket.SOL_SOCKET, socket.SO_MARK) != mark or sock.getsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, 32).rstrip(b'\0').decode() != interface:
                        raise PermissionError('Binding mismatch')
                    up_reader, upstream = await asyncio.open_connection(sock=sock)
                    row.update(state='connected', routeVerified=True)
                except Exception:
                    sock.close(); row['state'] = 'failed'
                    raise
                writer.write(b'\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x00'); await writer.drain()
            async def copy(source, destination, counter):
                while True:
                    data = await source.read(65536)
                    if not data:
                        return
                    destination.write(data); await destination.drain()
                    row[counter] += len(data)
            sending = asyncio.create_task(copy(reader, upstream, 'sentBytes'))
            receiving = asyncio.create_task(copy(up_reader, writer, 'receivedBytes'))
            try:
                await asyncio.wait([sending, receiving], return_when=asyncio.FIRST_COMPLETED)
            finally:
                sending.cancel(); receiving.cancel()
                await asyncio.gather(sending, receiving, return_exceptions=True)
        except (Exception, asyncio.CancelledError):
            pass
        finally:
            if capture:
                row['tcpCapture'] = capture.finish()
                row['tcpCapture']['routeVerified'] = row['routeVerified']
                row.pop('_capture', None)
            writer.close()
            if upstream:
                upstream.close()

    def accepted(reader, writer):
        if len(tasks) >= 32:
            writer.close()
            return
        task = asyncio.create_task(client(reader, writer)); tasks.add(task)
        task.add_done_callback(tasks.discard)
    server = await asyncio.start_server(accepted, '127.0.0.1', 0)
    output({'ready': True, 'port': server.sockets[0].getsockname()[1]})
    def snapshot(request_id):
        values = []
        for record in records:
            value = {key: item for key, item in record.items() if key != '_capture'}
            if record.get('_capture'):
                value['tcpCapture'] = record['_capture'].snapshot()
                value['tcpCapture']['routeVerified'] = record['routeVerified']
            if value.get('tcpCapture'):
                value['tcpCapture']['scope'] = 'isolated-proxy-client-endpoint'
            values.append(value)
        output({'id': request_id, 'records': values})

    def commands():
        for line in sys.stdin:
            try:
                request = json.loads(line)
                loop.call_soon_threadsafe(snapshot, request['id'])
            except Exception:
                break
        loop.call_soon_threadsafe(stop.set)
    threading.Thread(target=commands, daemon=True).start()
    while not stop.is_set() and time.monotonic() < deadline and os.getppid() == parent:
        await asyncio.sleep(.1)
    server.close(); await server.wait_closed()
    for task in list(tasks):
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == '__main__':
    try:
        asyncio.run(main(json.loads(sys.stdin.readline())))
    except Exception:
        output({'ready': False})
