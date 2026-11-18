'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { SolverProfileStore } = require('./solver-profiles');
const { TargetConfigData } = require('./target-config-data');
const lifecycle = require('./target-config-lifecycle');
const { ManagerSession, IDLE_TIMEOUT_MS } = require('./target-config-session');
const { ManagerDraftStore } = require('./target-config-drafts');
const view = require('./target-config/view');
const styles = require('./target-config/styles');
const client = require('./target-config/client');
const { resolveManagerEnvironment, renderManagerClient } = require('./target-config-bootstrap');
const { STATIC_SVG_ASSETS } = require('./target-config/device-art');
const { runtimeIdentity } = require('./runtime-identity');
const MAX_BODY = 64 * 1024;
const BODY_TIMEOUT_MS = 10000;
function managerRuntimeDigest() {
  // Official bundles and single executables embed the source digest at build time.
  if (typeof __ISINGQ_BUILD_RUNTIME_IDENTITY__ !== 'undefined') return __ISINGQ_BUILD_RUNTIME_IDENTITY__.artifact_sha256;
  if (module.filename) return runtimeIdentity(path.resolve(__dirname, '..')).artifact_sha256;
  // esbuild's bundled CommonJS modules lack a filename. The outer filename is
  // the same standalone script that starts the sidecar.
  return crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
}
const RUNTIME_DIGEST = managerRuntimeDigest();
function managerBuildIdentity(mode = resolveManagerEnvironment()) {
  return lifecycle.buildIdentity(view, styles, renderManagerClient(mode, client), RUNTIME_DIGEST);
}
const MANAGER_BUILD_ID = managerBuildIdentity();

function validLifetime(value) { if (!Number.isSafeInteger(value) || value < 100 || value > 60 * 60 * 1000) throw new Error('配置会话闲置预算必须为100到3600000毫秒整数'); return value; }
function idleBudget(idleTimeoutMs, lifetimeMs) { return validLifetime(idleTimeoutMs ?? lifetimeMs ?? IDLE_TIMEOUT_MS); }
function json(response, status, value) { if (response.destroyed || response.writableEnded) return; response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); }
function body(request) {
  return new Promise((resolve, reject) => {
    let size = 0, finished = false; const chunks = [];
    const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { finish(Object.assign(new Error(`配置请求正文读取超过${BODY_TIMEOUT_MS}毫秒（已收${size}字节）；请保留输入后重试`), { status: 408, code: 'config_body_timeout' })); request.destroy(); }, BODY_TIMEOUT_MS);
    timer.unref();
    request.on('data', chunk => { if (finished) return; size += chunk.length; if (size > MAX_BODY) { finish(Object.assign(new Error('配置请求超过64KiB；请减少输入'), { status: 413 })); request.resume(); return; } chunks.push(chunk); });
    request.on('end', () => { if (finished) return; try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { finish(Object.assign(new Error('请求不是有效JSON；请检查输入'), { status: 400 })); } });
    request.once('aborted', () => finish(Object.assign(new Error('配置请求未完整到达；请保留输入后重试'), { status: 400, code: 'config_body_incomplete' })));
    request.once('error', error => finish(error));
  });
}
async function openTargetConfig({ profileStore = new SolverProfileStore(), lifetimeMs, idleTimeoutMs, sessionOptions = {}, draftStore, draftOptions = {}, keepAlive = false,
  dataService, localTransportFactory, catalogClientFactory, timeoutSeconds, now, managedIdentity = null, internalPreviewEnvironment,
  shutdownGraceMs = lifecycle.SHUTDOWN_GRACE_MS, shutdownTimeoutMs = lifecycle.SHUTDOWN_TIMEOUT_MS } = {}) {
  const budget = idleBudget(idleTimeoutMs, lifetimeMs);
  const mode = resolveManagerEnvironment(internalPreviewEnvironment), renderedClient = renderManagerClient(mode, client);
  if (!Number.isInteger(shutdownGraceMs) || !Number.isInteger(shutdownTimeoutMs) || shutdownGraceMs < 0 || shutdownTimeoutMs < 1 || shutdownGraceMs > shutdownTimeoutMs || shutdownTimeoutMs > lifecycle.SHUTDOWN_TIMEOUT_MS) throw new Error('管理页收尾时间必须在1秒内且grace不大于总期限');
  // In-process adapters are deliberately not accepted by the sidecar launcher
  // or serialized through its arguments/environment/IPC channel.
  const data = dataService || new TargetConfigData({ profileStore, localTransportFactory, catalogClientFactory, timeoutSeconds, now });
  const drafts = draftStore || new ManagerDraftStore({ configFile: profileStore.file, ...draftOptions });
  const token = crypto.randomBytes(32).toString('hex'); let origin, active = true, closing, sessionState;
  const editors = new Map();
  let pendingBodies = 0, editorProtectionUncertain = false;
  const readBody = async request => { pendingBodies++; try { return await body(request); } finally { pendingBodies--; } };
  let closedResolve; const closed = new Promise(resolve => { closedResolve = resolve; }); const sockets = new Set();
  const sessionActive = () => active && !closing && Boolean(sessionState?.isActive());
  const assertActive = () => { if (!sessionActive()) { close(); throw Object.assign(new Error('本机会话已结束；请重新打开管理页'), { status: 403, code: 'config_session_closed' }); } };
  const reply = (response, status, value) => { const valid = sessionActive(); return json(response, valid ? status : 403, valid ? value : { error: '本机会话已结束或闲置回收；请重新打开管理页', code: 'config_session_closed' }); };
  const operation = work => sessionState.operation(() => { assertActive(); return work(); });
  const server = http.createServer(async (request, response) => {
    if (!sessionActive()) return json(response, 403, { error: '本机会话已结束；请重新打开管理页', code: 'config_session_closed' });
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (request.headers.host !== new URL(origin).host) return reply(response, 403, { error: '仅允许通过原本机地址访问配置页' });
    const route = request.url;
    if (request.method === 'GET' && Object.hasOwn(STATIC_SVG_ASSETS, route)) { response.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' }); return response.end(STATIC_SVG_ASSETS[route]); }
    if (request.method === 'GET' && route === '/favicon.ico') { response.writeHead(204); return response.end(); }
    if (request.method === 'GET' && ['/', '/style.css', '/app.js'].includes(route)) { response.writeHead(200, { 'Content-Type': route === '/' ? 'text/html; charset=utf-8' : route === '/style.css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' }); return response.end(route === '/' ? view : route === '/style.css' ? styles : renderedClient); }
    const supplied = request.headers['x-config-token'];
    if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return reply(response, 403, { error: '本机会话凭证无效；请从Toolkit重新打开配置页' });
    if (request.headers.origin && request.headers.origin !== origin) return reply(response, 403, { error: '拒绝来自其他网站的配置请求' });
    if (request.method !== 'GET' && request.headers.origin !== origin) return reply(response, 403, { error: '保存配置必须从本机配置页发起' });
    if (request.method !== 'GET' && !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) return reply(response, 415, { error: '配置请求必须使用application/json' });
    try {
      const parsed = new URL(route, origin);
      if (parsed.origin !== origin) return reply(response, 400, { error: '配置API仅接受本机相对路径', code: 'config_route_invalid' });
      if (request.method === 'GET' && route === '/api/session') return reply(response, 200, { ...(managedIdentity || {}), pid: process.pid, cloud_environment: mode.environment, internal_preview: mode.internalPreview, ...sessionState.snapshot() });
      if (request.method === 'POST' && route === '/api/activity') { const value = await readBody(request); assertActive(); return reply(response, 200, sessionState.activity(value)); }
      if (request.method === 'POST' && route === '/api/editor') {
        const value = await readBody(request); assertActive();
        if (!value || Object.keys(value).sort().join(',') !== 'dirty,draft_id,generation,page_id,sequence' || !/^[a-f0-9]{32}$/.test(value.page_id) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || typeof value.dirty !== 'boolean' || (value.dirty ? !/^[a-f0-9]{32}$/.test(value.draft_id) || !Number.isSafeInteger(value.generation) || value.generation < 1 : value.draft_id !== null || value.generation !== 0)) return reply(response, 400, { error: '编辑保护状态字段无效，请保留当前输入', code: 'editor_state_invalid' });
        const previous = editors.get(value.page_id);
        if (previous && value.sequence <= previous.sequence) return reply(response, 409, { error: '忽略旧编辑保护状态', code: 'editor_state_stale' });
        if (!previous && editors.size >= 640) {
          const clean = [...editors].find(([, editor]) => !editor.dirty);
          if (clean) editors.delete(clean[0]);
          else { editorProtectionUncertain = true; return reply(response, 429, { error: '编辑保护记录已达上限，已暂停自动交接；请保存输入并结束原管理页后重试', code: 'editor_state_capacity' }); }
        }
        editors.set(value.page_id, value); return reply(response, 200, { recorded: true });
      }
      if (request.method === 'POST' && route === '/api/handover') {
        const value = await readBody(request); assertActive();
        if (!managedIdentity || !value || Object.keys(value).join(',') !== 'expected_build' || value.expected_build !== managedIdentity.build_id) return reply(response, 409, { error: '管理页版本已变化，请重新核对', code: 'manager_upgrade_unverified' });
        const state = sessionState.snapshot();
        if (state.foreground_pages > 0 || state.operations_in_flight > 0 || pendingBodies > 0) return reply(response, 409, { error: '旧页仍在使用，请保存输入并结束原管理页后再打开新版', code: 'manager_upgrade_busy' });
        if (editorProtectionUncertain) return reply(response, 409, { error: '存在未确认的编辑保护登记，请保存输入并结束原管理页后再升级', code: 'manager_upgrade_unprotected' });
        const backups = drafts.list().drafts;
        if ([...editors.values()].some(editor => editor.dirty && !backups.some(draft => draft.id === editor.draft_id && draft.generation >= editor.generation && Date.parse(draft.expires_at) > Date.now()))) return reply(response, 409, { error: '旧页存在未确认或已过期的草稿备份，请从原页保存、重新备份或取消编辑', code: 'manager_upgrade_unprotected' });
        reply(response, 200, { closed: true, handover: true, remote_tasks_cancelled: false }); close(); return;
      }
      if (request.method === 'GET' && route === '/api/drafts') return reply(response, 200, await operation(() => drafts.list()));
      const draftRoute = /^\/api\/drafts\/([a-f0-9]{32})$/.exec(route);
      if (request.method === 'GET' && draftRoute) return reply(response, 200, await operation(() => drafts.get(draftRoute[1])));
      if (request.method === 'POST' && route === '/api/drafts') { const value = await readBody(request); assertActive(); return reply(response, 200, await operation(() => drafts.save(value))); }
      if (request.method === 'DELETE' && draftRoute) { const value = await readBody(request); assertActive(); return reply(response, 200, await operation(() => drafts.delete(draftRoute[1], value))); }
      if (request.method === 'GET' && parsed.pathname === '/api/cloud/catalog') {
        const keys = [...parsed.searchParams.keys()];
        if (keys.length !== 1 || keys[0] !== 'environment') return reply(response, 400, { error: '云目录仅接受一个environment=prod或sit参数', code: 'cloud_environment_invalid' });
        const requestedEnvironment = parsed.searchParams.get('environment');
        if (!['prod', 'sit'].includes(requestedEnvironment)) return reply(response, 400, { error: '云目录environment必须为受支持的固定环境枚举', code: 'cloud_environment_invalid' });
        if (requestedEnvironment !== mode.environment) return reply(response, 400, { error: mode.environment === 'prod' ? '本管理会话固定PROD，不能通过页面参数切换SIT' : '本会话仅用于固定SIT内部测试，不能通过页面参数切换PROD', code: 'cloud_environment_locked' });
        return reply(response, 200, await operation(() => data.cloudCatalog(mode.environment)));
      }
      const testRoute = /^\/api\/profiles\/([^/]+)\/test$/.exec(parsed.pathname);
      if (request.method === 'POST' && testRoute) {
        if (parsed.search) return reply(response, 400, { error: '连接测试不接受查询参数，请使用已保存版本', code: 'profile_test_invalid' });
        const value = await readBody(request); assertActive();
        return reply(response, 200, await operation(() => data.testProfile(testRoute[1], value)));
      }
      if (request.method === 'GET' && route === '/api/profiles') return reply(response, 200, { profiles: await operation(() => profileStore.list()), scope: 'current_user_and_toolkit_host', ...sessionState.snapshot() });
      if (request.method === 'POST' && route === '/api/profiles') { const value = await readBody(request); assertActive(); return reply(response, 200, { profile: await operation(() => profileStore.save(value)), saved: true, submitted: false, connection_checked: false }); }
      if (request.method === 'DELETE' && /^\/api\/profiles\/local_[a-f0-9]{32}$/.test(route)) { await readBody(request); assertActive(); return reply(response, 200, await operation(() => profileStore.delete(route.split('/').at(-1)))); }
      if (request.method === 'POST' && route === '/api/close') { await readBody(request); assertActive(); reply(response, 200, { closed: true, remote_tasks_cancelled: false }); close(); return; }
      return reply(response, 404, { error: '配置入口不存在；请刷新页面' });
    } catch (e) {
      if (response.destroyed || response.writableEnded) return;
      if (e.status === 429 && Number.isSafeInteger(e.retry_after_seconds) && e.retry_after_seconds >= 0) response.setHeader('Retry-After', String(e.retry_after_seconds));
      reply(response, e.status || (e.code === 'profile_revision_conflict' ? 409 : 400), { error: e.message, code: e.code || 'config_request_invalid',
        ...(Object.hasOwn(e, 'http_status') ? { http_status: e.http_status } : {}), ...(Object.hasOwn(e, 'retry_after_seconds') ? { retry_after_seconds: e.retry_after_seconds } : {}) });
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.timeout = 10000; server.maxHeadersCount = 40;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;

  const close = () => {
    if (closing) return closing;
    active = false; sessionState?.close(); closing = closed;
    let drainTimer, deadlineTimer, finished = false;
    const finish = () => { if (finished) return; finished = true; clearTimeout(drainTimer); clearTimeout(deadlineTimer); closedResolve({ closed: true, remote_tasks_cancelled: false }); };
    const destroy = () => { server.closeAllConnections?.(); for (const socket of sockets) socket.destroy(); };
    drainTimer = setTimeout(destroy, shutdownGraceMs); drainTimer.unref();
    deadlineTimer = setTimeout(() => { destroy(); finish(); }, shutdownTimeoutMs); deadlineTimer.unref();
    try { server.close(finish); server.closeIdleConnections?.(); } catch (_) { destroy(); finish(); }
    return closing;
  };
  sessionState = new ManagerSession({ ...sessionOptions, idleTimeoutMs: budget, onIdle: close });
  if (!keepAlive) server.unref();
  return { url: `${origin}/#${token}`, cloud_environment: mode.environment, internal_preview: mode.internalPreview, created_at: sessionState.createdAt, get expires_at() { return sessionState.snapshot().idle_deadline_at; },
    get session() { return sessionState.snapshot(); }, scope: 'current_user_and_toolkit_host', close, closed, server };
}

function minimalEnvironment() {
  const result = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) result[key] = process.env[key];
  return result;
}
// pkg has used both process.pkg and process.versions.pkg. SEA is a separate
// distribution format; node:sea is intentionally optional for Node18 sources.
function isPackagedRuntime(runtime = process, seaProbe = () => require('node:sea').isSea()) {
  if (runtime.pkg || runtime.versions?.pkg) return true;
  try { return seaProbe() === true; } catch (_) { return false; }
}
async function stopOwnedChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return true;
  const wait = milliseconds => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode) return resolve(true);
    const finished = () => { clearTimeout(timer); child.removeListener('exit', finished); child.removeListener('close', finished); resolve(true); };
    const timer = setTimeout(() => { child.removeListener('exit', finished); child.removeListener('close', finished); resolve(false); }, milliseconds);
    child.once('exit', finished); child.once('close', finished);
  });
  try { child.kill('SIGTERM'); } catch (_) {}
  if (await wait(lifecycle.SHUTDOWN_GRACE_MS)) return true;
  try { child.kill('SIGKILL'); } catch (_) {}
  return wait(lifecycle.SHUTDOWN_TIMEOUT_MS - lifecycle.SHUTDOWN_GRACE_MS);
}
async function launchTargetConfig({ profileStore = new SolverProfileStore(), lifetimeMs, idleTimeoutMs, sessionOptions = {}, executablePath = process.execPath,
  packaged = isPackagedRuntime(), lifecycleOptions = {}, internalPreviewEnvironment } = {}) {
  const budget = idleBudget(idleTimeoutMs, lifetimeMs);
  const allowedPolicy = ['foregroundLeaseMs', 'heartbeatMs', 'operationTimeoutMs', 'maxPageRecords', 'pageRetentionMs'];
  if (Object.keys(sessionOptions).some(key => !allowedPolicy.includes(key) || !Number.isSafeInteger(sessionOptions[key]) || sessionOptions[key] < 1)) throw new Error('托管会话仅接受明确的内部idle策略数值');
  const mode = resolveManagerEnvironment(internalPreviewEnvironment), buildId = managerBuildIdentity(mode);
  const file = lifecycle.canonicalConfigFile(profileStore.file), loc = lifecycle.location(file, buildId, undefined, mode.environment);
  const startupMs = lifecycleOptions.startupTimeoutMs ?? lifecycle.STARTUP_TIMEOUT_MS;
  const waitMs = lifecycleOptions.waitTimeoutMs ?? lifecycle.WAIT_TIMEOUT_MS;
  const probeMs = lifecycleOptions.identityTimeoutMs ?? lifecycle.IDENTITY_TIMEOUT_MS;
  if (![startupMs, waitMs, probeMs].every(value => Number.isSafeInteger(value) && value > 0) || startupMs > lifecycle.STARTUP_TIMEOUT_MS || waitMs > lifecycle.WAIT_TIMEOUT_MS || probeMs > lifecycle.IDENTITY_TIMEOUT_MS) throw new Error('管理页测试期限不可超出既定启动/等待/身份核验上限');
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const claim = lifecycle.newClaim(loc, Math.min(startupMs, Math.max(1, deadline - Date.now())));
    if (!claim) { lifecycle.recoverClaim(loc); await lifecycle.sleep(Math.min(25, Math.max(1, deadline - Date.now()))); continue; }
    let child, published = false, result, operationError, failed = false;
    try {
      result = await (async () => {
      await lifecycle.retireLegacy(loc, Math.min(probeMs, Math.max(1, deadline - Date.now())));
      const raced = await lifecycle.reusable(loc, Math.min(probeMs, Math.max(1, deadline - Date.now())));
      if (raced) return lifecycle.publicSession(raced);
      if (Date.now() >= claim.deadline_at) throw new lifecycle.ManagerLifecycleError('manager_wait_timeout', '管理页启动等待已到期，未创建新的子进程');
      const control = JSON.stringify({ registry_root: loc.directory, nonce: claim.nonce, build_id: buildId, cloud_environment: mode.environment, internal_preview: mode.internalPreview, session_options: sessionOptions });
      const args = [file, String(budget), control];
      const options = { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: minimalEnvironment() };
      child = lifecycleOptions.spawnSidecar ? lifecycleOptions.spawnSidecar({ executablePath, packaged, modulePath: __filename, args, options })
        : packaged ? spawn(executablePath, ['__target-config-serve', ...args], options) : fork(__filename, ['--config-sidecar', ...args], { ...options, execPath: executablePath, execArgv: [] });
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = error => { if (settled) return; settled = true; clearTimeout(timer); child.removeListener('error', failed); child.removeListener('exit', failed); child.removeListener('message', ready); error ? reject(error) : resolve(); };
        const failed = () => finish(new lifecycle.ManagerLifecycleError('manager_start_failed', '管理页进程未能就绪；请检查本机运行时与配置权限'));
        const ready = message => message?.type === 'target-config-ready' ? finish() : finish(new lifecycle.ManagerLifecycleError('manager_receipt_invalid', '管理页未返回受支持的就绪回执'));
        const timer = setTimeout(() => finish(new lifecycle.ManagerLifecycleError('manager_start_timeout', '管理页启动超过有界就绪期限；本次子进程将被回收')), Math.max(1, claim.deadline_at - Date.now()));
        child.once('error', failed); child.once('exit', failed); child.once('message', ready);
      });
      const record = lifecycle.validSession(lifecycle.readPrivate(loc.file, { missing: false }), loc);
      const verified = await lifecycle.queryIdentity(record, probeMs);
      if (record.nonce !== claim.nonce || record.pid !== child.pid || !verified) throw new lifecycle.ManagerLifecycleError('manager_identity_unverified', '新管理页身份未核验；停止本次子进程，不返回不明地址');
      published = true; if (child.connected) child.disconnect(); child.unref(); return lifecycle.publicSession({ ...record, current_state: verified });
      })();
    } catch (error) {
      failed = true;
      operationError = error;
    }
    // An unverified child must retain its claim and remain the actionable error;
    // make that precedence explicit rather than overriding control in finally.
    if (child && !published) {
      if (!await stopOwnedChild(child)) throw new lifecycle.ManagerLifecycleError('manager_cleanup_unverified', '本次启动失败且子进程退出未核实；保留登记，请勿反复打开或按磁盘PID终止进程');
      lifecycle.removeSession(loc, claim.nonce);
    }
    lifecycle.removeClaim(loc, claim.nonce);
    if (failed) throw operationError;
    return result;
  }
  throw new lifecycle.ManagerLifecycleError('manager_wait_timeout', '管理页正在由其他调用启动，等待已到期；请稍后重试，不会额外启动进程');
}
async function serveTargetConfigSidecar(args = []) {
  let session, loc, claim, record, startupTimer, finalized = false;
  const finalize = async (code = 0) => {
    if (finalized) return; finalized = true; clearTimeout(startupTimer);
    if (session) await session.close();
    try { if (record) lifecycle.removeSession(loc, record.nonce); if (loc && claim) lifecycle.removeClaim(loc, claim.nonce); } catch (_) { /* Never delete a different owner's registration. */ }
    process.exit(code);
  };
  try {
    const [inputFile, lifetime, serialized] = args;
    const control = JSON.parse(serialized);
    const file = lifecycle.canonicalConfigFile(inputFile);
    const mode = resolveManagerEnvironment(control.internal_preview === true ? control.cloud_environment : undefined), buildId = managerBuildIdentity(mode);
    if (control.cloud_environment !== mode.environment || control.internal_preview !== mode.internalPreview || control.build_id !== buildId) throw new Error('fixed environment/build mismatch');
    loc = lifecycle.location(file, buildId, control.registry_root, mode.environment);
    claim = lifecycle.claimChild(loc, control.nonce);
    startupTimer = setTimeout(() => finalize(1), Math.max(1, claim.deadline_at - Date.now()));
    const store = new SolverProfileStore({}); store.file = file; store.directory = path.dirname(file);
    session = await openTargetConfig({ profileStore: store, idleTimeoutMs: Number(lifetime), sessionOptions: control.session_options || {}, keepAlive: true, internalPreviewEnvironment: mode.internalPreview ? 'sit' : undefined,
      managedIdentity: { protocol: lifecycle.LIFECYCLE_PROTOCOL, nonce: claim.nonce, config_file: file, build_id: buildId, user_id: loc.user_id, cloud_environment: mode.environment, internal_preview: mode.internalPreview } });
    record = lifecycle.publishSession(loc, claim, session); clearTimeout(startupTimer);
    process.once('SIGTERM', () => finalize()); process.once('SIGINT', () => finalize());
    session.closed.then(() => finalize());
    if (process.send && process.connected) process.send({ type: 'target-config-ready' });
    return session;
  } catch (_) {
    if (process.send && process.connected) process.send({ type: 'target-config-error' });
    if (loc && claim) return finalize(1);
    process.exitCode = 1; return null;
  }
}
if (require.main === module && ['--config-sidecar', '__target-config-serve'].includes(process.argv[2])) serveTargetConfigSidecar(process.argv.slice(3));
module.exports = { openTargetConfig, launchTargetConfig, serveTargetConfigSidecar, isPackagedRuntime, MANAGER_BUILD_ID, managerBuildIdentity };
