import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDateDetectionController } from './date-detection.js';
import { createAxisInlineRenderer } from './inline.js';
import { ordinalOf, dateFromOrdinal } from '../calendar/date.js';

const root = new URL('../../', import.meta.url);
const index = fs.readFileSync(new URL('index.js', root), 'utf8');
const css = fs.readFileSync(new URL('style.css', root), 'utf8');

test('axis toolbar production contract has shared wide/narrow action dispatcher', () => {
    for (const selector of ['.sp-alm-add', '.sp-alm-gen', '.sp-alm-supplement', '.sp-alm-manage', '.sp-action-menu-toggle', '.sp-action-menu-item']) assert.match(index, new RegExp(selector.replaceAll('.', '\\.'), 'g'));
    for (const action of ['openAlmanacEditor', 'triggerGenerateAlmanac', 'triggerSupplementAnniversary', 'openCalendarManager']) assert.match(index, new RegExp(`dispatchAlmanacAction[\\s\\S]{0,1200}${action}`));
    assert.match(index, /\.sp-action-menu-list.*\.attr\('hidden', !open\)/);
    assert.match(index, /\.toggleClass\('sp-action-menu-open', open\)/);
    assert.match(index, /aria-expanded.*String\(open\)/);
});

test('axis CSS keeps editor action and time-travel fixes scoped', () => {
    assert.match(css, /\.sp-alm-editor-actions > button\s*\{[^}]*border-radius:\s*var\(--sp-size-8\)/);
    assert.match(css, /--sp-size-8:\s*calc\(8px \* var\(--sp-scale\)\)/);
    assert.match(css, /\.sp-alm-time-travel,\s*\.sp-alm-time-travel-stop\s*\{\s*white-space:\s*nowrap;/);
});

test('date chat bootstrap resets weekday signature and suppresses only the exact first-floor aftermath', () => {
    let chatId = 'A'; let floor = 0; let weekday = 1; let aftermath = 0; const writes = [];
    const controller = createDateDetectionController({
        context: () => ({ chatId }), identity: () => ({ chatId, floor, swipe: 0 }), storyEnabled: () => true,
        storyClock: () => ({ floor, endMeta: { complete: true, month: 1, day: floor + 1, weekdayIndex: weekday } }), completeStoryClock: () => true,
        storyDate: () => ({ month: 1, day: floor + 1 }), charKey: () => 'card', getAnchor: () => writes.at(-1) || null,
        setAnchor: (_key, month, day) => { writes.push({ month, day }); return { ok: true }; }, settings: () => ({ notifyMode: 'off' }), aftermath: () => { aftermath++; },
    });
    controller.reland();
    assert.equal(aftermath, 1);
    chatId = 'B'; floor = 0; weekday = 3; controller.reset();
    const bootstrap = controller.reland({ suppressAftermath: true });
    assert.equal(bootstrap.status, 'handled');
    assert.equal(aftermath, 1, '新聊天精确首楼只能落日期/星期，不能触发生成善后');
    floor = 1; weekday = 4;
    controller.reland();
    assert.equal(aftermath, 2, '下一条真实新楼仍须正常触发一次善后');
});

function axisInlineHarness(calendar, anchor) {
    let liveReads=0;
    const yearLength=cal=>cal.months.reduce((n,m)=>n+m.days,0);
    const dayOfYear=(month,day,cal)=>ordinalOf({year:null,month,day},cal);
    const wrap=(n,cal)=>(n-1+yearLength(cal))%yearLength(cal)+1;
    const env={settings:()=>({}),loadItems:()=>{liveReads++;return [];},today:()=>anchor,calendar:()=>calendar,dayOfYear,yearLength,
        clamp:(n,min,max,fallback)=>Math.min(max,Math.max(min,Number(n)||fallback)),
        itemCoversDoy:(it,doy,cal)=>(doy-dayOfYear(it.month,it.day,cal)+yearLength(cal))%yearLength(cal)<it.days,
        daysUntil:(m,d,a,cal)=>(dayOfYear(m,d,cal)-dayOfYear(a.month,a.day,cal)+yearLength(cal))%yearLength(cal),
        endMonthDay:(it,cal)=>dateFromOrdinal(wrap(dayOfYear(it.month,it.day,cal)+it.days-1,cal),cal),
        formatDate:(md,cal)=>`${cal.months[md.month-1].name}${md.day}日`,
        typeMeta:type=>({cls:type,label:type==='festival'?'节日':'纪念日'}),
        monthName:(cal,m)=>cal.months[m-1].name,weekdayFor:()=>null,weekdays:[],monthDayFromDoy:(doy,cal)=>dateFromOrdinal(doy,cal),
        cleanText:String,escapeHtml:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')};
    return {env,renderer:createAxisInlineRenderer(env),liveReads:()=>liveReads};
}
test('轴楼内五条内事项仅一次，当前/未来排序并用传入历法显示多日和跨年范围',()=>{
    const cal={kind:'custom',months:[{name:'首月',days:5},{name:'末月',days:4}]};
    const h=axisInlineHarness(cal,{month:1,day:4});
    const rows=[{id:'far',name:'较远事项',type:'festival',month:2,day:3,days:1},{id:'active',name:'进行事项',type:'festival',month:1,day:3,days:3,note:'保留完整说明'},{id:'now',name:'今天事项',type:'anniversary',month:1,day:4,days:1},{id:'next',name:'明日事项',type:'festival',month:1,day:5,days:1},{id:'cross',name:'跨年事项',type:'festival',month:2,day:4,days:3,displayDate:'旧节俗日期'}];
    const result=h.renderer.buildAlmanacBlock(rows,{month:1,day:4},cal);
    assert.match(result.summary,/5件事/);
    assert.equal((result.itemsHtml.match(/class="sp-alm-event /g)||[]).length,5);
    assert.ok(result.itemsHtml.indexOf('进行事项')<result.itemsHtml.indexOf('今天事项'));
    assert.ok(result.itemsHtml.indexOf('今天事项')<result.itemsHtml.indexOf('明日事项'));
    assert.match(result.itemsHtml,/首月3日—首月5日/);
    assert.match(result.itemsHtml,/末月4日—首月2日.*跨年/);
    assert.match(result.itemsHtml,/旧节俗日期/);
    assert.match(result.itemsHtml,/保留完整说明/);
    assert.doesNotMatch(result.itemsHtml,/sp-alm-scell|sp-alm-strip|sp-alm-up-row|<svg/);
    assert.equal(h.liveReads(),0);
});
test('轴楼内历史明确历法不回落活态，未知/空事项/关闭保持无伪内容',()=>{
    const live={kind:'custom',months:[{name:'现行月',days:30}]};
    const historical={kind:'custom',months:[{name:'旧历月',days:10}]};
    const h=axisInlineHarness(live,{month:1,day:1});
    const rows=[{id:'old',name:'旧事项',type:'festival',month:1,day:8,days:1}];
    assert.match(h.renderer.buildAlmanacBlock(rows,{month:1,day:3},historical).itemsHtml,/旧历月8日/);
    assert.equal(h.renderer.buildAlmanacBlock(rows,{month:1,day:3},null),null);
    assert.equal(h.renderer.buildAlmanacBlock([],null,historical),null);
    h.env.settings=()=>({almanacInlineEnabled:false});
    assert.equal(h.renderer.buildAlmanacBlock(rows,null,historical),null);
    assert.equal(h.liveReads(),0);
});

test('轴楼内44条乱序只显示排序后最近五条，少于五条按真实数量且不改源数据',()=>{
    const cal={kind:'custom',months:[{name:'首月',days:30},{name:'次月',days:30},{name:'末月',days:30}]};
    const h=axisInlineHarness(cal,{month:1,day:10});
    const source=[{id:'active',name:'进行中',type:'festival',month:1,day:9,days:3},{id:'today',name:'今天',type:'birthday',month:1,day:10,days:1},
        ...Array.from({length:42},(_,i)=>{const ordinal=i+11;return {id:`next-${ordinal}`,name:`未来${ordinal}`,type:'festival',month:Math.floor((ordinal-1)/30)+1,day:(ordinal-1)%30+1,days:1};})].reverse();
    const before=JSON.stringify(source);const rows=Object.freeze(source.map(Object.freeze));
    const result=h.renderer.buildAlmanacBlock(rows,{month:1,day:10},cal);
    assert.match(result.summary,/5件事/);
    assert.deepEqual([...result.itemsHtml.matchAll(/data-alm-id="([^"]+)"/g)].map(m=>m[1]),['active','today','next-11','next-12','next-13']);
    assert.equal(JSON.stringify(rows),before);assert.equal(rows.length,44);
    const short=h.renderer.buildAlmanacBlock([rows.find(it=>it.id==='next-12'),rows.find(it=>it.id==='active')],{month:1,day:10},cal);
    assert.match(short.summary,/2件事/);assert.equal((short.itemsHtml.match(/class="sp-alm-event /g)||[]).length,2);
});
