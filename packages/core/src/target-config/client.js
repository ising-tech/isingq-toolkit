'use strict';

const { DEVICE_ART, ACTION_ICONS, ART_DIGEST } = require('./device-art');

function targetConfigClient(deviceArt, actionIcons, managerBootstrap) {
  'use strict';
  const byId = id => document.getElementById(id);
  const fixedEnvironment = managerBootstrap?.environment === 'sit' && managerBootstrap.internal_preview === true ? 'sit' : 'prod';
  const internalPreview = fixedEnvironment === 'sit';
  const storageKey = 'isingq-target-config-session';
  const fromHash = location.hash.slice(1);
  let token = fromHash;
  if (!token) { try { token = sessionStorage.getItem(storageKey) || ''; } catch (_) {} }
  history.replaceState(null, '', location.pathname + location.search);
  let active = /^[a-f0-9]{64}$/.test(token);
  if (active) { try { sessionStorage.setItem(storageKey, token); } catch (_) {} }
  else { try { sessionStorage.removeItem(storageKey); } catch (_) {} }

  let profiles = [];
  let profilesSequence = 0;
  let profilesLoading = false;
  let saveBusy = false;
  let editorGeneration = 0;
  let editorContext = 0;
  let checkSequence = 0;
  let checkRound = 0;
  let checksInFlight = 0;
  let pageSuspended = document.visibilityState !== 'visible';
  let pendingChecks = [];
  const runningChecks = new Map();
  const checks = new Map();
  const cardViews = new Map();
  const deleting = new Set();
  const savingProfiles = new Set();
  const draftContexts = new Map();
  const draftMetadata = new Map();
  const ignoredDrafts = new Set();
  let currentDraft = null;
  let draftListSequence = 0;
  let draftRestoreSequence = 0;
  let draftRestoreId = null;
  let draftListError = '';
  let heartbeatTimer = null;
  let draftExpiryTimer = null;
  let activitySequence = 0;
  let sessionSequence = 0;
  let editorSafetySequence = 0;
  let lastEditorSafety = '';
  let lastInteractionSent = 0;
  let leaseHealthy = false;
  let policy = { idle_timeout_ms: 1800000, foreground_lease_ms: 90000, heartbeat_ms: 30000 };
  const pageId = randomId();
  const cloud = { environment: fixedEnvironment, sequence: 0, controller: null, phase: 'idle', catalog: null, checked_at: null, error: null };

  function make(tag, text = '', className = '') {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function message(id, text, isError = false) {
    const element = byId(id);
    element.textContent = text;
    element.hidden = !text;
    element.dataset.error = String(isError);
  }
  function display(value, unknown = '未知') {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return unknown;
  }
  function timestamp(value, compact = false) {
    if (value === null || value === undefined || value === '') return '时间未知';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', compact
      ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false } : { hour12: false }) : '时间未知';
  }
  function fact(list, label, value, wide = false) {
    const row = make('div');
    if (wide) row.className = 'full-width';
    row.append(make('dt', label), make('dd', value));
    list.append(row);
  }
  function action(label, handler, variant = '') {
    const button = make('button', label, 'ui-button');
    button.type = 'button';
    if (variant) button.dataset.variant = variant;
    button.onclick = handler;
    return button;
  }
  function icon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'action-icon');
    for (const [tag, attributes] of actionIcons[name]) {
      const part = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attributes)) part.setAttribute(key, value);
      svg.append(part);
    }
    return svg;
  }
  function iconAction(name, label, handler) {
    const button = action('', handler, 'text'); button.className += ' icon-button';
    button.setAttribute('aria-label', label); button.setAttribute('title', label);
    button.append(icon(name)); return button;
  }
  function deviceVisual(tone, label) {
    const visual = make('div', '', 'device-visual');
    const button = make('button', '', 'device-open'); button.type = 'button';
    button.setAttribute('aria-label', `查看详情 ${label}`); button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', 'details-dialog');
    const stage = make('span', '', 'cabinet-stage'); stage.setAttribute('aria-hidden', 'true');
    const shadow = make('span', '', 'cabinet-shadow');
    const model = make('span', '', 'cabinet-model');
    const image = make('img', '', 'cabinet-face cabinet-front');
    image.setAttribute('src', deviceArt[tone].frontPath);
    const side = make('img', '', 'cabinet-face cabinet-side'); side.setAttribute('src', deviceArt[tone].sidePath);
    for (const face of [image, side]) { face.setAttribute('alt', ''); face.setAttribute('width', '110'); face.setAttribute('height', '230'); face.setAttribute('draggable', 'false'); }
    const top = make('span', '', 'cabinet-top');
    const fallbackImage = make('img', '', 'cabinet-fallback'); fallbackImage.setAttribute('src', deviceArt[tone].path); fallbackImage.setAttribute('alt', ''); fallbackImage.setAttribute('draggable', 'false');
    model.append(image, side, top); stage.append(shadow, model, fallbackImage); button.append(stage); visual.append(button);
    return { visual, image, fallbackImage, button };
  }
  let openMore = null;
  function closeMoreMenu(returnFocus = false) {
    if (!openMore) return;
    const previous = openMore; openMore = null;
    previous.menu.hidden = true; previous.more.setAttribute('aria-expanded', 'false');
    if (returnFocus && !previous.more.disabled) previous.more.focus();
  }
  function positionMoreMenu(view) {
    const trigger = view.more.getBoundingClientRect();
    const popup = view.menu.getBoundingClientRect();
    const headerBottom = byId('manager-header').getBoundingClientRect().bottom;
    const width = window.innerWidth || popup.width + 16;
    const height = window.innerHeight || headerBottom + popup.height + 16;
    const minTop = headerBottom + 8;
    const above = trigger.top - popup.height - 6;
    const below = trigger.bottom + 6;
    view.menu.style.left = `${Math.max(8, Math.min(width - popup.width - 8, trigger.right - popup.width))}px`;
    view.menu.style.top = `${Math.max(minTop, Math.min(height - popup.height - 8, above >= minTop ? above : below))}px`;
    view.menu.style.maxHeight = `${Math.max(44, height - minTop - 8)}px`;
  }
  function toggleMoreMenu(view, forceOpen = false) {
    if (view.more.disabled) return;
    const wasOpen = openMore === view;
    closeMoreMenu();
    if (wasOpen && !forceOpen) return;
    view.menu.hidden = false; view.more.setAttribute('aria-expanded', 'true'); openMore = view;
    positionMoreMenu(view);
    if (!view.remove.disabled) view.remove.focus();
  }
  let detailsBasis = null;
  let detailsOpener = null;
  let endOpener = null;
  let endBusy = false;
  function dismissDetails(returnFocus = true) {
    const opener = detailsOpener; detailsBasis = null; detailsOpener = null;
    if (byId('details-dialog').open) byId('details-dialog').close();
    if (returnFocus && active && opener?.isConnected && !opener.disabled) opener.focus();
  }
  function detailFacts() { return make('dl', '', 'dialog-facts'); }
  function detailStatus(value) {
    const statuses = { offline: '离线（设备状态）', powering_on: '上电中', stable: '稳定', debugging: '调试中', unstable: '不稳定' };
    return statuses[value] || (value ? `未知（${display(value)}）` : '未知');
  }
  function renderDetails() {
    if (!detailsBasis) return;
    const content = byId('details-content'); content.replaceChildren();
    if (detailsBasis.kind === 'local') {
      const profile = currentProfile(detailsBasis.profile.id);
      byId('details-title').textContent = `本地连接 · ${display(profile.name)}`;
      const base = detailFacts();
      fact(base, '连接名称（别名）', display(profile.name)); fact(base, '配置版本', display(profile.revision));
      fact(base, '求解服务地址', display(profile.api_base_url), true); fact(base, '设备网页地址', display(profile.web_base_url, '未配置'), true);
      fact(base, '连接 ID', display(profile.id), true); content.append(base);
      const state = checks.get(profile.id);
      content.append(make('h3', '已加载的设备信息', 'dialog-section-title'));
      if (!state) { content.append(make('p', '尚未检测。可关闭详情后手动测试连接；打开详情不会发起检测。', 'dialog-description')); return; }
      if (state.phase === 'loading') { content.append(make('p', '正在检测，尚未取得本次结果。', 'dialog-description')); return; }
      if (state.phase === 'error') { content.append(make('p', state.error, 'card-message')); return; }
      const result = state.result; const device = result.device || {};
      const facts = detailFacts();
      fact(facts, '本次检测结果', ({ success: '信息读取完整', partial: '部分信息可用', failed: '检测失败' })[result.outcome] || '未知');
      fact(facts, '设备返回名称', display(device.name));
      fact(facts, '设备规模', Number.isSafeInteger(device.max_scale) && device.max_scale > 0 ? String(device.max_scale) : '未知');
      fact(facts, '设备声明精度', display(device.max_precision)); fact(facts, '运行状态', detailStatus(device.status));
      fact(facts, '设备版本', display(device.version)); fact(facts, '服务启动时间', timestamp(device.boot_timestamp));
      fact(facts, '完整检测时间', timestamp(result.checked_at));
      fact(facts, '检测位置', result.observation?.source === 'toolkit_host' ? 'Toolkit 运行位置' : '来源未知');
      content.append(facts);
      if (Array.isArray(result.issues) && result.issues.length) {
        content.append(make('h3', '检测问题', 'dialog-section-title'));
        const list = make('ul', '', 'dialog-issues');
        for (const issue of result.issues) {
          const diagnostic = Number.isInteger(issue?.http_status) ? `（接口 HTTP ${issue.http_status}）` : '';
          list.append(make('li', display(issue?.message, '设备信息未完整返回') + diagnostic));
        }
        content.append(list);
      }
      content.append(make('p', '仅展示本次已读取的信息，不代表硬件或任务可提交保证。', 'dialog-description'));
    } else {
      const entry = cloud.catalog.computerTypes.find(item => item.id === detailsBasis.id);
      byId('details-title').textContent = `云端机型 · ${display(entry.name, `机型 ${display(entry.id)}`)}`;
      const cap = entry.executionCapabilities; const facts = detailFacts();
      fact(facts, '机型 ID', display(entry.id)); fact(facts, '来源环境', `${cloudEnvironmentLabel()} · 公开目录`);
      fact(facts, '标称规格', display(entry.spinNumber)); fact(facts, '声明精度', '未声明');
      const rangeKnown = cap && Number.isSafeInteger(cap.minDimension) && Number.isSafeInteger(cap.maxDimension);
      fact(facts, '已声明实际支持范围', rangeKnown ? `${cap.minDimension}–${cap.maxDimension} 维` : '未知（目录未声明）', true);
      fact(facts, '问题类型', Array.isArray(cap?.problemTypes) && cap.problemTypes.length ? cap.problemTypes.map(value => value === 'qubo' ? 'QUBO' : value === 'ising' ? 'Ising' : display(value)).join(' / ') : '未知');
      fact(facts, '输入格式', Array.isArray(cap?.inputFormats) && cap.inputFormats.length ? cap.inputFormats.map(value => display(value).toUpperCase()).join(' / ') : '未知');
      fact(facts, '单次计算次数上限', display(cap?.maxCalculateCount));
      fact(facts, 'H 支持', cap?.supportsH === true ? '已声明支持' : cap?.supportsH === false ? '已声明不支持' : '未知');
      fact(facts, '固定后处理要求', cap?.fixedPostProcess === 0 || cap?.fixedPostProcess === 1 ? String(cap.fixedPostProcess) : '未声明');
      fact(facts, '目录读取时间', timestamp(cloud.checked_at), true); content.append(facts);
      content.append(make('p', '使用本页已加载的公开目录，不代表实时在线或账号权限。', 'dialog-description'));
    }
  }
  function syncDetails(kind, id) {
    if (!detailsBasis || (kind && detailsBasis.kind !== kind)) return;
    if (id && detailsBasis.kind === 'local' && detailsBasis.profile.id !== id) return;
    const valid = active && (detailsBasis.kind === 'local'
      ? isSameProfile(detailsBasis.profile, currentProfile(detailsBasis.profile.id))
      : cloud.phase === 'complete' && detailsBasis.environment === cloud.environment && detailsBasis.sequence === cloud.sequence && cloud.catalog?.computerTypes.some(entry => entry.id === detailsBasis.id));
    if (!valid) {
      const preferred = detailsBasis.kind === 'local' ? byId('local-refresh') : byId('cloud-refresh');
      const focus = preferred.disabled ? byId('add') : preferred;
      dismissDetails(false); if (active && !focus.disabled) focus.focus(); return;
    }
    const replacement = byId(detailsOpener?.id) || (detailsBasis.kind === 'local' ? byId(`info-${detailsBasis.profile.id}`) : byId(`cloud-details-${detailsBasis.environment}-${detailsBasis.id}`));
    if (replacement) detailsOpener = replacement;
    renderDetails();
  }
  function openDetails(basis, opener) {
    if (!active || byId('close-dialog').open) return;
    closeMoreMenu(); detailsBasis = basis; detailsOpener = opener;
    syncDetails(); if (!detailsBasis) return;
    if (!byId('details-dialog').open) byId('details-dialog').showModal();
    byId('details-close').focus();
  }
  function dismissEndDialog(returnFocus = true) {
    if (endBusy && active) return;
    const opener = endOpener; endOpener = null;
    if (byId('close-dialog').open) byId('close-dialog').close();
    if (returnFocus && active && opener?.isConnected && !opener.disabled) opener.focus();
  }
  function renderEndConfidence() {
    if (byId('close-dialog').open) byId('close-draft-status').textContent = draftConfidence();
  }
  function openEndDialog() {
    if (!active || endBusy || byId('close-dialog').open) return;
    closeMoreMenu(); dismissDetails(false); endOpener = byId('close');
    message('close-error', ''); byId('close-dialog').showModal(); renderEndConfidence(); byId('close-cancel').focus();
  }
  async function confirmEndManagement() {
    if (!active || endBusy || !byId('close-dialog').open) return;
    renderEndConfidence(); endBusy = true;
    byId('close-confirm').disabled = true; byId('close-cancel').disabled = true; byId('close').disabled = true;
    byId('close-confirm').textContent = '正在结束…'; message('close-error', '');
    try {
      await api('/api/close', 'POST', {});
      endBusy = false; dismissEndDialog(false); endSession('管理会话已结束。远端任务不受影响。');
    } catch (error) {
      if (active) message('close-error', `未收到结束确认：${error.message} 请核对本机会话状态，设备与任务不受影响。`, true);
      else { endBusy = false; dismissEndDialog(false); }
    } finally {
      endBusy = false;
      if (active) { byId('close-confirm').disabled = false; byId('close-cancel').disabled = false; byId('close').disabled = false; byId('close-confirm').textContent = '确认结束管理'; }
    }
  }
  function isSameProfile(a, b) { return a && b && a.id === b.id && a.revision === b.revision && a.api_base_url === b.api_base_url; }
  function currentProfile(id) { return profiles.find(profile => profile.id === id); }
  function abortCheck(id) {
    // Invalidate stale data without treating a client abort as completion of the
    // server's readonly work. Its slot stays occupied until the receipt settles.
    checks.delete(id);
  }
  function endSession(text) {
    active = false;
    checkRound++; clearPendingChecks();
    clearTimeout(heartbeatTimer); clearTimeout(draftExpiryTimer); activitySequence++; sessionSequence++;
    for (const draft of draftContexts.values()) clearTimeout(draft.timer);
    profilesSequence++;
    profilesLoading = false;
    cloud.sequence++;
    cloud.controller?.abort();
    for (const [id, state] of checks) {
      state.controller?.abort();
      if (state.phase === 'loading') { state.phase = 'error'; state.error = '会话已结束，未取得本次检测结果。'; }
      renderCard(id);
    }
    try { sessionStorage.removeItem(storageKey); } catch (_) {}
    token = '';
    byId('cloud-state').textContent = '会话已结束，请从 Toolkit 重新打开管理页。';
    byId('cloud-state').hidden = false;
    byId('local-state').hidden = true;
    document.querySelectorAll('input,textarea,button,select').forEach(element => {
      if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') element.readOnly = true;
      else element.disabled = true;
    });
    message('session-status', text + ' ' + draftConfidence(), true);
    message('notice', text, true);
    renderDraftStatus();
  }
  async function api(path, method = 'GET', data, signal, requestOptions = {}) {
    if (!active) throw new Error('本机会话已结束；请从 Toolkit 重新打开管理页。');
    const response = await fetch(path, {
      method, credentials: 'omit', cache: 'no-store', redirect: 'error', signal, ...requestOptions,
      headers: { 'X-Config-Token': token, ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    if (response.status === 403) {
      endSession('本机会话无效或已到期，请从 Toolkit 重新打开管理页。未改变远端任务。');
      const error = new Error('本机会话已到期'); error.status = 403; throw error;
    }
    let result;
    try { result = await response.json(); }
    catch (_) { const error = new Error('未取得有效页面数据，请手动重试。'); error.status = response.status; throw error; }
    if (!response.ok) {
      const error = new Error(typeof result?.error === 'string' ? result.error : '请求失败，请手动重试。');
      error.status = response.status; error.code = result?.code; error.http_status = result?.http_status; error.retry_after_seconds = result?.retry_after_seconds;
      throw error;
    }
    return result;
  }

  function setProfiles(next) {
    for (const [id, state] of checks) {
      if (!isSameProfile(state.profile, next.find(profile => profile.id === id))) abortCheck(id);
    }
    profiles = next;
    pendingChecks = pendingChecks.filter(job => { const valid = isSameProfile(job.profile, currentProfile(job.profile.id)); if (!valid) job.resolve(); return valid; });
    renderLocal();
  }
  function renderLocal() {
    closeMoreMenu();
    byId('count').textContent = String(profiles.length);
    byId('empty').hidden = profilesLoading || profiles.length > 0;
    const list = byId('list');
    list.dataset.count = String(profiles.length);
    cardViews.clear();
    const nodes = profiles.map(profile => {
      const view = localCard(profile);
      cardViews.set(profile.id, view);
      return view.node;
    });
    list.replaceChildren(...nodes);
    for (const profile of profiles) renderCard(profile.id);
    syncDetails('local');
  }
  function localCard(profile) {
    const item = make('li', '', 'device-tile'); item.dataset.profileId = profile.id;
    const { visual, image, fallbackImage, button: deviceButton } = deviceVisual('neutral', display(profile.name));
    deviceButton.id = `device-${profile.id}`;
    deviceButton.onclick = () => { if (isSameProfile(profile, currentProfile(profile.id))) openDetails({ kind: 'local', profile: { id: profile.id, revision: profile.revision, api_base_url: profile.api_base_url } }, deviceButton); };
    const article = make('article', '', 'ui-surface-card device-card');
    const heading = make('div', '', 'ui-surface-header');
    const title = make('div', '', 'card-heading');
    const name = make('h3', display(profile.name, '未命名连接'));
    const nameId = `connection-${profile.id}`;
    name.id = nameId; article.setAttribute('aria-labelledby', nameId);
    title.append(name, make('p', display(profile.api_base_url), 'card-address'));
    const status = make('span', '尚未检测', 'ui-tag');
    status.id = `check-state-${profile.id}`; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    heading.append(title, status);
    const body = make('div', '', 'ui-surface-body'); const content = make('div', '', 'card-content');
    const actions = make('div', '', 'card-actions');
    const testButton = iconAction('refresh', `测试连接 ${display(profile.name)}`, () => testConnection(profile.id));
    testButton.id = `test-${profile.id}`; testButton.className += ' test-icon';
    const editButton = iconAction('pencil', `编辑 ${display(profile.name)}`, () => {
      closeMoreMenu(); const current = currentProfile(profile.id); if (current) openEditor(current);
    });
    editButton.id = `edit-${profile.id}`;
    const moreWrap = make('div', '', 'more-actions');
    const menu = make('div', '', 'more-menu'); menu.id = `menu-${profile.id}`; menu.hidden = true; menu.setAttribute('role', 'menu');
    const deleteButton = action('删除连接', () => { closeMoreMenu(true); return deleteProfile(profile.id); });
    deleteButton.id = `delete-${profile.id}`; deleteButton.dataset.danger = 'true'; deleteButton.setAttribute('role', 'menuitem');
    deleteButton.setAttribute('aria-label', `删除 ${display(profile.name)}`); menu.append(deleteButton);
    let menuView;
    const moreButton = iconAction('more', `更多操作 ${display(profile.name)}`, () => toggleMoreMenu(menuView));
    moreButton.id = `more-${profile.id}`; moreButton.setAttribute('aria-haspopup', 'menu');
    moreButton.setAttribute('aria-controls', menu.id); moreButton.setAttribute('aria-expanded', 'false');
    menuView = { menu, more: moreButton, remove: deleteButton, wrapper: moreWrap };
    moreButton.onkeydown = event => { if (event.key === 'ArrowDown') { event.preventDefault(); toggleMoreMenu(menuView, true); } };
    const infoButton = iconAction('info', `查看详情 ${display(profile.name)}`, () => {
      if (isSameProfile(profile, currentProfile(profile.id))) openDetails({ kind: 'local', profile: { id: profile.id, revision: profile.revision, api_base_url: profile.api_base_url } }, infoButton);
    });
    infoButton.id = `info-${profile.id}`; infoButton.className += ' info-button';
    moreWrap.append(moreButton, menu); actions.append(infoButton, testButton, editButton, moreWrap);
    body.append(content, actions); article.append(heading, body); item.append(visual, article);
    return { node: item, status, content, testButton, editButton, deleteButton, moreButton, infoButton, deviceButton, image, fallbackImage, alias: display(profile.name) };
  }
  function localFacts(device = {}) {
    const facts = make('dl', '', 'device-facts local-facts');
    fact(facts, '设备规模', Number.isSafeInteger(device.max_scale) && device.max_scale > 0 ? String(device.max_scale) : '未知');
    fact(facts, '声明精度', display(device.max_precision));
    return facts;
  }
  function renderCard(id) {
    const view = cardViews.get(id);
    if (!view) return;
    const state = checks.get(id);
    const waiting = pendingChecks.some(job => job.profile.id === id);
    syncDetails('local', id);
    view.infoButton.disabled = !active;
    view.deviceButton.disabled = !active || deleting.has(id);
    view.testButton.disabled = !active || deleting.has(id) || waiting || state?.phase === 'loading';
    view.editButton.disabled = !active || deleting.has(id);
    view.deleteButton.disabled = !active || deleting.has(id) || savingProfiles.has(id);
    view.deleteButton.setAttribute('title', savingProfiles.has(id) ? '正在保存该连接，收到回执后可删除。' : '');
    view.deleteButton.textContent = deleting.has(id) ? '正在删除…' : '删除连接';
    view.moreButton.disabled = !active || deleting.has(id);
    const testLabel = state?.phase === 'loading' ? '检测中' : waiting ? '等待检测' : state ? '重新测试' : '测试连接';
    view.testButton.setAttribute('aria-label', `${testLabel} ${view.alias}`); view.testButton.setAttribute('title', testLabel);
    view.testButton.dataset.loading = String(state?.phase === 'loading');
    const artTone = state?.phase === 'error' ? 'failed' : state?.phase === 'complete' ? ({ success: 'success', partial: 'partial', failed: 'failed' }[state.result.outcome] || 'neutral') : 'neutral';
    view.image.setAttribute('src', deviceArt[artTone].frontPath);
    view.fallbackImage.setAttribute('src', deviceArt[artTone].path);
    view.testButton.setAttribute('aria-busy', String(state?.phase === 'loading'));
    view.status.dataset.tone = 'neutral';
    view.content.replaceChildren();
    if (!state) {
      view.status.textContent = waiting ? '等待检测' : '尚未检测';
      view.content.append(localFacts(), make('p', waiting ? (pageSuspended ? '页面可见后继续读取设备信息。' : '等待读取设备信息…') : '已保存，求解前检查连接与设备状态。', 'card-idle'));
      return;
    }
    if (state.phase === 'loading') {
      view.status.textContent = '正在检测';
      view.content.append(localFacts(), make('p', '正在从 Toolkit 运行位置读取设备信息…', 'card-idle'));
      return;
    }
    if (state.phase === 'error') {
      view.status.textContent = '未取得检测结果'; view.status.dataset.tone = 'danger';
      const issue = make('p', state.error, 'card-message'); issue.dataset.tone = 'danger'; view.content.append(issue);
      return;
    }
    const result = state.result;
    const tones = { success: 'success', partial: 'warning', failed: 'danger' };
    const labels = { success: '信息读取完整', partial: '部分信息可用', failed: '检测失败' };
    view.status.textContent = labels[result.outcome]; view.status.dataset.tone = tones[result.outcome];
    const device = result.device || {};
    const issues = Array.isArray(result.issues) ? result.issues : [];
    const hasKnownDevice = ['name', 'version', 'max_scale', 'max_precision', 'status', 'boot_timestamp'].some(field => display(device[field], '') !== '');
    const source = result.observation?.source === 'toolkit_host' ? 'Toolkit 运行位置' : '来源未知';
    const failedWithoutInfo = result.outcome === 'failed' && !hasKnownDevice;
    if (!failedWithoutInfo) {
      view.content.append(localFacts(device));
    }
    if (issues.length || failedWithoutInfo) {
      const first = make('p', display(issues[0]?.message, '未取得设备信息，请重试。'), 'card-message');
      first.dataset.tone = tones[result.outcome]; view.content.append(first);
    }
    // Empty failures stay compact without hiding a meaningful timestamp. Other
    // cards show a short check time with the complete value in the readonly dialog.
    view.content.append(make('p', `本次检测：${timestamp(result.checked_at, !failedWithoutInfo)} · ${source}`, 'check-meta'));
  }

  async function loadProfiles() {
    if (!active) return;
    const sequence = ++profilesSequence;
    profilesLoading = true;
    byId('local-state').textContent = '正在读取已保存连接…'; byId('local-state').hidden = false; byId('local-state').dataset.tone = 'neutral';
    byId('local-refresh').disabled = true; byId('empty').hidden = true;
    try {
      const result = await api('/api/profiles');
      if (!active || sequence !== profilesSequence) return;
      if (!Array.isArray(result.profiles)) throw new Error('连接列表格式无效，请手动刷新。');
      profilesLoading = false; setProfiles(result.profiles); byId('local-state').hidden = true;
      scheduleProfileChecks();
    } catch (error) {
      if (!active || sequence !== profilesSequence) return;
      profilesLoading = false;
      byId('local-state').textContent = `读取连接失败：${error.message} 可点击“刷新列表”重试，或继续添加连接。`;
      byId('local-state').dataset.tone = 'danger';
    } finally { if (active && sequence === profilesSequence) byId('local-refresh').disabled = false; }
  }
  function checkKey(profile) { return JSON.stringify([profile.id, profile.revision, profile.api_base_url]); }
  function clearPendingChecks() {
    const previous = pendingChecks; pendingChecks = [];
    for (const job of previous) job.resolve();
  }
  function scheduleProfileChecks() {
    checkRound++; clearPendingChecks();
    for (const profile of profiles) enqueueCheck(profile.id, true);
    pumpChecks();
  }
  function enqueueCheck(id, automatic = false) {
    const profile = currentProfile(id);
    if (!active || !profile || deleting.has(id)) return Promise.resolve();
    const basis = { id: profile.id, revision: profile.revision, api_base_url: profile.api_base_url };
    const key = checkKey(basis);
    if (runningChecks.has(key)) return runningChecks.get(key).promise;
    const queued = pendingChecks.find(job => job.key === key);
    if (queued) return queued.promise;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const job = { key, profile: basis, automatic, round: checkRound, promise, resolve };
    abortCheck(id);
    if (automatic) pendingChecks.push(job); else pendingChecks.unshift(job);
    renderCard(id); pumpChecks(); return promise;
  }
  function pumpChecks() {
    if (!active || pageSuspended || document.visibilityState !== 'visible') return;
    while (checksInFlight < 2 && pendingChecks.length) {
      const job = pendingChecks.shift();
      if (!isSameProfile(job.profile, currentProfile(job.profile.id)) || deleting.has(job.profile.id) || (job.automatic && (job.round !== checkRound || savingProfiles.has(job.profile.id)))) { job.resolve(); renderCard(job.profile.id); continue; }
      checksInFlight++; runningChecks.set(job.key, job);
      performConnectionCheck(job).finally(() => {
        checksInFlight--; runningChecks.delete(job.key); job.resolve(); pumpChecks();
      });
    }
  }
  function testConnection(id) { return enqueueCheck(id); }
  async function performConnectionCheck(job) {
    const id = job.profile.id;
    const profile = currentProfile(id);
    if (!active || !isSameProfile(job.profile, profile) || deleting.has(id) || (job.automatic && savingProfiles.has(id))) return;
    abortCheck(id);
    const sequence = ++checkSequence;
    const controller = new AbortController();
    const basis = { id: profile.id, revision: profile.revision, api_base_url: profile.api_base_url };
    const state = { profile: basis, sequence, controller, phase: 'loading' };
    checks.set(id, state); renderCard(id);
    const isCurrent = () => active && checks.get(id)?.sequence === sequence && isSameProfile(basis, currentProfile(id)) && !deleting.has(id);
    try {
      const result = await api(`/api/profiles/${encodeURIComponent(id)}/test`, 'POST', { revision: profile.revision }, controller.signal);
      if (!isCurrent()) return;
      if (result.profile_id !== id || result.profile_revision !== profile.revision || !['success', 'partial', 'failed'].includes(result.outcome)) throw new Error('检测回执与当前连接不一致，请重新测试。');
      state.phase = 'complete'; state.result = result; renderCard(id);
    } catch (error) {
      if (!isCurrent() || error.name === 'AbortError') return;
      state.phase = 'error';
      state.error = error.status === 409 ? '连接已被修改，请先刷新连接列表后再测试。'
        : error.status === 404 ? '该连接已不存在，请刷新连接列表。' : `检测未完成：${error.message} 请重试。`;
      renderCard(id);
    }
  }

  function randomId() {
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function duration(milliseconds) {
    return milliseconds >= 60000 ? `${Math.ceil(milliseconds / 60000)}分钟` : `${Math.ceil(milliseconds / 1000)}秒`;
  }
  function applyPolicy(value) {
    if (value?.expiry_policy !== 'idle' || !['idle_timeout_ms', 'foreground_lease_ms', 'heartbeat_ms'].every(key => Number.isSafeInteger(value[key]) && value[key] > 0)) return;
    const changed = policy.heartbeat_ms !== value.heartbeat_ms;
    policy = { idle_timeout_ms: value.idle_timeout_ms, foreground_lease_ms: value.foreground_lease_ms, heartbeat_ms: value.heartbeat_ms };
    if (changed && active && document.visibilityState === 'visible') { clearTimeout(heartbeatTimer); heartbeatTimer = setTimeout(heartbeat, policy.heartbeat_ms); }
  }
  function backupState(draft) {
    if (draft?.deleted) return 'deleted';
    if (!draft?.ackGeneration) return 'unconfirmed';
    const expiry = typeof draft.ackExpiresAt === 'string' ? Date.parse(draft.ackExpiresAt) : NaN;
    if (!Number.isFinite(expiry)) return 'unverified';
    return expiry <= Date.now() ? 'expired' : 'valid';
  }
  function draftConfidence() {
    if (!currentDraft?.dirty) return '重新打开后可核对本机已有草稿。';
    const state = backupState(currentDraft);
    if (state === 'expired') return '先前备份已过保留期，不能保证恢复；当前输入仍保留，请重新备份后再关闭。';
    if (state === 'deleted') return '草稿已清理，当前输入尚未确认备份；继续编辑或明确重试可保存为新草稿。';
    if (state === 'unverified') return '备份保留期未核实，不能保证恢复；请保留当前输入并重新核对。';
    if (state === 'valid' && currentDraft.ackGeneration >= currentDraft.generation && !currentDraft.error) return '当前编辑已在本机确认备份且仍在已知保留期内；重新打开后仍需核对草稿。';
    if (state === 'valid') return '仅较早编辑仍在已知保留期内，最新输入尚未确认；请保留当前输入。';
    return '当前输入尚未确认备份，请保留此页中的输入。';
  }
  function sessionNote(error) {
    renderDraftStatus();
    if (error) { message('session-status', '本机管理服务未响应，可能已闲置回收或连接断开。请从 Toolkit 重新打开，此页面不会自行重启服务。' + draftConfidence(), true); return; }
    const visible = document.visibilityState === 'visible';
    message('session-status', visible
      ? `操作时自动续用，无操作后闲置${duration(policy.idle_timeout_ms)}结束。`
      : `页面暂停续用，闲置${duration(policy.idle_timeout_ms)}后结束。`, false);
  }
  async function activity(visible, keepalive = false, interactive = false) {
    if (!active) return;
    const sequence = ++activitySequence;
    try {
      const result = await api('/api/activity', 'POST', { page_id: pageId, sequence, visible, interactive }, undefined, { keepalive });
      if (!active || sequence !== activitySequence) return;
      applyPolicy(result.session); leaseHealthy = true; sessionNote(); return true;
    } catch (error) {
      if (!active || sequence !== activitySequence || error.code === 'activity_stale') return;
      leaseHealthy = false; sessionNote(error);
    }
  }
  async function inspectSession() {
    if (!active) return;
    const sequence = ++sessionSequence; const activityBasis = activitySequence;
    try {
      const result = await api('/api/session');
      if (!active || sequence !== sessionSequence) return;
      applyPolicy(result.session || result);
      if (leaseHealthy) sessionNote();
    } catch (error) { if (active && sequence === sessionSequence && activityBasis === activitySequence) sessionNote(error); }
  }
  async function heartbeat(interactive = false) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
    if (!active || document.visibilityState !== 'visible') return;
    const renewed = await activity(true, false, interactive);
    if (renewed && active && document.visibilityState === 'visible') heartbeatTimer = setTimeout(heartbeat, policy.heartbeat_ms);
  }
  function visibilityChanged() {
    pageSuspended = document.visibilityState !== 'visible';
    clearTimeout(heartbeatTimer);
    if (!active) return;
    if (document.visibilityState === 'visible') { inspectSession(); heartbeat(true); pumpChecks(); }
    else { flushDraft(currentDraft, true); activity(false, true); sessionNote(); }
  }
  function valuesFromForm() {
    return { name: byId('name').value, api_base_url: byId('api').value, web_base_url: byId('web').value, contract_text: byId('contract').value };
  }
  function newDraft(mode, profileId, revision, values, sources = []) {
    const draft = { id: randomId(), generation: 0, ackGeneration: 0, ackExpiresAt: null, deleted: false, lastIssued: 0, inflight: 0, queued: false,
      mode, profile_id: profileId || null, profile_revision: revision || null, values, sources,
      dirty: false, retired: false, error: '', timer: null, afterAckCleanup: [] };
    draftContexts.set(draft.id, draft); return draft;
  }
  function renderDraftStatus() {
    clearTimeout(draftExpiryTimer);
    const draft = currentDraft;
    const state = backupState(draft);
    byId('draft-retry').hidden = !active || !draft?.dirty || !(draft.error || ['expired', 'unverified', 'deleted'].includes(state));
    let text = '未保存编辑将自动备份到本机私有草稿，默认保留24小时、最多10份。';
    let error = false;
    if (draft?.dirty) {
      if (!active || ['expired', 'unverified', 'deleted'].includes(state)) { text = draftConfidence(); error = state !== 'valid' || draft.ackGeneration < draft.generation; }
      else if (draft.error) { text = '草稿未备份：' + draft.error + ' 当前输入仍保留，可重试备份。'; error = true; }
      else if (state === 'valid' && draft.ackGeneration >= draft.generation) text = '草稿已在本机确认备份，仍在已知保留期内；重新打开后需核对，尚未保存为连接。';
      else if (state === 'valid') text = '较早编辑仍在已知保留期内，最新输入尚未确认备份。';
      else text = '正在备份编辑；尚未确认本机保存，请保留当前输入。';
      if (active && state === 'valid') {
        draftExpiryTimer = setTimeout(renderDraftStatus, Math.min(2147483647, Math.max(1, Date.parse(draft.ackExpiresAt) - Date.now() + 1)));
      }
    }
    message('draft-status', text, error);
    reportEditorSafety();
  }
  function reportEditorSafety() {
    if (!active) return;
    const dirty = currentDraft?.dirty === true;
    const state = { dirty, draft_id: dirty ? currentDraft.id : null, generation: dirty ? currentDraft.generation : 0 };
    const key = JSON.stringify(state);
    if (key === lastEditorSafety) return;
    lastEditorSafety = key;
    api('/api/editor', 'POST', { page_id: pageId, sequence: ++editorSafetySequence, ...state }).catch(error => {
      if (active && key === lastEditorSafety && error.code !== 'editor_state_stale') { lastEditorSafety = ''; message('form-notice', '编辑保护尚未确认，请保留当前输入并重试；升级前请先保存或结束原页。', true); }
    });
  }
  function userActivity(event) {
    if (!active || pageSuspended || event?.isTrusted !== true || Date.now() - lastInteractionSent < 1000) return;
    lastInteractionSent = Date.now(); heartbeat(true);
  }
  function renewDraftContext(draft) {
    const plans = retireDraft(draft);
    const next = newDraft(draft.mode, draft.profile_id, draft.profile_revision, { ...draft.values });
    next.dirty = draft.dirty; next.afterAckCleanup = plans;
    if (currentDraft === draft) currentDraft = next;
    return next;
  }
  function retryDraft() {
    let draft = currentDraft;
    if (!active || !draft || draft.retired || !draft.dirty) return;
    // A rejected tombstoned id is not silently recreated. A known own expiry or
    // this explicit user retry creates a new editing intention and identity.
    if (['expired', 'deleted'].includes(backupState(draft))) { draft = renewDraftContext(draft); draft.generation = 1; }
    return flushDraft(draft);
  }
  function metadataOf(draft) {
    return { id: draft.id, generation: draft.generation, updated_at: draft.updated_at, expires_at: draft.expires_at,
      mode: draft.mode, profile_id: draft.profile_id, profile_revision: draft.profile_revision, name: draft.values?.name || '' };
  }
  function renderDraftList() {
    const rows = [...draftMetadata.values()].filter(draft => draft.id !== currentDraft?.id && !currentDraft?.sources.some(source => source.id === draft.id && draft.generation <= source.generation));
    byId('draft-recovery').hidden = rows.length === 0 && !draftListError;
    byId('draft-list-status').textContent = draftListError || '仅在本机保存，默认保留24小时。选择恢复或忽略，不会自动写成连接。';
    const nodes = rows.map(draft => {
      const row = make('li', '', 'draft-row');
      const text = make('div'); text.append(make('p', display(draft.name, '未命名连接'), 'draft-row-name'),
        make('p', `${draft.mode === 'edit' ? '编辑连接' : '新增连接'} · ${timestamp(draft.updated_at)}`, 'draft-row-meta'));
      const controls = make('div', '', 'draft-row-actions');
      const restore = action('恢复编辑', () => restoreDraft(draft)); restore.id = `restore-${draft.id}`;
      const ignore = action('忽略', () => ignoreDraft(draft)); ignore.id = `ignore-${draft.id}`;
      restore.disabled = ignore.disabled = !active || ignoredDrafts.has(draft.id);
      controls.append(restore, ignore); row.append(text, controls); return row;
    });
    byId('draft-list').replaceChildren(...nodes);
  }
  async function loadDrafts() {
    if (!active) return;
    const sequence = ++draftListSequence;
    try {
      const result = await api('/api/drafts');
      if (!active || sequence !== draftListSequence) return;
      if (!Array.isArray(result.drafts)) throw new Error('草稿列表格式无效');
      draftMetadata.clear(); for (const draft of result.drafts) draftMetadata.set(draft.id, draft);
      draftListError = ''; renderDraftList();
    } catch (error) {
      if (!active || sequence !== draftListSequence) return;
      draftListError = '无法读取本机草稿，请刷新重试。不会覆盖当前输入。'; renderDraftList();
    }
  }
  async function cleanupPlans(plans) {
    const failed = [];
    // Send all tombstones immediately: a slow shared-source cleanup must not
    // defer the current draft's cleanup until after this page is frozen/closed.
    await Promise.all(plans.map(async plan => {
      try {
        await api(`/api/drafts/${plan.id}`, 'DELETE', { generation: plan.generation }, undefined, { keepalive: true });
        draftListSequence++;
        if ((draftMetadata.get(plan.id)?.generation || 0) <= plan.generation) draftMetadata.delete(plan.id);
      } catch (_) { failed.push(plan); }
    }));
    if (failed.length) {
      draftListError = '草稿清理未确认；可能已由其他页面更新。请刷新核对后再明确忽略，不会覆盖其他草稿。';
    }
    renderDraftList(); return failed;
  }
  function retireDraft(draft) {
    if (!draft || draft.retired) return [];
    draft.retired = true; clearTimeout(draft.timer); draft.queued = false;
    const plans = [...draft.sources, ...draft.afterAckCleanup];
    if (draft.generation > 0) plans.push({ id: draft.id, generation: Math.max(draft.generation, draft.lastIssued) + 1 });
    draftContexts.delete(draft.id); return plans;
  }
  async function flushDraft(draft, urgent = false) {
    if (!active || !draft || draft.retired || !draft.dirty) return;
    const state = backupState(draft);
    if (draft.deleted || (draft.ackGeneration >= draft.generation && ['valid', 'expired'].includes(state))) return;
    clearTimeout(draft.timer);
    if (draft.inflight && (!urgent || draft.lastIssued >= draft.generation)) { draft.queued = true; return; }
    const generation = draft.generation;
    const payload = { id: draft.id, generation, mode: draft.mode, profile_id: draft.profile_id, profile_revision: draft.profile_revision, values: { ...draft.values } };
    draft.inflight++; draft.lastIssued = Math.max(draft.lastIssued, generation); draft.error = '';
    if (currentDraft === draft) renderDraftStatus();
    try {
      const result = await api('/api/drafts', 'POST', payload, undefined, { keepalive: urgent });
      if (!active || draft.retired) return;
      if (result.draft?.id !== draft.id || result.draft.generation !== generation) throw new Error('未取得匹配的备份回执');
      if (generation >= draft.ackGeneration) { draft.ackGeneration = generation; draft.ackExpiresAt = result.draft.expires_at || null; }
      if (generation === draft.generation) draft.error = '';
      const previous = draftMetadata.get(draft.id);
      if (!previous || previous.generation <= generation) { draftListSequence++; draftMetadata.set(draft.id, metadataOf(result.draft)); }
      if (draft.afterAckCleanup.length && backupState(draft) === 'valid') {
        const plans = draft.afterAckCleanup; draft.afterAckCleanup = [];
        draft.sources.push(...await cleanupPlans(plans));
      }
    } catch (error) {
      if (active && !draft.retired && error.code === 'draft_deleted') { draft.deleted = true; draft.queued = false; draft.error = error.message; }
      else if (active && !draft.retired && generation === draft.generation && generation >= draft.ackGeneration) draft.error = error.message;
    } finally {
      draft.inflight--;
      if (currentDraft === draft) renderDraftStatus(); renderDraftList();
      if (active && !draft.retired && draft.queued) { draft.queued = false; flushDraft(draft); }
    }
  }
  function changedDraft() {
    let draft = currentDraft;
    if (!draft || draft.retired || !active) return;
    if (['expired', 'deleted'].includes(backupState(draft))) draft = renewDraftContext(draft);
    draft.values = valuesFromForm(); draft.generation++; draft.dirty = true; draft.error = '';
    clearTimeout(draft.timer); draft.timer = setTimeout(() => flushDraft(draft), 350);
    renderDraftStatus();
  }
  function afterProfileSaved(draft, generation, profile, stillCurrent) {
    if (!draft || draft.retired) return;
    const hasResidual = draft.generation > generation;
    const plans = retireDraft(draft);
    if (hasResidual) {
      const residual = newDraft('edit', profile.id, profile.revision, { ...draft.values });
      residual.generation = 1; residual.dirty = true; residual.afterAckCleanup = plans;
      if (stillCurrent) currentDraft = residual;
      flushDraft(residual);
    } else {
      if (stillCurrent) currentDraft = null;
      cleanupPlans(plans);
    }
    renderDraftStatus(); renderDraftList();
  }
  async function cancelEditing() {
    if (saveBusy) return;
    const draft = currentDraft; const plans = retireDraft(draft);
    currentDraft = null; closeEditor(); renderDraftStatus(); renderDraftList();
    message('notice', '已取消编辑，未保存更改。');
    const failed = await cleanupPlans(plans);
    if (failed.length && active) message('notice', '已取消编辑，但本机草稿清理未确认，请刷新草稿列表后核对。', true);
  }
  async function restoreDraft(metadata) {
    if (!active) return;
    if (currentDraft?.dirty && !byId('editor-panel').hidden) { message('notice', '当前有未保存编辑，请先保存或取消，再恢复草稿。', true); return; }
    draftRestoreId = metadata.id;
    const sequence = ++draftRestoreSequence; const context = editorContext; const generation = editorGeneration;
    try {
      const result = await api(`/api/drafts/${metadata.id}`);
      if (!active || sequence !== draftRestoreSequence || !draftMetadata.has(metadata.id)) return;
      if (context !== editorContext || generation !== editorGeneration) { message('notice', '读取草稿期间已有新编辑，未覆盖当前输入。', true); return; }
      const draft = result.draft;
      if (draft?.id !== metadata.id || !Number.isSafeInteger(draft.generation) || !draft.values) throw new Error('草稿内容不完整，请刷新列表');
      openEditor();
      byId('profile-id').value = draft.profile_id || ''; byId('revision').value = draft.profile_revision ? String(draft.profile_revision) : '';
      byId('name').value = draft.values.name; byId('api').value = draft.values.api_base_url; byId('web').value = draft.values.web_base_url; byId('contract').value = draft.values.contract_text;
      byId('editor-title').textContent = draft.mode === 'edit' ? '恢复编辑连接' : '恢复新增连接';
      draftContexts.delete(currentDraft.id);
      currentDraft = newDraft(draft.mode, draft.profile_id, draft.profile_revision, { ...draft.values }, [{ id: draft.id, generation: draft.generation }]);
      currentDraft.generation = 1; currentDraft.dirty = true; editorGeneration++;
      flushDraft(currentDraft); renderDraftStatus(); renderDraftList();
      message('notice', '草稿已复制到新的编辑中，尚未保存为连接。');
    } catch (error) { if (active) message('notice', '未恢复草稿：' + error.message, true); }
  }
  async function ignoreDraft(metadata) {
    if (!active || ignoredDrafts.has(metadata.id)) return;
    if (draftRestoreId === metadata.id) draftRestoreSequence++;
    ignoredDrafts.add(metadata.id); renderDraftList();
    const own = draftContexts.get(metadata.id);
    const failed = await cleanupPlans(own ? retireDraft(own) : [{ id: metadata.id, generation: metadata.generation }]);
    ignoredDrafts.delete(metadata.id); renderDraftList();
    if (active) message('notice', failed.length ? '草稿未能清理，请刷新核对；未影响其他草稿。' : '已忽略该草稿。', failed.length > 0);
  }

  function clearEditor() {
    byId('editor').reset(); byId('profile-id').value = ''; byId('revision').value = ''; byId('advanced').open = false;
    message('form-notice', '');
  }
  function openEditor(profile) {
    if (!active) return;
    if (currentDraft && !currentDraft.dirty) retireDraft(currentDraft); else flushDraft(currentDraft);
    editorGeneration++; editorContext++; clearEditor();
    byId('editor-panel').hidden = false; byId('add').setAttribute('aria-expanded', 'true');
    byId('editor-title').textContent = profile ? '编辑连接' : '添加连接';
    if (profile) {
      byId('profile-id').value = profile.id; byId('revision').value = String(profile.revision);
      byId('name').value = profile.name; byId('api').value = profile.api_base_url; byId('web').value = profile.web_base_url || '';
      byId('contract').value = profile.contract ? JSON.stringify(profile.contract, null, 2) : '';
    }
    currentDraft = newDraft(profile ? 'edit' : 'add', profile?.id, profile?.revision, valuesFromForm());
    renderDraftStatus(); renderDraftList();
    byId('name').focus();
  }
  function closeEditor() {
    if (saveBusy) return;
    editorGeneration++; editorContext++; clearEditor(); byId('editor-panel').hidden = true; byId('add').setAttribute('aria-expanded', 'false');
    byId('add').focus();
  }
  async function saveProfile(event) {
    event.preventDefault();
    if (!active || saveBusy) return;
    const generation = editorGeneration;
    const context = editorContext;
    const savedDraft = currentDraft; const savedDraftGeneration = savedDraft?.generation || 0;
    const raw = byId('contract').value.trim(); let contract;
    try { if (raw) contract = JSON.parse(raw); }
    catch (_) { byId('advanced').open = true; message('form-notice', '部署规则不是有效 JSON；请修正，或清空后使用标准协议。', true); byId('contract').focus(); return; }
    const value = { name: byId('name').value, api_base_url: byId('api').value, web_base_url: byId('web').value, ...(raw ? { contract } : {}) };
    if (byId('profile-id').value) { value.id = byId('profile-id').value; value.revision = Number(byId('revision').value); }
    if (value.id && deleting.has(value.id)) {
      message('form-notice', '该连接正在删除，请等待删除结果；本次保存尚未发送。', true);
      return;
    }
    // Serialize same-profile writes by request lifetime, not response arrival
    // order: a save can finish on the server before its receipt reaches us.
    // Sending DELETE meanwhile would make that receipt resurrect a removed card.
    if (value.id) { savingProfiles.add(value.id); renderCard(value.id); }
    saveBusy = true; byId('save').disabled = true; byId('cancel').disabled = true; byId('save').textContent = '正在保存…'; message('form-notice', '');
    try {
      const result = await api('/api/profiles', 'POST', value);
      if (!active) return;
      if (!result.profile?.id || !Number.isSafeInteger(result.profile.revision)) throw new Error('保存回执不完整；请刷新连接列表核对后再操作。');
      profilesSequence++; profilesLoading = false; byId('local-state').hidden = true; byId('local-refresh').disabled = false;
      const existing = profiles.findIndex(profile => profile.id === result.profile.id);
      const next = profiles.slice(); if (existing < 0) next.push(result.profile); else next[existing] = result.profile;
      setProfiles(next);
      afterProfileSaved(savedDraft, savedDraftGeneration, result.profile, context === editorContext);
      if (context === editorContext) {
        // A user may keep typing while save is in flight. Preserve those values
        // but advance their identity/revision so the next save updates this
        // connection instead of duplicating it or failing a stale revision.
        byId('profile-id').value = result.profile.id;
        byId('revision').value = String(result.profile.revision);
        byId('editor-title').textContent = '编辑连接';
        if (generation === editorGeneration) { saveBusy = false; closeEditor(); }
      }
      message('notice', '连接已保存。尚未检查设备可用性，也未创建任务。');
    } catch (error) { if (active) message('form-notice', error.message, true); }
    finally {
      if (value.id) { savingProfiles.delete(value.id); renderCard(value.id); }
      saveBusy = false; if (active) { byId('save').disabled = false; byId('cancel').disabled = false; byId('save').textContent = '保存连接'; }
    }
  }
  async function deleteProfile(id) {
    const profile = currentProfile(id);
    if (!active || !profile || deleting.has(id) || savingProfiles.has(id)) return;
    if (!confirm(`删除连接“${profile.name}”？历史任务记录与设备端任务不会删除。`)) return;
    deleting.add(id); abortCheck(id); renderCard(id);
    try {
      await api(`/api/profiles/${encodeURIComponent(id)}`, 'DELETE', {});
      if (!active) return;
      profilesSequence++; profilesLoading = false; byId('local-state').hidden = true; byId('local-refresh').disabled = false;
      setProfiles(profiles.filter(current => current.id !== id));
      if (byId('profile-id').value === id && !saveBusy) {
        const plans = retireDraft(currentDraft); currentDraft = null; closeEditor(); cleanupPlans(plans); renderDraftStatus();
      }
      message('notice', '已删除连接。历史任务与远端设备不受影响。');
    } catch (error) { if (active) message('notice', error.message, true); }
    finally { deleting.delete(id); renderCard(id); }
  }

  function cloudEnvironmentLabel() { return internalPreview ? 'SIT · 内部测试' : 'PROD'; }
  function cloudCard(entry) {
    const item = make('li', '', 'device-tile'); const { visual, button: deviceButton } = deviceVisual('cloud', display(entry.name, `机型 ${display(entry.id)}`));
    const article = make('article', '', 'ui-surface-card device-card cloud-card');
    const heading = make('div', '', 'ui-surface-header');
    const title = make('div', '', 'card-heading'); const name = make('h3', display(entry.name, `机型 ${display(entry.id)}`));
    title.append(name);
    const source = make('span', '公开目录', 'ui-tag'); source.dataset.tone = 'info'; heading.append(title, source);
    const body = make('div', '', 'ui-surface-body'); const facts = make('dl', '', 'device-facts cloud-facts');
    fact(facts, '标称规格', display(entry.spinNumber)); fact(facts, '声明精度', '未声明');
    const cap = entry.executionCapabilities;
    const rangeKnown = cap && Number.isSafeInteger(cap.minDimension) && cap.minDimension > 0 && Number.isSafeInteger(cap.maxDimension) && cap.maxDimension >= cap.minDimension;
    fact(facts, '已声明实际支持范围', rangeKnown ? `${cap.minDimension}–${cap.maxDimension} 维` : '未知（目录未声明）', true);
    body.append(facts);
    const environment = cloud.environment; const sequence = cloud.sequence;
    deviceButton.id = `device-cloud-${environment}-${entry.id}`; deviceButton.disabled = !active;
    deviceButton.onclick = () => openDetails({ kind: 'cloud', id: entry.id, environment, sequence }, deviceButton);
    const detailButton = action('查看详情', () => openDetails({ kind: 'cloud', id: entry.id, environment, sequence }, detailButton), 'text');
    detailButton.id = `cloud-details-${environment}-${entry.id}`; detailButton.className = 'card-details-button cloud-details-button';
    detailButton.setAttribute('aria-label', `查看详情 ${display(entry.name, `机型 ${display(entry.id)}`)}`);
    body.append(detailButton); article.append(heading, body); item.append(visual, article); return item;
  }
  function renderCloud() {
    syncDetails('cloud');
    const state = byId('cloud-state'); const list = byId('cloud-list');
    byId('cloud-source').textContent = `公开机型目录 · ${cloudEnvironmentLabel()}`;
    byId('cloud-refresh').disabled = !active || cloud.phase === 'loading';
    byId('cloud-refresh').textContent = cloud.phase === 'loading' ? '读取中…' : '刷新目录';
    list.replaceChildren(); state.hidden = false; state.dataset.tone = 'neutral';
    if (cloud.phase === 'loading') { state.textContent = `正在读取 ${cloudEnvironmentLabel()} 公开机型…`; return; }
    if (cloud.phase === 'error') {
      const limited = cloud.error?.status === 429 || cloud.error?.http_status === 429;
      state.dataset.tone = limited ? 'warning' : 'danger';
      const originalStatus = Number.isInteger(cloud.error?.http_status) && cloud.error.http_status >= 100 && cloud.error.http_status <= 599 ? `（原服务 HTTP ${cloud.error.http_status}）` : '';
      state.textContent = (limited ? `公开目录暂时限流。${Number.isFinite(cloud.error.retry_after_seconds) && cloud.error.retry_after_seconds > 0 ? `请在 ${cloud.error.retry_after_seconds} 秒后手动刷新。` : '请稍后手动刷新。'}` : `目录读取失败：${cloud.error?.message || '请手动刷新重试。'}`) + originalStatus;
      return;
    }
    const entries = cloud.catalog?.computerTypes || [];
    state.textContent = entries.length ? `${entries.length} 个机型 · 更新于 ${timestamp(cloud.checked_at, true)}` : `当前 ${cloudEnvironmentLabel()} 目录暂无机型，可稍后手动刷新。`;
    list.append(...entries.map(cloudCard));
  }
  async function loadCloud() {
    const environment = fixedEnvironment;
    if (!active) return;
    cloud.controller?.abort();
    const sequence = ++cloud.sequence; const controller = new AbortController();
    Object.assign(cloud, { environment, controller, phase: 'loading', catalog: null, error: null, checked_at: null }); renderCloud();
    try {
      const result = await api(`/api/cloud/catalog?environment=${environment}`, 'GET', undefined, controller.signal);
      if (!active || sequence !== cloud.sequence || environment !== cloud.environment) return;
      if (result.environment !== environment || !Array.isArray(result.catalog?.computerTypes)) throw new Error('目录环境或内容与请求不一致，请手动刷新。');
      Object.assign(cloud, { phase: 'complete', catalog: result.catalog, checked_at: result.checked_at }); renderCloud();
    } catch (error) {
      if (!active || sequence !== cloud.sequence || environment !== cloud.environment || error.name === 'AbortError') return;
      Object.assign(cloud, { phase: 'error', catalog: null, error }); renderCloud();
    }
  }

  document.addEventListener('pointerdown', event => { userActivity(event); if (openMore && !openMore.wrapper.contains(event.target)) closeMoreMenu(); });
  document.addEventListener('click', userActivity);
  document.addEventListener('wheel', userActivity, { passive: true });
  document.addEventListener('keydown', event => {
    userActivity(event);
    if (!openMore) return;
    if (event.key === 'Escape') { event.preventDefault(); closeMoreMenu(true); }
    else if (event.key === 'Tab') closeMoreMenu(true);
  });
  byId('add').onclick = () => openEditor();
  byId('cancel').onclick = cancelEditing;
  byId('editor').onsubmit = saveProfile;
  byId('editor').oninput = event => { userActivity(event); editorGeneration++; changedDraft(); };
  byId('draft-refresh').onclick = loadDrafts;
  byId('draft-retry').onclick = retryDraft;
  byId('local-refresh').onclick = loadProfiles;
  byId('cloud-refresh').onclick = () => loadCloud();
  byId('close').append(icon('power'));
  byId('close').onclick = openEndDialog;
  byId('close-confirm').onclick = confirmEndManagement;
  byId('close-cancel').onclick = () => dismissEndDialog();
  byId('close-dialog').oncancel = event => { event.preventDefault(); dismissEndDialog(); };
  byId('details-close').onclick = () => dismissDetails();
  byId('details-dialog').oncancel = event => { event.preventDefault(); dismissDetails(); };
  const dialogPresentation = new MutationObserver(() => {
    if (!active) { dismissDetails(false); dismissEndDialog(false); }
    else renderEndConfidence();
  });
  dialogPresentation.observe(byId('session-status'), { childList: true });
  dialogPresentation.observe(byId('draft-status'), { childList: true });
  window.addEventListener('scroll', () => closeMoreMenu(), { passive: true });
  window.addEventListener('resize', () => closeMoreMenu(), { passive: true });
  if (!active) { endSession('缺少有效本机会话凭证，请从 Toolkit 重新打开管理页。'); return; }
  document.addEventListener('visibilitychange', visibilityChanged);
  window.addEventListener('pageshow', event => { if (event.persisted) visibilityChanged(); });
  window.addEventListener('pagehide', () => { pageSuspended = true; clearTimeout(heartbeatTimer); flushDraft(currentDraft, true); activity(false, true); });
  if (internalPreview) message('preview-note', 'SIT · 内部测试');
  inspectSession();
  if (document.visibilityState === 'visible') heartbeat(true); else activity(false);
  loadDrafts();
  // Independent one-shot reads; neither section waits for the other and no poll
  // timer or device probe is started by loading or saving this page.
  loadProfiles();
  loadCloud();
}
module.exports = `/* local-art:${ART_DIGEST} */\n(${targetConfigClient.toString()})(${JSON.stringify(DEVICE_ART)},${JSON.stringify(ACTION_ICONS)},/* manager-cloud-bootstrap */{"environment":"prod","internal_preview":false});`;
