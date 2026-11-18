'use strict';

// Kept byte-identical in the expert loader so identity is checked before
// requiring candidate code. Scope: package/core manifests and core/src only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function runtimeIdentity(packageRoot) {
  const root = fs.realpathSync(packageRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  if (!['@ising-tech/isingq-mcp','@ising-tech/isingq-core'].includes(manifest.name)) throw Error('runtime package name');
  const coreRoot = manifest.name === '@ising-tech/isingq-core' ? root : path.join(root,'packages/core');
  const coreManifest = JSON.parse(fs.readFileSync(path.join(coreRoot,'package.json'),'utf8'));
  if (coreManifest.name !== '@ising-tech/isingq-core') throw Error('core package name');
  const src = path.join(coreRoot,'src'), files = [];
  if (fs.realpathSync(src) !== src) throw Error('redirected core src');
  function walk(directory) {
    for (const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = path.join(directory,entry.name);
      if (entry.isSymbolicLink()) throw Error('symlink inside core src');
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  walk(src);
  const hash = crypto.createHash('sha256');
  hash.update('isingq-runtime-code-v1\0');
  for (const file of [path.join(root,'package.json'),path.join(coreRoot,'package.json'),...files]) {
    const content = fs.readFileSync(file);
    hash.update(JSON.stringify([path.relative(root,file).split(path.sep).join('/'),content.length]));
    hash.update('\0'); hash.update(content); hash.update('\0');
  }
  return {package_version:manifest.version,core_version:coreManifest.version,
    artifact_sha256:hash.digest('hex'),artifact_digest_version:'isingq-runtime-code-v1'};
}
module.exports = {runtimeIdentity};
