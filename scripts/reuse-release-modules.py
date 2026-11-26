#!/usr/bin/env python3
"""Reuse only verified binaries built from identical inputs on the same platform."""
import argparse,hashlib,importlib.util,json,pathlib,shutil
from install_support import public_tree
def load_module(name,file):
    spec=importlib.util.spec_from_file_location(name,pathlib.Path(__file__).with_name(file));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
bundles=load_module('release_bundles','release-bundles.py')

def fingerprint(root,names):
    digest=hashlib.sha256()
    for name in sorted(names):
        path=root/name
        if not path.exists():raise ValueError('Missing module build input')
        for file in sorted(path.rglob('*')) if path.is_dir() else [path]:
            relative=file.relative_to(root)
            if any(part in ['bin','__pycache__','.git'] for part in relative.parts) or file.name.startswith('._') or file.name=='.DS_Store' or str(relative)=='server/outline/README.md':continue
            if file.is_symlink():raise ValueError('Module build input is a link')
            if file.is_file():
                data=file.read_bytes()
                if str(relative)=='packaging/runtime.lock.json':data=json.dumps(json.loads(data).get('go'),sort_keys=True).encode()
                if file.name in ['build-lantern.py','build-outline.sh']:
                    text=data.decode();text='\n'.join(line for line in text.splitlines() if 'module_stage(' not in line and 'FG_MODULE_STAGE' not in line);data=text.replace(',module_stage','').encode()
                digest.update(str(relative).encode()+b'\0');digest.update(data)
    return digest.hexdigest()

def reuse(source,target,platform):
    source,target=map(pathlib.Path,(source,target));result=[]
    try:bundles.verify(source,platform)
    except (ValueError,OSError,KeyError):return result
    inputs={
        'tor':['packaging/tor.lock.json','scripts/fetch-tor.py'],
        'lantern':['packaging/lantern.lock.json','packaging/runtime.lock.json','server/lantern','scripts/build-lantern.py'],
        'outline':['packaging/runtime.lock.json','server/outline','scripts/build-outline.sh'],
    }
    old=bundles.layout(source,platform);new=bundles.layout(target,platform)
    for name,names in inputs.items():
        version,folder=new[name];old_version,previous=old[name]
        if folder.exists():continue
        try:
            if version!=old_version:continue
            if name=='tor':
                a=json.loads((source/'packaging/tor.lock.json').read_text());b=json.loads((target/'packaging/tor.lock.json').read_text())
                if a['platforms'][platform]!=b['platforms'][platform]:continue
            elif fingerprint(source,names)!=fingerprint(target,names):continue
            if name=='outline':
                a=json.loads((source/'packaging/modules.lock.json').read_text())['bundledModules'];b=json.loads((target/'packaging/modules.lock.json').read_text())['bundledModules']
                if next(x for x in a if x['id']=='outline')!=next(x for x in b if x['id']=='outline'):continue
            folder.parent.mkdir(parents=True,exist_ok=True);shutil.copytree(previous,folder);public_tree(folder);result.append(name)
        except (OSError,ValueError,KeyError):
            if folder.exists():shutil.rmtree(folder)
    assets=json.loads((target/'server/access-points/assets.json').read_text())
    helper=load_module('frp_cache','fetch-access-modules.py')
    for arch,sha in assets['assets'].items():
        old_folder=source/'server/access-points/bin'/arch;folder=target/'server/access-points/bin'/arch
        if not folder.exists() and helper.valid_cache(old_folder,assets['version'],sha):
            folder.parent.mkdir(parents=True,exist_ok=True);shutil.copytree(old_folder,folder);public_tree(folder);result.append('frp-'+arch)
    return result

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source',required=True,type=pathlib.Path);parser.add_argument('--target',required=True,type=pathlib.Path);parser.add_argument('--platform',required=True);args=parser.parse_args()
    print(json.dumps({'reused':reuse(args.source,args.target,args.platform)}))
