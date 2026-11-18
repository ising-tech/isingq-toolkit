'use strict';

const zlib = require('node:zlib');

// NPY v1.0 inside a standard, deterministic ZIP archive (NumPy's NPZ format).
// No pickle/object arrays, platform-endian dependency or Python runtime needed.
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function matrixNpz(matrix) {
  const n = matrix?.qubo?.num_bits;
  if (!Number.isSafeInteger(n) || n < 1 || !Buffer.isBuffer(matrix.content)) throw new Error('NPZ 转换需要有效 matrixDocument（qubo.num_bits、content）');
  const rows = matrix.content.toString('utf8').trimEnd().split('\n');
  if (rows.length !== n) throw new Error(`NPZ 矩阵行数不匹配（expected=${n}, actual=${rows.length}）`);
  let header = `{'descr': '<f8', 'fortran_order': False, 'shape': (${n}, ${n}), }`;
  header += ' '.repeat((64 - ((10 + Buffer.byteLength(header) + 1) % 64)) % 64) + '\n';
  const preamble = Buffer.alloc(10);
  Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]).copy(preamble);
  preamble.writeUInt16LE(Buffer.byteLength(header), 8);
  const values = Buffer.alloc(n * n * 8);
  rows.forEach((row, i) => {
    const cells = row.split(',');
    if (cells.length !== n) throw new Error(`NPZ 矩阵列数不匹配（row=${i}, expected=${n}, actual=${cells.length}）`);
    cells.forEach((cell, j) => {
      const value = Number(cell);
      if (!cell.trim() || !Number.isFinite(value)) throw new Error(`NPZ 矩阵系数必须为有限数值（row=${i}, column=${j}）`);
      values.writeDoubleLE(value, (i * n + j) * 8);
    });
  });
  const npy = Buffer.concat([preamble, Buffer.from(header, 'ascii'), values]);
  const compressed = zlib.deflateRawSync(npy);
  if (Math.max(npy.length, compressed.length) > 0xffffffff) throw new Error('NPZ 矩阵超过 ZIP32 可编码范围');
  const name = Buffer.from('matrix.npy');
  const checksum = crc32(npy);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt16LE(33, 12); // 1980-01-01, deterministic DOS date.
  local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(npy.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt16LE(33, 14);
  central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(npy.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}

module.exports = { matrixNpz };
