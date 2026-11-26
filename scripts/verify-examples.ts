import { loadSkillBundle } from '../packages/skills/src/index.ts';
import { createToolService } from '../packages/tools/src/index.ts';
import { readConfig } from '../packages/harness/src/config.ts';
const config=readConfig();const skill=await loadSkillBundle();
const tools=await createToolService({graph:config.graph,dataDir:config.dataDir,seedPath:skill.seedPath,semanticLexiconPath:skill.semanticLexiconPath,limits:config.limits});
try{const result=await tools.examples.verify(AbortSignal.timeout(120000));console.log(JSON.stringify(result,null,2));if(result.failed)process.exitCode=1;}finally{await tools.close();}
