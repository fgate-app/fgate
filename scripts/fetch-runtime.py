#!/usr/bin/env python3
"""Install a pinned official runtime into a new directory after SHA-256 verification."""
import argparse,json,pathlib,tarfile,tempfile
from install_support import verified_download,public_directory,public_tree

def main():
    parser=argparse.ArgumentParser();parser.add_argument('runtime',choices=['node','go']);parser.add_argument('--platform',required=True,choices=['linux-arm64','linux-amd64']);parser.add_argument('--output',required=True,type=pathlib.Path);args=parser.parse_args()
    lock=json.loads((pathlib.Path(__file__).resolve().parents[1]/'packaging/runtime.lock.json').read_text())[args.runtime]
    asset=lock['platforms'][args.platform]
    public_directory(args.output.parent,args.output.parent)
    if args.output.exists():raise SystemExit('Runtime target already exists; use a new versioned directory')
    with tempfile.TemporaryDirectory(dir=args.output.parent) as work:
        root=pathlib.Path(work);archive=root/'runtime.tar';verified_download(asset['url'],archive,asset['sha256'])
        with tarfile.open(archive) as bundle:
            bundle.extractall(root/'unpacked',filter='data')
        folders=list((root/'unpacked').iterdir())
        if len(folders)!=1 or not folders[0].is_dir():raise ValueError('Unexpected runtime archive')
        folders[0].rename(args.output)
        public_tree(args.output)
    print(args.runtime+' '+lock['version']+' '+args.platform+': verified')
if __name__=='__main__':main()
