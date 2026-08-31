const api = window.fiberApp ?? null;
const elements = {
  sourceProjectPath: document.getElementById('sourceProjectPath'), targetProjectPath: document.getElementById('targetProjectPath'),
  backupFolderPath: document.getElementById('backupFolderPath'), browseSourceButton: document.getElementById('browseSourceButton'),
  browseTargetButton: document.getElementById('browseTargetButton'), browseBackupButton: document.getElementById('browseBackupButton'),
  reloadButton: document.getElementById('reloadButton'), statusBanner: document.getElementById('statusBanner'),
  availableCount: document.getElementById('availableCount'), selectedCount: document.getElementById('selectedCount'), complexCount: document.getElementById('complexCount'),
  expandComplexInput: document.getElementById('expandComplexInput'), searchInput: document.getElementById('searchInput'), searchResults: document.getElementById('searchResults'),
  manualInput: document.getElementById('manualInput'), addManualButton: document.getElementById('addManualButton'), importTxtButton: document.getElementById('importTxtButton'),
  importBcButton: document.getElementById('importBcButton'),
  importSummary: document.getElementById('importSummary'), selectedRows: document.getElementById('selectedRows'), clearSelectionButton: document.getElementById('clearSelectionButton'),
  ftuTypeOptions: document.getElementById('ftuTypeOptions'), generateButton: document.getElementById('generateButton'), openOutputButton: document.getElementById('openOutputButton'), logOutput: document.getElementById('logOutput')
};
const state = { connections: [], selected: new Map(), loadedSource: '', running: false, lastOutput: null };

function normalize(value) { return String(value ?? '').replace(/[\u00A0\u202F]/g, ' ').trim(); }
function key(value) { return normalize(value).replace(/\s+/g, '').toUpperCase().replace(/^K-/, ''); }
function basename(value) { const text = normalize(value); const index = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/')); return index >= 0 ? text.slice(index + 1) : text; }
function dirname(value) { const text = normalize(value); const index = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/')); return index >= 0 ? text.slice(0, index) : ''; }
function joinPath(parent, child) { return `${normalize(parent).replace(/[\\/]+$/, '')}\\${normalize(child).replace(/^[\\/]+/, '')}`; }
function formatAddress(item) { return [item.postcode, item.houseNumber, item.houseSuffix, item.room].map(normalize).filter(Boolean).join('-') || normalize(item.phkt) || 'Sin dirección'; }
function searchable(item) { return [item.kabelId, item.phkt, formatAddress(item), item.dpLabel, item.complex, item.kastnr, item.bcFiber, item.strengId].map(normalize).join(' ').toUpperCase(); }
function parseIdentifiers(text) { const seen = new Set(); return String(text ?? '').replace(/^\uFEFF/, '').split(/[\r\n;,]+/).map(normalize).filter((item) => { const id = key(item); if (!id || seen.has(id)) return false; seen.add(id); return true; }); }
function setStatus(message, tone = 'neutral') { elements.statusBanner.textContent = message; elements.statusBanner.dataset.tone = tone; }
function appendLog(message, tone = 'info') { for (const line of String(message ?? '').replace(/\r/g, '').split('\n').filter(Boolean)) { const row = document.createElement('div'); row.className = `log-line ${tone}`; row.textContent = `[${new Date().toLocaleTimeString('es-ES')}] ${line}`; elements.logOutput.append(row); } elements.logOutput.scrollTop = elements.logOutput.scrollHeight; }
function setBusy(running) { state.running = running; for (const element of [elements.sourceProjectPath, elements.targetProjectPath, elements.backupFolderPath, elements.browseSourceButton, elements.browseTargetButton, elements.browseBackupButton, elements.reloadButton, elements.expandComplexInput, elements.searchInput, elements.manualInput, elements.addManualButton, elements.importTxtButton, elements.importBcButton, elements.clearSelectionButton, elements.generateButton]) element.disabled = running; elements.openOutputButton.disabled = running || !state.lastOutput; }

function updateStats() {
  elements.availableCount.textContent = String(state.connections.length);
  elements.selectedCount.textContent = String(state.selected.size);
  elements.complexCount.textContent = String(new Set([...state.selected.values()].map((item) => normalize(item.complex)).filter(Boolean)).size);
}

function renderSelected() {
  const items = [...state.selected.values()].sort((a, b) => formatAddress(a).localeCompare(formatAddress(b), 'es', { numeric: true }));
  if (items.length === 0) elements.selectedRows.innerHTML = '<tr><td colspan="11" class="empty-cell">Todavía no hay conexiones seleccionadas.</td></tr>';
  else elements.selectedRows.innerHTML = items.map((item) => `<tr data-connection="${escapeHtml(item.kabelId)}"><td><strong>${escapeHtml(formatAddress(item))}</strong><br><small>${escapeHtml(item.phkt ?? '')}</small></td><td>${escapeHtml(item.kabelId)}</td><td>${escapeHtml(item.dpLabel ?? '')}</td><td>${escapeHtml(item.complex ?? 'Individual')}</td><td><select class="connection-edit status-edit" data-field="status">${renderStatusOptions(item.kastnr)}</select></td><td><input class="connection-edit ftu-edit" data-field="ftuType" list="ftuTypeOptions" value="${escapeHtml(item.ftuType ?? '')}" placeholder="Sin FTU"></td>${['demping1A', 'demping1Z', 'demping2A', 'demping2Z'].map((field) => `<td><input class="connection-edit demping-edit" data-field="${field}" type="number" step="0.01" value="${escapeHtml(item[field] ?? '')}" placeholder="—"></td>`).join('')}<td><button class="remove-connection" data-cable="${escapeHtml(item.kabelId)}" title="Eliminar" type="button">×</button></td></tr>`).join('');
  updateStats();
}

function renderStatusOptions(currentValue) {
  const current = normalize(currentValue).toUpperCase();
  const values = ['', 'GV', 'MTK', 'WNK', 'ANDE', 'KLDR', 'EG', 'GL', 'RESV', 'IHB', 'SMK', 'SWON', 'XXXX'];
  if (current && !values.includes(current)) values.push(current);
  return values.map((value) => `<option value="${escapeHtml(value)}"${value === current ? ' selected' : ''}>${escapeHtml(value || 'Sin status')}</option>`).join('');
}

function renderFtuOptions() {
  const values = [...new Set(state.connections.map((item) => normalize(item.ftuType)).filter(Boolean))].sort();
  elements.ftuTypeOptions.innerHTML = values.map((value) => `<option value="${escapeHtml(value)}"></option>`).join('');
}

function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function addConnections(matches) {
  const expand = elements.expandComplexInput.checked;
  for (const match of matches) {
    const complex = normalize(match.complex);
    const additions = expand && complex ? state.connections.filter((item) => normalize(item.complex).toUpperCase() === complex.toUpperCase()) : [match];
    for (const item of additions) if (!state.selected.has(key(item.kabelId))) state.selected.set(key(item.kabelId), { ...item });
  }
  renderSelected();
}

function addIdentifiers(text) {
  const identifiers = parseIdentifiers(text); const matches = []; const unmatched = [];
  for (const identifier of identifiers) {
    const requested = key(identifier);
    const found = state.connections.filter((item) => key(item.kabelId) === requested || key(item.phkt) === requested);
    if (found.length === 0) unmatched.push(identifier); else matches.push(...found);
  }
  addConnections(matches);
  elements.importSummary.textContent = `${matches.length} coincidencias directas; ${state.selected.size} conexiones incluidas.${unmatched.length ? ` No encontradas: ${unmatched.join(', ')}.` : ''}`;
  elements.importSummary.style.color = unmatched.length ? '#a4442e' : '';
  return { matches, unmatched };
}

function renderSearchResults() {
  const query = normalize(elements.searchInput.value).toUpperCase();
  const matches = state.connections.filter((item) => !query || searchable(item).includes(query)).slice(0, 50);
  if (matches.length === 0) { elements.searchResults.innerHTML = '<div class="search-empty">No hay coincidencias.</div>'; return; }
  elements.searchResults.innerHTML = matches.map((item) => `<button class="search-result" data-cable="${escapeHtml(item.kabelId)}" type="button"><strong>${escapeHtml(formatAddress(item))}</strong><span>${escapeHtml(item.kabelId)}${item.bcFiber ? ` · VZ${escapeHtml(item.bcFiber)}` : ''}${item.isNew ? ' · Nueva BC' : ''}</span><small>${escapeHtml(item.complex ?? item.dpLabel ?? '')}</small></button>`).join('');
}

function mergeBcRows(rows) {
  let added = 0; let enriched = 0;
  for (const row of rows ?? []) {
    const existing = state.connections.find((item) => key(item.kabelId) === key(row.kabelId));
    if (existing) {
      existing.bcStatusCode = row.statusCode; existing.bcFiber = row.fiber; existing.bcOdf = row.odf; existing.bcStrengId = row.strengId;
      if (!normalize(existing.ftuType)) existing.ftuType = row.ftuType;
      enriched++;
      continue;
    }
    state.connections.push({ ...row, kastnr: null, complex: null, isNew: true, bcStatusCode: row.statusCode, bcFiber: row.fiber, bcOdf: row.odf, bcStrengId: row.strengId });
    added++;
  }
  state.connections.sort((a, b) => formatAddress(a).localeCompare(formatAddress(b), 'es', { numeric: true }));
  renderFtuOptions(); renderSearchResults(); updateStats();
  return { added, enriched };
}

async function loadProject() {
  const projectFolderPath = normalize(elements.sourceProjectPath.value);
  if (!projectFolderPath) { setStatus('Selecciona la carpeta del proyecto completo.', 'warning'); return; }
  setBusy(true); setStatus('Leyendo conexiones del MDB...', 'neutral');
  try {
    const data = await api.loadPartialDeliveryProject({ projectFolderPath });
    state.connections = Array.isArray(data.connections) ? data.connections : [];
    state.selected.clear(); state.loadedSource = data.sourceProjectPath;
    elements.sourceProjectPath.value = data.sourceProjectPath;
    elements.targetProjectPath.value = data.targetProjectPath;
    elements.backupFolderPath.value = data.backupFolderPath;
    renderFtuOptions(); renderSelected(); renderSearchResults();
    setStatus(`${data.totalConnections} conexiones y ${data.totalComplexes} COMPLEX cargados.`, 'success');
    appendLog(`Proyecto cargado: ${data.sourceProjectPath}`, 'success');
  } catch (error) { const message = error instanceof Error ? error.message : String(error); setStatus(message, 'error'); appendLog(message, 'error'); }
  finally { setBusy(false); }
}

async function chooseFolder(input, thenLoad = false) {
  const selected = await api.openFolder({ title: 'Selecciona una carpeta', defaultPath: normalize(input.value) || undefined });
  if (!selected) return; input.value = selected; if (thenLoad) await loadProject();
}

async function importTxt() {
  try {
    const filePath = await api.openFile({ title: 'Selecciona la lista de Kabel ID o PHKT', filters: [{ name: 'Texto', extensions: ['txt'] }] });
    if (!filePath) return;
    const result = await api.readPartialDeliveryList({ filePath });
    elements.manualInput.value = result.text;
    const summary = addIdentifiers(result.text);
    appendLog(`TXT importado: ${basename(filePath)}. Coincidencias: ${summary.matches.length}; no encontradas: ${summary.unmatched.length}.`, summary.unmatched.length ? 'warning' : 'success');
  } catch (error) { appendLog(error instanceof Error ? error.message : String(error), 'error'); }
}

async function importBc() {
  try {
    const filePath = await api.openFile({ title: 'Selecciona el CSV de BC', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (!filePath) return;
    const result = await api.readPartialDeliveryBc({ filePath });
    const summary = mergeBcRows(result.rows);
    elements.importSummary.textContent = `BC importado: ${result.rows.length} filas; ${summary.enriched} actualizadas y ${summary.added} conexiones nuevas disponibles.`;
    appendLog(`BC importado: ${basename(filePath)}. Filas: ${result.rows.length}; nuevas: ${summary.added}.`, 'success');
  } catch (error) { appendLog(error instanceof Error ? error.message : String(error), 'error'); }
}

async function generate() {
  if (state.selected.size === 0) { setStatus('Selecciona al menos una conexión.', 'warning'); return; }
  setBusy(true); state.lastOutput = null; setStatus('Generando Partial Delivery...', 'neutral');
  try {
    const result = await api.generatePartialDelivery({
      sourceProjectPath: state.loadedSource || elements.sourceProjectPath.value,
      targetProjectPath: elements.targetProjectPath.value,
      backupFolderPath: elements.backupFolderPath.value,
      connections: [...state.selected.values()].map((item) => ({
        kabelId: item.kabelId,
        status: normalize(item.kastnr) || null,
        ftuType: normalize(item.ftuType) || null,
        demping1A: item.demping1A === '' || item.demping1A === null || item.demping1A === undefined ? null : Number(item.demping1A),
        demping1Z: item.demping1Z === '' || item.demping1Z === null || item.demping1Z === undefined ? null : Number(item.demping1Z),
        demping2A: item.demping2A === '' || item.demping2A === null || item.demping2A === undefined ? null : Number(item.demping2A),
        demping2Z: item.demping2Z === '' || item.demping2Z === null || item.demping2Z === undefined ? null : Number(item.demping2Z),
        postcode: item.postcode, houseNumber: item.houseNumber, houseSuffix: item.houseSuffix, room: item.room,
        complex: item.complex, dpLabel: item.dpLabel, statusCode: item.bcStatusCode, fiber: item.bcFiber
      }))
    });
    state.lastOutput = result.targetProjectPath;
    setStatus(`Partial Delivery listo: ${result.selectedConnections} conexiones y ${result.buildingCount} COMPLEX.`, 'success');
    appendLog(`Salida: ${result.targetProjectPath}`, 'success');
    appendLog(`Backup MDB completo: ${result.backupMdbPath}`, 'success');
    if (result.dwgManualPending) appendLog('Pendiente: editar manualmente la copia del DWG.', 'warning');
    appendLog('Crc, Email y Routes no se han creado ni copiado: los generará el programa externo.', 'info');
  } catch (error) { const message = error instanceof Error ? error.message : String(error); setStatus(message, 'error'); appendLog(message, 'error'); }
  finally { setBusy(false); }
}

elements.browseSourceButton.addEventListener('click', () => void chooseFolder(elements.sourceProjectPath, true));
elements.browseTargetButton.addEventListener('click', () => void (async () => {
  const proposedName = basename(elements.targetProjectPath.value) || 'Partial-Delivery-A';
  const selected = await api.openFolder({ title: 'Selecciona la carpeta donde crear el proyecto parcial', defaultPath: dirname(elements.targetProjectPath.value) || undefined });
  if (selected) elements.targetProjectPath.value = basename(selected).toUpperCase() === proposedName.toUpperCase() ? selected : joinPath(selected, proposedName);
})());
elements.browseBackupButton.addEventListener('click', () => void chooseFolder(elements.backupFolderPath));
elements.reloadButton.addEventListener('click', () => void loadProject());
elements.searchInput.addEventListener('input', renderSearchResults);
elements.searchResults.addEventListener('click', (event) => { const button = event.target.closest('[data-cable]'); if (!button) return; const item = state.connections.find((connection) => key(connection.kabelId) === key(button.dataset.cable)); if (item) addConnections([item]); });
elements.addManualButton.addEventListener('click', () => addIdentifiers(elements.manualInput.value));
elements.importTxtButton.addEventListener('click', () => void importTxt());
elements.importBcButton.addEventListener('click', () => void importBc());
elements.selectedRows.addEventListener('click', (event) => { const button = event.target.closest('.remove-connection'); if (!button) return; state.selected.delete(key(button.dataset.cable)); renderSelected(); });
elements.selectedRows.addEventListener('input', (event) => {
  const input = event.target.closest('.connection-edit'); const row = event.target.closest('[data-connection]');
  if (!input || !row) return;
  const item = state.selected.get(key(row.dataset.connection)); if (!item) return;
  if (input.dataset.field === 'status') item.kastnr = input.value;
  else item[input.dataset.field] = input.value;
});
elements.clearSelectionButton.addEventListener('click', () => { state.selected.clear(); renderSelected(); });
elements.generateButton.addEventListener('click', () => void generate());
elements.openOutputButton.addEventListener('click', () => { if (state.lastOutput) void api.showItemInFolder(state.lastOutput); });
api.onPartialDeliveryEvent((event) => { if (event?.message) { setStatus(event.message, event.stage === 'done' ? 'success' : 'neutral'); appendLog(event.message, event.stage === 'done' ? 'success' : 'info'); } });

const initialPath = new URLSearchParams(window.location.search).get('projectFolderPath') ?? '';
elements.sourceProjectPath.value = initialPath;
renderSelected(); renderSearchResults(); setBusy(false);
if (normalize(initialPath)) void loadProject();
