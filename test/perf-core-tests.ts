// Run every in-scope test file with 2 workers; keep per-file wall times and TAP logs.
import { readdirSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
const root = join(import.meta.dirname, '..');
const out = '/tmp/perf-core/tests'; mkdirSync(out, {recursive:true});
const previous = existsSync(join(out,'results.json')) ? JSON.parse(readFileSync(join(out,'results.json'),'utf8')) : {elapsedMs:0,results:[]};
const results: any[] = previous.results;
const allFiles = readdirSync(join(root, 'test')).filter(f=>f.endsWith('.test.ts') && !f.includes('runner') && !f.startsWith('remote-')).sort();
const pending = allFiles.filter(f=>!results.some(r=>r.file==='test/'+f));
const files = process.env.PERF_TEST_LIMIT ? pending.slice(0,Number(process.env.PERF_TEST_LIMIT)) : pending;
let next = 0;
const started = performance.now();
const active = new Set<ReturnType<typeof spawn>>();
function stop(pid: number) {
    let children: number[]=[];
    try {children=readFileSync(`/proc/${pid}/task/${pid}/children`,'utf8').trim().split(/\s+/).filter(Boolean).map(Number);} catch {}
    for(const id of children) stop(id);
    try {process.kill(pid,'SIGTERM');} catch {}
}
process.on('SIGTERM',()=>{for(const child of active) if(child.pid) stop(child.pid);process.exitCode=143;next=files.length;});
async function worker() {
    while (next < files.length) {
        const file = files[next++]; const t = performance.now();
        const child = spawn(process.execPath, ['--test','--test-concurrency=1','--test-reporter=tap','test/'+file], {cwd:root,stdio:['ignore','pipe','pipe']});
        active.add(child);
        let log = ''; let timedOut=false;
        const logFile=join(out,file+'.tap'); writeFileSync(logFile,'');
        const onData=(b:Buffer)=>{log+=b;appendFileSync(logFile,b);};
        child.stdout.on('data',onData); child.stderr.on('data',onData);
        const timer=setTimeout(()=>{timedOut=true;if(child.pid)stop(child.pid);},Number(process.env.PERF_TEST_CAP_MS??180000));
        const code = await new Promise(r=>child.once('exit',r)); clearTimeout(timer);
        active.delete(child);
        const row = {file:'test/'+file,wallMs:performance.now()-t,code,timedOut}; results.push(row);
        writeFileSync(join(out,'results.json'),JSON.stringify({elapsedMs:previous.elapsedMs+performance.now()-started,results},null,2));
        console.log(`${results.length}/${allFiles.length} ${file} ${(row.wallMs/1000).toFixed(2)}s code=${code}`);
    }
}
await Promise.all([worker(),worker()]);
