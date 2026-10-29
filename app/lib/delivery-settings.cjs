const fs = require('node:fs');
const path = require('node:path');

const PROJECT_MANAGERS = Object.freeze({
  pax: Object.freeze({ name: 'Pax', email: 'pleeuwvanweenen@vangelder.com' }),
  danny: Object.freeze({ name: 'Danny', email: 'dvanhee@vangelder.com' })
});

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function normalizeProjectManager(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return Object.hasOwn(PROJECT_MANAGERS, key) ? key : 'pax';
}

function normalizeDeliverySettings(value = {}) {
  return {
    ownerEmail: normalizeEmail(value.ownerEmail),
    projectManager: normalizeProjectManager(value.projectManager)
  };
}

function loadDeliverySettings(settingsPath) {
  try {
    if (!fs.existsSync(settingsPath)) {
      return normalizeDeliverySettings();
    }
    return normalizeDeliverySettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
  }
  catch {
    return normalizeDeliverySettings();
  }
}

function saveDeliverySettings(settingsPath, value) {
  const settings = normalizeDeliverySettings(value);
  if (settings.ownerEmail && !isValidEmail(settings.ownerEmail)) {
    throw new Error('Introduce un correo propio valido.');
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const temporaryPath = `${settingsPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, settingsPath);
  return settings;
}

function resolveDeliveryEmails(value) {
  const settings = normalizeDeliverySettings(value);
  if (!isValidEmail(settings.ownerEmail)) {
    throw new Error('Introduce tu correo antes de generar la MDB. Solo se pedira esta primera vez.');
  }

  const manager = PROJECT_MANAGERS[settings.projectManager];
  return {
    ...settings,
    projectManagerName: manager.name,
    projectManagerEmail: manager.email,
    instellingenValue: `${settings.ownerEmail}; ${manager.email}`
  };
}

module.exports = {
  PROJECT_MANAGERS,
  isValidEmail,
  loadDeliverySettings,
  normalizeDeliverySettings,
  resolveDeliveryEmails,
  saveDeliverySettings
};
