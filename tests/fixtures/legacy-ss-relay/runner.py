"""FreedomGate entry point; upstream SS Relay transport stays unchanged."""
import asyncio
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).parent / 'vendor'))
from core import parse_ss, InputError, Resolver
from service import Application
from udp import socks_handler

async def serve(config):
    node = config['node']
    app = Application(type('Config', (), {'nodes': [node], 'settings': {'timeout': 8}})(), interface='')
    resolver = Resolver('')
    async def connect(host, port):
        return node, await asyncio.wait_for(resolver.connect(node, host, port), 10)
    app.engine.connect = connect
    server = await asyncio.start_server(socks_handler(app, node), '127.0.0.1', config['port'])
    async with server:
        await server.serve_forever()

try:
    if sys.argv[1] == '--parse':
        print(json.dumps(parse_ss(sys.stdin.read())))
    else:
        asyncio.run(serve(json.loads(Path(sys.argv[1]).read_text())))
except Exception:
    # Never echo imported credentials or raw parser exceptions.
    print('SS Relay: invalid configuration or unavailable transport.', file=sys.stderr)
    sys.exit(1)
