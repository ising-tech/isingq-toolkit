'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpdateChecker, compareVersions } = require('../packages/core/src/update-check');
const payload = version => new Response(JSON.stringify({ name: '@ising-tech/isingq-mcp', version }));

test('stable versions compare numerically, with no downgrade or prerelease advice', async () => {
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  for (const [latest, status] of [['0.9.0','update_available'],['0.8.0','up_to_date'],['0.7.0','current_ahead'],['0.9.0-beta.1','unavailable'],['0.09.0','unavailable']]) {
    const r = await createUpdateChecker({ currentVersion: '0.8.0', fetch: async () => payload(latest) })();
    assert.equal(r.status, status); assert.equal(Boolean(r.notice), status === 'update_available');
    assert.equal(r.notification.show, status === 'update_available');
    assert.equal(r.notification.requires_response, false);
    assert.equal(r.notification.announce_check, false);
    assert.equal(r.notification.text, r.notice);
  }
});
test('fixed registry, no credentials or business data, cache and explicit refresh', async () => {
  let calls = 0, time = 1000;
  const checker = createUpdateChecker({ currentVersion: '0.8.0', now: () => time, successTtlMs: 100,
    fetch: async (url, args) => { calls++; assert.equal(url, 'https://registry.npmjs.org/@ising-tech%2fisingq-mcp/latest');
      assert.deepEqual(args.headers, { Accept: 'application/json' }); assert.equal(args.redirect, 'error'); assert.equal(args.body, undefined); return payload('0.9.0'); } });
  const [a,b] = await Promise.all([checker(),checker()]); assert.equal(calls,1); assert.deepEqual(a,b);
  assert.equal((await checker()).cached,true); await checker({refresh:true}); assert.equal(calls,2);
  time += 101; await checker(); assert.equal(calls,3);
});
test('failure and oversized or mismatched metadata do not masquerade as up to date', async () => {
  for (const fetch of [async()=>{throw Error('secret must not escape')},async()=>new Response('bad'),
    async()=>new Response('{}',{status:503}), async()=>new Response(JSON.stringify({name:'other',version:'1.0.0'})),
    async()=>new Response('x'.repeat(65537))]) {
    const r=await createUpdateChecker({fetch})();assert.equal(r.status,'unavailable');assert.equal(r.latest_version,null);
    assert.equal(r.notification.show,false);assert.equal(r.notification.text,null);
    assert.equal(r.message,undefined);
    assert(!JSON.stringify(r).includes('secret must not escape'));
  }
});
test('timeout is bounded and failure is briefly cached', async () => {
  let calls=0;
  const check=createUpdateChecker({timeoutMs:10,fetch:(_url,{signal})=>new Promise((_,reject)=>{
    calls++;signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});})});
  assert.equal((await check()).status,'unavailable');assert.equal((await check()).cached,true);assert.equal(calls,1);
  await assert.rejects(()=>check({refresh:'yes'}),/boolean/);
});

test('an in-flight update check does not gate local model validation', async () => {
  const { validateQubo } = require('../packages/core');
  let aborts=0, finished=false;
  const check=createUpdateChecker({timeoutMs:20,fetch:(_url,{signal})=>new Promise((_,reject)=>{
    signal.addEventListener('abort',()=>{aborts++;reject(Error('timeout'));},{once:true});
  })});
  const pending=check().then(r=>{finished=true;return r;});
  const model=validateQubo({num_bits:2});
  assert.equal(model.summary.num_bits,2);assert.equal(finished,false);
  const result=await pending;
  assert.equal(aborts,1);assert.equal(result.status,'unavailable');assert.equal(result.notification.show,false);
});
