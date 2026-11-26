#!/usr/bin/env python3
"""Download locked upstream binaries, verify SHA256, stage without activation."""
import platform
import argparse, gzip, json, pathlib, shutil, tarfile, zipfile

from install_support import digest,verified_download,initial_link,public_directory,public_tree

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--platform',choices=['linux-arm64','linux-amd64'],default='linux-'+{'aarch64':'arm64','arm64':'arm64','x86_64':'amd64','AMD64':'amd64'}.get(platform.machine(),'unsupported'))
    parser.add_argument('--output',required=True,type=pathlib.Path)
    parser.add_argument('--only',action='append',default=[],help='Fetch only these module ids')
    args=parser.parse_args()
    lock=json.loads((pathlib.Path(__file__).resolve().parents[1]/'packaging/modules.lock.json').read_text())
    public_directory(args.output,args.output)
    manifest=[]
    modules=[m for m in lock['modules'] if not args.only or m['id'] in args.only]
    for original in modules:
        platform_asset=original.get('platforms',{}).get(args.platform)
        if not platform_asset: raise SystemExit('Unsupported module platform: '+args.platform)
        module={**original,**platform_asset}
        folder=args.output/module['id']/module['version']
        public_directory(folder,args.output)
        archive=folder/module['asset']
        url=f"https://github.com/{module['repository']}/releases/download/{module['version']}/{module['asset']}"
        if not archive.exists() or digest(archive)!=module['sha256']:
            pending=folder/(module['asset']+'.part')
            verified_download(url,pending,module['sha256'])
            pending.replace(archive)
        target=folder/module['binary']
        temporary=folder/(module['binary']+'.next')
        with temporary.open('wb') as out:
            if module['format']=='gzip':
                with gzip.open(archive,'rb') as data: shutil.copyfileobj(data,out)
            elif module['format']=='zip':
                with zipfile.ZipFile(archive) as bundle, bundle.open(module['member']) as data: shutil.copyfileobj(data,out)
            else:
                with tarfile.open(archive,'r:gz') as bundle:
                    member=bundle.getmember(module['member'])
                    if not member.isfile(): raise SystemExit('Invalid archive member')
                    with bundle.extractfile(member) as data: shutil.copyfileobj(data,out)
        temporary.chmod(0o755)
        temporary.replace(target)
        record={**module,'platform':args.platform,'url':url,'binarySha256':digest(target)}
        (folder/'manifest.json').write_text(json.dumps(record,indent=2)+'\n')
        public_tree(folder)
        initial_link(args.output/module['id']/'current',module['version'])
        manifest.append(record)
        print(module['id']+' '+module['version']+': SHA256 verified; staged, not activated',flush=True)
    (args.output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    (args.output/'manifest.json').chmod(0o644)

if __name__=='__main__': main()
