'use strict';

const crypto = require('node:crypto');
const { MathModelError, validateMathModel, evaluateMathCandidate, fields, array, identifier, integer, compareEvaluations } = require('./math-model');
const VERIFIED_REPORT_CONTRACT_VERSION = 'isingq-verified-report-v1';
const VERIFIED_REPORT_ARTIFACT_CONTRACT_VERSION = 'isingq-report-artifact-v1';
const REPORT_RENDERER_VERSION = 'isingq-report-markdown-v3';

class VerifiedReportError extends MathModelError {
  constructor(code, path, message) {
    super(code, path, message);
    this.name = 'VerifiedReportError';
  }
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function text(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#!|+\-.]/g, '\\$&').replace(/[\r\n\u2028\u2029]/g, ' ');
}
function caption(record) { return Object.hasOwn(record, 'label') ? `${text(record.label)}（${text(record.id)}）` : text(record.id); }
function table(lines, headers, rows) {
  lines.push(`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`);
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  lines.push('');
}
function renderVariables(lines, result) {
  if (result.variable_diagnostics.length) table(lines, ['变量', '值', '域', '下界', '上界', '域核验'], result.variable_diagnostics.map(row => [caption(row), row.value, row.domain, row.lower, row.upper, row.within_domain ? '通过' : '越界']));
  else lines.push('无决策变量。', '');
}
function visibleSummary(report, model) {
  return { scope: 'provided_candidates', model_label: model.label ?? model.id,
    input_document_sha256: report.input_digests.document_sha256, global_optimality_verified: false,
    counts: { provided: { value: report.selection.provided_count, unit: 'candidate' },
      feasible: { value: report.selection.feasible_count, unit: 'candidate' } },
    objective_sense: report.objective_sense,
    best_candidates: report.ranking.filter(row => row.rank === 1).map(row => {
      const candidate = report.candidates.find(item => item.id === row.id);
      return { id: row.id, objective: { value: candidate.verification.objective_value, unit: 'model_objective_unit_unspecified' },
        recommendation_basis: { rank: row.rank, scope: 'provided_feasible_candidates',
          feasible_candidate_count: report.selection.feasible_count, verification_status: candidate.verification.status,
          objective_breakdown: candidate.verification.objective_breakdown,
          constraint_diagnostics: candidate.verification.constraint_diagnostics,
          assignment_sha256: candidate.assignment_sha256, input_document_sha256: report.input_digests.document_sha256 },
        decisions: candidate.verification.variable_diagnostics,
        baseline_comparison: candidate.baseline_comparison };
    }),
    baseline: report.baseline ? { objective: { value: report.baseline.verification.objective_value, unit: 'model_objective_unit_unspecified' },
      status: report.baseline.verification.status } : null,
  };
}
function renderVisibleSummary(summary) {
  const lines = [`模型/情景：${text(summary.model_label)}`, '', '范围仅为送检候选；不据此认证全部可行方案数量或全局最优。', ''];
  table(lines, ['数量字段', '数值', '单位/范围'], [
    ['送检候选数', summary.counts.provided.value, '个候选'],
    ['其中可行候选数', summary.counts.feasible.value, '个候选（仅送检集合）'],
  ]);
  if (summary.baseline) lines.push(`同模型基线目标值：${summary.baseline.objective.value}（模型目标单位未声明）；基线状态：${summary.baseline.status === 'feasible' ? '可行' : '不可行'}。`, '');
  if (!summary.best_candidates.length) lines.push('送检集合内没有可行候选，不能给出最佳决策。', '');
  for (const candidate of summary.best_candidates) {
    lines.push(`所提供可行候选中的最佳：${text(candidate.id)}`, '');
    table(lines, ['目标字段', '数值', '单位/方向'], [['目标值', candidate.objective.value, `模型目标单位未声明；${summary.objective_sense === 'min' ? '最小化' : '最大化'}`]]);
    if (candidate.baseline_comparison?.status === 'comparable') lines.push(`相对同模型基线的目标改善：${candidate.baseline_comparison.absolute_improvement}（模型目标单位；正值表示改善，仅为模型内预测）。`, '');
    const basis = candidate.recommendation_basis;
    lines.push('推荐依据（仅所声明模型与送检可行候选）：', '',
      `本候选满足所声明模型的变量域与约束；在送检的 ${basis.feasible_candidate_count} 个可行候选中排名 ${basis.rank}。下列目标分项与约束数值由同一次核验产生。`, '');
    renderObjective(lines, basis);
    renderConstraints(lines, basis);
    lines.push('完整决策赋值（变量含义以模型标签为准，包括零值）：', '');
    renderVariables(lines, { variable_diagnostics: candidate.decisions });
  }
  return lines.join('\n');
}
function renderReport(report, model) {
  const lines = [`# ${text(model.label ?? model.id)}：候选核验报告`, '',
    `仅比较所提供的 ${report.selection.provided_count} 个候选；其中可行 ${report.selection.feasible_count} 个，不可行 ${report.selection.infeasible_count} 个。目标方向：${model.objective.sense === 'min' ? '最小化' : '最大化'}。`, '',
    '核验范围是所声明的有限整数数学规格；不证明自然语言需求完整或与 QUBO 等价。基线改善仅为同一模型和数据下的预测。额外解释未核验；本工具未评估业务缺失信息，不能据此将用户已给事实改列为缺项。', '', ''];
  lines.push(`输入绑定（document SHA256）：${report.input_digests.document_sha256}`, '', '## 可直接引用的受检摘要', '', report.visible_summary_markdown, '## 可行候选排名', '');
  if (report.selection.top_k !== null) lines.push(`请求前 ${report.selection.top_k} 个；实际展示 ${report.selection.returned_count} 个，${report.selection.boundary_ties_included ? '已包含截断边界的全部并列候选' : '边界无额外并列候选'}。`, '');
  if (report.ranking.length) table(lines, ['排名', '候选', '目标值'], report.ranking.map(row => [row.rank, text(row.id), row.objective_value]));
  else lines.push('没有可行候选可参与排名。', '');
  if (report.baseline) {
    lines.push('## 基线核验', '', `状态：${report.baseline.verification.status === 'feasible' ? '可行' : '不可行'}；目标值：${report.baseline.verification.objective_value}。`, '');
    renderDiagnostics(lines, report.baseline.verification);
  }
  for (const candidate of report.candidates) {
    const result = candidate.verification;
    lines.push(`## 候选 ${text(candidate.id)}`, '', `核验状态：${result.status === 'feasible' ? '可行' : '不可行'}；目标值：${result.objective_value}。`, '');
    if (candidate.baseline_comparison) {
      const comparison = candidate.baseline_comparison;
      if (comparison.status === 'comparable') {
        const percent = comparison.improvement_percent;
        lines.push(`相对基线的目标改善：${comparison.absolute_improvement}；${percent === null ? '基线目标值非正，不提供通用改善百分比' : `改善百分比（精确分数）：${percent.numerator}/${percent.denominator}%`}。`, '');
      } else lines.push('基线或本候选不可行，不能计算改善。', '');
    }
    renderDiagnostics(lines, result);
  }
  lines.push('约束“取等”仅表示 lhs = rhs；余量与取等状态只描述本候选的数值状态，不推导放宽约束后的目标变化。', '');
  return lines.join('\n');
}
function renderObjective(lines, result) {
  lines.push('目标分项：', '', `常数项：${result.objective_breakdown.constant}。`, '');
  if (result.objective_breakdown.terms.length) table(lines, ['项', '系数', '变量', '变量值', '分项值'], result.objective_breakdown.terms.map(term => [term.index + 1, term.coefficient, term.variables.map(text).join(' × '), term.variable_values.join(' × '), term.value]));
}
function renderConstraints(lines, result) {
  lines.push('约束核验：', '');
  if (result.constraint_diagnostics.length) table(lines, ['约束', 'lhs', '关系', 'rhs', '余量', '取等', '违反量'], result.constraint_diagnostics.map(row => [caption(row), row.lhs, { le: '≤', ge: '≥', eq: '=' }[row.relation], row.rhs, row.slack, row.active ? '是' : '否', row.violation]));
  else lines.push('未声明约束。', '');
}
function renderDiagnostics(lines, result) {
  renderObjective(lines, result);
  lines.push('变量域核验：', '');
  renderVariables(lines, result);
  renderConstraints(lines, result);
}

function build(document) {
  fields(document, ['report_contract_version', 'model', 'data', 'candidates'], ['baseline', 'top_k'], 'document');
  if (document.report_contract_version !== VERIFIED_REPORT_CONTRACT_VERSION) throw new VerifiedReportError('unsupported', 'document.report_contract_version', `only ${VERIFIED_REPORT_CONTRACT_VERSION} is supported`);
  const { model, data } = document;
  validateMathModel(model, data);
  const topK = Object.hasOwn(document, 'top_k') ? integer(document.top_k, 'document.top_k') : null;
  if (topK !== null && topK <= 0) throw new VerifiedReportError('input_error', 'document.top_k', `expected positive integer, received=${topK}`);
  const ids = new Set();
  const entries = array(document.candidates, 'document.candidates', Number.MAX_SAFE_INTEGER);
  for (const [i, candidate] of entries.entries()) {
    const path = `document.candidates[${i}]`;
    fields(candidate, ['id', 'assignment'], [], path);
    const id = identifier(candidate.id, `${path}.id`);
    if (ids.has(id)) throw new VerifiedReportError('input_error', `${path}.id`, `duplicate candidate=${id}`);
    ids.add(id);
  }
  const modelDataDigest = digest({ model, data });
  const baseline = Object.hasOwn(document, 'baseline') ? {
    assignment_sha256: null,
    model_data_sha256: modelDataDigest,
    verification: evaluateMathCandidate(model, data, document.baseline),
  } : null;
  if (baseline) baseline.assignment_sha256 = digest(document.baseline);
  // Evaluate everything before rendering or exposing any ranking. One unsupported
  // numeric operation aborts the whole document, including out-of-domain plans.
  const candidates = entries.map(candidate => {
    const verification = evaluateMathCandidate(model, data, candidate.assignment);
    return { id: candidate.id, assignment_sha256: digest(candidate.assignment), model_data_sha256: modelDataDigest, verification,
      baseline_comparison: baseline ? compareEvaluations(model.objective.sense, baseline.verification, verification) : null };
  });
  const ordered = candidates.filter(candidate => candidate.verification.status === 'feasible').sort((a, b) => {
    const av = a.verification.objective_value, bv = b.verification.objective_value;
    if (av !== bv) return (av < bv ? -1 : 1) * (model.objective.sense === 'min' ? 1 : -1);
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  let rank = 0;
  const fullRanking = ordered.map((candidate, i) => {
    if (i === 0 || candidate.verification.objective_value !== ordered[i - 1].verification.objective_value) rank = i + 1;
    return { rank, id: candidate.id, objective_value: candidate.verification.objective_value };
  });
  const ranking = topK === null || topK >= fullRanking.length ? fullRanking : fullRanking.filter(row => row.rank <= topK);
  const report = {
    report_contract_version: VERIFIED_REPORT_CONTRACT_VERSION,
    scope: 'provided_candidates',
    evidence_boundary: { contract_version: 'isingq-report-evidence-v1',
      numerical_verification: 'declared_model_data_candidates', natural_language_verified: false,
      additional_claims_verified: false, missing_data_assessment: 'not_performed' },
    model_id: model.id,
    objective_sense: model.objective.sense,
    input_digests: { algorithm: 'sha256', encoding: 'sorted_object_keys_json_v1', model_sha256: digest(model), data_sha256: digest(data), model_data_sha256: modelDataDigest,
      candidates_sha256: digest(entries), baseline_sha256: baseline?.assignment_sha256 ?? null, document_sha256: digest(document) },
    baseline, candidates, ranking,
    selection: { top_k: topK, provided_count: entries.length, feasible_count: ordered.length, infeasible_count: entries.length - ordered.length,
      returned_count: ranking.length, boundary_ties_included: topK !== null && ranking.length > topK },
  };
  report.visible_summary = visibleSummary(report, model);
  report.visible_summary_markdown = renderVisibleSummary(report.visible_summary);
  const markdown = renderReport(report, model);
  return { ...report, report_markdown: markdown, report_artifact: {
    artifact_contract_version: VERIFIED_REPORT_ARTIFACT_CONTRACT_VERSION, renderer_version: REPORT_RENDERER_VERSION,
    visible_summary_sha256: crypto.createHash('sha256').update(report.visible_summary_markdown, 'utf8').digest('hex'),
    encoding: 'utf8', digest_encoding: 'utf8_bytes', content_sha256: crypto.createHash('sha256').update(markdown, 'utf8').digest('hex'),
    size_bytes: Buffer.byteLength(markdown, 'utf8'), input_document_sha256: report.input_digests.document_sha256,
  } };
}
function buildVerifiedReport(document) {
  try { return build(document); }
  catch (error) {
    if (error instanceof VerifiedReportError) throw error;
    if (error instanceof MathModelError) {
      const prefix = `${error.code} at ${error.path}: `;
      throw new VerifiedReportError(error.code, error.path, error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message);
    }
    throw error;
  }
}
function verifyReportArtifact(document, content) {
  if (typeof content !== 'string' && !Buffer.isBuffer(content)) throw new VerifiedReportError('input_error', 'artifact.content', 'expected UTF-8 string or Buffer');
  const report = buildVerifiedReport(document);
  const actual = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const expected = Buffer.from(report.report_markdown, 'utf8');
  if (!actual.equals(expected)) {
    const observed = crypto.createHash('sha256').update(actual).digest('hex');
    throw new VerifiedReportError('report_artifact_mismatch', 'artifact.content', `交付文件与当前输入的确定性报告不一致（expected_sha256=${report.report_artifact.content_sha256}, observed_sha256=${observed}）；停止引用该文件，使用当前输入重新export到新文件名后check，不解析自由文本猜测正确性`);
  }
  return { ...report.report_artifact, input_digests: report.input_digests, match: true,
    scope: 'current_bytes_equal_canonical_report', arbitrary_prose_verified: false };
}
module.exports = { VERIFIED_REPORT_CONTRACT_VERSION, VERIFIED_REPORT_ARTIFACT_CONTRACT_VERSION, VerifiedReportError, buildVerifiedReport, verifyReportArtifact };
