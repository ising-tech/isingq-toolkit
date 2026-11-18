'use strict';

// Production-shaped channel allocation: each access point interferes with its
// next six neighbours; the critical chain requires adjacent points to differ.
// The graph and direct edge scoring are independent of the math-model evaluator.
function channelAllocation(count = 4095) {
  const bits = Array.from({ length: count }, (_, i) => i % 2);
  const edges = [];
  const terms = [];
  const linear = Array(count).fill(0), pairs = new Map();
  const addPair = (i, j, coefficient) => {
    if (i > j) [i, j] = [j, i];
    const key = `${i},${j}`;
    pairs.set(key, (pairs.get(key) || 0) + coefficient);
  };
  for (let i = 0; i < count; i++) for (let distance = 1; distance <= 6; distance++) {
    const j = (i + distance) % count, weight = (7 * i + 3 * distance) % 5 + 1;
    edges.push({ i, j, weight });
    terms.push({ coefficient: weight, variables: [`x_${i}`] }, { coefficient: weight, variables: [`x_${j}`] },
      { coefficient: -2 * weight, variables: [`x_${i}`, `x_${j}`] });
    linear[i] -= weight; linear[j] -= weight; addPair(i, j, 2 * weight);
  }
  const constraints = Array.from({ length: count - 1 }, (_, i) => ({ id: `critical_${i}`, label: `关键相邻设备${i + 1}与${i + 2}分开`,
    expression: { terms: [{ coefficient: 1, variables: [`x_${i}`] }, { coefficient: 1, variables: [`x_${i + 1}`] }] }, relation: 'eq', rhs: 1 }));
  // Exact penalty for the declared constraints: P * (x_i + x_j - 1)^2.
  const penalty = 100;
  for (let i = 0; i < count - 1; i++) { linear[i] -= penalty; linear[i + 1] -= penalty; addPair(i, i + 1, 2 * penalty); }
  const qubo = { num_bits: count, offset: penalty * (count - 1),
    linear: linear.map((coefficient, index) => ({ index, coefficient })),
    quadratic: [...pairs].map(([key, coefficient]) => { const [i, j] = key.split(',').map(Number); return { i, j, coefficient }; }),
    variables: bits.map((_, index) => ({ index, name: `AP${index + 1}`, meaning: '双信道选择' })) };
  const model = { schema_version: 'math-model-v1', id: 'factory-4095-channel-allocation', label: '车间接入点双信道分配',
    variables: bits.map((_, i) => ({ id: `x_${i}`, domain: 'binary', label: `AP${i + 1}` })),
    objective: { sense: 'max', expression: { terms } }, constraints };
  const score = values => edges.reduce((sum, edge) => sum + (values[edge.i] !== values[edge.j] ? edge.weight : 0), 0);
  const energy = values => -score(values) + penalty * values.slice(0, -1).reduce((sum, value, i) => sum + (value + values[i + 1] - 1) ** 2, 0);
  const baseline = Object.fromEntries(bits.map((value, i) => [`x_${i}`, 1 - value]));
  return { bits, qubo, model, data: {}, baseline, score, energy, edge_count: edges.length,
    total_terms: terms.length + constraints.reduce((sum, constraint) => sum + constraint.expression.terms.length, 0) };
}
module.exports = { channelAllocation };
