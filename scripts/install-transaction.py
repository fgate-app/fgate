#!/usr/bin/env python3
"""Snapshot installer-owned links/units; never overwrite migrated user data on rollback."""
import datetime,json,os,pathlib,shutil,subprocess,sys,tempfile

UNITS=('freedomgate-network.service','freedomgate.service')
class InstallTransaction:
    def __init__(self,base='/opt/freedomgate',etc='/etc',state='/var/lib/freedomgate',run=subprocess.run):
        self.base,self.etc,self.state=map(pathlib.Path,(base,etc,state));self.run=run
    def snapshot(self):
        parent=self.base/'deploy-backups';parent.mkdir(parents=True,exist_ok=True)
        backup=pathlib.Path(tempfile.mkdtemp(prefix=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-installer-',dir=parent));backup.chmod(0o700)
        paths={'current':self.base/'current','node':self.base/'runtime/node',**{unit:self.etc/'systemd/system'/unit for unit in UNITS},'env':self.etc/'freedomgate/freedomgate.env','journal':self.etc/'systemd/journald.conf.d/freedomgate.conf'}
        records={}
        for key,path in paths.items():
            row={'path':str(path),'kind':'absent'}
            if path.is_symlink():row.update(kind='link',target=os.readlink(path))
            elif path.is_file():
                shutil.copy2(path,backup/key);row.update(kind='file',file=key)
            elif path.is_dir():
                if key!='node':raise ValueError('The native release path must be a symlink, not a directory.')
                row['kind']='directory'
            records[key]=row
        services={unit:{field:self.run(['systemctl',command,'--quiet',unit],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0 for field,command in [('active','is-active'),('enabled','is-enabled')]} for unit in UNITS}
        (backup/'transaction.json').write_text(json.dumps({'records':records,'services':services}));return backup
    def activate_node(self,backup,target):
        backup=pathlib.Path(backup);path=self.base/'runtime/node'
        if path.is_dir() and not path.is_symlink():path.rename(backup/'legacy-node')
        path.parent.mkdir(parents=True,exist_ok=True);path.parent.chmod(0o755)
        pending=path.with_name('node.next');pending.unlink(missing_ok=True);pending.symlink_to(target);pending.replace(path)
    def backup_state(self,backup):
        if self.state.exists():shutil.copytree(self.state,pathlib.Path(backup)/'state',symlinks=True)
    def restore(self,backup,restart=False):
        backup=pathlib.Path(backup);data=json.loads((backup/'transaction.json').read_text())
        journal=data['records']['journal'];journal_path=pathlib.Path(journal['path'])
        journal_changed=(journal['kind']=='file' and (not journal_path.is_file() or journal_path.read_bytes()!=(backup/journal['file']).read_bytes())) or (journal['kind']=='absent' and journal_path.exists())
        if restart:
            self.run(['systemctl','stop',*reversed(UNITS)],check=False)
            for unit,row in data['services'].items():
                if not row['enabled']:self.run(['systemctl','disable',unit],check=False,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        for key,row in data['records'].items():
            path=pathlib.Path(row['path'])
            if row['kind']=='directory':
                if (backup/'legacy-node').exists():
                    if path.is_symlink():path.unlink()
                    (backup/'legacy-node').rename(path)
                continue
            if row['kind']=='absent':path.unlink(missing_ok=True);continue
            path.parent.mkdir(parents=True,exist_ok=True)
            pending=path.with_name(path.name+'.rollback');pending.unlink(missing_ok=True)
            if row['kind']=='link':pending.symlink_to(row['target'])
            else:shutil.copy2(backup/row['file'],pending)
            pending.replace(path)
        if restart:
            self.run(['systemctl','daemon-reload'],check=True)
            if journal_changed:self.run(['systemctl','try-restart','systemd-journald.service'],check=False)
            for unit,row in data['services'].items():
                if row['enabled']:self.run(['systemctl','enable',unit],check=True)
                if row['active']:self.run(['systemctl','start',unit],check=True)
            for unit,row in data['services'].items():
                if not row['active']:self.run(['systemctl','stop',unit],check=False)

if __name__=='__main__':
    transaction=InstallTransaction();op=sys.argv[1]
    if op=='snapshot':print(transaction.snapshot())
    elif op=='node':transaction.activate_node(sys.argv[2],sys.argv[3])
    elif op=='state':transaction.backup_state(sys.argv[2])
    elif op=='restore':transaction.restore(sys.argv[2],restart='--restart' in sys.argv[3:])
    else:raise SystemExit('Unknown installer transaction operation.')
