const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { _internal } = require('../app/lib/dwg-tools.cjs');

function file(name) {
  return { name, fullPath: path.join('C:', 'work', 'Boringen', name), matchKey: name.replace(/\.dwg$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase() };
}

function reference(text, x, y, handle = text) {
  return { handle, text, x, y, z: 0, entityType: 'MTEXT', matchKey: text.replace(/\.dwg$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase() };
}

test('Gestuurde Boringen preserves gaps and assigns new files after the maximum existing number', () => {
  const plan = _internal.buildBoringRenamePlan({
    projectLabel: 'ASD-B123',
    boringFiles: [file('ASD-B123-Boring01.dwg'), file('ASD-B123-Boring03.dwg'), file('incoming-a.dwg'), file('incoming-b.dwg')],
    references: [reference('incoming-b.dwg', 30, 0), reference('ASD-B123-Boring03.dwg', 20, 0), reference('incoming-a.dwg', 10, 0), reference('ASD-B123-Boring01.dwg', 0, 0)]
  });
  assert.equal(plan.existingItems.length, 2);
  assert.deepEqual(plan.items.map((item) => item.newFileName), ['ASD-B123-Boring04.dwg', 'ASD-B123-Boring05.dwg']);
  assert.deepEqual(plan.items.map((item) => item.boringNumber), [4, 5]);
});

test('Gestuurde Boringen assigns only newly actionable files using the current sorted reference order', () => {
  const plan = _internal.buildBoringRenamePlan({
    projectLabel: 'ASD-B123',
    boringFiles: [file('ASD-B123-Boring07.dwg'), file('later.dwg'), file('first.dwg')],
    references: [reference('later.dwg', 20, 0), reference('ASD-B123-Boring07.dwg', 10, 0), reference('first.dwg', 0, 0)]
  });
  assert.deepEqual(plan.items.map((item) => [item.oldFileName, item.newFileName]), [['first.dwg', 'ASD-B123-Boring08.dwg'], ['later.dwg', 'ASD-B123-Boring09.dwg']]);
});

test('Gestuurde Boringen recognizes normalized prefixes case-insensitively and leaves them no-op', () => {
  const plan = _internal.buildBoringRenamePlan({ projectLabel: 'ASD-B123', boringFiles: [file('asd-b123-bOrInG02.DWG')], references: [reference('asd-b123-bOrInG02.DWG', 0, 0)] });
  assert.equal(plan.items.length, 0);
  assert.equal(plan.existingItems.length, 1);
  assert.equal(plan.matchedCount, 1);
});

test('Gestuurde Boringen fails clearly when existing normalized numbers are duplicated', () => {
  assert.throws(() => _internal.buildBoringRenamePlan({ projectLabel: 'ASD-B123', boringFiles: [file('ASD-B123-Boring02.dwg'), file('asd-b123-boring02.DWG')], references: [reference('ASD-B123-Boring02.dwg', 0, 0)] }), /numeracion existente duplicada/i);
});

test('Gestuurde Boringen separates no-op existing mappings from actionable work', () => {
  const plan = _internal.buildBoringRenamePlan({ projectLabel: 'ASD-B123', boringFiles: [file('ASD-B123-Boring04.dwg'), file('new-source.dwg')], references: [reference('ASD-B123-Boring04.dwg', 0, 0), reference('new-source.dwg', 1, 0)] });
  assert.equal(plan.matchedCount, 2);
  assert.equal(plan.existingItems.length, 1);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].newFileName, 'ASD-B123-Boring05.dwg');
});
