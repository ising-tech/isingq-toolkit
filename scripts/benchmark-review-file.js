'use strict';
const { runWithCleanupSync, runWithCleanup } = require('../packages/core/src/run-with-cleanup');

// Offline capacity evidence only. Generates the complete upper triangle, not a
// repeated small term. Large input is removed; a receipt and generator reproduce it.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { constants } = require('node:buffer');
const { verifyMathModelFile, verificationCapacityBasis } = require('../packages/core');
const args = process.argv.slice(2), n = Number(args[0] || 4095), receipt = args[1];
if (args.length > 2 || !Number.isSafeInteger(n) || n < 1 || n > 4095 || (receipt && !path.isAbsolute(receipt))) throw Error('用法：node --max-old-space-size=256 scripts/benchmark-review-file.js [1..4095] [回执绝对路径]；仅生成隔离数据，不访问网络或求解器');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-dense-file-')), started = performance.now(), events = [];
const mark = (operation, extra = {}) => { const value = { operation, elapsed_ms: Math.round(performance.now() - started), ...extra }; events.push(value); process.stdout.write(JSON.stringify(value) + '\n'); };
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
runWithCleanup(async () => {
  const ids = Array.from({ length: n }, (_, i) => 'x_' + i), termFile = path.join(root, 'objective.jsonl');
  const heads = ids.map(id => '{"coefficient":-9007199254740991,"variables":["' + id + '","'), tails = ids.map(id => id + '"]}\n');
  const fd = fs.openSync(termFile, 'wx', 0o600), hash = crypto.createHash('sha256'); let chunks = [], bytes = 0, buffered = 0;
  const flush = () => { const buffer = Buffer.from(chunks.join('')); fs.writeFileSync(fd, buffer); hash.update(buffer); bytes += buffer.length; chunks = []; buffered = 0; };
  runWithCleanupSync(() => {
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) { const line = heads[i] + tails[j]; chunks.push(line); buffered += line.length; if (buffered >= 1024 * 1024) flush(); }
      if (i % 1024 === 0) mark('generating', { completed_rows: i, file_bytes_written: bytes });
    }
    if (buffered) flush();
  }, () => {
    fs.closeSync(fd);
  });
  const termHash = hash.digest('hex'), termCount = n * (n + 1) / 2;
  const manifest = { schema_version: 'isingq-review-file-v1', model: { schema_version: 'math-model-v1', id: 'full-dense-capacity',
    variables: ids.map(id => ({ id, domain: 'binary' })), objective: { sense: 'min', expression: { terms_file: { path: 'objective.jsonl', sha256: termHash } } },
    constraints: ids.map((id, i) => ({ id: 'c' + i, expression: { terms: [{ coefficient: 1, variables: [id] }] }, relation: 'le', rhs: 1 })) }, data: {}, baseline: Object.fromEntries(ids.map(id => [id, 0])) };
  const content = JSON.stringify(manifest) + '\n', manifest_path = path.join(root, 'review.json'); fs.writeFileSync(manifest_path, content);
  const assignment = Object.fromEntries(ids.map((id, i) => [id, i === n - 1 ? 1 : 0]));
  mark('input_ready', { variables: n, term_count: termCount, coefficient_file_bytes: bytes, exceeds_single_js_string: bytes > constants.MAX_STRING_LENGTH });
  let ticks = 0; const heartbeat = setInterval(() => { ticks++; mark('verifying', { rss_bytes: process.memoryUsage().rss }); }, 10000);
  const before = performance.now(); let result;
  try { result = await verifyMathModelFile({ manifest_path, content_digest: sha(content) }, { assignment, outputDirectory: root }); }
  finally { clearInterval(heartbeat); }
  assert.equal(result.status, 'feasible'); assert.equal(result.objective.value, -Number.MAX_SAFE_INTEGER);
  assert.equal(result.decision_count,n);assert.ok(result.decisions.length<=40);
  assert.equal(result.file_statistics.objective_terms, termCount); assert.equal(result.constraint_count, n);
  assert.equal(result.baseline.improvement, Number.MAX_SAFE_INTEGER);
  const proofs = ['math-model.js', 'review-file.js', 'review-file-io.js', 'verified-report.js'].map(file => {
    const name = path.resolve(__dirname, '../packages/core/src', file); return { path: name, sha256: sha(fs.readFileSync(name)) }; });
  const out = { status: 'pass', kind: 'offline_full_dense_finite_integer_capacity_not_hardware_execution', variables: n, constraints: n,
    unique_objective_terms: termCount, coefficient_file_bytes: bytes, coefficient_sha256: termHash,
    exceeds_single_js_string: bytes > constants.MAX_STRING_LENGTH, single_string_ceiling: constants.MAX_STRING_LENGTH,
    capacity_basis: verificationCapacityBasis(), effective_capacity: result.capacity, candidate_objective: result.objective.value,
    baseline_objective: result.baseline.objective, improvement: result.baseline.improvement, statistics: result.file_statistics,
    verify_ms: Math.round(performance.now() - before), total_ms: Math.round(performance.now() - started), heartbeat_ticks: ticks,
    peak_rss_bytes: process.resourceUsage().maxRSS * 1024, heap_limit_bytes: require('node:v8').getHeapStatistics().heap_size_limit,
    node: process.version, source_files: proofs, large_fixture_retained: false, network_calls: 0, solver_submissions: 0, events };
  if (receipt) { fs.mkdirSync(path.dirname(receipt), { recursive: true }); fs.writeFileSync(receipt, JSON.stringify(out, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  mark('passed', { verify_ms: out.verify_ms, peak_rss_bytes: out.peak_rss_bytes, objective: out.candidate_objective });
}, () => fs.rmSync(root, { recursive: true, force: true })).catch(error => { process.stderr.write(JSON.stringify({ status: 'failed', code: error.code, message: error.message }) + '\n'); process.exitCode = 1; });
