const elements = {
  templatePath: document.getElementById('templatePath'),
  fcPath: document.getElementById('fcPath'),
  bcPath: document.getElementById('bcPath'),
  projectFolderPath: document.getElementById('projectFolderPath'),
  outputPath: document.getElementById('outputPath'),
  inspectButton: document.getElementById('inspectButton'),
  browseTemplateButton: document.getElementById('browseTemplateButton'),
  browseFcButton: document.getElementById('browseFcButton'),
  browseBcButton: document.getElementById('browseBcButton'),
  browseProjectFolderButton: document.getElementById('browseProjectFolderButton'),
  browseOutputButton: document.getElementById('browseOutputButton'),
  generateButton: document.getElementById('generateButton'),
  generateCrossCheckButton: document.getElementById('generateCrossCheckButton'),
  inspectConnectionBalanceButton: document.getElementById('inspectConnectionBalanceButton'),
  adjustConnectionsButton: document.getElementById('adjustConnectionsButton'),
  fixCustomerDempingsButton: document.getElementById('fixCustomerDempingsButton'),
  updateFcButton: document.getElementById('updateFcButton'),
  riserButton: document.getElementById('riserButton'),
  createBuiseindButton: document.getElementById('createBuiseindButton'),
  glaspoortProjectButton: document.getElementById('glaspoortProjectButton'),
  rebuildCustomerComplexesButton: document.getElementById('rebuildCustomerComplexesButton'),
  drawCustomerCoordinatesButton: document.getElementById('drawCustomerCoordinatesButton'),
  clearCustomerCoordinatesButton: document.getElementById('clearCustomerCoordinatesButton'),
  extractCustomerCoordinatesButton: document.getElementById('extractCustomerCoordinatesButton'),
  moveResvCoordinatesToDpButton: document.getElementById('moveResvCoordinatesToDpButton'),
  removeExtraRolesButton: document.getElementById('removeExtraRolesButton'),
  drawAccessnetWithoutAddressButton: document.getElementById('drawAccessnetWithoutAddressButton'),
  applyDempingContingencyButton: document.getElementById('applyDempingContingencyButton'),
  getOapCoordinateButton: document.getElementById('getOapCoordinateButton'),
  cancelButton: document.getElementById('cancelButton'),
  openOutputButton: document.getElementById('openOutputButton'),
  clearLogButton: document.getElementById('clearLogButton'),
  statusBanner: document.getElementById('statusBanner'),
  logOutput: document.getElementById('logOutput'),
  appVersion: document.getElementById('appVersion'),
  dwgStatus: document.getElementById('dwgStatus'),
  dwgDetail: document.getElementById('dwgDetail'),
  permitStatus: document.getElementById('permitStatus'),
  permitDetail: document.getElementById('permitDetail'),
  buildingStatus: document.getElementById('buildingStatus'),
  buildingDetail: document.getElementById('buildingDetail'),
  connectionBalanceCard: document.getElementById('connectionBalanceCard'),
  connectionBalanceStatus: document.getElementById('connectionBalanceStatus'),
  connectionBalanceDetail: document.getElementById('connectionBalanceDetail')
};

const fiberDesktopApi = window.fiberApp ?? null;

const state = {
  running: false,
  cancelAvailable: false,
  outputTouched: false,
  lastOutputPath: null,
  lastConnectionBalance: null
};

function basename(filePath) {
  const normalized = String(filePath ?? '');
  const separatorIndex = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized;
}

function dirname(filePath) {
  const normalized = String(filePath ?? '');
  const separatorIndex = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  return separatorIndex >= 0 ? normalized.slice(0, separatorIndex) : '';
}

function normalizePathForComparison(filePath) {
  return String(filePath ?? '')
    .trim()
    .replace(/[\\/]+/g, '\\')
    .replace(/[\\]+$/, '')
    .toLowerCase();
}

function withoutExtension(fileName) {
  const lastDot = fileName.lastIndexOf('.');
  return lastDot > 0 ? fileName.slice(0, lastDot) : fileName;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncateMiddle(value, limit = 64) {
  const text = String(value ?? '');

  if (text.length <= limit) {
    return text || 'Sin dato';
  }

  const keep = Math.floor((limit - 3) / 2);
  return `${text.slice(0, keep)}...${text.slice(text.length - keep)}`;
}

function setStatus(message, tone = 'neutral') {
  elements.statusBanner.textContent = message;
  elements.statusBanner.dataset.tone = tone;
}

function appendLog(message, tone = 'info') {
  const normalized = String(message ?? '').replace(/\r/g, '');
  const lines = normalized.split('\n').filter((line, index, all) => line !== '' || index < all.length - 1);

  for (const line of lines) {
    const entry = document.createElement('div');
    entry.className = `log-line ${tone}`;
    entry.textContent = `[${new Date().toLocaleTimeString('es-ES')}] ${line}`;
    elements.logOutput.append(entry);
  }

  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function setRunningState(running, cancelAvailable = false) {
  state.running = running;
  state.cancelAvailable = running && cancelAvailable;

  for (const control of [
    elements.inspectButton,
    elements.browseTemplateButton,
    elements.browseFcButton,
    elements.browseBcButton,
    elements.browseProjectFolderButton,
    elements.browseOutputButton,
    elements.generateButton,
    elements.generateCrossCheckButton,
    elements.inspectConnectionBalanceButton,
    elements.adjustConnectionsButton,
    elements.fixCustomerDempingsButton,
    elements.updateFcButton,
    elements.riserButton,
    elements.createBuiseindButton,
    elements.glaspoortProjectButton,
    elements.rebuildCustomerComplexesButton,
    elements.drawCustomerCoordinatesButton,
    elements.clearCustomerCoordinatesButton,
    elements.extractCustomerCoordinatesButton,
    elements.moveResvCoordinatesToDpButton,
    elements.removeExtraRolesButton,
    elements.drawAccessnetWithoutAddressButton,
    elements.applyDempingContingencyButton,
    elements.getOapCoordinateButton
  ]) {
    control.disabled = running;
  }

  for (const input of [
    elements.templatePath,
    elements.fcPath,
    elements.bcPath,
    elements.projectFolderPath,
    elements.outputPath
  ]) {
    input.disabled = running;
  }

  elements.cancelButton.disabled = !state.cancelAvailable;
  elements.openOutputButton.disabled = running || !state.lastOutputPath;
}

function updateInspectionCards(data) {
  if (!data) {
    elements.dwgStatus.textContent = 'Pendiente';
    elements.dwgDetail.textContent = 'Sin analizar';
    elements.permitStatus.textContent = 'Pendiente';
    elements.permitDetail.textContent = 'Sin analizar';
    elements.buildingStatus.textContent = 'Pendiente';
    elements.buildingDetail.textContent = 'Sin analizar';
    updateConnectionBalanceCard(null);
    return;
  }

  if (data.hasDwg) {
    elements.dwgStatus.textContent = 'Detectado';
    elements.dwgDetail.textContent = truncateMiddle(data.dwgPath);
  }
  else {
    elements.dwgStatus.textContent = 'No encontrado';
    elements.dwgDetail.textContent = 'La carpeta no contiene DWG';
  }

  elements.permitStatus.textContent = data.permitPdfCount > 0 ? `${data.permitPdfCount} PDF` : 'Sin PDF';
  elements.permitDetail.textContent = data.permitFolderName ?? 'Sin carpeta detectada';

  elements.buildingStatus.textContent = `${data.buildingFolderCount ?? 0} carpetas`;
  elements.buildingDetail.textContent = (data.buildingFolderCount ?? 0) > 0
    ? 'Listas para resolver COMPLEX'
    : 'No se han encontrado carpetas en Gebouwen';
}

function updateConnectionBalanceCard(result) {
  state.lastConnectionBalance = result ?? null;

  if (!result) {
    elements.connectionBalanceCard.dataset.tone = 'neutral';
    elements.connectionBalanceStatus.textContent = 'Pendiente';
    elements.connectionBalanceDetail.textContent = 'Sin revisar';
    return;
  }

  const tone = result.isBalanced ? 'success' : 'warning';
  elements.connectionBalanceCard.dataset.tone = tone;
  elements.connectionBalanceStatus.textContent = result.isBalanced ? 'OK' : 'Desbalance';

  const detailParts = [
    `FC: ${result.fcCount}`,
    `BC: ${result.bcCount}`,
    `FC+BC: ${result.sourceCount}`,
    `MDB: ${result.mdbCount}`
  ];

  if (!result.isBalanced) {
    detailParts.push(`Faltan: ${result.missingInMdb.length}`);
    detailParts.push(`Sobran: ${result.extraInMdb.length}`);
  }

  elements.connectionBalanceDetail.textContent = detailParts.join(' | ');
}

function buildSuggestedOutputPath() {
  const projectFolderPath = elements.projectFolderPath.value.trim();
  const fcPath = elements.fcPath.value.trim();

  let baseDirectory = projectFolderPath;
  let projectName = basename(projectFolderPath);

  if (!projectName && fcPath) {
    baseDirectory = dirname(fcPath);
    projectName = withoutExtension(basename(fcPath)).replace(/^FC\s+/i, '');
  }

  if (!projectName) {
    projectName = 'generated';
  }

  const outputName = `${projectName}.mdb`;
  return baseDirectory ? `${baseDirectory}\\${outputName}` : outputName;
}

function maybePopulateOutput() {
  if (state.outputTouched && elements.outputPath.value.trim()) {
    return;
  }

  elements.outputPath.value = buildSuggestedOutputPath();
}

async function inspectProjectFolder() {
  if (!fiberDesktopApi) {
    setStatus('La integracion de escritorio no se ha cargado. Cierra la app y vuelve a abrir el ejecutable nuevo.', 'error');
    appendLog('window.fiberApp no esta disponible.', 'error');
    return;
  }

  const projectFolderPath = elements.projectFolderPath.value.trim();

  if (!projectFolderPath) {
    setStatus('Selecciona primero la carpeta del proyecto.', 'warning');
    return;
  }

  setStatus('Revisando la carpeta del proyecto...', 'neutral');

  try {
    const inspection = await fiberDesktopApi.inspectProject(projectFolderPath);
    updateInspectionCards(inspection);
    setStatus('Carpeta revisada. Puedes generar el MDB cuando quieras.', 'neutral');
    appendLog(`Carpeta revisada: DWG=${inspection.hasDwg ? 'sí' : 'no'}, PDF=${inspection.permitPdfCount}, Gebouwen=${inspection.buildingFolderCount}`, 'meta');
  }
  catch (error) {
    setStatus(error.message, 'error');
    appendLog(error.message, 'error');
  }
}

async function chooseFile(targetInput, options) {
  if (!fiberDesktopApi) {
    setStatus('La integracion de escritorio no se ha cargado. No se puede abrir el explorador.', 'error');
    appendLog('No se puede abrir dialog: window.fiberApp no esta disponible.', 'error');
    return;
  }

  const selectedPath = await fiberDesktopApi.openFile({
    ...options,
    defaultPath: targetInput.value.trim() || options.defaultPath
  });

  if (!selectedPath) {
    return;
  }

  targetInput.value = selectedPath;

  if (targetInput === elements.fcPath || targetInput === elements.projectFolderPath) {
    maybePopulateOutput();
  }
}

async function chooseProjectFolder() {
  if (!fiberDesktopApi) {
    setStatus('La integracion de escritorio no se ha cargado. No se puede abrir el explorador.', 'error');
    appendLog('No se puede abrir dialog de carpeta: window.fiberApp no esta disponible.', 'error');
    return;
  }

  const selectedPath = await fiberDesktopApi.openFolder({
    title: 'Selecciona la carpeta del proyecto',
    defaultPath: elements.projectFolderPath.value.trim() || dirname(elements.fcPath.value.trim())
  });

  if (!selectedPath) {
    return;
  }

  elements.projectFolderPath.value = selectedPath;
  state.outputTouched = false;
  elements.outputPath.value = '';
  maybePopulateOutput();
  await inspectProjectFolder();
}

async function chooseOutputPath() {
  if (!fiberDesktopApi) {
    setStatus('La integracion de escritorio no se ha cargado. No se puede abrir el explorador.', 'error');
    appendLog('No se puede abrir dialog de salida: window.fiberApp no esta disponible.', 'error');
    return;
  }

  const selectedPath = await fiberDesktopApi.saveFile({
    title: 'Guardar MDB generado',
    defaultPath: elements.outputPath.value.trim() || buildSuggestedOutputPath(),
    filters: [
      { name: 'Access MDB', extensions: ['mdb'] }
    ]
  });

  if (!selectedPath) {
    return;
  }

  state.outputTouched = true;
  elements.outputPath.value = selectedPath;
}

function validateForm() {
  const missing = [];

  for (const [input, label] of [
    [elements.templatePath, 'Template MDB'],
    [elements.fcPath, 'FC Excel'],
    [elements.bcPath, 'BC CSV'],
    [elements.projectFolderPath, 'Carpeta del proyecto'],
    [elements.outputPath, 'MDB de salida']
  ]) {
    if (!input.value.trim()) {
      missing.push(label);
    }
  }

  return missing;
}

function validateToolInputs() {
  const missing = [];

  if (!elements.projectFolderPath.value.trim()) {
    missing.push('Carpeta del proyecto');
  }

  return missing;
}

function validateCrossCheckInputs() {
  const missing = [];

  for (const [input, label] of [
    [elements.fcPath, 'FC Excel'],
    [elements.bcPath, 'BC CSV'],
    [elements.projectFolderPath, 'Carpeta del proyecto']
  ]) {
    if (!input.value.trim()) {
      missing.push(label);
    }
  }

  return missing;
}

function validateFcProjectInputs() {
  const missing = [];

  for (const [input, label] of [
    [elements.fcPath, 'FC Excel'],
    [elements.projectFolderPath, 'Carpeta del proyecto']
  ]) {
    if (!input.value.trim()) {
      missing.push(label);
    }
  }

  return missing;
}

function validateProjectSourceConsistency({ requireBc = false } = {}) {
  const issues = [];
  const projectFolderPath = elements.projectFolderPath.value.trim();
  const fcPath = elements.fcPath.value.trim();
  const bcPath = elements.bcPath.value.trim();

  const projectBaseFolder = normalizePathForComparison(dirname(projectFolderPath));
  const fcBaseFolder = normalizePathForComparison(dirname(fcPath));
  const bcBaseFolder = normalizePathForComparison(dirname(bcPath));

  if (projectBaseFolder && fcBaseFolder && projectBaseFolder !== fcBaseFolder) {
    issues.push(`El FC seleccionado parece pertenecer a otra carpeta base. Proyecto: ${dirname(projectFolderPath)} | FC: ${dirname(fcPath)}`);
  }

  if (requireBc && projectBaseFolder && bcBaseFolder && projectBaseFolder !== bcBaseFolder) {
    issues.push(`El BC seleccionado parece pertenecer a otra carpeta base. Proyecto: ${dirname(projectFolderPath)} | BC: ${dirname(bcPath)}`);
  }

  return issues;
}

async function runProjectTool({ startMessage, successMessage, successLog, action }) {
  if (!fiberDesktopApi) {
    setStatus('La integracion de escritorio no se ha cargado. No se puede ejecutar esta herramienta.', 'error');
    appendLog('No se puede ejecutar la herramienta: window.fiberApp no esta disponible.', 'error');
    return;
  }

  const missing = validateToolInputs();
  if (missing.length > 0) {
    const message = `Faltan campos obligatorios: ${missing.join(', ')}.`;
    setStatus(message, 'warning');
    appendLog(message, 'warning');
    return;
  }

  setRunningState(true, false);
  setStatus(startMessage, 'neutral');
  appendLog(startMessage, 'meta');

  try {
    const result = await action({
      projectFolderPath: elements.projectFolderPath.value.trim()
    });

    setStatus(successMessage(result), 'success');
    appendLog(successLog(result), 'success');
  }
  catch (error) {
    setStatus(error.message, 'error');
    appendLog(error.message, 'error');
  }
  finally {
    setRunningState(false);
  }
}

async function generateCrossCheck() {
  if (!fiberDesktopApi) {
    setStatus('La integracion de escritorio no se ha cargado. No se puede generar el Cross Check.', 'error');
    appendLog('No se puede generar el Cross Check: window.fiberApp no esta disponible.', 'error');
    return;
  }

  const missing = validateCrossCheckInputs();
  if (missing.length > 0) {
    const message = `Faltan campos obligatorios: ${missing.join(', ')}.`;
    setStatus(message, 'warning');
    appendLog(message, 'warning');
    return;
  }

  const consistencyIssues = validateProjectSourceConsistency({ requireBc: true });
  if (consistencyIssues.length > 0) {
    const message = consistencyIssues.join(' ');
    setStatus(message, 'warning');
    appendLog(message, 'warning');
    return;
  }

  setRunningState(true, false);
  setStatus('Generando Address cross check Cocon delivery 4.0...', 'neutral');
  appendLog('Inicio de generacion de Address cross check.', 'meta');

  try {
    const result = await fiberDesktopApi.generateCrossCheck({
      fcPath: elements.fcPath.value.trim(),
      bcPath: elements.bcPath.value.trim(),
      projectFolderPath: elements.projectFolderPath.value.trim()
    });

    setStatus('Address cross check generado correctamente.', 'success');
    appendLog(`Cross check generado: ${result.outputPath}`, 'success');
  }
  catch (error) {
    setStatus(error.message, 'error');
    appendLog(error.message, 'error');
  }
  finally {
    setRunningState(false);
  }
}

async function generateMdb() {
  if (!fiberDesktopApi) {
    setStatus('La integracion de escritorio no se ha cargado. No se puede generar el MDB.', 'error');
    appendLog('No se puede generar: window.fiberApp no esta disponible.', 'error');
    return;
  }

  const missing = validateForm();

  if (missing.length > 0) {
    const message = `Faltan campos obligatorios: ${missing.join(', ')}.`;
    setStatus(message, 'warning');
    appendLog(message, 'warning');
    return;
  }

  const consistencyIssues = validateProjectSourceConsistency({ requireBc: true });
  if (consistencyIssues.length > 0) {
    const message = consistencyIssues.join(' ');
    setStatus(message, 'warning');
    appendLog(message, 'warning');
    return;
  }

  state.lastOutputPath = null;
  setRunningState(true, true);
  setStatus('Preparando generación...', 'neutral');
  appendLog('Inicio de generación.', 'meta');

  try {
    const result = await fiberDesktopApi.generate({
      templatePath: elements.templatePath.value.trim(),
      fcPath: elements.fcPath.value.trim(),
      bcPath: elements.bcPath.value.trim(),
      projectFolderPath: elements.projectFolderPath.value.trim(),
      outputPath: elements.outputPath.value.trim()
    });

    state.lastOutputPath = result.outputPath;
    setStatus('MDB generado correctamente.', 'success');
    appendLog('Generación completada correctamente.', 'success');
  }
  catch (error) {
    if (error?.message === 'La generación fue cancelada.') {
      setStatus('La generación fue cancelada.', 'warning');
      appendLog(error.message, 'warning');
    }
    else {
      setStatus(error.message, 'error');
      appendLog(error.message, 'error');
    }
  }
  finally {
    setRunningState(false);
  }
}

async function drawCustomerCoordinates() {
  await runProjectTool({
    startMessage: 'Preparando dibujo de coordenadas de clientes...',
    successMessage: (result) => `DWG actualizado con ${result.drawnCount} etiquetas de clientes.`,
    successLog: (result) => `Dibujo completado: ${result.drawnCount} textos escritos en el DWG.`,
    action: (payload) => fiberDesktopApi.drawCustomerCoordinates(payload)
  });
}

async function fixCustomerDempings() {
  await runProjectTool({
    startMessage: 'Corrigiendo dempings en la base de datos...',
    successMessage: (result) => `Dempings corregidos: ${result.updatedFields} campos en ${result.updatedRows} clientes.`,
    successLog: (result) => `Correccion de dempings completada en ${result.mdbPath}. Filas tocadas: ${result.updatedRows}. Campos tocados: ${result.updatedFields}.`,
    action: (payload) => fiberDesktopApi.fixCustomerDempings(payload)
  });
}

async function inspectConnectionBalance() {
  if (!fiberDesktopApi) {
    setStatus('La integracion de escritorio no se ha cargado. No se puede revisar el balance de conexiones.', 'error');
    appendLog('No se puede revisar balance de conexiones: window.fiberApp no esta disponible.', 'error');
    return;
  }

  const missing = validateCrossCheckInputs();
  if (missing.length > 0) {
    const message = `Faltan campos obligatorios: ${missing.join(', ')}.`;
    setStatus(message, 'warning');
    appendLog(message, 'warning');
    return;
  }

  const consistencyIssues = validateProjectSourceConsistency({ requireBc: true });
  if (consistencyIssues.length > 0) {
    const message = consistencyIssues.join(' ');
    setStatus(message, 'warning');
    appendLog(message, 'warning');
    return;
  }

  setRunningState(true, false);
  setStatus('Revisando balance entre FC, BC y MDB...', 'neutral');
  appendLog('Inicio de revisar balance de conexiones.', 'meta');

  try {
    const result = await fiberDesktopApi.inspectConnectionBalance({
      fcPath: elements.fcPath.value.trim(),
      bcPath: elements.bcPath.value.trim(),
      projectFolderPath: elements.projectFolderPath.value.trim()
    });

    updateConnectionBalanceCard(result);

    if (result.isBalanced) {
      setStatus(`Balance correcto: ${result.sourceCount} conexiones en FC+BC y ${result.mdbCount} en MDB.`, 'success');
      appendLog(`Balance correcto. FC: ${result.fcCount}. BC: ${result.bcCount}. FC+BC: ${result.sourceCount}. MDB: ${result.mdbCount}.`, 'success');
    }
    else {
      setStatus(`Desbalance detectado: faltan ${result.missingInMdb.length} y sobran ${result.extraInMdb.length}.`, 'warning');
      appendLog(`Desbalance detectado. FC: ${result.fcCount}. BC: ${result.bcCount}. FC+BC: ${result.sourceCount}. MDB: ${result.mdbCount}.`, 'warning');

      if (result.missingInMdb.length > 0) {
        appendLog(`Faltan en MDB (${result.missingInMdb.length}): ${result.missingInMdb.slice(0, 20).join(', ')}${result.missingInMdb.length > 20 ? ' ...' : ''}`, 'warning');
      }

      if (result.extraInMdb.length > 0) {
        appendLog(`Sobran en MDB (${result.extraInMdb.length}): ${result.extraInMdb.slice(0, 20).join(', ')}${result.extraInMdb.length > 20 ? ' ...' : ''}`, 'warning');
      }
    }
  }
  catch (error) {
    setStatus(error.message, 'error');
    appendLog(error.message, 'error');
  }
  finally {
    setRunningState(false);
  }
}

async function adjustConnections() {
  if (!fiberDesktopApi) {
    setStatus('La integracion de escritorio no se ha cargado. No se pueden ajustar conexiones.', 'error');
    appendLog('No se puede ajustar conexiones: window.fiberApp no esta disponible.', 'error');
    return;
  }

  const missing = validateCrossCheckInputs();
  if (missing.length > 0) {
    const message = `Faltan campos obligatorios: ${missing.join(', ')}.`;
    setStatus(message, 'warning');
    appendLog(message, 'warning');
    return;
  }

  const consistencyIssues = validateProjectSourceConsistency({ requireBc: true });
  if (consistencyIssues.length > 0) {
    const message = consistencyIssues.join(' ');
    setStatus(message, 'warning');
    appendLog(message, 'warning');
    return;
  }

  setRunningState(true, false);
  setStatus('Ajustando conexiones entre FC, BC y MDB...', 'neutral');
  appendLog('Inicio de ajustar conexiones.', 'meta');

  try {
    const result = await fiberDesktopApi.adjustConnections({
      fcPath: elements.fcPath.value.trim(),
      bcPath: elements.bcPath.value.trim(),
      projectFolderPath: elements.projectFolderPath.value.trim()
    });

    if (result.cancelled) {
      updateConnectionBalanceCard(state.lastConnectionBalance);
      setStatus('Ajuste cancelado por el usuario.', 'warning');
      appendLog('Ajuste cancelado por el usuario antes de borrar conexiones sobrantes.', 'warning');
      return;
    }

    updateConnectionBalanceCard({
      fcCount: result.fcCount,
      bcCount: result.bcCount,
      sourceCount: result.finalCount,
      mdbCount: result.finalCount,
      missingInMdb: [],
      extraInMdb: [],
      isBalanced: true
    });

    setStatus(`Ajuste completado: +${result.addedCount} / -${result.removedCount}.`, 'success');
    appendLog(`Ajuste completado en ${result.mdbPath}. Antes MDB: ${result.mdbCountBefore}. Final: ${result.finalCount}. Añadidas: ${result.addedCount}. Borradas: ${result.removedCount}.`, 'success');
  }
  catch (error) {
    setStatus(error.message, 'error');
    appendLog(error.message, 'error');
  }
  finally {
    setRunningState(false);
  }
}

async function updateFc() {
  if (!fiberDesktopApi) {
    setStatus('La integracion de escritorio no se ha cargado. No se puede actualizar desde FC.', 'error');
    appendLog('No se puede actualizar FC: window.fiberApp no esta disponible.', 'error');
    return;
  }

  const missing = validateFcProjectInputs();
  if (missing.length > 0) {
    const message = `Faltan campos obligatorios: ${missing.join(', ')}.`;
    setStatus(message, 'warning');
    appendLog(message, 'warning');
    return;
  }

  const consistencyIssues = validateProjectSourceConsistency();
  if (consistencyIssues.length > 0) {
    const message = consistencyIssues.join(' ');
    setStatus(message, 'warning');
    appendLog(message, 'warning');
    return;
  }

  setRunningState(true, false);
  setStatus('Rehaciendo Klant y Kabel desde FC y BC...', 'neutral');
  appendLog('Inicio de actualizar FC.', 'meta');

  try {
    const result = await fiberDesktopApi.updateFc({
      fcPath: elements.fcPath.value.trim(),
      bcPath: elements.bcPath.value.trim(),
      projectFolderPath: elements.projectFolderPath.value.trim()
    });

    appendLog(`FC actualizado en ${result.mdbPath}. Klant rehechos: ${result.rebuiltCustomers ?? 'n/d'}, con cambios en ${result.updatedCustomers} filas y ${result.updatedCustomerFields} campos. Kabel rehechos: ${result.rebuiltCables ?? 'n/d'}, con cambios en ${result.updatedCables} filas y ${result.updatedCableFields} campos. Final: ${result.finalCustomers ?? 'n/d'} clientes, ${result.finalCables ?? 'n/d'} cables.`, 'success');
    if (typeof result.addedCustomers === 'number' || typeof result.removedCustomers === 'number') {
      appendLog(`Altas por FC+BC: ${result.addedCustomers ?? 0}. Bajas por FC+BC: ${result.removedCustomers ?? 0}.`, 'info');
    }
    const customerFieldChanges = Object.entries(result.customerFieldChanges ?? {});
    if (customerFieldChanges.length > 0) {
      appendLog(`Campos cambiados en Klant: ${customerFieldChanges.map(([name, count]) => `${name}=${count}`).join(', ')}.`, 'info');
    }
    const cableFieldChanges = Object.entries(result.cableFieldChanges ?? {});
    if (cableFieldChanges.length > 0) {
      appendLog(`Campos cambiados en Kabel: ${cableFieldChanges.map(([name, count]) => `${name}=${count}`).join(', ')}.`, 'info');
    }

    if (Array.isArray(result.warnings) && result.warnings.length > 0) {
      setStatus(`FC actualizado con ${result.warnings.length} cambios sensibles a revisar.`, 'warning');
      appendLog('Cambios sensibles GL/EG/RESV detectados:', 'warning');

      for (const warning of result.warnings) {
        const fromValue = warning?.From ?? 'vacio';
        const toValue = warning?.To ?? 'vacio';
        const addressCode = warning?.AddressCode ? ` [${warning.AddressCode}]` : '';
        appendLog(`- ${warning?.CableId ?? 'sin cable'}${addressCode}: ${fromValue} -> ${toValue}`, 'warning');
      }
    }
    else {
      setStatus(`FC actualizado: Klant con cambios ${result.updatedCustomers}, Kabel con cambios ${result.updatedCables}.`, 'success');
    }
  }
  catch (error) {
    setStatus(error.message, 'error');
    appendLog(error.message, 'error');
  }
  finally {
    setRunningState(false);
  }
}

async function rebuildCustomerComplexes() {
  if (!fiberDesktopApi) {
    setStatus('La integracion de escritorio no se ha cargado. No se puede rehacer COMPLEX.', 'error');
    appendLog('No se puede rehacer COMPLEX: window.fiberApp no esta disponible.', 'error');
    return;
  }

  const missing = validateCrossCheckInputs();
  if (missing.length > 0) {
    const message = `Faltan campos obligatorios: ${missing.join(', ')}.`;
    setStatus(message, 'warning');
    appendLog(message, 'warning');
    return;
  }

  const consistencyIssues = validateProjectSourceConsistency({ requireBc: true });
  if (consistencyIssues.length > 0) {
    const message = consistencyIssues.join(' ');
    setStatus(message, 'warning');
    appendLog(message, 'warning');
    return;
  }

  setRunningState(true, false);
  setStatus('Rehaciendo COMPLEX en la base de datos...', 'neutral');
  appendLog('Inicio de rehacer COMPLEX.', 'meta');

  try {
    const result = await fiberDesktopApi.rebuildCustomerComplexes({
      fcPath: elements.fcPath.value.trim(),
      bcPath: elements.bcPath.value.trim(),
      projectFolderPath: elements.projectFolderPath.value.trim()
    });

    setStatus(`COMPLEX rehecho: ${result.updated} clientes actualizados.`, 'success');
    appendLog(`COMPLEX rehecho en ${result.mdbPath}. Actualizados: ${result.updated}. Asignados: ${result.assigned}. Limpiados: ${result.cleared}.`, 'success');
  }
  catch (error) {
    setStatus(error.message, 'error');
    appendLog(error.message, 'error');
  }
  finally {
    setRunningState(false);
  }
}

async function applyGlaspoortProject() {
  if (!fiberDesktopApi) {
    setStatus('La integracion de escritorio no se ha cargado. No se puede aplicar Glaspoort Project.', 'error');
    appendLog('No se puede aplicar Glaspoort Project: window.fiberApp no esta disponible.', 'error');
    return;
  }

  const missing = validateFcProjectInputs().filter((item) => item === 'Carpeta del proyecto');
  if (missing.length > 0) {
    const message = `Faltan campos obligatorios: ${missing.join(', ')}.`;
    setStatus(message, 'warning');
    appendLog(message, 'warning');
    return;
  }

  setRunningState(true, false);
  setStatus('Aplicando configuracion Glaspoort Project en Instellingen...', 'neutral');
  appendLog('Inicio de Glaspoort Project.', 'meta');

  try {
    const result = await fiberDesktopApi.applyGlaspoortProject({
      projectFolderPath: elements.projectFolderPath.value.trim()
    });

    setStatus('Glaspoort Project aplicado correctamente.', 'success');
    appendLog(`Instellingen actualizado en ${result.mdbPath}. Filas insertadas: ${result.inserted}. Filas actualizadas: ${result.updated}.`, 'success');
  }
  catch (error) {
    setStatus(error.message, 'error');
    appendLog(error.message, 'error');
  }
  finally {
    setRunningState(false);
  }
}

async function openRiserWindow() {
  if (!fiberDesktopApi) {
    setStatus('La integracion de escritorio no se ha cargado. No se puede abrir Riser.', 'error');
    appendLog('No se puede abrir Riser: window.fiberApp no esta disponible.', 'error');
    return;
  }

  const missing = validateCrossCheckInputs();
  if (missing.length > 0) {
    const message = `Faltan campos obligatorios para Riser: ${missing.join(', ')}.`;
    setStatus(message, 'warning');
    appendLog(message, 'warning');
    return;
  }

  const consistencyIssues = validateProjectSourceConsistency({ requireBc: true });
  if (consistencyIssues.length > 0) {
    const message = consistencyIssues.join(' ');
    setStatus(message, 'warning');
    appendLog(message, 'warning');
    return;
  }

  try {
    await fiberDesktopApi.openRiserWindow({
      fcPath: elements.fcPath.value.trim(),
      bcPath: elements.bcPath.value.trim(),
      projectFolderPath: elements.projectFolderPath.value.trim()
    });

    setStatus('Ventana Riser abierta.', 'neutral');
    appendLog('Riser abierto en una ventana nueva.', 'meta');
  }
  catch (error) {
    setStatus(error.message, 'error');
    appendLog(error.message, 'error');
  }
}

function normalizeBuisNumberInput(value) {
  const text = String(value ?? '').trim().toUpperCase();
  const match = text.match(/^(?:B|T)?0*(\d{1,3})(?:-(?:S|BE)-?0?\d{1,2})?$/);
  if (!match) {
    return null;
  }

  return match[1].padStart(2, '0');
}

function promptTextModal({ title, message, placeholder = '', defaultValue = '' }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'prompt-overlay';
    overlay.innerHTML = `
      <div class="prompt-card" role="dialog" aria-modal="true" aria-labelledby="promptTitle">
        <h3 id="promptTitle">${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        <input class="prompt-input" type="text" value="${escapeHtml(defaultValue)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off" />
        <div class="prompt-actions">
          <button class="button tertiary prompt-cancel" type="button">Cancelar</button>
          <button class="button accent prompt-ok" type="button">Aceptar</button>
        </div>
      </div>
    `;

    const input = overlay.querySelector('.prompt-input');
    const okButton = overlay.querySelector('.prompt-ok');
    const cancelButton = overlay.querySelector('.prompt-cancel');

    let settled = false;
    const close = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      resolve(value);
    };

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        close(null);
      }
    };

    okButton.addEventListener('click', () => close(input.value));
    cancelButton.addEventListener('click', () => close(null));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        close(input.value);
      }
    });
    document.addEventListener('keydown', onKeyDown);
    document.body.appendChild(overlay);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}

async function createBuiseind() {
  appendLog('Crear Buiseind pulsado. Preparando seleccion de tubo...', 'meta');

  if (!fiberDesktopApi) {
    setStatus('La integracion de escritorio no se ha cargado. No se puede crear Buiseind.', 'error');
    appendLog('No se puede crear Buiseind: window.fiberApp no esta disponible.', 'error');
    return;
  }

  const missing = validateToolInputs();
  if (missing.length > 0) {
    const message = `Faltan campos obligatorios: ${missing.join(', ')}.`;
    setStatus(message, 'warning');
    appendLog(message, 'warning');
    return;
  }

  const buisInput = await promptTextModal({
    title: 'Crear Buiseind',
    message: 'Indica que tubo/Buis termina en Buiseinde.',
    placeholder: 'Ejemplos: B04, T04, T04-S01 o B04-BE-01'
  });
  const buisNumber = normalizeBuisNumberInput(buisInput);
  if (!buisNumber) {
    setStatus('Creacion de Buiseind cancelada o tubo no valido.', 'warning');
    appendLog('Creacion de Buiseind cancelada: indica un tubo como B04, T04 o 4.', 'warning');
    return;
  }

  setRunningState(true, false);
  setStatus(`Selecciona en AutoCAD el punto para B${buisNumber}-BE-01...`, 'neutral');
  appendLog(`Tubo seleccionado: B${buisNumber}. Se creara el Buiseind B${buisNumber}-BE-01.`, 'meta');
  appendLog(`Esperando click en AutoCAD para crear Buiseind B${buisNumber}.`, 'meta');

  try {
    const coordinate = await fiberDesktopApi.pickRiserEtCoordinate({
      projectFolderPath: elements.projectFolderPath.value.trim(),
      prompt: `Selecciona B${buisNumber}-BE-01`
    });

    setStatus('Creando Buiseind en la base de datos...', 'neutral');
    const result = await fiberDesktopApi.createBuiseind({
      projectFolderPath: elements.projectFolderPath.value.trim(),
      buisNumber,
      coordinate
    });

    setStatus(`Buiseind creado: ${result.accesspointLabel}.`, 'success');
    appendLog(`Buiseind creado en ${result.mdbPath}: ${result.accesspointLabel}, ${result.trajectLabel}, duct ${result.ductLabel}.`, 'success');
  }
  catch (error) {
    setStatus(error.message, 'error');
    appendLog(error.message, 'error');
  }
  finally {
    setRunningState(false);
  }
}

async function clearCustomerCoordinates() {
  await runProjectTool({
    startMessage: 'Preparando limpieza de coordenadas de clientes...',
    successMessage: (result) => `DWG limpiado: ${result.removedCount} etiquetas eliminadas.`,
    successLog: (result) => `Limpieza completada: ${result.removedCount} etiquetas borradas del DWG.`,
    action: (payload) => fiberDesktopApi.clearCustomerCoordinates(payload)
  });
}

async function extractCustomerCoordinates() {
  await runProjectTool({
    startMessage: 'Importando coordenadas de clientes desde el DWG...',
    successMessage: (result) => `MDB actualizado con ${result.updated} clientes (${result.updatedStatuses ?? 0} estados GL/EG sincronizados).`,
    successLog: (result) => `Importacion completada: ${result.updated} clientes actualizados desde ${result.coordinateCount} textos del DWG. Coordenadas: ${result.updatedCoordinates ?? 0}. Estados GL/EG: ${result.updatedStatuses ?? 0}.`,
    action: (payload) => fiberDesktopApi.extractCustomerCoordinates(payload)
  });
}

async function moveResvCoordinatesToDp() {
  await runProjectTool({
    startMessage: 'Moviendo coordenadas de conexiones RESV al DP correspondiente...',
    successMessage: (result) => `RESV al DP: ${result.updatedRows} clientes actualizados de ${result.resvRows} RESV.`,
    successLog: (result) => `RESV al DP completado en ${result.mdbPath}. RESV encontrados: ${result.resvRows}. Actualizados: ${result.updatedRows}. Ya correctos: ${result.unchangedRows}. Sin DP/coordenada: ${result.notMatchedCount}.`,
    action: (payload) => fiberDesktopApi.moveResvCoordinatesToDp(payload)
  });
}

async function getOapCoordinate() {
  await runProjectTool({
    startMessage: 'Buscando coordenada OAP en el DWG...',
    successMessage: (result) => `OAP aplicado en POP y Vergunning (${result.x}, ${result.y}). Direccion POP: ${result.nearestPostcode ?? ''} ${result.nearestHuisnr ?? ''}${result.nearestToevoeging ?? ''}`.trim(),
    successLog: (result) => `OAP actualizado en MDB: X=${result.x}, Y=${result.y}. DP cercano: ${result.nearestDpLabel ?? 'sin dato'}. Kabel: ${result.nearestKabel ?? 'sin dato'}.`,
    action: (payload) => fiberDesktopApi.getOapCoordinate(payload)
  });
}

async function removeExtraRoles() {
  await runProjectTool({
    startMessage: 'Buscando errores M-30173 en el check y eliminando bloques ROL extra...',
    successMessage: (result) => `Contingencia aplicada: ${result.removedCount} bloques ROL eliminados en ${result.coordinateCount} coordenadas.`,
    successLog: (result) => `Contingencia ROL completada usando ${result.checkPath}. Coordenadas detectadas: ${result.coordinateCount}. Bloques eliminados: ${result.removedCount}.`,
    action: (payload) => fiberDesktopApi.removeExtraRoles(payload)
  });
}

async function drawAccessnetWithoutAddress() {
  await runProjectTool({
    startMessage: 'Buscando errores M-30001 en el check y dibujando circulos rojos...',
    successMessage: (result) => `Contingencia aplicada: ${result.drawnCount} circulos rojos dibujados en ${result.coordinateCount} coordenadas.`,
    successLog: (result) => `Contingencia accessnet completada usando ${result.checkPath}. Coordenadas detectadas: ${result.coordinateCount}. Circulos dibujados: ${result.drawnCount}.`,
    action: (payload) => fiberDesktopApi.drawAccessnetWithoutAddress(payload)
  });
}

async function applyDempingContingency() {
  await runProjectTool({
    startMessage: 'Buscando errores M-30212 y M-30005 en el check...',
    successMessage: (result) => `Contingencia demping aplicada: ${result.updatedRows} clientes y ${result.updatedFields} campos.`,
    successLog: (result) => `Contingencia demping completada usando ${result.checkPath}. M-30212: ${result.m30212Count}. M-30005: ${result.m30005Count}. Clientes actualizados: ${result.updatedRows}. Campos tocados: ${result.updatedFields}. No encontrados: ${result.notMatchedCount ?? 0}.`,
    action: (payload) => fiberDesktopApi.applyDempingContingency(payload)
  });
}

async function initialize() {
  if (!fiberDesktopApi) {
    elements.appVersion.textContent = 'IPC error';
    updateInspectionCards(null);
    setRunningState(false);
    setStatus('La app no ha podido cargar la capa de escritorio. Usa el ejecutable recompilado.', 'error');
    appendLog('Fallo de inicializacion: window.fiberApp no esta disponible.', 'error');
    return;
  }

  const defaults = await fiberDesktopApi.getDefaults();
  const ping = await fiberDesktopApi.ping();
  elements.appVersion.textContent = `v${defaults.appVersion}`;

  if (defaults.templatePath) {
    elements.templatePath.value = defaults.templatePath;
    appendLog(`Template interno detectado: ${defaults.templatePath}`, 'meta');
  }

  appendLog(`IPC activo (${ping.timestamp})`, 'meta');

  maybePopulateOutput();
  updateInspectionCards(null);
  setRunningState(false);
}

elements.outputPath.addEventListener('input', () => {
  state.outputTouched = elements.outputPath.value.trim() !== '';
});

elements.fcPath.addEventListener('change', maybePopulateOutput);
elements.projectFolderPath.addEventListener('change', maybePopulateOutput);

elements.browseTemplateButton.addEventListener('click', () => {
  void chooseFile(elements.templatePath, {
    title: 'Selecciona el template MDB',
    filters: [{ name: 'Access MDB', extensions: ['mdb'] }]
  });
});

elements.browseFcButton.addEventListener('click', () => {
  void chooseFile(elements.fcPath, {
    title: 'Selecciona el fichero FC',
    filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
  });
});

elements.browseBcButton.addEventListener('click', () => {
  void chooseFile(elements.bcPath, {
    title: 'Selecciona el fichero BC',
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
});

elements.browseProjectFolderButton.addEventListener('click', () => {
  void chooseProjectFolder();
});

elements.browseOutputButton.addEventListener('click', () => {
  void chooseOutputPath();
});

elements.inspectButton.addEventListener('click', () => {
  void inspectProjectFolder();
});

elements.generateButton.addEventListener('click', () => {
  void generateMdb();
});

elements.generateCrossCheckButton.addEventListener('click', () => {
  void generateCrossCheck();
});

elements.inspectConnectionBalanceButton.addEventListener('click', () => {
  void inspectConnectionBalance();
});

elements.adjustConnectionsButton.addEventListener('click', () => {
  void adjustConnections();
});

elements.fixCustomerDempingsButton.addEventListener('click', () => {
  void fixCustomerDempings();
});

elements.updateFcButton.addEventListener('click', () => {
  void updateFc();
});

elements.riserButton.addEventListener('click', () => {
  void openRiserWindow();
});

elements.createBuiseindButton.addEventListener('click', () => {
  void createBuiseind();
});

elements.glaspoortProjectButton.addEventListener('click', () => {
  void applyGlaspoortProject();
});

elements.rebuildCustomerComplexesButton.addEventListener('click', () => {
  void rebuildCustomerComplexes();
});

elements.drawCustomerCoordinatesButton.addEventListener('click', () => {
  void drawCustomerCoordinates();
});

elements.clearCustomerCoordinatesButton.addEventListener('click', () => {
  void clearCustomerCoordinates();
});

elements.extractCustomerCoordinatesButton.addEventListener('click', () => {
  void extractCustomerCoordinates();
});

elements.moveResvCoordinatesToDpButton.addEventListener('click', () => {
  void moveResvCoordinatesToDp();
});

elements.removeExtraRolesButton.addEventListener('click', () => {
  void removeExtraRoles();
});

elements.drawAccessnetWithoutAddressButton.addEventListener('click', () => {
  void drawAccessnetWithoutAddress();
});

elements.applyDempingContingencyButton.addEventListener('click', () => {
  void applyDempingContingency();
});

elements.getOapCoordinateButton.addEventListener('click', () => {
  void getOapCoordinate();
});

  elements.cancelButton.addEventListener('click', async () => {
    setStatus('Cancelando generación...', 'warning');
    appendLog('Solicitud de cancelación enviada.', 'warning');
    if (fiberDesktopApi) {
      await fiberDesktopApi.cancelGeneration();
    }
  });

elements.openOutputButton.addEventListener('click', async () => {
  if (!state.lastOutputPath) {
    return;
  }

  if (fiberDesktopApi) {
    await fiberDesktopApi.showItemInFolder(state.lastOutputPath);
  }
});

elements.clearLogButton.addEventListener('click', () => {
  elements.logOutput.innerHTML = '';
});

const removeGenerationListener = fiberDesktopApi
  ? fiberDesktopApi.onGenerationEvent((event) => {
      if (event.type === 'log') {
        appendLog(event.message, event.level === 'error' ? 'error' : event.level === 'warning' ? 'warning' : 'info');
        return;
      }

      if (event.type === 'status') {
        appendLog(event.message, 'meta');
        setStatus(event.message, 'neutral');
        return;
      }

      if (event.type === 'update') {
        const tone = event.level === 'error'
          ? 'error'
          : event.level === 'warning'
            ? 'warning'
            : event.level === 'success'
              ? 'success'
              : 'neutral';
        appendLog(event.message, event.level === 'error' ? 'error' : event.level === 'warning' ? 'warning' : event.level === 'success' ? 'success' : 'meta');
        setStatus(event.message, tone);
        return;
      }

      if (event.type === 'progress') {
        setStatus(event.message, 'neutral');
        return;
      }

      if (event.type === 'summary') {
        updateInspectionCards(event.diagnostics);
      }
    })
  : () => {};

window.addEventListener('beforeunload', () => {
  removeGenerationListener();
});

void initialize();
