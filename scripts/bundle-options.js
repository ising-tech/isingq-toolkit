'use strict';
const path=require('node:path');
const {runtimeIdentity}=require('../packages/core/src/runtime-identity');
function bundleOptions(outfile) {
  const root=path.resolve(__dirname,'..');
  return {absWorkingDir:root,entryPoints:['bin/isingq-mcp.js'],bundle:true,
    platform:'node',format:'cjs',target:'node22',sourcemap:false,outfile,
    define:{__ISINGQ_BUILD_RUNTIME_IDENTITY__:JSON.stringify(runtimeIdentity(root))}};
}
module.exports={bundleOptions};
