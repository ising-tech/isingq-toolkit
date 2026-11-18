'use strict';
const fs = require('node:fs');
// Only the inode observed through the owned descriptor may be removed. Missing
// identity is deliberately conservative: a pathname alone does not prove ownership.
function unlinkOwnedFileSync(file, identity) {
  if (!identity) return false;
  try {
    const current = fs.lstatSync(file);
    if (current.dev !== identity.dev || current.ino !== identity.ino) return false;
    fs.unlinkSync(file); return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
module.exports = { unlinkOwnedFileSync };
