const assert = require('node:assert/strict');
const test = require('node:test');

const { CROSSING_DP_LAYER_NAME, _internal } = require('../app/lib/dwg-tools.cjs');

test('Crossing DP prefers Kabel.Locatienaam_A over the postal location label', () => {
  const groups = _internal.buildCrossingDpGroups([
    { label: 'AREA-ODP01', x: 100, y: 200 },
    { label: 'AREA-ODP02', x: 0, y: 0 },
    { label: 'AREA-ODP03', x: 300, y: 400 }
  ], [
    { dpLabel: 'area-odp01', locationLabel: 'POSTCODE-1234AB-10', x: 110, y: 210, klantId: 1 },
    { dpLabel: 'AREA-ODP03', locationLabel: 'AREA-ODP01', x: 115, y: 215, klantId: 2 },
    { locationLabel: 'AREA-ODP02', x: 120, y: 220, klantId: 3 },
    { locationLabel: 'UNKNOWN-ODP', x: 130, y: 230, klantId: 4 }
  ]);

  assert.deepEqual(groups.map((group) => [group.label, group.hasValidCoordinates, group.customerCount]), [
    ['AREA-ODP01', true, 1],
    ['AREA-ODP02', false, 1],
    ['AREA-ODP03', true, 1]
  ]);
  assert.equal(groups[0].customers[0].klantId, 1);
  assert.equal(groups[2].customers[0].klantId, 2);
});

test('Crossing DP LISP draws colored LINE entities on one temporary layer', () => {
  const lisp = _internal.buildCrossingDpLisp([{
    label: 'AREA-ODP01', x: 100, y: 200, color: 4, customers: [{ x: 110, y: 210 }]
  }], { progressFilePath: 'C:/Temp/crossing.progress', draw: true });

  assert.match(lisp, new RegExp(`fmdb-crossing-layer "${CROSSING_DP_LAYER_NAME}"`));
  assert.match(lisp, /'\(0 \. "LINE"\)/);
  assert.match(lisp, /\(cons 8 fmdb-crossing-layer\)/);
  assert.match(lisp, /\(cons 62 \(nth 3 group\)\)/);
  assert.match(lisp, /\(setvar "FILEDIA" oldFiledia\)/);
  assert.match(lisp, /\(setvar "CMDECHO" oldCmdecho\)/);
});

test('Crossing DP assigns unique ACI colors beyond the preferred palette', () => {
  const dpTargets = Array.from({ length: 12 }, (_, index) => ({
    label: `AREA-ODP${String(index + 1).padStart(2, '0')}`,
    x: index + 1,
    y: index + 100
  }));
  const customers = dpTargets.map((target, index) => ({
    locationLabel: target.label,
    x: index + 200,
    y: index + 300
  }));
  const groups = _internal.buildCrossingDpGroups(dpTargets, customers);
  const colors = groups.map((group) => group.color);

  assert.equal(new Set(colors).size, colors.length);
  assert.deepEqual(colors.slice(0, 8), [1, 2, 3, 4, 5, 6, 30, 140]);
  assert.ok(colors.every((color) => color >= 1 && color <= 255 && color !== 7));
});

test('Crossing DP cleanup selects only its layer and deletes its definition without PURGE ALL', () => {
  const lisp = _internal.buildCrossingDpLisp([], { progressFilePath: 'C:/Temp/crossing.progress', draw: false });

  assert.match(lisp, /\(ssget "_X" \(list \(cons 8 fmdb-crossing-layer\)\)\)/);
  assert.match(lisp, /\(vla-delete layerObject\)/);
  assert.doesNotMatch(lisp, /-LAYER|"_Delete"/);
  assert.match(lisp, /\(if \(and oldLayer \(tblsearch "LAYER" oldLayer\)\) \(setvar "CLAYER" oldLayer\)\)/);
  assert.match(lisp, /\(setq oldError \*error\*\)/);
  assert.match(lisp, /\(fmdb-crossing-restore-settings oldFiledia oldCmdecho oldLayer\)/);
  assert.doesNotMatch(lisp, /-PURGE|PURGE ALL/i);
});
