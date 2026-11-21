'use strict';

/**
 * The message `help` (lib/help.js) describes the messages for AI agents. Its list of commands has to follow
 * onMessage in main.js (and SCENE_COMMANDS of lib/scenes.js), and the text has to name every command.
 *
 * main.js is loaded with `@iobroker/adapter-core` stubbed out, as in messages.test.js.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

class FakeAdapter {
    constructor(options) {
        this.name = options.name;
        this.namespace = 'aura.0';
        this.log = { info() {}, warn() {}, error() {}, debug() {} };
    }
    on() {}
}
const corePath = require.resolve('@iobroker/adapter-core');
require.cache[corePath] = {
    id: corePath,
    filename: corePath,
    loaded: true,
    exports: { Adapter: FakeAdapter },
};

const createAdapter = require('../main.js');
const { HELP, COMMANDS } = require('../lib/help');
const { SCENE_COMMANDS } = require('../lib/scenes');

/** The commands of onMessage in main.js */
function commandsOfMain() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const start = source.indexOf('    async onMessage(msg) {');
    const end = source.indexOf('\n    }\n', start);
    assert.ok(start > 0 && end > start, 'onMessage found');
    const names = [...source.slice(start, end).matchAll(/\bmsg\.command === '([^']+)'/g)].map((m) => m[1]);
    return [...new Set([...names, ...SCENE_COMMANDS])];
}

(async () => {
    const names = COMMANDS.map((c) => c.command);
    assert.deepStrictEqual([...names].sort(), commandsOfMain().sort(), 'COMMANDS lists exactly what onMessage answers');
    assert.deepStrictEqual(names, [...new Set(names)], 'every command once');
    console.log('\u2713 COMMANDS lists exactly the commands onMessage answers');

    for (const { command } of COMMANDS.filter((c) => c.command !== 'help')) {
        assert.ok(HELP.includes(command), `HELP names ${command}`);
    }
    for (const line of HELP.split('\n')) {
        assert.ok(line.length <= 120, `line too long: ${line}`);
    }
    console.log('\u2713 HELP names every command, lines of at most 120 characters');

    const write = Object.fromEntries(COMMANDS.map((c) => [c.command, c.write]));
    for (const command of ['notify', 'message', 'saveScene', 'deleteScene', 'staggeredWrite', 'restartAdapter']) {
        assert.strictEqual(write[command], true, `${command} writes`);
    }
    for (const command of ['help', 'listScenes', 'sceneDevices', 'listTimers', 'getRecentLogs']) {
        assert.strictEqual(write[command], false, `${command} only reads`);
    }
    console.log('\u2713 commands that change something are marked write');

    const a = createAdapter({});
    const replies = [];
    a.sendTo = (to, command, result, callback) => replies.push({ to, command, result, callback });
    await a.onMessage({ command: 'help', message: {}, from: 'system.adapter.pi-agent.0', callback: { id: 1 } });
    assert.strictEqual(replies.length, 1);
    assert.strictEqual(replies[0].to, 'system.adapter.pi-agent.0');
    assert.deepStrictEqual(replies[0].result, { help: HELP, commands: COMMANDS });
    console.log('\u2713 help answers {help, commands}');

    // \u2500\u2500 The family "screen" of the shared catalog of ioBroker.assistant \u2500\u2500\u2500\u2500\u2500\u2500
    const standard = Object.fromEntries(COMMANDS.filter((c) => c.standard).map((c) => [c.command, c.standard]));
    assert.deepStrictEqual(standard, {
        getScreens: 'screen.getScreens',
        show: 'screen.show',
        hide: 'screen.hide',
    });
    for (const [command, name] of Object.entries(standard)) {
        assert.ok(HELP.includes(name), `HELP names ${name}`);
        assert.strictEqual(write[command], command !== 'getScreens', `${command} write`);
    }
    console.log('\u2713 the catalog commands are marked with standard and named in HELP');

    const now = Date.now();
    const states = {
        'aura.0.clients.c1.info.name': { val: 'K\u00fcche Tablet' },
        'aura.0.clients.c1.info.lastSeen': { val: now - 1000 },
        'aura.0.clients.c2.info.name': { val: 'Flur' },
        'aura.0.clients.c2.info.lastSeen': { val: now - 3600000 },
        'aura.0.clients.c3.info.name': { val: 'K\u00fcche Handy' },
        'aura.0.clients.c3.info.lastSeen': { val: now - 1000 },
    };
    const delivered = [];
    const marked = [];
    a.getStatesAsync = async (pattern) => {
        const leaf = pattern.split('.').pop();
        return Object.fromEntries(Object.entries(states).filter(([id]) => id.endsWith(`.info.${leaf}`)));
    };
    a._deliverMessage = async (raw) => {
        delivered.push(JSON.parse(raw));
        return { id: `m${delivered.length}`, ts: now };
    };
    a._handleMessageMark = async (id, mode) => marked.push([id, mode]);
    const call = async (command, message, callback = { id: 2 }) => {
        replies.length = 0;
        await a.onMessage({ command, message, from: 'system.adapter.assistant.0', callback });
        return replies[0] && replies[0].result;
    };

    let r = await call('getScreens', {});
    assert.deepStrictEqual(
        r.screens.map((s) => [s.id, s.name, s.online]),
        [
            ['c1', 'K\u00fcche Tablet', true],
            ['c2', 'Flur', false],
            ['c3', 'K\u00fcche Handy', true],
        ],
    );
    assert.deepStrictEqual(r.screens[0].kinds, ['text', 'image', 'view']);
    console.log('\u2713 getScreens lists the dashboards with their kinds');

    r = await call('show', {
        kind: 'text',
        text: 'Waschmaschine fertig',
        screen: 'flur',
        severity: 'alert',
        seconds: 0,
    });
    assert.deepStrictEqual(r, { ok: true, id: 'm1', screens: ['Flur'] });
    assert.deepStrictEqual(delivered[0], {
        text: 'Waschmaschine fertig',
        severity: 'error',
        durationSec: 0,
        persist: false,
        target: { clients: ['c2'] },
    });
    r = await call('show', { kind: 'image', image: 'iobfile://echarts.0/agent/chart.png', title: 'Heute' });
    assert.deepStrictEqual(r, { ok: true, id: 'm2', screens: ['K\u00fcche Tablet', 'K\u00fcche Handy'] });
    assert.deepStrictEqual(delivered[1], { title: 'Heute', image: '/webfs/echarts.0/agent/chart.png', persist: false });
    r = await call('show', { kind: 'image', image: 'iVBORw0KGgo=', contentType: 'image/png', persist: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(delivered[2].image, 'data:image/png;base64,iVBORw0KGgo=');
    assert.strictEqual(delivered[2].persist, true, 'a field of notify passes on');
    r = await call('show', { kind: 'view', view: 'Kamera', screen: 'c1', seconds: 20, position: 'center' });
    assert.deepStrictEqual(delivered[3], {
        view: 'Kamera',
        position: 'center',
        durationSec: 20,
        persist: false,
        target: { clients: ['c1'] },
    });
    // a camera snapshot as a data URL, as ioBroker.assistant sends it: the message keeps it whole
    const snapshot = `data:image/jpeg;base64,${'A'.repeat(300000)}`;
    r = await call('show', { kind: 'image', image: snapshot, screen: 'Flur' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(delivered[4].image, snapshot);
    assert.strictEqual(a._normalizeMessage(JSON.stringify(delivered[4]), { kind: 'global' }).image, snapshot);
    console.log('\u2713 show maps text, image and view onto notify');

    const count = delivered.length;
    const refused = [];
    refused.push(await call('show', { kind: 'chart', ids: ['a.0.temp'] }));
    assert.strictEqual(refused.at(-1).reason, 'NOT_SUPPORTED');
    refused.push(await call('show', { text: 'no kind' }));
    assert.strictEqual(refused.at(-1).reason, 'BAD_REQUEST');
    refused.push(await call('show', { kind: 'text', text: 'x', screen: 'k\u00fcche' }));
    assert.strictEqual(refused.at(-1).reason, 'AMBIGUOUS');
    assert.deepStrictEqual(refused.at(-1).candidates, ['K\u00fcche Tablet', 'K\u00fcche Handy']);
    refused.push(await call('show', { kind: 'text', text: 'x', screen: 'Bad' }));
    assert.strictEqual(refused.at(-1).reason, 'NOT_FOUND');
    refused.push(await call('show', { kind: 'text', text: 'x', room: 'enum.rooms.kitchen' }));
    assert.strictEqual(refused.at(-1).reason, 'NOT_SUPPORTED');
    refused.push(await call('show', { kind: 'camera', camera: 'door', instance: 'cameras.0' }));
    assert.strictEqual(refused.at(-1).reason, 'NOT_SUPPORTED');
    refused.push(
        await call('show', { kind: 'image', image: `data:image/png;base64,${'A'.repeat(3000)}`, persist: true }),
    );
    assert.strictEqual(refused.at(-1).reason, 'BAD_REQUEST', 'the history keeps only a picture address');
    refused.push(await call('show', { kind: 'text' }));
    assert.strictEqual(refused.at(-1).reason, 'BAD_REQUEST');
    assert.strictEqual(delivered.length, count, 'nothing shown on a failure');
    for (const answer of refused) {
        assert.ok(typeof answer.error === 'string' && !('ok' in answer), JSON.stringify(answer));
    }
    console.log('\u2713 show refuses with the codes of the catalog');

    r = await call('hide', { id: 'm1' });
    assert.deepStrictEqual(r, { ok: true, id: 'm1' });
    r = await call('hide', {});
    assert.deepStrictEqual(r, { ok: true, id: 'm5' }, 'without id: the last show');
    assert.deepStrictEqual(marked, [
        ['m1', 'dismiss'],
        ['m5', 'dismiss'],
    ]);
    r = await call('hide', {});
    assert.strictEqual(r.reason, 'BAD_REQUEST', 'nothing left to hide');
    // without a callback it still has its effect
    await call('show', { kind: 'text', text: 'ohne R\u00fcckruf' }, null);
    assert.strictEqual(delivered.at(-1).text, 'ohne R\u00fcckruf');
    console.log('\u2713 hide closes a show, also the last one without id');

    console.log('\nAll help tests passed.');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
