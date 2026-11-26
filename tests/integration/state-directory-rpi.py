#!/usr/bin/env python3
"""Root-only isolated systemd/SQLite ownership regression; never touches live state."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import shlex
import pwd

if os.geteuid() != 0:
    raise SystemExit('root required')
name = 'freedomgate-state-lab'
state = Path('/var/lib') / name
node = '/opt/freedomgate/runtime/node/bin/node'
units = ['fg-state-lab-web', 'fg-state-lab-helper']

def run(*args, check=True):
    return subprocess.run(args, check=check, text=True, capture_output=True)

def transient(unit, properties, command):
    args = ['systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--unit=' + unit]
    for prop in properties:
        args.extend(['-p', prop])
    return run(*args, *command, check=False)

if state.exists():
    raise SystemExit('lab directory already exists')
web = ['User=freedomgate', 'Group=freedomgate', 'StateDirectory=' + name,
       'StateDirectoryMode=0700', 'UMask=0077', 'ProtectSystem=strict']
helper = ['User=root', 'Group=root', 'ProtectSystem=strict']
create = [node, '-e', 'const db=new(require("node:sqlite").DatabaseSync)(process.argv[1]);db.exec("CREATE TABLE IF NOT EXISTS probe(value TEXT); INSERT INTO probe VALUES (char(111,107))");', str(state / 'probe.sqlite')]
read = ['runuser', '-u', 'freedomgate', '--', node, '-e', 'const db=new(require("node:sqlite").DatabaseSync)(process.argv[1]);if(db.prepare("PRAGMA integrity_check").get().integrity_check!=="ok")process.exit(1);console.log(db.prepare("SELECT count(*) AS n FROM probe").get().n)', str(state / 'probe.sqlite')]
unit_paths = []
report = {'schemaVersion': 1, 'scope': 'isolated systemd StateDirectory / SQLite', 'cycles': []}
try:
    assert transient(units[0], web, create).returncode == 0
    assert transient(units[1], helper + ['StateDirectory=' + name, 'StateDirectoryMode=0750'], ['/usr/bin/true']).returncode == 0
    old = run(*read, check=False)
    assert old.returncode != 0 and 'unable to open database file' in old.stderr
    report['originalFailureReproduced'] = True
    for cycle in range(1, 6):
        assert transient(units[0], web, create).returncode == 0
        # Restart helper while web-owned data exists: this previously stole ownership.
        assert transient(units[1], helper + ['ReadWritePaths=' + str(state)], ['/usr/bin/touch', str(state / 'helper-marker')]).returncode == 0
        result = run(*read)
        info = state.stat()
        assert info.st_uid == pwd.getpwnam('freedomgate').pw_uid
        assert info.st_mode & 0o777 == 0o700
        report['cycles'].append({'cycle': cycle, 'sqliteIntegrity': 'ok', 'preservedRows': int(result.stdout.strip()), 'directoryOwner': 'freedomgate', 'directoryMode': '0700'})
    # Joint cold starts use actual ordered units, not an inferred start sequence.
    for unit, properties, command, ordering in [
        (units[0], web, create, ''),
        (units[1], helper + ['ReadWritePaths=' + str(state)], ['/usr/bin/true'], 'Before=' + units[0] + '.service\n')
    ]:
        path = Path('/run/systemd/system') / (unit + '.service')
        if path.exists():
            raise RuntimeError('lab unit already exists')
        path.write_text('[Unit]\n' + ordering + '[Service]\nType=oneshot\nRemainAfterExit=yes\n' + '\n'.join(properties) + '\nExecStart=' + ' '.join(shlex.quote(arg) for arg in command) + '\n')
        unit_paths.append(path)
    run('systemctl', 'daemon-reload')
    report['jointColdStarts'] = []
    for cycle in range(1, 6):
        run('systemctl', 'start', *(unit + '.service' for unit in units))
        assert run('systemctl', 'is-active', *(unit + '.service' for unit in units)).stdout.split() == ['active', 'active']
        count = int(run(*read).stdout.strip())
        report['jointColdStarts'].append({'cycle': cycle, 'bothActive': True, 'sqliteIntegrity': 'ok', 'preservedRows': count})
        run('systemctl', 'stop', *(unit + '.service' for unit in units))
    report['passed'] = True
finally:
    for unit in units:
        run('systemctl', 'stop', unit + '.service', check=False)
        run('systemctl', 'reset-failed', unit + '.service', check=False)
    for path in unit_paths:
        path.unlink(missing_ok=True)
    if unit_paths:
        run('systemctl', 'daemon-reload')
    shutil.rmtree(state, ignore_errors=True)
report['cleanedUp'] = not state.exists()
print(json.dumps(report, indent=2))
