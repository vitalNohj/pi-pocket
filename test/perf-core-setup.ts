// Measurement only: imported by node before test/serve.ts. Never uses live data.
import { context, newSession, root, work, owner, fakeTab } from './helpers.ts';
import { PocketApp } from '../src/server/app.ts';
import { ExtensionLoader } from '../src/server/reload.ts';
import { Room } from '../src/server/room.ts';
import { ConfigStore } from '../src/server/config.ts';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Harness, UserEntry, AssistantEntry, ToolResultEntry } from '@earendil-works/pi-durable';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { readFileSync, writeFileSync, statSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { Session } from 'node:inspector';

const out = '/tmp/perf-core';
const stats: any = { phases: [], calls: {}, submits: [], streams: [], events: {}, recentEvents: [], root, pid: process.pid };
let phase = 'startup';
let app: any;
let retained: any[] = [];
let profiler: Session | undefined;
const ids: number[] = [];
const timing = (name: string, ms: number) => { const c = stats.calls[name] ??= { n: 0, ms: 0 }; c.n++; c.ms += ms; };
function wrap(target: any, key: string, name: string, async = true) {
    const original = target[key];
    if (!original) return;
    target[key] = function (...args: any[]) {
        const t = performance.now();
        const result = original.apply(this, args);
        if (async && result?.then) return result.finally(() => timing(name, performance.now() - t));
        timing(name, performance.now() - t);
        return result;
    };
}
wrap(ModelRuntime, 'create', 'models.create');
wrap(Harness, 'open', 'harness.open');
wrap(ExtensionLoader.prototype, 'loadAll', 'extensions.loadAll');
wrap(ConfigStore.prototype, 'save', 'config.save', false);
wrap(Room.prototype, 'open', 'room.open');
wrap(Room.prototype, 'push', 'room.push', false);
const originalOpen = PocketApp.open.bind(PocketApp);
let opened = false;
PocketApp.open = async function (options: any) {
    if (opened) return originalOpen(options);
    opened = true;
    const firstStart = performance.now();
    let current = await originalOpen(options);
    stats.phases.push({ phase: 'empty.open', ms: performance.now() - firstStart, uptime: process.uptime() });
    execFileSync('git', ['init', '-q', work]);
    execFileSync('git', ['-C', work, 'config', 'user.email', 'perf@example.invalid']);
    execFileSync('git', ['-C', work, 'config', 'user.name', 'Performance Fixture']);
    const source = readFileSync(join(import.meta.dirname, '../src/server/room.ts'), 'utf8');
    writeFileSync(join(work, 'room.txt'), source);
    execFileSync('git', ['-C', work, 'add', 'room.txt']);
    execFileSync('git', ['-C', work, 'commit', '-qm', 'Fixture']);
    const seedAt = performance.now();
    const count = Number(process.env.PERF_SESSIONS ?? 500);
    for (let i = 0; i < count; i++) {
        const id = Number(await newSession(current));
        ids.push(id);
        if (i % 100 === 0) console.log(`PERF seeded ${i}/${count}`);
    }
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9ioAAAAASUVORK5CYII=';
    writeFileSync(join(work, 'sample.png'), Buffer.from(png, 'base64'));
    for (let s = 0; s < count; s++) {
        const rounds = s === 0 ? 1500 : 30;
        // Valid history entries of code/tool work, not model latency or artificial CPU load.
        await current.harness.commit(async (tx: any) => {
            for (let i = 0; i < rounds; i++) {
                const timestamp = Date.now();
                await tx.appendEntry(UserEntry, ids[s], { model: [{ role: 'user', content: i % 20 === 0 ? [{ type: 'text', text: `Inspect source ${i}` }, { type: 'image', data: png, mimeType: 'image/png' }] : `Inspect source ${i}`, timestamp }] });
                await tx.appendEntry(AssistantEntry, ids[s], { model: [fauxAssistantMessage([fauxToolCall('read', { path: join(work, 'room.txt'), offset: 1, limit: 100 }, { id: `fixture_${i}` })], { stopReason: 'toolUse' })] });
                await tx.appendEntry(ToolResultEntry, ids[s], { model: [{ role: 'toolResult', toolCallId: `fixture_${i}`, toolName: 'read', content: [{ type: 'text', text: source.slice((i % 8) * 500, (i % 8) * 500 + 16000) }], isError: false, timestamp }], data: { diagnostics: [] } });
                await tx.appendEntry(AssistantEntry, ids[s], { model: [fauxAssistantMessage([fauxText(`Read source section ${i}. The room keeps a watch and builds a projected view.`)])] });
            }
        }, context);
    }
    stats.phases.push({ phase: 'seed', ms: performance.now() - seedAt, sessions: count, entries: (count - 1) * 120 + 6000 });
    stats.databaseBytes = statSync(join(current.dataDir, 'pocket.sqlite')).size;
    await current.close();
    if (process.env.PERF_FIXTURE_OUT) cpSync(current.dataDir, process.env.PERF_FIXTURE_OUT, { recursive: true });
    stats.callsBeforeReopen = structuredClone(stats.calls);
    const reopenAt = performance.now();
    current = await originalOpen(options);
    stats.phases.push({ phase: 'populated.open', ms: performance.now() - reopenAt });
    stats.callsAfterReopen = structuredClone(stats.calls);
    app = current;
    stats.ids = ids;
    wrap(app.workspace, 'head', 'workspace.head', false);
    wrap(app.harness, 'commit', 'harness.commit');
    const stream = app.models.streamSimple.bind(app.models);
    app.models.streamSimple = (...args: any[]) => {
        const row: any = { start: performance.now(), messages: args[1]?.messages?.length, promptChars: JSON.stringify(args[1]).length };
        stats.streams.push(row);
        const result = stream(...args);
        result.result().then(() => row.end = performance.now(), () => row.end = performance.now());
        return result;
    };
    const submit = app.commands.submit.bind(app.commands);
    app.commands.submit = async (...args: any[]) => {
        const row: any = { start: performance.now(), id: Number(args[0]), text: args[2].text.slice(0, 50) };
        stats.submits.push(row);
        try { return await submit(...args); } finally { row.returned = performance.now(); }
    };
    const attach = app.attach.bind(app);
    app.attach = async (client: any) => {
        const send = client.send;
        client.send = (event: string, data: any) => {
            const bytes = Buffer.byteLength(JSON.stringify(data));
            const label = `${phase}:${event}`;
            const c = stats.events[label] ??= { n: 0, bytes: 0, maxBytes: 0 };
            c.n++; c.bytes += bytes; c.maxBytes = Math.max(c.maxBytes, bytes);
            if (stats.recentEvents.length > 1000) stats.recentEvents.shift();
            stats.recentEvents.push({ event, at: performance.now(), bytes, c: data?.conversationId ?? data?.conversation?.id });
            return send(event, data);
        };
        return attach(client);
    };
    const metricServer = createServer(async (req, res) => {
        try {
            const url = new URL(req.url!, 'http://127.0.0.7');
            let result: any;
            switch (url.pathname) {
                case '/state':
                    globalThis.gc?.();
                    result = { ...stats, calls: structuredClone(stats.calls), now: performance.now(), cpu: process.cpuUsage(), memory: process.memoryUsage(), rooms: ids.filter((id) => app.openRoom(id) !== undefined).length, token: app.config.ownerToken };
                    break;
                case '/phase': phase = url.searchParams.get('name')!; result = { phase }; break;
                case '/open50': {
                    const at = performance.now();
                    for (const id of ids.slice(1, 51)) retained.push(await app.room(id));
                    result = { ms: performance.now() - at }; break;
                }
                case '/close50':
                    for (const room of retained) app.releaseRoom(room);
                    retained = []; result = { ok: true }; break;
                case '/profile/start':
                    profiler = new Session(); profiler.connect();
                    await new Promise((resolve, reject) => profiler!.post('Profiler.enable', (e) => e ? reject(e) : resolve(null)));
                    await new Promise((resolve, reject) => profiler!.post('Profiler.start', (e) => e ? reject(e) : resolve(null)));
                    result = { ok: true }; break;
                case '/profile/stop': {
                    const { profile }: any = await new Promise((resolve, reject) => profiler!.post('Profiler.stop', (e, r) => e ? reject(e) : resolve(r)));
                    writeFileSync(`${out}/${url.searchParams.get('name')}.cpuprofile`, JSON.stringify(profile));
                    profiler!.disconnect(); profiler = undefined; result = { ok: true }; break;
                }
                case '/legacy': {
                    const tab = fakeTab(ids[0] as never, owner(app), 1); await app.attach(tab.client);
                    result = tab.events.filter((e) => ['hello', 'sessions', 'view'].includes(e.event)).map((e) => ({ event: e.event, bytes: Buffer.byteLength(JSON.stringify(e.data)) }));
                    app.detach(tab.client); break;
                }
                default: result = { error: 'not found' };
            }
            res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
        } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
    await new Promise<void>((resolve) => metricServer.listen(8978, '127.0.0.7', resolve));
    const close = app.close.bind(app);
    app.close = async () => { metricServer.closeAllConnections(); metricServer.close(); return close(); };
    console.log(`PERF instrumented ${process.pid}`);
    return app;
} as typeof PocketApp.open;
