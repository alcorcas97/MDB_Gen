function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeStatus(value) {
  return normalizeText(value)?.toUpperCase() ?? null;
}

function parseCustomerCablePosition(value) {
  const cableId = normalizeText(value);
  const match = cableId?.match(/^(.*-ODP\d+)-KA(\d+)$/i);
  if (!match) {
    return null;
  }

  return {
    cableId,
    dpKey: match[1].toUpperCase(),
    position: Number.parseInt(match[2], 10)
  };
}

function buildFtuNeighborSuggestion(warning, customerRows, { radius = 5, limit = 8 } = {}) {
  const target = parseCustomerCablePosition(warning?.CableId);
  const allowed = [...new Set((warning?.Allowed ?? []).map(normalizeStatus).filter(Boolean))];
  if (!target || allowed.length === 0) {
    return { suggestion: null, counts: {}, neighbors: [] };
  }

  const neighbors = (customerRows ?? [])
    .map((row) => {
      const candidate = parseCustomerCablePosition(row?.Kabel);
      const location = normalizeStatus(row?.Kastnr);
      if (!candidate || candidate.dpKey !== target.dpKey || !allowed.includes(location)) {
        return null;
      }

      const distance = Math.abs(candidate.position - target.position);
      if (distance === 0 || distance > radius) {
        return null;
      }

      return {
        cableId: candidate.cableId,
        position: candidate.position,
        location,
        distance
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.distance - right.distance || left.position - right.position)
    .slice(0, limit);

  const counts = {};
  for (const neighbor of neighbors) {
    counts[neighbor.location] = (counts[neighbor.location] ?? 0) + 1;
  }

  const ranked = Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const suggestion = ranked.length > 0 && ranked[0][1] > neighbors.length / 2
    ? ranked[0][0]
    : null;

  return { suggestion, counts, neighbors };
}

function applyFtuReviewDecision(refreshData, warning, selectedLocation) {
  const cableId = normalizeText(warning?.CableId);
  const location = normalizeStatus(selectedLocation);
  const allowed = (warning?.Allowed ?? []).map(normalizeStatus).filter(Boolean);
  if (!cableId || !location || !allowed.includes(location)) {
    throw new Error('La decision FTU no es valida para esta conexion.');
  }

  const customer = (refreshData?.TableRows?.Klant ?? []).find((row) => normalizeStatus(row?.Kabel) === cableId.toUpperCase());
  const cable = (refreshData?.TableRows?.Kabel ?? []).find((row) => normalizeStatus(row?.Label) === cableId.toUpperCase());
  if (!customer || !cable) {
    throw new Error(`No se ha encontrado ${cableId} en los datos de refresco.`);
  }

  customer.Kastnr = location;
  if (normalizeText(warning?.DeliveryStatus) === '2') {
    customer.FTUType = 'FTU_TK01';
    cable.Afwerkeenheid_B = location;
  }
  else {
    cable.Afwerkeenheid_B = null;
  }

  refreshData.FtuReviewWarnings = (refreshData.FtuReviewWarnings ?? []).filter(
    (item) => normalizeStatus(item?.CableId) !== cableId.toUpperCase()
  );

  return {
    CableId: cableId,
    AddressCode: normalizeText(warning?.AddressCode),
    DeliveryStatus: normalizeText(warning?.DeliveryStatus),
    SelectedLocation: location
  };
}

module.exports = {
  applyFtuReviewDecision,
  buildFtuNeighborSuggestion,
  parseCustomerCablePosition
};
