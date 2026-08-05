const test = require('node:test');
const assert = require('node:assert/strict');

const {
  associateRoles,
  buildPlacementModel,
  groupVertices,
  rankCandidates,
  summarizeDecisions
} = require('../app/lib/phkt-placement-domain.cjs');

const config = {
  vertexMergeTolerance: 0.01,
  rolVertexTolerance: 0.5,
  maxSearchRadius: 20,
  maxCandidates: 5,
  rolPriorityMargin: 2
};

function vertex(x, y, options = {}) {
  return {
    x,
    y,
    z: 0,
    polylineHandle: options.handle ?? 'A1',
    vertexIndex: options.index ?? 0,
    isEndpoint: options.endpoint ?? true
  };
}

test('1. a text receives its single nearby vertex', () => {
  const model = buildPlacementModel({ texts: [{ point: { x: 0, y: 0 } }], vertices: [vertex(2, 0)], roles: [] }, config);
  assert.equal(model.texts[0].candidates.length, 1);
});

test('2. endpoint vertices retain endpoint kind', () => {
  assert.equal(groupVertices([vertex(1, 1)])[0].kind, 'extremo');
});

test('3. intermediate vertices retain intermediate kind', () => {
  assert.equal(groupVertices([vertex(1, 1, { endpoint: false })])[0].kind, 'intermedio');
});

test('4. an intermediate vertex can carry ROL', () => {
  const grouped = groupVertices([vertex(1, 1, { endpoint: false })]);
  assert.equal(associateRoles(grouped, [{ x: 1, y: 1, z: 0 }], 0.5)[0].hasRol, true);
});

test('5. a slightly displaced ROL is associated within tolerance', () => {
  const grouped = groupVertices([vertex(1, 1)]);
  assert.equal(associateRoles(grouped, [{ x: 1.4, y: 1, z: 0 }], 0.5)[0].hasRol, true);
});

test('6. coincident vertices from two polylines are grouped', () => {
  const grouped = groupVertices([vertex(1, 1, { handle: 'A' }), vertex(1.005, 1, { handle: 'B' })], 0.01);
  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0].polylineHandles, ['A', 'B']);
});

test('7. two texts can share the same candidate', () => {
  const texts = Array.from({ length: 2 }, () => ({ candidates: [{}] }));
  const decisions = texts.map(() => ({ status: 'accepted', candidateId: 'V1', method: 'automatic' }));
  assert.equal(summarizeDecisions(texts, decisions).maximumAssignments, 2);
});

test('8. five texts can share the same candidate', () => {
  const texts = Array.from({ length: 5 }, () => ({ candidates: [{}] }));
  const decisions = texts.map(() => ({ status: 'accepted', candidateId: 'V1', method: 'automatic' }));
  const summary = summarizeDecisions(texts, decisions);
  assert.equal(summary.assigned, 5);
  assert.equal(summary.sharedVertices, 1);
  assert.equal(summary.maximumAssignments, 5);
});

test('9. nearly equidistant candidates are ordered deterministically', () => {
  const ranked = rankCandidates({ x: 0, y: 0 }, [{ id: 'B', x: 1.001, y: 0 }, { id: 'A', x: 1, y: 0 }], config);
  assert.deepEqual(ranked.map((item) => item.id), ['A', 'B']);
});

test('10. several ranked candidates are retained for next/previous navigation', () => {
  const ranked = rankCandidates({ x: 0, y: 0 }, [{ id: 'A', x: 1, y: 0 }, { id: 'B', x: 2, y: 0 }], config);
  assert.equal(ranked[1].id, 'B');
});

test('11. manual decisions are represented in the summary', () => {
  const summary = summarizeDecisions([{}], [{ status: 'accepted', candidateId: 'V1', method: 'manual' }]);
  assert.equal(summary.manual, 1);
});

test('12. justified DBText input retains its type while receiving candidates', () => {
  const model = buildPlacementModel({ texts: [{ type: 'AcDbText', justified: true, point: { x: 0, y: 0 } }], vertices: [vertex(1, 0)] }, config);
  assert.equal(model.texts[0].type, 'AcDbText');
  assert.equal(model.texts[0].candidates.length, 1);
});

test('13. MText input receives candidates', () => {
  const model = buildPlacementModel({ texts: [{ type: 'AcDbMText', point: { x: 0, y: 0 } }], vertices: [vertex(1, 0)] }, config);
  assert.equal(model.texts[0].candidates.length, 1);
});

test('14. arbitrary text layers do not affect candidate generation', () => {
  const model = buildPlacementModel({ texts: [{ layer: 'ANY', point: { x: 0, y: 0 } }], vertices: [vertex(1, 0)] }, config);
  assert.equal(model.texts[0].candidates.length, 1);
});

test('15. cancellation leaves no accepted decisions', () => {
  const summary = summarizeDecisions([{}], [{ status: 'skipped' }]);
  assert.equal(summary.assigned, 0);
});

test('16. application errors are counted without accepting the decision', () => {
  const summary = summarizeDecisions([{}], [{ status: 'error' }]);
  assert.equal(summary.assigned, 0);
  assert.equal(summary.errors, 1);
});

test('17. decimal coordinate differences inside tolerance are grouped', () => {
  assert.equal(groupVertices([vertex(0, 0), vertex(0.009, 0)], 0.01).length, 1);
});

test('18. vertices outside the maximum radius are excluded', () => {
  assert.deepEqual(rankCandidates({ x: 0, y: 0 }, [{ id: 'A', x: 21, y: 0 }], config), []);
});

test('ROL receives moderate priority only inside its configured margin', () => {
  const candidates = [
    { id: 'near', x: 1, y: 0, hasRol: false },
    { id: 'rol-near', x: 2.5, y: 0, hasRol: true },
    { id: 'rol-far', x: 10, y: 0, hasRol: true }
  ];
  assert.deepEqual(rankCandidates({ x: 0, y: 0 }, candidates, config).map((item) => item.id), ['rol-near', 'near', 'rol-far']);
});
