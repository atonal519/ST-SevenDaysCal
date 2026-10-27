import test from 'node:test';
import assert from 'node:assert/strict';
const migration = await import('./legacy-chat-return.js').catch(() => ({}));
import { replySourceSignature } from './reply-identity.js';
const pointer = (id, swipeId) => ({ external: true, recordId: id, replyId: 'reply-'+id, swipeId, sourceSignature: replySourceSignature({mes:'current text',swipes:['first text','current text']},swipeId) });
const fixture = () => ({
 metadata: { unrelated: { keep: true }, 'sp-storage': { provider: 'st-bainiaodata', schemaVersion: 1, collection: 'legacy', currentRecord: 'current', diagnosticsRecord: 'diagnostics' }, 'sp-memory': { old: true }, 'sp-theater': { old: true } },
 messages: [{ mes: 'current text', swipe_id: 1, extra: { foreign: 7, gouhua_snapshot: pointer('b',1) }, swipes: ['first text','current text'], swipe_info: [{ extra: { gouhua_snapshot: pointer('a',0), foreign: 8 } }, { extra: { gouhua_snapshot: pointer('b',1) } }] }],
 records: [ {recordId:'current',data:{schemaVersion:1,roots:{'sp-store':{version:1,data:{'schedule-user':{raw:'authoritative'}}},'sp-memory':{version:3,L0:{}}}}}, {recordId:'diagnostics',data:{schemaVersion:1,floors:[{replyId:'reply-b',attempts:{}}]}}, ...['a','b'].map((id,swipeId)=>({recordId:id,data:{schemaVersion:1,replyId:'reply-'+id,swipeId,snapshot:{v:2,point:id}}})) ],
});
test('legacy return restores authoritative roots and every swipe snapshot while preserving foreign fields', () => {
 assert.equal(typeof migration.buildLegacyChatReturn,'function','legacy return implementation is required');
 const input=fixture(), before=structuredClone(input), plan=migration.buildLegacyChatReturn(input);
 assert.equal(plan.metadata['sp-storage'],undefined);assert.equal(plan.metadata['sp-theater'],undefined);
 assert.equal(plan.metadata['sp-store'].data['schedule-user'].raw,'authoritative');
 assert.equal(plan.metadata['sp-store'].data['diagnostics-v1'].floors[0].replyId,'reply-b');
 assert.deepEqual(plan.metadata.unrelated,input.metadata.unrelated);assert.equal(plan.messages[0].extra.foreign,7);
 assert.equal(plan.messages[0].extra.gouhua_snapshot.point,'b');assert.equal(plan.messages[0].swipe_info[0].extra.gouhua_snapshot.point,'a');
 assert.deepEqual(plan.messages[0].swipes,input.messages[0].swipes);assert.deepEqual(input,before);
});
test('legacy return rejects a missing or wrongly attributed record before any save', () => {
 assert.equal(typeof migration.buildLegacyChatReturn,'function');
 const input=fixture();input.records.find(x=>x.recordId==='a').data.swipeId=1;
 assert.throws(()=>migration.buildLegacyChatReturn(input),/快照/);
 input.records=input.records.filter(x=>x.recordId!=='a');assert.throws(()=>migration.buildLegacyChatReturn(input),/快照/);
});
test('legacy return reads only the marked collection and normal chats perform no backend request', async () => {
 assert.equal(typeof migration.readLegacyChatReturn,'function');
 let calls=[];assert.equal(await migration.readLegacyChatReturn({context:{chatMetadata:{},chat:[]},fetchImpl:()=>{throw Error('must not fetch');}}),null);
 const input=fixture();const plan=await migration.readLegacyChatReturn({context:{chatMetadata:input.metadata,chat:input.messages,getRequestHeaders:()=>({})},fetchImpl:async(url,opts)=>{calls.push([url,opts]);return{ok:true,json:async()=>input.records};}});
 assert.equal(calls.length,1);assert.equal(calls[0][1].method,'GET');assert.match(calls[0][0],/\/st-sevendayscal\/legacy$/);assert.equal(plan.messages[0].extra.gouhua_snapshot.point,'b');
});
test('missing auxiliary diagnostics does not block otherwise complete legacy content', () => {
 const input=fixture();input.records=input.records.filter(x=>x.recordId!=='diagnostics');
 const plan=migration.buildLegacyChatReturn(input);assert.equal(plan.messages[0].extra.gouhua_snapshot.point,'b');assert.deepEqual(plan.metadata['sp-store'].data['diagnostics-v1'].floors,[]);
});
test('a pointer from another actual reply cannot become an inline snapshot', () => {
 const input=fixture();input.messages[0].extra.gouhua_snapshot.replySignature='different-reply';
 assert.throws(()=>migration.buildLegacyChatReturn(input),/快照/);
});
test('legacy fetch and JSON errors explain the migration action', async () => {
 const input=fixture(), context={chatMetadata:input.metadata,chat:input.messages};
 await assert.rejects(migration.readLegacyChatReturn({context,fetchImpl:async()=>{throw Error('Failed to fetch');}}),/迁回/);
 await assert.rejects(migration.readLegacyChatReturn({context,fetchImpl:async()=>({ok:true,json:async()=>{throw Error('Unexpected token');}})}),/无法读取/);
});
