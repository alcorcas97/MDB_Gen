const assert = require('node:assert/strict');
const test = require('node:test');

const { _internal } = require('../app/lib/dwg-tools.cjs');

test('M-30140 parser keeps unique GV coordinates and ignores coordinates at the origin', () => {
  const html = `
    <table>
      <caption>customer: slack symbol can not be found (M-30140)</caption>
      <tr><td>klant_id</td><td>kastnr</td><td>(x,y)</td></tr>
      <tr><td>1</td><td>GV</td><td>(122690.221,488664.006)</td></tr>
      <tr><td>2</td><td>GV</td><td>(122690.221,488664.006)</td></tr>
      <tr><td>3</td><td>GV</td><td>(0.000,0.000)</td></tr>
      <tr><td>4</td><td>MTK</td><td>(10.000,20.000)</td></tr>
    </table>`;

  assert.deepEqual(_internal.parseMissingRoleCoordinatesFromCheckHtml(html), {
    coordinates: [{ x: 122690.221, y: 488664.006 }],
    rowCount: 4,
    ignoredZeroCount: 1,
    ignoredNonGvCount: 1
  });
});

test('M-30140 LISP inserts ROL at AccessNet endpoints with the calibrated rotation', () => {
  const lisp = _internal.buildAddMissingRolesLisp({
    coordinates: [{ x: 100, y: 200 }],
    progressFilePath: 'C:/Temp/missing-roles.progress'
  });

  for (const token of [
    'FIBER_ADD_MISSING_ROLES',
    'LWPOLYLINE',
    'AccessNet',
    'Opmerking',
    'fmdb-lwpolyline-vertices',
    'Follow the longer segment into AccessNet',
    '(+ direction (/ pi 2.0))',
    '(fmdb-role-exists-at-point target)',
    '(fmdb-report-result "INSERTED"',
    '(fmdb-report-result "NO_ACCESSNET"'
  ]) {
    assert.match(lisp, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(lisp, /-PURGE|PURGE ALL/i);
});
