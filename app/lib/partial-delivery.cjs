const path = require('node:path');
const { parse } = require('csv-parse/sync');

function normalizeText(value) {
  const text = String(value ?? '')
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/[\u00AD\u200B\u200C\u200D\u2060\uFEFF]/g, '')
    .trim();
  return text || null;
}

function normalizeIdentifier(value) {
  return normalizeText(value)?.replace(/\s+/g, '').toUpperCase() ?? null;
}

function parseSelectionText(value) {
  const seen = new Set();
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .split(/[\r\n;,]+/)
    .map((item) => normalizeText(item))
    .filter((item) => {
      const key = normalizeIdentifier(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function parseBcCsv(value) {
  const rows = parse(String(value ?? '').replace(/^\uFEFF/, ''), {
    delimiter: ';', columns: true, skip_empty_lines: true, bom: true, relax_column_count: true, trim: true
  });
  return rows.map((row) => {
    const get = (...names) => {
      for (const name of names) {
        const value = row[name];
        if (normalizeText(value)) return normalizeText(value);
      }
      return null;
    };
    const rawCableId = get('KabelID', 'Kabel ID');
    const kabelId = rawCableId && /^K-/i.test(rawCableId) ? `K-${rawCableId.slice(2)}` : rawCableId ? `K-${rawCableId}` : null;
    const postcode = get('Postcode');
    const houseNumber = get('Huisnummer');
    const houseSuffix = get('HuisnummerToevoeging', 'Huisnummer Toevoeging');
    const room = get('Kamer');
    const phkt = [postcode, houseNumber, houseSuffix, room].filter(Boolean).join('-');
    const dpMatch = kabelId?.match(/^(?:K-)?(.+?-DP\d+)/i);
    return {
      kabelId, phkt, postcode, houseNumber, houseSuffix, room,
      statusCode: get('Opleverstatus', 'Opleverstatus KPN'),
      ftuType: get('FTU-Type'),
      dpLabel: dpMatch ? dpMatch[1] : null,
      odf: get('ODF'),
      fiber: get('ODFpositie', 'ODF Positie'),
      strengId: get('StrengID'),
      buildingType: get('Gebouwtype', 'Gebouwtype hoog laag etc')
    };
  }).filter((row) => row.kabelId);
}

function getConnectionSearchText(connection) {
  return [
    connection?.kabelId,
    connection?.phkt,
    connection?.postcode,
    connection?.houseNumber,
    connection?.houseSuffix,
    connection?.room,
    connection?.complex,
    connection?.dpLabel,
    connection?.kastnr
  ].map((item) => normalizeText(item) ?? '').join(' ').toUpperCase();
}

function resolveSelectionIdentifiers(connections, identifiers, { expandComplex = true } = {}) {
  const allConnections = Array.isArray(connections) ? connections : [];
  const requested = Array.isArray(identifiers) ? identifiers : parseSelectionText(identifiers);
  const byIdentifier = new Map();

  for (const connection of allConnections) {
    for (const candidate of [connection?.kabelId, connection?.phkt]) {
      const key = normalizeIdentifier(candidate);
      if (!key) continue;
      const matches = byIdentifier.get(key) ?? [];
      matches.push(connection);
      byIdentifier.set(key, matches);
    }
  }

  const directMatches = [];
  const unmatched = [];
  for (const identifier of requested) {
    const matches = byIdentifier.get(normalizeIdentifier(identifier)) ?? [];
    if (matches.length === 0) {
      unmatched.push(identifier);
      continue;
    }
    directMatches.push(...matches);
  }

  const selectedByCable = new Map();
  for (const match of directMatches) {
    const complex = normalizeText(match?.complex);
    const expanded = expandComplex && complex
      ? allConnections.filter((item) => normalizeText(item?.complex)?.toUpperCase() === complex.toUpperCase())
      : [match];
    for (const connection of expanded) {
      const key = normalizeIdentifier(connection?.kabelId);
      if (key) selectedByCable.set(key, connection);
    }
  }

  return {
    selected: [...selectedByCable.values()],
    directMatches,
    unmatched
  };
}

function buildNextPartialProjectName(sourceName) {
  const normalized = normalizeText(sourceName);
  if (!normalized) throw new Error('No se puede calcular el nombre del Partial Delivery.');
  const match = normalized.match(/^(.*)-([A-Z])$/i);
  if (!match) return `${normalized}-A`;
  const currentCode = match[2].toUpperCase().charCodeAt(0);
  if (currentCode >= 65 && currentCode < 90) return `${match[1]}-${String.fromCharCode(currentCode + 1)}`;
  return `${normalized}-A`;
}

function derivePartialTargetPath(sourceProjectPath) {
  const resolved = path.resolve(String(sourceProjectPath ?? ''));
  return path.join(path.dirname(resolved), buildNextPartialProjectName(path.basename(resolved)));
}

module.exports = {
  buildNextPartialProjectName,
  derivePartialTargetPath,
  getConnectionSearchText,
  normalizeIdentifier,
  normalizeText,
  parseSelectionText,
  parseBcCsv,
  resolveSelectionIdentifiers
};
