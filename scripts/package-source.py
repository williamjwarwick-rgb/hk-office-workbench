#!/usr/bin/env python3
"""Package only this public project's reviewed sources; no identity or runtime data."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import argparse
import json

ROOT = Path(__file__).resolve().parents[1]
TOP_FILES = {
    'README.md', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'tsconfig.json', 'vite.config.ts', 'vite-env.d.ts', 'index.html',
    'src.tsx', '.gitignore',
}
TOP_DIRS = {'.github', 'app', 'lib', 'public', 'data', 'docs', 'scripts', 'tests'}
EXCLUDED_DIRS = {'node_modules', 'dist', '.git', '.openai', '.sites-runtime',
                 '.wrangler', '__pycache__', 'private', 'backups', 'server'}

def source_files():
    for path in sorted(ROOT.rglob('*')):
        relative = path.relative_to(ROOT)
        if path.is_symlink() or not path.is_file():
            continue
        if any(part in EXCLUDED_DIRS for part in relative.parts):
            continue
        if relative.parts[0] not in TOP_DIRS and str(relative) not in TOP_FILES:
            continue
        if path.name.startswith(('.env', '.dev.vars')) or path.suffix in {'.zip', '.lock', '.tmp', '.pyc'}:
            continue
        if path.name.endswith('.tsbuildinfo'):
            continue
        yield path, relative

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default=str(ROOT / 'public/downloads/source.zip'))
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    files = list(source_files())
    with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
        for path, relative in files:
            archive.write(path, Path('hk-office-workbench') / relative)
    print(json.dumps({'file': str(output), 'files': len(files), 'bytes': output.stat().st_size}))

if __name__ == '__main__':
    main()
