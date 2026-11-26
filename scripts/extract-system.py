#!/usr/bin/env python3
"""Extract a pinned official source tree, rejecting links and path traversal."""
import pathlib,re,sys,tarfile
archive,destination,commit=sys.argv[1:]
if not re.fullmatch('[a-f0-9]{40}',commit):raise ValueError('Invalid source revision')
root=pathlib.Path(destination);root.mkdir(mode=0o700)
prefix='fgate-'+commit+'/'
total=0
with tarfile.open(archive,'r:gz') as bundle:
    for member in bundle:
        if member.name.rstrip('/')==prefix.rstrip('/') and member.isdir():continue
        if not member.name.startswith(prefix):raise ValueError('Invalid source root')
        relative=pathlib.PurePosixPath(member.name[len(prefix):])
        if relative.is_absolute() or '..' in relative.parts or not relative.parts:raise ValueError('Invalid source path')
        if not (member.isdir() or member.isfile()):raise ValueError('Source links are not supported')
        total+=member.size
        if member.size>128*1024*1024 or total>512*1024*1024:raise ValueError('Source archive is too large')
        target=root.joinpath(*relative.parts)
        if member.isdir():target.mkdir(parents=True,exist_ok=True);continue
        target.parent.mkdir(parents=True,exist_ok=True)
        with bundle.extractfile(member) as source,target.open('xb') as output:
            while chunk:=source.read(1024*1024):output.write(chunk)
        target.chmod(0o755 if member.mode&0o111 else 0o644)
for name in ['install.sh','package.json','scripts/install.sh','packaging/modules.lock.json']:
    if not (root/name).is_file():raise ValueError('Required source input is missing')
