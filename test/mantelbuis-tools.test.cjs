const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { _internal } = require('../app/lib/dwg-tools.cjs');

test('Mantelbuis LISP scans automatically, restores system variables and exports typed endpoints', () => {
  const lisp = _internal.buildCreateMantelbuisLisp({ outputFilePath: 'C:\\temp\\mantelbuis.tsv', progressFilePath: 'C:\\temp\\mantelbuis.progress' });
  for (const token of ['LWPOLYLINE', 'MLINE,LWPOLYLINE,POLYLINE', 'TEXT,MTEXT,MULTILEADER', '(ssget "_X"', 'fmdb-mantelbuis-near-material', 'OSMODE', 'CLAYER', 'FILEDIA', 'CMDECHO', '(fmdb-report-done "MANTELBUIS")']) {
    assert.match(lisp, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(lisp, /\bentsel\b/i);
});

test('Mantelbuis parser normalizes materials, assigns boring type and deduplicates reversed millimetric geometry', () => {
  const rows = _internal.parseMantelbuisRows([
    'DUCT\tHDPE 50\t100.0004\t200\t300\t400',
    'DUCT\thdpe50\t300\t400\t100.00049\t200',
    'DUCT\tST110\t100\t200\t300\t400',
    'LINE\t\t1\t2\t3\t4',
    'DUCT\tBAD\tx\t2\t3\t4'
  ].join('\n'));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { X_A: 100.0004, Y_A: 200, X_B: 300, Y_B: 400, Soort_Materie: 'HDPE50-Oranje', Boring_Type: 'Mantelbuis', Boorprofiel: '', ImportResult: '' });
  assert.equal(rows[1].Boring_Type, 'Persing');
  assert.equal(_internal.normalizeMantelbuisMaterial('FLEX125'), 'FLEX125');
  assert.equal(_internal.normalizeMantelbuisMaterial('HDPE110', { boring: true }), 'HDPE110-Zwart');
  assert.equal(_internal.extractBoringMaterial('Ø63HPE  Materiaal buis'), 'HDPE63-Zwart');
  assert.equal(_internal.extractBoringMaterial('Materiaal: HDPE 50'), 'HDPE50-Zwart');
  assert.deepEqual(_internal.extractBoringCoordinates('INTREDEPUNT\nX = 117350.9505\nY = 494460.5762\nUITTREDEPUNT\nX = 117360,4109\nY = 494455,8876'), {
    X_A: 117350.9505,
    Y_A: 494460.5762,
    X_B: 117360.4109,
    Y_B: 494455.8876
  });
  assert.equal(_internal.normalizeMantelbuisMaterial('ST40'), null);
});

test('Mantelbuis PowerShell contract applies directly to Mantelbuis and compacts IDs', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'app', 'mdb_tools.ps1'), 'utf8');
  for (const token of ['ApplyMantelbuis', 'function Apply-Mantelbuis', "-TableNames @('Mantelbuis')", "-TableName 'Mantelbuis'", 'Test-ContiguousTableIds', 'Boring_Type = $(if (Normalize-Text $row.Boring_Type)', 'Boorprofiel = $(if (Normalize-Text $row.Boorprofiel)']) {
    assert.match(script, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
