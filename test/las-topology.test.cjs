const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

function runTopologyProbe() {
  const generatorPath = path.resolve(__dirname, '..', 'generate_mdb.ps1').replaceAll("'", "''");
  const script = `
$source = Get-Content -LiteralPath '${generatorPath}' -Raw
$start = $source.IndexOf('Set-StrictMode')
$end = $source.IndexOf('$resolvedFc =')
if ($start -lt 0 -or $end -le $start) { throw 'No se pudieron cargar las funciones del generador.' }
Invoke-Expression $source.Substring($start, $end - $start)

$fullSegment = [pscustomobject]@{ DpLabel = 'ASD-GUR-ODP001'; Stage = 0; MinFiber = 1; MaxFiber = 93 }
$fullLayout = Resolve-SegmentLayout -Segment $fullSegment -SegmentCount 1 -SegmentIndex 0 -NextSegment $null -ForceInternal $false
$internalLayout = Resolve-SegmentLayout -Segment $fullSegment -SegmentCount 1 -SegmentIndex 0 -NextSegment $null -ForceInternal $true
$fullSegment | Add-Member SegmentStart $fullLayout.SegmentStart
$fullSegment | Add-Member SegmentEnd $fullLayout.SegmentEnd
$fullSegment | Add-Member SegmentCassettes 8
$fullSegment | Add-Member CassetteType '4SE12-A'
$fullSegment | Add-Member IncomingCable 'ASD-GUR-B01-K01-S01'
$fullSegment | Add-Member OutgoingCable $null
$fullSegment | Add-Member HasFibersBeyond48 $fullLayout.HasFibersBeyond48
$fullSegment | Add-Member Customers @(
    [pscustomobject]@{ Fiber = 1; CableId = 'K-ASD-GUR-ODP001-KA01' },
    [pscustomobject]@{ Fiber = 49; CableId = 'K-ASD-GUR-ODP101-KA01' }
)
$model = [pscustomobject]@{ Chains = @([pscustomobject]@{ Suffix = 1; Segments = @($fullSegment) }) }
$las = @(Build-LasRows -Model $model)
$secondHalf = @($las | Where-Object { $_.KabelB -eq 'K-ASD-GUR-ODP101-KA01' } | Sort-Object VezelnrB)
$ambiguous = @(Get-AmbiguousInternalDpCandidates -Model $model)

$normalSegment = [pscustomobject]@{ Stage = 0; MinFiber = 1; MaxFiber = 45 }
$normalLayout = Resolve-SegmentLayout -Segment $normalSegment -SegmentCount 1 -SegmentIndex 0 -NextSegment $null -ForceInternal $false

[pscustomobject]@{
    Full = $fullLayout
    Internal = $internalLayout
    Normal = $normalLayout
    AmbiguousCount = $ambiguous.Count
    AmbiguousRequires96 = $ambiguous[0].Requires96Fibers
    SecondHalfRows = @($secondHalf | ForEach-Object {
        [pscustomobject]@{ Cassette = $_.Cassette; Position = $_.Positienr; FiberB = $_.VezelnrB; FiberA = $_.VezelnrA }
    })
} | ConvertTo-Json -Depth 6 -Compress
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encoded
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const jsonLine = result.stdout.trim().split(/\r?\n/).findLast((line) => line.trim().startsWith('{'));
  assert.ok(jsonLine, `No se obtuvo JSON de la prueba PowerShell:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(jsonLine);
}

test('a single physical DP with fibres above 48 uses the full 96-fibre LAS layout', { skip: process.platform !== 'win32' }, () => {
  const result = runTopologyProbe();

  assert.equal(result.Full.SegmentStart, 1);
  assert.equal(result.Full.SegmentEnd, 96);
  assert.equal(result.Full.IsFullCapacity, true);
  assert.equal(result.Full.IsInternal, false);
  assert.equal(result.Full.CapacityForcedByFiberData, true);
  assert.equal(result.Internal.IsInternal, true);
  assert.equal(result.Internal.IsFullCapacity, true);
  assert.equal(result.AmbiguousCount, 1);
  assert.equal(result.AmbiguousRequires96, true);
  assert.deepEqual(result.SecondHalfRows, [
    { Cassette: 13, Position: 1, FiberB: 1, FiberA: 49 },
    { Cassette: 5, Position: 1, FiberB: 2, FiberA: 0 }
  ]);
});

test('a single physical DP without second-half fibres keeps the 48-fibre layout', { skip: process.platform !== 'win32' }, () => {
  const result = runTopologyProbe();

  assert.equal(result.Normal.SegmentStart, 1);
  assert.equal(result.Normal.SegmentEnd, 48);
  assert.equal(result.Normal.IsFullCapacity, false);
});
