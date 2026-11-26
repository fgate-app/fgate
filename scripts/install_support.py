"""Shared verified downloads and relocatable links for installation tools."""
import os
import subprocess
import hashlib
import pathlib
import shutil
import urllib.request


def digest(path):
    with pathlib.Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verified_download(url, path, sha256):
    path = pathlib.Path(path)
    if os.environ.get('FREEDOMGATE_RESOURCE_JOB'):
        subprocess.run([os.environ['FREEDOMGATE_RESOURCE_NODE'],os.environ['FREEDOMGATE_RESOURCE_SCRIPT'],url,str(path),sha256],check=True)
        if digest(path)!=sha256:raise ValueError('SHA-256 mismatch')
        return
    request = urllib.request.Request(url, headers={'User-Agent': 'FreedomGate-installer'})
    try:
        with urllib.request.urlopen(request, timeout=120) as response, path.open('wb') as out:
            shutil.copyfileobj(response, out)
        if digest(path) != sha256:
            raise ValueError('SHA-256 mismatch: ' + url)
    except Exception:
        path.unlink(missing_ok=True)
        raise


def initial_link(link, target):
    """Seed a module only on first install; preserve separately installed updates."""
    link = pathlib.Path(link)
    if link.exists():
        return
    pending = link.with_name(link.name + '.next')
    pending.unlink(missing_ok=True)
    pending.symlink_to(target, target_is_directory=True)
    pending.replace(link)


def public_directory(path, root):
    """Public artifacts only; never change permissions above the explicit output root."""
    path, root = pathlib.Path(path).resolve(), pathlib.Path(root).resolve()
    path.relative_to(root)
    path.mkdir(parents=True, exist_ok=True)
    for directory in [path, *path.parents]:
        directory.chmod(0o755)
        if directory == root: break


def public_tree(root):
    root = pathlib.Path(root)
    for path in [root, *root.rglob('*')]:
        if path.is_symlink(): continue
        path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)


def elf_architecture(path):
    with pathlib.Path(path).open('rb') as source: header = source.read(20)
    if len(header) != 20 or header[:4] != b'\x7fELF' or header[4] != 2 or header[5] not in (1, 2):
        raise ValueError('A 64-bit ELF binary is required')
    machine = int.from_bytes(header[18:20], 'little' if header[5] == 1 else 'big')
    if machine not in (62, 183): raise ValueError('Unsupported module architecture')
    return {62: 'linux-amd64', 183: 'linux-arm64'}[machine]


def module_stage(module, action, progress):
    if module=='frp':progress=int(os.environ.get('FREEDOMGATE_MODULE_PROGRESS_BASE',0))+progress*int(os.environ.get('FREEDOMGATE_MODULE_PROGRESS_SPAN',100))//100
    os.environ['FREEDOMGATE_ACTIVE_MODULE']=module
    print(f'FG_MODULE_STAGE {module} {action} {progress}',flush=True)
