'use strict';

// Cleanup callbacks are explicit steps: a failed step must not skip the rest.
// Separate flags preserve every thrown value, including undefined and null.
function runWithCleanupSync(work, ...cleanups) {
  let result, primaryError, cleanupError, failed = false, cleanupFailed = false;
  try { result = work(); } catch (error) { failed = true; primaryError = error; }
  for (const cleanup of cleanups) {
    try { cleanup(); } catch (error) { if (!cleanupFailed) { cleanupFailed = true; cleanupError = error; } }
  }
  if (failed) throw primaryError;
  if (cleanupFailed) throw cleanupError;
  return result;
}

async function runWithCleanup(work, ...cleanups) {
  let result, primaryError, cleanupError, failed = false, cleanupFailed = false;
  try { result = await work(); } catch (error) { failed = true; primaryError = error; }
  for (const cleanup of cleanups) {
    try { await cleanup(); } catch (error) { if (!cleanupFailed) { cleanupFailed = true; cleanupError = error; } }
  }
  if (failed) throw primaryError;
  if (cleanupFailed) throw cleanupError;
  return result;
}

module.exports = { runWithCleanupSync, runWithCleanup };
