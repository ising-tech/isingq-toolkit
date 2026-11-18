# @ising-tech/isingq-core

Node.js SDK for integration developers, providing QUBO modeling guidance, validation, matrix export, objective evaluation, variable decoding, and cloud or private-network local solver integration. MCP, DSH, and the expert CLI share this package.

[简体中文](README.md) · English

Agent users can use [MCP](https://www.npmjs.com/package/@ising-tech/isingq-mcp) or the [DSH Plugin](https://www.npmjs.com/package/@ising-tech/isingq-dsh-plugin) directly.

## Install

Requires Node.js **18.17+**. This guide covers **0.9.x**; install only versions actually published on npm.

```bash
npm install @ising-tech/isingq-core
```

## Minimal example

Use CommonJS to validate a QUBO and evaluate a given bitstring locally, without network access or an API Key:

```js
const { validateQubo, objectiveEnergy } = require('@ising-tech/isingq-core');
const { qubo, summary } = validateQubo({
  num_bits: 2,
  linear: [{ index: 0, coefficient: -1 }],
});
console.log(summary.num_bits);            // 2
console.log(objectiveEnergy(qubo, [1, 0])); // -1
```

## Common APIs

| API | Purpose |
| --- | --- |
| `modelingGuide(problemSummary)` | Get QUBO modeling steps and constraint handling guidance |
| `validateQubo(input)` | Validate and normalize a QUBO, returning the model and summary |
| `matrixDocument(input)` | Generate CSV matrix content and its digest |
| `modelDigest(input)` | Generate a full model digest including coefficients, the constant offset, and variable mappings |
| `objectiveEnergy(qubo, bits)` | Evaluate the QUBO objective for a bitstring, including the constant offset |
| `decodeBits(qubo, bits)` | Decode a bitstring using the model's variable mapping |
| `SolverService` | Manage local connections and solve targets, with preparation, submission, and task queries |

The caller constructs the business model and obtains user confirmation. Cloud submission requires a personal API Key and an explicit payment selection; local solving does not require a cloud API Key.

## Documentation

[API and data contracts](API.md) · [Full model digest specification](MODEL-DIGEST.md) · [Solver target integration](https://github.com/ising-tech/isingq-toolkit/blob/main/docs/solver-targets.md) · [Guided solve flow](https://github.com/ising-tech/isingq-toolkit/blob/main/docs/guided-solve.md) · [Apache-2.0](LICENSE)
