import importlib.util,pathlib,sys,tempfile,json,shutil,unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'))
spec=importlib.util.spec_from_file_location('release_bundles',ROOT/'scripts/release-bundles.py');bundles=importlib.util.module_from_spec(spec);spec.loader.exec_module(bundles)
class ReleaseBundles(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name);(self.root/'packaging').mkdir()
  for name in ['tor.lock.json','lantern.lock.json','modules.lock.json']:shutil.copy2(ROOT/'packaging'/name,self.root/'packaging'/name)
 def tearDown(self):self.tmp.cleanup()
 def seed(self,platform):
  header=bytearray(32);header[:6]=bytes.fromhex('7f454c460201');header[18:20]=(183 if platform=='linux-arm64' else 62).to_bytes(2,'little')
  import hashlib
  for id,(version,folder) in bundles.layout(self.root,platform).items():
   folder.mkdir(parents=True)
   names=bundles.TOR_FILES+['manifest.json'] if id=='tor' else ['lantern-headless','manifest.json','COPYING.txt','corresponding-source.tar.gz'] if id=='lantern' else ['outline-bridge']
   for name in names:
    p=folder/name;p.parent.mkdir(exist_ok=True,parents=True);p.write_bytes(header if name in ['tor/tor','tor/pluggable_transports/lyrebird','lantern-headless','outline-bridge'] else b'fixture')
   if id=='tor':manifest={'version':version,'sha256':json.loads((self.root/'packaging/tor.lock.json').read_text())['platforms'][platform]['sha256']}
   elif id=='lantern':manifest={'version':version,'routing':'proxy-only','binarySha256':hashlib.sha256(header).hexdigest()}
   else:continue
   (folder/'manifest.json').write_text(json.dumps(manifest))
  (self.root/'packaging/release-bundles').mkdir(exist_ok=True);(self.root/'packaging/release-bundles'/(platform+'.json')).write_text(json.dumps(bundles.inventory(self.root,platform)))
 def test_complete_bundle_verifies_without_network_or_subprocess_for_both_platforms(self):
  for platform in ['linux-arm64','linux-amd64']:
   self.seed(platform)
   with patch('subprocess.run',side_effect=AssertionError('offline')),patch('urllib.request.urlopen',side_effect=AssertionError('offline')):self.assertTrue(bundles.verify(self.root,platform))
 def test_missing_corrupt_or_wrong_platform_bundle_is_rejected(self):
  self.seed('linux-arm64');folder=bundles.layout(self.root,'linux-arm64')['outline'][1];(folder/'outline-bridge').write_bytes(b'bad')
  with self.assertRaises(ValueError):bundles.verify(self.root,'linux-arm64')
  with self.assertRaises(ValueError):bundles.verify(self.root,'linux-amd64')
 def test_pinned_version_change_requires_a_new_complete_bundle(self):
  self.seed('linux-arm64');p=self.root/'packaging/lantern.lock.json';data=json.loads(p.read_text());data['version']='next';p.write_text(json.dumps(data))
  with self.assertRaises(ValueError):bundles.verify(self.root,'linux-arm64')
 def test_install_prepares_only_selected_platform_from_empty_checkout_and_reuses_cache(self):
  for platform in ['linux-arm64','linux-amd64']:
   self.seed(platform);layout=bundles.layout(self.root,platform);templates={}
   for id,(version,folder) in layout.items():
    template=self.root/('fixture-'+platform+'-'+id);folder.rename(template);templates[id]=template
   (self.root/'packaging/release-bundles'/(platform+'.json')).unlink()
   calls=[]
   def run(args,**kwargs):
    calls.append(args)
    if any('build-outline.sh' in str(arg) for arg in args):
     self.assertEqual(args[-2:],['linux',platform.split('-')[1]]);shutil.copytree(templates['outline'],layout['outline'][1])
    elif any('build-lantern.py' in str(arg) for arg in args):
     self.assertEqual(args[args.index('--platform')+1],platform);shutil.copytree(templates['lantern'],layout['lantern'][1])
    elif any('fetch-tor.py' in str(arg) for arg in args):
     self.assertEqual(args[args.index('--platform')+1],platform);output=pathlib.Path(args[args.index('--output')+1])/'tor'/layout['tor'][0];shutil.copytree(templates['tor'],output)
    else:self.fail('Unexpected preparation command: '+str(args))
   with patch('subprocess.run',side_effect=run):bundles.prepare(self.root,platform)
   self.assertEqual(len(calls),3);self.assertTrue(bundles.verify(self.root,platform))
   with patch('subprocess.run',side_effect=AssertionError('valid cache must not download/build')):bundles.prepare(self.root,platform)
 def test_failed_upstream_preparation_does_not_publish_an_install_manifest(self):
  with patch('subprocess.run',side_effect=OSError('upstream unavailable')):
   with self.assertRaises(OSError):bundles.prepare(self.root,'linux-arm64')
  self.assertFalse((self.root/'packaging/release-bundles/linux-arm64.json').exists())
if __name__=='__main__':unittest.main()
