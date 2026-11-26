"""HTTP/3-only over a fixed authenticated SOCKS UDP association; no TCP fallback."""
import ctypes, importlib.util, json, os, select, signal, socket, subprocess, sys, time
spec=importlib.util.spec_from_file_location('transport',os.path.join(os.path.dirname(__file__),'dns-matrix.py'))
transport=importlib.util.module_from_spec(spec);spec.loader.exec_module(transport)

def child_guard(parent):
    # A cancelled worker must not leave curl running.
    ctypes.CDLL(None).prctl(1,signal.SIGKILL)
    if os.getppid()!=parent:os._exit(1)

def attempt(request):
    name=transport.domain_name(request['name']);address=request['address'];started=time.monotonic()
    row={'name':name,'address':address,'port':443,'state':'unavailable','protocol':'HTTP/3','tcpFallback':False,'sentBytes':0,'receivedBytes':0}
    proxy=None;relay=None;child=None
    try:
        version=subprocess.run(['curl','--disable','--version'],capture_output=True,text=True,timeout=1)
        if not any(line.startswith('Features:') and 'HTTP3' in line.split() for line in version.stdout.splitlines()):
            row['reason']='http3-tool-unavailable';return row
        proxy=transport.ProxyUdpSocket(request['proxy'],address,443,started+3)
        row.update(localAddress=proxy.getsockname()[0],localPort=proxy.getsockname()[1])
        relay=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);relay.bind(('127.0.0.1',0))
        args=['curl','--disable','--config','-','--http3-only','--proxy','','--noproxy','*','--connect-to',name+':443:127.0.0.1:'+str(relay.getsockname()[1]),'--connect-timeout','3','--max-time','4','--max-filesize','65536','--head','--output','/dev/null','--write-out','%{json}']
        parent=os.getpid()
        child=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,preexec_fn=lambda:child_guard(parent))
        child.stdin.write(('url = "https://'+name+'/"\n').encode());child.stdin.close()
        peer=None;packets=0
        while child.poll() is None and time.monotonic()-started<7 and packets<128 and row['sentBytes']+row['receivedBytes']<2097152:
            ready,_,_=select.select([relay,proxy.udp],[],[],.025)
            for sock in ready:
                if sock is relay:
                    data,source=relay.recvfrom(65536)
                    if peer is None:peer=source
                    if source!=peer:continue
                    proxy.send(data);row['sentBytes']+=len(data)
                else:
                    data=proxy.recv(65536)
                    if peer:relay.sendto(data,peer);row['receivedBytes']+=len(data)
                packets+=1
        if child.poll() is None:child.kill();row['reason']='budget-exhausted'
        child.wait(timeout=1);output=child.stdout.read(65537)
        result=json.loads(output) if len(output)<=65536 else {}
        row.update(httpVersion=str(result.get('http_version','')),httpStatus=result.get('http_code',0),certificateVerified=result.get('ssl_verify_result')==0,durationMs=round((time.monotonic()-started)*1000))
        if child.returncode==0 and row['httpVersion']=='3' and row['certificateVerified'] and row['httpStatus']>=100 and row['receivedBytes']>0:
            row['state']='ok';row.pop('reason',None)
        else:row.setdefault('reason','certificate-error' if result.get('exitcode')==60 else 'http3-unconfirmed')
        # Leave the flow observable while the parent correlates the UDP tuple.
        time.sleep(.15)
    except transport.GatewayUdpUnavailable:row['reason']='gateway-udp-unavailable'
    except (OSError,ValueError,subprocess.SubprocessError):row.setdefault('reason','http3-probe-unavailable')
    finally:
        if child is not None:
            if child.poll() is None:child.kill()
            child.wait();child.stdout.close()
        if relay is not None:relay.close()
        if proxy is not None:proxy.close()
    return row

if __name__=='__main__':
    try:print(json.dumps(attempt(json.load(sys.stdin))))
    except Exception:print(json.dumps({'state':'unavailable','reason':'http3-probe-unavailable'}))
