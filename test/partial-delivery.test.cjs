const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNextPartialProjectName,
  parseSelectionText,
  parseBcCsv,
  parseFcRows,
  refreshPartialConnections,
  selectConnectionsByKabelIds,
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

test('BC derives ODP labels from customer cable IDs', () => {
  const [row] = parseBcCsv('Postcode;Huisnummer;KabelID\n2661JX;249;RT-CMA-ODP207-KA01');
  assert.equal(row.dpLabel, 'RT-CMA-ODP207');
});

test('FC rows enrich FTU location and keep demping with decimal comma', () => {
  const rows = parseFcRows([
    { 'Kabel ID': 'ASD-GNA-DP102-KA06', 'FTU locatie': 'wnk', Powermeter: '2.2', 'IP vezelwaarde': '0.9', 'Opleverstatus KPN': '2' },
    { 'Kabel ID': 'K-ASD-GNA-DP102-KA07', 'FTU locatie': 'MTK', Powermeter: '', 'IP vezelwaarde': '0.6', 'Opleverstatus KPN': '2' },
    { 'Kabel ID': 'ASD-GNA-DP102-KA08', 'FTU locatie': 'SMK', Powermeter: '1.1', 'IP vezelwaarde': '1.2', 'Opleverstatus KPN': '11' }
  ]);
  assert.deepEqual(rows, [
    { kabelId: 'K-ASD-GNA-DP102-KA06', ftuLocation: 'wnk', measurement: '2,2', statusCode: '2' },
    { kabelId: 'K-ASD-GNA-DP102-KA07', ftuLocation: 'MTK', measurement: '0,6', statusCode: '2' },
    { kabelId: 'K-ASD-GNA-DP102-KA08', ftuLocation: 'SMK', measurement: null, statusCode: '11' }
  ]);
});

test('FC demping is ignored for every status other than 2', () => {
  const rows = parseFcRows([
    { 'Kabel ID': 'ONE', 'Opleverstatus KPN': '5', Powermeter: '2.2' },
    { 'Kabel ID': 'TWO', 'Opleverstatus KPN': '14', 'IP vezelwaarde': '1.1' }
  ]);
  assert.deepEqual(rows.map((row) => row.measurement), [null, null]);
});

test('BC refreshes address and topology while FC only supplies status 2 termination data', () => {
  const refreshed = refreshPartialConnections([
    { kabelId: 'K-ONE', postcode: 'OLD', houseNumber: '1', kastnr: 'WNK', demping1A: '9,9' }
  ], [{
    kabelId: 'K-ONE', phkt: '1000AA-7-A-2', postcode: '1000AA', houseNumber: '7', houseSuffix: 'A', room: '2',
    dpLabel: 'DP-NEW', statusCode: '2', ftuType: 'FTU-NEW', odf: 'ODF-3', fiber: '44', strengId: 'S-9', buildingType: 'Hoog'
  }], [{ kabelId: 'K-ONE', ftuLocation: 'MTK', measurement: '1,8' }]);
  assert.deepEqual(refreshed[0], {
    kabelId: 'K-ONE', postcode: '1000AA', houseNumber: '7', kastnr: 'MTK', demping1A: '1,8', phkt: '1000AA-7-A-2',
    houseSuffix: 'A', room: '2', dpLabel: 'DP-NEW', bcStatusCode: '2', bcFiber: '44', bcOdf: 'ODF-3', bcStrengId: 'S-9',
    buildingType: 'Hoog', ftuType: 'FTU-NEW', fiber: '44'
  });
});

test('BC clears demping outside status 2 even when FC contains a measurement', () => {
  const [refreshed] = refreshPartialConnections([{ kabelId: 'K-ONE', demping1A: '9,9' }], [
    { kabelId: 'K-ONE', statusCode: '11', ftuType: 'FTU', postcode: null, houseNumber: null, houseSuffix: null, room: null, phkt: null, dpLabel: null, odf: null, fiber: null, strengId: null, buildingType: null }
  ], [{ kabelId: 'K-ONE', ftuLocation: 'SMK', measurement: '1,2' }]);
  assert.equal(refreshed.kastnr, 'SMK');
  assert.equal(refreshed.demping1A, null);
});

test('BC status rejects an incompatible FC location', () => {
  const [refreshed] = refreshPartialConnections([{ kabelId: 'K-ONE', kastnr: 'WNK' }], [
    { kabelId: 'K-ONE', statusCode: '2' }
  ], [{ kabelId: 'K-ONE', ftuLocation: 'GV', measurement: '2,2' }]);
  assert.equal(refreshed.kastnr, 'XXXX');
  assert.equal(refreshed.demping1A, '2,2');
});

test('FC can choose EG or GL within the BC status without adding demping', () => {
  const [refreshed] = refreshPartialConnections([{ kabelId: 'K-ONE', kastnr: 'GL' }], [
    { kabelId: 'K-ONE', statusCode: '5', ftuType: 'SHOULD-CLEAR' }
  ], [{ kabelId: 'K-ONE', ftuLocation: 'EG', measurement: '2,2', statusCode: '5' }]);
  assert.equal(refreshed.kastnr, 'EG');
  assert.equal(refreshed.ftuType, '');
  assert.equal(refreshed.demping1A, null);
});

test('existing Partial Kabel IDs resolve only against fresh connections', () => {
  const selected = selectConnectionsByKabelIds([
    { kabelId: 'K-FRESH' }, { kabelId: 'K-OTHER' }
  ], ['K-FRESH', 'K-STALE']);
  assert.deepEqual(selected.map((item) => item.kabelId), ['K-FRESH']);
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
