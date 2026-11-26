#!/usr/bin/env python3
"""Extract only regular allowlisted files; never honor archive paths or links."""
import gzip, pathlib, shutil, sys, tarfile, zipfile
module, version, archive, destination = sys.argv[1:5]
arch={'arm64':'arm64','x64':'x86_64','amd64':'x86_64'}.get(sys.argv[5] if len(sys.argv)>5 else 'arm64')
if arch is None: raise ValueError('Unsupported architecture')
frp_arch='amd64' if arch=='x86_64' else 'arm64'
folder=pathlib.Path(destination)
folder.mkdir(parents=True,exist_ok=True)
folder.chmod(0o755)
LIMIT=256*1024*1024

def save(source,name):
    target=folder/name
    target.parent.mkdir(parents=True,exist_ok=True)
    for parent in [target.parent, *target.parent.parents]:
        if parent == folder: break
        parent.chmod(0o755)
    with target.open('wb') as out:
        count=0
        while chunk:=source.read(1024*1024):
            count+=len(chunk)
            if count>LIMIT: raise ValueError('Extracted file is too large')
            out.write(chunk)
    target.chmod(0o644 if name.startswith('lua/') else 0o755)

if module=='mihomo':
    with gzip.open(archive,'rb') as source: save(source,'mihomo')
elif module=='xray':
    with zipfile.ZipFile(archive) as bundle, bundle.open('xray') as source: save(source,'xray')
else:
    if module=='tor':
        names=['tor/tor','tor/libcrypto.so.3','tor/libssl.so.3','tor/libevent-2.1.so.7','tor/pluggable_transports/lyrebird','tor/pluggable_transports/pt_config.json','data/geoip','data/geoip6','docs/tor.txt','docs/lyrebird.txt','docs/openssl.txt','docs/libevent.txt','docs/zlib.txt','docs/conjure.txt']
        members={name:name for name in names}
    elif module=='adguard': members={'AdGuardHome/AdGuardHome':'AdGuardHome'}
    elif module=='frp': members={f'frp_{version.lstrip("v")}_linux_{frp_arch}/frpc':'frpc'}
    elif module=='zapret':
        prefix=f'zapret2-{version}/'
        members={prefix+f'binaries/linux-{arch}/nfqws2':'nfqws2'}
        for name in ['zapret-lib','zapret-antidpi','zapret-auto','zapret-pcap','zapret-obfs','zapret-tests']:
            members[prefix+'lua/'+name+'.lua']='lua/'+name+'.lua'
    else: raise ValueError('Unknown module')
    found=set()
    with tarfile.open(archive,'r:gz') as bundle:
        for member in bundle:
            name=member.name.removeprefix('./')
            if name in members:
                if not member.isfile() or member.size>LIMIT: raise ValueError('Invalid archive member')
                with bundle.extractfile(member) as source: save(source,members[name])
                found.add(name)
    required=set(members)-({'docs/zlib.txt','docs/conjure.txt'} if module=='tor' else set())
    if not required.issubset(found): raise ValueError('Required archive member missing')
