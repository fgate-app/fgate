import hashlib,importlib.util,json,pathlib,sys,tempfile,unittest,tarfile
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'))
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,ROOT/path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
builder=load('lantern_builder','scripts/build-lantern.py')
class LanternBuild(unittest.TestCase):
 def test_unknown_upstream_source_is_rejected_before_build(self):
  with tempfile.TemporaryDirectory() as work:
   root=pathlib.Path(work);(root/'serve.go').write_text('changed upstream API')
   with self.assertRaisesRegex(ValueError,'does not match'):builder.patch_sources(root,root)
 def test_our_snapshot_has_modified_core_and_adapter_and_needs_no_upstream_source_download(self):
  lock=json.loads((ROOT/'packaging/lantern.lock.json').read_text())
  with tempfile.TemporaryDirectory() as work,patch('urllib.request.urlopen',side_effect=AssertionError('source must be local')):
   headless,core,archive=builder.prepare_sources(lock,pathlib.Path(work))
   self.assertEqual((headless/'freedomgate_upstream.go').read_bytes(),(ROOT/'server/lantern/upstream.go').read_bytes())
   self.assertFalse((core/'.coveralls.yml').exists());self.assertIn('var Key = ""',(core/'email/email.go').read_text())
   self.assertIn('shouldForceProxying()', (core/'client/client.go').read_text())
   self.assertIn('proxyless transport is disabled by FreedomGate',(core/'dialer/proxyless.go').read_text())
   self.assertIn('../../flashlight-fg',(headless/'go.mod').read_text())
   self.assertEqual((headless/'../../flashlight-fg').resolve(),core.resolve())
   with tarfile.open(archive) as source:
    for entry in source:
     if entry.isfile():self.assertNotEqual(source.extractfile(entry).read(4),b'\x7fELF')
 def test_changed_snapshot_is_rejected_before_compilation(self):
  lock=json.loads((ROOT/'packaging/lantern.lock.json').read_text())
  with tempfile.TemporaryDirectory() as work:
   root=pathlib.Path(work);archive=root/'tampered.tar.gz';archive.write_bytes(b'tampered')
   with self.assertRaisesRegex(ValueError,'checksum'):builder.prepare_sources(lock,root,archive)
 def test_both_platforms_build_our_sources_and_keep_gpl_source_with_the_result(self):
  for platform,machine in [('linux-arm64',183),('linux-amd64',62)]:
   with tempfile.TemporaryDirectory() as output:
    def compile(args,cwd,env,**kwargs):
     self.assertEqual(env['GOARCH'],platform.split('-')[1]);self.assertIn('ForceProxying()',(cwd/'serve.go').read_text())
     binary=pathlib.Path(args[args.index('-o')+1]);header=bytearray(32);header[:6]=bytes.fromhex('7f454c460201');header[18:20]=machine.to_bytes(2,'little');binary.write_bytes(header)
    with patch('subprocess.run',side_effect=compile):target=builder.build(platform,output)
    manifest=json.loads((target/'manifest.json').read_text());self.assertEqual(manifest['platform'],platform);self.assertEqual(manifest['routing'],'proxy-only')
    self.assertTrue((target/'COPYING.txt').is_file());self.assertTrue((target/'corresponding-source.tar.gz').is_file())
 def test_failed_compilation_never_publishes_a_partial_module(self):
  with tempfile.TemporaryDirectory() as output,patch('subprocess.run',side_effect=OSError('compiler failed')):
   with self.assertRaises(OSError):builder.build('linux-arm64',output)
   self.assertEqual(list(pathlib.Path(output).iterdir()),[])
if __name__=='__main__':unittest.main()
