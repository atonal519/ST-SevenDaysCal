import test from 'node:test';
import assert from 'node:assert/strict';
import {
    QUICK_REPLY_SHORTCUTS,
    QUICK_REPLY_SHORTCUT_COMMAND,
    QUICK_REPLY_SHORTCUT_SET,
    createQuickReplyShortcutSync,
    quickReplyShortcutMessage,
    registerQuickReplyShortcutCommand,
} from './quick-reply-shortcuts.js';

function createHost() {
    const durable = new Map();
    const active = new Set();
    const sets = new Map();
    const saveLog = [];
    const clone = value => structuredClone(value);
    const save = set => {
        saveLog.push(set.name);
        durable.set(set.name, clone({ name: set.name, qrList: set.qrList }));
    };
    const api = {
        settings: { config: { hasSet: set => active.has(set.name) } },
        getSetByName: name => sets.get(name),
        async createSet(name) {
            const set = { name, qrList: [] };
            sets.set(name, set);
            save(set);
            return set;
        },
        createQuickReply(setName, label, props) {
            const qr = { label, ...props };
            sets.get(setName).qrList.push(qr);
            save(sets.get(setName));
            return qr;
        },
        deleteQuickReply(setName, label) {
            const set = sets.get(setName);
            set.qrList = set.qrList.filter(qr => qr.label !== label);
            save(set);
        },
        addGlobalSet(name) { active.add(name); },
        removeGlobalSet(name) { active.delete(name); },
        async deleteSet(name) { sets.delete(name); durable.delete(name); active.delete(name); },
        reload() {
            sets.clear();
            for (const [name, data] of durable) sets.set(name, clone(data));
        },
        addManualSet(name, qrList, isActive = true) {
            sets.set(name, { name, qrList: clone(qrList) });
            save(sets.get(name));
            if (isActive) active.add(name);
        },
        durable,
        active,
        sets,
        saveLog,
    };
    return api;
}

test('quick reply shortcut catalog has thirteen unique stable entry keys', () => {
    assert.equal(QUICK_REPLY_SHORTCUTS.length, 13);
    assert.equal(new Set(QUICK_REPLY_SHORTCUTS.map(item => item.key)).size, 13);
    assert.equal(new Set(QUICK_REPLY_SHORTCUTS.map(item => item.label)).size, 13);
    assert.equal(QUICK_REPLY_SHORTCUTS.find(item => item.key === 'axis-calendar').sheet, 'calendar');
    assert.equal(QUICK_REPLY_SHORTCUTS.find(item => item.key === 'lines-dashed').view, 'lines');
});

test('empty defaults create nothing; selected entries persist, execute the command, and preserve manual QR', async () => {
    const api = createHost();
    const errors = [];
    let parserCommand;
    const opened = [];
    const sync = createQuickReplyShortcutSync({ getApi: () => api, notify: message => errors.push(message) });
    await sync([]);
    assert.equal(api.sets.size, 0);

    registerQuickReplyShortcutCommand({
        parser: { addCommandObject: command => { parserCommand = command; } },
        commandClass: { fromProps: props => props },
        open: key => opened.push(key),
        notify: message => errors.push(message),
    });
    assert.equal(parserCommand.name, QUICK_REPLY_SHORTCUT_COMMAND);

    await sync(['point', 'axis-calendar', 'daily-menu']);
    let set = api.getSetByName(QUICK_REPLY_SHORTCUT_SET);
    assert.equal(set.qrList.length, 3);
    assert.equal(api.active.has(QUICK_REPLY_SHORTCUT_SET), true);
    for (const qr of set.qrList) {
        assert.equal(qr.message, quickReplyShortcutMessage(QUICK_REPLY_SHORTCUTS.find(item => item.label === qr.label).key));
        assert.equal(qr.automationId, '');
        assert.equal(qr.executeOnStartup, false);
        assert.equal(qr.executeOnUser, false);
        assert.equal(qr.executeOnAi, false);
        assert.equal(qr.executeOnChatChange, false);
    }

    // Model the native Quick Reply execution path: button message -> parser command callback.
    const menuButton = set.qrList.find(qr => qr.label === '今日菜单');
    const commandResult = await parserCommand.callback({}, menuButton.message.slice(1 + QUICK_REPLY_SHORTCUT_COMMAND.length));
    assert.equal(commandResult, '');
    assert.deepEqual(opened, ['daily-menu']);
    assert.equal(await parserCommand.callback({}, 'unknown-key'), '');
    assert.equal(errors.length, 1);

    api.reload();
    set = api.getSetByName(QUICK_REPLY_SHORTCUT_SET);
    assert.deepEqual(set.qrList.map(qr => qr.label).sort(), ['今日菜单', '点', '轴 · 日历']);

    set.qrList.push({ label: '手工按钮', message: '/help', automationId: '' });
    await sync(['point']);
    set = api.getSetByName(QUICK_REPLY_SHORTCUT_SET);
    assert.deepEqual(set.qrList.map(qr => qr.label), ['点', '手工按钮']);
    assert.equal(api.active.has(QUICK_REPLY_SHORTCUT_SET), true);

    await sync([]);
    assert.equal(api.active.has(QUICK_REPLY_SHORTCUT_SET), true);
    assert.deepEqual(api.getSetByName(QUICK_REPLY_SHORTCUT_SET).qrList.map(qr => qr.label), ['手工按钮']);
    assert.equal(api.getSetByName(QUICK_REPLY_SHORTCUT_SET).qrList[0].message, '/help');
});

test('same-name user set remains untouched and does not invoke the replacing createSet API', async () => {
    const api = createHost();
    api.addManualSet(QUICK_REPLY_SHORTCUT_SET, [{ label: '我的按钮', message: '/help' }]);
    const errors = [];
    let createCalls = 0;
    const createSet = api.createSet;
    api.createSet = async (...args) => { createCalls++; return createSet(...args); };
    const sync = createQuickReplyShortcutSync({ getApi: () => api, notify: message => errors.push(message) });

    await sync(['point']);
    assert.equal(createCalls, 0);
    assert.deepEqual(api.getSetByName(QUICK_REPLY_SHORTCUT_SET).qrList.map(qr => qr.label), ['我的按钮']);
    assert.equal(api.active.has(QUICK_REPLY_SHORTCUT_SET), true);
    assert.equal(errors.length, 1);
});

test('clearing shortcuts preserves the user visibility choice for a group with manual entries', async () => {
    const api = createHost();
    api.addManualSet(QUICK_REPLY_SHORTCUT_SET, [
        { label: '点', message: quickReplyShortcutMessage('point'), automationId: '' },
        { label: '手工按钮', message: '/help', automationId: '' },
    ], false);
    const sync = createQuickReplyShortcutSync({ getApi: () => api });
    await sync([]);
    assert.equal(api.active.has(QUICK_REPLY_SHORTCUT_SET), false);
    assert.deepEqual(api.getSetByName(QUICK_REPLY_SHORTCUT_SET).qrList.map(qr => qr.label), ['手工按钮']);
});

test('an empty pre-existing same-name set is not claimed as an owned shortcut set', async () => {
    const api = createHost();
    api.addManualSet(QUICK_REPLY_SHORTCUT_SET, [], false);
    let createCalls = 0;
    const createSet = api.createSet;
    api.createSet = async (...args) => { createCalls++; return createSet(...args); };
    const errors = [];
    await createQuickReplyShortcutSync({ getApi: () => api, notify: message => errors.push(message) })(['point']);
    assert.equal(createCalls, 0);
    assert.deepEqual(api.getSetByName(QUICK_REPLY_SHORTCUT_SET).qrList, []);
    assert.equal(errors.length, 1);
});

test('clearing the last owned entry removes an empty generated set before a future same-name set exists', async () => {
    const api = createHost();
    const sync = createQuickReplyShortcutSync({ getApi: () => api });
    await sync(['point']);
    await sync([]);
    assert.equal(api.getSetByName(QUICK_REPLY_SHORTCUT_SET), undefined);
    assert.equal(api.durable.has(QUICK_REPLY_SHORTCUT_SET), false);
});

test('the final pending native-set save resolves before deletion and allows a later reload and selection', async () => {
    const api = createHost();
    const sync = createQuickReplyShortcutSync({ getApi: () => api });
    await sync(['point']);
    const set = api.getSetByName(QUICK_REPLY_SHORTCUT_SET);
    const originalDeleteQuickReply = api.deleteQuickReply;
    const originalDeleteSet = api.deleteSet;
    const order = [];
    let resolvePending;
    let pendingSave;
    set.save = () => {
        if (pendingSave) {
            order.push('flush-save');
            resolvePending();
        }
        return pendingSave ?? Promise.resolve();
    };
    api.deleteQuickReply = (name, label) => {
        originalDeleteQuickReply(name, label);
        pendingSave = new Promise(resolve => { resolvePending = () => { order.push('save-complete'); resolve(); }; });
    };
    api.deleteSet = async name => {
        order.push('delete-set');
        await originalDeleteSet(name);
    };

    await sync([]);
    assert.deepEqual(order, ['flush-save', 'save-complete', 'delete-set']);
    api.reload();
    assert.equal(api.getSetByName(QUICK_REPLY_SHORTCUT_SET), undefined);
    await sync(['outline']);
    api.reload();
    assert.deepEqual(api.getSetByName(QUICK_REPLY_SHORTCUT_SET).qrList.map(qr => qr.label), ['面']);
});

test('rapid preference changes reconcile in order to the last selected state', async () => {
    const api = createHost();
    const sync = createQuickReplyShortcutSync({ getApi: () => api });
    await Promise.all([sync(['point']), sync(['outline']), sync([])]);
    assert.equal(api.getSetByName(QUICK_REPLY_SHORTCUT_SET), undefined);
    assert.equal(api.active.has(QUICK_REPLY_SHORTCUT_SET), false);
});
