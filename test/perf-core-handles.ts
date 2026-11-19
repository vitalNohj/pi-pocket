// Timer/teardown diagnostics for an isolated test file; never touches live sessions.
import { cleanUp } from './helpers.ts';
import { PocketApp } from '../src/server/app.ts';
import { createHook } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
const timers=new Map<number,any>();
createHook({init(id,type,_trigger,resource){if(type==='Timeout')timers.set(id,{resource,stack:new Error().stack});},destroy(id){timers.delete(id);}}).enable();
const original=PocketApp.prototype.close;
PocketApp.prototype.close=function(){const t=performance.now();console.log('PERF CLOSE START',process.pid,t);return original.call(this).finally(()=>console.log('PERF CLOSE END',process.pid,performance.now()-t));};
const observer=setInterval(()=>{console.log('PERF HANDLES',process.pid,JSON.stringify({at:performance.now(),resources:process.getActiveResourcesInfo(),timers:[...timers.values()].filter(x=>x.resource.hasRef()).map(x=>({ms:x.resource._idleTimeout,stack:x.stack})),handles:(process as any)._getActiveHandles().map((x:any)=>({type:x.constructor.name,local:x.localPort,remote:x.remotePort,readable:x.readable,writable:x.writable}))}));},15000);
observer.unref();process.on('exit',cleanUp);
