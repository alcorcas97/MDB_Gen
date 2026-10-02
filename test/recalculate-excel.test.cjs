const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Excel recalculation script rebuilds, saves, closes, and releases COM', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'recalculate_excel.ps1'), 'utf8');

  assert.match(source, /\[string\]\$WorkbookPath/);
  assert.match(source, /New-Object -ComObject Excel\.Application/);
  assert.match(source, /\$excel\.CalculateFullRebuild\(\)/);
  assert.match(source, /\$workbook\.Save\(\)/);
  assert.match(source, /\$workbook\.Close\(\$false\)/);
  assert.match(source, /FinalReleaseComObject\(\$workbook\)/);
  assert.match(source, /FinalReleaseComObject\(\$workbooks\)/);
  assert.match(source, /\$excel\.Quit\(\)/);
  assert.match(source, /FinalReleaseComObject\(\$excel\)/);
  assert.match(source, /\[GC\]::WaitForPendingFinalizers\(\)/);
});

test('cross check export recalculates before returning and treats Excel as optional', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'main.cjs'), 'utf8');
  const start = source.indexOf('async function exportCrossCheckWorkbook(payload)');
  const end = source.indexOf('async function applyOapCoordinateToMdb', start);
  const body = source.slice(start, end);

  assert.match(source, /const recalculateExcelScriptPath = path\.join\(appRoot, 'app', 'recalculate_excel\.ps1'\)/);
  assert.match(body, /await recalculateCrossCheckWorkbook\(result\.outputPath\)/);
  assert.match(source, /level: 'warning'/);
});
