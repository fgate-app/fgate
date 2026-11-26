#!/usr/bin/env python3
"""Assemble a release from explicit inputs; local diagnostics and state never enter it."""
import argparse,json,pathlib,re,shutil
from install_support import public_tree
DIRECTORIES=['shared','server','packaging','docs','tests','.storybook']
FILES=['package.json','package-lock.json','README.md','LICENSE','Dockerfile','compose.yaml','.dockerignore','install.sh']
WEB=['src','public','dist','index.html','vite.config.js']
# Explicit server imports only; yaml has no transitive runtime dependencies.
RUNTIME_PACKAGES=['yaml']
def ignored(folder,names):
    path=pathlib.Path(folder)
    if path.parent.name=='bin' and path.name in ['linux-arm64','linux-amd64'] and path.parent.parent.name in ['tor','lantern']:
        id=path.parent.parent.name;version=json.loads((path.parents[3]/'packaging'/(id+'.lock.json')).read_text())['version'];return [name for name in names if name!=version]
    return [name for name in names if name in ['.git','.data','node_modules','__pycache__','.DS_Store','.env'] or name.startswith(('.env.','.stage-')) or name.endswith(('.pyc','.log','.part')) or path.name=='bin' and str(path).endswith(('server/outline/bin','server/access-points/bin','server/lantern/bin','server/tor/bin')) and name not in ['linux-arm64','linux-amd64']]
def assemble(source,target,installer=False):
    source,target=pathlib.Path(source).resolve(),pathlib.Path(target).resolve()
    if source==target or any(target.is_relative_to(source/name) for name in [*DIRECTORIES,'scripts','web']):raise ValueError('Release destination must not overlap release inputs')
    if target.exists() and any(target.iterdir()):raise ValueError('Release destination must be empty')
    scripts=json.loads((source/'packaging/release-scripts.json').read_text())
    if any(not isinstance(name,str) or not re.fullmatch(r'[\w.-]+',name) or name in ['.','..'] for name in scripts):raise ValueError('Invalid release script name')
    required=[*(source/name for name in FILES),*(source/name for name in DIRECTORIES if name not in ['tests','.storybook','docs']),*(source/'web'/name for name in WEB),*(source/'scripts'/name for name in scripts)]
    if any(not path.exists() for path in required):raise ValueError('A required release input is missing')
    lock=json.loads((source/'package-lock.json').read_text())
    for name in RUNTIME_PACKAGES:
        package=source/'node_modules'/name
        if any(not (package/file).is_file() for file in ['package.json','dist/index.js','LICENSE']):raise ValueError('Prepared runtime dependency is missing: '+name)
        manifest=json.loads((package/'package.json').read_text())
        if manifest.get('version')!=lock.get('packages',{}).get('node_modules/'+name,{}).get('version'):raise ValueError('Runtime dependency does not match package-lock: '+name)
    target.mkdir(parents=True,exist_ok=True)
    for name in RUNTIME_PACKAGES:
        shutil.copytree(source/'node_modules'/name,target/'node_modules'/name,ignore=ignored,symlinks=True)
    def selected(folder,names):
        excluded=ignored(folder,names)
        if installer and pathlib.Path(folder)==source/'docs':return [name for name in names if name!='licenses']
        if installer and pathlib.Path(folder)==source/'packaging':excluded.append('release-bundles')
        if installer and pathlib.Path(folder).name in ['outline','access-points','lantern','tor'] and pathlib.Path(folder).parent.name=='server':excluded.append('bin')
        return excluded
    for name in DIRECTORIES:
        if (source/name).exists():shutil.copytree(source/name,target/name,ignore=selected,symlinks=True)
    for name in FILES:shutil.copy2(source/name,target/name)
    if not installer and (source/'PROJECT_STATUS.md').is_file():shutil.copy2(source/'PROJECT_STATUS.md',target/'PROJECT_STATUS.md')
    (target/'web').mkdir()
    for name in WEB:
        src,dest=source/'web'/name,target/'web'/name
        if src.is_dir():shutil.copytree(src,dest,ignore=ignored,symlinks=True)
        else:shutil.copy2(src,dest)
    (target/'scripts').mkdir()
    for name in scripts:shutil.copy2(source/'scripts'/name,target/'scripts'/name)
    # All links must remain within the packaged tree; no local private files via symlinks.
    for path in target.rglob('*'):
        if path.is_symlink() and (not path.resolve().is_relative_to(target) or not path.exists()):raise ValueError('Release symlink escapes the package or is broken')
    public_tree(target)
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);parser.add_argument('--target',required=True);parser.add_argument('--installer',action='store_true',help='Exclude binaries fetched or built at installation');args=parser.parse_args();assemble(args.source,args.target,installer=args.installer)
