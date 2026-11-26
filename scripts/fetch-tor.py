#!/usr/bin/env python3
"""Download and verify the pinned official Tor bundle during installation."""
import argparse,hashlib,json,pathlib,re,subprocess,urllib.request
from install_support import public_directory,public_tree,elf_architecture
ROOT=pathlib.Path(__file__).resolve().parents[1]
REQUIRED=['tor/tor','tor/libcrypto.so.3','tor/libssl.so.3','tor/libevent-2.1.so.7','tor/pluggable_transports/lyrebird','tor/pluggable_transports/pt_config.json','data/geoip','data/geoip6']
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--platform',choices=['linux-arm64','linux-amd64'],required=True);parser.add_argument('--output',type=pathlib.Path,required=True);args=parser.parse_args();args.output=args.output.resolve()
    lock=json.loads((ROOT/'packaging/tor.lock.json').read_text());asset=lock['platforms'][args.platform];folder=args.output/'tor'/lock['version'];public_directory(folder,args.output)
    archive=folder/'bundle.tar.gz';url=lock['source']+asset['asset']
    if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest()!=asset['sha256']:
        request=urllib.request.Request(url,headers={'User-Agent':'FreedomGate'})
        with urllib.request.urlopen(request,timeout=120) as response:data=response.read(128*1024*1024+1)
        if len(data)>128*1024*1024 or hashlib.sha256(data).hexdigest()!=asset['sha256']:raise ValueError('Tor checksum mismatch')
        archive.write_bytes(data)
    subprocess.run(['python3',str(ROOT/'scripts/extract-module.py'),'tor',lock['version'],str(archive),str(folder),args.platform.split('-')[1]],check=True)
    (folder/'manifest.json').write_text(json.dumps({'version':lock['version'],'sha256':asset['sha256'],'url':url,'platform':args.platform}));public_tree(folder)
    current=args.output/'tor/current'
    if not current.exists():current.symlink_to(lock['version'])
    print('Tor / Snowflake '+lock['version']+': official archive SHA-256 verified')
if __name__=='__main__':main()
