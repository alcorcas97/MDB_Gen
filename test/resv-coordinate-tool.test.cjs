const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('RESV coordinate transfer avoids unsupported Access SQL and rejects zero DP coordinates', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'mdb_tools.ps1'), 'utf8');
  const start = source.indexOf('function Move-ResvCoordinatesToDp');
  const end = source.indexOf('function Set-OapCoordinate', start);
  assert.ok(start >= 0 && end > start, 'No se encontró Move-ResvCoordinatesToDp.');
  const functionSource = source.slice(start, end);

  assert.doesNotMatch(functionSource, /WHERE\s+UCASE\s*\(/i);
  assert.match(functionSource, /Normalize-UpperStatus[^\r\n]+Kastnr/);
  assert.match(functionSource, /Abs\(\[double\]\$x\)[^\r\n]+Abs\(\[double\]\$y\)/);
});
