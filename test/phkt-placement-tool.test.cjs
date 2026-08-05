const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildExtractionLisp,
  buildReviewLisp,
  parseExtraction,
  parseReviewResult
} = require('../app/lib/phkt-placement-tool.cjs');
const { buildPlacementModel } = require('../app/lib/phkt-placement-domain.cjs');

function assertBalancedLisp(source) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === ';') while (index < source.length && source[index] !== '\n') index += 1;
    else if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    assert.ok(depth >= 0, 'AutoLISP closes more expressions than it opens');
  }
  assert.equal(depth, 0);
  assert.equal(inString, false);
}

test('extraction parser handles DBText, MText, vertices and ROL records', () => {
  const parsed = parseExtraction([
    'TEXT\t1\tAcDbText\tPHKT-1\t1\t2\t0',
    'TEXT\t2\tAcDbMText\tPHKT-2\t3\t4\t0',
    'VERTEX\tA\t0\t1\t5\t6\t0',
    'ROL\tB\t5.1\t6\t0'
  ].join('\n'));
  assert.equal(parsed.texts.length, 2);
  assert.equal(parsed.vertices[0].isEndpoint, true);
  assert.equal(parsed.roles.length, 1);
});

test('extraction AutoLISP filters TEXT and Accessnet LWPOLYLINE only', () => {
  const lisp = buildExtractionLisp({ outputFilePath: 'C:/tmp/out.tsv', progressFilePath: 'C:/tmp/progress', commandName: 'TEST_EXTRACT' });
  assert.match(lisp, /\(0 \. "TEXT"\)/);
  assert.doesNotMatch(lisp, /TEXT,MTEXT/);
  assert.match(lisp, /Reintentar Cancelar/);
  assert.match(lisp, /LWPOLYLINE/);
  assert.match(lisp, /ACCESSNET/);
  assert.match(lisp, /EffectiveName/);
  assertBalancedLisp(lisp);
});

test('review AutoLISP covers justified text, live move, navigation, rollback and one undo mark', () => {
  const model = buildPlacementModel({
    texts: [{ handle: '1', type: 'AcDbText', content: 'PHKT-1', point: { x: 0, y: 0, z: 0 } }],
    vertices: [{ polylineHandle: 'A', vertexIndex: 0, isEndpoint: true, x: 1, y: 0, z: 0 }],
    roles: []
  });
  const lisp = buildReviewLisp({ model, outputFilePath: 'C:/tmp/out.tsv', progressFilePath: 'C:/tmp/progress', commandName: 'TEST_REVIEW' });
  assert.match(lisp, /TextAlignmentPoint/);
  assert.match(lisp, /AcDbMText/);
  assert.match(lisp, /Siguiente Anterior Manual Omitir Volver Terminar Cancelar/);
  assert.match(lisp, /<Aceptar>/);
  assert.doesNotMatch(lisp, /grdraw/);
  assert.doesNotMatch(lisp, /vla-ZoomWindow/);
  assert.match(lisp, /fmdb-move-text-now/);
  assert.match(lisp, /fmdb-save-document/);
  assert.doesNotMatch(lisp, /Aplicar todos los movimientos/);
  assert.match(lisp, /vla-StartUndoMark/);
  assert.match(lisp, /vla-EndUndoMark/);
  assert.match(lisp, /fmdb-rollback-decisions/);
  assertBalancedLisp(lisp);
});

test('review result parser returns the complete final summary', () => {
  const result = parseReviewResult('STATUS\tAPPLIED\nSELECTED\t5\nASSIGNED\t4\nMANUAL\t1\nSKIPPED\t1\nWITHOUT_CANDIDATES\t1\nERRORS\t0\nSHARED_VERTICES\t1\nMAXIMUM_ASSIGNMENTS\t2');
  assert.deepEqual(result, {
    status: 'APPLIED', selected: 5, assigned: 4, manual: 1, skipped: 1,
    withoutCandidates: 1, errors: 0, sharedVertices: 1, maximumAssignments: 2, error: null
  });
});
