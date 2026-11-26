#!/usr/bin/env python3
"""Bundle official frp binaries; cache is bound to version, archive and file hashes."""
import os
import argparse,hashlib,io,json,pathlib,shutil,tarfile,tempfile
from install_support import digest,public_directory,public_tree,verified_download,module_stage
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
    selected=[(platform,sha) for platform,sha in lock['assets'].items() if not args.platform or platform in args.platform]
    for index,(platform,sha256) in enumerate(selected):
        os.environ['FREEDOMGATE_MODULE_PROGRESS_BASE']=str(index*100//len(selected));os.environ['FREEDOMGATE_MODULE_PROGRESS_SPAN']=str(100//len(selected))
        target=ROOT/'bin'/platform;public_directory(target.parent,ROOT/'bin')
        if valid_cache(target,lock['version'],sha256):module_stage('frp','reuse',100);continue
        asset='frp_'+lock['version']+'_'+platform.replace('-','_')
        url='https://github.com/'+lock['repository']+'/releases/download/v'+lock['version']+'/'+asset+'.tar.gz'
        module_stage('frp','downloading',20)
        with tempfile.TemporaryDirectory() as download:
            path=pathlib.Path(download)/'frp.tar.gz';verified_download(url,path,sha256);data=path.read_bytes()
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
        module_stage('frp','complete',100)
        print('Verified frp '+lock['version']+': '+platform)
if __name__=='__main__':main()
