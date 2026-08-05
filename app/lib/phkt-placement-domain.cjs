const DEFAULT_PHKT_PLACEMENT_CONFIG = Object.freeze({
  vertexMergeTolerance: 0.01,
  rolVertexTolerance: 0.5,
  maxSearchRadius: 50,
  maxCandidates: 5,
  rolPriorityMargin: 2
});

function distance3d(left, right) {
  const dx = Number(left.x) - Number(right.x);
  const dy = Number(left.y) - Number(right.y);
  const dz = Number(left.z ?? 0) - Number(right.z ?? 0);
  return Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));
}

class SpatialIndex {
  constructor(cellSize) {
    this.cellSize = Math.max(Number(cellSize) || 1, Number.EPSILON);
    this.cells = new Map();
  }

  getCell(point) {
    return [
      Math.floor(Number(point.x) / this.cellSize),
      Math.floor(Number(point.y) / this.cellSize),
      Math.floor(Number(point.z ?? 0) / this.cellSize)
    ];
  }

  getKey(x, y, z) {
    return `${x}|${y}|${z}`;
  }

  insert(point, value) {
    const [x, y, z] = this.getCell(point);
    const key = this.getKey(x, y, z);
    const values = this.cells.get(key) ?? [];
    values.push(value);
    this.cells.set(key, values);
  }

  query(point, radius) {
    const [cx, cy, cz] = this.getCell(point);
    const cellRadius = Math.max(1, Math.ceil(Number(radius) / this.cellSize));
    const values = [];

    for (let x = cx - cellRadius; x <= cx + cellRadius; x += 1) {
      for (let y = cy - cellRadius; y <= cy + cellRadius; y += 1) {
        for (let z = cz - cellRadius; z <= cz + cellRadius; z += 1) {
          values.push(...(this.cells.get(this.getKey(x, y, z)) ?? []));
        }
      }
    }

    return values;
  }
}

function groupVertices(vertices, tolerance = DEFAULT_PHKT_PLACEMENT_CONFIG.vertexMergeTolerance) {
  const safeTolerance = Math.max(Number(tolerance) || 0, Number.EPSILON);
  const index = new SpatialIndex(safeTolerance);
  const candidates = [];

  for (const vertex of vertices) {
    const nearby = index.query(vertex, safeTolerance)
      .filter((candidate) => distance3d(candidate, vertex) <= safeTolerance)
      .sort((left, right) => distance3d(left, vertex) - distance3d(right, vertex));
    let candidate = nearby[0];

    if (!candidate) {
      candidate = {
        id: `V${String(candidates.length + 1).padStart(6, '0')}`,
        x: Number(vertex.x),
        y: Number(vertex.y),
        z: Number(vertex.z ?? 0),
        hasRol: false,
        references: []
      };
      candidates.push(candidate);
      index.insert(candidate, candidate);
    }

    candidate.references.push({
      polylineHandle: String(vertex.polylineHandle),
      vertexIndex: Number(vertex.vertexIndex),
      isEndpoint: Boolean(vertex.isEndpoint)
    });
  }

  for (const candidate of candidates) {
    const endpointCount = candidate.references.filter((reference) => reference.isEndpoint).length;
    candidate.kind = endpointCount === 0
      ? 'intermedio'
      : endpointCount === candidate.references.length
        ? 'extremo'
        : 'extremo/intermedio';
    candidate.polylineHandles = [...new Set(candidate.references.map((reference) => reference.polylineHandle))];
  }

  return candidates;
}

function associateRoles(candidates, roles, tolerance = DEFAULT_PHKT_PLACEMENT_CONFIG.rolVertexTolerance) {
  const safeTolerance = Math.max(Number(tolerance) || 0, Number.EPSILON);
  const index = new SpatialIndex(safeTolerance);
  const result = candidates.map((candidate) => ({ ...candidate, hasRol: Boolean(candidate.hasRol) }));
  result.forEach((candidate) => index.insert(candidate, candidate));

  for (const role of roles) {
    const nearest = index.query(role, safeTolerance)
      .map((candidate) => ({ candidate, distance: distance3d(candidate, role) }))
      .filter((item) => item.distance <= safeTolerance)
      .sort((left, right) => left.distance - right.distance)[0];
    if (nearest) {
      nearest.candidate.hasRol = true;
    }
  }

  return result;
}

function rankCandidates(textPoint, candidates, config = DEFAULT_PHKT_PLACEMENT_CONFIG, spatialIndex = null) {
  const maxRadius = Number(config.maxSearchRadius);
  const maximum = Math.max(1, Number(config.maxCandidates) || 1);
  const searchableCandidates = spatialIndex?.query(textPoint, maxRadius) ?? candidates;
  const ranked = searchableCandidates
    .map((candidate) => ({ ...candidate, distance: distance3d(textPoint, candidate) }))
    .filter((candidate) => candidate.distance <= maxRadius);

  if (ranked.length === 0) {
    return [];
  }

  const closestDistance = Math.min(...ranked.map((candidate) => candidate.distance));
  const rolMargin = Number(config.rolPriorityMargin) || 0;
  ranked.forEach((candidate) => {
    candidate.rolPreferred = candidate.hasRol && candidate.distance <= closestDistance + rolMargin;
  });
  ranked.sort((left, right) => {
    if (left.rolPreferred !== right.rolPreferred) {
      return left.rolPreferred ? -1 : 1;
    }
    return left.distance - right.distance || left.id.localeCompare(right.id);
  });
  return ranked.slice(0, maximum);
}

function buildPlacementModel(extraction, config = DEFAULT_PHKT_PLACEMENT_CONFIG) {
  const candidates = associateRoles(
    groupVertices(extraction.vertices ?? [], config.vertexMergeTolerance),
    extraction.roles ?? [],
    config.rolVertexTolerance
  );
  const candidateIndex = new SpatialIndex(Math.max(Number(config.maxSearchRadius) || 1, 1));
  candidates.forEach((candidate) => candidateIndex.insert(candidate, candidate));
  const texts = (extraction.texts ?? []).map((text) => ({
    ...text,
    candidates: rankCandidates(text.point, candidates, config, candidateIndex)
  }));
  return { config: { ...config }, texts, candidates };
}

function summarizeDecisions(texts, decisions) {
  const accepted = decisions.filter((decision) => decision.status === 'accepted');
  const assignmentCounts = new Map();
  accepted.forEach((decision) => {
    assignmentCounts.set(decision.candidateId, (assignmentCounts.get(decision.candidateId) ?? 0) + 1);
  });
  const counts = [...assignmentCounts.values()];
  return {
    selected: texts.length,
    assigned: accepted.length,
    manual: accepted.filter((decision) => decision.method === 'manual').length,
    skipped: decisions.filter((decision) => decision.status === 'skipped').length,
    withoutCandidates: texts.filter((text) => (text.candidates ?? []).length === 0).length,
    errors: decisions.filter((decision) => decision.status === 'error').length,
    sharedVertices: counts.filter((count) => count > 1).length,
    maximumAssignments: counts.length > 0 ? Math.max(...counts) : 0
  };
}

module.exports = {
  DEFAULT_PHKT_PLACEMENT_CONFIG,
  SpatialIndex,
  associateRoles,
  buildPlacementModel,
  distance3d,
  groupVertices,
  rankCandidates,
  summarizeDecisions
};
