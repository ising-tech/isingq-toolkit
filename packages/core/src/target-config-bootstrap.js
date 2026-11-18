'use strict';

const MARKER = '/* manager-cloud-bootstrap */';
const DEFAULT_BOOTSTRAP = '{"environment":"prod","internal_preview":false}';
function invalid(message) { return Object.assign(new Error(message), { code: 'manager_bootstrap_invalid' }); }
function resolveManagerEnvironment(internalPreviewEnvironment) {
  if (internalPreviewEnvironment === undefined || internalPreviewEnvironment === null) return { environment: 'prod', internalPreview: false };
  if (internalPreviewEnvironment === 'sit') return { environment: 'sit', internalPreview: true };
  throw invalid('正常管理页固定PROD；可信内部预览选项仅接受sit，不能从页面参数选择环境');
}
function renderManagerClient({ environment = 'prod', internalPreview = false } = {}, source = require('./target-config/client')) {
  if (!['prod', 'sit'].includes(environment) || typeof internalPreview !== 'boolean' || environment === 'sit' && !internalPreview) throw invalid('管理页bootstrap环境无效；SIT必须显式属于可信内部预览');
  const expected = MARKER + DEFAULT_BOOTSTRAP;
  if (typeof source !== 'string' || source.split(MARKER).length !== 2 || source.split(expected).length !== 2) throw invalid('管理页client bootstrap机器合同缺失、重复或默认片段不匹配；请使用匹配的页面构建，未做文本猜测或静默fallback');
  return source.replace(expected, MARKER + JSON.stringify({ environment, internal_preview: internalPreview }));
}
module.exports = { MARKER, DEFAULT_BOOTSTRAP, resolveManagerEnvironment, renderManagerClient };
