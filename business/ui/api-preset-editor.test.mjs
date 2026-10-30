import test from 'node:test';import assert from 'node:assert/strict';
import {openApiPresetEditor} from './api-preset-editor.js';import {createApiEditorActions} from '../../runtime/api-editor.js';
class Node {
 constructor(tag){this.tagName=tag;this.children=[];this.events={};this.className='';this.disabled=false;this.hidden=false;this.value='';this.textContent='';}
 append(...children){this.children.push(...children);}replaceChildren(...children){this.children=[...children];}setAttribute(key,value){this[key]=value;}addEventListener(name,fn){(this.events[name]??=[]).push(fn);}focus(){}get classList(){return{add:name=>{this.className+=' '+name;},toggle:(name,yes)=>{if(yes)this.className+=' '+name;}};}
 all(){return[this,...this.children.flatMap(n=>n.all())];}async fire(type,event){for(const fn of this.events[type]??[])await fn(event);}async click(){for(const fn of this.events.click??[])await fn();}
}
function setup(settings){let writes=0,requests=0,options;const actions=createApiEditorActions({getSettings:()=>settings,saveSettings:()=>{writes++;},validateAdditional:s=>{if(s)JSON.parse(s);},createId:()=>`created-${writes}`});const open=role=>openApiPresetEditor({documentRef:{createElement:tag=>new Node(tag)},dialog:{custom:value=>{options=value;return Promise.resolve(null);}},actions,role,parseExcludeParams:s=>s.split(/[\n,，]/).map(s=>s.trim()).filter(Boolean),fetchModels:async()=>{requests++;return['available'];}});return{actions,open,writes:()=>writes,requests:()=>requests,options:()=>options,field:id=>options.content.all().find(n=>n.id===`sp-api-editor-${id}`)};}
test('modal new and cancel do not save or call the model; explicit save creates a connection without changing usage',async()=>{
 const settings={apiPresets:[],apiPresetActiveId:'',apiUrl:'',apiKey:'',apiModel:''},t=setup(settings);t.open();for(const id of ['name','url','key','model'])assert.equal(t.field(id).value,'');t.options().onClose();assert.equal(t.writes(),0);assert.equal(t.requests(),0);
 t.open();t.field('name').value='新增连接';t.field('url').value='https://new.invalid';t.field('key').value='new-key';await t.options().submit();assert.equal(settings.apiPresets.length,1);assert.equal(settings.apiKey,'');assert.equal(settings.apiPresetActiveId,'');assert.equal(t.requests(),0);
});
test('modal keeps exclusion newlines, local drafts and captured auxiliary target through source changes',async()=>{
 const p={id:'a',name:'A',url:'https://a.invalid',key:'a-key',model:'a-model',excludeParams:['seed','temperature'],timeoutSec:90,stream:true,qqjExtra:'keep'},settings={apiPresets:[p,{id:'b',name:'B',url:'https://b.invalid',key:'b-key'}],apiPresetActiveId:'b',apiUrl:'https://b.invalid',apiKey:'b-key',utilityPresetId:'a'},t=setup(settings);t.open('utility');assert.equal(t.field('key').value,'');const exclude=t.options().content.all().find(n=>n.tagName==='textarea');assert.equal(exclude.value,'seed\ntemperature');t.field('url').value='https://draft.invalid';assert.equal(t.writes(),0);assert.equal(t.requests(),0);
 await t.options().content.all().find(n=>n.textContent==='拉取模型').click();assert.equal(t.requests(),1);assert.equal(t.writes(),0);settings.utilityPresetId='b';settings.apiPresets[0].name='外部新名';await t.options().submit();assert.equal(settings.utilityPresetId,'b');assert.equal(settings.apiUrl,'https://b.invalid');assert.equal(settings.apiPresets[0].url,'https://draft.invalid');assert.equal(settings.apiPresets[0].key,'a-key');assert.equal(settings.apiPresets[0].qqjExtra,'keep');assert.equal(settings.apiPresets[0].name,'外部新名');
});

test('model search Enter does not save the main form or consume composing input',async()=>{
 const settings={apiPresets:[],apiPresetActiveId:'',apiUrl:'https://own.invalid',apiKey:'own-key',apiModel:'m'},t=setup(settings);t.open('content');const search=t.field('model-search');let prevented=false,stopped=false;
 await search.fire('keydown',{key:'Enter',preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});if(!stopped)await t.options().submit();assert.equal(prevented,true);assert.equal(t.writes(),0);
 prevented=false;await search.fire('keydown',{key:'Enter',isComposing:true,preventDefault(){prevented=true;},stopPropagation(){}});assert.equal(prevented,false);
});

test('Tab passes model retrieval to the closed advanced summary and skips its inputs even when they report rectangles',async()=>{
 const settings={apiPresets:[],apiPresetActiveId:'',apiUrl:'https://own.invalid',apiKey:'key',apiModel:'m'},t=setup(settings);t.open('content');const form=t.options().content;let focused=t.field('model');
 for(const node of form.all())for(const child of node.children){child.parentNode=node;child.parentElement=node;}
 const controls=form.all().filter(n=>['button','input','textarea','select','summary'].includes(n.tagName));
 for(const node of controls){node.focus=()=>{focused=node;};node.getClientRects=()=>{for(let parent=node;parent;parent=parent.parentNode)if(parent.hidden)return[];return[{}];};node.closest=()=>{for(let parent=node.parentNode;parent;parent=parent.parentNode)if(parent.tagName==='details'&&!parent.open)return parent;return null;};}
 form.closest=()=>({querySelectorAll:selector=>controls.filter(n=>selector.split(',').includes(n.tagName))});form.getRootNode=()=>({activeElement:focused});
 await form.fire('keydown',{key:'Tab',preventDefault(){},stopPropagation(){}});assert.equal(focused.textContent,'拉取模型');await form.fire('keydown',{key:'Tab',preventDefault(){},stopPropagation(){}});assert.equal(focused.tagName,'summary');assert.equal(focused.textContent,'接口高级选项');
});
