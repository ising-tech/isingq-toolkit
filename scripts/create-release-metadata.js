#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { TARGETS, writeReleaseMetadata } = require('./release-targets');

const root = path.resolve(__dirname, '..');
const files = writeReleaseMetadata(
  path.join(root, 'dist'),
  TARGETS,
  require('../package.json').version,
);
process.stdout.write(`Created release metadata for ${Object.keys(files).length} binaries\n`);
