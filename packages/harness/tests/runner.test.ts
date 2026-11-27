import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolService } from '../../tools/src/index.ts';
import { loadSkillBundle } from '../../skills/src/index.ts';
import { createHarness } from '../src/runner.ts';
import { createModelClient } from '../src/model.ts';
import type { AgentConfig, Limits } from '../../../contracts/index.ts';

const limits:Limits={maxRows:100,maxDepth:4,timeoutMs:5000,maxRepairs:1,maxModelCalls:6,maxToolCalls:40};
async function setup(overrides:Partial<AgentConfig>={}, customLimits:Partial<Limits>={}){
 const dir=await mkdtemp(join(tmpdir(),'codegraph-v2-runner-'));const skill=await loadSkillBundle();const cap={...limits,...customLimits};
 const tools=await createToolService({graph:{mode:'fixture'},dataDir:dir,seedPath:skill.seedPath,semanticLexiconPath:skill.semanticLexiconPath,limits:cap});
 const config:AgentConfig={graphMode:'fixture',modelMode:'demo',modelName:'demo-rules-v2',...overrides};
 const agent=await createHarness({tools,skill,config,limits:cap});
 return {dir,skill,tools,config,agent,cap,async close(){await tools.close();await rm(dir,{recursive:true,force:true});}};
}

test('Skill workflow executes actual tools and returns verifiable evidence and report',async()=>{
 const app=await setup();try{
  assert.equal((await app.agent.verifyExamples()).verified,35);
  const r=await app.agent.run({question:'getAllFood 方法依赖哪些下游服务？'});
  assert.equal(r.status,'success');assert.ok(r.result.rows.length>0);assert.ok(r.examplesUsed.length>0);
  assert.equal(r.source.runtime,'standalone-workbench');assert.equal(r.source.skillVersion,app.skill.version);
  assert.ok(r.evidenceIds?.length);assert.match(r.reportMarkdown!,/getAllFood/);
  const stages=r.trace.map(t=>t.stage);assert.ok(stages.indexOf('validate_query')<stages.indexOf('execute_query'));
  assert.equal(r.usage.modelCalls,0);assert.ok(r.usage.toolCalls!>=5);
 }finally{await app.close();}
});

test('combined query is two executions with merged evidence, not a single combined template',async()=>{
 const app=await setup();try{
  const r=await app.agent.run({question:'查询 placeOrder 的 RPC 和 MQ 联合依赖'});
  assert.equal(r.status,'success');assert.equal(r.plan?.branches.length,2);
  assert.equal(r.trace.filter(t=>t.stage==='execute_query').length,2);assert.equal(r.evidenceIds?.length,3);
  assert.ok(r.trace.some(t=>t.stage==='merge_results'));assert.ok(r.result.graph.edges.length>0);
 }finally{await app.close();}
});

test('ambiguous entities pause before generation; only a candidate can resume',async()=>{
 const app=await setup();try{
  const r=await app.agent.run({question:'查询 getOrder 方法'});assert.equal(r.status,'needs_clarification');assert.equal(r.candidates.length,2);assert.equal(r.queries.length,0);
  const selected=await app.agent.run({question:r.question,entityId:r.candidates[0].id});assert.equal(selected.status,'success');
  const invalid=await app.agent.run({question:r.question,entityId:'method:getAllFood'});assert.equal(invalid.status,'rejected');
 }finally{await app.close();}
});

test('write intents, unknown entities, budgets, and aborts retain explicit states',async()=>{
 const app=await setup();try{
  assert.equal((await app.agent.run({question:'删除所有节点'})).status,'rejected');
  assert.equal((await app.agent.run({question:'查询 noSuchMethod 方法'})).status,'empty');
  const low=await createHarness({tools:app.tools,skill:app.skill,config:app.config,limits:{...limits,maxToolCalls:1}});
  assert.equal((await low.run({question:'查询 getAllFood 方法'})).error?.code,'TOOL_BUDGET_EXCEEDED');
  const aborted=await app.agent.run({question:'查询 getAllFood 方法'},AbortSignal.abort());assert.equal(aborted.error?.code,'TIMEOUT');assert.equal(aborted.usage.toolCalls,0);
 }finally{await app.close();}
});

test('live adapter follows provider JSON protocol and repairs invalid queries within budget',async()=>{
 const app=await setup({modelMode:'deepseek',modelName:'deepseek-flash',apiKey:'UNIT_TEST_NOT_A_KEY'});try{
  let generation=0;const requests:any[]=[];
  const mock:typeof fetch=async(_url,init)=>{
   const body=JSON.parse(String(init?.body));requests.push(body);
   const d=JSON.parse(body.messages[1].content);
   const value=d.branch? (++generation===1?{cypher:'MATCH (n) DELETE n',parameters:{}}:{cypher:app.tools.fixtureTemplates.entity,parameters:{entityId:d.selectedEntity.id,name:'',limit:100}}):app.skill.planDemo(d.question);
   return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}}));
  };
  const agent=await createHarness({tools:app.tools,skill:app.skill,config:app.config,limits,model:createModelClient(app.config,mock)});
  const r=await agent.run({question:'查询 getAllFood 方法'});assert.equal(r.status,'success');assert.equal(r.usage.modelCalls,3);assert.equal(r.usage.promptTokens,30);
  assert.ok(r.trace.some(t=>t.stage==='repair_generation'));assert.equal(r.trace.filter(t=>t.stage==='execute_query').length,1);
  for(const body of requests){assert.deepEqual(body.thinking,{type:'disabled'});assert.equal(body.response_format.type,'json_object');assert.ok(body.messages[0].content.includes(app.skill.instructions));assert.ok(!body.messages[0].content.includes(app.config.apiKey!));}
 }finally{await app.close();}
});

test('one failed branch returns partial evidence instead of pretending full success',async()=>{
 const app=await setup({modelMode:'deepseek'});try{
  const usage={promptTokens:1,completionTokens:1,complete:true};
  const agent=await createHarness({tools:app.tools,skill:app.skill,config:app.config,limits:{...limits,maxRepairs:0},model:{
   async plan(q){return {value:app.skill.planDemo(q),usage};},
   async generate(i){if(i.branch.category==='mq')throw Object.assign(new Error('private'),{code:'MODEL_NETWORK_ERROR'});return {value:{cypher:app.tools.fixtureTemplates.downstream,parameters:{entityId:i.entity!.id,name:'',limit:100}},usage};}
  }});
  const r=await agent.run({question:'placeOrder 的 RPC 和 MQ 联合依赖'});assert.equal(r.status,'partial');assert.equal(r.evidenceIds?.length,1);assert.ok(r.warnings.some(x=>x.includes('messaging')));assert.equal(r.usage.estimatedCostCny,null);assert.ok(!JSON.stringify(r).includes('private'));
 }finally{await app.close();}
});

test('runtime cannot load a Skill workflow that omits validation',async()=>{
 const app=await setup();try{await assert.rejects(()=>createHarness({tools:app.tools,skill:{...app.skill,stages:app.skill.stages.filter(s=>s!=='validate')},config:app.config,limits}),/关键校验/);}finally{await app.close();}
});

test('report budget failure preserves executed results as partial',async()=>{
 const app=await setup({}, {maxToolCalls:5});try{
  const r=await app.agent.run({question:'查询 getAllFood 方法'});assert.equal(r.status,'partial');assert.equal(r.result.rows.length,1);assert.equal(r.evidenceIds?.length,1);assert.equal(r.error?.code,'TOOL_BUDGET_EXCEEDED');
 }finally{await app.close();}
});

test('malformed model content retains reported tokens and actual limits reach the prompt',async()=>{
 const app=await setup({modelMode:'glm',apiKey:'UNIT_TEST_SECRET',modelName:'glm-5.3',inputPriceCnyPerMillion:1,outputPriceCnyPerMillion:1});try{
  const mock:typeof fetch=async(_url,init)=>{
   const body=JSON.parse(String(init?.body));const d=JSON.parse(body.messages[1].content);
   assert.deepEqual(body.thinking,{type:'enabled'});assert.equal(body.reasoning_effort,'low');
   if(d.branch){assert.equal(d.limits.maxRows,3);assert.equal(d.limits.maxDepth,2);assert.match(body.messages[0].content,/最多 3 行/);}
   return new Response(JSON.stringify({choices:[{message:{content:d.branch?'not valid JSON':JSON.stringify(app.skill.planDemo(d.question))}}],usage:{prompt_tokens:100,completion_tokens:20}}));
  };
  const r=await(await createHarness({tools:app.tools,skill:app.skill,config:app.config,limits:{...limits,maxRows:3,maxDepth:2},model:createModelClient(app.config,mock)})).run({question:'查询 getAllFood 方法'});
  assert.equal(r.status,'failed');assert.equal(r.usage.promptTokens,200);assert.equal(r.usage.completionTokens,40);assert.equal(r.usage.estimatedCostCny,0.00024);
  assert.ok(!r.warnings.some(w=>w.includes('未返回完整 token')));
 }finally{await app.close();}
});
