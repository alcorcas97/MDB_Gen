const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron/main');
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const generatorScriptPath = path.join(appRoot, 'generate_mdb.ps1');
const mdbToolsScriptPath = path.join(appRoot, 'app', 'mdb_tools.ps1');
const bundledTemplatePath = path.join(appRoot, 'template.mdb');
const bundledCrossCheckTemplatePath = path.join(appRoot, 'app', 'assets', 'Address cross check Cocon delivery 4.0.xlsx');
const windowIconPath = path.join(appRoot, 'app', 'assets', 'icon.png');
const splashHtmlPath = path.join(__dirname, 'splash.html');
const runtimeLogPath = path.join(os.tmpdir(), 'fiber-mdb-generator-runtime.log');
const selfTestLogPath = path.join(os.tmpdir(), 'fiber-mdb-selftest.json');

let mainWindow = null;
let splashWindow = null;
let riserWindow = null;
let activeRun = null;
let projectMetadataModule = null;
let dwgToolsModule = null;
let crossCheckToolsModule = null;
let updateCheckStarted = false;
const selfTestMode = process.argv.includes('--self-test');

function appendRuntimeLog(message) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(runtimeLogPath, line, 'utf8');
  }
  catch {
  }
}

function sendGenerationEvent(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('generation:event', payload);
}

function getProjectMetadataModule() {
  if (!projectMetadataModule) {
    projectMetadataModule = require('./lib/project-metadata.cjs');
  }

  return projectMetadataModule;
}

function getDwgToolsModule() {
  if (!dwgToolsModule) {
    dwgToolsModule = require('./lib/dwg-tools.cjs');
  }

  return dwgToolsModule;
}

function getCrossCheckToolsModule() {
  if (!crossCheckToolsModule) {
    crossCheckToolsModule = require('./lib/crosscheck-tools.cjs');
  }

  return crossCheckToolsModule;
}

function getDrawProgressMessage(drawnCount, totalCount) {
  return `Dibujando coordenadas de clientes sobre el DWG... ${drawnCount}/${totalCount}`;
}

function getDrawStageMessage(stage) {
  switch (String(stage ?? '').toLowerCase()) {
    case 'layers':
      return 'Preparando capas del DWG...';
    case 'delete':
      return 'Borrando etiquetas anteriores del DWG...';
    case 'draw':
      return 'Iniciando el dibujo de coordenadas de clientes...';
    default:
      return null;
  }
}

function getCleanupStageMessage(stage) {
  switch (String(stage ?? '').toLowerCase()) {
    case 'delete':
      return 'Borrando coordenadas de clientes del DWG...';
    case 'purge':
      return 'Ejecutando purge all en el DWG...';
    case 'audit':
      return 'Ejecutando audit en el DWG...';
    default:
      return null;
  }
}

function closeSplashWindow() {
  if (!splashWindow || splashWindow.isDestroyed()) {
    splashWindow = null;
    return;
  }

  splashWindow.close();
  splashWindow = null;
}

function revealMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    closeSplashWindow();
    return;
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  mainWindow.focus();
  closeSplashWindow();
}

function createSplashWindow() {
  if (selfTestMode) {
    return;
  }

  splashWindow = new BrowserWindow({
    width: 500,
    height: 320,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#102535',
    center: true,
    icon: fs.existsSync(windowIconPath) ? windowIconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      sandbox: true
    }
  });

  splashWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.show();
    }
  });

  splashWindow.on('closed', () => {
    splashWindow = null;
  });

  void splashWindow.loadFile(splashHtmlPath);
}

function createWindow() {
  appendRuntimeLog(`createWindow packaged=${app.isPackaged} selfTest=${selfTestMode}`);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1120,
    minHeight: 760,
    show: selfTestMode,
    backgroundColor: '#f6f0e5',
    autoHideMenuBar: true,
    icon: fs.existsSync(windowIconPath) ? windowIconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    revealMainWindow();
    setTimeout(() => {
      void maybeCheckForAppUpdates();
    }, 1800);
  });

  mainWindow.webContents.on('did-fail-load', () => {
    revealMainWindow();
  });

  void mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.on('console-message', (_event, _level, message) => {
    appendRuntimeLog(`[renderer] ${message}`);
    console.log(`[renderer] ${message}`);
  });

  mainWindow.webContents.on('did-finish-load', async () => {
    if (!selfTestMode) {
      setTimeout(() => {
        void maybeCheckForAppUpdates();
      }, 2500);
      return;
    }

    try {
      const result = await mainWindow.webContents.executeJavaScript(`
        (async () => {
          const info = {
            hasFiberApp: Boolean(window.fiberApp),
            methodNames: window.fiberApp ? Object.keys(window.fiberApp) : [],
            statusBefore: document.getElementById('statusBanner')?.textContent ?? null
          };

          document.getElementById('inspectButton')?.click();
          await new Promise((resolve) => setTimeout(resolve, 250));

          info.statusAfterClick = document.getElementById('statusBanner')?.textContent ?? null;

          if (window.fiberApp?.ping) {
            info.ping = await window.fiberApp.ping();
          }

          if (window.fiberApp?.getDefaults) {
            info.defaults = await window.fiberApp.getDefaults();
          }

          return info;
        })();
      `);

      fs.writeFileSync(selfTestLogPath, JSON.stringify(result, null, 2), 'utf8');
      appendRuntimeLog(`[self-test] wrote ${selfTestLogPath}`);
      console.log('[self-test] ' + JSON.stringify(result));
    }
    catch (error) {
      appendRuntimeLog('[self-test-error] ' + (error && error.stack ? error.stack : String(error)));
      console.error('[self-test] ' + (error && error.stack ? error.stack : String(error)));
    }
    finally {
      setTimeout(() => app.quit(), 750);
    }
  });

  mainWindow.on('closed', () => {
    if (riserWindow && !riserWindow.isDestroyed()) {
      riserWindow.close();
    }
    riserWindow = null;
    mainWindow = null;
    closeSplashWindow();
  });
}

function openRiserWindow(payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('La ventana principal no esta disponible.');
  }

  const query = {
    fcPath: String(payload.fcPath ?? '').trim(),
    bcPath: String(payload.bcPath ?? '').trim(),
    projectFolderPath: String(payload.projectFolderPath ?? '').trim()
  };

  if (riserWindow && !riserWindow.isDestroyed()) {
    void riserWindow.loadFile(path.join(__dirname, 'riser.html'), { query });
    riserWindow.show();
    riserWindow.focus();
    return riserWindow;
  }

  riserWindow = new BrowserWindow({
    width: 1460,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    parent: mainWindow,
    show: false,
    backgroundColor: '#f6f0e5',
    autoHideMenuBar: true,
    icon: fs.existsSync(windowIconPath) ? windowIconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  riserWindow.once('ready-to-show', () => {
    if (riserWindow && !riserWindow.isDestroyed()) {
      riserWindow.show();
      riserWindow.focus();
    }
  });

  riserWindow.on('closed', () => {
    riserWindow = null;
  });

  void riserWindow.loadFile(path.join(__dirname, 'riser.html'), { query });
  return riserWindow;
}

function buildFailureMessage(transcript) {
  const normalized = String(transcript ?? '');

  if (/DAO\.DBEngine\.120|Microsoft\.ACE\.OLEDB\.12\.0/i.test(normalized)) {
    return 'La generacion ha fallado porque falta el motor de Access y Excel (ACE/DAO) en este equipo. Instala Microsoft Access Database Engine y vuelve a intentarlo.';
  }

  return 'La generacion ha fallado. Revisa el log para ver el punto exacto del error.';
}

function normalizeVersionString(value) {
  return String(value ?? '')
    .trim()
    .replace(/^v/i, '')
    .replace(/[^\d.].*$/, '');
}

function compareAppVersions(leftVersion, rightVersion) {
  const leftParts = normalizeVersionString(leftVersion).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = normalizeVersionString(rightVersion).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;

    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }

  return 0;
}

function getConfiguredGitHubRepository() {
  try {
    const packageJsonPath = path.join(appRoot, 'package.json');
    const rawPackage = fs.readFileSync(packageJsonPath, 'utf8');
    const packageData = JSON.parse(rawPackage);
    const repositoryValue = packageData?.repository;

    if (typeof repositoryValue === 'string') {
      const match = repositoryValue.match(/github\.com[:/](?<repo>[^/]+\/[^/.]+)(?:\.git)?$/i);
      return match?.groups?.repo ?? null;
    }

    if (repositoryValue && typeof repositoryValue.url === 'string') {
      const match = repositoryValue.url.match(/github\.com[:/](?<repo>[^/]+\/[^/.]+)(?:\.git)?$/i);
      return match?.groups?.repo ?? null;
    }
  }
  catch (error) {
    appendRuntimeLog(`update-config-error ${error?.message ?? error}`);
  }

  return null;
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        'User-Agent': 'Fiber-MDB-Generator'
      }
    }, (response) => {
      if (!response.statusCode || response.statusCode >= 400) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode ?? 'error'}`));
        return;
      }

      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        }
        catch (error) {
          reject(error);
        }
      });
    });

    request.on('error', reject);
    request.setTimeout(12000, () => {
      request.destroy(new Error('Tiempo de espera agotado consultando GitHub.'));
    });
  });
}

function downloadFile(url, destinationPath) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(destinationPath);
    const request = https.get(url, {
      headers: {
        'User-Agent': 'Fiber-MDB-Generator'
      }
    }, (response) => {
      if (!response.statusCode || response.statusCode >= 400) {
        fileStream.close(() => {});
        fs.rm(destinationPath, { force: true }, () => {});
        response.resume();
        reject(new Error(`HTTP ${response.statusCode ?? 'error'} descargando instalador.`));
        return;
      }

      response.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(destinationPath);
        });
      });
    });

    request.on('error', (error) => {
      fileStream.close(() => {});
      fs.rm(destinationPath, { force: true }, () => {});
      reject(error);
    });

    request.setTimeout(30000, () => {
      request.destroy(new Error('Tiempo de espera agotado descargando el instalador.'));
    });
  });
}

function findPreferredInstallerAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const installerAssets = assets.filter((asset) => /\.exe$/i.test(String(asset?.name ?? '')));
  if (installerAssets.length === 0) {
    return null;
  }

  const preferred = installerAssets.find((asset) => /installer/i.test(String(asset?.name ?? '')));
  return preferred ?? installerAssets[0];
}

async function maybeCheckForAppUpdates() {
  if (updateCheckStarted || selfTestMode) {
    return;
  }

  updateCheckStarted = true;
  const repositoryFullName = getConfiguredGitHubRepository();
  if (!repositoryFullName || !mainWindow || mainWindow.isDestroyed()) {
    appendRuntimeLog(`update-check skipped repository=${repositoryFullName ?? 'none'} mainWindow=${Boolean(mainWindow)}`);
    return;
  }

  try {
    appendRuntimeLog(`update-check start repository=${repositoryFullName} current=${app.getVersion()}`);
    const release = await requestJson(`https://api.github.com/repos/${repositoryFullName}/releases/latest`);
    const currentVersion = app.getVersion();
    const latestVersion = normalizeVersionString(release?.tag_name ?? release?.name);
    const installerAsset = findPreferredInstallerAsset(release);

    appendRuntimeLog(
      `update-check release current=${currentVersion} latest=${latestVersion} tag=${String(release?.tag_name ?? '')} installer=${String(installerAsset?.name ?? 'none')}`
    );

    if (!latestVersion || compareAppVersions(latestVersion, currentVersion) <= 0) {
      appendRuntimeLog(`update-check no-new-version current=${currentVersion} latest=${latestVersion}`);
      return;
    }
    const response = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Nueva versión disponible',
      message: `Hay una versión nueva de Fiber MDB Generator (${latestVersion}).`,
      detail: installerAsset
        ? 'Puedes descargar e instalar ahora mismo el nuevo instalador.'
        : 'Hay una release nueva en GitHub, pero no se ha encontrado un instalador .exe en los assets.',
      buttons: installerAsset ? ['Instalar ahora', 'Más tarde'] : ['Abrir release', 'Más tarde'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });

    appendRuntimeLog(`update-check prompt-response response=${response.response}`);

    if (response.response !== 0) {
      return;
    }

    if (installerAsset?.browser_download_url) {
      const targetPath = path.join(os.tmpdir(), installerAsset.name);
      appendRuntimeLog(`update-check download-start target=${targetPath}`);
      await downloadFile(installerAsset.browser_download_url, targetPath);
      appendRuntimeLog(`update-check download-complete target=${targetPath}`);
      await shell.openPath(targetPath);
      return;
    }

    if (release?.html_url) {
      await shell.openExternal(release.html_url);
    }
  }
  catch (error) {
    appendRuntimeLog(`update-check-error ${error?.message ?? error}`);
  }
}

function validateGenerationInput(payload) {
  const missingFields = [];

  for (const [key, label] of [
    ['templatePath', 'Template MDB'],
    ['fcPath', 'FC Excel'],
    ['bcPath', 'BC CSV'],
    ['projectFolderPath', 'Carpeta del proyecto'],
    ['outputPath', 'MDB de salida']
  ]) {
    if (!String(payload?.[key] ?? '').trim()) {
      missingFields.push(label);
    }
  }

  if (missingFields.length > 0) {
    throw new Error(`Faltan rutas obligatorias: ${missingFields.join(', ')}.`);
  }
}

function validateProjectAndMdbInput(payload) {
  const missingFields = [];

  for (const [key, label] of [
    ['projectFolderPath', 'Carpeta del proyecto']
  ]) {
    if (!String(payload?.[key] ?? '').trim()) {
      missingFields.push(label);
    }
  }

  if (missingFields.length > 0) {
    throw new Error(`Faltan rutas obligatorias: ${missingFields.join(', ')}.`);
  }
}

function validateCrossCheckInput(payload) {
  const missingFields = [];

  for (const [key, label] of [
    ['fcPath', 'FC Excel'],
    ['bcPath', 'BC CSV'],
    ['projectFolderPath', 'Carpeta del proyecto']
  ]) {
    if (!String(payload?.[key] ?? '').trim()) {
      missingFields.push(label);
    }
  }

  if (missingFields.length > 0) {
    throw new Error(`Faltan rutas obligatorias: ${missingFields.join(', ')}.`);
  }
}

async function resolveProjectWorkingMdbPath(projectFolderPath) {
  const resolvedProjectFolder = path.resolve(String(projectFolderPath ?? '').trim());
  const projectFolderName = path.basename(resolvedProjectFolder).toLowerCase();
  const queue = [resolvedProjectFolder];
  const mdbCandidates = [];

  while (queue.length > 0) {
    const currentFolder = queue.shift();
    const entries = await fsp.readdir(currentFolder, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentFolder, entry.name);

      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.mdb') {
        continue;
      }

      if (entry.name.toLowerCase().endsWith('.generated.mdb')) {
        continue;
      }

      const relativeDirectory = path.relative(resolvedProjectFolder, path.dirname(fullPath));
      const normalizedRelativeDirectory = relativeDirectory.toLowerCase();

      mdbCandidates.push({
        name: entry.name,
        fullPath,
        relativeDirectory,
        isArchived: /(^|[\\/])(archief|archive|backup|bak)([\\/]|$)/i.test(normalizedRelativeDirectory),
        depth: relativeDirectory ? relativeDirectory.split(path.sep).length : 0
      });
    }
  }

  mdbCandidates.sort((left, right) => {
    if (left.isArchived !== right.isArchived) {
      return left.isArchived ? 1 : -1;
    }

    const leftExact = path.basename(left.name, '.mdb').toLowerCase() === projectFolderName;
    const rightExact = path.basename(right.name, '.mdb').toLowerCase() === projectFolderName;
    if (leftExact !== rightExact) {
      return leftExact ? -1 : 1;
    }

    if (left.depth !== right.depth) {
      return left.depth - right.depth;
    }

    return left.fullPath.localeCompare(right.fullPath, 'es');
  });

  if (mdbCandidates.length === 0) {
    throw new Error('No se ha encontrado un MDB de trabajo dentro de la carpeta del proyecto. La .generated se conserva como backup y no se usa para estas acciones.');
  }

  return mdbCandidates[0].fullPath;
}

function runPowerShellFile(scriptPath, scriptArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const runState = {
      cancelRequested: false,
      child: null
    };

    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      ...scriptArgs
    ];

    const child = spawn('powershell.exe', args, {
      cwd: appRoot,
      windowsHide: true
    });

    runState.child = child;
    activeRun = runState;

    let transcript = '';

    const forwardChunk = (chunk, level) => {
      const message = chunk.toString();
      transcript += message;
      if (options.forwardOutput !== false) {
        sendGenerationEvent({ type: 'log', level, message });
      }
    };

    child.stdout.on('data', (chunk) => forwardChunk(chunk, 'info'));
    child.stderr.on('data', (chunk) => forwardChunk(chunk, 'error'));

    child.on('error', (error) => {
      if (activeRun === runState) {
        activeRun = null;
      }

      reject(error);
    });

    child.on('close', (code) => {
      const wasCancelled = runState.cancelRequested;

      if (activeRun === runState) {
        activeRun = null;
      }

      if (wasCancelled) {
        const error = new Error('La generacion fue cancelada.');
        error.cancelled = true;
        reject(error);
        return;
      }

      if (code === 0) {
        resolve({ transcript });
        return;
      }

      if (typeof options.buildFailureMessage === 'function') {
        reject(new Error(options.buildFailureMessage(transcript)));
        return;
      }

      reject(new Error(transcript.trim() || 'La operacion ha fallado.'));
    });
  });
}

function runPowerShellScript(scriptArgs) {
  return runPowerShellFile(generatorScriptPath, scriptArgs, {
    forwardOutput: true,
    buildFailureMessage
  });
}

function runGeneratorWithPowerShell(payload, metadataPath) {
  return runPowerShellScript([
    '-TemplatePath',
    payload.templatePath,
    '-FcPath',
    payload.fcPath,
    '-BcPath',
    payload.bcPath,
    '-OutputPath',
    payload.outputPath,
    '-ProjectFolderPath',
    payload.projectFolderPath,
    '-MetadataPath',
    metadataPath
  ]);
}

async function runPowerShellJson(scriptPath, scriptArgs) {
  const { transcript } = await runPowerShellFile(scriptPath, scriptArgs, {
    forwardOutput: false
  });

  const normalizedTranscript = String(transcript ?? '').replace(/^\uFEFF/, '').trim();
  return JSON.parse(normalizedTranscript);
}

async function runMdbToolsJson(scriptArgs) {
  return runPowerShellJson(mdbToolsScriptPath, scriptArgs);
}

async function exportCrossCheckWorkbook(payload) {
  const workingMdbPath = await resolveProjectWorkingMdbPath(payload.projectFolderPath);
  const tableRows = await runMdbToolsJson([
    '-Mode',
    'ExportCrossCheckData',
    '-MdbPath',
    workingMdbPath
  ]);
  const { exportCrossCheckWorkbook: exportCrossCheckWorkbookFile } = getCrossCheckToolsModule();
  const result = await exportCrossCheckWorkbookFile({
    projectFolderPath: payload.projectFolderPath,
    templatePath: bundledCrossCheckTemplatePath,
    mdbPath: workingMdbPath,
    fcPath: payload.fcPath,
    bcPath: payload.bcPath,
    tableRows
  });

  return {
    mdbPath: result.mdbPath ?? workingMdbPath,
    outputPath: result.outputPath
  };
}

async function exportConnectionSyncData(payload, outputPath) {
  await runPowerShellScript([
    '-FcPath',
    payload.fcPath,
    '-BcPath',
    payload.bcPath,
    '-ProjectFolderPath',
    payload.projectFolderPath,
    '-ExportConnectionSyncDataOnly',
    '-ConnectionSyncDataOutputPath',
    outputPath
  ]);
}

async function exportRiserData(payload, outputPath) {
  await runPowerShellScript([
    '-FcPath',
    payload.fcPath,
    '-BcPath',
    payload.bcPath,
    '-ProjectFolderPath',
    payload.projectFolderPath,
    '-ExportRiserDataOnly',
    '-RiserDataOutputPath',
    outputPath
  ]);
}

async function analyzeAmbiguousInternalDpsWithPowerShell(payload, metadataPath) {
  const analysisPath = path.join(
    os.tmpdir(),
    `fiber-mdb-analysis-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  try {
    await runPowerShellScript([
      '-TemplatePath',
      payload.templatePath,
      '-FcPath',
      payload.fcPath,
      '-BcPath',
      payload.bcPath,
      '-OutputPath',
      payload.outputPath,
      '-ProjectFolderPath',
      payload.projectFolderPath,
      '-MetadataPath',
      metadataPath,
      '-AnalyzeOnly',
      '-AnalysisOutputPath',
      analysisPath
    ]);

    const rawAnalysis = await fsp.readFile(analysisPath, 'utf8');
    const normalizedAnalysis = rawAnalysis.replace(/^\uFEFF/, '');
    return JSON.parse(normalizedAnalysis);
  }
  finally {
    await fsp.rm(analysisPath, { force: true }).catch(() => {});
  }
}

async function resolveAmbiguousInternalDps(analysis) {
  const candidates = Array.isArray(analysis?.AmbiguousInternalDps)
    ? analysis.AmbiguousInternalDps
    : [];

  const decisions = {};

  for (const candidate of candidates) {
    const dpLabel = String(candidate?.DpLabel ?? '').trim();
    if (!dpLabel) {
      continue;
    }

    sendGenerationEvent({
      type: 'status',
      message: `Confirmacion requerida para ${dpLabel}.`
    });

    const response = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Confirmar DP interno',
      message: `${dpLabel}: ¿debe tratarse como DP interno?`,
      detail: `${candidate.Reason}\n\nSi eliges "No", la generacion usara 48 fibras. Si eliges "Si", se tratara como interno/BUDI de 96 fibras.`,
      buttons: ['No, es externo (48 fibras)', 'Si, es interno (96 fibras)', 'Cancelar'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });

    if (response.response === 2) {
      const error = new Error('La generacion fue cancelada.');
      error.cancelled = true;
      throw error;
    }

    const isInternal = response.response === 1;
    decisions[dpLabel] = isInternal;

    sendGenerationEvent({
      type: 'log',
      level: 'info',
      message: `${dpLabel}: ${isInternal ? 'marcado como interno/BUDI (96 fibras).' : 'marcado como externo/normal (48 fibras).'}\n`
    });
  }

  return decisions;
}

async function promptTextInput(title, message, defaultValue = '') {
  const script = `
    (() => {
      const value = window.prompt(${JSON.stringify(message)}, ${JSON.stringify(defaultValue)});
      return value === null ? null : String(value);
    })()
  `;

  return mainWindow.webContents.executeJavaScript(script, true);
}

function parseBackboneCableLabelExample(label) {
  const normalized = String(label ?? '').trim().toUpperCase();
  const match = normalized.match(/^(.*-B)(\d+)(-K)(\d+)(-S)(\d+)$/);
  if (!match) {
    return null;
  }

  return {
    prefix: match[1],
    bNumber: Number.parseInt(match[2], 10),
    bPadLength: match[2].length,
    kNumber: Number.parseInt(match[4], 10),
    kPadLength: match[4].length,
    segmentPadLength: match[6].length
  };
}

async function resolveBackboneCableNamingChoice(projectFolderPath) {
  const projectName = path.basename(String(projectFolderPath ?? '').trim()) || 'proyecto';
  const response = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: 'Numeracion de bloqueos 96V',
    message: `Selecciona como quieres numerar los bloqueos 96V para ${projectName}.`,
    detail: 'K01 fijo genera B01-K01, B02-K01, B03-K01. Seguir bloqueo genera B01-K01, B02-K02, B03-K03. Otro te deja indicar el primer y segundo ejemplo para construir la serie.',
    buttons: ['K01 fijo', 'Seguir bloqueo', 'Otro', 'Cancelar'],
    defaultId: 1,
    cancelId: 3,
    noLink: true
  });

  if (response.response === 3) {
    const error = new Error('La generacion fue cancelada.');
    error.cancelled = true;
    throw error;
  }

  if (response.response === 0) {
    return {
      mode: 'fixedK01',
      bPadLength: 2,
      kPadLength: 2,
      segmentPadLength: 2,
      bStart: 1,
      kStart: 1,
      kStep: 0
    };
  }

  if (response.response === 1) {
    return {
      mode: 'matchBlock',
      bPadLength: 2,
      kPadLength: 2,
      segmentPadLength: 2,
      bStart: 1,
      kStart: 1,
      kStep: 1
    };
  }

  const firstExample = await promptTextInput(
    'Serie personalizada',
    'Introduce la forma del primer bloqueo 96V. Ejemplo: RT-CLY-B01-K01-S01',
    ''
  );
  if (firstExample === null) {
    const error = new Error('La generacion fue cancelada.');
    error.cancelled = true;
    throw error;
  }

  const secondExample = await promptTextInput(
    'Serie personalizada',
    'Introduce la forma del segundo bloqueo 96V. Ejemplo: RT-CLY-B02-K02-S01',
    ''
  );
  if (secondExample === null) {
    const error = new Error('La generacion fue cancelada.');
    error.cancelled = true;
    throw error;
  }

  const first = parseBackboneCableLabelExample(firstExample);
  const second = parseBackboneCableLabelExample(secondExample);

  if (!first || !second) {
    throw new Error('No se pudo interpretar la serie personalizada. Usa un formato como RT-CLY-B01-K01-S01 y RT-CLY-B02-K02-S01.');
  }

  if (first.prefix !== second.prefix) {
    throw new Error('La serie personalizada no es valida: el prefijo antes de B debe coincidir en el primer y segundo ejemplo.');
  }

  const suffixStep = second.bNumber - first.bNumber;
  if (suffixStep !== 1) {
    throw new Error('La serie personalizada no es valida: el segundo ejemplo debe representar el siguiente bloqueo (por ejemplo B02 despues de B01).');
  }

  return {
    mode: 'customSeries',
    bPadLength: first.bPadLength,
    kPadLength: first.kPadLength,
    segmentPadLength: first.segmentPadLength,
    bStart: first.bNumber,
    kStart: first.kNumber,
    kStep: second.kNumber - first.kNumber
  };
}

ipcMain.handle('app:get-defaults', async () => ({
  appVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  templatePath: fs.existsSync(bundledTemplatePath) ? bundledTemplatePath : null
}));

ipcMain.handle('app:ping', async () => ({
  ok: true,
  timestamp: new Date().toISOString(),
  isPackaged: app.isPackaged
}));

ipcMain.handle('riser:open-window', async (_event, payload) => {
  validateCrossCheckInput(payload);
  openRiserWindow(payload);
  return { opened: true };
});

ipcMain.handle('riser:load-data', async (_event, payload) => {
  validateCrossCheckInput(payload);

  const riserDataPath = path.join(
    os.tmpdir(),
    `fiber-riser-data-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  try {
    await exportRiserData(payload, riserDataPath);
    const raw = await fsp.readFile(riserDataPath, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  }
  finally {
    await fsp.rm(riserDataPath, { force: true }).catch(() => {});
  }
});

ipcMain.handle('dialog:open-file', async (_event, options = {}) => {
  const response = await dialog.showOpenDialog(mainWindow, {
    title: options.title,
    defaultPath: options.defaultPath,
    filters: options.filters,
    properties: ['openFile']
  });

  return response.canceled ? null : response.filePaths[0];
});

ipcMain.handle('dialog:open-folder', async (_event, options = {}) => {
  const response = await dialog.showOpenDialog(mainWindow, {
    title: options.title,
    defaultPath: options.defaultPath,
    properties: ['openDirectory']
  });

  return response.canceled ? null : response.filePaths[0];
});

ipcMain.handle('dialog:save-file', async (_event, options = {}) => {
  const response = await dialog.showSaveDialog(mainWindow, {
    title: options.title,
    defaultPath: options.defaultPath,
    filters: options.filters
  });

  return response.canceled ? null : response.filePath;
});

ipcMain.handle('project:inspect', async (_event, { projectFolderPath }) => {
  const { inspectProjectFolder } = getProjectMetadataModule();
  return inspectProjectFolder(projectFolderPath);
});

ipcMain.handle('shell:show-item', async (_event, targetPath) => {
  if (!String(targetPath ?? '').trim()) {
    return false;
  }

  shell.showItemInFolder(targetPath);
  return true;
});

ipcMain.handle('mdb:fix-customer-dempings', async (_event, payload) => {
  if (activeRun) {
    throw new Error('Ya hay una operacion en curso.');
  }

  validateProjectAndMdbInput(payload);
  const workingMdbPath = await resolveProjectWorkingMdbPath(payload.projectFolderPath);

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `MDB de trabajo detectado: ${workingMdbPath}\n`
  });

  sendGenerationEvent({
    type: 'status',
    message: 'Corrigiendo dempings en la tabla Klant...'
  });

  const result = await runMdbToolsJson([
    '-Mode',
    'FixCustomerDempingValues',
    '-MdbPath',
    workingMdbPath
  ]);

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `Dempings corregidos en MDB: ${result.updatedRows} clientes, ${result.updatedFields} campos.\n`
  });

  sendGenerationEvent({
    type: 'status',
    message: 'Dempings corregidos correctamente en la base de datos.'
  });

  return {
    mdbPath: workingMdbPath,
    updatedRows: result.updatedRows,
    updatedFields: result.updatedFields
  };
});

ipcMain.handle('mdb:inspect-connection-balance', async (_event, payload) => {
  if (activeRun) {
    throw new Error('Ya hay una operacion en curso.');
  }

  validateCrossCheckInput(payload);
  const workingMdbPath = await resolveProjectWorkingMdbPath(payload.projectFolderPath);
  const syncDataPath = path.join(
    os.tmpdir(),
    `fiber-connection-sync-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `MDB de trabajo detectado: ${workingMdbPath}\n`
  });

  sendGenerationEvent({
    type: 'status',
    message: 'Leyendo FC y BC para revisar el balance de conexiones...'
  });

  try {
    await exportConnectionSyncData(payload, syncDataPath);

    const result = await runMdbToolsJson([
      '-Mode',
      'InspectConnectionBalance',
      '-MdbPath',
      workingMdbPath,
      '-AssignmentsPath',
      syncDataPath
    ]);

    sendGenerationEvent({
      type: 'log',
      level: result.isBalanced ? 'info' : 'warning',
      message: `Balance de conexiones. FC: ${result.fcCount}. BC: ${result.bcCount}. FC+BC: ${result.sourceCount}. MDB: ${result.mdbCount}. Faltan: ${result.missingInMdb.length}. Sobran: ${result.extraInMdb.length}.\n`
    });

    return {
      mdbPath: workingMdbPath,
      ...result
    };
  }
  finally {
    await fsp.rm(syncDataPath, { force: true }).catch(() => {});
  }
});

ipcMain.handle('mdb:adjust-connections', async (_event, payload) => {
  if (activeRun) {
    throw new Error('Ya hay una operacion en curso.');
  }

  validateCrossCheckInput(payload);
  const workingMdbPath = await resolveProjectWorkingMdbPath(payload.projectFolderPath);
  const syncDataPath = path.join(
    os.tmpdir(),
    `fiber-connection-sync-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `MDB de trabajo detectado: ${workingMdbPath}\n`
  });

  sendGenerationEvent({
    type: 'status',
    message: 'Preparando ajuste de conexiones desde FC y BC...'
  });

  try {
    await exportConnectionSyncData(payload, syncDataPath);

    const inspection = await runMdbToolsJson([
      '-Mode',
      'InspectConnectionBalance',
      '-MdbPath',
      workingMdbPath,
      '-AssignmentsPath',
      syncDataPath
    ]);

    if (inspection.extraInMdb.length > 0) {
      const preview = inspection.extraInMdb.slice(0, 20).join('\n');
      const response = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Confirmar borrado de conexiones',
        message: `La MDB contiene ${inspection.extraInMdb.length} conexiones que ya no estan en FC+BC.`,
        detail: `Se borraran de las tablas afectadas si continuas.\n\n${preview}${inspection.extraInMdb.length > 20 ? '\n...' : ''}`,
        buttons: ['Cancelar', 'Borrar y ajustar'],
        defaultId: 1,
        cancelId: 0,
        noLink: true
      });

      if (response.response === 0) {
        return {
          mdbPath: workingMdbPath,
          cancelled: true,
          fcCount: inspection.fcCount,
          bcCount: inspection.bcCount,
          mdbCountBefore: inspection.mdbCount,
          finalCount: inspection.mdbCount,
          addedCount: 0,
          removedCount: 0
        };
      }
    }

    const result = await runMdbToolsJson([
      '-Mode',
      'ApplyConnectionSync',
      '-MdbPath',
      workingMdbPath,
      '-AssignmentsPath',
      syncDataPath
    ]);

    sendGenerationEvent({
      type: 'log',
      level: 'info',
      message: `Ajuste de conexiones aplicado. Añadidas: ${result.addedCount}. Borradas: ${result.removedCount}. Final: ${result.finalCount} conexiones.\n`
    });

    sendGenerationEvent({
      type: 'status',
      message: 'Ajuste de conexiones completado correctamente.'
    });

    return {
      mdbPath: workingMdbPath,
      cancelled: false,
      ...result
    };
  }
  finally {
    await fsp.rm(syncDataPath, { force: true }).catch(() => {});
  }
});

ipcMain.handle('mdb:update-fc', async (_event, payload) => {
  if (activeRun) {
    throw new Error('Ya hay una operacion en curso.');
  }

  const missingFields = [];
  for (const [key, label] of [
    ['fcPath', 'FC Excel'],
    ['bcPath', 'BC CSV'],
    ['projectFolderPath', 'Carpeta del proyecto']
  ]) {
    if (!String(payload?.[key] ?? '').trim()) {
      missingFields.push(label);
    }
  }

  if (missingFields.length > 0) {
    throw new Error(`Faltan rutas obligatorias: ${missingFields.join(', ')}.`);
  }

  const workingMdbPath = await resolveProjectWorkingMdbPath(payload.projectFolderPath);
  const assignmentsPath = path.join(
    os.tmpdir(),
    `fiber-fc-refresh-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `MDB de trabajo detectado: ${workingMdbPath}\n`
  });

  sendGenerationEvent({
    type: 'status',
    message: 'Leyendo FC y BC para rehacer Klant y Kabel...'
  });

  try {
    await runPowerShellScript([
      '-FcPath',
      payload.fcPath,
      '-BcPath',
      payload.bcPath,
      '-ExportFcRefreshDataOnly',
      '-FcRefreshDataOutputPath',
      assignmentsPath
    ]);

    const result = await runMdbToolsJson([
      '-Mode',
      'ApplyFcRefresh',
      '-MdbPath',
      workingMdbPath,
      '-AssignmentsPath',
      assignmentsPath
    ]);

    sendGenerationEvent({
      type: 'log',
      level: 'info',
      message: `FC rehecho en MDB. Klant rehechos: ${result.rebuiltCustomers}, con cambios en ${result.updatedCustomers} filas y ${result.updatedCustomerFields} campos. Kabel rehechos: ${result.rebuiltCables}, con cambios en ${result.updatedCables} filas y ${result.updatedCableFields} campos. Final: ${result.finalCustomers} clientes, ${result.finalCables} cables.\n`
    });

    const customerFieldChanges = Object.entries(result.customerFieldChanges ?? {});
    if (customerFieldChanges.length > 0) {
      sendGenerationEvent({
        type: 'log',
        level: 'info',
        message: `Campos cambiados en Klant: ${customerFieldChanges.map(([name, count]) => `${name}=${count}`).join(', ')}\n`
      });
    }

    const cableFieldChanges = Object.entries(result.cableFieldChanges ?? {});
    if (cableFieldChanges.length > 0) {
      sendGenerationEvent({
        type: 'log',
        level: 'info',
        message: `Campos cambiados en Kabel: ${cableFieldChanges.map(([name, count]) => `${name}=${count}`).join(', ')}\n`
      });
    }

    if (Array.isArray(result.warnings) && result.warnings.length > 0) {
      const warningLines = result.warnings.map((item) => {
        const fromValue = item?.From ?? 'vacio'
        const toValue = item?.To ?? 'vacio'
        const addressCode = item?.AddressCode ? ` [${item.AddressCode}]` : ''
        return `- ${item?.CableId ?? 'sin cable'}${addressCode}: ${fromValue} -> ${toValue}`
      });

      sendGenerationEvent({
        type: 'log',
        level: 'warning',
        message: `Revisar manualmente estos cambios sensibles de estado FC:\n${warningLines.join('\n')}\n`
      });
    }

    sendGenerationEvent({
      type: 'status',
      message: 'FC actualizado correctamente en la base de datos.'
    });

    return {
      mdbPath: workingMdbPath,
      updatedCustomers: result.updatedCustomers,
      updatedCustomerFields: result.updatedCustomerFields,
      updatedCables: result.updatedCables,
      updatedCableFields: result.updatedCableFields,
      rebuiltCustomers: result.rebuiltCustomers,
      rebuiltCables: result.rebuiltCables,
      available: result.available,
      finalCustomers: result.finalCustomers,
      finalCables: result.finalCables,
      addedCustomers: result.addedCustomers,
      removedCustomers: result.removedCustomers,
      customerFieldChanges: result.customerFieldChanges ?? {},
      cableFieldChanges: result.cableFieldChanges ?? {},
      warnings: result.warnings ?? []
    };
  }
  finally {
    await fsp.rm(assignmentsPath, { force: true }).catch(() => {});
  }
});

ipcMain.handle('mdb:apply-riser-data', async (_event, payload) => {
  if (activeRun) {
    throw new Error('Ya hay una operacion en curso.');
  }

  validateCrossCheckInput(payload);

  const dpLabel = String(payload?.dpLabel ?? '').trim();
  const tableRows = payload?.tableRows ?? null;
  if (!dpLabel) {
    throw new Error('Falta el DP del riser.');
  }

  if (!tableRows || !Array.isArray(tableRows.Traject) || !Array.isArray(tableRows.Duct) || !Array.isArray(tableRows.Accesspoint)) {
    throw new Error('Los datos del riser no tienen el formato esperado.');
  }

  const workingMdbPath = await resolveProjectWorkingMdbPath(payload.projectFolderPath);
  const assignmentsPath = path.join(
    os.tmpdir(),
    `fiber-riser-apply-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  const normalizedPayload = {
    DpLabel: dpLabel,
    TableRows: {
      Traject: tableRows.Traject,
      Duct: tableRows.Duct,
      Accesspoint: tableRows.Accesspoint
    },
    KabelTypeUpdates: Array.isArray(payload?.kabelTypeUpdates) ? payload.kabelTypeUpdates : []
  };

  await fsp.writeFile(assignmentsPath, JSON.stringify(normalizedPayload, null, 2), 'utf8');

  try {
    const result = await runMdbToolsJson([
      '-Mode',
      'ApplyRiserData',
      '-MdbPath',
      workingMdbPath,
      '-AssignmentsPath',
      assignmentsPath
    ]);

    return {
      ...result,
      mdbPath: workingMdbPath
    };
  }
  finally {
    await fsp.rm(assignmentsPath, { force: true }).catch(() => {});
  }
});

ipcMain.handle('mdb:apply-glaspoort-project', async (_event, payload) => {
  if (activeRun) {
    throw new Error('Ya hay una operacion en curso.');
  }

  validateProjectAndMdbInput(payload);
  const workingMdbPath = await resolveProjectWorkingMdbPath(payload.projectFolderPath);

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `MDB de trabajo detectado: ${workingMdbPath}\n`
  });

  sendGenerationEvent({
    type: 'status',
    message: 'Aplicando filas de Glaspoort Project en Instellingen...'
  });

  const result = await runMdbToolsJson([
    '-Mode',
    'ApplyGlaspoortProject',
    '-MdbPath',
    workingMdbPath
  ]);

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `Instellingen actualizado. Filas insertadas: ${result.inserted}. Filas actualizadas: ${result.updated}.\n`
  });

  sendGenerationEvent({
    type: 'status',
    message: 'Glaspoort Project aplicado correctamente.'
  });

  return {
    mdbPath: workingMdbPath,
    inserted: result.inserted,
    updated: result.updated
  };
});

ipcMain.handle('mdb:rebuild-customer-complexes', async (_event, payload) => {
  if (activeRun) {
    throw new Error('Ya hay una operacion en curso.');
  }

  validateCrossCheckInput(payload);
  const workingMdbPath = await resolveProjectWorkingMdbPath(payload.projectFolderPath);
  const assignmentsPath = path.join(
    os.tmpdir(),
    `fiber-complex-assignments-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `MDB de trabajo detectado: ${workingMdbPath}\n`
  });

  sendGenerationEvent({
    type: 'status',
    message: 'Calculando COMPLEX desde FC, BC y Gebouwen...'
  });

  try {
    await runPowerShellScript([
      '-FcPath',
      payload.fcPath,
      '-BcPath',
      payload.bcPath,
      '-ProjectFolderPath',
      payload.projectFolderPath,
      '-ExportComplexAssignmentsOnly',
      '-ComplexAssignmentsOutputPath',
      assignmentsPath
    ]);

    const result = await runMdbToolsJson([
      '-Mode',
      'RebuildCustomerComplexes',
      '-MdbPath',
      workingMdbPath,
      '-AssignmentsPath',
      assignmentsPath
    ]);

    sendGenerationEvent({
      type: 'log',
      level: 'info',
      message: `COMPLEX rehecho en MDB: ${result.updated} clientes actualizados, ${result.assigned} asignados, ${result.cleared} limpiados.\n`
    });

    sendGenerationEvent({
      type: 'status',
      message: 'COMPLEX rehecho correctamente.'
    });

    return {
      mdbPath: workingMdbPath,
      updated: result.updated,
      assigned: result.assigned,
      cleared: result.cleared,
      available: result.available
    };
  }
  finally {
    await fsp.rm(assignmentsPath, { force: true }).catch(() => {});
  }
});

ipcMain.handle('dwg:draw-customers', async (_event, payload) => {
  if (activeRun) {
    throw new Error('Ya hay una operacion en curso.');
  }

  validateProjectAndMdbInput(payload);
  const workingMdbPath = await resolveProjectWorkingMdbPath(payload.projectFolderPath);

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `MDB de trabajo detectado: ${workingMdbPath}\n`
  });

  sendGenerationEvent({
    type: 'status',
    message: 'Preparando etiquetas de clientes para el DWG...'
  });

  const drawItems = await runMdbToolsJson([
    '-Mode',
    'ExportCustomerDrawData',
    '-MdbPath',
    workingMdbPath
  ]);

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `Clientes listos para dibujar: ${drawItems.length}\n`
  });

  sendGenerationEvent({
    type: 'status',
    message: getDrawProgressMessage(0, drawItems.length)
  });

  const { drawCustomerCoordinatesToDwg } = getDwgToolsModule();
  const result = await drawCustomerCoordinatesToDwg(payload.projectFolderPath, Array.isArray(drawItems) ? drawItems : [], {
    onStage: (stage) => {
      const message = getDrawStageMessage(stage);
      if (!message) {
        return;
      }

      sendGenerationEvent({
        type: 'status',
        message
      });
    },
    onProgress: ({ drawnCount, totalCount }) => {
      sendGenerationEvent({
        type: 'progress',
        current: drawnCount,
        total: totalCount,
        message: getDrawProgressMessage(drawnCount, totalCount)
      });
    }
  });

  if (result.usedOpenDocument) {
    sendGenerationEvent({
      type: 'log',
      level: 'info',
      message: 'DWG abierto detectado en AutoCAD. El dibujo se ha ejecutado sobre el documento abierto.\n'
    });
  }

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `DWG actualizado: ${result.drawnCount} textos creados en ${result.dwgPath}\n`
  });

  if (result.timedOut) {
    sendGenerationEvent({
      type: 'log',
      level: 'warning',
      message: 'AutoCAD tardo demasiado en cerrarse, pero el DWG ya habia quedado guardado con las etiquetas.\n'
    });
  }

  sendGenerationEvent({
    type: 'status',
    message: 'Coordenadas de clientes dibujadas correctamente.'
  });

  return {
    mdbPath: workingMdbPath,
    dwgPath: result.dwgPath,
    drawnCount: result.drawnCount
  };
});

ipcMain.handle('dwg:clear-customers', async (_event, payload) => {
  if (activeRun) {
    throw new Error('Ya hay una operacion en curso.');
  }

  validateProjectAndMdbInput(payload);

  sendGenerationEvent({
    type: 'status',
    message: 'Preparando limpieza del DWG...'
  });

  const { clearCustomerCoordinatesInDwg } = getDwgToolsModule();
  const result = await clearCustomerCoordinatesInDwg(payload.projectFolderPath, {
    onStage: (stage) => {
      const message = getCleanupStageMessage(stage);
      if (!message) {
        return;
      }

      sendGenerationEvent({
        type: 'status',
        message
      });
    }
  });

  if (result.usedOpenDocument) {
    sendGenerationEvent({
      type: 'log',
      level: 'info',
      message: 'DWG abierto detectado en AutoCAD. La limpieza se ha ejecutado sobre el documento abierto.\n'
    });
  }

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `DWG limpiado: ${result.removedCount} etiquetas borradas en ${result.dwgPath}\n`
  });

  if (result.timedOut) {
    sendGenerationEvent({
      type: 'log',
      level: 'warning',
      message: 'AutoCAD tardo demasiado en cerrarse, pero el DWG ya habia quedado guardado con la limpieza.\n'
    });
  }

  sendGenerationEvent({
    type: 'status',
    message: 'Coordenadas de clientes eliminadas y DWG limpiado correctamente.'
  });

  return {
    dwgPath: result.dwgPath,
    removedCount: result.removedCount
  };
});

ipcMain.handle('dwg:extract-customers', async (_event, payload) => {
  if (activeRun) {
    throw new Error('Ya hay una operacion en curso.');
  }

  validateProjectAndMdbInput(payload);
  const workingMdbPath = await resolveProjectWorkingMdbPath(payload.projectFolderPath);

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `MDB de trabajo detectado: ${workingMdbPath}\n`
  });

  sendGenerationEvent({
    type: 'status',
    message: 'Leyendo textos del DWG para importar coordenadas de clientes...'
  });

  const { extractCustomerTextCoordinates, CUSTOMER_LAYER_COLORS } = getDwgToolsModule();
  const extraction = await extractCustomerTextCoordinates(payload.projectFolderPath);
  const allowedLayers = new Set([...CUSTOMER_LAYER_COLORS.keys()].map((layer) => layer.toUpperCase()));
  const coordinates = extraction.coordinates.filter((item) => {
    const layerName = String(item.layer ?? '').trim().toUpperCase();
    return layerName && allowedLayers.has(layerName);
  });

  if (coordinates.length === 0) {
    throw new Error('No se han encontrado textos de clientes en las layers configuradas.');
  }

  if (extraction.source === 'open-document') {
    sendGenerationEvent({
      type: 'log',
      level: 'info',
      message: 'DWG abierto detectado en AutoCAD. Las coordenadas se han leido del documento abierto.\n'
    });
  }

  const tempCoordinatesPath = path.join(
    os.tmpdir(),
    `fiber-dwg-coordinates-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  try {
    await fsp.writeFile(tempCoordinatesPath, JSON.stringify(coordinates, null, 2), 'utf8');
    const importResult = await runMdbToolsJson([
      '-Mode',
      'ImportCustomerCoordinates',
      '-MdbPath',
      workingMdbPath,
      '-CoordinatesPath',
      tempCoordinatesPath
    ]);

    sendGenerationEvent({
      type: 'log',
      level: 'info',
      message: `Coordenadas leidas del DWG: ${coordinates.length}. Clientes actualizados en MDB: ${importResult.updated}. Coordenadas: ${importResult.updatedCoordinates ?? 0}. Estados GL/EG: ${importResult.updatedStatuses ?? 0}\n`
    });

    sendGenerationEvent({
      type: 'status',
      message: 'Coordenadas de clientes importadas correctamente.'
    });

    return {
      mdbPath: workingMdbPath,
      dwgPath: extraction.dwgPath,
      coordinateCount: coordinates.length,
      updated: importResult.updated,
      updatedCoordinates: importResult.updatedCoordinates ?? 0,
      updatedStatuses: importResult.updatedStatuses ?? 0
    };
  }
  finally {
    await fsp.rm(tempCoordinatesPath, { force: true }).catch(() => {});
  }
});

ipcMain.handle('dwg:remove-extra-roles', async (_event, payload) => {
  if (activeRun) {
    throw new Error('Ya hay una operacion en curso.');
  }

  validateProjectAndMdbInput(payload);

  sendGenerationEvent({
    type: 'status',
    message: 'Buscando Checks.htm y leyendo errores M-30173...'
  });

  const { removeExtraRolesFromCheck } = getDwgToolsModule();
  const result = await removeExtraRolesFromCheck(payload.projectFolderPath, {
    onStage: (stage) => {
      const messages = {
        locate: 'Buscando el fichero Checks.htm del proyecto...',
        parse: 'Extrayendo coordenadas M-30173 del check...',
        delete: 'Eliminando bloques ROL extra en el DWG...',
        purge: 'Ejecutando purge all en el DWG...',
        audit: 'Ejecutando audit en el DWG...'
      };
      const message = messages[String(stage ?? '').toLowerCase()];
      if (!message) {
        return;
      }

      sendGenerationEvent({
        type: 'status',
        message
      });
    }
  });

  if (result.usedOpenDocument) {
    sendGenerationEvent({
      type: 'log',
      level: 'info',
      message: 'DWG abierto detectado en AutoCAD. La contingencia se ha ejecutado sobre el documento abierto.\n'
    });
  }

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `Check usado: ${result.checkPath}\n`
  });

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `Coordenadas M-30173 detectadas: ${result.coordinateCount}. Bloques ROL eliminados: ${result.removedCount}\n`
  });

  if (result.timedOut) {
    sendGenerationEvent({
      type: 'log',
      level: 'warning',
      message: 'AutoCAD tardo demasiado en cerrarse, pero el DWG ya habia quedado guardado con la contingencia.\n'
    });
  }

  sendGenerationEvent({
    type: 'status',
    message: 'Contingencia de roles extra aplicada correctamente.'
  });

  return result;
});

ipcMain.handle('dwg:draw-accessnet-without-address', async (_event, payload) => {
  if (activeRun) {
    throw new Error('Ya hay una operacion en curso.');
  }

  validateProjectAndMdbInput(payload);

  sendGenerationEvent({
    type: 'status',
    message: 'Buscando Checks.htm y leyendo errores M-30001...'
  });

  const { drawAccessnetWithoutAddressFromCheck } = getDwgToolsModule();
  const result = await drawAccessnetWithoutAddressFromCheck(payload.projectFolderPath, {
    onStage: (stage) => {
      const messages = {
        locate: 'Buscando el fichero Checks.htm del proyecto...',
        parse: 'Extrayendo coordenadas M-30001 del check...',
        layers: 'Preparando capa de contingencia para accessnet...',
        draw: 'Dibujando circulos rojos en el DWG...',
        purge: 'Ejecutando purge all en el DWG...',
        audit: 'Ejecutando audit en el DWG...'
      };
      const message = messages[String(stage ?? '').toLowerCase()];
      if (!message) {
        return;
      }

      sendGenerationEvent({
        type: 'status',
        message
      });
    }
  });

  if (result.usedOpenDocument) {
    sendGenerationEvent({
      type: 'log',
      level: 'info',
      message: 'DWG abierto detectado en AutoCAD. La contingencia se ha ejecutado sobre el documento abierto.\n'
    });
  }

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `Check usado: ${result.checkPath}\n`
  });

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `Coordenadas M-30001 detectadas: ${result.coordinateCount}. Circulos rojos dibujados: ${result.drawnCount}\n`
  });

  if (result.timedOut) {
    sendGenerationEvent({
      type: 'log',
      level: 'warning',
      message: 'AutoCAD tardo demasiado en cerrarse, pero el DWG ya habia quedado guardado con la contingencia.\n'
    });
  }

  sendGenerationEvent({
    type: 'status',
    message: 'Contingencia de accessnet sin direccion aplicada correctamente.'
  });

  return result;
});

ipcMain.handle('dwg:get-oap-coordinate', async (_event, payload) => {
  if (activeRun) {
    throw new Error('Ya hay una operacion en curso.');
  }

  validateProjectAndMdbInput(payload);
  const workingMdbPath = await resolveProjectWorkingMdbPath(payload.projectFolderPath);

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `MDB de trabajo detectado: ${workingMdbPath}\n`
  });

  sendGenerationEvent({
    type: 'status',
    message: 'Buscando el rectangulo OAP en la layer Opmerking...'
  });

  const { extractOapCoordinate } = getDwgToolsModule();
  const oapCoordinate = await extractOapCoordinate(payload.projectFolderPath);
  const updateResult = await runMdbToolsJson([
    '-Mode',
    'SetOapCoordinate',
    '-MdbPath',
    workingMdbPath,
    '-X',
    String(oapCoordinate.x),
    '-Y',
    String(oapCoordinate.y)
  ]);

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `OAP localizado en (${oapCoordinate.x}, ${oapCoordinate.y}). POP actualizados: ${updateResult.updatedPop}, Vergunning actualizados: ${updateResult.updatedVergunning}\n`
  });

  sendGenerationEvent({
    type: 'status',
    message: 'Coordenada OAP aplicada en POP y Vergunning.'
  });

  return {
    mdbPath: workingMdbPath,
    dwgPath: oapCoordinate.dwgPath,
    x: oapCoordinate.x,
    y: oapCoordinate.y,
    candidateCount: oapCoordinate.candidateCount,
    updatedPop: updateResult.updatedPop,
    updatedVergunning: updateResult.updatedVergunning
  };
});

ipcMain.handle('dwg:pick-riser-et-coordinate', async (_event, payload) => {
  if (activeRun) {
    throw new Error('Ya hay una operacion en curso.');
  }

  validateProjectAndMdbInput(payload);

  const { pickPointFromOpenDocument } = getDwgToolsModule();
  return pickPointFromOpenDocument(payload.projectFolderPath, {
    prompt: payload?.prompt
  });
});

ipcMain.handle('crosscheck:generate', async (_event, payload) => {
  if (activeRun) {
    throw new Error('Ya hay una operacion en curso.');
  }

  validateCrossCheckInput(payload);

  sendGenerationEvent({
    type: 'status',
    message: 'Generando Address cross check Cocon delivery 4.0...'
  });

  const result = await exportCrossCheckWorkbook(payload);

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `MDB de trabajo detectado: ${result.mdbPath}\n`
  });

  sendGenerationEvent({
    type: 'log',
    level: 'info',
    message: `Address cross check generado: ${result.outputPath}\n`
  });

  sendGenerationEvent({
    type: 'status',
    message: 'Address cross check generado correctamente.'
  });

  return result;
});

ipcMain.handle('generation:cancel', async () => {
  if (!activeRun?.child) {
    return false;
  }

  activeRun.cancelRequested = true;
  activeRun.child.kill();

  setTimeout(() => {
    if (activeRun?.child?.exitCode === null) {
      spawn('taskkill', ['/pid', String(activeRun.child.pid), '/t', '/f'], {
        windowsHide: true
      });
    }
  }, 1500);

  return true;
});

ipcMain.handle('generation:run', async (_event, payload) => {
  if (activeRun) {
    throw new Error('Ya hay una generacion en curso.');
  }

  validateGenerationInput(payload);

  sendGenerationEvent({
    type: 'status',
    message: 'Analizando DWG, vergunningen y estructura del proyecto...'
  });

  const { extractProjectMetadata } = getProjectMetadataModule();
  const metadata = await extractProjectMetadata(payload.projectFolderPath);

  sendGenerationEvent({
    type: 'summary',
    diagnostics: metadata.diagnostics
  });

  sendGenerationEvent({
    type: 'status',
    message: `Metadata lista: ${metadata.diagnostics.coordinateCount} coordenadas, ${metadata.diagnostics.permitPdfCount} PDF y ${metadata.diagnostics.buildingFolderCount} complejos detectados.`
  });

  for (const warning of metadata.diagnostics.warnings ?? []) {
    sendGenerationEvent({
      type: 'log',
      level: 'warning',
      message: `${warning}\n`
    });
  }

  const tempMetadataPath = path.join(
    os.tmpdir(),
    `fiber-mdb-metadata-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  const metadataPayload = {
    coordinates: metadata.coordinates,
    vergunning: metadata.vergunning,
    internalDpDecisions: {},
    backboneCableNaming: null
  };

  await fsp.writeFile(tempMetadataPath, JSON.stringify(metadataPayload, null, 2), 'utf8');

  try {
    sendGenerationEvent({
      type: 'status',
      message: 'Comprobando si hay DPs ambiguos...'
    });

    const analysis = await analyzeAmbiguousInternalDpsWithPowerShell(payload, tempMetadataPath);
    const internalDpDecisions = await resolveAmbiguousInternalDps(analysis);

    if (Object.keys(internalDpDecisions).length > 0) {
      metadataPayload.internalDpDecisions = internalDpDecisions;
      await fsp.writeFile(tempMetadataPath, JSON.stringify(metadataPayload, null, 2), 'utf8');
    }

    sendGenerationEvent({
      type: 'status',
      message: 'Confirmando numeracion de bloqueos 96V...'
    });

    metadataPayload.backboneCableNaming = await resolveBackboneCableNamingChoice(payload.projectFolderPath);
    await fsp.writeFile(tempMetadataPath, JSON.stringify(metadataPayload, null, 2), 'utf8');

    sendGenerationEvent({
      type: 'status',
      message: 'Ejecutando generate_mdb.ps1...'
    });

    await runGeneratorWithPowerShell(payload, tempMetadataPath);

    sendGenerationEvent({
      type: 'status',
      message: 'MDB generado correctamente.'
    });

    return {
      outputPath: payload.outputPath,
      metadataSummary: {
        coordinateCount: metadata.diagnostics.coordinateCount,
        permitPdfCount: metadata.diagnostics.permitPdfCount,
        buildingFolderCount: metadata.diagnostics.buildingFolderCount,
        warnings: metadata.diagnostics.warnings
      }
    };
  }
  finally {
    await fsp.rm(tempMetadataPath, { force: true }).catch(() => {});
  }
});

app.whenReady().then(() => {
  appendRuntimeLog('app.whenReady');
  createSplashWindow();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
