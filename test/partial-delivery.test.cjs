const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNextPartialProjectName,
  parseSelectionText,
  parseBcCsv,
  resolveSelectionIdentifiers
} = require('../app/lib/partial-delivery.cjs');

const connections = [
  { kabelId: 'K-ONE', phkt: '1000AA-1', complex: 'Block A' },
  { kabelId: 'K-TWO', phkt: '1000AA-2', complex: 'Block A' },
  { kabelId: 'K-THREE', phkt: '1000AA-3', complex: null }
];

test('selection text accepts one identifier per line plus separators', () => {
  assert.deepEqual(parseSelectionText('\uFEFFK-ONE\r\n1000AA-2;K-ONE'), ['K-ONE', '1000AA-2']);
});

test('BC CSV maps address, Kabel ID and fiber position semantically', () => {
  const rows = parseBcCsv('Postcode;Huisnummer;HuisnummerToevoeging;Opleverstatus;FTU-Type;KabelID;ODFpositie;StrengID\n1075VE;48;;2;FTU_TK01;ASD-GNA-DP102-KA01;49;DP102-5-1');
  assert.deepEqual(rows[0], {
    kabelId: 'K-ASD-GNA-DP102-KA01', phkt: '1075VE-48', postcode: '1075VE', houseNumber: '48', houseSuffix: null, room: null,
    statusCode: '2', ftuType: 'FTU_TK01', dpLabel: 'ASD-GNA-DP102', odf: null, fiber: '49', strengId: 'DP102-5-1', buildingType: null
  });
});

test('selection resolves Kabel ID or PHKT and expands a complex by default', () => {
  const result = resolveSelectionIdentifiers(connections, ['1000AA-1']);
  assert.deepEqual(result.selected.map((item) => item.kabelId).sort(), ['K-ONE', 'K-TWO']);
  assert.deepEqual(result.unmatched, []);
});

test('selection can retain only the exact requested connection', () => {
  const result = resolveSelectionIdentifiers(connections, ['K-ONE', 'missing'], { expandComplex: false });
  assert.deepEqual(result.selected.map((item) => item.kabelId), ['K-ONE']);
  assert.deepEqual(result.unmatched, ['missing']);
});

test('partial suffix advances predictably', () => {
  assert.equal(buildNextPartialProjectName('ASD-GNA-B9857'), 'ASD-GNA-B9857-A');
  assert.equal(buildNextPartialProjectName('ASD-GNA-B9857-A'), 'ASD-GNA-B9857-B');
});
