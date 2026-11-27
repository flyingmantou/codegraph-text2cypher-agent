import { randomUUID } from 'node:crypto';
import type { AgentConfig, AgentPort, ExecutionEvidence, GraphNode, GraphSchema, Limits, QueryExample, QueryRequest, QueryResponse, QuerySpec, SkillBundle, TaskBranch, TaskPlan, TicketValidation, ToolService, ExampleSearchResult } from '../../../contracts/index.ts';
import { createModelClient, validatePlan, type ModelClient, type ModelUsage } from './model.ts';

const STAGES=['schema','plan','entities','examples','generate','validate','execute','merge','report'];
const empty=()=>({columns:[],rows:[],graph:{nodes:[],edges:[]},truncated:false,durationMs:0});
const fail=(code:string,message:string)=>Object.assign(new Error(message),{code});
const SAFE_CODES=new Set(['UNSAFE_REQUEST','INVALID_REQUEST','UNSUPPORTED_DEMO_QUERY','MODEL_INVALID_PLAN','MODEL_INVALID_OUTPUT','MODEL_INVALID_JSON','MODEL_EMPTY_OUTPUT','MODEL_TRUNCATED_OUTPUT','MODEL_NOT_CONFIGURED','MODEL_NETWORK_ERROR','MODEL_HTTP_ERROR','INVALID_MODEL_URL','MODEL_INVALID_RESPONSE','INVALID_ENTITY','TOOL_BUDGET_EXCEEDED','MODEL_BUDGET_EXCEEDED','QUERY_VALIDATION_FAILED','ENTITY_SCOPE_MISMATCH','TIMEOUT','TOOL_FAILED','INVALID_TICKET','TICKET_CONTEXT_MISMATCH','SCHEMA_CHANGED','UNKNOWN_EVIDENCE','EVIDENCE_MISSING','INVALID_SKILL_WORKFLOW']);
function safeError(error:unknown,signal:AbortSignal){
 if(signal.aborted) return {code:'TIMEOUT',message:'任务已取消或超过总时限'};
 const e=error as {code?:string;message?:string};
 const code=e?.code&&SAFE_CODES.has(e.code)?e.code:'TOOL_FAILED';
 // External messages are never copied into public results.
 const messages:Record<string,string>={UNSAFE_REQUEST:'只读图谱任务不执行数据修改',INVALID_REQUEST:'输入不符合查询约定',UNSUPPORTED_DEMO_QUERY:'规则演示需要明确实体名称或支持的筛选问法',INVALID_ENTITY:'所选实体不属于本次候选',QUERY_VALIDATION_FAILED:'查询未通过校验，已停止执行',MODEL_NOT_CONFIGURED:'尚未配置服务端模型凭据',MODEL_BUDGET_EXCEEDED:'模型调用次数达到上限',TOOL_BUDGET_EXCEEDED:'工具调用次数达到上限',EVIDENCE_MISSING:'缺少实际执行证据，不能生成结论'};
 return {code,message:messages[code]??'该阶段未完成，请查看错误码并检查运行配置'};
}
interface BranchState {branch:TaskBranch;query?:QuerySpec;ticket?:string;repairs:number;error?:{code:string;message:string};examples:QueryExample[];}

/** Executes the versioned Skill stages; provider and graph operations remain separate ports. */
export async function createHarness(options:{tools:ToolService;skill:SkillBundle;config:AgentConfig;limits:Limits;model?:ModelClient}):Promise<AgentPort>{
 const {tools,skill,config,limits}=options;
 if(JSON.stringify(skill.stages)!==JSON.stringify(STAGES))throw fail('INVALID_SKILL_WORKFLOW','关键校验阶段不能缺失或重排');
 const model=options.model??createModelClient(config);
 async function run(request:QueryRequest,external?:AbortSignal):Promise<QueryResponse>{
  const signal=external?AbortSignal.any([external,AbortSignal.timeout(limits.timeoutMs)]):AbortSignal.timeout(limits.timeoutMs);
  const response:QueryResponse={id:randomUUID(),question:typeof request?.question==='string'?request.question.trim():'',status:'failed',summary:'',createdAt:new Date().toISOString(),source:{graph:config.graphMode,model:config.modelMode,graphVersion:'unknown',modelName:config.modelName,skillVersion:skill.version,runtime:'standalone-workbench'},queries:[],result:empty(),trace:[],usage:{modelCalls:0,toolCalls:0,promptTokens:0,completionTokens:0,estimatedCostCny:config.modelMode==='demo'?0:null},examplesUsed:[],candidates:[],warnings:[],evidenceIds:[]};
  if(config.graphMode==='fixture')response.warnings.push('人工样例图谱，不代表课程真实数据。');
  if(config.modelMode==='demo')response.warnings.push('规则演示模式，未调用大模型。');
  let schema:GraphSchema;let plan:TaskPlan;let entity:GraphNode|undefined;let stopped=false;let usageComplete=true;
  let branches:BranchState[]=[];const evidence:ExecutionEvidence[]=[];
  const trace=(stage:string,status:'ok'|'error'|'skipped',message:string,started:number)=>response.trace.push({stage,status,message,durationMs:Math.round(performance.now()-started)});
  const call=async<T>(name:string,args:Record<string,unknown>):Promise<T>=>{
   signal.throwIfAborted();
   if((response.usage.toolCalls??0)>=(limits.maxToolCalls??40))throw fail('TOOL_BUDGET_EXCEEDED','工具预算已用尽');
   response.usage.toolCalls=(response.usage.toolCalls??0)+1;const started=performance.now();
   const r=await tools.call<T>(name,args,{sessionId:response.id,limits,selectedEntityId:entity?.id,signal});
   signal.throwIfAborted();
   if(!r.ok){trace(name,'error',r.error?.code??'TOOL_FAILED',started);throw fail(r.error?.code??'TOOL_FAILED','工具未完成');}
   trace(name,'ok','工具完成',started);return r.data as T;
  };
  const modelCall=async<T>(fn:()=>Promise<{value:T;usage:ModelUsage}>):Promise<T>=>{
   signal.throwIfAborted();if(response.usage.modelCalls>=limits.maxModelCalls)throw fail('MODEL_BUDGET_EXCEEDED','模型预算已用尽');
   response.usage.modelCalls++;
   try{const r=await fn();response.usage.promptTokens+=r.usage.promptTokens;response.usage.completionTokens+=r.usage.completionTokens;usageComplete&&=r.usage.complete;return r.value;}
   catch(e){const u=(e as {usage?:ModelUsage})?.usage;if(u&&Number.isSafeInteger(u.promptTokens)&&u.promptTokens>=0&&Number.isSafeInteger(u.completionTokens)&&u.completionTokens>=0){response.usage.promptTokens+=u.promptTokens;response.usage.completionTokens+=u.completionTokens;usageComplete&&=u.complete;}else usageComplete=false;throw e;}
  };
  const generate=async(b:BranchState,error?:string)=>{
   const started=performance.now();const previous=b.query;
   if(config.modelMode==='demo')b.query={cypher:tools.fixtureTemplates[b.branch.category],parameters:b.branch.category==='filter'?{keyword:plan.entityTerm,limit:limits.maxRows}:{name:'',entityId:entity!.id,limit:limits.maxRows},label:b.branch.purpose};
   else b.query=await modelCall(()=>model.generate({question:response.question,schema,skill,branch:b.branch,entity,entityTerm:plan.entityTerm,examples:b.examples,templates:schema.source==='fixture'?tools.fixtureTemplates:undefined,previous,error,limits},signal));
   response.queries.push(structuredClone(b.query));trace(b.repairs?'repair_generation':'generation','ok',`${b.branch.id}：候选查询已生成`,started);
  };
  const validate=async(b:BranchState)=>{
   while(true){
    const checked=await call<TicketValidation>('validate_query',{query:b.query});
    if(checked.valid&&checked.ticket){b.ticket=checked.ticket;return;}
    if(config.modelMode==='demo'||b.repairs>=limits.maxRepairs)throw fail('QUERY_VALIDATION_FAILED','查询未通过校验');
    b.repairs++;await generate(b,checked.errors.map(e=>e.code).join(','));
   }
  };
  const branchError=(b:BranchState,error:unknown)=>{b.error=safeError(error,signal);response.warnings.push(`${b.branch.id}：${b.error.code}`);if(signal.aborted)throw error;};
  const stages:Record<string,()=>Promise<void>>={
   async schema(){schema=await call<GraphSchema>('get_schema',{});response.source.graph=schema.source;response.source.graphVersion=schema.version;},
   async plan(){
    if(!response.question||response.question.length>2000)throw fail('INVALID_REQUEST','问题无效');
    if(config.modelMode==='demo'&&schema.source!=='fixture')throw fail('UNSUPPORTED_DEMO_QUERY','真实图谱需要配置模型');
    plan=validatePlan(config.modelMode==='demo'?skill.planDemo(response.question):await modelCall(()=>model.plan(response.question,schema,skill,signal)));
    response.plan=plan;branches=plan.branches.map(branch=>({branch,repairs:0,examples:[]}));
   },
   async entities(){
    if(plan.category==='filter'){if(request.entityId)throw fail('INVALID_ENTITY','筛选任务不接收选定实体');return;}
    const candidates=await call<GraphNode[]>('resolve_entities',{term:plan.entityTerm});
    if(!candidates.length){response.status='empty';response.summary='未找到匹配实体，请检查名称或使用更明确的实体标识。';stopped=true;return;}
    if(request.entityId){entity=candidates.find(c=>c.id===request.entityId);if(!entity)throw fail('INVALID_ENTITY','实体不是本问题候选');}
    else if(candidates.length===1)entity=candidates[0];
    else{response.status='needs_clarification';response.candidates=candidates;response.summary='存在多个匹配实体，请选择后继续。';stopped=true;}
   },
   async examples(){
    for(const b of branches){
     const matches=await call<ExampleSearchResult[]>('search_examples',{question:response.question,category:b.branch.category,verifiedOnly:true,mode:'hybrid'});
     b.examples=matches.filter(m=>m.example.verification.status==='verified'&&m.example.verification.source===schema.source&&m.example.verification.graphVersion===schema.version).slice(0,3).map(m=>m.example);
     for(const e of b.examples)if(!response.examplesUsed.includes(e.id))response.examplesUsed.push(e.id);
    }
   },
   async generate(){for(const b of branches){try{await generate(b);}catch(e){branchError(b,e);}}},
   async validate(){for(const b of branches){if(b.error)continue;try{await validate(b);}catch(e){branchError(b,e);}}},
   async execute(){
    for(const b of branches){if(b.error)continue;
     while(true){try{const record=await call<ExecutionEvidence>('execute_query',{ticket:b.ticket});if(!record.executionId||!record.result)throw fail('EVIDENCE_MISSING','执行无证据');evidence.push(record);response.evidenceIds!.push(record.executionId);break;}
      catch(e){if(signal.aborted)throw e;if(config.modelMode==='demo'||b.repairs>=limits.maxRepairs){branchError(b,e);break;}b.repairs++;try{await generate(b,safeError(e,signal).code);await validate(b);}catch(repairError){branchError(b,repairError);break;}}
     }
    }
   },
   async merge(){
    if(!evidence.length){const e=branches.find(b=>b.error)?.error;throw fail(e?.code??'EVIDENCE_MISSING',e?.message??'没有可用证据');}
    if(evidence.length>1){const merged=await call<ExecutionEvidence>('merge_results',{executionIds:response.evidenceIds});response.result=merged.result;response.evidenceIds!.push(merged.executionId);}
    else response.result=evidence[0].result;
    const failed=branches.filter(b=>b.error).length;
    response.status=failed||response.result.truncated?'partial':response.result.rows.length?'success':'empty';
    response.summary=`${failed?'部分子任务完成。':''}查询返回 ${response.result.rows.length} 条记录、${response.result.graph.nodes.length} 个节点和 ${response.result.graph.edges.length} 条关系。${response.result.truncated?'结果达到上限，不能视为完整集合。':''}`;
    if(config.modelMode!=='demo')response.warnings.push('执行成功不等于查询语义正确，请核对实体、方向与证据。');
   },
   async report(){const r=await call<{markdown:string}>('export_report',{question:response.question,executionIds:evidence.map(e=>e.executionId)});response.reportMarkdown=r.markdown;},
  };
  try{
   for(const stage of skill.stages){if(stopped)break;signal.throwIfAborted();const started=performance.now();await stages[stage]();trace(stage,'ok',`Skill 阶段 ${stage} 完成`,started);}
  }catch(error){
   const e=safeError(error,signal);response.error=e;
   if(evidence.length){
    response.status='partial';
    if(!response.result.columns.length)response.result=evidence[0].result;
    response.summary=`${e.message}。已保留 ${evidence.length} 个实际执行证据；当前结果不代表完整任务完成。`;
    response.warnings.push('后续合并、报告或运行步骤未完成，请结合错误码核对已有结果。');
   }else{response.status=['UNSAFE_REQUEST','INVALID_REQUEST','INVALID_ENTITY'].includes(e.code)?'rejected':'failed';response.summary=e.message;}
   response.trace.push({stage:'runtime',status:'error',message:e.code,durationMs:0});
  }
  if(config.modelMode!=='demo'){
   if(!usageComplete)response.warnings.push('存在未返回完整 token 统计的调用，费用保持未知。');
   const a=config.inputPriceCnyPerMillion,b=config.outputPriceCnyPerMillion;
   if(usageComplete&&a!==undefined&&b!==undefined)response.usage.estimatedCostCny=(response.usage.promptTokens*a+response.usage.completionTokens*b)/1e6;
  }
  return response;
 }
 return {run,listExamples:()=>tools.examples.list(),searchExamples:(q,c)=>tools.examples.search(q,c,false),upsertExample:v=>tools.examples.upsert(v),deleteExample:id=>tools.examples.delete(id),verifyExamples:()=>tools.examples.verify()};
}
