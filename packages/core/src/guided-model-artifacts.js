'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WorkspaceArtifacts, WorkspaceError } = require('./workspace');
const { assertFileBytes } = require('./file-limits');
const { matrixDocument } = require('./qubo');
const GUIDED_MODEL_ARTIFACT_CONTRACT_VERSION = 'isingq-guided-model-artifacts-v1';
const EXPORT_FAILED = 'model_artifacts_export_failed';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const sourceDigest = plan => digest(JSON.stringify({ qubo: plan.qubo, model_markdown: plan.model_markdown ?? null }));
function artifactError(code, message) { return Object.assign(new Error(message), { code, guided: true }); }
function cell(value) { return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>'); }
// Numeric strings come only from the validated QUBO, never from Agent prose.
function latexMagnitude(value) {
  const [mantissa, exponent] = String(value).toLowerCase().split('e');
  if (exponent === undefined) return mantissa;
  const power = '10^{' + Number(exponent) + '}';
  return mantissa === '1' ? power : mantissa + String.raw` \times ` + power;
}
function latexQubo(qubo, small) {
  const rows = [];
  if (small) {
    const terms = [];
    function add(coefficient, symbols = '') {
      if (coefficient === 0) return;
      const magnitude = Math.abs(coefficient);
      terms.push({negative:coefficient < 0, body:(symbols && magnitude === 1 ? '' : latexMagnitude(magnitude)) + (symbols ? (magnitude === 1 ? '' : ' ') + symbols : '')});
    }
    add(qubo.offset);
    for (const term of qubo.linear) add(term.coefficient, 'x_{' + term.index + '}');
    for (const term of qubo.quadratic) add(term.coefficient, 'x_{' + term.i + '} x_{' + term.j + '}');
    if (!terms.length) terms.push({negative:false,body:'0'});
    for (let start = 0; start < terms.length; start += 3) {
      let line = start === 0 ? 'f(x) &=' : String.raw`&\quad`;
      for (let index = start; index < Math.min(start + 3, terms.length); index++) {
        const term = terms[index];
        line += index === 0 ? (term.negative ? ' - ' : ' ') : term.negative ? ' - ' : ' + ';
        line += term.body;
      }
      rows.push(line);
    }
  } else {
    const offset = (qubo.offset < 0 ? '- ' : '') + latexMagnitude(Math.abs(qubo.offset));
    rows.push('f(x) &= ' + offset + String.raw` + \sum_{(i,a)\in \mathcal{L}} a x_{i}`);
    rows.push(String.raw`&\quad + \sum_{(i,j,b)\in \mathcal{Q}} b x_{i} x_{j}`);
  }
  rows.push(String.raw`x_{i} &\in \{0,1\},\quad 0 \le i < ` + qubo.num_bits);
  return ['$$',String.raw`\begin{aligned}`,...rows.map((row,index)=>row + (index < rows.length - 1 ? String.raw` \\` : '')),String.raw`\end{aligned}`,'$$'];
}
function renderModel(qubo, prose) {
  const provided = typeof prose === 'string' && prose.trim().length > 0;
  const lines = ['# 建模产物', '', '## 业务建模说明', '', provided ? prose : '未提供业务建模说明；当前仅按输入QUBO保存数学表达。未提供的业务目标、约束及变量含义保持未知，不从系数反推业务语义。', '', '## QUBO数学表达', ''];
  const small = qubo.num_bits <= 40 && qubo.linear.length + qubo.quadratic.length <= 40;
  lines.push(...latexQubo(qubo, small), '');
  if (!small) lines.push(String.raw`$\mathcal{L}$、$\mathcal{Q}$逐项对应完整qubo.json中的linear、quadratic；缺省系数为0。完整数值输入保存在模型JSON和矩阵CSV中，不在正文展开数万项。`, '');
  lines.push('## 变量映射', '');
  if (qubo.num_bits <= 40) {
    const variables = new Map(qubo.variables.map(v => [v.index, v]));
    lines.push('| 位索引 | 名称 | 业务含义 |', '| --- | --- | --- |');
    for (let i = 0; i < qubo.num_bits; i++) { const v = variables.get(i); lines.push('| ' + i + ' | ' + cell(v?.name || '$x_{' + i + '}$') + ' | ' + cell(v?.meaning || '未提供业务含义') + ' |'); }
  } else lines.push('共有' + qubo.num_bits + '个二进制变量；已提供' + qubo.variables.length + '项业务映射，完整映射见qubo.json。未提供映射的位只保留$x_{i}$定义，业务含义未知。');
  lines.push('', '## 核对范围', '', '业务说明由Agent提供。程序按同一输入保存QUBO、矩阵和上述数学表达；这不证明自然语言约束完整或业务等价。', '');
  return lines.join('\n');
}
class GuidedModelArtifacts {
  constructor({ root, environment, limits }) { this.workspace = new WorkspaceArtifacts({ root, round: 1, environment }); this.limits = limits; }
  sources(plan) {
    let matrix;
    try { matrix = matrixDocument(plan.qubo, this.limits()); }
    catch (error) { throw artifactError(EXPORT_FAILED, '无法生成“矩阵CSV文件”。' + error.message); }
    const markdown = renderModel(matrix.qubo, plan.model_markdown);
    const base = 'output/' + plan.request_id + '/';
    const files = [
      { label: '模型说明与公式', relative_path: base + 'model.md', content: Buffer.from(markdown) },
      { label: 'QUBO模型文件', relative_path: base + 'qubo.json', content: Buffer.from(JSON.stringify(matrix.qubo)) },
      { label: '矩阵CSV文件', relative_path: base + 'matrix.csv', content: matrix.content },
    ];
    return { markdown, files, qubo:matrix.qubo };
  }
  checkOutputBytes(files) {
    for (const file of files) {
      const target = path.join(this.workspace.roundDirectory, file.relative_path);
      try { assertFileBytes(file.content.length, this.workspace.maxFileBytes, 'localFile', target); }
      catch (error) { throw artifactError(EXPORT_FAILED, '无法导出“' + file.label + '”。' + error.message); }
    }
  }
  metadata(plan, sources) {
    return { version: GUIDED_MODEL_ARTIFACT_CONTRACT_VERSION, math_format:'latex', status: 'writing', source_digest: sourceDigest(plan), markdown: sources.markdown,
      files: sources.files.map(file => ({ label: file.label, relative_path: file.relative_path, sha256: digest(file.content), size_bytes: file.content.length })) };
  }
  export(plan) {
    try {
      const sources = this.sources(plan);
      this.checkOutputBytes(sources.files);
      plan.artifacts = this.metadata(plan, sources);
      this.workspace.init();
      for (const file of sources.files) { plan.artifacts.last_file = file.label; this.workspace.write(file.relative_path, file.content); }
      plan.artifacts.status = 'complete';
    } catch (error) {
      const label = plan.artifacts?.last_file || '建模产物目录';
      const failure = error.guided ? error : artifactError(EXPORT_FAILED, '本机“' + label + '”导出未完成。'
        + (error instanceof WorkspaceError ? error.message + '。'
          : '请核对目录权限和磁盘状态（path=' + this.workspace.roundDirectory + '），保留已有文件后重新准备。'));
      if (plan.artifacts) {
        plan.artifacts.status = 'failed';
        plan.artifacts.last_error = { label, directory: this.workspace.roundDirectory, message: failure.message };
      }
      throw failure;
    }
  }
  verify(plan) {
    if (!plan.artifacts) {
      const sources = this.sources(plan);
      this.checkOutputBytes(sources.files);
      // An older process could write the files before saving their metadata.
      const quboFile = sources.files[1];
      try {
        const content = this.workspace.read(quboFile.relative_path);
        if (!content.equals(quboFile.content) && content.equals(Buffer.from(JSON.stringify(sources.qubo, null, 2) + '\n'))) {
          quboFile.content = content;
        }
      } catch (_) {
        // The normal verification below diagnoses missing or unreadable files.
      }
      plan.artifacts = this.metadata(plan, sources);
    }
    const artifacts = plan.artifacts;
    const expectedPaths = ['model.md','qubo.json','matrix.csv'].map(name=>'output/' + plan.request_id + '/' + name);
    if (artifacts.version !== GUIDED_MODEL_ARTIFACT_CONTRACT_VERSION || artifacts.source_digest !== sourceDigest(plan) || artifacts.files.length !== 3 || artifacts.files.some((file,index)=>file.relative_path !== expectedPaths[index])) {
      artifacts.status = 'invalid';
      throw artifactError('model_artifacts_changed', '本次模型或建模说明与原导出内容不一致；请核对原产物并重新准备，不会自动改写或提交。');
    }
    let markdown;
    for (const file of artifacts.files) {
      const expected = path.join(this.workspace.roundDirectory, file.relative_path);
      try {
        const content = this.workspace.read(file.relative_path);
        if (content.length !== file.size_bytes || digest(content) !== file.sha256) throw Error('mismatch');
        if (file.relative_path.endsWith('/model.md')) markdown = content.toString('utf8');
      } catch (error) {
        if (artifacts.status === 'failed' && artifacts.last_error?.message) throw artifactError(EXPORT_FAILED, artifacts.last_error.message);
        artifacts.status = 'invalid'; artifacts.last_error = { label:file.label, path:expected };
        if (error.code === 'artifact_too_large') {
          throw artifactError('model_artifacts_changed', '本次“' + file.label + '”无法在当前容量下核对。' + error.message);
        }
        throw artifactError('model_artifacts_changed', '本次“' + file.label + '”已改动、缺失或无法安全读取；请通过建模产物文件入口核对，恢复原始产物后刷新，并按新摘要重新确认。不会覆盖、自动修复或提交。');
      }
    }
    artifacts.status = 'complete';
    return { markdown };
  }
  view(plan, {full = true} = {}) {
    let issue, markdown;
    if (plan.issue?.code === EXPORT_FAILED && (!full || !plan.artifacts)) issue = plan.issue;
    if (full && !issue) {
      try { markdown = this.verify(plan).markdown; }
      catch (error) { issue = {code:error.code || 'model_artifacts_changed',message:error.guided ? error.message : '当前建模产物无法核对；请保留文件并刷新，不会自动修复或提交。'}; }
    }
    const artifacts = plan.artifacts;
    let files = [];
    const expectedPaths = ['model.md','qubo.json','matrix.csv'].map(name=>'output/' + plan.request_id + '/' + name);
    if (['complete','invalid'].includes(artifacts?.status) && artifacts.files.length===3 && artifacts.files.every((file,index)=>file.relative_path===expectedPaths[index])) {
      let checking;
      try {
        files = artifacts.files.map(file => {
          checking = file;
          const target = this.workspace.resolve(file.relative_path), metadata = fs.lstatSync(target);
          if (!metadata.isFile()) throw Error('missing');
          if (metadata.size !== file.size_bytes) throw Error('size mismatch');
          return { label: file.label, path: target };
        });
      } catch (_) {
        files = []; artifacts.status='invalid';
        if (checking) artifacts.last_error={label:checking.label,path:path.join(this.workspace.roundDirectory,checking.relative_path)};
        issue ||= {code:'model_artifacts_changed',message:'本次“' + (checking?.label || '建模产物') + '”已改动、缺失或无法安全读取；请恢复原始产物后刷新，并重新确认。不会覆盖或自动提交。'};
      }
    }
    if (artifacts?.status === 'invalid' && !issue) issue={code:'model_artifacts_changed',message:'本次建模产物尚未恢复一致性核对；请恢复后刷新，并重新确认。'};
    if (plan.solve_id && issue) issue={code:issue.code,message:'当前本机建模产物未通过一致性核对，请单独检查或恢复文件；原调用输入与状态仍按原记录查询，不会自动重新提交。'};
    const integrity = issue || files.length !== 3 ? 'failed' : full ? 'current_verified' : 'not_checked';
    return { status:integrity === 'failed' ? 'unavailable' : full ? 'exported' : 'not_checked', integrity, math_format:artifacts?.math_format || 'legacy_text',
      ...(full && integrity === 'current_verified' ? {markdown} : {}), files,
      files_markdown: files.map(file => '- [' + file.label + '](<' + encodeURI(file.path).replace(/[?#]/g, char=>encodeURIComponent(char)) + '>)').join('\n'),
      location:'文件位于Toolkit运行主机的本机目录；远程宿主可打开性未验证。',
      ...(issue ? {issue} : {}),
      note:(integrity === 'failed' ? (plan.solve_id ? '当前文件一致性未通过，未展示其正文；请单独核对本机文件，原调用状态不变。' : '当前文件一致性未通过，未展示其正文；文件入口仅供本机核对，需恢复后刷新并重新确认。') : full ? '本次正文已核对当前文件字节。' : '仅提供文件入口，未重新核对当前文件字节；不代表当前文件与绑定模型一致，提交前仍会核对。') + '业务说明由Agent提供，不证明自然语言约束完整或业务等价。' };

  }
}
module.exports = { GUIDED_MODEL_ARTIFACT_CONTRACT_VERSION, GuidedModelArtifacts };
