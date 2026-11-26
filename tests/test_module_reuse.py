import hashlib,importlib.util,json,pathlib,shutil,sys,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'))
spec=importlib.util.spec_from_file_location('reuse_modules',ROOT/'scripts/reuse-release-modules.py');reuse=importlib.util.module_from_spec(spec);spec.loader.exec_module(reuse)
class ReuseTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.source=pathlib.Path(self.tmp.name)/'old';self.target=pathlib.Path(self.tmp.name)/'new'
  def put(name,value):
   file=self.source/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_text(value)
  locks={'tor.lock.json':{'version':'1','platforms':{'linux-arm64':{'sha256':'a'*64}}},'lantern.lock.json':{'version':'1'},'modules.lock.json':{'bundledModules':[{'id':'outline','bridgeVersion':'1'}]},'runtime.lock.json':{'go':'1'}}
  for name,data in locks.items():put('packaging/'+name,json.dumps(data))
  for name in ['fetch-tor.py','install_support.py','build-lantern.py','build-outline.sh']:put('scripts/'+name,'build input')
  put('server/outline/main.go','outline');put('server/lantern/source.go','lantern');put('server/access-points/assets.json',json.dumps({'version':'1','assets':{}}))
  shutil.copytree(self.source,self.target)
  elf=bytearray(20);elf[:6]=b'\x7fELF\x02\x01';elf[18:20]=(183).to_bytes(2,'little')
  for module,(version,folder) in reuse.bundles.layout(self.source,'linux-arm64').items():
   names=reuse.bundles.TOR_FILES if module=='tor' else ['lantern-headless','COPYING.txt','corresponding-source.tar.gz'] if module=='lantern' else ['outline-bridge']
   for name in names:
    file=folder/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(elf)
   if module=='tor':manifest={'version':'1','sha256':'a'*64}
   elif module=='lantern':manifest={'version':'1','binarySha256':hashlib.sha256(elf).hexdigest(),'routing':'proxy-only'}
   else:continue
   (folder/'manifest.json').write_text(json.dumps(manifest))
  manifest=self.source/'packaging/release-bundles/linux-arm64.json';manifest.parent.mkdir();manifest.write_text(json.dumps(reuse.bundles.inventory(self.source,'linux-arm64')))
 def test_identical_verified_inputs_reuse_all_bundles(self):self.assertEqual(set(reuse.reuse(self.source,self.target,'linux-arm64')),{'tor','lantern','outline'})
 def test_source_change_rebuilds_only_affected_component(self):
  (self.target/'server/outline/main.go').write_text('changed');self.assertEqual(set(reuse.reuse(self.source,self.target,'linux-arm64')),{'tor','lantern'})
 def test_changed_tor_lock_does_not_copy_old_tor(self):
  p=self.target/'packaging/tor.lock.json';data=json.loads(p.read_text());data['version']='2';p.write_text(json.dumps(data));self.assertNotIn('tor',reuse.reuse(self.source,self.target,'linux-arm64'))
 def test_tampered_or_wrong_architecture_cache_is_rejected(self):
  (self.source/'server/outline/bin/linux-arm64/outline-bridge').write_bytes(b'bad');self.assertEqual(reuse.reuse(self.source,self.target,'linux-arm64'),[]);self.assertEqual(reuse.reuse(self.source,self.target,'linux-amd64'),[])
if __name__=='__main__':unittest.main()
