import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

interface Owner { id: string; name: string; module: string; paths: string[]; }
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../ownership.json', import.meta.url), 'utf8')) as { owners: Owner[] };
const excludedDirectories = new Set(['.git', '.runtime', 'node_modules', 'artifacts', 'coverage', '__pycache__', '.pytest_cache', '.venv', '.cache']);
const excludedNames = new Set(['.DS_Store', 'credentials.json', 'secrets.json', 'id_rsa', 'id_ed25519']);
const excludedSuffix = /\.(zip|log|pyc|pyo|tmp|bak|pem|key|p12|pfx|jks)$/i;
function safePath(path: string): boolean {
  return !!path && !path.startsWith('/') && !path.includes('\\') && !/[\x00-\x1f]/.test(path) && !path.split('/')[0].includes(':') && !path.split('/').some(part => !part || part === '.' || part === '..');
}
function isExcluded(path: string): boolean {
  const parts = path.split('/'); const name = parts.at(-1)!;
  return parts.some(part => excludedDirectories.has(part)) || excludedNames.has(name) || excludedSuffix.test(name) || (name.startsWith('.env') && name !== '.env.example');
}
function ownersOf(file: string): Owner[] {
  return manifest.owners.filter(owner => owner.paths.some(prefix => prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix));
}
async function walk(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    const path = relative(root, absolute).replaceAll('\\', '/');
    if (isExcluded(path)) continue;
    if (!safePath(path) || entry.isSymbolicLink()) throw new Error(`Unsafe path or symlink: ${path}`);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Non-regular source path: ${path}`);
  }
  return files;
}

async function main(): Promise<void> {
  if (manifest.owners.length !== 4 || new Set(manifest.owners.map(owner => owner.id)).size !== 4) throw new Error('Four distinct owners are required');
  for (const owner of manifest.owners) for (const prefix of owner.paths) if (!safePath(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix)) throw new Error('Invalid ownership prefix');
  const args = process.argv.slice(2);
  let owner: Owner | undefined; let list = false; let staged = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--owner') {
      const id = args[++i]; owner = manifest.owners.find(item => item.id === id);
      if (!owner) throw new Error('Unknown or missing --owner');
    } else if (args[i] === '--list') list = true;
    else if (args[i] === '--staged') staged = true;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (list && staged) throw new Error('--list and --staged are mutually exclusive');
  if (staged && !owner) throw new Error('--staged requires --owner');
  if (staged) {
    // Read only. Include both paths in a staged rename by disabling rename detection.
    const files = execFileSync('git', ['diff', '--cached', '--name-only', '--no-renames', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    const outside = files.filter(path => !safePath(path) || isExcluded(path) || ownersOf(path).length !== 1 || ownersOf(path)[0].id !== owner!.id);
    if (outside.length) throw new Error('Staged paths outside this module or excluded from delivery:\n' + outside.join('\n'));
    console.log(`${owner!.name}: ${files.length} staged path(s) are within scope. No Git changes performed.`);
    return;
  }
  const files = (await walk(root)).sort();
  const invalid = files.filter(path => ownersOf(path).length !== 1);
  if (invalid.length) throw new Error('Missing or overlapping ownership:\n' + invalid.join('\n'));
  if (list) {
    for (const path of files.filter(path => !owner || ownersOf(path)[0].id === owner.id)) console.log(path);
    return;
  }
  for (const item of manifest.owners) console.log(`${item.name} (${item.module}): ${files.filter(path => ownersOf(path)[0].id === item.id).length} files`);
  console.log(`PASS: ${files.length} files, exactly one owner each.`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Ownership check failed'); process.exitCode = 1; });
