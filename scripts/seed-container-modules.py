#!/usr/bin/env python3
"""Seed missing immutable module versions, retaining independently updated current links."""
import argparse,fcntl,os,pathlib,shutil,tempfile
from install_support import elf_architecture,public_directory,public_tree
BINARIES={'mihomo','xray','AdGuardHome','nfqws2','tor','lyrebird','frpc','frps','lantern-headless'}
def validate_architecture(root,platform):
    if not root.exists():return
    marker=root/'.platform'
    if marker.exists() and marker.read_text().strip()!=platform:raise ValueError('Module volumes cannot be shared between architectures')
    for path in root.rglob('*'):
        if any(part.startswith('.') for part in path.relative_to(root).parts):continue
        if path.is_file() and path.name in BINARIES and elf_architecture(path)!=platform:raise ValueError('A module binary has a different architecture: '+path.name)

def seed(source,target,platform):
    source,target=pathlib.Path(source).resolve(),pathlib.Path(target).resolve()
    if platform not in ['linux-arm64','linux-amd64']:raise ValueError('Unsupported module platform')
    if source==target or source.is_relative_to(target) or target.is_relative_to(source):raise ValueError('Module seed and volume must be separate')
    if not source.is_dir():raise ValueError('Module seed directory is missing')
    validate_architecture(source,platform);validate_architecture(target,platform)
    public_directory(target,target)
    with (target/'.seed.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        validate_architecture(target,platform)
        for module in sorted(source.iterdir()):
            if module.name.startswith('.') or not module.is_dir() or module.is_symlink():continue
            destination=target/module.name;public_directory(destination,target)
            for version in module.iterdir():
                if version.name.startswith('.') or not version.is_dir() or version.is_symlink():continue
                final=destination/version.name
                if final.exists():continue
                with tempfile.TemporaryDirectory(prefix='.seed-',dir=destination) as work:
                    staged=pathlib.Path(work)/'module';shutil.copytree(version,staged,symlinks=True)
                    for path in staged.rglob('*'):
                        if path.is_symlink():
                            original=version/path.relative_to(staged)
                            if not original.resolve().is_relative_to(source):raise ValueError('Module seed link escapes its root')
                    public_tree(staged);staged.rename(final)
        for module in sorted(source.iterdir()):
            if not module.is_dir() or module.is_symlink():continue
            link=module/'current'
            if not link.is_symlink():continue
            resolved=link.resolve()
            if not resolved.is_relative_to(source) or not resolved.exists():raise ValueError('Invalid module seed current link')
            current=target/module.name/'current'
            if current.is_symlink():
                if not current.exists() or not current.resolve().is_relative_to(target):raise ValueError('Existing module current link is invalid; repair it before startup')
                public_tree(current.resolve());continue
            if current.exists():raise ValueError('Existing module current must be a symlink')
            pending=current.with_name('current.next');pending.unlink(missing_ok=True)
            pending.symlink_to(os.path.relpath(target/resolved.relative_to(source),current.parent));pending.replace(current)
        if (source/'manifest.json').exists() and not (target/'manifest.json').exists():shutil.copy2(source/'manifest.json',target/'manifest.json')
        marker=target/'.platform.next';marker.write_text(platform+'\n');marker.chmod(0o644);marker.replace(target/'.platform')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);parser.add_argument('--target',required=True);parser.add_argument('--platform',required=True,choices=['linux-arm64','linux-amd64']);args=parser.parse_args();seed(args.source,args.target,args.platform)
