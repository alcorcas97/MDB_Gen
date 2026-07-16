const fiberDesktopApi = window.fiberApp ?? null;

const elements = {
  projectLabelCard: document.getElementById('projectLabelCard'),
  dpLabelCard: document.getElementById('dpLabelCard'),
  connectionCountCard: document.getElementById('connectionCountCard'),
  dpSelect: document.getElementById('dpSelect'),
  tubeCountInput: document.getElementById('tubeCountInput'),
  postcodeInput: document.getElementById('postcodeInput'),
  statusBanner: document.getElementById('statusBanner'),
  reloadButton: document.getElementById('reloadButton'),
  resetButton: document.getElementById('resetButton'),
  applyButton: document.getElementById('applyButton'),
  tubeList: document.getElementById('tubeList'),
  sourceCountStatus: document.getElementById('sourceCountStatus'),
  sourceCountDetail: document.getElementById('sourceCountDetail'),
  resolvedCard: document.getElementById('resolvedCard'),
  resolvedCountStatus: document.getElementById('resolvedCountStatus'),
  resolvedCountDetail: document.getElementById('resolvedCountDetail'),
  etCard: document.getElementById('etCard'),
  etCountStatus: document.getElementById('etCountStatus'),
  etCountDetail: document.getElementById('etCountDetail'),
  logOutput: document.getElementById('logOutput')
};

const SUBDUCT_TEMPLATES = {
  6: {
    ductType: '12V_GVK-IH_PR03',
    diameterDuct: 9,
    positions: ['RD1', 'WT1', 'GL1', 'BL1', 'GN1', 'VI1']
  },
  12: {
    ductType: '24V_GVK-IH_PR04',
    diameterDuct: 10,
    positions: ['RD1', 'WT1', 'GL1', 'BL1', 'GN1', 'VI1', 'BR1', 'ZW1', 'OR1', 'TQ1', 'RZ1', 'GS1']
  },
  24: {
    ductType: '48V_GVK-IH_PR04',
    diameterDuct: 12,
    positions: [
      'RD1', 'WT1', 'GL1', 'BL1', 'GN1', 'VI1', 'BR1', 'ZW1', 'OR1', 'TQ1', 'RZ1', 'GS1',
      'RD2', 'WT2', 'GL2', 'BL2', 'GN2', 'VI2', 'BR2', 'ZW2', 'OR2', 'TQ2', 'RZ2', 'GS2'
    ]
  }
};

const SUBDUCT_COLORS = {
  RD1: '#e24a4a',
  WT1: '#f2f2f2',
  GL1: '#f1cc28',
  BL1: '#297cf0',
  GN1: '#32b44a',
  VI1: '#8c47e6',
  BR1: '#9c5a26',
  ZW1: '#202020',
  OR1: '#ff8c13',
  TQ1: '#2ad0d4',
  RZ1: '#f058a6',
  GS1: '#b9bec7',
  RD2: '#be2e2e',
  WT2: '#d8d8d8',
  GL2: '#ccaa12',
  BL2: '#1257b9',
  GN2: '#1f8b36',
  VI2: '#6131a8',
  BR2: '#72401b',
  ZW2: '#000000',
  OR2: '#d97400',
  TQ2: '#1ea5a8',
  RZ2: '#c63f84',
  GS2: '#888f99'
};

const state = {
  fcPath: '',
  bcPath: '',
  projectFolderPath: '',
  data: null,
  tubes: [],
  loading: false,
  applying: false,
  rowValidationTimers: {},
  rowValidationCooldownMs: 2000,
  rowValidationSuspendedUntil: {}
};

function appendLog(message, tone = 'info') {
  const normalized = String(message ?? '').replace(/\r/g, '');
  const lines = normalized.split('\n').filter(Boolean);

  for (const line of lines) {
    const entry = document.createElement('div');
    entry.className = `log-line ${tone}`;
    entry.textContent = `[${new Date().toLocaleTimeString('es-ES')}] ${line}`;
    elements.logOutput.append(entry);
  }

  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function setStatus(message, tone = 'neutral') {
  elements.statusBanner.textContent = message;
  elements.statusBanner.dataset.tone = tone;
}

function setBusyState(isBusy) {
  state.loading = isBusy;
  elements.reloadButton.disabled = isBusy;
  elements.resetButton.disabled = isBusy;
  elements.applyButton.disabled = isBusy || state.applying;
  elements.dpSelect.disabled = isBusy;
  elements.tubeCountInput.disabled = isBusy;
  elements.postcodeInput.disabled = isBusy;
}

function normalizeText(value) {
  const text = String(value ?? '')
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/[\u00AD\u200B\u200C\u200D\u2060\uFEFF]/g, '')
    .trim();
  return text === '' ? null : text;
}

function normalizePostcode(value) {
  const text = normalizeText(value);
  return text ? text.replace(/\s+/g, '').toUpperCase() : null;
}

function getSelectedDpLabel() {
  return normalizeText(elements.dpSelect.value);
}

function parsePostcodes() {
  const seen = new Set();
  return String(elements.postcodeInput.value ?? '')
    .split(/[;,]/)
    .map((item) => normalizePostcode(item))
    .filter((item) => {
      if (!item || seen.has(item)) {
        return false;
      }

      seen.add(item);
      return true;
    });
}

function parseHouseInput(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const compact = normalized.replace(/\s+/g, '').toUpperCase();
  const match = compact.match(/^(\d+)([A-Z0-9-]*)$/);
  if (!match) {
    return null;
  }

  return {
    houseNumber: match[1],
    houseSuffix: match[2] || null,
    compact
  };
}

function buildEmptyTube(index, size = 12) {
  const template = SUBDUCT_TEMPLATES[size] ?? SUBDUCT_TEMPLATES[12];
  return {
    index,
    size,
    etCoordinate: null,
    rows: template.positions.map(() => ({
      houseInput: '',
      selectedCableId: ''
    }))
  };
}

function syncTubeShape(tube) {
  const template = SUBDUCT_TEMPLATES[tube.size] ?? SUBDUCT_TEMPLATES[12];
  const previousRows = Array.isArray(tube.rows) ? tube.rows : [];

  tube.rows = template.positions.map((_, rowIndex) => ({
    houseInput: previousRows[rowIndex]?.houseInput ?? '',
    selectedCableId: previousRows[rowIndex]?.selectedCableId ?? ''
  }));
}

function updateTubeCount(nextCount) {
  const safeCount = Math.max(1, Math.min(24, Number.parseInt(nextCount, 10) || 1));
  elements.tubeCountInput.value = String(safeCount);

  const nextTubes = [];
  for (let index = 1; index <= safeCount; index += 1) {
    const existingTube = state.tubes[index - 1];
    if (existingTube) {
      existingTube.index = index;
      syncTubeShape(existingTube);
      nextTubes.push(existingTube);
      continue;
    }

    nextTubes.push(buildEmptyTube(index, 12));
  }

  state.tubes = nextTubes;
}

function formatCoordinate(coordinate) {
  if (!coordinate) {
    return 'Pendiente de elegir en AutoCAD';
  }

  return `X ${coordinate.x.toFixed(4)} | Y ${coordinate.y.toFixed(4)} | Z ${coordinate.z.toFixed(4)}`;
}

function getRowKey(tubeIndex, rowIndex) {
  return `${tubeIndex}:${rowIndex}`;
}

function suspendRowValidation(tubeIndex, rowIndex) {
  state.rowValidationSuspendedUntil[getRowKey(tubeIndex, rowIndex)] = Date.now() + state.rowValidationCooldownMs;
}

function clearRowValidationSuspension(tubeIndex, rowIndex) {
  const rowKey = getRowKey(tubeIndex, rowIndex);
  delete state.rowValidationSuspendedUntil[rowKey];

  if (state.rowValidationTimers[rowKey]) {
    window.clearTimeout(state.rowValidationTimers[rowKey]);
    delete state.rowValidationTimers[rowKey];
  }
}

function scheduleRowValidation(tubeIndex, rowIndex) {
  const rowKey = getRowKey(tubeIndex, rowIndex);

  if (state.rowValidationTimers[rowKey]) {
    window.clearTimeout(state.rowValidationTimers[rowKey]);
  }

  suspendRowValidation(tubeIndex, rowIndex);
  state.rowValidationTimers[rowKey] = window.setTimeout(() => {
    delete state.rowValidationTimers[rowKey];
    delete state.rowValidationSuspendedUntil[rowKey];
    renderTubes();
  }, state.rowValidationCooldownMs);
}

function isRowValidationSuspended(tubeIndex, rowIndex) {
  const suspendedUntil = state.rowValidationSuspendedUntil[getRowKey(tubeIndex, rowIndex)] ?? 0;
  return suspendedUntil > Date.now();
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveRow(tubeIndex, rowIndex) {
  const tube = state.tubes[tubeIndex];
  const rowState = tube?.rows?.[rowIndex];
  const selectedDp = getSelectedDpLabel();
  const postcodes = parsePostcodes();
  const parsedHouse = parseHouseInput(rowState?.houseInput);

  if (!rowState || !normalizeText(rowState.houseInput)) {
    return { tone: 'neutral', status: 'empty' };
  }

  if (isRowValidationSuspended(tubeIndex, rowIndex)) {
    return {
      tone: 'neutral',
      status: 'typing',
      message: 'Escribiendo...'
    };
  }

  if (!parsedHouse) {
    return {
      tone: 'error',
      status: 'invalid',
      message: 'Formato inválido. Usa 24 o 24A.'
    };
  }

  if (postcodes.length === 0) {
    return {
      tone: 'warning',
      status: 'missing-postcodes',
      message: 'Añade primero al menos un código postal.'
    };
  }

  const allMatches = (state.data?.Connections ?? []).filter((connection) => {
    const postcode = normalizePostcode(connection.Postcode);
    const houseNumber = normalizeText(connection.HouseNumber);
    const houseSuffix = normalizeText(connection.HouseSuffix)?.replace(/\s+/g, '').toUpperCase() ?? null;

    return postcodes.includes(postcode)
      && houseNumber === parsedHouse.houseNumber
      && (houseSuffix ?? '') === (parsedHouse.houseSuffix ?? '');
  });

  const dpMatches = selectedDp
    ? allMatches.filter((connection) => normalizeText(connection.DpLabel) === selectedDp)
    : allMatches;
  const candidates = dpMatches.length > 0 ? dpMatches : allMatches;

  if (candidates.length === 0) {
    return {
      tone: 'error',
      status: 'not-found',
      message: 'No hay coincidencia en FC/BC para esa casa.'
    };
  }

  const selectedCableId = normalizeText(rowState.selectedCableId);
  if (selectedCableId) {
    const selectedCandidate = candidates.find((candidate) => normalizeText(candidate.CableId) === selectedCableId);
    if (selectedCandidate) {
      return {
        tone: 'success',
        status: 'resolved',
        candidate: selectedCandidate,
        candidates
      };
    }
  }

  if (candidates.length === 1) {
    return {
      tone: 'success',
      status: 'resolved',
      candidate: candidates[0],
      candidates
    };
  }

  return {
    tone: 'warning',
    status: 'ambiguous',
    candidates,
    message: `${candidates.length} posibles coincidencias. Elige el cable correcto.`
  };
}

function computeStats() {
  let usedRows = 0;
  let resolvedRows = 0;
  let ambiguousRows = 0;
  let invalidRows = 0;

  for (let tubeIndex = 0; tubeIndex < state.tubes.length; tubeIndex += 1) {
    const tube = state.tubes[tubeIndex];
    for (let rowIndex = 0; rowIndex < tube.rows.length; rowIndex += 1) {
      const rowState = tube.rows[rowIndex];
      if (!normalizeText(rowState.houseInput)) {
        continue;
      }

      usedRows += 1;
      const resolution = resolveRow(tubeIndex, rowIndex);
      if (resolution.status === 'resolved') {
        resolvedRows += 1;
      }
      else if (resolution.status === 'ambiguous') {
        ambiguousRows += 1;
      }
      else {
        invalidRows += 1;
      }
    }
  }

  const etDone = state.tubes.filter((tube) => tube.etCoordinate).length;
  return {
    usedRows,
    resolvedRows,
    ambiguousRows,
    invalidRows,
    etDone
  };
}

function updateSummary() {
  const projectLabel = normalizeText(state.data?.ProjectLabel) ?? 'Sin dato';
  const selectedDp = getSelectedDpLabel() ?? 'Pendiente';
  const connectionCount = Array.isArray(state.data?.Connections) ? state.data.Connections.length : 0;
  const stats = computeStats();

  elements.projectLabelCard.textContent = projectLabel;
  elements.dpLabelCard.textContent = selectedDp;
  elements.connectionCountCard.textContent = String(connectionCount);

  elements.sourceCountStatus.textContent = String(connectionCount);
  elements.sourceCountDetail.textContent = `${(state.data?.DpLabels ?? []).length} DP detectados en FC/BC`;

  elements.resolvedCard.dataset.tone = stats.ambiguousRows > 0 || stats.invalidRows > 0 ? 'warning' : stats.usedRows > 0 ? 'success' : 'neutral';
  elements.resolvedCountStatus.textContent = `${stats.resolvedRows}/${stats.usedRows}`;
  elements.resolvedCountDetail.textContent = stats.usedRows === 0
    ? 'Sin casas asignadas todavía'
    : `${stats.ambiguousRows} ambiguas | ${stats.invalidRows} sin resolver`;

  elements.etCard.dataset.tone = stats.etDone === state.tubes.length && state.tubes.length > 0 ? 'success' : stats.etDone > 0 ? 'warning' : 'neutral';
  elements.etCountStatus.textContent = `${stats.etDone}/${state.tubes.length}`;
  elements.etCountDetail.textContent = stats.etDone === state.tubes.length && state.tubes.length > 0
    ? 'Todos los ET ya tienen coordenadas'
    : 'Faltan coordenadas ET por elegir';
}

function renderTubeRow(tube, tubeIndex, rowIndex, subductLabel) {
  const resolution = resolveRow(tubeIndex, rowIndex);
  const candidate = resolution.candidate ?? null;
  const mainClass = resolution.status === 'resolved'
    ? 'success'
    : resolution.status === 'ambiguous' || resolution.status === 'missing-postcodes'
      ? 'warning'
      : resolution.status === 'empty'
        ? 'pending'
        : 'error';

  let resolveMain = 'Pendiente';
  let resolveDetail = 'Sin casa asignada';
  let selectHtml = '';

  if (resolution.status === 'resolved' && candidate) {
    resolveMain = candidate.CableId;
    resolveDetail = `${candidate.Postcode}-${candidate.HouseNumber}${candidate.HouseSuffix ?? ''} | ${candidate.DpLabel}`;
  }
  else if (resolution.status === 'ambiguous') {
    resolveMain = 'Selección manual';
    resolveDetail = resolution.message;
    selectHtml = `
      <select data-action="candidate" data-tube-index="${tubeIndex}" data-row-index="${rowIndex}">
        <option value="">Elegir Kabel ID...</option>
        ${resolution.candidates.map((item) => `
          <option value="${htmlEscape(item.CableId)}" ${normalizeText(tube.rows[rowIndex].selectedCableId) === normalizeText(item.CableId) ? 'selected' : ''}>
            ${htmlEscape(item.CableId)} | ${htmlEscape(item.Postcode)}-${htmlEscape(item.HouseNumber)}${htmlEscape(item.HouseSuffix ?? '')}
          </option>
        `).join('')}
      </select>
    `;
  }
  else if (resolution.status === 'typing') {
    resolveMain = 'Escribiendo...';
    resolveDetail = resolution.message;
  }
  else if (resolution.status === 'missing-postcodes' || resolution.status === 'invalid' || resolution.status === 'not-found') {
    resolveMain = 'Sin resolver';
    resolveDetail = resolution.message;
  }

  const color = SUBDUCT_COLORS[subductLabel] ?? '#cccccc';
  return `
    <div class="tube-grid-row" data-tone="${resolution.tone === 'neutral' ? '' : resolution.tone}">
      <div class="position-chip">${rowIndex + 1}</div>
      <div class="subduct-chip">
        <span class="subduct-dot" style="background:${color}"></span>
        <span>${htmlEscape(subductLabel)}</span>
      </div>
      <input
        type="text"
        spellcheck="false"
        placeholder="Casa / conexión"
        value="${htmlEscape(tube.rows[rowIndex].houseInput)}"
        data-action="house"
        data-tube-index="${tubeIndex}"
        data-row-index="${rowIndex}">
      <div class="resolve-cell">
        <div class="resolve-main ${mainClass}">${htmlEscape(resolveMain)}</div>
        <div class="resolve-detail">${htmlEscape(resolveDetail)}</div>
        ${selectHtml}
      </div>
    </div>
  `;
}

function renderTubes() {
  const selectedDp = getSelectedDpLabel() ?? '';

  elements.dpSelect.innerHTML = (state.data?.DpLabels ?? [])
    .map((dpLabel) => `<option value="${htmlEscape(dpLabel)}" ${dpLabel === selectedDp ? 'selected' : ''}>${htmlEscape(dpLabel)}</option>`)
    .join('');

  elements.tubeList.innerHTML = state.tubes.map((tube, tubeIndex) => {
    const template = SUBDUCT_TEMPLATES[tube.size] ?? SUBDUCT_TEMPLATES[12];
    const etLabel = `${selectedDp || 'DP'}-ET-${String(tube.index).padStart(2, '0')}`;
    return `
      <section class="tube-card">
        <div class="tube-head">
          <div class="tube-title">
            <h3>Tubo ${tube.index} (TK${String(tube.index).padStart(2, '0')})</h3>
            <p>${template.positions.length} posiciones | ${template.ductType}</p>
          </div>

          <label>
            <span>Tamaño del tubo</span>
            <select data-action="tube-size" data-tube-index="${tubeIndex}">
              ${Object.keys(SUBDUCT_TEMPLATES).map((size) => `
                <option value="${size}" ${Number(size) === tube.size ? 'selected' : ''}>${size} posiciones</option>
              `).join('')}
            </select>
          </label>

          <button class="button secondary" type="button" data-action="pick-et" data-tube-index="${tubeIndex}">
            Elegir ET
          </button>
        </div>

        <div class="tube-meta">
          <div class="coord-pill">${htmlEscape(etLabel)} | ${htmlEscape(formatCoordinate(tube.etCoordinate))}</div>
          <div class="coord-pill">Diam. ducto: ${template.diameterDuct} mm</div>
        </div>

        <div class="tube-grid">
          <div class="tube-grid-head">
            <div>Pos.</div>
            <div>Subduct</div>
            <div>Nº casa</div>
            <div>Resolución</div>
          </div>
          ${template.positions.map((subductLabel, rowIndex) => renderTubeRow(tube, tubeIndex, rowIndex, subductLabel)).join('')}
        </div>
      </section>
    `;
  }).join('');

  updateSummary();
}

function collectResolvedCableIds() {
  const seen = new Set();
  const updates = [];

  for (let tubeIndex = 0; tubeIndex < state.tubes.length; tubeIndex += 1) {
    const tube = state.tubes[tubeIndex];
    for (let rowIndex = 0; rowIndex < tube.rows.length; rowIndex += 1) {
      const resolution = resolveRow(tubeIndex, rowIndex);
      const cableId = normalizeText(resolution.candidate?.CableId);
      if (!cableId) {
        continue;
      }

      const key = cableId.toUpperCase();
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      updates.push({
        CableId: cableId,
        Kabeltype: '2V_GVK-IH_PR05'
      });
    }
  }

  return updates;
}

function buildApplyPayload() {
  const dpLabel = getSelectedDpLabel();
  const trajectRows = [];
  const accesspointRows = [];
  const ductRows = [];

  state.tubes.forEach((tube) => {
    const template = SUBDUCT_TEMPLATES[tube.size] ?? SUBDUCT_TEMPLATES[12];
    const trajectLabel = `${dpLabel}-TK${String(tube.index).padStart(2, '0')}-S01`;
    const etLabel = `${dpLabel}-ET-${String(tube.index).padStart(2, '0')}`;

    trajectRows.push({
      ID: tube.index,
      Label: trajectLabel,
      Locatie_A: dpLabel,
      Locatie_B: etLabel,
      Nauwkeurigheid: 0,
      ImportResult: null
    });

    accesspointRows.push({
      ID: tube.index,
      Label: etLabel,
      Accesspointtype: 'Kabelmanteleinde',
      X: tube.etCoordinate.x,
      Y: tube.etCoordinate.y,
      Z: tube.etCoordinate.z,
      Toelichting: '',
      Nauwkeurigheid: 0,
      ImportResult: null
    });

    template.positions.forEach((subductLabel, rowIndex) => {
      const resolution = resolveRow(tube.index - 1, rowIndex);
      const cableId = normalizeText(resolution.candidate?.CableId) ?? '';

      ductRows.push({
        ID: ductRows.length + 1,
        Duct: trajectLabel,
        DUCTTYPE: template.ductType,
        StandA: 0,
        StandB: 0,
        DIAMETERDUCT: template.diameterDuct,
        Traject: trajectLabel,
        Serienummer: '',
        SubDuct: subductLabel,
        DiameterSubDuct: 1,
        Kabel: cableId,
        PoortA: '',
        PoortB: '',
        ImportResult: null,
        OPMERKINGEN: null
      });
    });
  });

  return {
    fcPath: state.fcPath,
    bcPath: state.bcPath,
    projectFolderPath: state.projectFolderPath,
    dpLabel,
    tableRows: {
      Traject: trajectRows,
      Duct: ductRows,
      Accesspoint: accesspointRows
    },
    kabelTypeUpdates: collectResolvedCableIds()
  };
}

function validateBeforeApply() {
  if (!state.data) {
    return 'Todavía no se han cargado los datos base del riser.';
  }

  if (!getSelectedDpLabel()) {
    return 'Selecciona primero el DP del riser.';
  }

  if (parsePostcodes().length === 0) {
    return 'Indica al menos un código postal.';
  }

  for (const tube of state.tubes) {
    if (!tube.etCoordinate) {
      return `Faltan las coordenadas ET del tubo ${tube.index}.`;
    }
  }

  for (let tubeIndex = 0; tubeIndex < state.tubes.length; tubeIndex += 1) {
    const tube = state.tubes[tubeIndex];
    for (let rowIndex = 0; rowIndex < tube.rows.length; rowIndex += 1) {
      if (!normalizeText(tube.rows[rowIndex].houseInput)) {
        continue;
      }

      const resolution = resolveRow(tubeIndex, rowIndex);
      if (resolution.status !== 'resolved') {
        return `La posición ${rowIndex + 1} del tubo ${tube.index} no está resuelta todavía.`;
      }
    }
  }

  return null;
}

async function loadRiserData() {
  if (!fiberDesktopApi) {
    setStatus('La integracion de escritorio no esta disponible.', 'error');
    appendLog('window.fiberApp no esta disponible.', 'error');
    return;
  }

  setBusyState(true);
  setStatus('Leyendo FC y BC para preparar el riser...', 'neutral');
  appendLog(`Leyendo datos del riser desde ${state.projectFolderPath}`, 'meta');

  try {
    const data = await fiberDesktopApi.loadRiserData({
      fcPath: state.fcPath,
      bcPath: state.bcPath,
      projectFolderPath: state.projectFolderPath
    });

    state.data = data;
    if (!normalizeText(elements.postcodeInput.value)) {
      const suggestedPostcodes = [...new Set((data.Connections ?? []).slice(0, 8).map((item) => normalizePostcode(item.Postcode)).filter(Boolean))];
      elements.postcodeInput.value = suggestedPostcodes.join(', ');
    }

    updateTubeCount(elements.tubeCountInput.value);
    const initialDp = getSelectedDpLabel() ?? data.DpLabels?.[0] ?? '';
    elements.dpSelect.innerHTML = (data.DpLabels ?? [])
      .map((dpLabel) => `<option value="${htmlEscape(dpLabel)}" ${dpLabel === initialDp ? 'selected' : ''}>${htmlEscape(dpLabel)}</option>`)
      .join('');

    setStatus('Datos del riser cargados. Ya puedes asignar casas y elegir los ET.', 'success');
    appendLog(`Proyecto ${data.ProjectLabel} cargado con ${(data.Connections ?? []).length} conexiones y ${(data.DpLabels ?? []).length} DP.`, 'success');
    renderTubes();
  }
  catch (error) {
    setStatus(error.message, 'error');
    appendLog(error.message, 'error');
  }
  finally {
    setBusyState(false);
  }
}

async function pickEtCoordinate(tubeIndex) {
  if (!fiberDesktopApi) {
    return;
  }

  const tube = state.tubes[tubeIndex];
  const dpLabel = getSelectedDpLabel();
  if (!tube || !dpLabel) {
    setStatus('Selecciona primero el DP del riser.', 'warning');
    return;
  }

  setStatus(`Esperando selección en AutoCAD para ${dpLabel}-ET-${String(tube.index).padStart(2, '0')}...`, 'neutral');
  appendLog(`Esperando click en AutoCAD para ET del tubo ${tube.index}.`, 'meta');

  try {
    const coordinate = await fiberDesktopApi.pickRiserEtCoordinate({
      projectFolderPath: state.projectFolderPath,
      prompt: `Selecciona ${dpLabel}-ET-${String(tube.index).padStart(2, '0')}`
    });

    tube.etCoordinate = coordinate;
    setStatus(`ET del tubo ${tube.index} capturado correctamente.`, 'success');
    appendLog(`ET del tubo ${tube.index}: X=${coordinate.x}, Y=${coordinate.y}, Z=${coordinate.z}`, 'success');
    renderTubes();
  }
  catch (error) {
    setStatus(error.message, 'error');
    appendLog(error.message, 'error');
  }
}

async function applyRiser() {
  if (!fiberDesktopApi) {
    return;
  }

  const validationError = validateBeforeApply();
  if (validationError) {
    setStatus(validationError, 'warning');
    appendLog(validationError, 'warning');
    return;
  }

  const payload = buildApplyPayload();
  state.applying = true;
  elements.applyButton.disabled = true;
  setStatus('Aplicando riser en la base de datos...', 'neutral');
  appendLog(`Aplicando riser sobre ${payload.dpLabel}...`, 'meta');

  try {
    const result = await fiberDesktopApi.applyRiserData(payload);
    if (Array.isArray(result.missingCableIds) && result.missingCableIds.length > 0) {
      appendLog(`Cables no encontrados en Kabel: ${result.missingCableIds.join(', ')}`, 'warning');
    }

    setStatus(`Riser aplicado en ${result.mdbPath}.`, 'success');
    appendLog(
      `Riser aplicado en ${result.mdbPath}. Traject: ${result.trajectRowsAdded}. Duct: ${result.ductRowsAdded}. Accesspoint: ${result.accesspointRowsAdded}. Kabeltype actualizados: ${result.kabelUpdated}.`,
      'success'
    );
  }
  catch (error) {
    setStatus(error.message, 'error');
    appendLog(error.message, 'error');
  }
  finally {
    state.applying = false;
    elements.applyButton.disabled = false;
  }
}

function resetView() {
  updateTubeCount(1);
  elements.tubeCountInput.value = '1';
  renderTubes();
  setStatus('Vista de riser reiniciada. Los datos fuente siguen cargados.', 'neutral');
  appendLog('Vista reiniciada.', 'meta');
}

function handleTubeListChange(event) {
  const target = event.target;
  const action = target?.dataset?.action;
  const tubeIndex = Number.parseInt(target?.dataset?.tubeIndex ?? '-1', 10);
  const rowIndex = Number.parseInt(target?.dataset?.rowIndex ?? '-1', 10);

  if (action === 'tube-size' && state.tubes[tubeIndex]) {
    state.tubes[tubeIndex].size = Number.parseInt(target.value, 10) || 12;
    syncTubeShape(state.tubes[tubeIndex]);
    renderTubes();
    return;
  }

  if (action === 'house' && state.tubes[tubeIndex]?.rows[rowIndex]) {
    state.tubes[tubeIndex].rows[rowIndex].houseInput = target.value;
    if (!normalizeText(target.value)) {
      state.tubes[tubeIndex].rows[rowIndex].selectedCableId = '';
      clearRowValidationSuspension(tubeIndex, rowIndex);
      renderTubes();
      return;
    }

    scheduleRowValidation(tubeIndex, rowIndex);
    updateSummary();
    return;
  }

  if (action === 'candidate' && state.tubes[tubeIndex]?.rows[rowIndex]) {
    state.tubes[tubeIndex].rows[rowIndex].selectedCableId = target.value;
    renderTubes();
  }
}

function handleTubeListClick(event) {
  const button = event.target.closest('button[data-action="pick-et"]');
  if (!button) {
    return;
  }

  const tubeIndex = Number.parseInt(button.dataset.tubeIndex ?? '-1', 10);
  if (tubeIndex >= 0) {
    void pickEtCoordinate(tubeIndex);
  }
}

function initializePaths() {
  const query = new URLSearchParams(window.location.search);
  state.fcPath = String(query.get('fcPath') ?? '').trim();
  state.bcPath = String(query.get('bcPath') ?? '').trim();
  state.projectFolderPath = String(query.get('projectFolderPath') ?? '').trim();
}

async function initialize() {
  initializePaths();

  if (!fiberDesktopApi) {
    setStatus('La capa de escritorio no está disponible. Abre el ejecutable actualizado.', 'error');
    appendLog('window.fiberApp no esta disponible.', 'error');
    return;
  }

  if (!state.fcPath || !state.bcPath || !state.projectFolderPath) {
    setStatus('Faltan rutas base para abrir Riser. Vuelve a abrirlo desde la ventana principal.', 'error');
    appendLog('Rutas insuficientes para cargar Riser.', 'error');
    return;
  }

  updateTubeCount(1);
  renderTubes();
  await loadRiserData();
}

elements.reloadButton.addEventListener('click', () => {
  void loadRiserData();
});

elements.resetButton.addEventListener('click', () => {
  resetView();
});

elements.applyButton.addEventListener('click', () => {
  void applyRiser();
});

elements.tubeCountInput.addEventListener('change', () => {
  updateTubeCount(elements.tubeCountInput.value);
  renderTubes();
});

elements.postcodeInput.addEventListener('input', () => {
  renderTubes();
});

elements.dpSelect.addEventListener('change', () => {
  renderTubes();
  setStatus(`DP seleccionado: ${elements.dpSelect.value}`, 'neutral');
});

elements.tubeList.addEventListener('input', handleTubeListChange);
elements.tubeList.addEventListener('change', handleTubeListChange);
elements.tubeList.addEventListener('focusout', (event) => {
  const target = event.target;
  if (target?.dataset?.action !== 'house') {
    return;
  }

  const tubeIndex = Number.parseInt(target.dataset.tubeIndex ?? '-1', 10);
  const rowIndex = Number.parseInt(target.dataset.rowIndex ?? '-1', 10);
  if (tubeIndex < 0 || rowIndex < 0) {
    return;
  }

  clearRowValidationSuspension(tubeIndex, rowIndex);
  renderTubes();
});
elements.tubeList.addEventListener('click', handleTubeListClick);

void initialize();
