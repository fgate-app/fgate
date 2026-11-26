#!/usr/bin/env python3
"""Prepare upstream modules at installation and verify installed release binaries."""
import argparse,hashlib,json,pathlib,shutil,subprocess,tempfile
from install_support import elf_architecture,public_tree
ROOT=pathlib.Path(__file__).resolve().parents[1]
TOR_FILES=['tor/tor','tor/libcrypto.so.3','tor/libssl.so.3','tor/libevent-2.1.so.7','tor/pluggable_transports/lyrebird','tor/pluggable_transports/pt_config.json','data/geoip','data/geoip6']
def layout(root,platform):
 if platform not in ['linux-arm64','linux-amd64']:raise ValueError('Unsupported release platform')
 tor=json.loads((root/'packaging/tor.lock.json').read_text());lantern=json.loads((root/'packaging/lantern.lock.json').read_text());outline=next(x for x in json.loads((root/'packaging/modules.lock.json').read_text())['bundledModules'] if x['id']=='outline')
 return {'tor':(tor['version'],root/'server/tor/bin'/platform/tor['version']),'lantern':(lantern['version'],root/'server/lantern/bin'/platform/lantern['version']),'outline':(outline['bridgeVersion'],root/'server/outline/bin'/platform)}
def inventory(root,platform):
 modules={}
 for id,(version,folder) in layout(root,platform).items():
  required=TOR_FILES if id=='tor' else ['lantern-headless','manifest.json','COPYING.txt','corresponding-source.tar.gz'] if id=='lantern' else ['outline-bridge']
  if any(not (folder/name).is_file() for name in required):raise ValueError('Missing release bundle: '+id+' '+platform)
  for name in (['tor/tor','tor/pluggable_transports/lyrebird'] if id=='tor' else ['lantern-headless'] if id=='lantern' else ['outline-bridge']):
   if elf_architecture(folder/name)!=platform:raise ValueError('Incompatible release binary: '+id)
  if id=='lantern':
   manifest=json.loads((folder/'manifest.json').read_text())
   if manifest.get('version')!=version or manifest.get('binarySha256')!=hashlib.sha256((folder/'lantern-headless').read_bytes()).hexdigest() or manifest.get('routing')!='proxy-only':raise ValueError('Unverified release Lantern module')
  if id=='tor':
   manifest=json.loads((folder/'manifest.json').read_text());lock=json.loads((root/'packaging/tor.lock.json').read_text())
   if manifest.get('version')!=version or manifest.get('sha256')!=lock['platforms'][platform]['sha256']:raise ValueError('Unverified release Tor module')
  files={}
  for p in sorted(folder.rglob('*')):
   if p.is_symlink():raise ValueError('Release binaries must not contain symbolic links')
   if p.is_file():files[str(p.relative_to(root))]=hashlib.sha256(p.read_bytes()).hexdigest()
  modules[id]={'version':version,'files':files}
 return {'schema':1,'platform':platform,'modules':modules}
def verify(root,platform):
 manifest=root/'packaging/release-bundles'/(platform+'.json')
 if not manifest.is_file():raise ValueError('The complete release bundle is missing. Use a prepared FreedomGate release.')
 if json.loads(manifest.read_text())!=inventory(root,platform):raise ValueError('The release bundle checksum or version does not match')
 return True

def prepare(root,platform):
 for id,(version,folder) in layout(root,platform).items():
  if id=='outline' and not (folder/'outline-bridge').is_file():subprocess.run(['sh',str(root/'scripts/build-outline.sh'),'linux',platform.split('-')[1]],check=True)
  if id=='lantern' and not folder.is_dir():subprocess.run(['python3',str(root/'scripts/build-lantern.py'),'--platform',platform,'--output',str(folder.parent)],check=True)
  if id=='tor' and not folder.is_dir():
   with tempfile.TemporaryDirectory(prefix='.stage-bundle-') as work:
    subprocess.run(['python3',str(root/'scripts/fetch-tor.py'),'--platform',platform,'--output',work],check=True)
    folder.parent.mkdir(parents=True,exist_ok=True);shutil.copytree(pathlib.Path(work)/'tor'/version,folder)
    (folder/'bundle.tar.gz').unlink(missing_ok=True)
  public_tree(folder)
 data=inventory(root,platform);manifest=root/'packaging/release-bundles'/(platform+'.json');manifest.parent.mkdir(exist_ok=True);manifest.write_text(json.dumps(data,indent=2)+'\n');manifest.chmod(0o644);verify(root,platform)
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--root',type=pathlib.Path,default=ROOT);parser.add_argument('--platform',required=True,choices=['linux-arm64','linux-amd64']);parser.add_argument('--prepare',action='store_true',help='Download/build pinned upstream modules for this platform');args=parser.parse_args()
 if args.prepare:prepare(args.root.resolve(),args.platform)
 else:verify(args.root.resolve(),args.platform)
 print('Release modules verified: '+args.platform)
