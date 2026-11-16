import test from 'node:test';
import assert from 'node:assert/strict';
import { createPointWidgetActions } from './widget.js';
import { firstPointEventBlock, parsePointEventRecord, replacePointEventBlock, numberedPointList } from './parse.js';
import { appendSpaceAssistant, compactPointBaselines, pointRawToken, stripWidgetsForApi } from '../space/schema.js';
import { createSpaceContext } from '../space/context.js';

const initial = `<calendar_widget>
StartDate: 2026-11-16
Day: 1
${Array.from({ length: 13 }, (_, i) => `Event: main|安排${i + 1}|说明${i + 1}|上午|地点|动态`).join('\n')}
</calendar_widget>`;
const owner = { view: 'user', charName: '' };
const card = n => `Event: main|新安排${n}|新说明${n}|下午|新地点|新动态`;

function harness(raw = initial, scopes = null) {
    const key = (view, charName) => `${view}:${charName}`;
    const stores = new Map((scopes || [{ ...owner, raw, ts: 1 }]).map(scope => [key(scope.view, scope.charName), { raw: scope.raw, ts: scope.ts }]));
    const baselines = compactPointBaselines(scopes || [{ ...owner, raw, ts: 1 }]);
    const notices = [], writes = [];
    let rejectWrite = false;
    const create = () => createPointWidgetActions({
        firstPointEventBlock, parsePointEventRecord, replaceNthEventLine: replacePointEventBlock, pointRawToken,
        getCacheKey: key, readStore: name => stores.get(name),
        writeStore: (name, value) => { if (rejectWrite) return false; stores.set(name, value); writes.push(name); return true; },
        getUserName: () => '用户', currentView: () => 'none', syncLatestScheduleBlock() {},
        showToast: message => notices.push(message),
    });
    return {
        create, stores, baselines, notices, writes, failWrite: value => { rejectWrite = value; },
        options: (editIndex, scope = owner, pointBaselines = baselines) => ({ editIndex, owner: scope, pointBaselines }),
        raw: (scope = owner) => stores.get(key(scope.view, scope.charName))?.raw,
    };
}

test('thirteen edits from one reply apply independently, including after history serialization and a new runtime', async () => {
    const h = harness();
    const context = createSpaceContext({
        context: () => ({ name1: '用户', name2: '角色' }),
        readPointScopes: () => [{ ...owner, raw: initial, ts: 1 }], numberedPoints: numberedPointList,
    });
    const request = await context.buildMessages({ target: {}, userMsg: '按面修改这13条点', historySnapshot: [] });
    assert.equal(request.pointBaselines[0].eventTokens?.length, 13);
    assert.doesNotMatch(JSON.stringify(request), /eventTokens|rawToken/);
    const reply = appendSpaceAssistant([], Array.from({ length: 13 }, (_, i) => `<schedule_widget edit="${i + 1}" view="user">${card(i + 1)}</schedule_widget>`).join('\n'), request)[0];
    for (let n = 1; n <= 13; n++) {
        const restored = JSON.parse(JSON.stringify(reply));
        assert.equal(await h.create()(card(n), null, h.options(n, owner, restored.pointBaselines)), true, `card ${n}`);
    }
    assert.equal(h.writes.length, 13);
    for (let n = 1; n <= 13; n++) assert.match(h.raw(), new RegExp(`Event: main\\|新安排${n}\\|新说明${n}\\|`));
    assert.equal(h.notices.some(message => message.includes('已变化')), false);
    assert.deepEqual(stripWidgetsForApi([reply], { preserveCandidates: true }).map(Object.keys), [['role', 'content']]);
});

test('out of order edits preserve every other item and can append without expiring remaining replacements', async () => {
    const h = harness();
    for (const n of [13, 4, 1, 8]) assert.equal(await h.create()(card(n), null, h.options(n)), true);
    const store = h.stores.get('user:');
    h.stores.set('user:', { ...store, raw: store.raw.replace('</calendar_widget>', 'Future:\nEvent: bond|另加未来安排|另一说明|下周|地点|动态\n</calendar_widget>'), ts: 77 });
    assert.equal(await h.create()(card(2), null, h.options(2)), true);
    assert.match(h.raw(), /另加未来安排/);
    assert.match(h.raw(), /Event: main\|安排3\|说明3/);
});

test('a changed target is rejected but does not invalidate the other original targets', async () => {
    const h = harness();
    h.stores.set('user:', { raw: replacePointEventBlock(initial, 0, 'Event: main|手改安排|手改说明|晚上|地点|动态'), ts: 9 });
    assert.equal(await h.create()(card(1), null, h.options(1)), false);
    assert.equal(h.writes.length, 0); assert.match(h.notices.at(-1), /点已变化/);
    assert.equal(await h.create()(card(2), null, h.options(2)), true);
    assert.match(h.raw(), /手改安排/);
    assert.equal(await h.create()(card(2), null, h.options(2)), false, 'the same original target cannot be replaced twice');
});

test('moving an item, changing its day or shifting StartDate invalidates its original target', async () => {
    const raw = '<calendar_widget>\nStartDate: 2026-11-16\nDay: 1\nEvent: main|同名安排|说明|上午|地点|动态\nDay: 2\nEvent: main|同名安排|说明|上午|地点|动态\n</calendar_widget>';
    for (const changed of [
        raw.replace('Day: 2', 'Day: 3'),
        raw.replace('2026-11-16', '2026-11-17'),
        raw.replace('Day: 1\nEvent: main|同名安排|说明|上午|地点|动态\n', ''),
    ]) {
        const h = harness(raw); h.stores.set('user:', { raw: changed, ts: 9 });
        assert.equal(await h.create()(card(2), null, h.options(2)), false);
        assert.equal(h.writes.length, 0);
    }
});

test('scoped snapshots keep user and different characters separate', async () => {
    const a = { view: 'char', charName: '甲' }, b = { view: 'char', charName: '乙' };
    const h = harness(initial, [owner, a, b].map(scope => ({ ...scope, raw: initial, ts: 1 })));
    for (const scope of [owner, a, b]) assert.equal(await h.create()(card(1), null, h.options(1, scope)), true);
    for (const scope of [owner, a, b]) assert.equal(await h.create()(card(2), null, h.options(2, scope)), true);
    assert.equal(await h.create()(card(3), null, h.options(3, { view: 'char', charName: '丙' })), false);
    assert.equal(h.writes.length, 6);
});

test('target numbering shares the replacement parser, including multiline, wrapped and invalid records', async () => {
    const raw = `<calendar_widget>
Event: main|无归属|不编号|上午|地点|动态
Day: 1
Event: main|残缺
> Event: main|第一条|说明第一行
> 说明第二行|上午|地点|动态|true
> Adult: true
Future:
Event: hidden|第二条|说明|以后|地点|动态
</calendar_widget>`;
    const h = harness(raw);
    assert.match(numberedPointList(raw), /#1.*第一条/); assert.match(numberedPointList(raw), /#2.*第二条/);
    assert.equal(h.baselines[0].eventTokens?.length, 2);
    assert.equal(await h.create()(card(1), null, h.options(1)), true);
    assert.equal(await h.create()(card(2), null, h.options(2)), true);
    assert.match(h.raw(), /新动态\|true/); assert.match(h.raw(), /Adult: true/);
    assert.doesNotMatch(h.raw(), /说明第二行/);
});

test('a failed write leaves the original target applicable, while legacy snapshots keep their prior validation', async () => {
    const h = harness(); h.failWrite(true);
    assert.equal(await h.create()(card(1), null, h.options(1)), false);
    assert.equal(h.raw(), initial); h.failWrite(false);
    assert.equal(await h.create()(card(1), null, h.options(1)), true);
    assert.equal(await h.create()(card(2), null, h.options(2)), true);
    const old = harness();
    const legacy = [{ ...owner, rawToken: pointRawToken(initial), ts: 1 }];
    assert.equal(await old.create()(card(1), null, old.options(1, owner, legacy)), true);
    assert.equal(await old.create()(card(2), null, old.options(2, owner, legacy)), false);
    assert.equal(old.writes.length, 1);
});
