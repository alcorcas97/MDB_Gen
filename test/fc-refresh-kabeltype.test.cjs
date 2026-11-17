const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const toolPath = path.resolve(__dirname, '..', 'app', 'mdb_tools.ps1');
const source = fs.readFileSync(toolPath, 'utf8');

function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start);
  assert.ok(start >= 0 && end > start, `No se encontró ${name}.`);
  return source.slice(start, end);
}

function sourceKabeltypeAllowed(existingRows, targetRows) {
  const helper = functionSource('Test-FcRefreshKabeltypeSourceAllowed', 'Merge-FcRefreshRow');
  const input = JSON.stringify({ existingRows, targetRows }).replace(/'/g, "''");
  const script = `
function Normalize-Text { param([object]$Value) if ($null -eq $Value) { return $null }; $text = ([string]$Value).Trim(); if ($text.Length -eq 0) { return $null }; return $text }
function Normalize-UpperStatus { param([object]$Value) $text = Normalize-Text $Value; if ($null -eq $text) { return $null }; return $text.ToUpperInvariant() }
${helper}
$input = ConvertFrom-Json -InputObject '${input}'
Test-FcRefreshKabeltypeSourceAllowed -ExistingCustomerRows @($input.existingRows) -TargetCustomerRows @($input.targetRows)
`;
  const result = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() === 'True';
}

function distributionCableMatch(sourceRow, existingRows) {
  const normalizeText = functionSource('Normalize-Text', 'Get-JsonPropertyValue');
  const normalizeStatus = functionSource('Normalize-UpperStatus', 'Resolve-CustomerCableType');
  const distribution = functionSource('Test-FcRefreshDistributionCable', 'Merge-FcRefreshRow');
  const input = JSON.stringify({ sourceRow, existingRows }).replace(/'/g, "''");
  const script = `
${normalizeText}
${normalizeStatus}
${distribution}
$input = ConvertFrom-Json -InputObject '${input}'
$lookup = @{}
foreach ($row in @($input.existingRows)) { Add-FcRefreshDistributionCableRowByRoute -Lookup $lookup -Row $row }
$match = Find-FcRefreshDistributionCableMatch -SourceRow $input.sourceRow -ExistingRowsByRoute $lookup
if ($null -ne $match) { $match.Label }
`;
  const result = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() || null;
}

function assertUniqueFcKeys(tableName, rows) {
  const normalizeText = functionSource('Normalize-Text', 'Get-JsonPropertyValue');
  const syncKey = functionSource('Get-ConnectionSyncKey', 'Get-ConnectionSyncPreservedFieldNames');
  const validation = functionSource('Assert-FcRefreshUniqueKeys', 'Get-FcRefreshPreservedFieldNames');
  const input = JSON.stringify({ rows }).replace(/'/g, "''");
  const script = `
${normalizeText}
${syncKey}
${validation}
$input = ConvertFrom-Json -InputObject '${input}'
try {
  Assert-FcRefreshUniqueKeys -TableName '${tableName}' -Rows @($input.rows) -Origin 'test'
  'ok'
}
catch {
  $_.Exception.Message
  exit 2
}
`;
  const result = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  return { status: result.status, output: result.stdout.trim() };
}

test('FC refresh only accepts a source Kabeltype for RESV to non-RESV final Klant transitions', () => {
  assert.equal(sourceKabeltypeAllowed([{ Kabel: 'KA-1', Kastnr: 'RESV' }], [{ Kabel: 'KA-1', Kastnr: 'MTK' }]), true);
  assert.equal(sourceKabeltypeAllowed([{ Kabel: 'KA-1', Kastnr: 'RESV' }], [{ Kabel: 'KA-1', Kastnr: 'RESV' }]), false);
  assert.equal(sourceKabeltypeAllowed([{ Kabel: 'KA-1', Kastnr: 'RESV' }], [{ Kabel: 'KA-1', Kastnr: null }]), false);
  assert.equal(sourceKabeltypeAllowed([{ Kabel: 'KA-1', Kastnr: 'GV' }], [{ Kabel: 'KA-1', Kastnr: 'MTK' }]), false);
});

test('FC refresh indexes final merged Klant rows by normalized cable and keeps Duct cables protected', () => {
  const apply = functionSource('Apply-FcRefresh', 'Export-PartialDeliveryData');

  assert.match(apply, /Add-FcRefreshCustomerRowByCableId\s+-Lookup\s+\$targetCustomersByCableId\s+-Row\s+\$mergedRow/);
  assert.match(apply, /Test-FcRefreshKabeltypeSourceAllowed\s+-ExistingCustomerRows\s+\$existingCustomerRowsForCable\s+-TargetCustomerRows\s+\$targetCustomerRowsForCable/);
  assert.match(apply, /if\s*\(\$isDuctCable\s+-or\s+-not\s+\$shouldAcceptSourceKabeltype\)\s*\{\s*\$mergedRow\.Kabeltype\s*=\s*\$existingRow\.Kabeltype/s);
});

test('FC refresh preserves an existing 96V Label by its stable route, while customer cables stay label-matched', () => {
  const source96v = {
    Label: 'B02-K01', Kabeltype: '96V_LTMC_PR02', Locatienaam_A: 'RT-CLY', Locatienaam_B: 'DP-02',
    Afwerkeenheid_A: '101', Afwerkeenheid_B: 'DP-02'
  };
  const existing96v = { ...source96v, Label: 'B02-K02' };
  const customer = {
    Label: 'CUSTOMER-1', Kabeltype: '2V_DBC_PR01', Locatienaam_A: 'DP-02', Locatienaam_B: 'Street 1',
    Afwerkeenheid_A: 'DP-02', Afwerkeenheid_B: 'MTK'
  };

  assert.equal(distributionCableMatch(source96v, [existing96v]), 'B02-K02');
  assert.equal(distributionCableMatch(customer, [existing96v]), null);
});

test('FC refresh only remaps parallel 96V routes when topology identifies one segment', () => {
  const source = {
    Label: 'B02-K01', Kabeltype: '96V_LTMC_PR02', Locatienaam_A: 'DP-01', Locatienaam_B: 'DP-02',
    Afwerkeenheid_A: 'A', Afwerkeenheid_B: 'B'
  };
  const topologyMatch = { ...source, Label: 'B02-K02' };
  const otherParallelRoute = { ...source, Label: 'B02-K03', Afwerkeenheid_A: 'C', Afwerkeenheid_B: 'D' };
  const ambiguousParallelRoute = { ...source, Label: 'B02-K04' };

  assert.equal(distributionCableMatch(source, [topologyMatch, otherParallelRoute]), 'B02-K02');
  assert.equal(distributionCableMatch(source, [topologyMatch, ambiguousParallelRoute]), null);
});

test('FC refresh rejects duplicate base keys while allowing parallel 96V route labels', () => {
  assert.deepEqual(assertUniqueFcKeys('Klant', [{ Kabel: 'KA-1' }, { Kabel: ' ka-1 ' }]), {
    status: 2,
    output: 'Claves duplicadas de Klant en test: ka-1'
  });
  assert.deepEqual(assertUniqueFcKeys('Kabel', [
    { Label: 'B02-K02', Kabeltype: '96V', Locatienaam_A: 'DP-01', Locatienaam_B: 'DP-02' },
    { Label: 'B02-K03', Kabeltype: '96V', Locatienaam_A: 'DP-01', Locatienaam_B: 'DP-02' }
  ]), { status: 0, output: 'ok' });
});

test('FC refresh applies only DAO deltas and preserves existing AutoNumber IDs', () => {
  const applyStart = source.indexOf('function Apply-FcRefresh {');
  const applyEnd = source.indexOf('function Apply-ConnectionSync', applyStart);
  assert.ok(applyStart >= 0 && applyEnd > applyStart, 'No se encontró Apply-FcRefresh.');
  const apply = source.slice(applyStart, applyEnd);
  const deltaStart = source.indexOf('function Apply-FcRefreshDeltas');
  const deltaEnd = source.indexOf('function Apply-FcRefresh {', deltaStart);
  assert.ok(deltaStart >= 0 && deltaEnd > deltaStart, 'No se encontró Apply-FcRefreshDeltas.');
  const deltas = source.slice(deltaStart, deltaEnd);

  assert.doesNotMatch(apply, /Reset-ConnectionSyncIds/);
  assert.doesNotMatch(apply, /Clear-AccessTables/);
  assert.match(apply, /Assert-FcRefreshUniqueKeys\s+-TableName 'Klant'\s+-Rows \$sourceCustomerRows/);
  assert.match(apply, /Assert-FcRefreshUniqueKeys\s+-TableName 'Kabel'\s+-Rows \$existingCableRows/);
  assert.match(apply, /-Workspace \$Workspace/);
  assert.match(apply, /Dos filas objetivo de Klant pretenden el ID existente/);
  assert.match(apply, /Dos filas objetivo de Kabel pretenden el ID existente/);
  assert.match(apply, /Apply-FcRefreshDeltas/);
  assert.match(deltas, /Remove-AccessRowsById[\s\S]*TableName 'Klant'/);
  assert.match(deltas, /Remove-AccessRowsById[\s\S]*TableName 'Kabel'/);
  assert.match(deltas, /Write-AccessTable[\s\S]*TableName 'Kabel'/);
  assert.match(deltas, /Write-AccessTable[\s\S]*TableName 'Klant'/);
  assert.match(deltas, /BeginTrans\(\)/);
  assert.match(deltas, /Rollback\(\)/);
  assert.match(deltas, /No se puede aplicar el refresco FC sin un DAO Workspace transaccional/);
  assert.doesNotMatch(source, /function Get-DaoWorkspace/);
});

test('FC refresh context opens a DAO Workspace explicitly and dispatch passes it through', () => {
  const open = functionSource('Open-Database', 'Close-DatabaseContext');
  const close = functionSource('Close-DatabaseContext', 'Get-KabelLocationMap');

  assert.match(open, /\$workspace = \$dao\.Workspaces\.Item\(0\)/);
  assert.match(open, /\$database = \$workspace\.OpenDatabase\(\$resolvedPath\)/);
  assert.match(open, /\$accessApplication\.DBEngine\.Workspaces\.Item\(0\)/);
  assert.match(open, /Workspace = \$workspace/);
  assert.match(close, /ReleaseComObject\(\$Context\.Workspace\)/);
  assert.match(source, /Apply-FcRefresh -Database \$context\.Database -Workspace \$context\.Workspace -Path \$AssignmentsPath/);
});

test('FC refresh writes only changed fields and can explicitly clear a value to NULL', () => {
  const update = functionSource('Update-AccessRowFields', 'Remove-AccessRowsById');
  const setValue = functionSource('Set-AccessFieldValue', 'Write-AccessTable');

  assert.match(update, /foreach \(\$fieldName in \$FieldNames\)/);
  assert.match(update, /-ExplicitNull:\(\$null -eq \$targetValue\)/);
  assert.match(setValue, /\[switch\]\$ExplicitNull/);
  assert.match(setValue, /\[System\.DBNull\]::Value/);
});
