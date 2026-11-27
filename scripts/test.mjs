import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
async function walk(dir){const files=[];for(const entry of await readdir(dir,{withFileTypes:true})){if(['node_modules','.runtime','.git'].includes(entry.name))continue;const p=dir+'/'+entry.name;if(entry.isDirectory())files.push(...await walk(p));else if(/\.test\.(?:ts|mjs|js)$/.test(p))files.push(p);}return files;}
const files=[...await walk(root+'packages'),...await walk(root+'apps')].sort();
const r=spawnSync(process.execPath,['--test',...files],{cwd:root,stdio:'inherit'});process.exitCode=r.status??1;
