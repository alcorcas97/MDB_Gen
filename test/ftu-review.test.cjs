const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyFtuReviewDecision,
  buildFtuNeighborSuggestion
} = require('../app/lib/ftu-review.cjs');

test('nearby compatible positions suggest their unique majority', () => {
  const warning = {
    CableId: 'K-ASD-GRL-ODP006-KA17',
    Allowed: ['MTK', 'WNK', 'ANDE', 'KLDR']
  };
  const rows = [
    { Kabel: 'K-ASD-GRL-ODP006-KA14', Kastnr: 'MTK' },
    { Kabel: 'K-ASD-GRL-ODP006-KA15', Kastnr: 'MTK' },
    { Kabel: 'K-ASD-GRL-ODP006-KA16', Kastnr: 'MTK' },
    { Kabel: 'K-ASD-GRL-ODP006-KA18', Kastnr: 'MTK' },
    { Kabel: 'K-ASD-GRL-ODP006-KA19', Kastnr: 'MTK' },
    { Kabel: 'K-ASD-GRL-ODP006-KA20', Kastnr: 'GV' },
    { Kabel: 'K-ASD-GRL-ODP007-KA17', Kastnr: 'WNK' }
  ];

  const result = buildFtuNeighborSuggestion(warning, rows);
  assert.equal(result.suggestion, 'MTK');
  assert.deepEqual(result.counts, { MTK: 5 });
});

test('a tie does not produce an automatic suggestion', () => {
  const result = buildFtuNeighborSuggestion(
    { CableId: 'K-X-ODP001-KA10', Allowed: ['MTK', 'WNK'] },
    [
      { Kabel: 'K-X-ODP001-KA09', Kastnr: 'MTK' },
      { Kabel: 'K-X-ODP001-KA11', Kastnr: 'WNK' }
    ]
  );

  assert.equal(result.suggestion, null);
});

test('the selected status updates Klant and Kabel and removes its warning', () => {
  const warning = {
    CableId: 'K-X-ODP001-KA10',
    AddressCode: '1000AA-1',
    DeliveryStatus: '2',
    Allowed: ['MTK', 'WNK']
  };
  const data = {
    FtuReviewWarnings: [warning],
    TableRows: {
      Klant: [{ Kabel: warning.CableId, Kastnr: 'XXXX', FTUType: 'FTU_TK01' }],
      Kabel: [{ Label: warning.CableId, Afwerkeenheid_B: 'XXXX' }]
    }
  };

  const decision = applyFtuReviewDecision(data, warning, 'MTK');
  assert.equal(data.TableRows.Klant[0].Kastnr, 'MTK');
  assert.equal(data.TableRows.Kabel[0].Afwerkeenheid_B, 'MTK');
  assert.equal(data.FtuReviewWarnings.length, 0);
  assert.equal(decision.SelectedLocation, 'MTK');
});
