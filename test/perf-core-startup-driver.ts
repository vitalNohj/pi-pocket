import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
const out='/tmp/perf-core';const records:any[]=[];
for(let i=0;i<3;i++) {
 const dir=mkdtempSync(join(out,'startup-data-'));
 cpSync(join(out,'fixture-data'),dir,{recursive:true,mode:constants.COPYFILE_FICLONE});
 const file=join(out,`startup-${i}.json`);const t=performance.now();
 const child=spawn(process.execPath,['--import','./test/perf-core-startup.ts','test/serve.ts','8977','127.0.0.7'],{cwd:join(import.meta.dirname,'..'),env:{...process.env,PERF_START_DATA:dir,PERF_START_METRICS:file},stdio:['ignore','pipe','pipe']});
 const exit=new Promise(r=>child.once('exit',r));let log='';
 const ready=new Promise<void>((resolve,reject)=>{child.stdout.on('data',b=>{log+=b;if(log.includes('  owner: ')) resolve();});child.stderr.on('data',b=>log+=b);child.once('exit',()=>reject(Error(log)));});
 try{await ready;records.push({launchToReadyMs:performance.now()-t,...JSON.parse(readFileSync(file,'utf8'))});}finally{child.kill('SIGTERM');await exit;rmSync(dir,{recursive:true,force:true});}
 console.log(records.at(-1));
}
writeFileSync(join(out,'startup-summary.json'),JSON.stringify(records,null,2));
