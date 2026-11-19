// Read only the generated /tmp fixture, never the person's data.
import { root } from './helpers.ts';
import { PocketApp } from '../src/server/app.ts';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Harness } from '@earendil-works/pi-durable';
import { ExtensionLoader } from '../src/server/reload.ts';
import { Spend } from '../src/server/spend.ts';
import { Attribution } from '../src/server/attribution.ts';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
const metrics: any = { importsUptime: process.uptime(), calls: {}, counts: {} };
function wrap(target: any, key: string) { const old = target[key]; if(!old)return; target[key] = async function(...args: any[]) { const t=performance.now(); try{return await old.apply(this,args);}finally{metrics.calls[key]=(metrics.calls[key]??0)+performance.now()-t;metrics.counts[key]=(metrics.counts[key]??0)+1;} }; }
wrap(ModelRuntime,'create');wrap(Harness,'open');wrap(ExtensionLoader.prototype,'loadAll');
const instrumentedHarnessOpen=Harness.open.bind(Harness);
Harness.open=async (...args:any[])=>{const harness=await instrumentedHarnessOpen(...args);wrap(harness,'snapshot');return harness;};
wrap(Spend.prototype,'load');wrap(Attribution.prototype,'recover');
const original = PocketApp.open.bind(PocketApp);
PocketApp.open = async (options: any) => {
    const dir = process.env.PERF_START_DATA!;
    const t=performance.now(); const app = await original({...options,dataDir:dir});
    metrics.openMs=performance.now()-t; metrics.appUptime=process.uptime();
    writeFileSync(process.env.PERF_START_METRICS!,JSON.stringify(metrics));
    return app;
};
