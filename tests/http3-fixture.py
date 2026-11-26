"""Test-only HTTP/3 origin, used inside an isolated network namespace."""
import asyncio, sys
from aioquic.asyncio import QuicConnectionProtocol, serve
from aioquic.h3.connection import H3_ALPN, H3Connection
from aioquic.h3.events import HeadersReceived
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.events import ProtocolNegotiated
class Protocol(QuicConnectionProtocol):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs);self.http=None
    def quic_event_received(self,event):
        if isinstance(event,ProtocolNegotiated):self.http=H3Connection(self._quic)
        if self.http:
            for item in self.http.handle_event(event):
                if isinstance(item,HeadersReceived):
                    self.http.send_headers(stream_id=item.stream_id,headers=[(b':status',b'200'),(b'content-length',b'0')],end_stream=True);self.transmit()
async def main():
    config=QuicConfiguration(is_client=False,alpn_protocols=H3_ALPN);config.load_cert_chain(sys.argv[1],sys.argv[2])
    server=await serve('0.0.0.0',443,configuration=config,create_protocol=Protocol)
    print('ready',flush=True)
    try:await asyncio.Future()
    finally:server.close()
asyncio.run(main())
