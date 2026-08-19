'use strict';

const { matrixDocument } = require('../src/qubo');

const NUM_JOBS = 1920;
const NUM_CONFLICTS = 7680;
const SEED = 20260818;

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function buildDemo() {
  const random = randomGenerator(SEED);
  const conflicts = [];
  const pairs = new Set();

  function addConflict(left, right, weight) {
    const i = Math.min(left, right);
    const j = Math.max(left, right);
    const key = `${i}:${j}`;
    if (i === j || pairs.has(key)) return false;
    pairs.add(key);
    conflicts.push({ i, j, weight });
    return true;
  }

  for (let i = 0; i < NUM_JOBS; i += 1) {
    addConflict(i, (i + 1) % NUM_JOBS, 3 + Math.floor(random() * 7));
  }
  while (conflicts.length < NUM_CONFLICTS) {
    const i = Math.floor(random() * NUM_JOBS);
    const j = Math.floor(random() * NUM_JOBS);
    addConflict(i, j, 1 + Math.floor(random() * 9));
  }

  const linear = Array(NUM_JOBS).fill(0);
  const quadratic = [];
  let totalConflictWeight = 0;
  for (const { i, j, weight } of conflicts) {
    linear[i] -= weight;
    linear[j] -= weight;
    quadratic.push({ i, j, coefficient: 2 * weight });
    totalConflictWeight += weight;
  }

  const qubo = {
    num_bits: NUM_JOBS,
    linear: linear.map((coefficient, index) => ({ index, coefficient })),
    quadratic,
    offset: 0,
    variables: linear.map((_, index) => ({
      index,
      name: `order_${String(index + 1).padStart(4, '0')}`,
      meaning: '0=拣货波次 A，1=拣货波次 B',
    })),
  };

  return {
    qubo,
    conflicts,
    metadata: {
      scenario: '仓库拣货订单双波次分流',
      num_orders: NUM_JOBS,
      num_conflicts: NUM_CONFLICTS,
      total_conflict_weight: totalConflictWeight,
      seed: SEED,
    },
  };
}

function summarizeResult(demo, bits) {
  let separatedWeight = 0;
  for (const { i, j, weight } of demo.conflicts) {
    if (bits[i] !== bits[j]) separatedWeight += weight;
  }
  const windowB = bits.reduce((sum, bit) => sum + bit, 0);
  return {
    wave_a_orders: bits.length - windowB,
    wave_b_orders: windowB,
    separated_conflict_weight: separatedWeight,
    residual_same_window_weight: demo.metadata.total_conflict_weight - separatedWeight,
    separated_ratio: separatedWeight / demo.metadata.total_conflict_weight,
  };
}

if (require.main === module) {
  const demo = buildDemo();
  const matrix = matrixDocument(demo.qubo);
  process.stdout.write(`${JSON.stringify({
    ...demo.metadata,
    ...matrix.summary,
    matrix_size_bytes: matrix.size_bytes,
    matrix_sha256: matrix.sha256,
  }, null, 2)}\n`);
}

module.exports = { buildDemo, summarizeResult };
