import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../packages/harness/src/http.ts';
import { readConfig } from '../packages/harness/src/config.ts';
import { invoke } from '../packages/harness/tests/http-harness.ts';
import { evaluateSuite, type EvaluationSuite } from '../packages/skills/src/evaluation.ts';
import type { QueryResponse } from '../contracts/index.ts';
const dir=await mkdtemp(join(tmpdir(),'codegraph-integrate-'));
const config=readConfig({DATA_DIR:dir});const app=await createApplication(config);
const jsonHeaders={'content-type':'application/json'};
try{
 const verified=await(await invoke(app.server,'/api/examples/verify',{method:'POST',headers:jsonHeaders,body:'{}'})).json();
 const suite=JSON.parse(await readFile(new URL('../packages/skills/data/evaluation.dev.json',import.meta.url),'utf8')) as EvaluationSuite;
 const report=await evaluateSuite(suite,async request=>{const r=await invoke(app.server,'/api/query',{method:'POST',headers:jsonHeaders,body:JSON.stringify(request)});if(!r.ok)throw new Error('HTTP_STATUS');return await r.json() as QueryResponse;});
 const checks:Record<string,boolean>={examples:verified.verified===35,development:report.totals.passed===suite.cases.length};
 for(const path of ['/','/styles.css','/app.js','/api-client.js','/helpers.js','/api/health','/api/schema'])checks[path]=(await invoke(app.server,path)).ok;
 const batch=await(await invoke(app.server,'/api/batch',{method:'POST',headers:jsonHeaders,body:JSON.stringify({questions:['查询 getAllFood 方法','payOrder 的 MQ 消息链路'],complexity:'medium'})})).json();
 checks.batch=batch.results?.length===2&&batch.results.every((r:QueryResponse)=>r.status==='success');
 if(batch.results?.[0]){const markdown=await invoke(app.server,`/api/runs/${batch.results[0].id}/report`);checks.markdown=markdown.ok&&(await markdown.text()).includes('standalone-workbench');}
 const evidence={transport:'in-process-http-handler',createdAt:new Date().toISOString(),checks,exampleVerification:verified,evaluation:report};
 const out=new URL('../docs/validation/',import.meta.url);await mkdir(out,{recursive:true});await writeFile(new URL('integration.json',out),JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify({checks,examples:verified.verified,evaluation:report.totals,failedCases:report.cases.filter(c=>!c.passed).map(c=>({id:c.id,assertions:c.assertions}))},null,2));
 if(Object.values(checks).some(v=>!v))process.exitCode=1;
}finally{await app.close();await rm(dir,{recursive:true,force:true});}
