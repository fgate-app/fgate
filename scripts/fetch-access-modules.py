#!/usr/bin/env python3
"""Bundle official frp binaries; cache is bound to version, archive and file hashes."""
import argparse,hashlib,io,json,pathlib,shutil,tarfile,tempfile,urllib.request
from install_support import digest,public_directory,public_tree
ROOT=pathlib.Path(__file__).resolve().parent.parent/'server/access-points'
NAMES=('frpc','frps','LICENSE')
def valid_cache(target,version,sha256):
    try:
        manifest=json.loads((target/'manifest.json').read_text())
        return manifest['version']==version and manifest['sha256']==sha256 and all(digest(target/name)==manifest['files'][name] for name in NAMES)
    except (OSError,ValueError,KeyError):return False

def main():
    lock=json.loads((ROOT/'assets.json').read_text())
    parser=argparse.ArgumentParser();parser.add_argument('--platform',action='append',choices=list(lock['assets']));args=parser.parse_args()
    for platform,sha256 in lock['assets'].items():
        if args.platform and platform not in args.platform:continue
        target=ROOT/'bin'/platform;public_directory(target.parent,ROOT/'bin')
        if valid_cache(target,lock['version'],sha256):public_tree(target);continue
        asset='frp_'+lock['version']+'_'+platform.replace('-','_')
        url='https://github.com/'+lock['repository']+'/releases/download/v'+lock['version']+'/'+asset+'.tar.gz'
        with urllib.request.urlopen(url,timeout=90) as response:data=response.read(128*1024*1024+1)
        if len(data)>128*1024*1024 or hashlib.sha256(data).hexdigest()!=sha256:raise ValueError('frp checksum mismatch: '+platform)
        with tempfile.TemporaryDirectory(prefix='.stage-',dir=target.parent) as work:
            staged=pathlib.Path(work)/'module';staged.mkdir()
            with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as archive:
                for name in NAMES:
                    member=archive.getmember(asset+'/'+name)
                    if not member.isfile() or member.size>128*1024*1024:raise ValueError('Invalid frp archive member')
                    with archive.extractfile(member) as source,(staged/name).open('wb') as out:shutil.copyfileobj(source,out)
                    (staged/name).chmod(0o755 if name!='LICENSE' else 0o644)
            (staged/'manifest.json').write_text(json.dumps({'version':lock['version'],'sha256':sha256,'platform':platform,'files':{name:digest(staged/name) for name in NAMES}}));public_tree(staged)
            old=pathlib.Path(work)/'previous'
            if target.exists():target.rename(old)
            try:staged.rename(target)
            except BaseException:
                if old.exists():old.rename(target)
                raise
        print('Verified frp '+lock['version']+': '+platform)
if __name__=='__main__':main()
