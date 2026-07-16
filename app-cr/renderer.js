const elements = {
  caseFolderPath: document.getElementById('caseFolderPath'),
  reportOutputPath: document.getElementById('reportOutputPath'),
  buildOutputRootPath: document.getElementById('buildOutputRootPath'),
  inspectButton: document.getElementById('inspectButton'),
  browseCaseFolderButton: document.getElementById('browseCaseFolderButton'),
  browseReportOutputButton: document.getElementById('browseReportOutputButton'),
  browseBuildOutputRootButton: document.getElementById('browseBuildOutputRootButton'),
  exportReportButton: document.getElementById('exportReportButton'),
  buildTreeButton: document.getElementById('buildTreeButton'),
  openCaseFolderButton: document.getElementById('openCaseFolderButton'),
  openReportFolderButton: document.getElementById('openReportFolderButton'),
  clearLogButton: document.getElementById('clearLogButton'),
  statusBanner: document.getElementById('statusBanner'),
  appVersion: document.getElementById('appVersion'),
  packageStatus: document.getElementById('packageStatus'),
  packageDetail: document.getElementById('packageDetail'),
  rdStatus: document.getElementById('rdStatus'),
  rdDetail: document.getElementById('rdDetail'),
  sourceStatus: document.getElementById('sourceStatus'),
  sourceDetail: document.getElementById('sourceDetail'),
  questionCard: document.getElementById('questionCard'),
  questionStatus: document.getElementById('questionStatus'),
  questionDetail: document.getElementById('questionDetail'),
  summaryOutput: document.getElementById('summaryOutput'),
  logOutput: document.getElementById('logOutput')
};

const desktopApi = window.crStudio ?? null;

const state = {
  running: false,
  lastReport: null,
  lastReportPath: null
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

function setStatus(message, tone = 'neutral') {
  elements.statusBanner.textContent = message;
  elements.statusBanner.dataset.tone = tone;
}

function appendLog(message, tone = 'info') {
  const lines = String(message ?? '').replace(/\r/g, '').split('\n').filter(Boolean);
  for (const line of lines) {
    const entry = document.createElement('div');
    entry.className = `log-line ${tone}`;
    entry.textContent = `[${new Date().toLocaleTimeString('es-ES')}] ${line}`;
    elements.logOutput.append(entry);
  }
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function setRunningState(running) {
  state.running = running;

  for (const control of [
    elements.inspectButton,
    elements.browseCaseFolderButton,
    elements.browseReportOutputButton,
    elements.browseBuildOutputRootButton,
    elements.exportReportButton,
    elements.buildTreeButton,
    elements.openCaseFolderButton
  ]) {
    control.disabled = running;
  }

  elements.caseFolderPath.disabled = running;
  elements.reportOutputPath.disabled = running;
  elements.buildOutputRootPath.disabled = running;
  elements.openReportFolderButton.disabled = running || !state.lastReportPath;
}

function defaultReportPath() {
  const caseFolderPath = elements.caseFolderPath.value.trim();
  if (!caseFolderPath) {
    return '';
  }

  return `${caseFolderPath}\\${basename(caseFolderPath)}.analysis.json`;
}

function ensureReportPath() {
  if (!elements.reportOutputPath.value.trim()) {
    elements.reportOutputPath.value = defaultReportPath().replace(/\.analysis\.json$/i, '.sources.json');
  }
}

function ensureBuildOutputRootPath() {
  const caseFolderPath = elements.caseFolderPath.value.trim();
  if (!caseFolderPath || elements.buildOutputRootPath.value.trim()) {
    return;
  }

  elements.buildOutputRootPath.value = `${caseFolderPath}\\_generated`;
}

function renderList(title, values) {
  const block = document.createElement('section');
  block.className = 'summary-block';

  const heading = document.createElement('h3');
  heading.textContent = title;
  block.append(heading);

  if (!values || values.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'summary-empty';
    empty.textContent = 'Sin datos';
    block.append(empty);
    return block;
  }

  const list = document.createElement('ul');
  for (const value of values) {
    const item = document.createElement('li');
    item.textContent = value;
    list.append(item);
  }

  block.append(list);
  return block;
}

function updateCards(report) {
  if (!report) {
    elements.packageStatus.textContent = 'Pendiente';
    elements.packageDetail.textContent = 'Sin analizar';
    elements.rdStatus.textContent = 'Pendiente';
    elements.rdDetail.textContent = 'Sin analizar';
    elements.sourceStatus.textContent = 'Pendiente';
    elements.sourceDetail.textContent = 'Sin analizar';
    elements.questionStatus.textContent = 'Pendiente';
    elements.questionDetail.textContent = 'Sin analizar';
    elements.questionCard.dataset.tone = 'neutral';
    return;
  }

  if (report.acceptedPackage.archivePath) {
    elements.packageStatus.textContent = basename(report.acceptedPackage.archivePath);
    elements.packageDetail.textContent = `${report.acceptedPackage.archiveType?.toUpperCase() ?? 'ARCHIVE'} | ${report.acceptedPackage.topLevelFolder ?? 'Sin carpeta raiz'}`;
  }
  else {
    elements.packageStatus.textContent = 'Sin paquete';
    elements.packageDetail.textContent = 'No se ha encontrado .zip o .rar principal';
  }

  const rdCount = report.reactiedocumenten.documents.length;
  elements.rdStatus.textContent = report.reactiedocumenten.exists ? `${rdCount} docs` : 'Sin carpeta';
  elements.rdDetail.textContent = report.reactiedocumenten.exists
    ? (report.reactiedocumenten.documents[0]?.relativePath ?? 'Carpeta encontrada sin documentos filtrados')
    : 'No se ha encontrado Reactiedocumenten o Reactie Document';

  elements.sourceStatus.textContent = `${report.sourceSummary.sourceCount} fuentes`;
  elements.sourceDetail.textContent = report.sourceSummary.labels.join(' | ') || 'Sin fuentes detectadas';

  elements.questionStatus.textContent = `${report.openQuestions.length} pendientes`;
  elements.questionDetail.textContent = report.openQuestions[0] ?? 'Sin dudas abiertas';
  elements.questionCard.dataset.tone = report.openQuestions.length > 0 ? 'warning' : 'success';
}

function renderSummary(report) {
  elements.summaryOutput.innerHTML = '';

  if (!report) {
    return;
  }

  const blocks = [
    renderList('Pistas del paquete aceptado', report.acceptedPackage.hints),
    renderList('Ficheros raiz del paquete', report.acceptedPackage.rootFiles),
    renderList('Carpetas en Aanvullende informatie', report.additionalInfo.folders),
    renderList('Archivos en Aanvullende informatie', report.additionalInfo.archives),
    renderList('Documentos RD / AD detectados', report.reactiedocumenten.documents.map((item) => item.relativePath)),
    renderList('Preguntas abiertas', report.openQuestions)
  ];

  if (report.acceptedPackage.routes) {
    blocks.unshift(renderList('Resumen de Routes.txt', [
      `Trayectos T@: ${report.acceptedPackage.routes.trajectoryCount}`,
      `Bloqueos K@: ${report.acceptedPackage.routes.cableCount}`,
      ...report.acceptedPackage.routes.preview
    ]));
  }

  if (report.acceptedPackage.email?.emails?.length > 0) {
    blocks.push(renderList('Emails detectados', report.acceptedPackage.email.emails));
  }

  if (report.acceptedPackage.checks?.preview?.length > 0) {
    blocks.push(renderList('Preview de Checks.htm', report.acceptedPackage.checks.preview));
  }

  for (const block of blocks) {
    elements.summaryOutput.append(block);
  }
}

async function inspectCase() {
  if (!desktopApi) {
    setStatus('La app no ha cargado la integracion de escritorio.', 'error');
    return;
  }

  const caseFolderPath = elements.caseFolderPath.value.trim();
  if (!caseFolderPath) {
    setStatus('Selecciona una carpeta de caso.', 'warning');
    return;
  }

  setRunningState(true);
  setStatus('Analizando caso CR/VN/RD...', 'neutral');
  appendLog(`Analizando ${caseFolderPath}`, 'meta');

  try {
    const report = await desktopApi.inspectCase(caseFolderPath);
    state.lastReport = report;
    updateCards(report);
    renderSummary(report);
    ensureReportPath();
    setStatus(`Caso analizado: ${report.caseName}`, 'success');
    appendLog(`Paquete principal: ${report.acceptedPackage.archivePath ?? 'no encontrado'}`, 'success');
    appendLog(`RD detectados: ${report.reactiedocumenten.documents.length}`, 'success');
    appendLog(`Preguntas abiertas: ${report.openQuestions.length}`, report.openQuestions.length > 0 ? 'warning' : 'success');
  }
  catch (error) {
    setStatus(error.message, 'error');
    appendLog(error.message, 'error');
  }
  finally {
    setRunningState(false);
  }
}

async function exportReport() {
  if (!desktopApi) {
    setStatus('La app no ha cargado la integracion de escritorio.', 'error');
    return;
  }

  const caseFolderPath = elements.caseFolderPath.value.trim();
  const outputPath = elements.reportOutputPath.value.trim();

  if (!caseFolderPath) {
    setStatus('Selecciona una carpeta de caso.', 'warning');
    return;
  }

  if (!outputPath) {
    setStatus('Indica la ruta del informe JSON.', 'warning');
    return;
  }

  setRunningState(true);
  setStatus('Descubriendo fuentes y exportando manifest...', 'neutral');
  appendLog(`Exportando manifest a ${outputPath}`, 'meta');

  try {
    const result = await desktopApi.discoverSources({
      caseFolderPath,
      outputPath
    });

    state.lastReportPath = result.outputPath;
    elements.openReportFolderButton.disabled = false;
    setStatus(`Manifest exportado: ${result.outputPath}`, 'success');
    appendLog(`Fuentes descubiertas para ${result.projectCode}`, 'success');
  }
  catch (error) {
    setStatus(error.message, 'error');
    appendLog(error.message, 'error');
  }
  finally {
    setRunningState(false);
  }
}

async function buildTree() {
  if (!desktopApi) {
    setStatus('La app no ha cargado la integracion de escritorio.', 'error');
    return;
  }

  const caseFolderPath = elements.caseFolderPath.value.trim();
  const outputRootPath = elements.buildOutputRootPath.value.trim();

  if (!caseFolderPath) {
    setStatus('Selecciona una carpeta de caso.', 'warning');
    return;
  }

  if (!outputRootPath) {
    setStatus('Indica la carpeta de salida VN.', 'warning');
    return;
  }

  setRunningState(true);
  setStatus('Construyendo arbol VN...', 'neutral');
  appendLog(`Construyendo salida VN en ${outputRootPath}`, 'meta');

  try {
    const result = await desktopApi.buildVnTree({
      caseFolderPath,
      outputRootPath
    });

    state.lastReportPath = result.vnRootPath;
    elements.openReportFolderButton.disabled = false;
    setStatus(`Arbol VN construido: ${result.vnRootPath}`, 'success');
    appendLog(`Proyecto: ${result.projectCode}`, 'success');
    appendLog(`Copias realizadas: ${result.copiedCount}`, 'success');
    appendLog(result.mdbGenerated ? `MDB generado en ${result.outputMdbPath}.` : 'MDB no generado.', result.mdbGenerated ? 'success' : 'warning');
    appendLog(`Meetgegevens: ${result.measurementCount} | Boringen: ${result.boringenCount} | Vergunningen: ${result.vergunningenCount} | Kastoverzicht: ${result.kastoverzichtCount}`, 'success');

    if (Array.isArray(result.warnings) && result.warnings.length > 0) {
      for (const warning of result.warnings) {
        appendLog(warning, 'warning');
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

async function chooseCaseFolder() {
  if (!desktopApi) {
    return;
  }

  const selectedPath = await desktopApi.openFolder({
    title: 'Selecciona un caso CR / VN',
    defaultPath: elements.caseFolderPath.value.trim()
  });

  if (!selectedPath) {
    return;
  }

  elements.caseFolderPath.value = selectedPath;
  elements.reportOutputPath.value = defaultReportPath().replace(/\.analysis\.json$/i, '.sources.json');
  elements.buildOutputRootPath.value = `${selectedPath}\\_generated`;
  state.lastReport = null;
  state.lastReportPath = null;
  updateCards(null);
  renderSummary(null);
}

async function chooseReportPath() {
  if (!desktopApi) {
    return;
  }

  const selectedPath = await desktopApi.saveFile({
    title: 'Guardar informe JSON',
    defaultPath: elements.reportOutputPath.value.trim() || defaultReportPath(),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (!selectedPath) {
    return;
  }

  elements.reportOutputPath.value = selectedPath;
}

async function chooseBuildOutputRoot() {
  if (!desktopApi) {
    return;
  }

  const selectedPath = await desktopApi.openFolder({
    title: 'Selecciona la carpeta de salida VN',
    defaultPath: elements.buildOutputRootPath.value.trim() || dirname(elements.caseFolderPath.value.trim())
  });

  if (!selectedPath) {
    return;
  }

  elements.buildOutputRootPath.value = selectedPath;
}

async function initialize() {
  updateCards(null);
  renderSummary(null);
  setRunningState(false);

  if (!desktopApi) {
    setStatus('La capa de escritorio no esta disponible. Usa el ejecutable recompilado.', 'error');
    appendLog('window.crStudio no esta disponible.', 'error');
    return;
  }

  const defaults = await desktopApi.getDefaults();
  const ping = await desktopApi.ping();

  elements.appVersion.textContent = `v${defaults.appVersion}`;
  if (!elements.caseFolderPath.value && defaults.defaultCaseRoot) {
    elements.caseFolderPath.value = defaults.defaultCaseRoot;
  }
  ensureReportPath();
  ensureBuildOutputRootPath();

  appendLog(`IPC activo (${ping.timestamp})`, 'meta');
  setStatus('Selecciona un caso y pulsa "Analizar caso".', 'neutral');
}

elements.inspectButton.addEventListener('click', () => {
  void inspectCase();
});

elements.browseCaseFolderButton.addEventListener('click', () => {
  void chooseCaseFolder();
});

elements.browseReportOutputButton.addEventListener('click', () => {
  void chooseReportPath();
});

elements.browseBuildOutputRootButton.addEventListener('click', () => {
  void chooseBuildOutputRoot();
});

elements.exportReportButton.addEventListener('click', () => {
  void exportReport();
});

elements.buildTreeButton.addEventListener('click', () => {
  void buildTree();
});

elements.openCaseFolderButton.addEventListener('click', () => {
  const target = elements.caseFolderPath.value.trim();
  if (target && desktopApi) {
    void desktopApi.showItemInFolder(target);
  }
});

elements.openReportFolderButton.addEventListener('click', () => {
  if (state.lastReportPath && desktopApi) {
    void desktopApi.showItemInFolder(state.lastReportPath);
  }
});

elements.clearLogButton.addEventListener('click', () => {
  elements.logOutput.innerHTML = '';
});

elements.caseFolderPath.addEventListener('change', () => {
  ensureReportPath();
  ensureBuildOutputRootPath();
});

void initialize();
