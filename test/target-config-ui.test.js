'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const client = require('../packages/core/src/target-config/client');
const view = require('../packages/core/src/target-config/view');
const token = 'a'.repeat(64);
const profileA = { id: `local_${'1'.repeat(32)}`, revision: 1, name: '研发室 A', api_base_url: 'http://fixture.invalid:8080/a', web_base_url: null };
const profileB = { ...profileA, id: `local_${'2'.repeat(32)}`, name: '研发室 B', api_base_url: 'http://fixture.invalid:8080/b' };
const checkedAt = '2026-11-11T02:03:04.000Z';
const cloudEntry = { id: 8, name: '云机型甲', spinNumber: '2048', price: 99999, computeCreditCost: 12345,
  executionCapabilities: { minDimension: 2, maxDimension: 1024, problemTypes: ['qubo'], inputFormats: ['csv', 'npz'], maxCalculateCount: 3 } };
const catalog = (environment = 'prod', entries = [cloudEntry]) => ({ environment, checked_at: checkedAt, catalog: { schemaVersion: 1, uploadLimits: { maxCsvBytes: 1048576 }, computerTypes: entries } });
function check(profile = profileA, overrides = {}) {
  return { profile_id: profile.id, profile_revision: profile.revision, checked_at: checkedAt, outcome: 'success',
    device: { name: '物理设备甲', version: '1.0.0', max_scale: 2049, max_precision: '8bit', status: 'stable', boot_timestamp: 1730000000000 },
    issues: [], observation: { source: 'toolkit_host', read_only: true, task_submitted: false }, ...overrides };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

// Run the shipped client, not a mirrored reducer. This minimal DOM records
// actual native control handlers; no browser/network or test dependency needed.
function harness({ hash = `#${token}`, stored = null, visible = 'visible', autoActivity = true, autoEditor = true, autoDrafts = true, draftStore = new Map(), now, environment = 'prod', internalPreview = false, autoInitialChecks = true } = {}) {
  const elements = []; const observers = [];
  const documentEvents = new Map(); const windowEvents = new Map();
  let clock = 0; let timerId = 0; const timers = new Map();
  // Fixture receipts and client validity checks share a deterministic clock;
  // explicit expiry tests may still provide their independently advanced now.
  const clientNow = now || (() => Date.parse(checkedAt) + clock);
  const ClientDate = class extends Date { constructor(...args) { super(...(args.length ? args : [clientNow()])); } static now() { return clientNow(); } };
  const timeout = (fn, ms = 0) => { const id = ++timerId; timers.set(id, { fn, at: clock + ms }); return id; };
  const sessionPolicy = { expiry_policy: 'idle', idle_timeout_ms: 1800000, foreground_lease_ms: 90000, heartbeat_ms: 30000, idle_deadline_at: null };
  const document = { activeElement: null, visibilityState: visible,
    addEventListener(name, handler) { documentEvents.set(name, handler); } };
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.rooted = false; this._text = ''; this.attributes = {}; this.dataset = {}; this.className = ''; this.value = ''; this.style = {}; this.hidden = false; this.disabled = false; this.open = false; this.id = ''; elements.push(this); }
    set textContent(value) { this._text = String(value); this.children.forEach(child => { child.parentNode = null; }); this.children = []; for (const observer of observers) if (observer.targets.has(this) && !observer.queued) { observer.queued = true; queueMicrotask(() => { observer.queued = false; observer.callback([]); }); } }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    get isConnected() { return this.rooted || Boolean(this.parentNode?.isConnected); }
    append(...nodes) { for (const node of nodes) { if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(child => child !== node); node.parentNode = this; this.children.push(node); } }
    replaceChildren(...nodes) { this._text = ''; this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    getBoundingClientRect() { return this.rect || (this.id === 'manager-header' ? { top: 0, bottom: 80, height: 80, left: 0, right: 1024, width: 1024 } : this.className === 'more-menu' ? { top: 0, bottom: 44, height: 44, left: 0, right: 142, width: 142 } : { top: 200, bottom: 232, height: 32, left: 300, right: 332, width: 32 }); }
    contains(target) { for (let node = target; node; node = node.parentNode) if (node === this) return true; return false; }
    reset() { for (const id of ['name', 'api', 'web', 'contract', 'profile-id', 'revision']) document.getElementById(id).value = ''; }
  }
  for (const match of view.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    const element = new Element(match[1]); element.id = match[2]; element.rooted = true; element.hidden = /\bhidden(?:\s|>)/.test(match[0]);
  }
  document.createElement = tag => new Element(tag);
  document.createElementNS = (_namespace, tag) => new Element(tag);
  document.getElementById = id => [...elements].reverse().find(element => element.id === id && element.isConnected) || null;
  document.querySelectorAll = selector => elements.filter(element => element.isConnected && selector.split(',').includes(element.tagName.toLowerCase()));
  const storage = new Map(stored ? [['isingq-target-config-session', stored]] : []);
  const calls = [];
  const location = { hash, pathname: '/', search: '' };
  const histories = [];
  class FakeMutationObserver { constructor(callback) { this.callback = callback; this.targets = new Set(); this.queued = false; observers.push(this); } observe(target) { this.targets.add(target); } disconnect() { this.targets.clear(); } }
  const context = { MutationObserver: FakeMutationObserver, innerWidth: 1024, innerHeight: 768, document, location, history: { replaceState(_state, _title, url) { histories.push(url); location.hash = ''; } },
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    confirm: () => true, AbortController, Date: ClientDate, console, crypto: require('node:crypto').webcrypto,
    setTimeout: timeout, clearTimeout: id => timers.delete(id),
    addEventListener(name, handler) { windowEvents.set(name, handler); },
    fetch: (url, options) => new Promise((resolve, reject) => {
      const call = { url, options, settled: false, respond(data, status = 200) { call.settled = true; resolve({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) }); }, reject(error) { call.settled = true; reject(error); } };
      calls.push(call);
      if (url === '/api/session') call.respond(sessionPolicy);
      if (url === '/api/editor' && autoEditor) call.respond({ recorded: true });
      if (url === '/api/activity' && autoActivity) call.respond({ session: sessionPolicy });
      if (autoDrafts && url === '/api/drafts' && options.method === 'GET') call.respond({ drafts: [...draftStore.values()].map(({values, ...draft}) => ({ ...draft, name: values.name })) });
      if (autoDrafts && url === '/api/drafts' && options.method === 'POST') {
        const payload = JSON.parse(options.body); const draft = { ...payload, updated_at: checkedAt, expires_at: '2026-11-12T02:03:04.000Z' };
        draftStore.set(draft.id, draft); call.respond({ draft });
      }
      if (autoDrafts && /^\/api\/drafts\/[a-f0-9]{32}$/.test(url)) {
        const id = url.split('/').at(-1);
        if (options.method === 'GET') call.respond({ draft: draftStore.get(id) });
        else if (options.method === 'DELETE') { draftStore.delete(id); call.respond({ deleted: true, id, generation: JSON.parse(options.body).generation }); }
      }
    }),
  };
  context.window = context;
  const bootstrap = '/* manager-cloud-bootstrap */' + JSON.stringify({ environment, internal_preview: internalPreview });
  const rendered = client.replace('/* manager-cloud-bootstrap */{"environment":"prod","internal_preview":false}', bootstrap);
  vm.runInNewContext(rendered, context, { timeout: 1000 });
  const get = id => document.getElementById(id);
  const click = id => { const element = get(id); assert.ok(element, `missing control ${id}`); for (let node = element; node; node = node.parentNode) if (node.hidden) return undefined; return element.disabled ? undefined : element.onclick(); };
  const type = (id, value) => { get(id).value = value; get('editor').oninput(); };
  const submit = () => get('editor').onsubmit({ preventDefault() {} });
  const request = (url, index = 0) => { const found = calls.filter(call => call.url === url)[index]; assert.ok(found, `missing request ${url} #${index}`); return found; };
  const businessCalls = () => calls.filter(call => !/^\/api\/(?:session|activity|editor|drafts)(?:$|\/)/.test(call.url));
  return { get, click, type, submit, calls, request, storage, histories, location, document, elements, businessCalls, draftStore,
    keydown(key, target = document.activeElement, isTrusted = false) { const event = { key, target, isTrusted, preventDefault() {} }; const modal = [...elements].reverse().find(element => element.tagName === 'DIALOG' && element.open); if (key === 'Escape' && modal?.oncancel) modal.oncancel(event); else { target?.onkeydown?.(event); documentEvents.get('keydown')?.(event); } },
    pointerDown(target) { documentEvents.get('pointerdown')?.({ target }); },
    async advance(ms) { const target = clock + ms; let guard = 0; while (true) { const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; assert.ok(++guard < 1000); clock = next[1].at; timers.delete(next[0]); next[1].fn(); await flush(); } clock = target; await flush(); },
    async visibility(state) { document.visibilityState = state; documentEvents.get('visibilitychange')?.(); await flush(); },
    async pagehide() { windowEvents.get('pagehide')?.({ persisted: false }); await flush(); },
    scroll() { windowEvents.get('scroll')?.(); },
    async pageshow() { windowEvents.get('pageshow')?.({ persisted: true }); await flush(); },
    async initialize(profiles = [profileA], cloud = catalog(environment === 'sit' && internalPreview ? 'sit' : 'prod')) {
      request('/api/profiles').respond({ profiles });
      const env = environment === 'sit' && internalPreview ? 'sit' : 'prod';
      if (cloud) request(`/api/cloud/catalog?environment=${env}`).respond(cloud); await flush();
      if (autoInitialChecks) for (let step = 0; step <= profiles.length; step++) {
        const pending = calls.filter(call => /\/api\/profiles\/[^/]+\/test$/.test(call.url) && !call.settled);
        if (!pending.length) break;
        for (const call of pending) { const profile = profiles.find(item => call.url === `/api/profiles/${item.id}/test`); call.respond(check(profile)); }
        await flush();
      }
    },
  };
}

test('initial reads are parallel, fixed PROD has no selector, editor is collapsed and an empty profile list starts no checks', async () => {
  const ui = harness();
  assert.deepEqual(ui.businessCalls().map(call => call.url), ['/api/profiles', '/api/cloud/catalog?environment=prod']);
  assert.equal(ui.get('cloud-environment'), null); assert.doesNotMatch(view, /<select|environment-label/);
  assert.equal(ui.location.hash, ''); assert.deepEqual(ui.histories, ['/']);
  assert.equal(ui.storage.get('isingq-target-config-session'), token);
  assert.equal(ui.get('editor-panel').hidden, true);
  for (const call of ui.businessCalls()) { assert.equal(call.options.method, 'GET'); assert.equal(call.options.headers['X-Config-Token'], token); assert.equal(call.options.credentials, 'omit'); }
  await ui.initialize([], catalog('prod', []));
  assert.equal(ui.get('empty').hidden, false); assert.match(ui.get('cloud-state').textContent, /暂无机型/);
  assert.equal(ui.businessCalls().length, 2);
});

test('basic save and cancel keep independent cloud edits and never probe or submit tasks automatically', async () => {
  const ui = harness(); await ui.initialize([], null);
  ui.click('add'); assert.equal(ui.get('editor-panel').hidden, false); assert.equal(ui.get('advanced').open, false);
  ui.type('name', '新连接'); ui.type('api', 'http://fixture.invalid:8080/new');
  ui.request('/api/cloud/catalog?environment=prod').respond(catalog()); await flush();
  assert.equal(ui.get('name').value, '新连接'); assert.equal(ui.get('api').value, 'http://fixture.invalid:8080/new');
  ui.click('cancel'); assert.equal(ui.businessCalls().length, 2); assert.match(ui.get('notice').textContent, /未保存/);
  ui.click('add'); ui.type('name', '已保存连接'); ui.type('api', profileA.api_base_url);
  const saving = ui.submit();
  const save = ui.calls.at(-1); assert.equal(save.url, '/api/profiles'); assert.equal(save.options.method, 'POST');
  assert.deepEqual(JSON.parse(save.options.body), { name: '已保存连接', api_base_url: profileA.api_base_url, web_base_url: '' });
  save.respond({ profile: { ...profileA, name: '已保存连接' }, submitted: false, connection_checked: false }); await saving;
  assert.equal(ui.get('editor-panel').hidden, true); assert.match(ui.get('list').textContent, /已保存连接/);
  assert.match(ui.get('notice').textContent, /尚未检查设备可用性，也未创建任务/);
  assert.equal(ui.calls.filter(call => call.url.includes('/test')).length, 0);
  assert.ok(ui.calls.every(call => !/task|solve|power|benchmark/i.test(call.url)));
});

test('local checks show typed partial/auth/unknown information rather than treating HTTP200 as green or ending session', async () => {
  const ui = harness(); await ui.initialize();
  ui.click('add'); ui.type('name', '保留的草稿');
  const pending = ui.click(`test-${profileA.id}`);
  const call = ui.calls.at(-1); assert.equal(call.url, `/api/profiles/${profileA.id}/test`);
  assert.deepEqual(JSON.parse(call.options.body), { revision: 1 });
  assert.equal(ui.get(`test-${profileA.id}`).disabled, true); assert.equal(ui.get(`check-state-${profileA.id}`).textContent, '正在检测');
  call.respond(check(profileA, { outcome: 'partial', device: { name: '<script>provider-data</script>', version: null, max_scale: 2049, max_precision: null, status: null, boot_timestamp: null },
    issues: [{ field: 'status', code: 'access_denied', message: '状态接口访问受限', http_status: 403 }] })); await pending;
  assert.equal(ui.get(`check-state-${profileA.id}`).dataset.tone, 'warning');
  assert.equal(ui.get(`check-state-${profileA.id}`).textContent, '部分信息可用');
  assert.match(ui.get('list').textContent, /研发室 A/); ui.click(`info-${profileA.id}`); assert.match(ui.get('details-content').textContent, /<script>provider-data<\/script>/); ui.click('details-close');
  assert.match(ui.get('list').textContent, /未知/); assert.match(ui.get('list').textContent, /Toolkit 运行位置/); assert.match(ui.get('list').textContent, /访问受限/);
  assert.equal(ui.get('name').value, '保留的草稿'); assert.equal(ui.get('add').disabled, false);
  assert.equal(ui.storage.get('isingq-target-config-session'), token);
  assert.equal(ui.elements.filter(element => element.tagName === 'SCRIPT').length, 0);
  const retry = ui.click(`test-${profileA.id}`); ui.calls.at(-1).respond(check()); await retry;
  assert.equal(ui.get(`check-state-${profileA.id}`).dataset.tone, 'success');
  ui.click(`info-${profileA.id}`); assert.match(ui.get('details-content').textContent, /设备返回名称物理设备甲/); ui.click('details-close');
});

test('edited/deleted connections and newer check sequences reject late replies without clearing an unrelated draft', async () => {
  const ui = harness(); await ui.initialize([profileA, profileB]);
  const oldCheck = ui.click(`test-${profileA.id}`); const oldRequest = ui.calls.at(-1);
  ui.click(`edit-${profileA.id}`); ui.type('api', 'http://fixture.invalid:8080/replaced');
  const save = ui.submit(); const revised = { ...profileA, revision: 2, api_base_url: 'http://fixture.invalid:8080/replaced' };
  ui.calls.at(-1).respond({ profile: revised }); await save;
  assert.equal(oldRequest.options.signal.aborted, false, 'stale readonly work retains its global slot until the response settles');
  const newCheck = ui.click(`test-${profileA.id}`); const newRequest = ui.calls.at(-1);
  ui.click('add'); ui.type('name', '另一份草稿');
  oldRequest.respond(check(profileA, { device: { name: '旧设备不可见' } })); await oldCheck;
  assert.doesNotMatch(ui.get('list').textContent, /旧设备不可见/);
  assert.equal(ui.get(`check-state-${profileA.id}`).textContent, '正在检测');
  newRequest.respond(check(revised, { device: { ...check().device, name: '新设备信息' } })); await newCheck;
  ui.click(`info-${profileA.id}`); assert.match(ui.get('details-content').textContent, /新设备信息/); ui.click('details-close'); assert.equal(ui.get('name').value, '另一份草稿');
  const deletingCheck = ui.click(`test-${profileB.id}`); const deletingRequest = ui.calls.at(-1);
  const removal = (ui.click(`more-${profileB.id}`), ui.click(`delete-${profileB.id}`)); const deleteRequest = ui.calls.at(-1);
  assert.equal(deleteRequest.options.method, 'DELETE'); assert.equal(deletingRequest.options.signal.aborted, false, 'deletion invalidates data without freeing an unfinished readonly-work slot');
  deleteRequest.respond({ deleted: true, id: profileB.id }); await removal;
  deletingRequest.respond(check(profileB, { device: { name: '删除后的旧信息' } })); await deletingCheck;
  assert.doesNotMatch(ui.get('list').textContent, /研发室 B|删除后的旧信息/);
  assert.equal(ui.get('name').value, '另一份草稿');
});

test('fixed PROD refresh sequencing rejects superseded data while unknown capabilities, rate limits and form edits remain independent', async () => {
  const ui = harness(); await ui.initialize([profileA], null);
  ui.click('add'); ui.type('name', '云出错仍保留输入');
  const refreshed = ui.get('cloud-refresh').onclick();
  const current = ui.request('/api/cloud/catalog?environment=prod', 1);
  assert.equal(ui.request('/api/cloud/catalog?environment=prod').options.signal.aborted, true);
  current.respond(catalog('prod', [{ ...cloudEntry, name: null, executionCapabilities: null }])); await refreshed;
  assert.match(ui.get('cloud-source').textContent, /PROD/);
  assert.match(ui.get('cloud-list').textContent, /机型 8/); assert.match(ui.get('cloud-list').textContent, /未知（目录未声明）/);
  ui.request('/api/cloud/catalog?environment=prod').respond(catalog('prod', [{ ...cloudEntry, name: '旧回执不可见' }])); await flush();
  assert.doesNotMatch(ui.get('cloud-list').textContent, /旧回执|99999|12345|已连接|在线/);
  const limited = ui.click('cloud-refresh');
  ui.request('/api/cloud/catalog?environment=prod', 2).respond({ error: '限流', code: 'CATALOGUE_RATE_LIMITED', retry_after_seconds: 17 }, 429); await limited;
  assert.match(ui.get('cloud-state').textContent, /限流.*17 秒/);
  assert.equal(ui.get('cloud-list').textContent, ''); assert.equal(ui.get('name').value, '云出错仍保留输入');
  const local = ui.click(`test-${profileA.id}`); ui.calls.at(-1).respond(check()); await local;
  assert.equal(ui.get(`check-state-${profileA.id}`).textContent, '信息读取完整');
  assert.ok(ui.calls.filter(call => call.url.startsWith('/api/cloud/catalog')).every(call => call.url.endsWith('environment=prod') && call.options.method === 'GET'));
});

test('cloud declared range is separate from marketing size and failed reads never fabricate fallback cards', async () => {
  const ui = harness(); await ui.initialize();
  assert.match(ui.get('cloud-list').textContent, /标称规格2048/);
  assert.match(ui.get('cloud-list').textContent, /已声明实际支持范围2–1024 维/);
  const request = ui.click('cloud-refresh'); ui.calls.at(-1).respond({ error: '公开目录暂时不可用', code: 'upstream_unavailable', http_status: 503 }, 502); await request;
  assert.match(ui.get('cloud-state').textContent, /目录读取失败.*原服务 HTTP 503/);
  assert.equal(ui.get('cloud-list').textContent, ''); assert.equal(ui.get('add').disabled, false);
});

test('sessionStorage supports same-tab reload; actual session403 clears it and blocks all later writes, preserving typed fields', async () => {
  const ui = harness({ hash: '', stored: token });
  assert.equal(ui.businessCalls().length, 2); assert.equal(ui.businessCalls()[0].options.headers['X-Config-Token'], token);
  await ui.initialize([profileA], null); ui.click('add'); ui.type('name', '会话结束前的草稿');
  ui.request('/api/cloud/catalog?environment=prod').respond({ error: '会话失效' }, 403); await flush();
  assert.equal(ui.storage.size, 0); assert.equal(ui.get('save').disabled, true); assert.equal(ui.get('name').value, '会话结束前的草稿');
  assert.match(ui.get('notice').textContent, /本机会话无效或已到期/);
  const count = ui.calls.length; await ui.submit(); ui.click('cloud-refresh'); ui.click(`test-${profileA.id}`);
  assert.equal(ui.calls.length, count);
  const missing = harness({ hash: '', stored: null }); assert.equal(missing.calls.length, 0); assert.equal(missing.get('add').disabled, true);
});

test('save completion does not discard input typed after the request; stale revision tests remain retryable', async () => {
  const ui = harness(); await ui.initialize();
  ui.click(`edit-${profileA.id}`); ui.type('name', '本次保存');
  const save = ui.submit(); const saveRequest = ui.calls.at(-1);
  ui.type('name', '保存期间继续输入');
  saveRequest.respond({ profile: { ...profileA, name: '本次保存', revision: 2 } }); await save;
  assert.equal(ui.get('editor-panel').hidden, false); assert.equal(ui.get('name').value, '保存期间继续输入');
  assert.equal(ui.get('revision').value, '2', 'kept draft must attach to the saved revision');
  const checkRequest = ui.click(`test-${profileA.id}`); ui.calls.at(-1).respond({ error: 'revision stale', code: 'profile_revision_conflict' }, 409); await checkRequest;
  assert.match(ui.get('list').textContent, /刷新连接列表/); assert.equal(ui.get(`test-${profileA.id}`).disabled, false);
  assert.equal(ui.get('name').value, '保存期间继续输入');
});

test('typing during a new save attaches the remaining draft to the created identity; switching editors stays independent', async () => {
  const ui = harness(); await ui.initialize([]);
  ui.click('add'); ui.type('name', '首次创建'); ui.type('api', profileA.api_base_url);
  const first = ui.submit(); const firstRequest = ui.calls.at(-1);
  ui.type('name', '保存中继续修改'); firstRequest.respond({ profile: profileA }); await first;
  assert.equal(ui.get('profile-id').value, profileA.id);
  assert.equal(ui.get('revision').value, '1');
  assert.equal(ui.get('name').value, '保存中继续修改');
  const second = ui.submit(); const secondRequest = ui.calls.at(-1);
  assert.equal(JSON.parse(secondRequest.options.body).id, profileA.id, 'continued draft updates, never creates a duplicate');
  ui.click('add'); ui.type('name', '切换后的独立草稿');
  secondRequest.respond({ profile: { ...profileA, revision: 2 } }); await second;
  assert.equal(ui.get('profile-id').value, ''); assert.equal(ui.get('name').value, '切换后的独立草稿');
});

test('a slow initial profiles read cannot erase a connection just saved by this page', async () => {
  const ui = harness();
  ui.request('/api/cloud/catalog?environment=prod').respond(catalog()); await flush();
  ui.click('add'); ui.type('name', profileA.name); ui.type('api', profileA.api_base_url);
  const saving = ui.submit(); ui.calls.at(-1).respond({ profile: profileA }); await saving;
  ui.request('/api/profiles').respond({ profiles: [] }); await flush();
  assert.match(ui.get('list').textContent, /研发室 A/);
  assert.equal(ui.get('count').textContent, '1');
});
test('same-revision external address replacement invalidates checks and keeps alias separate from returned device scale', async () => {
  const named = { ...profileA, name: '2050机器' };
  const ui = harness(); await ui.initialize([named]);
  const oldCheck = ui.click(`test-${named.id}`); const oldRequest = ui.calls.at(-1);
  const refresh = ui.click('local-refresh'); const replaced = { ...named, api_base_url: 'http://fixture.invalid:8080/changed-outside' };
  ui.request('/api/profiles', 1).respond({ profiles: [replaced] }); await refresh;
  assert.equal(oldRequest.options.signal.aborted, false, 'stale readonly work retains its global slot until the response settles');
  oldRequest.respond(check(named, { device: { ...check().device, name: '旧地址回执' } })); await oldCheck;
  assert.doesNotMatch(ui.get('list').textContent, /旧地址回执/);
  assert.equal(ui.get(`check-state-${named.id}`).textContent, '正在检测');
  assert.match(ui.get('list').textContent, /changed-outside/);
  const next = ui.calls.filter(call => call.url === `/api/profiles/${named.id}/test`).at(-1); next.respond(check(replaced)); await flush();
  assert.match(ui.get('list').textContent, /2050机器/);
  assert.match(ui.get('list').textContent, /设备规模2049/);
  ui.click(`info-${profileA.id}`); assert.match(ui.get('details-content').textContent, /设备返回名称物理设备甲/); ui.click('details-close');
});
test('SVG card facts keep scale and precision, collapse empty failures and diagnose original service status once', async () => {
  const ui = harness(); await ui.initialize();
  const pending = ui.click(`test-${profileA.id}`);
  ui.calls.at(-1).respond(check(profileA, { outcome: 'failed', device: { name: null, version: null, max_scale: null, max_precision: null, status: null, boot_timestamp: null }, issues: [{ field: 'config', code: 'network', message: '连接超时，请核对服务地址。' }] })); await pending;
  assert.match(ui.get('list').textContent, /连接超时/);
  assert.doesNotMatch(ui.get('list').textContent, /设备返回名称|设备规模|设备声明精度|未知/);
  assert.match(ui.get('list').textContent, /Toolkit 运行位置/);
  assert.equal(ui.get(`test-${profileA.id}`).disabled, false);
  const retry = ui.click(`test-${profileA.id}`); ui.calls.at(-1).respond(check()); await retry;
  const primary = ui.elements.find(element => element.isConnected && element.className.split(' ').includes('local-facts'));
  assert.ok(primary); assert.equal(primary.children.length, 2);
  assert.match(primary.textContent, /声明精度8bit/);
  assert.match(primary.textContent, /设备规模2049/); assert.doesNotMatch(primary.textContent, /2049 维|1\.0\.0/);
  ui.click(`info-${profileA.id}`); const details = ui.get('details-content');
  assert.match(details.textContent, /设备返回名称物理设备甲/); assert.match(details.textContent, /1\.0\.0/); assert.match(details.textContent, /完整检测时间.*2026/); ui.click('details-close');
  const meta = ui.elements.find(element => element.isConnected && element.className === 'check-meta');
  assert.doesNotMatch(meta.textContent, /2026/); assert.match(meta.textContent, /Toolkit 运行位置/);
  assert.equal(ui.get('list').dataset.count, '1');
  const cloudHeading = ui.elements.find(element => element.isConnected && element.tagName === 'H3' && element.textContent.startsWith('云机型甲'));
  assert.equal(cloudHeading.textContent, '云机型甲');
  assert.doesNotMatch(ui.get('cloud-list').textContent, /公开机型/);
  ui.click('cloud-details-prod-8'); assert.match(ui.get('details-content').textContent, /机型 ID8/); ui.click('details-close');
  const refresh = ui.click('cloud-refresh'); ui.calls.at(-1).respond({ error: '公开云目录暂不可用；本地维护仍可使用。', code: 'cloud_catalog_unavailable', http_status: 404 }, 502); await refresh;
  const error = ui.get('cloud-state').textContent;
  assert.match(error, /原服务 HTTP 404/); assert.doesNotMatch(error, /HTTP 502/);
  assert.equal((error.match(/本地/g) || []).length, 1);
  assert.equal(ui.get('cloud-environment'), null); assert.match(ui.get('cloud-source').textContent, /PROD/);
  assert.ok(view.indexOf('id="web"') < view.indexOf('<details id="advanced"'), 'viewer URL is optional basic input, outside advanced rules');
});
test('same-profile save then delete cannot remove a card before a late save receipt restores it', async () => {
  const ui = harness(); await ui.initialize([profileA, profileB]);
  ui.click(`edit-${profileA.id}`); ui.type('name', '保存中的 A');
  const saving = ui.submit(); const saveRequest = ui.calls.at(-1);
  const deleting = (ui.click(`more-${profileA.id}`), ui.click(`delete-${profileA.id}`));
  const deleteRequest = ui.calls.find(call => call.url === `/api/profiles/${profileA.id}` && call.options.method === 'DELETE');
  // Reproduce the reported order if the delete was allowed: backend deletion
  // completes, then an already-completed save response arrives late.
  if (deleteRequest) { deleteRequest.respond({ deleted: true, id: profileA.id }); await deleting; }
  saveRequest.respond({ profile: { ...profileA, revision: 2, name: '保存中的 A' } }); await saving;
  assert.equal(Boolean(deleteRequest), false, 'same-profile DELETE must wait until this save receipt is resolved');
  assert.equal(ui.get(`delete-${profileA.id}`).disabled, false);
  assert.match(ui.get('list').textContent, /保存中的 A/);
});
test('same-profile write exclusion covers delete-first ordering while other profiles and draft inputs stay usable', async () => {
  const ui = harness(); await ui.initialize([profileA, profileB]);
  ui.click(`edit-${profileA.id}`); ui.type('name', 'A 尚未发送的草稿');
  const removing = (ui.click(`more-${profileA.id}`), ui.click(`delete-${profileA.id}`)); const deletion = ui.calls.at(-1);
  const before = ui.calls.length; await ui.submit();
  assert.equal(ui.calls.length, before, 'POST A must not start while DELETE A awaits its receipt');
  assert.match(ui.get('form-notice').textContent, /正在删除.*尚未发送/);
  assert.equal(ui.get('name').value, 'A 尚未发送的草稿'); assert.equal(ui.get('name').disabled, false);
  ui.click(`edit-${profileB.id}`); ui.type('name', 'B 可以保存');
  const savingB = ui.submit(); const saveB = ui.calls.at(-1);
  assert.equal(JSON.parse(saveB.options.body).id, profileB.id);
  saveB.respond({ profile: { ...profileB, revision: 2, name: 'B 可以保存' } }); await savingB;
  deletion.respond({ deleted: true, id: profileA.id }); await removing;
  assert.doesNotMatch(ui.get('list').textContent, /研发室 A/); assert.match(ui.get('list').textContent, /B 可以保存/);
});

test('saving A locks only deletion of A, survives unrelated CRUD rendering, then permits an explicitly later delete', async () => {
  const ui = harness(); await ui.initialize([profileA, profileB]);
  ui.click(`edit-${profileA.id}`); const saving = ui.submit(); const save = ui.calls.at(-1);
  assert.equal(ui.get(`delete-${profileA.id}`).disabled, true);
  assert.equal(ui.get(`delete-${profileB.id}`).disabled, false);
  assert.equal(ui.get('name').disabled, false);
  const deletingB = (ui.click(`more-${profileB.id}`), ui.click(`delete-${profileB.id}`)); ui.calls.at(-1).respond({ deleted: true, id: profileB.id }); await deletingB;
  assert.equal(ui.get(`delete-${profileA.id}`).disabled, true, 'rendering another deletion must not drop A save exclusion');
  save.respond({ profile: { ...profileA, revision: 2 } }); await saving;
  assert.equal(ui.get(`delete-${profileA.id}`).disabled, false);
  const deletingA = (ui.click(`more-${profileA.id}`), ui.click(`delete-${profileA.id}`)); const deletion = ui.calls.at(-1);
  assert.equal(deletion.options.method, 'DELETE'); deletion.respond({ deleted: true, id: profileA.id }); await deletingA;
  assert.equal(ui.get('count').textContent, '0'); assert.equal(ui.get('list').textContent, '');
});

test('visible leases continue beyond the old initial lifetime using only local activity; hidden/pagehide release and stop timers', async () => {
  const ui = harness(); await ui.initialize();
  const dataCount = ui.businessCalls().length;
  const initial = JSON.parse(ui.request('/api/activity').options.body);
  assert.match(initial.page_id, /^[a-f0-9]{32}$/); assert.equal(initial.visible, true);
  await ui.advance(1800000);
  const activities = ui.calls.filter(call => call.url === '/api/activity');
  assert.equal(activities.length, 61); assert.equal(ui.get('save').disabled, false);
  assert.equal(ui.businessCalls().length, dataCount, 'heartbeats never query device/cloud/profiles');
  assert.match(ui.get('session-status').textContent, /操作时自动续用.*30分钟/);
  await ui.visibility('hidden');
  const release = ui.calls.filter(call => call.url === '/api/activity').at(-1);
  assert.equal(JSON.parse(release.options.body).visible, false); assert.equal(release.options.keepalive, true);
  const count = ui.calls.length; await ui.advance(180000); assert.equal(ui.calls.length, count);
  await ui.visibility('visible'); assert.equal(JSON.parse(ui.calls.filter(call => call.url === '/api/activity').at(-1).options.body).visible, true);
  await ui.pagehide(); const hide = ui.calls.filter(call => call.url === '/api/activity').at(-1);
  assert.equal(JSON.parse(hide.options.body).visible, false); const afterHide = ui.calls.length;
  await ui.advance(90000); assert.equal(ui.calls.length, afterHide);
  await ui.pageshow(); assert.equal(JSON.parse(ui.calls.filter(call => call.url === '/api/activity').at(-1).options.body).visible, true);
});

test('out-of-order activity responses cannot override a newer visible lease or change form/draft state', async () => {
  const ui = harness({ autoActivity: false }); await ui.initialize();
  const first = ui.request('/api/activity');
  await ui.visibility('hidden'); const hidden = ui.request('/api/activity', 1);
  await ui.visibility('visible'); const foreground = ui.request('/api/activity', 2);
  assert.ok(JSON.parse(first.options.body).sequence < JSON.parse(hidden.options.body).sequence);
  assert.ok(JSON.parse(hidden.options.body).sequence < JSON.parse(foreground.options.body).sequence);
  ui.click('add'); ui.type('name', '最新草稿不被活动错误改变');
  foreground.respond({ session: { expiry_policy: 'idle', idle_timeout_ms: 1800000, foreground_lease_ms: 90000, heartbeat_ms: 30000 } }); await flush();
  hidden.reject(new Error('old hidden request failure'));
  first.respond({ session: { expiry_policy: 'idle', idle_timeout_ms: 1, foreground_lease_ms: 90, heartbeat_ms: 30 } }); await flush();
  assert.match(ui.get('session-status').textContent, /操作时自动续用.*30分钟/);
  assert.equal(ui.get('name').value, '最新草稿不被活动错误改变');
  assert.equal(ui.get('add').disabled, false);
});

test('private draft autosave is debounced, retains invalid JSON text and does not write profiles or browser draft storage', async () => {
  const ui = harness(); await ui.initialize([]);
  ui.click('add'); ui.type('name', '尚未完成'); ui.type('api', 'http://incomplete'); ui.type('contract', '{invalid JSON');
  assert.equal(ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').length, 0);
  await ui.advance(349); assert.equal(ui.draftStore.size, 0);
  await ui.advance(1); assert.equal(ui.draftStore.size, 1);
  const draft = [...ui.draftStore.values()][0]; assert.equal(draft.values.contract_text, '{invalid JSON');
  assert.equal(draft.mode, 'add'); assert.equal(draft.profile_id, null); assert.equal(draft.profile_revision, null);
  assert.equal(JSON.stringify(draft).includes(token), false);
  assert.equal(ui.storage.size, 1); assert.equal(ui.storage.get('isingq-target-config-session'), token);
  assert.equal(ui.businessCalls().filter(call => call.options.method !== 'GET').length, 0);
  assert.match(ui.get('draft-status').textContent, /已在本机确认备份/);
});

test('default fixture clock advances with timers and still expires acknowledged backups at their deadline', async () => {
  const ui = harness({ autoDrafts: false }); await ui.initialize([]);
  ui.request('/api/drafts').respond({ drafts: [] }); await flush();
  ui.click('add'); ui.type('name', '默认时钟也检查到期'); await ui.advance(350);
  const post = ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').at(-1);
  const data = JSON.parse(post.options.body);
  post.respond({ draft: { ...data, updated_at: checkedAt, expires_at: new Date(Date.parse(checkedAt) + 400).toISOString() } }); await flush();
  assert.match(ui.get('draft-status').textContent, /已在本机确认备份/);
  await ui.advance(51);
  assert.match(ui.get('draft-status').textContent, /过期|已过保留期/);
  assert.equal(ui.get('draft-retry').hidden, false);
  assert.equal(ui.get('name').value, '默认时钟也检查到期');
});

test('a fresh session discovers private drafts across page instances and restores only on explicit action without replacing new input', async () => {
  const store = new Map(); const first = harness({ draftStore: store }); await first.initialize([]);
  first.click('add'); first.type('name', '跨端口草稿'); first.type('api', 'http://unfinished'); first.type('contract', '{still-invalid');
  await first.advance(350); const source = [...store.values()][0];
  const second = harness({ draftStore: store, stored: null }); await second.initialize([]);
  assert.equal(second.get('editor-panel').hidden, true);
  assert.equal(second.calls.filter(call => call.url === `/api/drafts/${source.id}`).length, 0, 'metadata list must not preload full draft text');
  second.click('add'); second.type('name', '新输入必须保留'); await second.click(`restore-${source.id}`);
  assert.equal(second.get('name').value, '新输入必须保留'); assert.match(second.get('notice').textContent, /先保存或取消/);
  await second.click('cancel'); await second.click(`restore-${source.id}`); await flush();
  assert.equal(second.get('name').value, '跨端口草稿'); assert.equal(second.get('contract').value, '{still-invalid');
  const copies = [...store.values()].filter(draft => draft.id !== source.id);
  assert.equal(copies.length, 1); assert.notEqual(copies[0].id, source.id);
  assert.equal(second.businessCalls().filter(call => call.options.method !== 'GET').length, 0);
  await second.submit(); assert.match(second.get('form-notice').textContent, /不是有效 JSON/);
  await second.click('cancel'); assert.equal(store.size, 0, 'explicit cancel cleans copied and source drafts');
});

test('cancel sends a higher cleanup generation immediately and late autosave receipt cannot revive the cleared draft', async () => {
  const ui = harness({ autoDrafts: false }); await ui.initialize([]); ui.request('/api/drafts').respond({ drafts: [] }); await flush();
  ui.click('add'); ui.type('name', '取消前内容'); await ui.advance(350);
  const post = ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').at(-1); const saved = JSON.parse(post.options.body);
  const cancelled = ui.click('cancel'); const cleanup = ui.calls.at(-1);
  assert.equal(cleanup.url, `/api/drafts/${saved.id}`); assert.equal(cleanup.options.method, 'DELETE');
  assert.ok(JSON.parse(cleanup.options.body).generation > saved.generation);
  cleanup.respond({ deleted: true, id: saved.id, generation: JSON.parse(cleanup.options.body).generation }); await cancelled;
  post.respond({ draft: { ...saved, updated_at: checkedAt, expires_at: '2026-11-12T02:03:04Z' } }); await flush();
  assert.equal(ui.get('draft-list').textContent, ''); assert.equal(ui.get('editor-panel').hidden, true);
  assert.equal(ui.businessCalls().filter(call => call.options.method !== 'GET').length, 0);
});

test('storage failures are visibly unbacked, retry is explicit, and a recovered session failure never claims latest input is safe', async () => {
  const ui = harness({ autoDrafts: false, autoActivity: false }); await ui.initialize([]);
  ui.request('/api/drafts').respond({ drafts: [] }); await flush();
  ui.click('add'); ui.type('name', '备份失败仍保留'); await ui.advance(350);
  const post = ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').at(-1); const data = JSON.parse(post.options.body);
  post.respond({ error: '本机草稿写入失败', code: 'draft_io_error' }, 500); await flush();
  assert.match(ui.get('draft-status').textContent, /草稿未备份/); assert.equal(ui.get('draft-retry').hidden, false);
  const retry = ui.click('draft-retry'); ui.calls.at(-1).respond({ draft: { ...data, updated_at: checkedAt, expires_at: '2026-11-12T02:03:04Z' } }); await retry;
  assert.match(ui.get('draft-status').textContent, /已在本机确认备份/);
  ui.type('name', '此最新输入还没有回执');
  ui.request('/api/activity').reject(new Error('connection refused')); await flush();
  assert.match(ui.get('session-status').textContent, /重新打开.*最新输入尚未确认/);
  assert.equal(ui.get('name').value, '此最新输入还没有回执');
  await ui.visibility('visible'); const current = ui.calls.filter(call => call.url === '/api/activity').at(-1);
  current.respond({ error: '闲置已回收', code: 'config_session_closed' }, 403); await flush();
  const count = ui.calls.length; await ui.advance(60000); assert.equal(ui.calls.length, count);
  assert.equal(ui.get('save').disabled, true); assert.equal(ui.get('name').readOnly, true); assert.equal(ui.storage.size, 0);
});

test('save with later edits backs up a new identity before cleaning old drafts; late old responses cannot erase the residual edit', async () => {
  const ui = harness({ autoDrafts: false }); await ui.initialize(); ui.request('/api/drafts').respond({ drafts: [] }); await flush();
  ui.click(`edit-${profileA.id}`); ui.type('name', '本次要保存'); await ui.advance(350);
  const oldPost = ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').at(-1); const old = JSON.parse(oldPost.options.body);
  const saving = ui.submit(); const profileSave = ui.calls.at(-1);
  ui.type('name', '保存后仍待编辑'); await ui.advance(350);
  profileSave.respond({ profile: { ...profileA, revision: 2, name: '本次要保存' } }); await saving;
  const residualPost = ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').at(-1); const residual = JSON.parse(residualPost.options.body);
  assert.notEqual(residual.id, old.id); assert.equal(residual.profile_revision, 2); assert.equal(residual.values.name, '保存后仍待编辑');
  assert.equal(ui.calls.some(call => call.url === `/api/drafts/${old.id}` && call.options.method === 'DELETE'), false, 'preserve old backup until residual backup acknowledged');
  residualPost.respond({ draft: { ...residual, updated_at: checkedAt, expires_at: '2026-11-12T02:03:04Z' } }); await flush();
  const cleanup = ui.calls.find(call => call.url === `/api/drafts/${old.id}` && call.options.method === 'DELETE'); assert.ok(cleanup);
  assert.ok(JSON.parse(cleanup.options.body).generation > old.generation);
  cleanup.respond({ deleted: true, id: old.id, generation: JSON.parse(cleanup.options.body).generation }); await flush();
  oldPost.respond({ draft: { ...old, updated_at: checkedAt, expires_at: '2026-11-12T02:03:04Z' } }); await flush();
  assert.equal(ui.get('name').value, '保存后仍待编辑'); assert.equal(ui.get('revision').value, '2');
  assert.match(ui.get('draft-status').textContent, /已在本机确认备份/);
  assert.doesNotMatch(ui.get('draft-list').textContent, /本次要保存/);
});

test('restoring a shared source deletes only its read generation and exposes newer cross-page drafts after a conflict', async () => {
  const source = { id: 'd'.repeat(32), generation: 5, mode: 'add', profile_id: null, profile_revision: null, values: { name: '原草稿', api_base_url: 'http://unfinished', web_base_url: '', contract_text: '' }, updated_at: checkedAt, expires_at: '2026-11-12T02:03:04Z' };
  const ui = harness({ autoDrafts: false }); await ui.initialize([]);
  ui.request('/api/drafts').respond({ drafts: [{ ...source, values: undefined, name: source.values.name }] }); await flush();
  const restoring = ui.click(`restore-${source.id}`); ui.calls.at(-1).respond({ draft: source }); await restoring;
  const copyPost = ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').at(-1); const copy = JSON.parse(copyPost.options.body);
  copyPost.respond({ draft: { ...copy, updated_at: checkedAt, expires_at: source.expires_at } }); await flush();
  const cancelled = ui.click('cancel'); const sourceCleanup = ui.calls.find(call => call.url === `/api/drafts/${source.id}` && call.options.method === 'DELETE');
  assert.ok(ui.calls.some(call => call.url === `/api/drafts/${copy.id}` && call.options.method === 'DELETE'), 'slow source cleanup must not delay the copied draft tombstone');
  assert.equal(sourceCleanup.url, `/api/drafts/${source.id}`); assert.equal(JSON.parse(sourceCleanup.options.body).generation, 5);
  sourceCleanup.respond({ error: '已有更新代', code: 'draft_generation_conflict' }, 409); await flush();
  const copyCleanup = ui.calls.find(call => call.url === `/api/drafts/${copy.id}` && call.options.method === 'DELETE'); assert.equal(copyCleanup.url, `/api/drafts/${copy.id}`);
  copyCleanup.respond({ deleted: true, id: copy.id, generation: JSON.parse(copyCleanup.options.body).generation }); await cancelled;
  assert.match(ui.get('notice').textContent, /清理未确认/);
  const refresh = ui.click('draft-refresh'); ui.calls.at(-1).respond({ drafts: [{ id: source.id, generation: 6, mode: 'add', profile_id: null, profile_revision: null, name: '别页较新草稿', updated_at: checkedAt, expires_at: source.expires_at }] }); await refresh;
  assert.match(ui.get('draft-list').textContent, /别页较新草稿/);
});

test('hidden-page latest draft flush is keepalive and an older ACK cannot hide the latest failed backup', async () => {
  const ui = harness({ autoDrafts: false }); await ui.initialize([]); ui.request('/api/drafts').respond({ drafts: [] }); await flush();
  ui.click('add'); ui.type('name', '早一版'); await ui.advance(350);
  const first = ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').at(-1); const firstData = JSON.parse(first.options.body);
  ui.type('name', '隐藏前最新输入'); await ui.pagehide();
  const latest = ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').at(-1); const latestData = JSON.parse(latest.options.body);
  assert.equal(latest.options.keepalive, true); assert.ok(latestData.generation > firstData.generation);
  latest.respond({ error: '本机草稿写入失败', code: 'draft_io_error' }, 500); await flush();
  assert.match(ui.get('draft-status').textContent, /草稿未备份/);
  first.respond({ draft: { ...firstData, updated_at: checkedAt, expires_at: '2026-11-12T02:03:04Z' } }); await flush();
  assert.match(ui.get('draft-status').textContent, /草稿未备份/);
  assert.equal(ui.get('draft-retry').hidden, false); assert.equal(ui.get('name').value, '隐藏前最新输入');
});

test('explicit ignore invalidates a pending restore so late text cannot reopen or overwrite an editor', async () => {
  const source = { id: 'e'.repeat(32), generation: 3, mode: 'add', profile_id: null, profile_revision: null, name: '已忽略草稿', updated_at: checkedAt, expires_at: '2026-11-12T02:03:04Z' };
  const ui = harness({ autoDrafts: false }); await ui.initialize([]); ui.request('/api/drafts').respond({ drafts: [source] }); await flush();
  const restoring = ui.click(`restore-${source.id}`); const oldGet = ui.calls.at(-1);
  const ignoring = ui.click(`ignore-${source.id}`); ui.calls.at(-1).respond({ deleted: true, id: source.id, generation: 3 }); await ignoring;
  oldGet.respond({ draft: { ...source, values: { name: '不应晚到填入', api_base_url: '', web_base_url: '', contract_text: '' } } }); await restoring;
  assert.equal(ui.get('editor-panel').hidden, true); assert.equal(ui.get('name').value, '');
  assert.equal(ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').length, 0);
});


test('expired acknowledged backup is not presented as recoverable in current, ended or disconnected session messages', async () => {
  let clock = Date.parse(checkedAt);
  const ui = harness({ autoDrafts: false, autoActivity: false, now: () => clock }); await ui.initialize([]);
  ui.request('/api/drafts').respond({ drafts: [] }); await flush();
  ui.click('add'); ui.type('name', '保留当前输入'); await ui.advance(350);
  const post = ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').at(-1); const data = JSON.parse(post.options.body);
  post.respond({ draft: { ...data, updated_at: checkedAt, expires_at: new Date(clock + 50).toISOString() } }); await flush();
  assert.match(ui.get('draft-status').textContent, /已在本机确认备份/);
  clock += 51; await ui.advance(51);
  assert.match(ui.get('draft-status').textContent, /过期|已过保留期/);
  assert.equal(ui.get('draft-retry').hidden, false);
  ui.request('/api/activity').reject(new Error('connection refused')); await flush();
  assert.match(ui.get('session-status').textContent, /过期|已过保留期/);
  assert.doesNotMatch(ui.get('session-status').textContent, /当前草稿最近一次已确认在本机备份；重新打开后请明确恢复/);
  ui.click('close'); const closing = ui.click('close-confirm'); ui.calls.at(-1).respond({ closed: true }); await closing;
  assert.match(ui.get('draft-status').textContent, /过期|已过保留期/);
  assert.match(ui.get('session-status').textContent, /过期|已过保留期/);
  assert.equal(ui.get('name').value, '保留当前输入');
});

test('known-expired own context resumes backup under a new id on new input without promising success before ACK', async () => {
  let clock = Date.parse(checkedAt);
  const ui = harness({ autoDrafts: false, now: () => clock }); await ui.initialize([]); ui.request('/api/drafts').respond({ drafts: [] }); await flush();
  ui.click('add'); ui.type('name', '原输入'); await ui.advance(350);
  const first = ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').at(-1); const original = JSON.parse(first.options.body);
  first.respond({ draft: { ...original, updated_at: checkedAt, expires_at: new Date(clock + 50).toISOString() } }); await flush();
  clock += 51;
  ui.type('api', 'http://new-input-after-expiry'); await ui.advance(350);
  const next = ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').at(-1); const fresh = JSON.parse(next.options.body);
  assert.notEqual(fresh.id, original.id); assert.equal(fresh.values.name, '原输入'); assert.equal(fresh.values.api_base_url, 'http://new-input-after-expiry');
  assert.doesNotMatch(ui.get('draft-status').textContent, /已在本机确认备份/);
  assert.equal(ui.calls.some(call => call.url === `/api/drafts/${original.id}` && call.options.method === 'DELETE'), false);
  next.respond({ draft: { ...fresh, updated_at: new Date(clock).toISOString(), expires_at: new Date(clock + 86400000).toISOString() } }); await flush();
  const cleanup = ui.calls.find(call => call.url === `/api/drafts/${original.id}` && call.options.method === 'DELETE'); assert.ok(cleanup);
  cleanup.respond({ deleted: true, id: original.id, generation: JSON.parse(cleanup.options.body).generation }); await flush();
  assert.match(ui.get('draft-status').textContent, /已在本机确认备份/);
  assert.equal(ui.get('api').value, 'http://new-input-after-expiry');
});

test('ordinary draft_deleted rejection cannot automatically recreate another page cleared context; explicit retry can create a new intention', async () => {
  const ui = harness({ autoDrafts: false }); await ui.initialize([]); ui.request('/api/drafts').respond({ drafts: [] }); await flush();
  ui.click('add'); ui.type('name', '尚未确认的输入'); await ui.advance(350);
  const oldPost = ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').at(-1); const old = JSON.parse(oldPost.options.body);
  oldPost.respond({ error: '草稿已由另一页清理', code: 'draft_deleted' }, 409); await flush();
  const writes = ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').length;
  await ui.pagehide(); await ui.visibility('visible'); await ui.advance(350);
  assert.equal(ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').length, writes, 'no automatic resurrection after a deletion rejection');
  assert.match(ui.get('draft-status').textContent, /未备份|未确认|已清理/);
  const retrying = ui.click('draft-retry'); const next = ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').at(-1); const fresh = JSON.parse(next.options.body);
  assert.notEqual(fresh.id, old.id); assert.equal(fresh.values.name, '尚未确认的输入');
  next.respond({ draft: { ...fresh, updated_at: checkedAt, expires_at: '2026-11-12T02:03:04Z' } }); await flush();
  const cleanup = ui.calls.find(call => call.url === `/api/drafts/${old.id}` && call.options.method === 'DELETE');
  if (cleanup) cleanup.respond({ deleted: true, id: old.id, generation: JSON.parse(cleanup.options.body).generation });
  await retrying;
});

test('unknown ACK retention is not a recovery promise; explicit expired retry uses a fresh id and failed renewal stays unconfirmed', async () => {
  let clock = Date.parse(checkedAt);
  const ui = harness({ autoDrafts: false, now: () => clock }); await ui.initialize([]); ui.request('/api/drafts').respond({ drafts: [] }); await flush();
  ui.click('add'); ui.type('name', '未改变的当前输入'); await ui.advance(350);
  const first = ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').at(-1); const original = JSON.parse(first.options.body);
  first.respond({ draft: { ...original, updated_at: checkedAt } }); await flush();
  assert.match(ui.get('draft-status').textContent, /保留期未核实/);
  assert.doesNotMatch(ui.get('draft-status').textContent, /已在本机确认备份/);
  const verify = ui.click('draft-retry'); const verifyRequest = ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').at(-1);
  assert.equal(JSON.parse(verifyRequest.options.body).id, original.id, 'unknown expiry alone must not silently invent a new identity');
  verifyRequest.respond({ draft: { ...original, updated_at: checkedAt, expires_at: new Date(clock + 50).toISOString() } }); await verify;
  clock += 51; await ui.advance(51);
  const renewing = ui.click('draft-retry'); const renewal = ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').at(-1); const fresh = JSON.parse(renewal.options.body);
  assert.notEqual(fresh.id, original.id); assert.equal(fresh.values.name, '未改变的当前输入');
  assert.doesNotMatch(ui.get('draft-status').textContent, /已在本机确认备份/);
  renewal.respond({ error: '磁盘写入失败', code: 'draft_io_error' }, 500); await renewing;
  assert.match(ui.get('draft-status').textContent, /草稿未备份/);
  ui.click('close'); const closing = ui.click('close-confirm'); ui.calls.at(-1).respond({ closed: true }); await closing;
  assert.match(ui.get('session-status').textContent, /尚未确认备份/);
  assert.equal(ui.get('name').value, '未改变的当前输入');
});

test('trusted cabinet assets preserve the pinned geometry and every image byte participates in manager build identity', () => {
  const { createHash } = require('node:crypto');
  const { CABINET_SOURCE_SHA256, DEVICE_ART, STATIC_SVG_ASSETS, ART_DIGEST } = require('../packages/core/src/target-config/device-art');
  assert.equal(CABINET_SOURCE_SHA256, 'ddc7bdf025a6a70767d86417b7a8dd527682ec64d61d9b41301278c80c30ed17');
  assert.ok(client.includes(ART_DIGEST));
  for (const [tone, art] of Object.entries(DEVICE_ART)) {
    const svg = STATIC_SVG_ASSETS[art.path]; assert.ok(svg);
    assert.equal(createHash('sha256').update(svg).digest('hex'), art.sha256);
    assert.ok(art.path.includes(art.sha256.slice(0, 16))); assert.ok(client.includes(art.path));
    assert.match(svg, /viewBox="0 0 320 400"/);
    assert.match(svg, /M50 85 160 30 270 85 160 140Z/);
    assert.match(svg, /matrix\(1 -\.5 0 1 160 140\)/);
    assert.match(svg, /matrix\(1 \.5 0 1 50 85\)/);
    assert.doesNotMatch(svg, /<script|foreignObject|\bhref=|\bonload=|192\.168\.|研发室|比特数/i);
    assert.match(svg, /示意/); assert.ok(['neutral', 'success', 'partial', 'failed', 'cloud'].includes(tone));
  }
});

test('cabinet-over-card presentation uses actual objects and status art without adding sample devices or online claims', async () => {
  const { DEVICE_ART } = require('../packages/core/src/target-config/device-art');
  const ui = harness(); await ui.initialize([profileA, profileB]);
  assert.equal(ui.get('list').children.length, 2);
  const tile = ui.get('list').children[0]; const visual = tile.children[0]; const trigger = visual.children[0]; const art = trigger.children[0].children[1].children[0];
  assert.equal(visual.className, 'device-visual'); assert.equal(visual.getAttribute('aria-hidden'), null); assert.equal(trigger.tagName, 'BUTTON'); assert.match(trigger.getAttribute('aria-label'), /查看详情.*研发室/);
  assert.equal(art.getAttribute('src'), DEVICE_ART.success.frontPath); assert.equal(art.getAttribute('alt'), '');
  assert.equal(tile.children[1].tagName, 'ARTICLE');
  const partial = ui.click(`test-${profileA.id}`); ui.calls.at(-1).respond(check(profileA, { outcome: 'partial', issues: [{ message: '版本信息未取得' }] })); await partial;
  assert.equal(art.getAttribute('src'), DEVICE_ART.partial.frontPath);
  const failed = ui.click(`test-${profileA.id}`); ui.calls.at(-1).respond(check(profileA, { outcome: 'failed', device: {}, issues: [{ message: '读取失败，请重试' }] })); await failed;
  assert.equal(art.getAttribute('src'), DEVICE_ART.failed.frontPath);
  const success = ui.click(`test-${profileA.id}`); ui.calls.at(-1).respond(check()); await success;
  assert.equal(art.getAttribute('src'), DEVICE_ART.success.frontPath);
  assert.equal(ui.get(`check-state-${profileA.id}`).textContent, '信息读取完整');
  assert.doesNotMatch(ui.get('list').textContent, /在线|检测可达|可提交/);
  const cloudArt = ui.get('cloud-list').children[0].children[0].children[0].children[0].children[1].children[0];
  assert.equal(cloudArt.getAttribute('src'), DEVICE_ART.cloud.frontPath);
  assert.match(ui.get('cloud-list').textContent, /2–1024 维/);
  const callsBeforeDetails = ui.businessCalls().length;
  ui.click(`device-${profileA.id}`); assert.match(ui.get('details-content').textContent, /物理设备甲/); ui.keydown('Escape'); assert.equal(ui.document.activeElement, trigger);
  const cloudTrigger = ui.get('device-cloud-prod-8'); ui.click(cloudTrigger.id); assert.match(ui.get('details-content').textContent, /机型 ID8/); ui.keydown('Escape'); assert.equal(ui.document.activeElement, cloudTrigger);
  assert.equal(ui.businessCalls().length, callsBeforeDetails, 'device shortcuts open loaded details without detection or catalogue calls');
  assert.equal((view.match(/id="add"/g) || []).length, 1);
  assert.ok(view.indexOf('id="add"') < view.indexOf('<main>'));
});

test('icon actions expose real menu deletion with Escape, outside click and keyboard focus', async () => {
  const ui = harness(); await ui.initialize();
  const more = ui.get(`more-${profileA.id}`); const menu = ui.get(`menu-${profileA.id}`); const remove = ui.get(`delete-${profileA.id}`);
  assert.equal(menu.hidden, true); assert.equal(more.getAttribute('aria-haspopup'), 'menu');
  ui.click(`more-${profileA.id}`); assert.equal(menu.hidden, false); assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.equal(ui.document.activeElement, remove);
  ui.keydown('Escape'); assert.equal(menu.hidden, true); assert.equal(ui.document.activeElement, more);
  ui.keydown('ArrowDown', more); assert.equal(menu.hidden, false);
  ui.pointerDown(ui.get('local-refresh')); assert.equal(menu.hidden, true);
  ui.click(`more-${profileA.id}`); const deleting = ui.click(`delete-${profileA.id}`); const request = ui.calls.at(-1);
  assert.equal(menu.hidden, true); assert.equal(request.url, `/api/profiles/${profileA.id}`); assert.equal(request.options.method, 'DELETE');
  request.respond({ deleted: true, id: profileA.id }); await deleting;
  assert.equal(ui.get('list').children.length, 0);
  for (const id of ['local-refresh', 'cloud-refresh', 'close', 'draft-refresh', 'save', 'cancel', 'draft-retry']) assert.ok(ui.get(id));
});


test('header power action only opens a nonblocking confirmation; cancel/Escape do not close and confirmation is single-flight', async () => {
  const ui = harness(); await ui.initialize([]);
  assert.match(view, /id="close"[^>]*aria-label="结束管理"[^>]*title="结束管理"/);
  assert.ok(view.indexOf('id="close"') < view.indexOf('<main>'));
  assert.doesNotMatch(view.slice(view.indexOf('<footer>'), view.indexOf('</footer>')), /id="close"/);
  ui.click('add'); ui.type('name', '未确认备份的输入'); ui.click('close');
  assert.equal(ui.get('close-dialog').open, true); assert.equal(ui.document.activeElement, ui.get('close-cancel'));
  assert.match(ui.get('close-draft-status').textContent, /尚未确认备份/);
  assert.equal(ui.calls.filter(call => call.url === '/api/close').length, 0);
  await ui.advance(30000);
  assert.equal(ui.calls.filter(call => call.url === '/api/activity').length, 2, 'native dialog does not pause lease JavaScript');
  assert.match(ui.get('close-draft-status').textContent, /已在本机确认备份/);
  ui.click('close-cancel'); assert.equal(ui.get('close-dialog').open, false); assert.equal(ui.document.activeElement, ui.get('close'));
  ui.click('close'); ui.keydown('Escape');
  assert.equal(ui.get('close-dialog').open, false); assert.equal(ui.document.activeElement, ui.get('close'));
  assert.equal(ui.calls.filter(call => call.url === '/api/close').length, 0);
  ui.click('close'); const closing = ui.click('close-confirm'); const closeRequest = ui.calls.at(-1);
  ui.get('close-confirm').onclick(); ui.keydown('Escape');
  assert.equal(ui.calls.filter(call => call.url === '/api/close').length, 1);
  assert.equal(ui.get('close-dialog').open, true); assert.equal(ui.get('close-cancel').disabled, true);
  assert.equal(closeRequest.url, '/api/close'); assert.equal(closeRequest.options.method, 'POST'); assert.deepEqual(JSON.parse(closeRequest.options.body), {});
  closeRequest.respond({ closed: true, remote_tasks_cancelled: false }); await closing; await flush();
  assert.equal(ui.get('close-dialog').open, false); assert.equal(ui.get('close').disabled, true);
  assert.ok(ui.calls.every(call => !/power|task|benchmark|solve/i.test(call.url)));
});

test('close confirmation observes backup expiry without claiming recovery or creating new backup intent', async () => {
  let clock = Date.parse(checkedAt);
  const ui = harness({ autoDrafts: false, now: () => clock }); await ui.initialize([]); ui.request('/api/drafts').respond({ drafts: [] }); await flush();
  ui.click('add'); ui.type('name', '到期状态仍保留'); await ui.advance(350);
  const post = ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').at(-1); const data = JSON.parse(post.options.body);
  post.respond({ draft: { ...data, updated_at: checkedAt, expires_at: new Date(clock + 50).toISOString() } }); await flush();
  ui.click('close'); assert.match(ui.get('close-draft-status').textContent, /已在本机确认备份/);
  clock += 51; await ui.advance(51);
  assert.match(ui.get('close-draft-status').textContent, /过期|已过保留期/);
  assert.equal(ui.calls.filter(call => call.url === '/api/drafts' && call.options.method === 'POST').length, 1);
  ui.keydown('Escape'); assert.equal(ui.calls.filter(call => call.url === '/api/close').length, 0);
  assert.equal(ui.get('name').value, '到期状态仍保留');
});

test('local readonly dialog uses loaded data, preserves diagnostics and closes on configuration revision/API or deletion changes', async () => {
  const ui = harness(); await ui.initialize([]); ui.click('add'); ui.type('name', profileA.name); ui.type('api', profileA.api_base_url);
  const saved = ui.submit(); ui.calls.at(-1).respond({ profile: profileA }); await saved;
  const before = ui.businessCalls().length; ui.click(`info-${profileA.id}`);
  assert.equal(ui.get('details-dialog').open, true); assert.equal(ui.document.activeElement, ui.get('details-close'));
  assert.match(ui.get('details-content').textContent, /尚未检测/); assert.match(ui.get('details-content').textContent, /连接名称（别名）研发室 A/);
  assert.match(ui.get('details-content').textContent, /http:\/\/fixture.invalid:8080\/a/);
  assert.equal(ui.businessCalls().length, before, 'opening details never starts a test or catalogue read');
  ui.keydown('Escape'); assert.equal(ui.document.activeElement, ui.get(`info-${profileA.id}`));
  const testing = ui.click(`test-${profileA.id}`); const testRequest = ui.calls.at(-1);
  ui.click(`info-${profileA.id}`); assert.match(ui.get('details-content').textContent, /正在检测/);
  testRequest.respond(check(profileA, { outcome: 'partial', issues: [{ field: 'runtime', message: '部分接口访问受限', http_status: 403 }] })); await testing;
  const content = ui.get('details-content').textContent;
  for (const part of ['设备返回名称物理设备甲', '设备规模2049', '设备声明精度8bit', '运行状态稳定', '设备版本1.0.0', '完整检测时间', 'Toolkit 运行位置', '接口 HTTP 403']) assert.ok(content.includes(part), part);
  assert.equal(ui.get('details-dialog').open, true);
  ui.click('details-close');
  const refreshing = ui.click('local-refresh'); ui.click(`info-${profileA.id}`);
  const replaced = { ...profileA, api_base_url: 'http://fixture.invalid:8080/replaced-same-revision' };
  ui.calls.filter(call => call.url === '/api/profiles' && call.options.method === 'GET').at(-1).respond({ profiles: [replaced] }); await refreshing;
  assert.equal(ui.get('details-dialog').open, false);
  ui.click(`info-${profileA.id}`); assert.match(ui.get('details-content').textContent, /replaced-same-revision/); assert.match(ui.get('details-content').textContent, /正在检测/);
  ui.click('details-close'); const deletingOutside = ui.click('local-refresh'); ui.click(`info-${profileA.id}`);
  ui.calls.filter(call => call.url === '/api/profiles' && call.options.method === 'GET').at(-1).respond({ profiles: [] }); await deletingOutside;
  assert.equal(ui.get('details-dialog').open, false);
  assert.equal(ui.elements.filter(element => element.isConnected && element.tagName === 'DETAILS').length, 1, 'only the original advanced JSON disclosure remains');
});

test('cloud readonly dialog keeps fixed environment/range/capabilities and closes when its current catalogue is refreshed', async () => {
  const ui = harness(); await ui.initialize(); const before = ui.businessCalls().length;
  ui.click('cloud-details-prod-8'); assert.equal(ui.get('details-dialog').open, true);
  const content = ui.get('details-content').textContent;
  for (const part of ['机型 ID8', '来源环境PROD', '标称规格2048', '2–1024 维', 'QUBO', 'CSV / NPZ', '单次计算次数上限3']) assert.ok(content.includes(part), part);
  assert.equal(ui.businessCalls().length, before); assert.doesNotMatch(content, /99999|12345|已连接/);
  ui.keydown('Escape'); assert.equal(ui.document.activeElement, ui.get('cloud-details-prod-8'));
  ui.click('cloud-details-prod-8'); const changing = ui.get('cloud-refresh').onclick();
  assert.equal(ui.get('details-dialog').open, false);
  ui.request('/api/cloud/catalog?environment=prod', 1).respond(catalog('prod', [{ ...cloudEntry, name: null, executionCapabilities: null }])); await changing;
  ui.click('cloud-details-prod-8'); assert.match(ui.get('details-title').textContent, /机型 8/);
  assert.match(ui.get('details-content').textContent, /来源环境PROD/); assert.match(ui.get('details-content').textContent, /未知（目录未声明）/);
});

test('more-menu placement stays below the sticky header and closes on scroll without invoking actions', async () => {
  const ui = harness(); await ui.initialize(); const before = ui.businessCalls().length;
  ui.get('manager-header').rect = { top: 0, bottom: 100, width: 1024, height: 100, left: 0, right: 1024 };
  ui.get(`more-${profileA.id}`).rect = { top: 82, bottom: 114, width: 32, height: 32, left: 300, right: 332 };
  ui.click(`more-${profileA.id}`); const menu = ui.get(`menu-${profileA.id}`);
  assert.equal(menu.hidden, false); assert.ok(parseFloat(menu.style.top) >= 108); assert.ok(parseFloat(menu.style.left) >= 8);
  ui.scroll(); assert.equal(menu.hidden, true); assert.equal(ui.businessCalls().length, before);
});

test('failed end confirmation stays explicit and cancellable without claiming shutdown or repeating the close request', async () => {
  const ui = harness(); await ui.initialize([]); ui.click('add'); ui.type('name', '关闭失败不丢输入');
  ui.click('close'); const confirming = ui.click('close-confirm'); const request = ui.calls.at(-1);
  request.respond({ error: '本机结束回执不可用', code: 'close_unconfirmed' }, 500); await confirming;
  assert.equal(ui.get('close-dialog').open, true); assert.match(ui.get('close-error').textContent, /未收到结束确认/);
  assert.equal(ui.get('close-cancel').disabled, false); assert.equal(ui.get('close').disabled, false);
  ui.click('close-cancel'); assert.equal(ui.get('close-dialog').open, false); assert.equal(ui.document.activeElement, ui.get('close'));
  assert.equal(ui.get('name').value, '关闭失败不丢输入'); assert.equal(ui.calls.filter(call => call.url === '/api/close').length, 1);
  assert.equal(ui.get('save').disabled, false);
});

test('server bootstrap fixes ordinary PROD and labels explicit internal SIT without any environment selector', async () => {
  const normal = harness(); await normal.initialize([]);
  assert.equal(normal.get('cloud-environment'), null); assert.doesNotMatch(view, /<select|environment-label|SIT/);
  assert.match(normal.get('cloud-source').textContent, /PROD/); assert.equal(normal.get('preview-note').hidden, true);
  assert.ok(normal.calls.filter(call => call.url.startsWith('/api/cloud/catalog')).every(call => call.url.endsWith('environment=prod')));
  const internal = harness({ environment: 'sit', internalPreview: true }); await internal.initialize([]);
  assert.match(internal.get('cloud-source').textContent, /SIT · 内部测试/); assert.equal(internal.get('preview-note').hidden, false);
  assert.match(internal.get('preview-note').textContent, /SIT · 内部测试/);
  assert.ok(internal.calls.some(call => call.url === '/api/cloud/catalog?environment=sit'));
  internal.click('cloud-details-sit-8'); assert.match(internal.get('details-content').textContent, /来源环境SIT · 内部测试/);
  const notInternal = harness({ environment: 'sit', internalPreview: false }); await notInternal.initialize([]);
  assert.ok(notInternal.calls.some(call => call.url === '/api/cloud/catalog?environment=prod'));
  const wrongReply = harness(); await wrongReply.initialize([], catalog('sit'));
  assert.equal(wrongReply.get('cloud-list').textContent, ''); assert.match(wrongReply.get('cloud-state').textContent, /环境或内容与请求不一致/);
  assert.match(wrongReply.get('cloud-source').textContent, /PROD/);
});

test('opening and refreshing saved devices performs one finite round with at most two readonly requests and local errors do not block the rest', async () => {
  const profiles = Array.from({ length: 5 }, (_, index) => ({ ...profileA, id: `local_${String(index + 3).padStart(32, '0')}`, name: `合成设备${index + 1}`, api_base_url: `http://fixture.invalid:8080/${index}` }));
  const ui = harness({ autoInitialChecks: false }); await ui.initialize(profiles);
  const testCalls = () => ui.calls.filter(call => /\/api\/profiles\/[^/]+\/test$/.test(call.url));
  const unresolved = () => testCalls().filter(call => !call.settled);
  assert.equal(testCalls().length, 2); assert.equal(ui.get(`check-state-${profiles[2].id}`).textContent, '等待检测');
  let maximum = unresolved().length;
  testCalls()[0].respond(check(profiles[0], { outcome: 'partial', issues: [{ message: '部分信息未返回' }] })); await flush();
  assert.equal(testCalls().length, 3); maximum = Math.max(maximum, unresolved().length);
  testCalls()[1].respond({ error: '读取超时', code: 'local_timeout' }, 502); await flush();
  assert.equal(testCalls().length, 4); maximum = Math.max(maximum, unresolved().length);
  for (let step = 0; step < 5; step++) {
    for (const call of unresolved()) { const profile = profiles.find(item => call.url === `/api/profiles/${item.id}/test`); call.respond(check(profile)); }
    await flush(); maximum = Math.max(maximum, unresolved().length);
  }
  assert.equal(maximum, 2); assert.equal(testCalls().length, 5);
  assert.equal(ui.get(`check-state-${profiles[0].id}`).dataset.tone, 'warning'); assert.equal(ui.get(`check-state-${profiles[1].id}`).dataset.tone, 'danger');
  const beforeWait = testCalls().length; await ui.advance(180000); assert.equal(testCalls().length, beforeWait, 'there is no periodic device poll');
  const refreshing = ui.click('local-refresh'); ui.calls.filter(call => call.url === '/api/profiles' && call.options.method === 'GET').at(-1).respond({ profiles }); await refreshing;
  assert.equal(testCalls().length, 7, 'a completed round is not reused as a fake fresh cache');
  for (let step = 0; step < 5; step++) { for (const call of unresolved()) { const profile = profiles.find(item => call.url === `/api/profiles/${item.id}/test`); call.respond(check(profile)); } await flush(); }
  assert.equal(testCalls().length, 10);
  assert.ok(ui.calls.every(call => !/task|benchmark|power|solve/i.test(call.url)));
  assert.equal(ui.calls.filter(call => call.url === '/api/profiles' && call.options.method === 'POST').length, 0);
  for (const call of testCalls()) assert.deepEqual(JSON.parse(call.options.body), { revision: 1 });
});

test('repeated refreshes share the global two-slot limit, hidden pauses pending work and ended sessions launch nothing else', async () => {
  const profiles = Array.from({ length: 5 }, (_, index) => ({ ...profileA, id: `local_${String(index + 10).padStart(32, '0')}`, name: `队列设备${index}`, api_base_url: `http://fixture.invalid:8080/q${index}` }));
  const ui = harness({ autoInitialChecks: false }); await ui.initialize(profiles);
  const testCalls = () => ui.calls.filter(call => /\/api\/profiles\/[^/]+\/test$/.test(call.url));
  for (let step = 0; step < 3; step++) {
    const refreshing = ui.click('local-refresh'); ui.calls.filter(call => call.url === '/api/profiles' && call.options.method === 'GET').at(-1).respond({ profiles }); await refreshing;
    assert.equal(testCalls().length, 2, 'refresh must not reset in-flight slots');
  }
  await ui.visibility('hidden');
  testCalls()[0].respond(check(profiles[0])); testCalls()[1].respond(check(profiles[1])); await flush();
  assert.equal(testCalls().length, 2);
  await ui.visibility('visible'); assert.equal(testCalls().length, 4);
  ui.click('close'); const ending = ui.click('close-confirm'); ui.calls.at(-1).respond({ closed: true }); await ending;
  testCalls()[2].respond(check(profiles[2])); testCalls()[3].respond(check(profiles[3])); await flush();
  await ui.visibility('visible'); await ui.advance(60000);
  assert.equal(testCalls().length, 4, 'fifth device stays unstarted after management ends');
});

test('hidden initial pages wait for visibility; editing a queued connection does not turn save into a probe', async () => {
  const third = { ...profileA, id: `local_${'3'.repeat(32)}`, name: '待编辑 C', api_base_url: 'http://fixture.invalid:8080/c' };
  const ui = harness({ visible: 'hidden', autoInitialChecks: false }); await ui.initialize([profileA, profileB, third]);
  const testCalls = () => ui.calls.filter(call => /\/api\/profiles\/[^/]+\/test$/.test(call.url));
  assert.equal(testCalls().length, 0); await ui.visibility('visible'); assert.equal(testCalls().length, 2);
  ui.click(`edit-${third.id}`); ui.type('api', 'http://fixture.invalid:8080/c-new');
  const saving = ui.submit(); const revised = { ...third, revision: 2, api_base_url: 'http://fixture.invalid:8080/c-new' };
  ui.calls.at(-1).respond({ profile: revised }); await saving;
  testCalls()[0].respond(check(profileA)); testCalls()[1].respond(check(profileB)); await flush();
  assert.equal(testCalls().length, 2); assert.equal(ui.get(`check-state-${third.id}`).textContent, '尚未检测');
  const manual = ui.click(`test-${third.id}`); const request = testCalls().at(-1); assert.deepEqual(JSON.parse(request.options.body), { revision: 2 });
  request.respond(check(revised)); await manual;
  assert.equal(ui.get(`check-state-${third.id}`).textContent, '信息读取完整');
});

test('changing an in-flight device identity keeps its old readonly slot until settlement and only an explicit refresh queues its replacement', async () => {
  const third = { ...profileA, id: `local_${'4'.repeat(32)}`, name: '第三台', api_base_url: 'http://fixture.invalid:8080/third' };
  const ui = harness({ autoInitialChecks: false }); await ui.initialize([profileA, profileB, third]);
  const tests = () => ui.calls.filter(call => /\/api\/profiles\/[^/]+\/test$/.test(call.url));
  const oldA = tests()[0]; const oldB = tests()[1];
  ui.click(`edit-${profileA.id}`); ui.type('api', 'http://fixture.invalid:8080/a-revised');
  const saving = ui.submit(); const revised = { ...profileA, revision: 2, api_base_url: 'http://fixture.invalid:8080/a-revised' };
  ui.calls.at(-1).respond({ profile: revised }); await saving;
  assert.equal(tests().length, 2); assert.equal(oldA.options.signal.aborted, false);
  const refreshing = ui.click('local-refresh'); ui.calls.filter(call => call.url === '/api/profiles' && call.options.method === 'GET').at(-1).respond({ profiles: [revised, profileB, third] }); await refreshing;
  assert.equal(tests().length, 2, 'edited address must not manufacture a free backend-work slot');
  oldA.respond(check(profileA, { device: { ...check().device, name: '旧来源不可用' } })); await flush();
  assert.equal(tests().length, 3); const newA = tests()[2]; assert.deepEqual(JSON.parse(newA.options.body), { revision: 2 });
  assert.equal(ui.get(`check-state-${profileA.id}`).textContent, '正在检测');
  oldB.respond(check(profileB)); await flush(); assert.equal(tests().length, 4);
  newA.respond(check(revised, { device: { ...check().device, name: '当前来源' } })); tests()[3].respond(check(third)); await flush();
  ui.click(`info-${profileA.id}`); assert.match(ui.get('details-content').textContent, /当前来源/); assert.doesNotMatch(ui.get('details-content').textContent, /旧来源不可用/);
});

test('only real user input marks activity interactive; background-style visible heartbeats cannot claim interaction', async () => {
  const ui = harness(); await ui.initialize([]);
  assert.equal(JSON.parse(ui.request('/api/activity').options.body).interactive, true, 'opening explicitly engages once');
  await ui.advance(30000);
  let latest = ui.calls.filter(call => call.url === '/api/activity').at(-1);
  assert.equal(JSON.parse(latest.options.body).interactive, false, 'timer is only a health heartbeat');
  const before = ui.calls.filter(call => call.url === '/api/activity').length;
  ui.keydown('a'); assert.equal(ui.calls.filter(call => call.url === '/api/activity').length, before);
  ui.keydown('a', ui.get('name'), true); latest = ui.calls.filter(call => call.url === '/api/activity').at(-1);
  assert.equal(JSON.parse(latest.options.body).interactive, true);
});
test('editor upgrade protection follows unsaved generation and cancel without saving the connection', async () => {
  const ui = harness(); await ui.initialize([]); ui.click('add'); ui.type('name', '升级前尚未保存');
  let state=JSON.parse(ui.calls.filter(call=>call.url==='/api/editor').at(-1).options.body);
  assert.equal(state.dirty,true); assert.equal(state.generation,1); assert.match(state.draft_id,/^[a-f0-9]{32}$/);
  ui.type('api','http://fixture.invalid'); const next=JSON.parse(ui.calls.filter(call=>call.url==='/api/editor').at(-1).options.body);
  assert.equal(next.draft_id,state.draft_id);assert.equal(next.generation,2);assert.ok(next.sequence>state.sequence);
  ui.click('cancel');state=JSON.parse(ui.calls.filter(call=>call.url==='/api/editor').at(-1).options.body);
  assert.equal(state.dirty,false);assert.equal(state.draft_id,null);
  assert.equal(ui.calls.filter(call=>call.url==='/api/profiles'&&call.options.method==='POST').length,0);
});
test('a lost local service stops automatic heartbeat attempts and a real action may retry once',async()=>{const ui=harness({autoActivity:false});await ui.initialize([]);ui.request('/api/activity').reject(new Error('connection refused'));await flush();const count=ui.calls.filter(c=>c.url==='/api/activity').length;await ui.advance(90000);assert.equal(ui.calls.filter(c=>c.url==='/api/activity').length,count);ui.keydown('a',ui.get('name'),true);assert.equal(ui.calls.filter(c=>c.url==='/api/activity').length,count+1);});
test('editor protection registration errors are shown while preserving the current input',async()=>{const ui=harness({autoEditor:false});await ui.initialize([]);ui.click('add');ui.type('name','保护失败仍保留');const request=ui.calls.filter(c=>c.url==='/api/editor').at(-1);request.respond({error:'capacity',code:'editor_state_capacity'},429);await flush();assert.match(ui.get('form-notice').textContent,/编辑保护尚未确认/);assert.equal(ui.get('name').value,'保护失败仍保留');assert.equal(ui.get('save').disabled,false);});
