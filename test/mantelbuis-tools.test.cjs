const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { _internal } = require('../app/lib/dwg-tools.cjs');

test('Mantelbuis LISP validates the layer, restores system variables and exports central endpoints', () => {
  const lisp = _internal.buildCreateMantelbuisLisp({ outputFilePath: 'C:\\temp\\mantelbuis.tsv', progressFilePath: 'C:\\temp\\mantelbuis.progress' });
  for (const token of ['(snvalid material)', 'LWPOLYLINE', 'Coordinates', '(if newEntity', '(entdel entity)', 'OSMODE', 'CLAYER', 'FILEDIA', 'CMDECHO', '(fmdb-report-done "MANTELBUIS")']) {
    assert.match(lisp, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Mantelbuis parser emits the MDB contract and deduplicates reversed millimetric geometry', () => {
  const rows = _internal.parseMantelbuisRows([
    'PVC\t100.0004\t200\t300\t400',
    'pvc\t300\t400\t100.00049\t200',
    'HDPE\t100\t200\t300\t400',
    'BAD\tx\t2\t3\t4'
  ].join('\n'));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { X_A: 100.0004, Y_A: 200, X_B: 300, Y_B: 400, Soort_Materie: 'PVC', Boring_Type: 'Mantelbuis', Boorprofiel: '', ImportResult: '' });
  assert.equal(rows[1].Soort_Materie, 'HDPE');
});

test('Mantelbuis PowerShell contract applies directly to Mantelbuis and compacts IDs', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'app', 'mdb_tools.ps1'), 'utf8');
  for (const token of ['ApplyMantelbuis', 'function Apply-Mantelbuis', "-TableNames @('Mantelbuis')", "-TableName 'Mantelbuis'", 'Test-ContiguousTableIds']) {
    assert.match(script, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
