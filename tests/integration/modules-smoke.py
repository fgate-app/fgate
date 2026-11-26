#!/usr/bin/env python3
"""Loopback-only mihomo -> Xray SOCKS -> HTTP fixture; no VPN credentials."""
import contextlib
import argparse, http.server, json, pathlib, socket, subprocess, tempfile, threading, time

def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1',0))
        return listener.getsockname()[1]

def ready(port,process):
    for _ in range(100):
        if process.poll() is not None: raise RuntimeError('Module exited before readiness')
        try:
            with socket.create_connection(('127.0.0.1',port),timeout=.1): return
        except OSError: time.sleep(.1)
    raise TimeoutError('Local module listener unavailable')

class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        data=b'freedomgate-module-smoke'
        self.send_response(200)
        self.send_header('Content-Length',str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self,*args): pass

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--modules',required=True,type=pathlib.Path)
    args=parser.parse_args()
    mihomo=args.modules/'mihomo/v1.19.33/mihomo'
    xray=args.modules/'xray/v26.10.31/xray'
    adguard=args.modules/'adguard/v0.107.80/AdGuardHome'
    versions={}
    for name,binary,flags in [('mihomo',mihomo,['-v']),('xray',xray,['version']),('adguard',adguard,['--version'])]:
        versions[name]=subprocess.check_output([str(binary),*flags],text=True,timeout=10).strip().splitlines()[0]
    fixture=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture)
    thread=threading.Thread(target=fixture.serve_forever,daemon=True)
    thread.start()
    processes=[]
    directory=tempfile.TemporaryDirectory(prefix='fg-module-smoke-')
    try:
        with contextlib.nullcontext(directory.name) as folder:
            base=pathlib.Path(folder)
            proxy_port,xray_port=free_port(),free_port()
            xconfig={'log':{'loglevel':'error'},'inbounds':[{'listen':'127.0.0.1','port':xray_port,'protocol':'socks','settings':{'auth':'noauth','udp':True}}],'outbounds':[{'protocol':'freedom','tag':'fixture-direct'}]}
            mconfig={'mixed-port':proxy_port,'allow-lan':False,'bind-address':'127.0.0.1','mode':'rule','log-level':'error','ipv6':False,'tun':{'enable':False},'dns':{'enable':False},'proxies':[{'name':'local-xray','type':'socks5','server':'127.0.0.1','port':xray_port,'udp':True}],'rules':['MATCH,local-xray']}
            (base/'xray.json').write_text(json.dumps(xconfig))
            (base/'mihomo.json').write_text(json.dumps(mconfig))
            subprocess.run([str(xray),'run','-test','-config',str(base/'xray.json')],check=True,capture_output=True,timeout=15)
            subprocess.run([str(mihomo),'-t','-d',folder,'-f',str(base/'mihomo.json')],check=True,capture_output=True,timeout=15)
            with (base/'process.log').open('w') as logs:
                xp=subprocess.Popen([str(xray),'run','-config',str(base/'xray.json')],stdout=logs,stderr=logs)
                processes.append(xp)
                ready(xray_port,xp)
                mp=subprocess.Popen([str(mihomo),'-d',folder,'-f',str(base/'mihomo.json')],stdout=logs,stderr=logs)
                processes.append(mp)
                ready(proxy_port,mp)
                data=subprocess.check_output(['curl','--noproxy','','--fail','--silent','--show-error','--max-time','10','--proxy',f'http://127.0.0.1:{proxy_port}',f'http://127.0.0.1:{fixture.server_port}/fixture'],timeout=15)
                assert data==b'freedomgate-module-smoke', 'Unexpected proxy-chain response'
            print(json.dumps({'versions':versions,'configuration_validation':'passed','mihomo_to_xray_to_fixture':'passed','tun_enabled':False,'external_vpn_tested':False}))
    finally:
        for process in reversed(processes):
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill();process.wait()
        fixture.shutdown();fixture.server_close();directory.cleanup()

if __name__=='__main__': main()
