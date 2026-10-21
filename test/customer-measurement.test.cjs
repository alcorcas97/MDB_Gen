const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const generatorSource = fs.readFileSync(path.resolve(__dirname, '..', 'generate_mdb.ps1'), 'utf8');
const toolSource = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'mdb_tools.ps1'), 'utf8');

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start);
  assert.ok(start >= 0 && end > start, `No se encontró ${name}.`);
  return source.slice(start, end);
}

function resolveMeasurement(deliveryStatus, powermeter, ipFiberValue) {
  const normalizeText = functionSource(generatorSource, 'Normalize-Text', 'Normalize-Key');
  const normalizeMeasurement = functionSource(generatorSource, 'Normalize-Measurement', 'Resolve-CustomerMeasurement');
  const resolve = functionSource(generatorSource, 'Resolve-CustomerMeasurement', 'Parse-DateValue');
  const input = JSON.stringify({ deliveryStatus, powermeter, ipFiberValue }).replace(/'/g, "''");
  const script = `${normalizeText}\n${normalizeMeasurement}\n${resolve}\n$input = ConvertFrom-Json -InputObject '${input}'\nResolve-CustomerMeasurement -DeliveryStatus $input.deliveryStatus -Powermeter $input.powermeter -IpFiberValue $input.ipFiberValue`;
  const result = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() || null;
}

test('status 2 chooses and normalizes the valid customer measurement', () => {
  assert.equal(resolveMeasurement('2', '0,000', '1.75'), '1,75');
  assert.equal(resolveMeasurement('2', '0.0', '0'), '2,2');
  assert.equal(resolveMeasurement('2', '24.32', null), '-24,32');
  assert.equal(resolveMeasurement('2', '-23.18', null), '-23,18');
  assert.equal(resolveMeasurement('11', '24.32', '1.75'), null);
});

test('FC refresh replaces Dempingswaarde1A but preserves the remaining attenuation fields', () => {
  const preserved = functionSource(toolSource, 'Get-FcRefreshPreservedFieldNames', 'Get-DuctCableLookup');
  assert.doesNotMatch(preserved, /'Dempingswaarde1A'/);
  for (const field of [
    'Specificatie1A', 'Dempingswaarde1Z', 'Specificatie1Z',
    'Dempingswaarde2A', 'Specificatie2A', 'Dempingswaarde2Z', 'Specificatie2Z'
  ]) {
    assert.match(preserved, new RegExp(`'${field}'`));
  }
});
