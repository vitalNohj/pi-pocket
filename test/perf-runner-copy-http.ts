// Real throwaway node test/serve.ts server, scripted model, runner and pi-env.
import {fork,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,createReadStream,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import WebSocket from 'ws';
// Isolate the runner environment before dynamic application imports.
const root=mkdtempSync(join(tmpdir(),'pi-pocket-runner-http-'));
process.env.PI_CODING_AGENT_DIR=join(root,'agent');process.env.PI_POCKET_DIR=join(root,'pocket');
const repo=join(root,'repo');mkdirSync(repo,{recursive:true});
const {Runner}=await import('../src/runner/runner.ts');
const {RequestGate}=await import('../src/runner/request-gate.ts');
const idleNetworkOnly=process.env.PERF_IDLE_NETWORK_ONLY==='1';
const idleMs=Number(process.env.PERF_IDLE_MS??20000);
const phases:any={};let phase='setup';
function m(){return phases[phase]??={requests:{},paths:{},ws:{},ms:[]};}
const input=RequestGate.prototype.input;
RequestGate.prototype.input=function(b){if(b[4]===1){const j=JSON.parse(b.subarray(13,13+b.readUInt32BE(9)).toString());m().requests[j.op]=(m().requests[j.op]??0)+1;const key=j.op+':'+(j.path??j.cwd??'');m().paths[key]=(m().paths[key]??0)+1;}return input.call(this,b);};
const send=WebSocket.prototype.send;
WebSocket.prototype.send=function(d:any,...a:any[]){let key=Buffer.isBuffer(d)?'binary':'control';try{if(key==='control')key=JSON.parse(String(d)).type;}catch{}m().ws[key]=(m().ws[key]??0)+1;m().ws.bytes=(m().ws.bytes??0)+(Buffer.isBuffer(d)?d.length:Buffer.byteLength(String(d)));return (send as any).call(this,d,...a);};
for(let d=0;d<50;d++){const dir=join(repo,`pkg-${d}`);mkdirSync(dir);for(let i=0;i<100;i++)writeFileSync(join(dir,`file-${i}.ts`),`export const value = ${i};\n`);}
writeFileSync(join(repo,'AGENTS.md'),'Use a plain style.\n');
for(let i=0;i<60;i++){const dir=join(repo,'.pi','skills',`skill-${i}`);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'SKILL.md'),`---\nname: skill-${i}\ndescription: An example skill ${i}.\n---\n\nRead the code.\n`);}
for(const args of [['init','-q'],['add','.'],['-c','user.name=Perf','-c','user.email=perf@example.invalid','commit','-qm','fixture']])execFileSync('git',args,{cwd:repo});
for(let i=0;i<100;i++)writeFileSync(join(repo,'pkg-0',`file-${i}.ts`),`export const changed = ${i};\n`);
const large=join(root,'large.bin');writeFileSync(large,Buffer.alloc(50*1024*1024,65));
const site=createServer((req,res)=>{if(req.url==='/large.bin'){res.writeHead(200,{'content-type':'application/octet-stream','content-length':50*1024*1024});createReadStream(large).pipe(res);return;}res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><title>Performance fixture</title><h1>Loading</h1><script>fetch("/large.bin").then(r=>r.arrayBuffer()).then(b=>{document.querySelector("h1").textContent="Done "+b.byteLength;console.log("perf-complete-"+b.byteLength)}).catch(e=>console.error("perf-error",e));</script>');});
await new Promise<void>(r=>site.listen(0,'127.0.0.8',r));const siteURL=`http://127.0.0.8:${(site.address() as any).port}`;
const server=fork('test/serve.ts',['8907','127.0.0.8'],{silent:true,execArgv:['--expose-gc','--cpu-prof','--cpu-prof-dir=/tmp/pi-pocket-runner-perf-profiles','--import','/tmp/pi-pocket-runner-serve-preload.mjs'],env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:'/home/nohj/.cache/ms-playwright'}});
let log='';server.stdout!.on('data',b=>log+=b.toString());server.stderr!.on('data',b=>log+=b.toString());
const sleep=(n:number)=>new Promise(r=>setTimeout(r,n));
async function until(f:()=>boolean,ms=30000){const t=performance.now();while(!f()){if(performance.now()-t>ms)throw new Error('timeout '+log.slice(-300));await sleep(5);}}
const snapshots:any={};
async function snap(key:string){return new Promise<void>(resolve=>{const f=(r:any)=>{if(r.kind==='perf-snapshot'&&r.key===key){snapshots[key]=r;server.off('message',f);resolve();}};server.on('message',f);server.send({kind:'perf-snapshot',key});});}
const runners:any[]=[];const streams:AbortController[]=[];
const base='http://127.0.0.8:8907';let token='';
async function api(path:string,body?:any){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-pocket':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});const text=await r.text();if(!r.ok)throw new Error(r.status+' '+text);try{return JSON.parse(text);}catch{return text;}}
async function addRunner(n:number){const {code}=await api('/api/runners/code',{name:`Profile ${n}`});const linked=await api('/runner/link',{code});const runner=new Runner({link:{server:base,...linked},version:'perf',cwd:repo,settings:()=>({confirm:false,folders:[repo]}),ask:async()=>({allow:true}),log:()=>{}});runners.push(runner);runner.start();await until(()=>runner.connected);return linked.id;}
async function measure(name:string,n:number,f:()=>Promise<any>){phase=name;for(let i=0;i<n;i++){const t=performance.now();const v=await f();m().ms.push(performance.now()-t);if(i===0)m().value=v;}console.log(name,JSON.stringify(m()));}
async function sessionEvents(id:any){const controller=new AbortController();streams.push(controller);const state:any={text:'',views:0,firstView:0,firstEcho:0};const t=performance.now();const response=await fetch(base+`/api/events?c=${id}&p=4`,{headers:{authorization:`Bearer ${token}`,'accept-encoding':'identity'},signal:controller.signal});void(async()=>{try{for await(const chunk of response.body as any){const s=Buffer.from(chunk).toString();state.text+=s;if(s.includes('event: view')){state.views++;state.firstView ||=performance.now()-t;}if(state.text.includes('echo:')&&!state.firstEcho)state.firstEcho=performance.now();}}catch{}})();await until(()=>state.firstView>0);return state;}
try{
 await until(()=>log.includes('owner: '));token=new URL(/owner: (\S+)/.exec(log)![1]!).searchParams.get('token')!;
 await snap('zero');
 if(idleNetworkOnly)await measure('zero-idle20',1,async()=>{await sleep(idleMs);await snap('zero-idle-end');});
 const rid=await addRunner(1);await sleep(1100);await snap('one');
 if(idleNetworkOnly)await measure('one-idle20',1,async()=>{await sleep(idleMs);await snap('one-idle-end');});
 if(process.env.PERF_LINKS_ONLY==='1'){
  await measure('add9-beforeFeatures',1,async()=>{for(let i=2;i<=10;i++)await addRunner(i);});await sleep(1100);await snap('ten-beforeFeatures');
  await measure('ten-beforeFeatures-idle',1,async()=>{await sleep(idleMs);await snap('ten-beforeFeatures-idle-end');});
 }else{
 for(const [name,more] of [['local',{}],['remote',{runner:rid}]] as const){
 let id:any;await measure(`${name}-create`,1,async()=>{id=(await api('/api/sessions',{cwd:repo,...more})).id;return id;});
 let events:any;if(!idleNetworkOnly){await measure(`${name}-open-SSE`,1,async()=>{events=await sessionEvents(id);return events.firstView;});
 await measure(`${name}-cold-first-answer`,1,async()=>{const t=performance.now();await api(`/api/c/${id}/submit`,{text:'perf-prompt',requestId:crypto.randomUUID()});await until(()=>events.firstEcho>0);return events.firstEcho-t;});
 for(const [path,label] of [['view?path=.','files-root'],['changes','changes100'],['branches','branches'],['files','mentions']] as const)await measure(`${name}-${label}`,3,async()=>JSON.stringify(await api(`/api/c/${id}/${path}`)).length);
 }
 if(name==='remote'||idleNetworkOnly){
 await snap(name+'-busy-after-panels');
 await measure(`browser-${name}-cold-fetch50MiB`,1,async()=>{const state=await api(`/api/c/${id}/browser/navigate`,{url:siteURL});const t=performance.now();let latest:any;while(performance.now()-t<30000){latest=await api(`/api/c/${id}/browser/console`);if(JSON.stringify(latest).includes('perf-complete-52428800'))return {state,console:latest};await sleep(100);}throw new Error('Browser did not finish '+JSON.stringify(latest));});
 await measure(`browser-${name}-warm-fetch50MiB`,1,async()=>{await api(`/api/c/${id}/browser/clear`,{});await api(`/api/c/${id}/browser/reload`,{});const t=performance.now();while(performance.now()-t<30000){const c=await api(`/api/c/${id}/browser/console`);if(JSON.stringify(c).includes('perf-complete-52428800'))return c;await sleep(100);}throw new Error('warm Browser timeout');});
 }
 streams.at(-1)?.abort();
 }
 if(!idleNetworkOnly)await measure('isolated-idle30seconds',1,async()=>{const t=performance.now();await snap('idle-start');await sleep(30000);await snap('idle-end');return performance.now()-t;});
 await measure('add9',1,async()=>{for(let i=2;i<=10;i++)await addRunner(i);});await sleep(1100);await snap('ten');
 if(idleNetworkOnly)await measure('ten-idle20',1,async()=>{await sleep(idleMs);await snap('ten-idle-end');});
 }
}catch(e){console.error(e);phases.error=String(e);}finally{
 for(const s of streams)s.abort();for(const r of runners)await r.stop();server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));site.closeAllConnections();await new Promise(r=>site.close(r));
 writeFileSync(process.env.PERF_HTTP_OUT??'/tmp/pi-pocket-runner-http-results.json',JSON.stringify({root,phases,snapshots,log},null,2));rmSync(root,{recursive:true,force:true});
}
