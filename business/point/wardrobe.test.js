import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWardrobePrompt, parseWardrobe, formatWardrobeText, renderWardrobeHtml, createWardrobeController } from './wardrobe.js';
import { createTaskOwnerManager } from '../../runtime/task-owner.js';
import { __portableChatDataTestSeams, buildPortableChatPackage, parsePortableChatPackage, createPortableImportPlan } from '../../runtime/portable-chat-data.js';

const raw = 'Title: 雨天店内\nScene: 午后下雨，三人在旧书店整理来信。\nPerson: 用户 | 正文写明蓝色衬衫，搭配深色长裤。\nImage: the user wearing a blue shirt and dark trousers\nPerson: 同行者 | 正文未写衣服，按店内活动搭配米色针织衫和便鞋。\nImage: the companion wearing a cream sweater and loafers\nPerson: 书店老板 | 沿用正文灰围裙，袖口卷起。\nImage: the shopkeeper wearing a grey apron with rolled sleeves';

test('同次解析多人含配角，完整项保留且图词精确对应', () => {
    const value = parseWardrobe(raw+'\nPerson: 残缺 | 只有说明\nPerson: 空说明 |\nImage: unrelated');
    assert.deepEqual(value.items.map(x=>x.name),['用户','同行者','书店老板']);
    assert.match(value.items[2].imagePrompt,/shopkeeper/);
    assert.match(value.scene,/旧书店/);
});
test('提示合同以当前剧情选人和还原着装，不从点或固定两槽选人', () => {
    const prompt=buildWardrobePrompt({storyDate:'霜月16日',previousWardrobe:parseWardrobe(raw)});
    for(const text of ['当前场景','已写明','没有写明','同一次','单人全身','People: NONE','霜月16日']) assert.ok(prompt.includes(text),text);
    assert.doesNotMatch(prompt,/固定.*[两二]人|必须.*外出/);
    assert.match(prompt,/Person.*短关键词/);
    assert.match(prompt,/一两行/);
    assert.match(prompt,/Scene只用一句/);
    assert.match(prompt,/Image保留完整/);
    assert.match(prompt,/Image[^\n]*自然动作[^\n]*视角/);
    assert.doesNotMatch(prompt,/完整中文着装说明/);
    const readable=formatWardrobeText({...parseWardrobe(raw),items:parseWardrobe(raw).items.map(x=>({...x,image:{path:'/private.png'}}))});
    assert.match(readable,/书店老板/);assert.doesNotMatch(readable,/shopkeeper|private.png|Image:/);
});
function harness(response){let value=null,calls=0,writes=0;const controller=createWardrobeController({owners:createTaskOwnerManager(),chatId:()=> 'a',read:()=>value,storyDate:()=> '秋日',generate:async()=>{calls++;return typeof response==='function'?await response():response;},write:async next=>{writes++;value=next;return {ok:true,commitState:'local-applied'};},render(){},toast(){}});return {controller,read:()=>value,calls:()=>calls,writes:()=>writes};}
test('一次文字生成完成方案并local-applied，零额外识别请求',async()=>{const h=harness(raw);assert.equal((await h.controller.run()).status,'updated');assert.equal(h.calls(),1);assert.equal(h.writes(),1);assert.equal(h.read().items.length,3);assert.equal(h.read().storyDate,'秋日');});
test('坏回包不覆盖，明确无人情景可如实保存',async()=>{const bad=harness('一段没有人物结构的回复');assert.equal((await bad.controller.run()).status,'failed');assert.equal(bad.writes(),0);const none=harness('Title: 空屋\nScene: 屋里无人，不能识别可搭配人物。\nPeople: NONE');assert.equal((await none.controller.run()).status,'updated');assert.equal(none.read().empty,true);assert.equal(none.read().items.length,0);});
test('取消后迟到文字不落盘',async()=>{let finish;const h=harness(()=>new Promise(resolve=>finish=resolve));const pending=h.controller.run();h.controller.cancel();finish(raw);assert.equal((await pending).status,'cancelled');assert.equal(h.writes(),0);});
test('衣橱文档及图库引用随points显式导出导入，保目标聊天其它模块',()=>{
    assert.equal(__portableChatDataTestSeams.KEY_MATCHERS.points('wardrobe-user'),true);
    const value={...parseWardrobe(raw),items:parseWardrobe(raw).items.map(x=>({...x,image:{path:'/outfit.png',seed:1}}))};
    const exported=buildPortableChatPackage({selectedModules:['points'],roots:{'sp-store':{version:1,data:{'wardrobe-user':value}}}});
    const parsed=parsePortableChatPackage(JSON.stringify(exported.package));
    const plan=createPortableImportPlan({roots:{'sp-store':{version:1,data:{'wardrobe-user':{title:'旧'},'lines-user':{raw:'保留'}}}},portablePackage:parsed.package,selectedModules:['points'],targetChatId:'target'});
    assert.deepEqual(plan.replacementRoots['sp-store'].data['wardrobe-user'],value);
    assert.equal(plan.replacementRoots['sp-store'].data['lines-user'].raw,'保留');
});

test('衣橱展示转义姓名与说明，合法项保持原生图索引和隐藏配图',()=>{
    const html=renderWardrobeHtml({items:[null,{name:'<img src=x>',description:'衣服 & <script>bad</script>',imagePrompt:'test'}]});
    assert.match(html,/data-wardrobe-image-index="1"/);
    assert.match(html,/&lt;img src=x&gt;/);
    assert.doesNotMatch(html,/<script>|<img src=x>/);
    assert.match(html,/aria-hidden="true" inert/);
    assert.match(html,/sp-wardrobe-image-generate/);
    assert.doesNotMatch(html,/<img class="sp-wardrobe-image-picture"/);
});
