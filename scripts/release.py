#!/usr/bin/env python3
"""Package disjoint module submissions and verify their exact source reconstruction.

No Git command is executed. HANDOFF-*.json and release-manifest.json describe
delivery packages; they are outside the project tree and are not commit inputs.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
from zipfile import BadZipFile, ZIP_DEFLATED, ZipFile, ZipInfo


PROJECT_DIRECTORY = 'codegraph-text2cypher-agent'
EXCLUDED_DIRECTORIES = {
    '.git', '.runtime', 'node_modules', 'artifacts', 'coverage', '__pycache__',
    '.pytest_cache', '.venv', '.cache',
}
EXCLUDED_NAMES = {'.DS_Store', 'credentials.json', 'secrets.json', 'id_rsa', 'id_ed25519'}
EXCLUDED_SUFFIXES = {'.zip', '.log', '.pyc', '.pyo', '.tmp', '.bak', '.pem', '.key', '.p12', '.pfx', '.jks'}
SECRET_PATTERN = re.compile(rb'sk-[A-Za-z0-9]{20,}|[a-fA-F0-9]{32}\.[A-Za-z0-9]{12,}')
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_relative(value, directory=False):
    if not isinstance(value, str) or not value or '\\' in value or any(ord(char) < 32 for char in value):
        raise ValueError('Invalid relative path')
    normalized = value[:-1] if directory and value.endswith('/') else value
    path = PurePosixPath(normalized)
    if path.is_absolute() or str(path) != normalized or ':' in path.parts[0] or any(part in ('', '.', '..') for part in path.parts):
        raise ValueError('Unsafe relative path: ' + value)
    return normalized


def excluded(relative):
    path = PurePosixPath(relative)
    return (
        any(part in EXCLUDED_DIRECTORIES for part in path.parts)
        or path.name in EXCLUDED_NAMES
        or path.suffix.lower() in EXCLUDED_SUFFIXES
        or (path.name.startswith('.env') and path.name != '.env.example')
    )


def read_ownership(root):
    manifest = json.loads((root / 'ownership.json').read_text(encoding='utf-8'))
    owners = manifest.get('owners', [])
    if len(owners) != 4 or len({owner['id'] for owner in owners}) != 4:
        raise ValueError('Exactly four distinct owners are required')
    for owner in owners:
        if not re.fullmatch(r'[a-z0-9-]+', owner['id']) or not re.fullmatch(r'[a-z0-9-]+', owner['module']):
            raise ValueError('Invalid owner or module identifier')
        for prefix in owner['paths']:
            safe_relative(prefix, directory=prefix.endswith('/'))
    return manifest


def owner_for(relative, owners):
    matched = [owner for owner in owners if any(
        relative.startswith(prefix) if prefix.endswith('/') else relative == prefix
        for prefix in owner['paths']
    )]
    if len(matched) != 1:
        raise ValueError('Missing or overlapping ownership: ' + relative)
    return matched[0]


def source_snapshot(root, ownership):
    files = {}
    for current, directories, names in os.walk(root, followlinks=False):
        current = Path(current)
        kept = []
        for name in sorted(directories):
            path = current / name
            relative = path.relative_to(root).as_posix()
            if excluded(relative):
                continue
            if path.is_symlink():
                raise ValueError('Symlink cannot be packaged: ' + relative)
            kept.append(name)
        directories[:] = kept
        for name in sorted(names):
            path = current / name
            relative = safe_relative(path.relative_to(root).as_posix())
            if excluded(relative):
                continue
            if path.is_symlink() or not path.is_file():
                raise ValueError('Only regular files can be packaged: ' + relative)
            owner = owner_for(relative, ownership['owners'])
            data = path.read_bytes()
            if SECRET_PATTERN.search(data):
                raise ValueError('Potential credential pattern; inspect without printing secrets: ' + relative)
            files[relative] = {
                'data': data, 'sha256': digest(data), 'bytes': len(data),
                'owner': owner['id'], 'mode': stat.S_IMODE(path.stat().st_mode),
            }
    if not files:
        raise ValueError('No project files found')
    return dict(sorted(files.items()))


def source_records(snapshot):
    return [{'path': path, 'sha256': value['sha256'], 'bytes': value['bytes'], 'owner': value['owner']}
            for path, value in snapshot.items()]


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def package_name(index, owner):
    return '{:02d}-{}-{}.zip'.format(index + 1, owner['id'], owner['module'])


def build(root, output, ownership):
    snapshot = source_snapshot(root, ownership)
    generated_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    output.mkdir(parents=True, exist_ok=True)
    packages = []
    for index, owner in enumerate(ownership['owners']):
        assigned = {path: data for path, data in snapshot.items() if data['owner'] == owner['id']}
        if not assigned:
            raise ValueError('Owner has no files: ' + owner['id'])
        handoff_path = 'apps/web/HANDOFF.md' if owner['module'] == 'web' else 'packages/{}/HANDOFF.md'.format(owner['module'])
        if handoff_path not in assigned:
            raise ValueError('Owner handoff is missing: ' + handoff_path)
        package_manifest = {
            'formatVersion': 1, 'generatedAt': generated_at,
            'owner': {key: owner[key] for key in ('id', 'name', 'module')},
            'contractVersion': ownership['contractVersion'],
            'projectDirectory': PROJECT_DIRECTORY,
            'handoffPath': handoff_path,
            'commitScope': 'Only the listed paths under projectDirectory; this HANDOFF JSON is delivery metadata and must not be committed.',
            'dependencies': 'The complete application requires all four modules and the shared contracts supplied by the harness package.',
            'files': source_records(assigned),
        }
        name = package_name(index, owner)
        target = output / name
        # The snapshot makes every member and its checksum correspond to the same read.
        with ZipFile(target, 'w', ZIP_DEFLATED) as archive:
            archive.writestr('HANDOFF-{}.json'.format(owner['id']), json_bytes(package_manifest))
            for relative, item in assigned.items():
                member = ZipInfo(PROJECT_DIRECTORY + '/' + relative)
                # ZIP timestamp records packaging time, not a claimed development history.
                member.date_time = tuple(datetime.datetime.now().timetuple()[:6])
                member.create_system = 3
                member.external_attr = (stat.S_IFREG | item['mode']) << 16
                member.compress_type = ZIP_DEFLATED
                archive.writestr(member, item['data'])
        packages.append({
            'owner': owner['id'], 'name': name, 'files': len(assigned),
            'bytes': target.stat().st_size, 'sha256': digest(target.read_bytes()),
        })
    manifest = {
        'formatVersion': 1, 'generatedAt': generated_at,
        'contractVersion': ownership['contractVersion'], 'projectDirectory': PROJECT_DIRECTORY,
        'files': source_records(snapshot), 'packages': packages,
    }
    (output / 'release-manifest.json').write_bytes(json_bytes(manifest))
    verification = verify(root, output, ownership)
    return {'outputDirectory': str(output), 'packages': packages, **verification}


def verify(root, output, ownership):
    expected = source_snapshot(root, ownership)
    manifest = json.loads((output / 'release-manifest.json').read_text(encoding='utf-8'))
    if manifest.get('projectDirectory') != PROJECT_DIRECTORY or manifest.get('contractVersion') != ownership['contractVersion']:
        raise ValueError('Release manifest has incompatible project or contracts')
    if manifest.get('files') != source_records(expected):
        raise ValueError('Source changed or release manifest differs; rebuild after module changes finish')
    packages = manifest.get('packages', [])
    if len(packages) != 4:
        raise ValueError('Exactly four packages are required')
    seen = set()
    total_uncompressed = 0
    with tempfile.TemporaryDirectory(prefix='codegraph-four-package-') as directory:
        reconstructed = Path(directory) / PROJECT_DIRECTORY
        reconstructed.mkdir()
        for index, owner in enumerate(ownership['owners']):
            package = packages[index]
            if package.get('owner') != owner['id'] or package.get('name') != package_name(index, owner):
                raise ValueError('Unexpected package order or owner')
            archive_path = output / safe_relative(package['name'])
            raw_archive = archive_path.read_bytes()
            if digest(raw_archive) != package.get('sha256') or len(raw_archive) != package.get('bytes'):
                raise ValueError('Archive checksum mismatch: ' + package['name'])
            with ZipFile(archive_path) as archive:
                names = archive.namelist()
                if len(names) != len(set(names)):
                    raise ValueError('Duplicate ZIP member: ' + package['name'])
                handoff_name = 'HANDOFF-{}.json'.format(owner['id'])
                if handoff_name not in names:
                    raise ValueError('Missing package handoff manifest')
                declared = json.loads(archive.read(handoff_name))
                own = {path: item for path, item in expected.items() if item['owner'] == owner['id']}
                if declared.get('files') != source_records(own) or declared.get('owner', {}).get('id') != owner['id']:
                    raise ValueError('Package handoff disagrees with source ownership')
                if declared.get('projectDirectory') != PROJECT_DIRECTORY or declared.get('contractVersion') != ownership['contractVersion']:
                    raise ValueError('Package handoff has incompatible project or contracts')
                if package.get('files') != len(own):
                    raise ValueError('Package file count is incorrect')
                if set(names) != {handoff_name} | {PROJECT_DIRECTORY + '/' + path for path in own}:
                    raise ValueError('Package contains missing or unexpected paths')
                for member in archive.infolist():
                    safe_relative(member.filename)
                    unix_mode = member.external_attr >> 16
                    if stat.S_ISLNK(unix_mode) or member.is_dir():
                        raise ValueError('ZIP contains symlink or unexpected directory entry')
                    total_uncompressed += member.file_size
                    if total_uncompressed > MAX_ARCHIVE_BYTES:
                        raise ValueError('Archives exceed reconstruction size limit')
                    if member.filename == handoff_name:
                        continue
                    relative = safe_relative(member.filename[len(PROJECT_DIRECTORY) + 1:])
                    if relative in seen:
                        raise ValueError('File appears in multiple packages: ' + relative)
                    if excluded(relative) or owner_for(relative, ownership['owners'])['id'] != owner['id']:
                        raise ValueError('File is outside its owner scope: ' + relative)
                    data = archive.read(member)
                    if len(data) != expected[relative]['bytes'] or digest(data) != expected[relative]['sha256']:
                        raise ValueError('Reconstructed file checksum mismatch: ' + relative)
                    destination = reconstructed / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(data)
                    destination.chmod(stat.S_IMODE(unix_mode) or 0o644)
                    seen.add(relative)
        if seen != set(expected):
            raise ValueError('Four-package union is not the complete project')
        for relative, item in expected.items():
            if digest((reconstructed / relative).read_bytes()) != item['sha256']:
                raise ValueError('Extracted reconstruction mismatch: ' + relative)
    return {'verified': True, 'projectFiles': len(seen), 'duplicateFiles': 0, 'missingFiles': 0, 'reconstruction': 'byte-for-byte SHA-256 match'}


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', default=str(root.parent / 'deliveries-v2'))
    parser.add_argument('--verify-only', action='store_true', help='Verify existing packages against the current source tree')
    args = parser.parse_args()
    output = Path(args.output_dir).resolve()
    if output == root or root in output.parents:
        raise ValueError('Output directory must be outside the project tree')
    ownership = read_ownership(root)
    result = verify(root, output, ownership) if args.verify_only else build(root, output, ownership)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, BadZipFile) as error:
        raise SystemExit('Release check failed: ' + str(error))
