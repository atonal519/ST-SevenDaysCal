import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiEditorActions } from './api-editor.js';
function setup(settings={}){let saves=0,fail;const api=createApiEditorActions({getSettings:()=>settings,saveSettings:async()=>{saves++;await fail?.();},validateAdditional:value=>{if(value.trim())JSON.parse(value);},createId:()=>`new-${saves}`});return{settings,api,saves:()=>saves,fail:value=>{fail=value;}};}
const connection=(id='a')=>({id,name:id,url:`https://${id}.invalid`,key:`${id}-key`,model:`${id}-model`,excludeParams:['seed'],timeoutSec:90,stream:true,foreign:{keep:true},qqjTemperature:0});
test('global create is blank-key isolated and stays unbound on fresh reads, while explicit selection applies content',async()=>{
 const t=setup({apiPresets:[],apiUrl:'',apiKey:'',apiModel:'',apiPresetActiveId:'',utilityPresetId:'',theaterPresetId:''});
 await assert.rejects(t.api.create('新连接',{url:'https://new.invalid',key:'',model:'m'}),/Key|密钥/);assert.equal(t.saves(),0);
 const id=await t.api.create('新连接',{url:'https://new.invalid',key:'new-key',model:'m',timeoutSec:180});assert.equal(t.settings.apiPresetActiveId,'');assert.equal(t.settings.apiUrl,'');assert.equal(t.api.capture('content').profile.url,'');assert.equal(setup(t.settings).api.capture('content').profile.url,'');assert.equal(t.settings.utilityPresetId,'');
 await t.api.select('content',id);assert.equal(t.settings.apiUrl,'https://new.invalid');assert.equal(t.settings.apiPresetActiveId,id);assert.equal(t.settings.apiKey,'new-key');
});
test('captured main and following roles match actual content; switched content is not overwritten by the old editor',async()=>{
 const t=setup({apiPresets:[connection('a'),connection('b')],apiPresetActiveId:'a',apiUrl:'https://live-a.invalid',apiKey:'live-key',apiModel:'live-model',utilityPresetId:'',theaterPresetId:''});
 const main=t.api.capture('content'),follow=t.api.capture('utility');assert.deepEqual(main,follow);assert.equal(main.profile.url,'https://live-a.invalid');
 await t.api.select('content','b');await t.api.save(main.target,{url:'https://edited-a.invalid',model:'changed',key:''},'改名A');assert.equal(t.settings.apiUrl,'https://b.invalid');assert.equal(t.settings.apiKey,'b-key');assert.equal(t.settings.apiPresetActiveId,'b');assert.equal(t.settings.apiPresets[0].url,'https://edited-a.invalid');assert.deepEqual(t.settings.apiPresets[0].foreign,{keep:true});
 t.settings.utilityPresetId='a';const utility=t.api.capture('utility');await t.api.save(utility.target,{url:'https://utility-a.invalid',key:''},'机械A');assert.equal(t.settings.apiPresetActiveId,'b');assert.equal(t.settings.apiUrl,'https://b.invalid');assert.equal(t.settings.utilityPresetId,'a');
 t.settings.apiPresets=t.settings.apiPresets.filter(p=>p.id!=='a');await assert.rejects(t.api.save(main.target,{model:'stale'},'不复活'),/不存在/);
});
test('copy and deletion preserve drafts/foreign fields without rebinding and failure preserves concurrent changes',async()=>{
 const t=setup({apiPresets:[connection(),null,'opaque'],apiPresetActiveId:'a',apiUrl:'https://a.invalid',apiKey:'a-key',apiModel:'a-model',utilityPresetId:'a',theaterPresetId:'a'}),captured=t.api.capture('utility');
 const id=await t.api.create('副本',{...captured.profile,key:''},captured.target);assert.notEqual(id,'a');assert.equal(t.settings.apiPresetActiveId,'a');assert.deepEqual(t.settings.apiPresets.find(p=>p?.id===id).foreign,{keep:true});
 t.fail(()=>{const p=t.settings.apiPresets.find(p=>p?.id==='a');p.name='外部改名';t.settings.apiPresets.push({id:'other',from:'other-plugin'});t.settings.unrelated='late';throw Error('offline');});
 await assert.rejects(t.api.save(captured.target,{url:'https://draft.invalid'},'本轮名'),/offline/);assert.equal(t.settings.apiPresets[0].url,'https://a.invalid');assert.equal(t.settings.apiPresets[0].name,'外部改名');assert.ok(t.settings.apiPresets.includes(null));assert.ok(t.settings.apiPresets.includes('opaque'));assert.ok(t.settings.apiPresets.some(p=>p?.id==='other'));assert.equal(t.settings.unrelated,'late');
 t.fail(null);await t.api.remove('a');assert.equal(t.settings.apiPresetActiveId,'');assert.equal(t.settings.utilityPresetId,'');assert.equal(t.settings.theaterPresetId,'');assert.equal(t.settings.apiKey,'a-key');assert.ok(t.settings.apiPresets.some(p=>p?.id===id));
});

test('an unbound content snapshot remains editable with a stale display ID, but a later actual source change is not overwritten',async()=>{
 const t=setup({apiPresets:[],apiPresetActiveId:'gone',apiUrl:'https://own.invalid',apiKey:'own-key',apiModel:'own'}),captured=t.api.capture('content');
 await t.api.save(captured.target,{model:'edited'},'主配置');assert.equal(t.settings.apiModel,'edited');assert.equal(t.settings.apiPresetActiveId,'gone');
 t.settings.apiPresets.push(connection('b'));await t.api.select('content','b');await assert.rejects(t.api.save(captured.target,{model:'stale'},'主配置'),/已切换/);assert.equal(t.settings.apiModel,'b-model');
});

test('explicit auxiliary edits never replace the content snapshot, while following-content edits preserve current names unless renamed',async()=>{
 const t=setup({apiPresets:[connection('a')],apiPresetActiveId:'a',utilityPresetId:'a',theaterPresetId:'',apiUrl:'https://live.invalid',apiKey:'live-key',apiModel:'live-model'}),aux=t.api.capture('utility'),flat={apiUrl:t.settings.apiUrl,apiKey:t.settings.apiKey,apiModel:t.settings.apiModel};
 await t.api.save(aux.target,{model:'aux-model'},'A');for(const [key,value] of Object.entries(flat))assert.equal(t.settings[key],value);
 const follow=t.api.capture('theater');assert.equal(follow.target.kind,'content');t.settings.apiPresets[0].name='外部新名';await t.api.save(follow.target,{model:'content-edited'},undefined);assert.equal(t.settings.apiUrl,'https://live.invalid');assert.equal(t.settings.apiKey,'live-key');assert.equal(t.settings.apiModel,'content-edited');assert.equal(t.settings.apiPresets[0].name,'外部新名');
 await t.api.save(follow.target,{model:'renamed'},'明确改名');assert.equal(t.settings.apiPresets[0].name,'明确改名');
});
