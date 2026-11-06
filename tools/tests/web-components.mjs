// ioBroker web components (@iobroker/web-components) in the webcomponent widget:
// the socket bridge, the theme from Aura's variables, the typed settings, the
// hidden/disabled expressions of the settings form and where iob-navigate leads.
//
//   node tools/tests/web-components.mjs
//
// No dev server needed - utils/webComponentHost.ts is free of React and of the
// live socket and is bundled with esbuild.
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const cache = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const bundle = join(cache, `aura-web-components-${process.pid}.mjs`);
await build({
    entryPoints: [join(process.cwd(), 'src-vis/utils/webComponentHost.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundle,
    logLevel: 'warning',
});
const m = await import(pathToFileURL(bundle).href);
rmSync(bundle, { force: true });

let failed = 0;
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) {
        failed++;
    }
    console.log(
        `${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` - got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`,
    );
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── socket bridge ───────────────────────────────────────────────────────────
function fakeApi() {
    const log = [];
    const subs = new Map(); // id -> Set(cb)
    return {
        log,
        subs,
        emit(id, state) {
            for (const cb of subs.get(id) ?? []) {
                cb(state);
            }
        },
        api: {
            subscribeState(id, cb) {
                log.push(['sub', id]);
                if (!subs.has(id)) {
                    subs.set(id, new Set());
                }
                subs.get(id).add(cb);
                return () => {
                    log.push(['unsub', id]);
                    subs.get(id)?.delete(cb);
                };
            },
            getState: async (id) => ({ val: `state of ${id}` }),
            setState: async (id, val, ack) => {
                log.push(['set', id, val, ack]);
            },
            getObject: async (id) => ({ _id: id }),
            getHistory: async () => [],
            getObjectView: async (type, start, end) => ({ [`${type}|${start}|${end}`]: 1 }),
            sendTo: async (instance, command, data) => ({ instance, command, data }),
        },
    };
}

{
    const f = fakeApi();
    const socket = m.createWebComponentSocket(f.api, 'de');
    check('socket: systemLang', socket.systemLang, 'de');

    const got = [];
    const a = (id, state) => got.push(['a', id, state?.val]);
    const b = (id, state) => got.push(['b', id, state?.val]);
    await socket.subscribeState(['x.0.one', 'x.0.two'], a);
    await socket.subscribeState('x.0.one', a); // the same callback again: no second subscription
    await socket.subscribeState('x.0.one', b);
    check(
        'socket: one subscription per id and callback',
        f.log.filter((e) => e[0] === 'sub'),
        [
            ['sub', 'x.0.one'],
            ['sub', 'x.0.two'],
            ['sub', 'x.0.one'],
        ],
    );
    f.emit('x.0.one', { val: 1 });
    f.emit('x.0.two', { val: 2 });
    check('socket: the callback gets id and state', got, [
        ['a', 'x.0.one', 1],
        ['b', 'x.0.one', 1],
        ['a', 'x.0.two', 2],
    ]);

    got.length = 0;
    socket.unsubscribeState('x.0.one', a);
    f.emit('x.0.one', { val: 3 });
    check('socket: unsubscribing one callback leaves the other', got, [['b', 'x.0.one', 3]]);

    got.length = 0;
    socket.unsubscribeState(['x.0.one', 'x.0.two']);
    f.emit('x.0.one', { val: 4 });
    f.emit('x.0.two', { val: 4 });
    check('socket: unsubscribing without a callback drops all', got, []);
    check(
        'socket: every subscription was ended',
        [...f.subs.values()].every((s) => s.size === 0),
        true,
    );

    f.log.length = 0;
    await socket.setState('x.0.one', { val: 7, ack: true });
    await socket.setState('x.0.one', 8);
    await socket.setState('x.0.one', false, true);
    await socket.setState('x.0.one', { val: 'on' }, true);
    check('socket: setState with a value or a { val, ack } object', f.log, [
        ['set', 'x.0.one', 7, true],
        ['set', 'x.0.one', 8, false],
        ['set', 'x.0.one', false, true],
        ['set', 'x.0.one', 'on', true],
    ]);

    check('socket: getState passes through', await socket.getState('x.0.one'), { val: 'state of x.0.one' });
    check(
        'socket: getObjectViewSystem reads to the end of the range',
        await socket.getObjectViewSystem('instance', 'system.adapter.'),
        { 'instance|system.adapter.|\u9999': 1 },
    );
    check('socket: sendTo passes through', await socket.sendTo('flow.0', 'list', { a: 1 }), {
        instance: 'flow.0',
        command: 'list',
        data: { a: 1 },
    });

    // Objects without object events: the current object once
    const objs = [];
    const oc = (id, obj) => objs.push([id, obj?._id]);
    await socket.subscribeObject('x.0.one', oc);
    await tick();
    check('socket: subscribeObject without events delivers the object once', objs, [['x.0.one', 'x.0.one']]);
    objs.length = 0;
    // a read that answers late: the component has unsubscribed by then
    f.api.getObject = (id) => new Promise((r) => setTimeout(() => r({ _id: id }), 5));
    await socket.subscribeObject('x.0.two', oc);
    await socket.unsubscribeObject('x.0.two', oc);
    await new Promise((r) => setTimeout(r, 20));
    check('socket: no object after unsubscribing', objs, []);
}

// ── object subscriptions: the bridge, then hooks/useIoBroker on a fake socket ──
{
    const subs = new Map(); // id or pattern -> Set(cb)
    const log = [];
    const f = fakeApi();
    f.api.subscribeObject = (id, cb) => {
        log.push(['subObj', id]);
        if (!subs.has(id)) {
            subs.set(id, new Set());
        }
        subs.get(id).add(cb);
        return () => {
            log.push(['unsubObj', id]);
            subs.get(id).delete(cb);
        };
    };
    const socket = m.createWebComponentSocket(f.api, 'en');
    const objs = [];
    const oc = (id, obj) => objs.push([id, obj === null ? null : obj?.v]);
    await socket.subscribeObject(['flow.0.diagrams.a', 'system.adapter.*'], oc);
    await tick();
    check(
        'objects: subscribed through the host, no object delivered up front',
        [log, objs],
        [
            [
                ['subObj', 'flow.0.diagrams.a'],
                ['subObj', 'system.adapter.*'],
            ],
            [],
        ],
    );
    for (const cb of subs.get('flow.0.diagrams.a')) {
        cb({ v: 2 }, 'flow.0.diagrams.a');
        cb(null, 'flow.0.diagrams.a');
    }
    for (const cb of subs.get('system.adapter.*')) {
        cb({ v: 3 }, 'system.adapter.flow.0');
    }
    check('objects: changes, deletion as null, a pattern with the ID of the object', objs, [
        ['flow.0.diagrams.a', 2],
        ['flow.0.diagrams.a', null],
        ['system.adapter.flow.0', 3],
    ]);
    await socket.unsubscribeObject(['flow.0.diagrams.a', 'system.adapter.*'], oc);
    check('objects: unsubscribed through the host', log.slice(2), [
        ['unsubObj', 'flow.0.diagrams.a'],
        ['unsubObj', 'system.adapter.*'],
    ]);
}
{
    // the real socket layer, bundled with a fake socket library in place of /socket.io/socket.io.js
    const ioBundle = join(cache, `aura-web-components-io-objects-${process.pid}.mjs`);
    await build({
        entryPoints: [join(process.cwd(), 'src-vis/hooks/useIoBroker.ts')],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: ioBundle,
        define: { 'import.meta.env.DEV': 'false' },
        logLevel: 'warning',
    });
    const sockets = [];
    const answers = {}; // command -> (...args) => callback arguments
    globalThis.window ??= { location: { origin: 'http://aura.test', protocol: 'http:' } };
    globalThis.io = {
        connect() {
            const handlers = {};
            const sock = {
                connected: true,
                emitted: [],
                on(event, cb) {
                    (handlers[event] ??= []).push(cb);
                },
                emit(event, ...args) {
                    const cb = typeof args.at(-1) === 'function' ? args.pop() : null;
                    sock.emitted.push([event, ...args]);
                    if (cb && answers[event]) {
                        setTimeout(() => cb(...answers[event](...args)), 0);
                    }
                },
                disconnect() {},
                fire(event, ...args) {
                    for (const h of handlers[event] ?? []) {
                        h(...args);
                    }
                },
            };
            sockets.push(sock);
            return sock;
        },
    };
    const quiet = console.log;
    console.log = () => {}; // the connect banner
    const io = await import(pathToFileURL(ioBundle).href);
    rmSync(ioBundle, { force: true });
    const s = io.getSocket();
    s.fire('connect');
    console.log = quiet;
    const sent = (command) => s.emitted.filter((e) => e[0] === command).map((e) => e[1]);

    let version = 1;
    answers.getObject = (id) => [null, { _id: id, common: { name: `${id} v${version}` } }];
    answers.subscribeObjects = (id) => [id.startsWith('secret.') ? 'permissionError' : null];
    answers.unsubscribeObjects = () => [null];

    const got = [];
    const a = (obj, id) => got.push(['a', id, obj === null ? null : obj.common.name]);
    const b = (obj, id) => got.push(['b', id, obj === null ? null : obj.common.name]);
    const offA = io.subscribeObjectDirect('flow.0.diagrams.d1', a);
    const offB = io.subscribeObjectDirect('flow.0.diagrams.d1', b);
    const offP = io.subscribeObjectDirect('system.adapter.*', a);
    check('io objects: one subscribeObjects per ID or pattern', sent('subscribeObjects'), [
        'flow.0.diagrams.d1',
        'system.adapter.*',
    ]);
    s.fire('objectChange', 'flow.0.diagrams.d1', { common: { name: 'changed' } });
    s.fire('objectChange', 'system.adapter.flow.0', { common: { name: 'instance' } });
    s.fire('objectChange', 'system.adapterX', { common: { name: 'no match' } });
    s.fire('objectChange', 'flow.0.diagrams.d1', null);
    check('io objects: exact and pattern subscribers, deletion as null', got, [
        ['a', 'flow.0.diagrams.d1', 'changed'],
        ['b', 'flow.0.diagrams.d1', 'changed'],
        ['a', 'system.adapter.flow.0', 'instance'],
        ['a', 'flow.0.diagrams.d1', null],
        ['b', 'flow.0.diagrams.d1', null],
    ]);

    // the object cache follows the changes
    got.length = 0;
    const reads = () => sent('getObject').length;
    await io.getObjectDirect('x.0.cached');
    const before = reads();
    s.fire('objectChange', 'x.0.cached', { common: { name: 'pushed' } });
    check(
        'io objects: a change renews a cached object, no read',
        [(await io.getObjectDirect('x.0.cached')).common.name, reads() - before],
        ['pushed', 0],
    );
    s.fire('objectChange', 'x.0.cached', null);
    check('io objects: a deleted cached object reads as null', await io.getObjectDirect('x.0.cached'), null);
    // a read in flight while the object changes: its (older) answer must not be cached
    const inFlight = io.getObjectDirect('x.0.racing');
    s.fire('objectChange', 'x.0.racing', { common: { name: 'newer' } });
    await inFlight;
    const racingReads = reads();
    await io.getObjectDirect('x.0.racing');
    check('io objects: a read overtaken by a change is not cached', reads() - racingReads, 1);
    // the first subscription of an ID drops what nobody kept current
    await io.getObjectDirect('x.0.stale');
    const staleReads = reads();
    const offStale = io.subscribeObjectDirect('x.0.stale', () => {});
    await io.getObjectDirect('x.0.stale');
    check('io objects: subscribing reads the object afresh', reads() - staleReads, 1);
    offStale();

    // a refused subscription (no read right for objects) neither throws nor repeats its warning
    const warn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    let threw = false;
    try {
        const off1 = io.subscribeObjectDirect('secret.0.x', a);
        off1();
        io.subscribeObjectDirect('secret.0.x', a)();
        await new Promise((r) => setTimeout(r, 5));
    } catch {
        threw = true;
    }
    console.warn = warn;
    check(
        'io objects: a refused subscription is reported once and throws nothing',
        [threw, warnings.filter((w) => w.includes('secret.0.x')).length],
        [false, 1],
    );

    // a subscriber that throws does not keep the change from the others
    got.length = 0;
    const error = console.error;
    console.error = () => {};
    const offBad = io.subscribeObjectDirect('flow.0.diagrams.d1', () => {
        throw new Error('broken component');
    });
    const offAfter = io.subscribeObjectDirect('flow.0.diagrams.d1', (obj, id) => got.push(['after', id]));
    s.fire('objectChange', 'flow.0.diagrams.d1', { common: { name: 'x' } });
    console.error = error;
    check(
        'io objects: a throwing subscriber leaves the others alone',
        got.map((g) => g[0]),
        ['a', 'b', 'after'],
    );
    offBad();
    offAfter();

    // reconnect: subscribed again; a single object that changed meanwhile is delivered
    await io.getObjectDirect('flow.0.diagrams.d1'); // cached as v1
    got.length = 0;
    const sentBefore = s.emitted.length;
    console.log = () => {};
    s.fire('disconnect');
    version = 2;
    s.fire('reconnect');
    console.log = quiet;
    await new Promise((r) => setTimeout(r, 5));
    check(
        'io objects: every subscription renewed after a reconnect',
        s.emitted
            .slice(sentBefore)
            .filter((e) => e[0] === 'subscribeObjects')
            .map((e) => e[1]),
        ['flow.0.diagrams.d1', 'system.adapter.*'],
    );
    check('io objects: what changed while offline reaches the subscribers', got, [
        ['a', 'flow.0.diagrams.d1', 'flow.0.diagrams.d1 v2'],
        ['b', 'flow.0.diagrams.d1', 'flow.0.diagrams.d1 v2'],
    ]);

    // unsubscribing: the server hears it after the last subscriber of an ID
    offA();
    check('io objects: still subscribed while a subscriber is left', sent('unsubscribeObjects'), [
        'x.0.stale',
        'secret.0.x',
        'secret.0.x',
    ]);
    offB();
    offP();
    offP(); // twice: no second unsubscribe
    check('io objects: unsubscribed after the last one', sent('unsubscribeObjects').slice(3), [
        'flow.0.diagrams.d1',
        'system.adapter.*',
    ]);
    got.length = 0;
    io.__devInjectObjectChange('system.adapter.flow.0', { common: { name: 'late' } });
    check('io objects: nothing after unsubscribing', got, []);
    const offDev = io.subscribeObjectDirect('system.adapter.*', a);
    io.__devInjectObjectChange('system.adapter.flow.0', { common: { name: 'played' } });
    check('io objects: the dev stub plays an objectChange', got, [['a', 'system.adapter.flow.0', 'played']]);
    offDev();
}

// ── theme ───────────────────────────────────────────────────────────────────
{
    const vars = {
        '--accent': '#3b82f6',
        '--accent-yellow': '#eab308',
        '--app-bg': '#0f172a',
        '--widget-bg': ' #1e293b ',
        '--text-primary': '#f8fafc',
        '--text-secondary': '#94a3b8',
        '--widget-border': '#334155',
        '--accent-red': '#ef4444',
        '--accent-green': '#22c55e',
        '--widget-radius': '12px',
    };
    const theme = m.themeFromVars((n) => vars[n] ?? '', true, ' Inter, sans-serif ');
    check('theme: type', theme.type, 'dark');
    check(
        'theme: accent is primary, Aura colors carried over',
        [theme.primary, theme.background, theme.paper],
        ['#3b82f6', '#0f172a', '#1e293b'],
    );
    check('theme: text colors', [theme.text, theme.textSecondary, theme.divider], ['#f8fafc', '#94a3b8', '#334155']);
    check(
        'theme: state colors',
        [theme.error, theme.warning, theme.success, theme.info],
        ['#ef4444', '#eab308', '#22c55e', '#3b82f6'],
    );
    check('theme: font', theme.fontFamily, 'Inter, sans-serif');
    check('theme: radius in px', theme.borderRadius, 12);
    const rem = m.themeFromVars((n) => (n === '--widget-radius' ? '0.75rem' : ''), false, '', 16);
    check('theme: radius in rem becomes px (Aura gives 0.75rem)', rem.borderRadius, 12);
    const calc = m.themeFromVars((n) => (n === '--widget-radius' ? 'calc(1rem + 2px)' : ''), false);
    check('theme: a radius that is no plain length keeps the default', typeof calc.borderRadius, 'number');

    const empty = m.themeFromVars(() => '', false);
    check(
        'theme: without variables the defaults fill in',
        [empty.type, typeof empty.primary, typeof empty.paper],
        ['light', 'string', 'string'],
    );
}

// ── settings ────────────────────────────────────────────────────────────────
const manifest = {
    manifestVersion: 1,
    tag: 'iob-test-tile',
    name: 'Test',
    module: 'test.js',
    settings: {
        type: 'panel',
        items: {
            head: { type: 'header', text: 'Datapoint' },
            oid: { type: 'objectId' },
            mode: { type: 'select', default: 'a', options: [{ value: 'a', label: 'A' }] },
            digits: { type: 'number', default: 1 },
            showUnit: { type: 'checkbox', default: true },
            note: { type: 'text', hidden: 'data.mode !== "b"' },
        },
    },
};
check(
    'settings: defaults, stored values typed by the manifest, unknown keys dropped',
    m.typedSettings(manifest, { oid: 'x.0.one', digits: '2', showUnit: false, other: 1 }),
    { oid: 'x.0.one', mode: 'a', digits: 2, showUnit: false },
);
check('settings: nothing stored -> the defaults', m.typedSettings(manifest, undefined), {
    mode: 'a',
    digits: 1,
    showUnit: true,
});

check('expr: hidden while the condition holds', m.evalSettingExpr('data.mode !== "b"', { mode: 'a' }), true);
check('expr: visible otherwise', m.evalSettingExpr('data.mode !== "b"', { mode: 'b' }), false);
check('expr: no expression', m.evalSettingExpr(undefined, {}), false);
check('expr: a broken expression counts as false', m.evalSettingExpr('data.(', {}), false);
check('expr: a throwing expression counts as false', m.evalSettingExpr('data.x.y', {}), false);

// ── iob-navigate ────────────────────────────────────────────────────────────
const layouts = [
    {
        id: 'L1',
        slug: 'home',
        sections: [
            {
                id: 'S1',
                slug: 'main',
                tabs: [
                    { id: 't1', name: 'Wohnzimmer', slug: 'wohnzimmer' },
                    { id: 't2', name: 'Küche', slug: 'kueche' },
                ],
            },
            { id: 'S2', slug: 'more', tabs: [{ id: 't3', name: 'Küche', slug: 'kueche-2' }] },
        ],
    },
    { id: 'L2', slug: 'other', sections: [{ id: 'S9', slug: 'x', tabs: [{ id: 't9', name: 'Bad', slug: 'bad' }] }] },
];
check('navigate: by slug', m.findTabForView('wohnzimmer', layouts, 'L1', 'S1'), {
    layoutId: 'L1',
    sectionId: 'S1',
    tabId: 't1',
});
check('navigate: by name, case-insensitive', m.findTabForView(' KÜCHE ', layouts, 'L1', 'S1'), {
    layoutId: 'L1',
    sectionId: 'S1',
    tabId: 't2',
});
check('navigate: the active section first', m.findTabForView('Küche', layouts, 'L1', 'S2'), {
    layoutId: 'L1',
    sectionId: 'S2',
    tabId: 't3',
});
check('navigate: by id', m.findTabForView('t3', layouts, 'L1', 'S1'), {
    layoutId: 'L1',
    sectionId: 'S2',
    tabId: 't3',
});
check('navigate: only the active layout', m.findTabForView('bad', layouts, 'L1', 'S1'), null);
check('navigate: unknown view', m.findTabForView('nowhere', layouts, 'L1'), null);
check('navigate: no view', m.findTabForView(undefined, layouts, 'L1'), null);

// ── the "add widget" dialog: every component an entry of its own ────────────
{
    const flow = {
        url: 'http://host:8082/adapter/flow/webcomponents/flow-diagram.json',
        adapter: 'flow',
        version: '0.1.0',
        moduleUrl: 'http://host:8082/adapter/flow/webcomponents/flow-diagram.js',
        manifest: {
            manifestVersion: 1,
            tag: 'iob-flow-diagram',
            name: { en: 'Flow diagram', de: 'Fluss-Diagramm' },
            description: { en: 'Animated flow diagram', de: 'Animiertes Fluss-Diagramm' },
            icon: '../flow.svg',
            size: { width: 480, height: 340 },
            settings: { type: 'panel', items: {} },
        },
    };
    const bare = {
        url: 'http://host:8082/adapter/other/wc/tile.json',
        adapter: 'other',
        version: '1.0.0',
        moduleUrl: 'http://host:8082/adapter/other/wc/tile.js',
        manifest: { manifestVersion: 1, tag: 'iob-other-tile', name: { fr: 'Tuile' }, settings: { items: {} } },
    };
    const entries = m.webComponentPickerEntries([flow, flow, bare, { adapter: 'x', manifest: {} }, null], 'de');
    check('entries: once per adapter and tag, without a tag none', entries.length, 2);
    check('entry: key', entries[0].key, 'wc:flow|iob-flow-diagram');
    check('entry: name in the frontend language', entries[0].label, 'Fluss-Diagramm');
    check('entry: description and adapter as hint', entries[0].hint, 'Animiertes Fluss-Diagramm – Adapter flow');
    check('entry: icon relative to the manifest', entries[0].iconUrl, 'http://host:8082/adapter/flow/flow.svg');
    check('entry: preferred size', entries[0].size, { width: 480, height: 340 });
    check('entry: no name in the language - another one', entries[1].label, 'Tuile');
    check(
        'entry: no name at all - the tag',
        m.webComponentPickerEntries([{ ...bare, manifest: { ...bare.manifest, name: undefined } }], 'de')[0].label,
        'iob-other-tile',
    );
    check('entry: no description - only the adapter', entries[1].hint, 'Adapter other');
    check('entry: no icon, no size', [entries[1].iconUrl, entries[1].size], [undefined, undefined]);
    check('entries: English frontend', m.webComponentPickerEntries([flow], 'en')[0].label, 'Flow diagram');

    check('key: parsed', m.parseWebComponentKey('wc:flow|iob-flow-diagram'), {
        adapter: 'flow',
        tag: 'iob-flow-diagram',
    });
    check('key: round trip', m.parseWebComponentKey(m.webComponentKey('a', 'b-c')), { adapter: 'a', tag: 'b-c' });
    check(
        'key: a widget type, a template id or garbage is none',
        ['webcomponent', 'shutter', 'wc:flow', 'wc:flow|', undefined, 7].map((k) => m.parseWebComponentKey(k)),
        [null, null, null, null, null, null],
    );

    const grid = { rowHeight: 20, snapX: 20, gap: 10, padding: 16 };
    // 480 + 2·16 = 512 px wide: (512 + 10) / 30 ≈ 17 columns; 340 + 32 = 372 px high: 382 / 30 ≈ 13 rows
    check('size: px to grid cells with the widget padding', m.webComponentGridSize({ width: 480, height: 340 }, grid), {
        w: 17,
        h: 13,
    });
    check('size: tiny stays at least 2×2', m.webComponentGridSize({ width: 1, height: 1 }, { ...grid, padding: 0 }), {
        w: 2,
        h: 2,
    });
    check(
        'size: none named - the type default applies',
        [m.webComponentGridSize(undefined, grid), m.webComponentGridSize({ width: 0, height: 100 }, grid)],
        [null, null],
    );
}

// ── a catalog that stays current: versioned URLs, merging, change detection ──
{
    check(
        'version: the adapter version as query of a URL',
        [
            m.versionedUrl('http://h/adapter/flow/wc/d.json', '1.2.0'),
            m.versionedUrl('http://h/adapter/flow/wc/d.js?v=1.1.0&x=1', '1.2.0'),
            m.versionedUrl('http://h/adapter/flow/wc/d.js', ''),
            m.versionedUrl('not a url', '1.0.0'),
        ],
        [
            'http://h/adapter/flow/wc/d.json?v=1.2.0',
            'http://h/adapter/flow/wc/d.js?v=1.2.0&x=1',
            'http://h/adapter/flow/wc/d.js',
            'not a url',
        ],
    );

    // the real loader of the package: the versioned manifest URL is read, the module URL
    // (relative to the manifest, so without its query) gets the version as well
    const pkg = await import('@iobroker/web-components');
    const manifestOf = (tag, module) => ({
        manifestVersion: 1,
        tag,
        name: 'D',
        module,
        icon: 'd.svg',
        settings: { type: 'panel', items: {} },
    });
    const read = [];
    const sources = m.versionedSources(
        pkg.getWebComponentSources(
            [{ _id: 'system.adapter.flow.0', common: { version: '1.2.0', webComponents: ['wc/d.json'] } }],
            'http://h:8095/index.html',
        ),
    );
    const loaded = (
        await pkg.loadWebComponents(sources, {
            readManifest: async (url) => {
                read.push(url);
                return manifestOf('iob-versioned-d', 'd.js');
            },
            log: { error() {}, warn() {} },
        })
    ).map(m.versionedModule);
    check('version: the manifest is read under its versioned URL', read, [
        'http://h:8095/adapter/flow/wc/d.json?v=1.2.0',
    ]);
    check(
        'version: the module URL is versioned too',
        loaded[0].moduleUrl,
        'http://h:8095/adapter/flow/wc/d.js?v=1.2.0',
    );
    check(
        'version: the icon still resolves next to the manifest',
        m.webComponentPickerEntries(loaded, 'en')[0].iconUrl,
        'http://h:8095/adapter/flow/wc/d.svg',
    );
    // importWebComponent: once per URL, and the tag check still holds
    const defined = new Set();
    globalThis.customElements ??= { get: (tag) => (defined.has(tag) ? class {} : undefined) };
    const imported = [];
    const importer = async (url) => {
        imported.push(url);
        defined.add('iob-versioned-d');
        return {};
    };
    await pkg.importWebComponent(loaded[0], { importer });
    await pkg.importWebComponent(loaded[0], { importer });
    check('version: the versioned module is imported once', imported, ['http://h:8095/adapter/flow/wc/d.js?v=1.2.0']);
    let rejected = '';
    await pkg
        .importWebComponent(
            {
                ...loaded[0],
                moduleUrl: 'http://h:8095/adapter/flow/wc/other.js?v=1.2.0',
                manifest: manifestOf('iob-x-none', 'other.js'),
            },
            { importer: async () => ({}) },
        )
        .catch((e) => (rejected = e.message));
    check(
        'version: a module that does not define its tag is still refused',
        /does not define <iob-x-none>/.test(rejected),
        true,
    );
    // an older component: a module exporting its manifest, imported at once under the versioned URL
    const legacyImports = [];
    const legacy = (
        await pkg.loadWebComponents(
            m.versionedSources([{ url: 'http://h:8095/adapter/old/wc/old.js', adapter: 'old', version: '0.2.0' }]),
            {
                importer: async (url) => {
                    legacyImports.push(url);
                    defined.add('iob-legacy-old');
                    return { manifest: manifestOf('iob-legacy-old', undefined) };
                },
                log: { error() {}, warn() {} },
            },
        )
    ).map(m.versionedModule);
    check(
        'version: a module that exports its manifest keeps one versioned URL',
        [legacyImports, legacy[0].moduleUrl],
        [['http://h:8095/adapter/old/wc/old.js?v=0.2.0'], 'http://h:8095/adapter/old/wc/old.js?v=0.2.0'],
    );

    // merging a catalog read again
    const comp = (adapter, tag, version, extra = {}) => ({
        url: `http://h/adapter/${adapter}/${tag}.json?v=${version}`,
        adapter,
        version,
        moduleUrl: `http://h/adapter/${adapter}/${tag}.js?v=${version}`,
        manifest: { ...manifestOf(tag, `${tag}.js`), ...extra },
    });
    const before = [comp('flow', 'iob-a', '1.0.0'), comp('flow', 'iob-b', '1.0.0'), comp('x', 'iob-c', '2.0.0')];
    const after = [
        comp('flow', 'iob-a', '1.1.0'), // updated, its element is defined
        comp('flow', 'iob-b', '1.1.0'), // updated, never shown
        comp('x', 'iob-c', '2.0.0'), // unchanged
        comp('y', 'iob-d', '1.0.0'), // new
    ];
    const merged = m.mergeCatalog(after, before, (tag) => tag === 'iob-a');
    check(
        'merge: a defined element keeps the module it was imported from, the rest takes the new one',
        merged.map((c) => c.moduleUrl.replace('http://h/adapter/', '')),
        ['flow/iob-a.js?v=1.0.0', 'flow/iob-b.js?v=1.1.0', 'x/iob-c.js?v=2.0.0', 'y/iob-d.js?v=1.0.0'],
    );
    check('merge: the new manifest is taken all the same', merged[0].url, after[0].url);
    check(
        'merge: an unchanged component stays the same object, a changed one does not',
        [merged[2] === before[2], merged[0] === before[0], merged[3] === after[3]],
        [true, false, true],
    );
    const changedSettings = m.mergeCatalog([comp('x', 'iob-c', '2.0.0', { name: 'New name' })], before, () => true);
    check('merge: a changed manifest of the same version is a new object', changedSettings[0] === before[2], false);

    // which instance changes make the catalog be read again
    const inst = (id, version, list, extra = {}) => ({
        _id: id,
        type: 'instance',
        common: { version, ...(list ? { webComponents: list } : {}), ...extra },
    });
    const watch = m.createCatalogWatch();
    watch.reset([
        inst('system.adapter.flow.0', '1.0.0', ['wc/a.json']),
        inst('system.adapter.admin.0', '7.0.0'),
        { _id: 'system.adapter.broken.0' },
        null,
    ]);
    const changes = [
        ['an object below an instance', 'system.adapter.flow.0.alive', { common: {} }],
        ['the adapter object', 'system.adapter.flow', inst('system.adapter.flow', '1.1.0', ['wc/a.json'])],
        [
            'an instance started or configured',
            'system.adapter.flow.0',
            inst('system.adapter.flow.0', '1.0.0', ['wc/a.json'], { enabled: false }),
        ],
        ['a second instance', 'system.adapter.flow.1', inst('system.adapter.flow.1', '1.0.0', ['wc/a.json'])],
        ['an adapter without components', 'system.adapter.admin.0', inst('system.adapter.admin.0', '7.1.0')],
        ['the update of flow.0', 'system.adapter.flow.0', inst('system.adapter.flow.0', '1.1.0', ['wc/a.json'])],
        ['the update of flow.1', 'system.adapter.flow.1', inst('system.adapter.flow.1', '1.1.0', ['wc/a.json'])],
        ['the second instance removed', 'system.adapter.flow.1', null],
        [
            'a new component',
            'system.adapter.flow.0',
            inst('system.adapter.flow.0', '1.1.0', ['wc/a.json', 'wc/b.json']),
        ],
        ['a new adapter with components', 'system.adapter.y.0', inst('system.adapter.y.0', '1.0.0', ['d.json'])],
        ['the adapter removed', 'system.adapter.y.0', null],
    ];
    check(
        'watch: read again only when (adapter, version, components) change',
        changes.map(([what, id, obj]) => `${what}: ${watch.change(id, obj)}`),
        [
            'an object below an instance: false',
            'the adapter object: false',
            'an instance started or configured: false',
            'a second instance: false',
            'an adapter without components: false',
            'the update of flow.0: true',
            'the update of flow.1: true', // the same burst - the reload is debounced, so it is read once
            'the second instance removed: false',
            'a new component: true',
            'a new adapter with components: true',
            'the adapter removed: true',
        ],
    );
    check(
        'watch: instances read anew after an outage - the same set or another one',
        [
            watch.differs([inst('system.adapter.flow.0', '1.1.0', ['wc/a.json', 'wc/b.json'])]),
            watch.differs([inst('system.adapter.flow.0', '1.2.0', ['wc/a.json', 'wc/b.json'])]),
        ],
        [false, true],
    );
}
{
    // the catalog of utils/webComponentRegistry on the real socket layer and a fake socket library
    const regBundle = join(cache, `aura-web-components-registry-${process.pid}.mjs`);
    await build({
        entryPoints: [join(process.cwd(), 'src-vis/utils/webComponentRegistry.ts')],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: regBundle,
        define: { 'import.meta.env.DEV': 'false' },
        logLevel: 'warning',
    });
    let flowVersion = '1.0.0';
    const instanceRows = () => [
        {
            id: 'system.adapter.flow.0',
            value: {
                _id: 'system.adapter.flow.0',
                type: 'instance',
                common: { version: flowVersion, webComponents: ['wc/d.json'] },
            },
        },
        { id: 'system.adapter.admin.0', value: { _id: 'system.adapter.admin.0', common: { version: '7.0.0' } } },
    ];
    const sockets = [];
    globalThis.window ??= { location: { origin: 'http://aura.test', protocol: 'http:' } };
    globalThis.customElements ??= { get: () => undefined };
    globalThis.io = {
        connect() {
            const handlers = {};
            const sock = {
                connected: true,
                emitted: [],
                on(event, cb) {
                    (handlers[event] ??= []).push(cb);
                },
                emit(event, ...args) {
                    const cb = typeof args.at(-1) === 'function' ? args.pop() : null;
                    sock.emitted.push([event, ...args]);
                    if (!cb) return;
                    if (event === 'getObjectView') setTimeout(() => cb(null, { rows: instanceRows() }), 0);
                    else setTimeout(() => cb(null), 0);
                },
                disconnect() {},
                fire(event, ...args) {
                    for (const h of handlers[event] ?? []) {
                        h(...args);
                    }
                },
            };
            sockets.push(sock);
            return sock;
        },
    };
    const fetched = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        fetched.push(String(url));
        return {
            ok: true,
            json: async () => ({
                manifestVersion: 1,
                tag: 'iob-registry-d',
                name: 'D',
                module: 'd.js',
                settings: { type: 'panel', items: {} },
            }),
        };
    };
    const quiet = console.log;
    console.log = () => {};
    const reg = await import(pathToFileURL(regBundle).href);
    rmSync(regBundle, { force: true });
    // after the import: with a document, the socket layer would start its wake-up timers
    globalThis.document = { baseURI: 'http://h:8095/' };
    const first = await reg.loadWebComponentCatalog();
    const s = sockets[0];
    s.fire('connect');
    console.log = quiet;
    check(
        'catalog: manifest and module under versioned URLs',
        [fetched, first[0]?.moduleUrl],
        [['http://h:8095/adapter/flow/wc/d.json?v=1.0.0'], 'http://h:8095/adapter/flow/wc/d.js?v=1.0.0'],
    );
    const objectSubs = () => s.emitted.filter((e) => e[0] === 'subscribeObjects').map((e) => e[1]);
    check('catalog: nobody uses it - no object subscription', objectSubs(), []);
    const stop = reg.watchCatalog();
    const stop2 = reg.watchCatalog();
    check('catalog: in use - the instance objects are watched, once', objectSubs(), ['system.adapter.*']);
    await new Promise((r) => setTimeout(r, 150)); // the look at what changed before the watch: nothing
    fetched.length = 0;
    // an instance that starts, an object below it: nothing to read
    s.fire('objectChange', 'system.adapter.flow.0', {
        _id: 'system.adapter.flow.0',
        common: { version: '1.0.0', webComponents: ['wc/d.json'], enabled: true },
    });
    s.fire('objectChange', 'system.adapter.flow.0.alive', { common: {} });
    // the update: written twice in a burst, read once after it
    flowVersion = '1.1.0';
    const updated = { _id: 'system.adapter.flow.0', common: { version: '1.1.0', webComponents: ['wc/d.json'] } };
    s.fire('objectChange', 'system.adapter.flow.0', updated);
    s.fire('objectChange', 'system.adapter.flow', { common: { version: '1.1.0' } });
    s.fire('objectChange', 'system.adapter.flow.0', { ...updated, common: { ...updated.common, enabled: true } });
    check('catalog: nothing read before the burst is over', fetched, []);
    await new Promise((r) => setTimeout(r, 2300));
    const second = await reg.loadWebComponentCatalog();
    check(
        'catalog: the update read once, without a page reload, under the new version',
        [fetched, second[0]?.moduleUrl],
        [['http://h:8095/adapter/flow/wc/d.json?v=1.1.0'], 'http://h:8095/adapter/flow/wc/d.js?v=1.1.0'],
    );
    stop();
    stop2();
    check(
        'catalog: still watched right after the last user left (tab switch)',
        s.emitted.filter((e) => e[0] === 'unsubscribeObjects').length,
        0,
    );
    globalThis.fetch = realFetch;
}

// ── object views: the ID of a row ───────────────────────────────────────────
check(
    'row of the config view (keyed by name): the object ID',
    m.objectIdOfRow({ id: '12V', value: { _id: 'flow.0.diagrams.12v', type: 'config', common: { name: '12V' } } }),
    'flow.0.diagrams.12v',
);
check('row keyed by ID: unchanged', m.objectIdOfRow({ id: 'a.0.b', value: { _id: 'a.0.b' } }), 'a.0.b');
check(
    'row without an object (e.g. the custom view): its key',
    [m.objectIdOfRow({ id: 'a.0.b', value: { enabled: true } }), m.objectIdOfRow({ id: 'a.0.c' })],
    ['a.0.b', 'a.0.c'],
);

if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
}
console.log('\nall web component checks passed');
// the catalog keeps watching a while after its last user left (a timer of 10 s)
process.exit(0);
