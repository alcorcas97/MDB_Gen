const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { _internal } = require('../app/lib/dwg-tools.cjs');

test('Mantelbuis LISP exports endpoints and restores material polylines as DRILLING MLINE', () => {
  const lisp = _internal.buildCreateMantelbuisLisp({ outputFilePath: 'C:\\temp\\mantelbuis.tsv', progressFilePath: 'C:\\temp\\mantelbuis.progress' });
  for (const token of ['LWPOLYLINE', 'MLINE,LWPOLYLINE,POLYLINE', 'TEXT,MTEXT,MULTILEADER', '(ssget "_X"', 'fmdb-mantelbuis-near-material', 'fmdb-mantelbuis-angle-difference', '(* 5.0 (fmdb-mantelbuis-angle-difference lineAngle angleValue))', '(cdr (assoc 50 entityData))', 'fmdb-mantelbuis-restore-drilling', '(list "CMLSTYLE" "DRILLING")', '(command "_.MLINE")', '(entdel entity)', '(setvar "OSMODE" 0)', 'CLAYER', 'FILEDIA', 'CMDECHO', 'CMLJUST', 'CMLSCALE', 'fmdb-mantelbuis-write-unresolved', 'texts 5.0', 'texts 10.0', '(cdr (assoc 5 entityData))', '(fmdb-report-result "RESTORED"', '(fmdb-report-done "MANTELBUIS")']) {
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
  assert.equal(_internal.normalizeMantelbuisMaterial('HDPE75', { boring: true }), 'HDPE75-Zwart');
  assert.equal(_internal.normalizeMantelbuisMaterial('HDPE63-Blue'), 'HDPE63-XXX');
  assert.deepEqual(_internal.extractBoringMaterial('Ø63HPE  Materiaal buis'), ['HDPE63-Zwart']);
  assert.deepEqual(_internal.extractBoringMaterial('Gestuurde Boring 1 x %%C63mm + 1 x %%C160mm HPE SDR11 PE100'), ['HDPE63-Zwart', 'HDPE160-Zwart']);
  assert.deepEqual(_internal.extractBoringMaterial('1x \\U+2205 75mm HPE SDR11'), ['HDPE75-Zwart']);
  assert.deepEqual(_internal.extractBoringMaterial('Materiaal: HDPE 50'), ['HDPE50-Zwart']);
  assert.deepEqual(_internal.extractBoringCoordinates('INTREDEPUNT\nX = 117350.9505\nY = 494460.5762\nUITTREDEPUNT\nX = 117360,4109\nY = 494455,8876'), {
    X_A: 117350.9505,
    Y_A: 494460.5762,
    X_B: 117360.4109,
    Y_B: 494455.8876
  });
  assert.equal(_internal.normalizeMantelbuisMaterial('ST40'), null);
  assert.deepEqual(_internal.parseMantelbuisExport('UNRESOLVED\tAB12\tDrilling\tHDPE50\t1\t2\t3\t4'), [{ kind: 'UNRESOLVED', handle: 'AB12', layer: 'Drilling', suggestedMaterial: 'HDPE50-Oranje', xA: 1, yA: 2, xB: 3, yB: 4 }]);
  assert.equal(_internal.normalizeMantelbuisMaterial('HDPE 50', { uncertain: true }), 'HDPE50-XXX');
  assert.equal(_internal.normalizeMantelbuisMaterial('HDPE 50-Zwart', { uncertain: true }), 'HDPE50-Zwart');
  assert.deepEqual(_internal.buildManualMantelbuisRow({ xA: 1, yA: 2, xB: 3, yB: 4 }, 'ST110'), { X_A: 1, Y_A: 2, X_B: 3, Y_B: 4, Soort_Materie: 'ST110', Boring_Type: 'Persing', Boorprofiel: '', ImportResult: '' });
  assert.deepEqual(_internal.buildManualMantelbuisRow({ xA: 1, yA: 2, xB: 3, yB: 4, Boring_Type: 'Gestuurde Boring', Boorprofiel: 'Project-Boring03.dwg' }, 'HDPE50'), { X_A: 1, Y_A: 2, X_B: 3, Y_B: 4, Soort_Materie: 'HDPE50-XXX', Boring_Type: 'Gestuurde Boring', Boorprofiel: 'Project-Boring03.dwg', ImportResult: '' });
});

test('Mantelbuis boring rows retain each extracted material on the matched geometry', async () => {
  const project = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mantelbuis-'));
  try {
    fs.mkdirSync(path.join(project, 'Boringen'));
    fs.writeFileSync(path.join(project, 'Boringen', 'Project-Boring01.dwg'), '');
    fs.writeFileSync(path.join(project, 'Boringen', 'Project-Boring02.dwg'), '');
    fs.writeFileSync(path.join(project, 'Boringen', 'Project-Boring03.dwg'), '');
    const result = await _internal.buildBoringRows(project, [
      { kind: 'REFERENCE', value: 'Project-Boring01.dwg', xA: 10, yA: 20, xB: 10, yB: 20 },
      { kind: 'REFERENCE', value: 'Project-Boring02.dwg', xA: 30, yA: 40, xB: 30, yB: 40 },
      { kind: 'REFERENCE', value: 'Project-Boring03.dwg', xA: 50, yA: 60, xB: 50, yB: 60 },
      { kind: 'LINE', value: '', xA: 10, yA: 20, xB: 11, yB: 21 },
      { kind: 'LINE', value: '', xA: 30, yA: 40, xB: 31, yB: 41 },
      { kind: 'LINE', value: '', xA: 50, yA: 60, xB: 51, yB: 61 }
    ], {
      readDetails: async (_folder, name) => name.endsWith('01.dwg')
        ? { materials: ['HDPE63-Zwart', 'HDPE160-Zwart'], coordinates: { X_A: 10, Y_A: 20, X_B: 11, Y_B: 21 } }
        : name.endsWith('02.dwg')
          ? { materials: ['HDPE75-Zwart'], coordinates: { X_A: 30, Y_A: 40, X_B: 31, Y_B: 41 } }
          : { materials: [], coordinates: null }
    });
    assert.deepEqual(result.rows.map((row) => row.Soort_Materie), ['HDPE63-Zwart', 'HDPE160-Zwart', 'HDPE75-Zwart']);
    assert.deepEqual(result.rows.slice(0, 2).map(({ X_A, Y_A, X_B, Y_B }) => ({ X_A, Y_A, X_B, Y_B })), [{ X_A: 10, Y_A: 20, X_B: 11, Y_B: 21 }, { X_A: 10, Y_A: 20, X_B: 11, Y_B: 21 }]);
    assert.deepEqual(result.unresolved, [{ kind: 'UNRESOLVED', handle: 'Project-Boring03.dwg', layer: 'Boring: Project-Boring03.dwg', suggestedMaterial: null, xA: 50, yA: 60, xB: 51, yB: 61, Boring_Type: 'Gestuurde Boring', Boorprofiel: 'Project-Boring03.dwg' }]);
    assert.deepEqual(result.reviewItems, []);
  }
  finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('Mantelbuis PowerShell contract applies directly to Mantelbuis and compacts IDs', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'app', 'mdb_tools.ps1'), 'utf8');
  for (const token of ['ApplyMantelbuis', 'function Apply-Mantelbuis', 'function Get-MantelbuisCoordinateKey', '$incomingCoordinates.ContainsKey($coordinateKey)', 'replacedCount = $replaced', "-TableNames @('Mantelbuis')", "-TableName 'Mantelbuis'", 'Test-ContiguousTableIds', 'Boring_Type = $(if (Normalize-Text $row.Boring_Type)', 'Boorprofiel = $(if (Normalize-Text $row.Boorprofiel)']) {
    assert.match(script, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Mantelbuis cleanup does not turn a completed scan into an EBUSY failure', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'lib', 'dwg-tools.cjs'), 'utf8');
  assert.match(source, /removeFileIfExists\(target, \{ bestEffort: true, retries: 5 \}\)/);
  assert.match(source, /\['EBUSY', 'EPERM', 'EACCES'\]\.includes\(error\?\.code\)/);
});
