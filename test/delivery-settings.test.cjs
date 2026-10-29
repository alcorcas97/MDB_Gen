const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  loadDeliverySettings,
  resolveDeliveryEmails,
  saveDeliverySettings
} = require('../app/lib/delivery-settings.cjs');

test('delivery settings persist the owner email and selected project manager', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fiber-delivery-settings-'));
  const settingsPath = path.join(temporaryDirectory, 'delivery-settings.json');

  try {
    saveDeliverySettings(settingsPath, {
      ownerEmail: ' User@ThePeopleGroup.nl ',
      projectManager: 'danny'
    });
    assert.deepEqual(loadDeliverySettings(settingsPath), {
      ownerEmail: 'user@thepeoplegroup.nl',
      projectManager: 'danny'
    });
  }
  finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Instellingen email contains exactly the owner and Pax or Danny', () => {
  assert.equal(
    resolveDeliveryEmails({ ownerEmail: 'user@thepeoplegroup.nl', projectManager: 'pax' }).instellingenValue,
    'user@thepeoplegroup.nl; pleeuwvanweenen@vangelder.com'
  );
  assert.equal(
    resolveDeliveryEmails({ ownerEmail: 'user@thepeoplegroup.nl', projectManager: 'danny' }).instellingenValue,
    'user@thepeoplegroup.nl; dvanhee@vangelder.com'
  );
  assert.throws(
    () => resolveDeliveryEmails({ ownerEmail: '', projectManager: 'pax' }),
    /Introduce tu correo/
  );
});

test('MDB generator rebuilds Instellingen instead of retaining template recipients', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'generate_mdb.ps1'), 'utf8');
  for (const token of [
    '[string]$OwnerEmail',
    '[string]$ProjectManagerEmail',
    "'Instellingen'",
    "Write-AccessTable -Database $database -TableName 'Instellingen' -Rows $settingsRows",
    '1 fila, 2 correos'
  ]) {
    assert.match(script, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(script, /bkragt@vangelder\.com/i);
});
