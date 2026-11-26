import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToolService } from '../packages/tools/src/index.ts';
import { loadSkillBundle } from '../packages/skills/src/index.ts';
import { checkCase, type EvaluationSuite } from '../packages/skills/src/evaluation.ts';
import { createHarness } from '../packages/harness/src/runner.ts';
import { createModelClient } from '../packages/harness/src/model.ts';
import type { AgentConfig, Limits } from '../contracts/index.ts';

const dry=process.argv.includes('--dry-run');
if(process.argv.slice(2).some(a=>a!=='--dry-run'))throw new Error('Use --dry-run or no arguments');
const skill=await loadSkillBundle();
const suite=JSON.parse(await readFile(new URL('../packages/skills/data/evaluation.dev.json',import.meta.url),'utf8')) as EvaluationSuite;
const limits:Limits={maxRows:100,maxDepth:4,timeoutMs:60000,maxRepairs:1,maxModelCalls:4,maxToolCalls:40};
const providers=[{mode:'deepseek',model:'deepseek-flash',base:'https://api.deepseek.com',key:'DEEPSEEK_API_KEY',cases:['DEV-01','DEV-04','DEV-07']},{mode:'glm',model:'glm-5.3',base:'https://open.bigmodel.cn/api/paas/v4',key:'GLM_API_KEY',cases:['DEV-01']}] as const;
const report:any={createdAt:new Date().toISOString(),kind:'live-api-on-fixture',graph:'fixture',runtime:'standalone-workbench',maxRequests:16,requestAttempts:0,models:[],limitations:['人工fixture和固定Cypher模板，仅测试接入和证据链，不是课程真实Neo4j验收或模型能力排名。']};
const dir=await mkdtemp(join(tmpdir(),'codegraph-live-'));
const tools=await createToolService({graph:{mode:'fixture'},dataDir:dir,seedPath:skill.seedPath,semanticLexiconPath:skill.semanticLexiconPath,limits});
try{
 if(!dry)await tools.examples.verify();
 for(const spec of providers){
  const record:any={model:spec.model,provider:spec.mode,status:dry?'dry_run':'not_tested',requests:[],cases:[]};report.models.push(record);
  if(dry)continue;
  const key=process.env[spec.key];if(!key){record.status='missing_key';continue;}
  const config:AgentConfig={graphMode:'fixture',modelMode:spec.mode,modelName:spec.model,apiBaseUrl:spec.base,apiKey:key};
  const observed:typeof fetch=async(url,init)=>{
   const request:any={httpStatus:null,responseModel:null,networkCode:null};record.requests.push(request);report.requestAttempts++;
   if(report.requestAttempts>16)throw new Error('LIVE_REQUEST_LIMIT');
   try{const response=await fetch(url,init);request.httpStatus=response.status;
    if(response.ok){try{const body=await response.clone().json() as {model?:unknown};if(typeof body.model==='string'&&/^(glm|deepseek)-[A-Za-z0-9._:-]{1,100}$/.test(body.model)&&!body.model.includes(key))request.responseModel=body.model;}catch{}}
    return response;
   }catch(error){const c=(error as {cause?:{code?:string};name?:string}).cause?.code;request.networkCode=['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ENETUNREACH','ETIMEDOUT'].includes(c??'')?c:'NETWORK_OR_TIMEOUT';throw error;}
  };
  const model=createModelClient(config,observed);
  const agent=await createHarness({tools,skill,config,limits,model});
  for(const id of spec.cases){
   const item=suite.cases.find(c=>c.id===id)!;const start=performance.now();const r=await agent.run({question:item.question,complexity:item.complexity});
   const assertions=checkCase(item,r,{requiredGraphMode:'fixture',requiredModelMode:spec.mode});
   record.cases.push({id,status:r.status,passed:assertions.length===0,assertions,elapsedMs:Math.round(performance.now()-start),errorCode:r.error?.code??null,usage:r.usage,evidenceCount:r.evidenceIds?.length??0,nodeCount:r.result.graph.nodes.length,source:r.source});
   if(['MODEL_NETWORK_ERROR','MODEL_HTTP_ERROR','MODEL_NOT_CONFIGURED','TIMEOUT'].includes(r.error?.code??''))break;
  }
  record.status=record.cases.length===spec.cases.length&&record.cases.every((c:any)=>c.passed)?'passed':'not_passed';
 }
}finally{await tools.close();await rm(dir,{recursive:true,force:true});}
if(!dry){const folder=fileURLToPath(new URL('../.runtime/',import.meta.url));await mkdir(folder,{recursive:true,mode:0o700});await writeFile(join(folder,'live-api-report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}
console.log(JSON.stringify(report,null,2));
if(!dry&&report.models.some((m:any)=>!['passed','plan_endpoint_responded'].includes(m.status)))process.exitCode=1;
