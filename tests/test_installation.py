import importlib.util,json,os,pathlib,shutil,subprocess,tempfile,unittest,sys
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
ROOT=pathlib.Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
support=load('install_support','scripts/install_support.py')
transaction=load('install_transaction','scripts/install-transaction.py')
class Installation(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name);self.base=self.root/'opt';self.etc=self.root/'etc';self.state=self.root/'state';self.calls=[]
        for folder in [self.base/'runtime',self.etc/'systemd/system',self.etc/'freedomgate',self.state]:folder.mkdir(parents=True)
        self.tx=transaction.InstallTransaction(self.base,self.etc,self.state,self.run_command)
    def tearDown(self):self.tmp.cleanup()
    def run_command(self,args,**kwargs):self.calls.append(args);return subprocess.CompletedProcess(args,0)
    def test_public_artifacts_under_private_umask(self):
        old=os.umask(0o077)
        try:
            folder=self.root/'public';support.public_directory(folder/'module/version',folder)
            executable=folder/'module/version/binary';executable.write_text('binary');executable.chmod(0o700)
            data=folder/'module/version/manifest.json';data.write_text('{}');support.public_tree(folder)
            for path in [folder,folder/'module',folder/'module/version']:self.assertEqual(path.stat().st_mode&0o777,0o755)
            self.assertEqual(executable.stat().st_mode&0o777,0o755);self.assertEqual(data.stat().st_mode&0o777,0o644)
            self.assertEqual(self.root.stat().st_mode&0o777,0o700)
        finally:os.umask(old)
    def test_transaction_restores_links_units_and_environment_but_not_user_data(self):
        (self.base/'current').symlink_to('old-release');(self.base/'runtime/node').symlink_to('old-node')
        unit=self.etc/'systemd/system/freedomgate.service';unit.write_text('old unit');env=self.etc/'freedomgate/freedomgate.env';env.write_text('PORT=8080\n');env.chmod(0o600)
        dropin=self.etc/'systemd/system/freedomgate.service.d/custom.conf';dropin.parent.mkdir();dropin.write_text('custom')
        (self.state/'db').write_text('old data');backup=self.tx.snapshot();self.tx.backup_state(backup)
        self.tx.activate_node(backup,'new-node');(self.base/'current').unlink();(self.base/'current').symlink_to('new-release');unit.write_text('new unit');env.write_text('PORT=80\n');(self.state/'db').write_text('migrated data')
        self.tx.restore(backup,restart=True)
        self.assertEqual(os.readlink(self.base/'current'),'old-release');self.assertEqual(os.readlink(self.base/'runtime/node'),'old-node')
        self.assertEqual(unit.read_text(),'old unit');self.assertEqual(env.read_text(),'PORT=8080\n');self.assertEqual(env.stat().st_mode&0o777,0o600);self.assertEqual(dropin.read_text(),'custom')
        self.assertEqual((backup/'state/db').read_text(),'old data');self.assertEqual((self.state/'db').read_text(),'migrated data');self.assertEqual(backup.stat().st_mode&0o777,0o700)
        self.assertIn(['systemctl','daemon-reload'],self.calls)
    def test_legacy_runtime_directory_is_restored(self):
        node=self.base/'runtime/node';node.mkdir();(node/'binary').write_text('old')
        backup=self.tx.snapshot();self.tx.activate_node(backup,'new-node');self.assertTrue(node.is_symlink());self.tx.restore(backup)
        self.assertFalse(node.is_symlink());self.assertEqual((node/'binary').read_text(),'old')
    def test_failure_before_activation_does_not_restart_services(self):
        backup=self.tx.snapshot();self.calls.clear();self.tx.restore(backup)
        self.assertEqual(self.calls,[])
    def test_first_install_rollback_removes_only_installer_owned_files(self):
        backup=self.tx.snapshot();self.tx.activate_node(backup,'new-node');(self.base/'current').symlink_to('new-release');unit=self.etc/'systemd/system/freedomgate.service';unit.write_text('new')
        self.tx.restore(backup);self.assertFalse(unit.exists());self.assertFalse((self.base/'current').is_symlink());self.assertFalse((self.base/'runtime/node').is_symlink())
    def test_real_release_directory_is_rejected_without_moving_it(self):
        (self.base/'current').mkdir();(self.base/'current/user-file').write_text('keep')
        with self.assertRaises(ValueError):self.tx.snapshot()
        self.assertEqual((self.base/'current/user-file').read_text(),'keep')
    def test_initial_module_link_preserves_independent_update(self):
        module=self.root/'module';module.mkdir();(module/'new').mkdir();(module/'current').symlink_to('new');support.initial_link(module/'current','pinned');self.assertEqual(os.readlink(module/'current'),'new')
    def test_frp_cache_rejects_changed_version_or_binary(self):
        frp=load('fetch_access','scripts/fetch-access-modules.py');folder=self.root/'frp';folder.mkdir()
        for name in frp.NAMES:(folder/name).write_text(name)
        (folder/'manifest.json').write_text(json.dumps({'version':'v1','sha256':'a'*64,'files':{name:support.digest(folder/name) for name in frp.NAMES}}))
        self.assertTrue(frp.valid_cache(folder,'v1','a'*64));self.assertFalse(frp.valid_cache(folder,'v2','a'*64));(folder/'frpc').write_text('corrupt');self.assertFalse(frp.valid_cache(folder,'v1','a'*64))
    def seed_fixture(self,platform='linux-arm64'):
        seed=load('seed_modules','scripts/seed-container-modules.py');source=self.root/'seed';target=self.root/'volume';version=source/'mihomo/pinned';version.mkdir(parents=True)
        header=bytearray(20);header[:6]=b'\x7fELF\x02\x01';header[18:20]=(183 if platform=='linux-arm64' else 62).to_bytes(2,'little');(version/'mihomo').write_bytes(header);(version/'mihomo').chmod(0o755);(source/'mihomo/current').symlink_to('pinned');(source/'.platform').write_text(platform)
        return seed,source,target,bytes(header)
    def test_container_seeds_new_module_without_replacing_independent_current(self):
        seed,source,target,header=self.seed_fixture();newer=target/'mihomo/newer';newer.mkdir(parents=True);(newer/'mihomo').write_bytes(header);(target/'mihomo/current').symlink_to('newer')
        seed.seed(source,target,'linux-arm64');self.assertEqual(os.readlink(target/'mihomo/current'),'newer');self.assertTrue((target/'mihomo/pinned/mihomo').is_file());self.assertEqual((target/'.platform').read_text().strip(),'linux-arm64')
        tor=source/'tor/pinned/tor';tor.mkdir(parents=True);(tor/'tor').write_bytes(header);(source/'tor/current').symlink_to('pinned');seed.seed(source,target,'linux-arm64');self.assertTrue((target/'tor/current/tor/tor').is_file());self.assertEqual(os.readlink(target/'mihomo/current'),'newer')
    def test_container_cross_architecture_volume_is_rejected_before_copy(self):
        seed,source,target,header=self.seed_fixture();target.mkdir();(target/'.platform').write_text('linux-amd64');(target/'keep').write_text('untouched')
        with self.assertRaises(ValueError):seed.seed(source,target,'linux-arm64')
        self.assertEqual((target/'keep').read_text(),'untouched');self.assertFalse((target/'mihomo').exists())
    def test_legacy_volume_architecture_is_checked_without_a_marker(self):
        seed,source,target,header=self.seed_fixture();version=target/'mihomo/old';version.mkdir(parents=True);wrong=bytearray(header);wrong[18:20]=(62).to_bytes(2,'little');(version/'mihomo').write_bytes(wrong)
        with self.assertRaises(ValueError):seed.seed(source,target,'linux-arm64')
        self.assertFalse((target/'.platform').exists())
    def test_container_seed_is_readable_with_private_umask_and_keeps_relative_alias(self):
        seed,source,target,header=self.seed_fixture();version=source/'zapret2/commit';version.mkdir(parents=True);(version/'nfqws2').write_bytes(header);(source/'zapret').mkdir();(source/'zapret/current').symlink_to('../zapret2/commit')
        old=os.umask(0o077)
        try:seed.seed(source,target,'linux-arm64')
        finally:os.umask(old)
        self.assertEqual(os.readlink(target/'zapret/current'),'../zapret2/commit');self.assertEqual((target/'mihomo/pinned').stat().st_mode&0o777,0o755);self.assertEqual((target/'mihomo/pinned/mihomo').stat().st_mode&0o777,0o755)
    def test_container_does_not_silently_replace_a_broken_independent_link(self):
        seed,source,target,header=self.seed_fixture();(target/'mihomo').mkdir(parents=True);(target/'mihomo/current').symlink_to('missing')
        with self.assertRaises(ValueError):seed.seed(source,target,'linux-arm64')
        self.assertEqual(os.readlink(target/'mihomo/current'),'missing')
    def test_release_assembler_omits_local_diagnostics_state_env_and_wrong_platforms(self):
        package=load('package_tree','scripts/package-tree.py');source=self.root/'source';target=self.root/'release';source.mkdir()
        for name in package.DIRECTORIES:(source/name).mkdir(parents=True,exist_ok=True)
        for name in package.FILES:(source/name).write_text('public')
        for name in ['src','public','dist']:(source/'web'/name).mkdir(parents=True)
        for name in ['index.html','vite.config.js']:(source/'web'/name).write_text('public')
        scripts=json.loads((ROOT/'packaging/release-scripts.json').read_text());(source/'packaging/release-scripts.json').write_text(json.dumps(scripts));(source/'scripts').mkdir()
        for name in scripts:(source/'scripts'/name).write_text('public')
        (source/'scripts/test-blanc-all.py').write_text('PRIVATE-FIXTURE');(source/'scripts/unknown-local.py').write_text('PRIVATE-FIXTURE');(source/'web/.env.local').write_text('PRIVATE-FIXTURE');(source/'server/.data').mkdir();(source/'server/.data/db').write_text('PRIVATE-FIXTURE')
        wrong=source/'server/outline/bin/darwin-arm64';wrong.mkdir(parents=True);(wrong/'outline-bridge').write_text('wrong platform')
        runtime=source/'node_modules/yaml';runtime.mkdir(parents=True);(runtime/'dist').mkdir()
        (runtime/'package.json').write_text(json.dumps({'version':'2.9.1'}));(runtime/'dist/index.js').write_text('public');(runtime/'LICENSE').write_text('public')
        (source/'package-lock.json').write_text(json.dumps({'packages':{'node_modules/yaml':{'version':'2.9.1'}}}))
        private=source/'node_modules/not-runtime';private.mkdir();(private/'private').write_text('PRIVATE-FIXTURE')
        # A fresh Git checkout has no ignored Markdown documentation.
        shutil.rmtree(source/'docs')
        package.assemble(source,target)
        self.assertEqual((target/'LICENSE').read_text(),'public');self.assertTrue((target/'node_modules/yaml/dist/index.js').exists());self.assertTrue((target/'node_modules/yaml/LICENSE').exists())
        self.assertFalse((target/'node_modules/not-runtime').exists())
        for module in ['outline','access-points','lantern','tor']:
            binary=source/'server'/module/'bin/linux-amd64/fixture';binary.parent.mkdir(parents=True,exist_ok=True);binary.write_text('BINARY-FIXTURE')
        archive=source/'server/lantern/source/modified.tar.gz';archive.parent.mkdir(parents=True);archive.write_text('OUR-MODIFIED-SOURCES')
        reports=source/'docs/test-reports';reports.mkdir(parents=True);(reports/'private.json').write_text('PRIVATE-FIXTURE')
        licenses=source/'docs/licenses';licenses.mkdir();(licenses/'GPL.txt').write_text('public license')
        generated=source/'packaging/release-bundles';generated.mkdir();(generated/'linux-arm64.json').write_text('STALE-FIXTURE')
        installer=self.root/'installer';package.assemble(source,installer,installer=True)
        for module in ['outline','access-points','lantern','tor']:self.assertFalse((installer/'server'/module/'bin').exists())
        self.assertTrue((installer/'server/outline').is_dir());self.assertTrue((installer/'server/lantern/source/modified.tar.gz').is_file())
        self.assertTrue((installer/'docs/licenses/GPL.txt').is_file());self.assertFalse((installer/'docs/test-reports').exists());self.assertFalse((installer/'packaging/release-bundles').exists())
        (runtime/'package.json').write_text(json.dumps({'version':'wrong'}))
        with self.assertRaisesRegex(ValueError,'package-lock'):package.assemble(source,self.root/'mismatch-release')
        (runtime/'dist/index.js').unlink()
        with self.assertRaisesRegex(ValueError,'missing'):package.assemble(source,self.root/'missing-release')
        self.assertFalse((target/'PROJECT_STATUS.md').exists())
        self.assertFalse((target/'scripts/test-blanc-all.py').exists());self.assertFalse((target/'scripts/unknown-local.py').exists());self.assertFalse((target/'web/.env.local').exists());self.assertFalse((target/'server/.data').exists());self.assertFalse((target/'server/outline/bin/darwin-arm64').exists());self.assertTrue((target/'web/src').is_dir());self.assertTrue((target/'scripts/install.sh').exists())
        for file in target.rglob('*'):
            if file.is_file():self.assertNotIn('PRIVATE-FIXTURE',file.read_text())
    def test_release_rejects_script_path_escape(self):
        package=load('package_tree_bad','scripts/package-tree.py');source=self.root/'bad';(source/'packaging').mkdir(parents=True);(source/'packaging/release-scripts.json').write_text(json.dumps(['../../secret']))
        with self.assertRaises(ValueError):package.assemble(source,self.root/'bad-release')

    def test_journal_configuration_is_reloaded_when_rollback_removes_it(self):
        backup=self.tx.snapshot();journal=self.etc/'systemd/journald.conf.d/freedomgate.conf';journal.parent.mkdir(parents=True);journal.write_text('new journal settings');self.tx.restore(backup,restart=True)
        self.assertFalse(journal.exists());self.assertIn(['systemctl','try-restart','systemd-journald.service'],self.calls)
if __name__=='__main__':unittest.main()
