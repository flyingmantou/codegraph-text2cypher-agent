import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExampleStore } from '../src/examples.ts';
import { createGraphAdapter } from '../src/graph/index.ts';
import { setup, limits } from './helpers.ts';
import type { GraphPort } from '../../../contracts/index.ts';

const cancelled = () => new DOMException('Cancelled test operation', 'AbortError');

test('example search propagates cancellation into schema lookup and releases a hung waiter', {timeout: 2000}, async () => {
  const kit = await setup(); const graph = await createGraphAdapter({mode:'fixture'});
  let markStarted!: () => void; const started = new Promise<void>(resolve => markStarted=resolve);
  let observedSignal: AbortSignal | undefined;
  const slowGraph: GraphPort = {...graph, async getSchema(signal) { observedSignal=signal; markStarted(); return new Promise(() => {}); }};
  const store = new ExampleStore(kit.config.dataDir,kit.config.seedPath,kit.config.semanticLexiconPath,slowGraph,limits);
  await store.initialize(); const controller=new AbortController();
  try {
    const pending=store.searchWithMode('反向影响',undefined,true,'semantic',controller.signal);
    await started; assert.equal(observedSignal,controller.signal);
    controller.abort(cancelled()); await assert.rejects(pending,{name:'AbortError'});
  } finally {await graph.close();await kit.cleanup();}
});

test('cancelled list and queued edits return promptly and never mutate after the queue unblocks', {timeout: 3000}, async () => {
  const kit=await setup();const graph=await createGraphAdapter({mode:'fixture'});
  let markStarted!:()=>void; const started=new Promise<void>(resolve=>markStarted=resolve);
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let first=true;
  const slowGraph:GraphPort={...graph,async execute(query,limits,signal){if(first){first=false;markStarted();await gate;}return graph.execute(query,limits,signal);}};
  const store=new ExampleStore(kit.config.dataDir,kit.config.seedPath,kit.config.semanticLexiconPath,slowGraph,{...limits,timeoutMs:2500});
  await store.initialize(); const initial=await store.list();
  try {
    const verification=store.verify();await started;
    const controller=new AbortController();
    const waitingList=store.list(controller.signal);
    const waitingUpsert=store.upsert({...initial[0],id:'cancelled-edit'},controller.signal);
    const waitingDelete=store.delete(initial[0].id,controller.signal);
    const checks=[waitingList,waitingUpsert,waitingDelete].map(promise=>assert.rejects(promise,{name:'AbortError'}));
    controller.abort(cancelled());await Promise.all(checks);
    release();assert.equal((await verification).verified,3);
    const final=await store.list();assert.equal(final.length,3);assert.ok(final.some(item=>item.id===initial[0].id));assert.ok(final.every(item=>item.id!=='cancelled-edit'));
    const persisted=JSON.parse(await readFile(join(kit.config.dataDir,'examples.json'),'utf8'));
    assert.deepEqual(persisted.map((item:any)=>item.id),initial.map(item=>item.id));
  }finally{release();await graph.close();await kit.cleanup();}
});

test('cancelling whole-library verification discards partial statuses and keeps queue usable', {timeout: 3000}, async () => {
  const kit=await setup();const graph=await createGraphAdapter({mode:'fixture'});
  let calls=0;let markSecond!:()=>void;const second=new Promise<void>(resolve=>markSecond=resolve);let block=true;
  let graphCancelled=false;
  const slowGraph:GraphPort={...graph,async execute(query,limits,signal){
    calls++;
    if(block&&calls===2){markSecond();await new Promise<void>((_resolve,reject)=>{signal!.addEventListener('abort',()=>{graphCancelled=true;reject(signal!.reason);},{once:true});});}
    return graph.execute(query,limits,signal);
  }};
  const store=new ExampleStore(kit.config.dataDir,kit.config.seedPath,kit.config.semanticLexiconPath,slowGraph,{...limits,timeoutMs:2500});await store.initialize();
  const controller=new AbortController();
  try{
    const pending=store.verify(controller.signal);const failure=assert.rejects(pending,{name:'AbortError'});
    await second;controller.abort(cancelled());await failure;
    assert.equal(graphCancelled,true);assert.equal(calls,2);
    const remaining=await store.list();assert.ok(remaining.every(item=>item.verification.status==='unverified'));
    await assert.rejects(readFile(join(kit.config.dataDir,'examples.json'),'utf8'),{code:'ENOENT'});
    block=false;const retry=await store.verify();assert.equal(retry.verified,3);
    assert.ok((await store.list()).every(item=>item.verification.status==='verified'));
  }finally{await graph.close();await kit.cleanup();}
});
