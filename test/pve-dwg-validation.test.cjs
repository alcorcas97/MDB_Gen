const assert = require('node:assert/strict');
const test = require('node:test');

const { _internal } = require('../app/lib/dwg-tools.cjs');

function createDatabase(overrides = {}) {
  return {
    header: { INSUNITS: 6 },
    tables: {
      LAYER: {
        entries: [
          { name: '0', colorIndex: 7, colorName: '', off: false },
          { name: 'AccessNet', colorIndex: 4, colorName: '', off: false },
          { name: 'Geulinformatie', colorIndex: 6, colorName: '', off: false }
        ]
      }
    },
    entities: [],
    ...overrides
  };
}

test('PvE validator accepts the deterministic baseline', () => {
  const result = _internal.validatePveDatabase(createDatabase({
    entities: [{
      type: 'TEXT',
      handle: 'A1',
      layer: 'Geulinformatie',
      lineweight: 29,
      text: '2xHDPE40',
      width: 0,
      rotation: 0,
      startPoint: { x: 10, y: 10 }
    }]
  }));

  assert.deepEqual(result.summary, { errors: 0, warnings: 0, total: 0 });
});

test('PvE validator accepts both libredwg ByLayer encodings and ACI White', () => {
  const result = _internal.validatePveDatabase(createDatabase({
    tables: {
      LAYER: {
        entries: [{ name: '0', colorIndex: 7, colorName: 'White', off: false }]
      }
    },
    entities: [{
      type: 'LINE',
      handle: 'A2',
      layer: '0',
      lineweight: -1,
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 1, y: 1 }
    }]
  }));

  assert.equal(result.summary.total, 0);
});

test('PvE validator detects layer, units, lineweight and label violations', () => {
  const database = createDatabase({
    header: { INSUNITS: 4 },
    tables: {
      LAYER: {
        entries: [
          { name: '0', colorIndex: 256, colorName: 'RGB:255,255,255', off: false },
          { name: 'Address blocks', colorIndex: 7, colorName: '', off: true }
        ]
      }
    },
    entities: [
      {
        type: 'MTEXT',
        handle: 'B2',
        layer: 'Geulinformatie',
        lineweight: 17,
        text: '2XHDPE40',
        width: 8,
        rotation: Math.PI,
        startPoint: { x: 20, y: 30 }
      },
      {
        type: 'MLEADER',
        handle: 'B3',
        layer: 'Text',
        lineweight: 29,
        text: 'Nota',
        enableLanding: true,
        rotation: 0,
        startPoint: { x: 0, y: 0 }
      }
    ]
  });

  const result = _internal.validatePveDatabase(database);
  const codes = new Set(result.findings.map((finding) => finding.code));
  for (const code of [
    'PVE_LAYER_NOT_ALLOWED',
    'PVE_LAYER_OFF',
    'PVE_LAYER_ZERO_COLOR',
    'PVE_UNITS_NOT_METERS',
    'PVE_LINEWEIGHT_NOT_BYLAYER',
    'PVE_UPPERCASE_X',
    'PVE_GEUL_LABEL_WIDTH',
    'PVE_LABEL_INVERTED',
    'PVE_LEADER_EXTENSION'
  ]) {
    assert.ok(codes.has(code), `Expected ${code}`);
  }
  assert.equal(result.summary.warnings, 0);
  assert.equal(result.summary.errors, result.summary.total);
});

test('PvE validator reports missing nearby geulinformatie as a manual warning', () => {
  const database = createDatabase({
    entities: [
      {
        type: 'MLINE',
        handle: 'C1',
        layer: 'Drilling',
        lineweight: 29,
        startPoint: { x: 0, y: 0 },
        vertices: [
          { vertex: { x: 0, y: 0 } },
          { vertex: { x: 20, y: 0 } }
        ]
      },
      {
        type: 'MLINE',
        handle: 'C2',
        layer: 'Trench',
        lineweight: 29,
        startPoint: { x: 0, y: 10 },
        vertices: [
          { vertex: { x: 0, y: 10 } },
          { vertex: { x: 20, y: 10 } }
        ]
      }
    ]
  });

  const result = _internal.validatePveDatabase(database);
  assert.equal(result.summary.errors, 0);
  assert.equal(result.summary.warnings, 2);
  assert.equal(result.findings[0].code, 'PVE_GEULINFO_INCOMPLETE');
});

test('PvE validator accepts a material label close to an MLINE segment', () => {
  const database = createDatabase({
    entities: [
      {
        type: 'MLINE',
        handle: 'D1',
        layer: 'Drilling',
        lineweight: 29,
        startPoint: { x: 0, y: 0 },
        vertices: [
          { vertex: { x: 0, y: 0 } },
          { vertex: { x: 100, y: 0 } }
        ]
      },
      {
        type: 'TEXT',
        handle: 'D2',
        layer: 'Opmerking',
        lineweight: 29,
        text: 'HDPE50',
        rotation: 0,
        startPoint: { x: 50, y: 2 }
      }
    ]
  });

  const result = _internal.validatePveDatabase(database);
  assert.equal(result.summary.total, 0);
});

test('PvE Multileader audit parser preserves the relevant AutoCAD properties', () => {
  const [item] = _internal.parsePveMleaderAudit(
    'AB12\tGeulinformatie\t2XHDPE40\t4.5\t3.14159265\t:vlax-true\t-1\tISO geulinfo\t12.5\t20.25\n'
  );

  assert.deepEqual(item, {
    handle: 'AB12',
    layer: 'Geulinformatie',
    text: '2XHDPE40',
    width: 4.5,
    rotation: 3.14159265,
    enableLanding: true,
    lineweight: -1,
    styleName: 'ISO geulinfo',
    x: 12.5,
    y: 20.25
  });
});

test('PvE Multileader AutoLISP is read-only', () => {
  const lisp = _internal.buildPveMleaderAuditLisp({
    outputFilePath: 'C:\\Temp\\pve.tsv',
    progressFilePath: 'C:\\Temp\\pve.progress'
  });

  assert.match(lisp, /MULTILEADER/);
  assert.match(lisp, /EnableLanding/);
  assert.doesNotMatch(lisp, /entmake|entdel|vla-delete|qsave|purge/i);
});
