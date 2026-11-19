// Measurement only. Run from checkout with --expose-gc, --cpu-prof, CPUQuota=200%.
// This imports test/helpers first, isolating data and Pi config before application imports.
import { cleanUp, root, work, home, context, openApp, owner, say, scriptedModel, lastText, loadTools } from './helpers.ts';
import { performance } from 'node:perf_hooks';
import { createHook } from 'node:async_hooks';
import { syncBuiltinESMExports } from 'node:module';
import cp from 'node:child_process';
import fp from 'node:fs/promises';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { Runner } from '../src/runner/runner.ts';
import { RunnerLink } from '../src/server/runners.ts';
import { RequestGate } from '../src/runner/request-gate.ts';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { readFolder, scanFolder, scanSettings, copyUploads, uploadsFolder } from '../src/server/remote-context.ts';
import { withDesignMirror } from '../src/server/design/mirror.ts';
import { createHandler } from '../src/server/http.ts';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

const output = process.env.PERF_OUT ?? '/tmp/pi-pocket-runner-perf-results.json';
type Metric = { ms: number[]; requests: Record<string, number>; rpcMs: Record<string, number[]>; gateMs: Record<string, number[]>; daemonMs: Record<string, number[]>; realpathN: number; realpathMs: number; ws: Record<string, number>; frameMs: number; frameN: number; outboxPeak: number; cpu?: NodeJS.CpuUsage; memory?: NodeJS.MemoryUsage; value?: unknown };
const results: Record<string, Metric> = {};
let phase = 'setup';
let delayMs = 0;
function metric(): Metric { return results[phase] ??= { ms: [], requests: {}, rpcMs: {}, gateMs: {}, daemonMs: {}, realpathN: 0, realpathMs: 0, ws: {}, frameMs: 0, frameN: 0, outboxPeak: 0 }; }
function sample(obj: Record<string, number[]>, k: string, ms: number) { (obj[k] ??= []).push(ms); }
function inc(obj: Record<string, number>, k: string, n = 1) { obj[k] = (obj[k] ?? 0) + n; }
const timers = new Map<number, { interval: number; stack?: string }>();
let captureTimers = false;
createHook({ init(id, type, _trigger, resource: any) { if(type==='Timeout') timers.set(id, { interval: resource._idleTimeout, ...(captureTimers ? {stack: new Error().stack?.split('\n').slice(2,7).join('\n')} : {}) }); }, destroy(id) { timers.delete(id); } }).enable();
const realpath = fp.realpath;
fp.realpath = (async (...args: any[]) => { const m = metric(), t = performance.now(); m.realpathN++; try { return await (realpath as any)(...args); } finally { m.realpathMs += performance.now()-t; } }) as any;
const inputStarts = new Map<number, { t: number; op: string; m: Metric; daemon?: number }>();
const gateInput = RequestGate.prototype.input;
RequestGate.prototype.input = function(b) { if(b[4] === 1) { const len = b.readUInt32BE(9), j = JSON.parse(b.subarray(13, 13+len).toString()); inputStarts.set(b.readUInt32BE(5), { t: performance.now(), op: j.op, m: metric() }); } return gateInput.call(this,b); };
const gateOutput = RequestGate.prototype.output;
RequestGate.prototype.output = function(b) { const id=b.readUInt32BE(5), s=inputStarts.get(id); if(s && (b[4]===2 || b[4]===3)) { if(s.daemon) sample(s.m.daemonMs,s.op,performance.now()-s.daemon); inputStarts.delete(id); } return gateOutput.call(this,b); };
const spawn = cp.spawn;
const daemons: any[] = [];
cp.spawn = ((program: any, args: any[], opts: any) => { const child = spawn(program,args,opts); if(String(program).includes('pi-env') && args?.[0]==='serve') { daemons.push(child); const write=child.stdin!.write; child.stdin!.write = function(b:any,...rest:any[]) { if(Buffer.isBuffer(b) && b.length>=13 && b[4]===1) { const s=inputStarts.get(b.readUInt32BE(5)); if(s) { s.daemon=performance.now(); sample(s.m.gateMs,s.op,s.daemon-s.t); } } return (write as any).call(this,b,...rest); }; } return child; }) as any;
syncBuiltinESMExports();
const request = RunnerLink.prototype.request;
RunnerLink.prototype.request = async function(op,json,opts,scope) { const m=metric(), t=performance.now(); inc(m.requests,op); try { return await request.call(this,op,json,opts,scope); } finally { sample(m.rpcMs,op,performance.now()-t); } };
const wsSend = WebSocket.prototype.send;
WebSocket.prototype.send = function(data:any,...args:any[]) { const m=metric(); const binary = Buffer.isBuffer(data) || data instanceof Uint8Array; inc(m.ws,binary?'binaryN':'controlN'); inc(m.ws,binary?'binaryBytes':'controlBytes', binary ? data.length : Buffer.byteLength(String(data))); if(!binary) { try { inc(m.ws,JSON.parse(String(data)).type); } catch {} } if(delayMs>0 && this.url?.includes('/runner/socket') || delayMs>0 && (this as any)._isServer) { const socket=this; setTimeout(()=> { if(socket.readyState===WebSocket.OPEN) (wsSend as any).call(socket,data,...args); },delayMs); } else return (wsSend as any).call(this,data,...args); } as any;
const { FrameSplitter, Outbox } = await import('../src/runner/protocol.ts');
const split = FrameSplitter.prototype.push;
FrameSplitter.prototype.push = function(b) { const m=metric(), t=performance.now(); try { const f=split.call(this,b); m.frameN+=f.length; return f; } finally { m.frameMs+=performance.now()-t; } };
const outWrite=Outbox.prototype.write;
Outbox.prototype.write=function(b) { const r=outWrite.call(this,b); metric().outboxPeak=Math.max(metric().outboxPeak,this.unacknowledged); return r; };
const sleep=(n:number)=>new Promise(r=>setTimeout(r,n));
async function until(f:()=>boolean) { const start=performance.now(); while(!f()) { if(performance.now()-start>30000)throw new Error('wait timeout'); await sleep(2); } }
function ok<T>(r: any): T { if(!r.ok)throw r.error; return r.value; }
async function measure(name:string, n:number, f:()=>Promise<unknown>) { phase=name; const m=metric(); const cpu=process.cpuUsage(); for(let i=0;i<n;i++) { const t=performance.now(); const value=await f(); m.ms.push(performance.now()-t); if(i===0 && (typeof value==='string'||typeof value==='number'||typeof value==='boolean'))m.value=value; } m.cpu=process.cpuUsage(cpu); m.memory=process.memoryUsage(); console.log(name,JSON.stringify({ms:m.ms,requests:m.requests,ws:m.ws,cpu:m.cpu})); writeFileSync(output,JSON.stringify({root,results},null,2)); }
function snapshot() { (globalThis as any).gc?.(); return { memory:process.memoryUsage(), timers:[...timers.values()], daemonPids:daemons.filter(d=>d.exitCode===null).map(d=>d.pid), daemonRSS:daemons.filter(d=>d.exitCode===null).map(d=>({pid:d.pid,status:readFileSync(`/proc/${d.pid}/status`,'utf8').split('\n').filter(l=>l.startsWith('VmRSS:'))[0]})) }; }
const snapshots:any={};
const runnerHome=join(root,'runner-home'), repo=join(root,'repository');
mkdirSync(runnerHome,{recursive:true}); mkdirSync(repo,{recursive:true});
const oldHome=process.env.HOME; process.env.HOME=runnerHome;
for(let d=0;d<50;d++) { const dir=join(repo,`pkg-${d}`);mkdirSync(dir,{recursive:true}); for(let i=0;i<100;i++)writeFileSync(join(dir,`file-${i}.ts`),`// module ${d}-${i}\nexport const data = ${JSON.stringify('example data '.repeat(100))};\n`); }
writeFileSync(join(repo,'AGENTS.md'),'# Rules\nUse TypeScript.\n');
writeFileSync(join(repo,'small.txt'),'Hello runner\n');
for(const dir of [join(repo,'.pi','skills'),join(repo,'.agents','skills'),join(runnerHome,'.agents','skills')])for(let i=0;i<20;i++){mkdirSync(join(dir,`skill-${i}`),{recursive:true});writeFileSync(join(dir,`skill-${i}`,'SKILL.md'),`---\nname: skill-${i}\ndescription: Useful example skill ${i}.\n---\n\nUse a real command.\n`);}
const run=(args:string[])=>cp.execFileSync(args[0]!,args.slice(1),{cwd:repo,stdio:'pipe'});
run(['git','init','-q']);run(['git','add','.']);run(['git','-c','user.name=Perf','-c','user.email=perf@example.invalid','commit','-qm','fixture']);
for(let i=0;i<100;i++)writeFileSync(join(repo,'pkg-0',`file-${i}.ts`),`export const changed = ${i};\n`);
const large=Buffer.alloc(50*1024*1024,65);writeFileSync(join(repo,'large.bin'),large);
writeFileSync(join(repo,'.gitignore'),'large.bin\nwrite-*.bin\n');
mkdirSync(join(repo,'.pi','design'),{recursive:true});for(let i=0;i<40;i++)writeFileSync(join(repo,'.pi','design',`sample-${i}.css`),`:root { --sample-${i}: #abcdef; }\n`);
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=','base64');
writeFileSync(join(repo,'pixel.png'),PNG);
let firstModel=0;
const app=await openApp(scriptedModel(input=>{firstModel=performance.now();const {role,text}=lastText(input as any);if(role==='user'&&text.startsWith('bg '))return fauxAssistantMessage([fauxToolCall('background',JSON.parse(text.slice(3)))],{stopReason:'toolUse'});return fauxAssistantMessage([fauxText('ok')]);}));
app.config.lastModel={provider:'faux',modelId:'faux-1',thinkingLevel:'off'};
const server=createServer(createHandler({app,listen:{host:'127.0.0.7',port:0},restart:()=>{}}));
server.on('upgrade',(r,s,h)=>{if(!app.runners.upgrade(r,s,h))s.destroy();});
await new Promise<void>(r=>server.listen(0,'127.0.0.7',r));const base=`http://127.0.0.7:${(server.address() as any).port}`;
const runners:Runner[]=[];
let runner:Runner;let rid:string;
async function addRunner(name:string) { const link=app.runners.redeem(app.runners.makeCode(name,owner(app).id).code); const r=new Runner({link:{server:base,...link},version:'perf',cwd:runnerHome,log:()=>{},settings:()=>({confirm:false,folders:[repo]}),ask:async()=>({allow:true})});runners.push(r);r.start();await until(()=>r.connected);return {runner:r,id:link.id}; }
let remoteId:any,localId:any;const backgroundIds:any[]=[];const tempFolders:string[]=[];
try {
  await sleep(100);snapshots.zero=snapshot();captureTimers=true;
  await measure('connect-cold',1,async()=>{({runner,id:rid}=await addRunner('Throwaway profile'));});
  snapshots.one=snapshot();captureTimers=false;
  await measure('create-remote-cold',1,async()=>{remoteId=(await app.commands.createSession(owner(app),{cwd:repo,runner:rid})).id;});
  await measure('create-local',1,async()=>{localId=(await app.commands.createSession(owner(app),{cwd:repo})).id;});
  const env=app.envFor(remoteId) as any, local=new NodeExecutionEnv({cwd:repo});
  if(process.env.PERF_COLD_TURN_ONLY) {
    for(const id of [localId,remoteId])await measure(id===localId?'cold-model-start-local':'cold-model-start-remote',1,async()=>{const t=performance.now();await say(app,id,'hello');return firstModel-t;});
  }else{
  if(!process.env.PERF_POST_PANELS) {
  for(const [label,e] of [['local',local],['remote',env]] as const){
    await measure(`${label}-read-small`,30,async()=>ok(await e.readTextFile('small.txt',context)));
    await measure(`${label}-write-small`,30,async()=>ok(await e.writeFile('write-small.txt','small\n',context)));
    await measure(`${label}-list-folder`,20,async()=>((ok<any[]>(await e.listDir('pkg-0',context))).length));
    await measure(`${label}-echo`,20,async()=>ok(await e.exec(['echo','hello'],{onOutput:()=>{}},context)));
    await measure(`${label}-parallel100-info`,5,async()=>{await Promise.all(Array.from({length:100},(_,i)=>e.fileInfo(`pkg-0/file-${i}.ts`,context).then(ok)));});
    await measure(`${label}-read50MiB`,3,async()=>ok<Uint8Array>(await e.readBinaryFile('large.bin',context)).length);
    await measure(`${label}-write50MiB`,3,async()=>ok(await e.writeFile(`write-${label}.bin`,large,context)));
    await measure(`${label}-output50MiB`,2,async()=>{let bytes=0;ok(await e.exec(['cat','large.bin'],{onOutput:(t:string)=>bytes+=Buffer.byteLength(t)},context));return bytes;});
  }
  for(const [label,id] of [['local',localId],['remote',remoteId]] as const){
    await measure(`${label}-files-root`,5,async()=>JSON.stringify(await app.workspace.viewFile(id,owner(app),'.')).length);
    await measure(`${label}-changes100dirty`,5,async()=>JSON.stringify(await app.workspace.changes(id,owner(app))).length);
    await measure(`${label}-branches`,5,async()=>JSON.stringify(await app.workspace.branches(id,owner(app))).length);
    await measure(`${label}-mentions-cold`,1,async()=>JSON.stringify(await app.workspace.fileList(id,owner(app))).length);
    await measure(`${label}-mentions-warm`,5,async()=>JSON.stringify(await app.workspace.fileList(id,owner(app))).length);
  }
  }
  await measure('context-shell',5,async()=>{const s=await readFolder(env,repo);return s.files.length;});
  scanSettings.shell=false;
  await measure('context-listing-fallback',2,async()=>{const s=await readFolder(env,repo);return s.files.length;});
  scanSettings.shell=true;
  await measure('context-cached',5,async()=>{await scanFolder(env,repo);});
  for(const id of [localId,remoteId])await measure(id===localId?'first-turn-local':'first-turn-remote',1,async()=>{const t=performance.now();await say(app,id,'hello');return firstModel-t;});
  await measure('warm-turn-remote',3,async()=>{const t=performance.now();await say(app,remoteId,'hello');return firstModel-t;});
  await measure('create-remote-samefolder',3,async()=>{await app.commands.createSession(owner(app),{cwd:repo,runner:rid});});
  const designHost={dataDir:app.dataDir,runnerOf:app.runnerOf.bind(app),envFor:app.envFor.bind(app)} as any;
  await measure('design-40files-cold',1,async()=>withDesignMirror(designHost,remoteId,repo,context,async()=>{}));
  await measure('design-40files-warm',3,async()=>withDesignMirror(designHost,remoteId,repo,context,async()=>{}));
  await measure('design-scan100sources-cold',1,async()=>withDesignMirror(designHost,remoteId,repo,context,async()=>{},'pkg-0'));
  await measure('design-scan100sources-warm',1,async()=>withDesignMirror(designHost,remoteId,repo,context,async()=>{},'pkg-0'));
  await measure('image-cold',1,async()=>{await app.workspace.imageFile(owner(app),remoteId,'pixel.png');});
  await measure('image-warm',10,async()=>{await app.workspace.imageFile(owner(app),remoteId,'pixel.png');});
  const folder=uploadsFolder(await env.connection.info(),app.runnerScope(remoteId).id);tempFolders.push(folder.folder,join((await env.connection.info()).tmpdir,'pi-pocket-tasks',app.runnerScope(remoteId).id));ok(await env.createDir(folder.folder,{recursive:true},context));
  const attach=join(root,'attachment.bin');writeFileSync(attach,large.subarray(0,10*1024*1024));
  await measure('attachment10MiB',3,async()=>JSON.stringify(await copyUploads(env,folder,[{path:attach,name:'attachment.bin'}])));
  delayMs=10;
  for(const [name,f] of [
    ['rtt20-read-small',()=>env.readTextFile('small.txt',context).then(ok)],
    ['rtt20-write-small',()=>env.writeFile('write-small.txt','x',context).then(ok)],
    ['rtt20-branches',()=>app.workspace.branches(remoteId,owner(app))],
    ['rtt20-changes',()=>app.workspace.changes(remoteId,owner(app))],
    ['rtt20-files',()=>app.workspace.viewFile(remoteId,owner(app),'.')],
    ['rtt20-context-shell',()=>readFolder(env,repo)],
    ['rtt20-design-warm',()=>withDesignMirror(designHost,remoteId,repo,context,async()=>{})],
    ['rtt20-read50MiB',()=>env.readBinaryFile('large.bin',context).then(ok)],
    ['rtt20-write50MiB',()=>env.writeFile('write-rtt.bin',large,context).then(ok)],
    ['rtt20-parallel100-info',()=>Promise.all(Array.from({length:100},(_,i)=>env.fileInfo(`pkg-0/file-${i}.ts`,context).then(ok)))],
  ] as const)await measure(name, name.includes('50MiB')||name.includes('design')?1:3, f);
  delayMs=0;
  await measure('reconnect-default',3,async()=>{runner.drop();await until(()=>!runner.connected);ok(await env.readTextFile('small.txt',context));});
  await measure('reconnect-output-kept',1,async()=>{let text='';const p=env.exec(['sh','-c','echo before; sleep 0.1; cat large.bin'],{onOutput:(t:string)=>{text+=t.slice(0,10);}},context);await sleep(10);runner.drop();ok(await p);return text.length;});
  await sleep(1100);
  snapshots.idleOne=snapshot();
  await measure('idle30seconds',1,async()=>{await sleep(30000);});
  await loadTools(app,remoteId,'background');
  await say(app,remoteId,'bg '+JSON.stringify({action:'start',command:'sleep 90',label:'idle task',notify:false}));
  const tasks=await app.background.list(remoteId);backgroundIds.push(...tasks.map(t=>({conversation:remoteId,id:t.id})));
  await measure('background-idle12seconds',1,async()=>{await sleep(12000);});
  await say(app,remoteId,'bg '+JSON.stringify({action:'start',command:'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do echo workload-output; sleep 1; done',label:'output task',notify:false}));
  backgroundIds.push(...(await app.background.list(remoteId)).map(t=>({conversation:remoteId,id:t.id})));
  await measure('background-busy12seconds',1,async()=>{await sleep(12000);});
  for(const {conversation,id} of backgroundIds)await app.background.stop(conversation,id).catch(()=>{});
  await sleep(1100);
  snapshots.beforeMany=snapshot();captureTimers=true;
  await measure('connect-additional9',1,async()=>{for(let i=0;i<9;i++)await addRunner(`Profile ${i}`);});
  await sleep(100);snapshots.ten=snapshot();captureTimers=false;
  }
  phase='done';
  writeFileSync(output,JSON.stringify({root,base,results,snapshots},null,2));
} finally {
  delayMs=0;
  for(const {conversation,id} of backgroundIds)await app.background.stop(conversation,id).catch(()=>{});
  for(const r of runners)await r.stop();
  await app.close();server.closeAllConnections();await new Promise(r=>server.close(r));
  // Remove only the runner-owned transfer/task directories created by these throwaway permissions.
  for(const folder of tempFolders)rmSync(folder,{recursive:true,force:true});
  process.env.HOME=oldHome;
  cleanUp();
}
console.log('Saved',output);
