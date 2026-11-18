'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { matrixNpz } = require('../packages/core/src/npz');
const { matrixDocument } = require('../packages/core/src/qubo');

test('NPZ loads as matrix finite float64 square via independent Python/NumPy oracle', t => {
  const matrix = matrixDocument({ num_bits: 3, linear: [{ index: 0, coefficient: -1.25 }, { index: 2, coefficient: 3e-10 }], quadratic: [{ i: 0, j: 2, coefficient: 7.5 }], offset: 19 });
  const npz = matrixNpz(matrix);
  const result = spawnSync('python3', ['-c', `import io,sys,json,zipfile,numpy as np
raw=sys.stdin.buffer.read()
z=zipfile.ZipFile(io.BytesIO(raw)); assert z.testzip() is None
assert z.namelist()==['matrix.npy']
f=np.load(io.BytesIO(raw),allow_pickle=False)
a=f['matrix']; assert a.shape==(3,3); assert a.dtype==np.dtype('<f8'); assert np.isfinite(a).all()
np.testing.assert_array_equal(a,np.array([[-1.25,0,7.5],[0,0,0],[0,0,3e-10]]))
print(json.dumps({'keys':f.files,'shape':list(a.shape),'dtype':str(a.dtype),'crc':'valid','values':a.tolist()}))`], { input: npz, encoding: 'utf8' });
  if (result.error?.code === 'ENOENT' || /ModuleNotFoundError: No module named ['\"]numpy/.test(result.stderr || '')) {
    t.skip('独立 NumPy oracle 需要已有 Python3/NumPy；正常运行时不依赖 Python');
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).shape, [3, 3]);
  assert.deepEqual(npz, matrixNpz(matrix), 'archive deterministic');
});

test('NPZ rejects non-square, non-numeric, nonfinite and missing matrices', () => {
  for (const content of ['1,0\n', '1,0\n0\n', '1,nope\n0,1\n', '1,Infinity\n0,1\n', '1,\n0,1\n']) {
    assert.throws(() => matrixNpz({ qubo: { num_bits: 2 }, content: Buffer.from(content) }), /NPZ/);
  }
  assert.throws(() => matrixNpz({}), /matrixDocument/);
});
