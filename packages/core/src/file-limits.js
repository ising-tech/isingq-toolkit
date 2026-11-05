'use strict';

// Shared source; the expert CLI carries an identical copy, checked by regression.
const fs = require('node:fs');
const { constants } = require('node:buffer');
const MiB = 1024 * 1024;
// JSON/text consumers need a JS string as well as a Buffer; reserve one byte for
// bounded-read lookahead. This is a runtime ceiling, not a tested capacity claim.
const MAX_CONFIGURABLE_BYTES = Math.min(constants.MAX_LENGTH, constants.MAX_STRING_LENGTH) - 1;
const FILE_LIMITS = Object.freeze({
  record: Object.freeze({ environment: 'ISINGQ_MAX_RECORD_BYTES', bytes: 128 * MiB }),
  localFile: Object.freeze({ environment: 'ISINGQ_MAX_LOCAL_FILE_BYTES', bytes: 128 * MiB }),
  hostConfig: Object.freeze({ environment: 'ISINGQ_MAX_HOST_CONFIG_BYTES', bytes: 10 * MiB }),
});

class FileLimitError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; Object.assign(this, details); }
}

function fileLimit(kind, environment = process.env) {
  const setting = FILE_LIMITS[kind];
  const value = environment[setting.environment];
  if (value === undefined) return setting.bytes;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)
    || !Number.isSafeInteger(Number(value)) || Number(value) > MAX_CONFIGURABLE_BYTES) {
    throw new FileLimitError('file_limit_invalid', `容量配置无效（setting=${setting.environment}）；请移除该变量恢复默认 ${setting.bytes} 字节，或设置为 1 到 ${MAX_CONFIGURABLE_BYTES} 的十进制整数字节数；不接受空值、小数、空格或单位后缀。`);
  }
  return Number(value);
}

function fileLimitHint(kind) {
  return `如需读取或保存更大文件，可按用户指令调高进程环境变量 ${FILE_LIMITS[kind].environment}（十进制字节数）并重启该进程；调高后的内存与业务处理能力需另行验证，不要删除历史或跳过检查。`;
}

function assertFileBytes(bytes, maxBytes, kind, file) {
  if (bytes > maxBytes) throw new FileLimitError('file_too_large',
    `文件超过有效容量上限，未覆盖原文件（path=${file}, bytes=${bytes}, max_bytes=${maxBytes}）；${fileLimitHint(kind)}`,
    { bytes, maxBytes });
}

// Read only a regular path (no leaf symlink), or the caller-owned stdin fd.
// Allocate in chunks rather than reserving the entire configured capacity.
function readFileBounded(file, maxBytes, kind = 'localFile') {
  let descriptor;
  const stdin = file === 0;
  try {
    if (!stdin) {
      const entry = fs.lstatSync(file);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new FileLimitError('file_type_invalid', `内容输入必须为普通文件，拒绝目录或符号链接（path=${file}）`);
      assertFileBytes(entry.size, maxBytes, kind, file);
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    } else descriptor = 0;
    const metadata = fs.fstatSync(descriptor);
    if (!stdin && !metadata.isFile()) throw new FileLimitError('file_type_invalid', `内容输入不是普通文件（path=${file}）`);
    if (metadata.isFile()) assertFileBytes(metadata.size, maxBytes, kind, file);
    const buffer = Buffer.allocUnsafe(Math.min(MiB, Math.max(4096, metadata.size + 1), maxBytes + 1));
    const chunks = [];
    let bytes = 0;
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, maxBytes + 1 - bytes), null);
      if (!count) break;
      bytes += count;
      assertFileBytes(bytes, maxBytes, kind, file);
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    if (!stdin && descriptor !== undefined) fs.closeSync(descriptor);
  }
}

module.exports = { FILE_LIMITS, MAX_CONFIGURABLE_BYTES, FileLimitError, fileLimit, fileLimitHint, assertFileBytes, readFileBounded };
