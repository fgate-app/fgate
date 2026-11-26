"""Fixed-destination UDP connectivity probe for the privileged network helper."""
import json
import secrets
import socket
import struct
import sys
import time


def probe(interface):
    query_id = secrets.randbits(16)
    question = b'\x07example\x03com\x00\x00\x01\x00\x01'
    query = struct.pack('!6H', query_id, 0x0100, 1, 0, 0, 0) + question
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        # Follow exactly the marked outbound used by the zapret gateway.  There
        # is no unmarked fallback if setting the mark or interface fails.
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, 0x10000000)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, interface.encode() + b'\0')
        sock.settimeout(2.5)
        sock.connect(('1.1.1.1', 53))
        start = time.monotonic()
        sock.send(query)
        response = sock.recv(4096)
        if (len(response) < len(query) or response[:2] != query[:2]
                or not response[2] & 0x80 or response[3] & 0x0F
                or response[4:6] != b'\0\1' or response[12:len(query)] != question):
            return {'status': 'error', 'delay': None}
        return {'status': 'ok', 'delay': max(1, round((time.monotonic() - start) * 1000))}


if __name__ == '__main__':
    try:
        result = probe(sys.argv[1])
    except TimeoutError:
        result = {'status': 'timeout', 'delay': None}
    except (OSError, IndexError):
        result = {'status': 'error', 'delay': None}
    print(json.dumps(result))
