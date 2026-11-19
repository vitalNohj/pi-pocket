// A finite measurement run. It starts test/serve.ts on isolated loopback and always stops it.
import { root, cleanUp } from './helpers.ts';
import { Browsers } from '../src/server/browser.ts';
import { VIEWPORTS } from '../src/server/browser/viewport.ts';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
const out = '/tmp/perf-core'; mkdirSync(out, { recursive: true });
const count = Number(process.env.PERF_SESSIONS ?? 500);
const metrics = 'http://127.0.0.7:8978';
const base = 'http://127.0.0.7:8977';
const run: any = { count, date: new Date().toISOString() };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const probe = async (path: string) => { const res = await fetch(metrics + path); if (!res.ok) throw new Error(await res.text()); return res.json() as any; };
const phase = async (name: string) => probe(`/phase?name=${name}`);
let log = '';
const started = performance.now();
const child = spawn(process.execPath, ['--expose-gc', ...(!process.env.PERF_NO_CPU_PROF ? ['--cpu-prof', '--cpu-prof-dir=' + out, '--cpu-prof-name=process-' + count + '.cpuprofile'] : []), '--import', './test/perf-core-setup.ts', 'test/serve.ts', '8977', '127.0.0.7'], { cwd: join(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (b) => { log += b; process.stdout.write(b); });
child.stderr.on('data', (b) => { log += b; process.stderr.write(b); });
const exited = new Promise((resolve) => child.once('exit', resolve));
let browsers: Browsers | undefined;
let page: any;
try {
    const deadline = Date.now() + 15 * 60_000;
    while (!log.includes('  owner: ')) {
        if (child.exitCode !== null) throw new Error(`Copy exited ${child.exitCode}`);
        if (Date.now() > deadline) throw new Error('Copy startup timed out');
        await pause(100);
    }
    run.launchIncludingSeedMs = performance.now() - started;
    run.start = await probe('/state');
    await phase('no-tab');
    if (!process.env.PERF_SEED_ONLY) {
    if (count <= 50) {
        await pause(1500);
        run.idle0start = await probe('/state');
        if (!process.env.PERF_NO_CPU_PROF) await probe('/profile/start');
        await pause(60_000);
        if (!process.env.PERF_NO_CPU_PROF) await probe('/profile/stop?name=idle-no-tab');
        run.idle0end = await probe('/state');
    }
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, 'perf-browser-')), load: async () => undefined, save: () => {} });
    const browserStart = performance.now();
    page = await browsers.open(1);
    run.chromiumLaunchMs = performance.now() - browserStart;
    await page.setViewport(VIEWPORTS.mobile);
    const evaluate = async (script: string) => JSON.parse(await page.evaluate(script));
    const ready = async () => {
        const deadline = Date.now() + 60_000;
        while (!(await evaluate(`const {store}=await import('/store.js'); return JSON.stringify(store.state.sessionsLoaded && store.state.connection === 'open');`))) {
            if (Date.now() > deadline) throw new Error('App not ready');
            await pause(20);
        }
    };
    await phase('first-load');
    await page.navigate(`${base}/login?token=${encodeURIComponent(run.start.token)}`);
    await ready();
    run.pageLoad = await evaluate(`return JSON.stringify({now:performance.now(),navigation:performance.getEntriesByType('navigation').map(e=>e.toJSON()), resources:performance.getEntriesByType('resource').map(e=>({name:e.name.replace(location.origin,''),type:e.initiatorType,start:e.startTime,duration:e.duration,transfer:e.transferSize,encoded:e.encodedBodySize,decoded:e.decodedBodySize})),rows:document.querySelectorAll('.home-list .session-row').length});`);
    await pause(2000);
    run.rowsSettled = await evaluate(`return JSON.stringify({rows:document.querySelectorAll('.home-list .session-row').length,now:performance.now()})`);
    if (count <= 50) {
        await evaluate(`const {store,navigate}=await import('/store.js'); navigate(${run.start.ids[1]}); while(store.state.view?.conversation?.id!==${run.start.ids[1]}) await new Promise(r=>setTimeout(r,20)); return JSON.stringify(true);`);
        await phase('one-tab');
        await pause(1000);
        run.idle1start = await probe('/state');
        if (!process.env.PERF_NO_CPU_PROF) await probe('/profile/start');
        await pause(60_000);
        if (!process.env.PERF_NO_CPU_PROF) await probe('/profile/stop?name=idle-one-tab');
        run.idle1end = await probe('/state');
    }
    if (!process.env.PERF_IDLE_ONLY) {
    // Measure drawer/list reopening, including paint; all 500 sessions remain real server records.
    run.listRender = await evaluate(`
        const {store}=await import('/store.js');
        globalThis.perfLong=[];
        new PerformanceObserver(l=>perfLong.push(...l.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
        const times=[];
        for(let i=0;i<5;i++) {
            const t=performance.now(); store.set({sessions:[...store.state.sessions]});
            await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
            times.push(performance.now()-t);
        }
        return JSON.stringify({times,longTasks:perfLong,rows:document.querySelectorAll('.home-list .session-row').length});
    `);
    await phase('large-open');
    await probe('/profile/start');
    run.largeOpen = await evaluate(`
        const {store,navigate}=await import('/store.js');
        const t=performance.now(); navigate(${run.start.ids[0]});
        while(store.state.view?.conversation?.id !== ${run.start.ids[0]} || !store.state.view?.entries?.size) await new Promise(r=>setTimeout(r,20));
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        return JSON.stringify({ms:performance.now()-t,entries:store.state.view.entries.size,order:store.state.view.order?.length,longTasks:globalThis.perfLong});
    `);
    await pause(1500);
    await probe('/profile/stop?name=large-open-' + count);
    run.afterLarge = await probe('/state');
    run.switches = [];
    for (const id of [run.start.ids[1],run.start.ids[0],run.start.ids[2],run.start.ids[0]]) {
        await phase('switch');
        run.switches.push(await evaluate(`
            const {store,navigate}=await import('/store.js'); const t=performance.now(); navigate(${id});
            while(store.state.view?.conversation?.id !== ${id}) await new Promise(r=>setTimeout(r,10));
            await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
            return JSON.stringify({id:${id},ms:performance.now()-t,entries:store.state.view.entries?.size});
        `));
        await pause(100);
    }
    await phase('send');
    await probe('/profile/start');
    run.messages = await evaluate(`
        const {store,navigate,api}=await import('/store.js');
        navigate(${run.start.ids[2]});
        while(store.state.view?.conversation?.id!==${run.start.ids[2]}) await new Promise(r=>setTimeout(r,20));
        const samples=[];
        for(let i=0;i<5;i++) {
            const text='perf-message-'+i; const t=performance.now();
            const response=await api('c/${run.start.ids[2]}/submit',{text,requestId:crypto.randomUUID()});
            // Watch the actual projected assistant reply, not only the POST response.
            while(![...(store.state.view?.entries?.values() ?? [])].some(e=>JSON.stringify(e.blocks)?.includes(text) && e.kind==='assistant')) {
                if(performance.now()-t>15000) break;
                await new Promise(r=>setTimeout(r,20));
            }
            samples.push({ms:performance.now()-t,response,view:[...store.state.view.entries.values()].slice(-2)});
            await new Promise(r=>setTimeout(r,150));
        }
        return JSON.stringify(samples);
    `);
    await probe('/profile/stop?name=send-' + count);
    run.beforeRooms = await probe('/state');
    run.open50 = await probe('/open50');
    run.openRooms = await probe('/state');
    await probe('/close50');
    await pause(32_000);
    run.closedRooms = await probe('/state');
    run.legacy = await probe('/legacy');
    run.end = await probe('/state');
    }
    }
} catch (error) {
    run.error = String(error); process.stderr.write(`PROBE ERROR ${String(error)}\n`);
    try { run.end = await probe('/state'); } catch {}
} finally {
    await browsers?.closeAll({ final: true });
    child.kill('SIGTERM');
    await Promise.race([exited, pause(30_000).then(() => child.kill('SIGKILL'))]);
    const suffix = process.env.PERF_SEED_ONLY ? 'seed' : process.env.PERF_IDLE_ONLY ? 'idle' : String(count);
    writeFileSync(`${out}/run-${suffix}.json`, JSON.stringify(run, null, 2));
    writeFileSync(`${out}/serve-${suffix}.log`, log);
    cleanUp();
}
console.log(`Measurements: ${out}/run-${count}.json ${run.error ?? 'OK'}`);
