"""Strict TLS version comparison through one authenticated fixed-peer listener."""
import importlib.util, json, os, ssl, sys, time
spec=importlib.util.spec_from_file_location('transport',os.path.join(os.path.dirname(__file__),'dns-matrix.py'))
transport=importlib.util.module_from_spec(spec);spec.loader.exec_module(transport)

def attempt(request):
    version=request['version'];address=request['address'];name=transport.domain_name(request['name'])
    row={'version':version,'address':address,'servername':name,'port':443,'certificateVerification':True,'state':'unavailable'}
    sock=None;stage='prepare';started=time.monotonic()
    try:
        if version not in ('1.2','1.3'):raise ValueError('Invalid TLS version.')
        selected=ssl.TLSVersion.TLSv1_2 if version=='1.2' else ssl.TLSVersion.TLSv1_3
        context=ssl.create_default_context();context.minimum_version=selected;context.maximum_version=selected;context.set_alpn_protocols(['http/1.1'])
        stage='proxy-connect';sock=transport.proxy_socket(request['proxy'],address,443,started+7)
        row.update(localAddress=sock.getsockname()[0],localPort=sock.getsockname()[1])
        stage='tls';sock=context.wrap_socket(sock,server_hostname=name);row['negotiatedVersion']=sock.version()
        if row['negotiatedVersion']!='TLSv'+version:raise ValueError('Unexpected TLS version.')
        stage='http';sock.sendall(('HEAD / HTTP/1.1\r\nHost: '+name+'\r\nConnection: close\r\n\r\n').encode())
        data=sock.recv(4096);first=data.split(b'\r\n',1)[0].split()
        if len(first)<2 or not first[0].startswith(b'HTTP/') or not first[1].isdigit():raise ValueError('Invalid HTTP response.')
        row.update(state='ok',httpStatus=int(first[1]))
    except (OSError,ValueError,AttributeError) as error:
        row.update(state='unavailable' if stage=='prepare' else 'failed',failedStage=stage,reason='tls-version-unavailable' if stage=='prepare' else 'certificate-error' if isinstance(error,ssl.SSLCertVerificationError) else 'timeout' if isinstance(error,TimeoutError) else 'tls-error' if stage=='tls' else 'invalid-response' if stage=='http' else 'transport-error')
    finally:
        row['durationMs']=round((time.monotonic()-started)*1000)
        if sock is not None:
            if row['state']=='ok':time.sleep(.15)
            sock.close()
    return row

if __name__=='__main__':
    try:print(json.dumps(attempt(json.load(sys.stdin))))
    except Exception:print(json.dumps({'state':'unavailable','reason':'tls-probe-unavailable'}))
