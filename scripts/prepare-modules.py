#!/usr/bin/env python3
"""Prepare architecture-specific modules without changing system networking."""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import tarfile
import tempfile

from install_support import initial_link, verified_download, public_directory, public_tree, elf_architecture,module_stage

ROOT = pathlib.Path(__file__).resolve().parents[1]


def build_zapret(module, output, platform):
    module_stage('zapret','checking',5)
    target = output / 'zapret2' / module['commit']
    public_directory(target.parent,output)
    if (target / 'nfqws2').exists() and (target / 'lua').is_dir():
        module_stage('zapret','reuse',100)
        return

    with tempfile.TemporaryDirectory() as work:
        work = pathlib.Path(work)
        archive = work / 'source.tar.gz'
        url = f"https://codeload.github.com/{module['repository']}/tar.gz/{module['commit']}"
        verified_download(url, archive, module['sourceSha256'])
        with tarfile.open(archive) as bundle:
            bundle.extractall(work / 'src', filter='data')
        source = next((work / 'src').iterdir())
        module_stage('zapret','building',40)
        subprocess.run(['make', '-j2'], cwd=source, check=True)

        # Publish only a complete build; failed copies never become active.
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.stage-', dir=target.parent) as stage:
            staged = pathlib.Path(stage) / 'module'
            staged.mkdir()
            shutil.copy2(source / 'binaries/my/nfqws2', staged / 'nfqws2')
            shutil.copytree(source / 'lua', staged / 'lua')
            manifest = {'version': module['commit'][:7], 'sourceSha256': module['sourceSha256'], 'platform': platform}
            (staged / 'manifest.json').write_text(json.dumps(manifest))
            if target.exists():
                shutil.rmtree(target)
            staged.replace(target)
            public_tree(target)
            module_stage('zapret','complete',100)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--platform', required=True, choices=['linux-arm64', 'linux-amd64'])
    parser.add_argument('--output', required=True, type=pathlib.Path)
    args = parser.parse_args()
    subprocess.run(['python3', str(ROOT / 'scripts/fetch-modules.py'), '--platform', args.platform, '--output', str(args.output)], check=True)
    lock = json.loads((ROOT / 'packaging/modules.lock.json').read_text())
    zapret = next(module for module in lock['sourceModules'] if module['id'] == 'zapret2')
    build_zapret(zapret, args.output, args.platform)
    managed = args.output / 'zapret'
    public_directory(managed,args.output)
    initial_link(managed / 'current', '../zapret2/' + zapret['commit'])
    print('All modules prepared: ' + args.platform)


if __name__ == '__main__':
    main()
