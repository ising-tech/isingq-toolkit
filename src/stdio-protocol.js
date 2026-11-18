'use strict';

const { TextDecoder } = require('node:util');
const { fileLimit } = require('../packages/core/src/file-limits');

function protocolError(code, message) { return { code, message }; }

// Inline MCP messages share the local-file byte policy (128 MiB by default,
// with its existing environment override). Large review-file artifacts use
// their dedicated file entry point; their separate budget does not enlarge stdin.
async function* readFrames(input, maxLineBytes = fileLimit('localFile')) {
  let parts = [], bytes = 0, oversized = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  function finish() {
    let frame;
    if (oversized) frame = { error: protocolError(-32600, `MCP 输入行超过容量上限（max_bytes=${maxLineBytes}）；请通过文件入口传递大内容，或按本地文件容量策略调整 ISINGQ_MAX_LOCAL_FILE_BYTES 后重启。`) };
    else {
      try { frame = { line: decoder.decode(Buffer.concat(parts, bytes)) }; }
      catch { frame = { error: protocolError(-32700, 'MCP 输入不是有效 UTF-8；请按 UTF-8 编码重发该消息。') }; }
    }
    parts = []; bytes = 0; oversized = false;
    return frame;
  }
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      if (!oversized) {
        const count = end - start;
        if (count > maxLineBytes - bytes) { oversized = true; parts = []; bytes = 0; }
        else if (count) { parts.push(chunk.subarray(start, end)); bytes += count; }
      }
      if (newline === -1) break;
      yield finish();
      start = newline + 1;
    }
  }
  if (bytes || oversized) yield finish();
}

function validateRequest(request) {
  const object = request !== null && typeof request === 'object' && !Array.isArray(request);
  const validEnvelope = object && request.jsonrpc === '2.0' && typeof request.method === 'string' && request.method.length > 0;
  const hasId = object && Object.hasOwn(request, 'id');
  const validId = hasId && (typeof request.id === 'string' || Number.isInteger(request.id));
  const notification = validEnvelope && !hasId;
  const validParams = object && (!Object.hasOwn(request, 'params') || (request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)));
  return {
    notification,
    id: validId ? request.id : null,
    error: validEnvelope && (!hasId || validId) && validParams ? null
      : protocolError(-32600, '无效 MCP 请求；请使用 jsonrpc="2.0"、非空字符串 method、非 null 的字符串/整数 id（通知省略 id）与对象 params。'),
  };
}

async function writeMessage(output, message) {
  // Await the write callback even when write() returns true. There is at most
  // one pending response, so a slow Host applies pressure all the way to stdin.
  await new Promise((resolve, reject) => {
    output.write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve());
  });
}

async function runStdio({ input, output, handle, begin, onCleanupError = () => {}, maxLineBytes = fileLimit('localFile') }) {
  const onOutputError = () => {}; // write callbacks carry the error to the awaited caller.
  output.on('error', onOutputError);
  try { for await (const frame of readFrames(input, maxLineBytes)) {
    let request, validation;
    if (frame.error) validation = { error: frame.error, id: null };
    else {
      if (!frame.line.trim()) continue;
      try { request = JSON.parse(frame.line); validation = validateRequest(request); }
      catch { validation = { error: protocolError(-32700, 'MCP JSON 解析失败；请检查该行 JSON 格式并重发。'), id: null }; }
    }
    if (validation.error) {
      if (!validation.notification) await writeMessage(output, { jsonrpc: '2.0', id: validation.id, error: validation.error });
      continue;
    }
    // MCP request methods must never run as notifications: tools/call could
    // otherwise create a task for which the Host cannot receive an outcome.
    // No incoming notification currently needs application-side handling.
    if (validation.notification) continue;
    let response, release;
    try {
      release = begin?.(request);
      response = { result: await handle(request) };
    } catch (error) {
      response = { error: protocolError(Number.isInteger(error?.code) ? error.code : -32603, String(error?.message || error)) };
    }
    try {
      if (!validation.notification) await writeMessage(output, { jsonrpc: '2.0', id: validation.id, ...response });
    } finally {
      // Preserve the completed tool result even if activity bookkeeping fails.
      // The server marks this connection unavailable for further tool work.
      try { await release?.(); } catch (error) { onCleanupError(error); }
    }
  } } finally { output.removeListener('error', onOutputError); }
}

module.exports = { readFrames, validateRequest, runStdio };
