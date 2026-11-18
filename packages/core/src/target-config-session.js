'use strict';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const FOREGROUND_LEASE_MS = 90 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const OPERATION_TIMEOUT_MS = 10000;
const MAX_PAGE_RECORDS = 128;
const PAGE_RETENTION_MS = FOREGROUND_LEASE_MS + HEARTBEAT_MS;
class ManagerSessionError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
class ManagerSession {
  constructor({ idleTimeoutMs = IDLE_TIMEOUT_MS, foregroundLeaseMs = FOREGROUND_LEASE_MS, heartbeatMs = HEARTBEAT_MS,
    operationTimeoutMs = OPERATION_TIMEOUT_MS, maxPageRecords = MAX_PAGE_RECORDS, pageRetentionMs,
    clock = Date.now, onIdle = () => {} } = {}) {
    pageRetentionMs ??= Math.max(foregroundLeaseMs + heartbeatMs, operationTimeoutMs);
    if (![idleTimeoutMs, foregroundLeaseMs, heartbeatMs, operationTimeoutMs, maxPageRecords, pageRetentionMs].every(positive) || heartbeatMs >= foregroundLeaseMs) throw new Error('管理页idle/lease/heartbeat与容量参数无效');
    this.idleTimeoutMs = idleTimeoutMs; this.foregroundLeaseMs = foregroundLeaseMs; this.heartbeatMs = heartbeatMs;
    this.operationTimeoutMs = operationTimeoutMs; this.maxPageRecords = maxPageRecords; this.pageRetentionMs = pageRetentionMs;
    this.clock = clock; this.onIdle = onIdle; this.createdAt = clock(); this.idleSince = this.createdAt;
    this.pages = new Map(); this.pendingOperations = new Set(); this.operations = 0; this.active = true; this.timer = null; this.schedule();
  }
  reconcile(now = this.clock()) {
    let lastExpired = null;
    for (const [id, page] of this.pages) {
      if (page.until !== null && page.until <= now) { lastExpired = Math.max(lastExpired ?? -Infinity, page.until); page.until = null; }
      if (page.until === null && now - page.updatedAt >= this.pageRetentionMs) this.pages.delete(id);
    }
    if (this.operations === 0 && !this.hasForeground() && this.idleSince === null) this.idleSince = lastExpired ?? now;
  }
  hasForeground() { return [...this.pages.values()].some(page => page.until !== null); }
  deadline() { return this.operations > 0 || this.hasForeground() ? null : this.idleSince + this.idleTimeoutMs; }
  isActive() {
    if (!this.active) return false;
    const now = this.clock(); this.reconcile(now); const deadline = this.deadline();
    if (deadline !== null && now >= deadline) { this.close(); this.onIdle(); return false; }
    return true;
  }
  assertActive() { if (!this.isActive()) throw new ManagerSessionError(403, 'config_session_closed', '本机管理页已结束或闲置回收；请重新打开，草稿备份状态需另行核对'); }
  snapshot() {
    this.isActive(); const deadline = this.deadline();
    return { expiry_policy: 'idle', idle_timeout_ms: this.idleTimeoutMs, foreground_lease_ms: this.foregroundLeaseMs,
      heartbeat_ms: this.heartbeatMs, idle_deadline_at: deadline === null ? null : new Date(deadline).toISOString(),
      expires_at: deadline === null ? null : new Date(deadline).toISOString(), foreground_pages: [...this.pages.values()].filter(page => page.until !== null).length,
      operations_in_flight: this.operations, closed: !this.active };
  }
  schedule() {
    clearTimeout(this.timer); if (!this.active) return;
    this.reconcile(); const due = [...this.pages.values()].filter(page => page.until !== null).map(page => page.until);
    const deadline = this.deadline(); if (deadline !== null) due.push(deadline);
    if (!due.length) return;
    this.timer = setTimeout(() => { if (this.isActive()) this.schedule(); }, Math.max(1, Math.min(...due) - this.clock())); this.timer.unref();
  }
  activity(input) {
    this.assertActive();
    if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'interactive,page_id,sequence,visible' || !/^[a-f0-9]{32}$/.test(input.page_id) || !positive(input.sequence) || typeof input.visible !== 'boolean' || typeof input.interactive !== 'boolean' || (!input.visible && input.interactive)) throw new ManagerSessionError(400, 'activity_invalid', '活动仅接受page_id、正整数sequence、visible和interactive布尔值；隐藏页不能声明真实交互');
    const now = this.clock(), previous = this.pages.get(input.page_id);
    if (previous && input.sequence <= previous.sequence) throw new ManagerSessionError(409, 'activity_stale', '已忽略过时页签活动序号，不延长或释放其他前台页租约');
    if (input.interactive && (!previous || previous.until === null) && [...this.pages.values()].filter(page => page.until !== null).length >= this.maxPageRecords) throw new ManagerSessionError(429, 'activity_capacity', '同时有效的前台租约已达上限；请关闭部分前台页后重试，不会挤掉其他有效租约');
    if (!previous && this.pages.size >= this.maxPageRecords * 5) throw new ManagerSessionError(429, 'activity_history_capacity', '短期页签序号保护容量已满；请在租约与重试保护窗口后重试，不会为此延长闲置期');
    const until = !input.visible ? null : input.interactive ? now + this.foregroundLeaseMs : previous?.until ?? null;
    this.pages.set(input.page_id, { sequence: input.sequence, until, updatedAt: now });
    if (input.interactive) this.idleSince = null;
    else if (!this.hasForeground() && this.operations === 0 && this.idleSince === null) this.idleSince = now;
    this.schedule(); return { session: this.snapshot() };
  }
  beginOperation() {
    this.assertActive(); this.operations++; this.idleSince = null; this.schedule(); let ended = false;
    return () => { if (ended) return; ended = true; this.reconcile(); this.operations--; if (this.operations === 0 && !this.hasForeground()) this.idleSince = this.clock(); this.schedule(); };
  }
  async operation(work) {
    const end = this.beginOperation(); let timer, cancel;
    const cancelled = new Promise((_, reject) => { cancel = () => reject(new ManagerSessionError(403, 'config_session_closed', '本机会话已结束，本次操作回执不可再用于当前会话')); }); this.pendingOperations.add(cancel);
    try {
      return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => { timer = setTimeout(() => reject(new ManagerSessionError(504, 'manager_operation_timeout', '本次管理操作未在有界期限内完成；请重新核对结果，不能据此声称已备份或已保存')), this.operationTimeoutMs); }), cancelled]);
    } finally { clearTimeout(timer); this.pendingOperations.delete(cancel); end(); }
  }
  close() { if (!this.active) return; this.active = false; clearTimeout(this.timer); this.pages.clear(); for (const cancel of this.pendingOperations) cancel(); }
}
module.exports = { ManagerSession, ManagerSessionError, IDLE_TIMEOUT_MS, FOREGROUND_LEASE_MS, HEARTBEAT_MS, OPERATION_TIMEOUT_MS, MAX_PAGE_RECORDS, PAGE_RETENTION_MS };
