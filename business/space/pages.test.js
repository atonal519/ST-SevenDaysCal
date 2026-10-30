import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpaceRepository } from './repository.js';
import { createSpaceChat } from './chat.js';
import { createSpaceContext } from './context.js';
import { buildPortableChatPackage, parsePortableChatPackage, createPortableImportPlan } from '../../runtime/portable-chat-data.js';
const target = { chatId: 'fixture', historyKey: { kind: 'space-chat', chatId: 'fixture' } };
function fixture(saved = []) {
 let stored = structuredClone(saved); const writes = [];
 const repo = createSpaceRepository({ captureIdentity: () => target, isCurrent: () => true, readStore: () => stored,
  writeStore: (_, value) => { stored = structuredClone(value); writes.push(stored); return true; } });
 repo.load(); return { repo, writes, stored: () => stored };
}
test('旧数组只读归第一页，空第二页保存、冷读、导出且第三页无写入', () => {
 const f=fixture([{role:'user',content:'原备忘'}]);
 assert.deepEqual(f.repo.pages(), ['1']); assert.equal(f.writes.length,0);
 assert.equal(f.repo.addPage(), '2'); assert.equal(f.repo.addPage(), null); assert.equal(f.writes.length,1);
 assert.deepEqual(f.stored(), {version:1,pages:['1','2'],messages:[{role:'user',content:'原备忘'}]});
 assert.deepEqual(fixture(f.stored()).repo.pages(), ['1','2']);
 const empty={version:1,pages:['1','2'],messages:[]};
 const exported=buildPortableChatPackage({selectedModules:['space'],roots:{'sp-store':{version:1,data:{'space-chat-user':empty}}}});
 assert.equal(exported.ok,true); const parsed=parsePortableChatPackage(JSON.stringify(exported.package));assert.equal(parsed.ok,true);
 const plan=createPortableImportPlan({portablePackage:parsed.package,selectedModules:['space'],targetChatId:'next'});
 assert.deepEqual(plan.replacementRoots['sp-store'].data['space-chat-user'],empty);
});
test('页内删除、重发和清屏保留另一页，消息仍使用公共索引', async () => {
 const f=fixture({version:1,pages:['1','2'],messages:[
  {role:'user',content:'A',pageId:'1'},{role:'user',content:'B',pageId:'2'},
  {role:'assistant',content:'A答',pageId:'1'},{role:'assistant',content:'B答',pageId:'2'}]});
 let page='1';const chat=createSpaceChat({repository:f.repo,activePageId:()=>page,loadConfig:()=>({url:'u',key:'k'}),buildMessages:async()=>[],postCompletion:async()=> '新答'});
 assert.equal(chat.remove(1),false); assert.equal((await chat.resendFrom(0,'修订A')).status,'updated');
 assert.deepEqual(f.repo.history().map(x=>[x.content,x.pageId]),[['B','2'],['B答','2'],['修订A','1'],['新答','1']]);
 page='2'; assert.equal(chat.remove(0),true); assert.equal(chat.clear('1'),true);
 assert.deepEqual(f.repo.history().map(x=>x.content),['B答']);assert.deepEqual(f.repo.pages(),['1','2']);
});
test('发送固定页、在途新增第二页保留页列表，公共背景顺序与页内回指完整', async () => {
 const outline=title=>`<outline_widget>Beat: 当前|${title}|关系|主线|结果\nScene: 核对消息</outline_widget>`;
 const f=fixture([{role:'assistant',content:outline('第一页卡'),expectedWidgetKind:'outline_widget',outlineRawToken:'formal'}]);
 let page='1',release;let built;const shown=[];
 const ctx=createSpaceContext({context:()=>({}),readOutlineDraftSnapshot:()=>({raw:''}),rawToken:()=> 'formal'});
 const chat=createSpaceChat({repository:f.repo,activePageId:()=>page,loadConfig:()=>({url:'u',key:'k'}),
  buildMessages:async args=>{built=await ctx.buildMessages(args);return built;},postCompletion:()=>new Promise(r=>release=r),
  ui:{appendMessage:(...args)=>shown.push(args),beginThinking:()=>({}),endThinking(){}}});
 const pending=chat.send('把上一张卡改短些');while(!release)await new Promise(r=>setImmediate(r));
 assert.equal(f.repo.addPage(),'2');page='2'; release(outline('第一页卡'));assert.equal((await pending).status,'updated');
 assert.deepEqual(f.stored().pages,['1','2']);assert.equal(f.repo.history().at(-1).pageId,'1');assert.equal(shown.at(-1)[3].pageId,'1');
 f.repo.replace(target,[...f.repo.history(),{role:'assistant',content:outline('第二页卡'),pageId:'2',expectedWidgetKind:'outline_widget',outlineRawToken:'formal'}]);
 const messages=await ctx.buildMessages({target,userMsg:'把上一张卡改短些',historySnapshot:f.repo.history(),pageId:'1',pages:f.repo.pages()});
 const apiHistory=messages.slice(1).map(item=>item.content).join('\n');
 assert.match(apiHistory,/第一页卡/);assert.match(apiHistory,/第二页卡/);
 assert.ok(apiHistory.indexOf('第一页卡') < apiHistory.indexOf('第二页卡'));
 assert.match(apiHistory,/历史卡片候选｜应用状态以当前正式资料为准/);
 assert.match(messages[0].content,/当前.*窗口.?1/);assert.equal(messages.slice(1,-1).length, f.repo.history().length);
 assert.ok(messages.every(x=>!('pageId' in x)));assert.match(messages.at(-2).content,/窗口.?2/);
});
test('便携旧数组与双页候选往返仅标消息只读，保留页配置', () => {
 for(const value of [[{role:'user',content:'旧记录'}],{version:1,pages:['1','2'],messages:[{role:'assistant',pageId:'2',content:'<outline_widget>Beat: 当前|候选|关系|主线|结果\nScene: 核对消息</outline_widget>'}]}]) {
  const exported=buildPortableChatPackage({selectedModules:['space'],roots:{'sp-store':{version:1,data:{'space-chat-user':value}}}});
  assert.equal(exported.ok,true);const parsed=parsePortableChatPackage(JSON.stringify(exported.package));assert.equal(parsed.ok,true);
  const plan=createPortableImportPlan({portablePackage:parsed.package,selectedModules:['space'],targetChatId:'next'});const imported=plan.replacementRoots['sp-store'].data['space-chat-user'];
  if(Array.isArray(value))assert.deepEqual(imported,value);else{assert.deepEqual(imported.pages,['1','2']);assert.equal(imported.messages[0].portableReadonly,true);assert.equal(imported.messages[0].pageId,'2');}
 }
});

test('页内回指请求交给同次模型理解，并保留完整候选历史', async () => {
    const { classifySpaceIntent } = await import('./context.js');
    const candidate = title => `<outline_widget>Beat: 当前|${title}|关系|主线|结果\nScene: 核对消息</outline_widget>`;
    const publicCard = { role: 'assistant', content: candidate('公共面卡'), pageId: '2', expectedWidgetKind: 'outline_widget', outlineRawToken: 'formal' };
    const request = '把上一张面草稿整理成线卡';
    for (const local of [
        { role: 'assistant', content: '无效面卡', expectedWidgetKind: 'outline_widget', pageId: '1' },
        { role: 'assistant', content: candidate('只读面卡'), expectedWidgetKind: 'outline_widget', portableReadonly: true, pageId: '1' },
        { role: 'assistant', content: '其它卡型', expectedWidgetKind: 'line_widget', pageId: '1' },
    ]) {
        const intent = classifySpaceIntent(request, [publicCard, local], { pageId: '1' });
        assert.equal(intent.action, 'semantic-route');
        assert.deepEqual(intent.allowedWidgetKinds, ['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget', 'outline_widget']);
    }
    const local = { ...publicCard, pageId: '1', content: candidate('本页面卡') };
    const intent = classifySpaceIntent(request, [publicCard, local, publicCard], { pageId: '1' });
    assert.equal(intent.action, 'semantic-route');
    assert.deepEqual(intent.allowedWidgetKinds, ['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget', 'outline_widget']);
});

test('导入替换及数据管理清除后重置临时页草稿，不把窗口2草稿带到窗口1', async () => {
    const { createSpaceFeature } = await import('./feature.js');
    let saved = { version: 1, pages: ['1', '2'], messages: [] };
    let inputValue = '';
    const input = { attr() { return this; }, val(value) { if (arguments.length) { inputValue = value; return this; } return inputValue; } };
    const node = { attr() { return this; }, prop() { return this; }, empty() {} };
    const feature = createSpaceFeature({
        context: () => ({ chatId: 'fixture' }), keyDesc: () => target.historyKey,
        readStore: () => saved, writeStore: () => true, isOpen: () => true,
        ui: { query: selector => selector === '#sp-space-input' ? input : node, element: () => ({ scrollTop: 0, scrollHeight: 0 }) },
    });
    feature.open(); feature.ui.switchPage('2'); input.val('窗口2草稿');
    saved = [{ role: 'user', content: '导入的旧记录' }]; feature.refreshFromStore('space-chat');
    assert.equal(feature.ui.activePageId(), '1'); assert.equal(input.val(), '');
    assert.deepEqual(feature.repository.pages(), ['1']);
    saved = { version: 1, pages: ['1', '2'], messages: [] }; feature.refreshFromStore('space-chat');
    feature.ui.switchPage('2'); input.val('另一份窗口2草稿'); feature.refreshAfterStoreClear('space-chat');
    assert.equal(feature.ui.activePageId(), '1'); assert.equal(input.val(), '');
    assert.deepEqual(feature.repository.pages(), ['1']);
});
