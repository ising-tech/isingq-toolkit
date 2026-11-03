'use strict';

const EFFECT_EVIDENCE_CONTRACT_VERSION = 'isingq-effect-evidence-v1';
const EXECUTION_MODES = ['simulation', 'live', 'unknown'];

function executionEvidence(value, { strict = false, field = 'transport.execution_mode' } = {}) {
  if (strict && value !== undefined && !EXECUTION_MODES.includes(value)) {
    throw new Error(`${field} 必须是 simulation、live 或 unknown；请修正受信 Adapter 的执行模式声明，不能按任务 ID 或文本猜测`);
  }
  const mode = EXECUTION_MODES.includes(value) ? value : 'unknown';
  return {
    execution_mode: mode,
    billing: { status: mode === 'simulation' ? 'not_applicable' : 'unverified' },
    source: mode === 'live' ? 'isingq_api' : mode,
  };
}

function normalizeSetupResult(result) {
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('setup result 必须是含执行证据的 object');
  const mode = executionEvidence(result.execution_mode, { strict: true, field: 'setup result.execution_mode' }).execution_mode;
  if (mode === 'unknown') {
    if (result.credential_presence !== undefined && result.credential_presence !== 'not_checked') throw new Error('setup result 执行证据冲突（field=credential_presence）；unknown 结果不能声称已检查凭据存在性');
    return { configured: false, status: 'unknown', execution_mode: 'unknown', credential_effect: 'unknown', remote_verification: 'unverified', no_real_credentials: null, credential_presence: 'not_checked' };
  }
  if (mode === 'live' && !['configured', 'already_configured'].includes(result.status)) {
    throw new Error('setup result.status 必须是 configured 或 already_configured；live 结果必须区分本次保存和当前运行时已有配置');
  }
  const expected = mode === 'simulation'
    ? { configured: false, status: 'simulation', execution_mode: mode, credential_effect: 'not_written', remote_verification: 'not_applicable', no_real_credentials: true, credential_presence: 'not_checked' }
    : { configured: true, status: result.status, execution_mode: mode, credential_effect: result.status === 'configured' ? 'written' : 'already_present', remote_verification: 'unverified', no_real_credentials: false, credential_presence: 'available' };
  for (const [field, value] of Object.entries(expected)) {
    if (result[field] !== value) throw new Error(`setup result 执行证据冲突（field=${field}）；请修正受信 Adapter，不能把模拟输入、未写入或未验证远端的结果声明为真实配置成功`);
  }
  // Return a fixed whitelist. Arbitrary adapter fields, markers and credential
  // material never become public output or an alternative source of authority.
  return expected;
}

module.exports = { EFFECT_EVIDENCE_CONTRACT_VERSION, executionEvidence, normalizeSetupResult };
