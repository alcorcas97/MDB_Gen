const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Partial Delivery writes refreshed BC address and DP data into Klant and Kabel', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'mdb_tools.ps1'), 'utf8');
  const start = source.indexOf('function Apply-PartialDelivery');
  const end = source.indexOf('$context = Open-Database', start);
  const body = source.slice(start, end);

  assert.match(body, /\$customer\.Postcode\s*=\s*Normalize-Text \$edit\.postcode/);
  assert.match(body, /\$customer\.Huisnr\s*=\s*\$houseNumber/);
  assert.match(body, /\$customer\.Toevoeging\s*=\s*Normalize-Text \$edit\.houseSuffix/);
  assert.match(body, /\$customer\.KAMER\s*=\s*Normalize-Text \$edit\.room/);
  assert.match(body, /\$cable\[0\]\.Locatienaam_A\s*=\s*\$dpLabel/);
  assert.match(body, /\$cable\[0\]\.Locatienaam_B\s*=\s*\(\$addressParts -join '-'\)/);
  assert.match(body, /\$editStatusCode -eq '2'/);
  assert.match(body, /if \(\$isTerminatedCustomer\).*Convert-ToDempingText/s);
});

test('Partial regeneration backs up the previous project without merging its connections', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'main.cjs'), 'utf8');
  const start = source.indexOf('async function generatePartialDelivery');
  const end = source.indexOf('function runPowerShellFile', start);
  const body = source.slice(start, end);

  assert.match(body, /const connections = \(payload\?\.connections \?\? \[\]\)/);
  assert.doesNotMatch(body, /existingData\?\.connections|const merged = new Map/);
  assert.match(body, /await fsp\.rename\(targetProjectPath, previousProjectBackupPath\)/);
});
