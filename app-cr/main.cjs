const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron/main');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { inspectCaseFolder, exportCaseReport, exportSourceManifest, buildVnTree } = require('./lib/cr-inspector.cjs');
const { extractProjectMetadata } = require('./lib/project-metadata.cjs');

const appRoot = path.resolve(__dirname, '..');
const windowIconPath = path.join(appRoot, 'app', 'assets', 'icon.png');
const vnMdbGeneratorScriptPath = path.join(__dirname, 'generate_vn_mdb.ps1');
const bundledTemplatePath = fs.existsSync(path.join(appRoot, 'template.mdb'))
  ? path.join(appRoot, 'template.mdb')
  : path.join(process.resourcesPath, 'template.mdb');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1100,
    minHeight: 760,
    backgroundColor: '#f4efe6',
    autoHideMenuBar: true,
    icon: fs.existsSync(windowIconPath) ? windowIconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  void mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function normalizeFolderPath(targetPath) {
  const value = String(targetPath ?? '').trim();
  if (!value) {
    throw new Error('Selecciona una carpeta de caso.');
  }

  return path.resolve(value);
}

function runPowerShellJson(scriptPath, scriptArgs) {
  return new Promise((resolve, reject) => {
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

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || 'La ejecucion de PowerShell ha fallado.'));
        return;
      }

      try {
        resolve(JSON.parse(String(stdout ?? '').replace(/^\uFEFF/, '').trim()));
      }
      catch (error) {
        reject(new Error(`No se pudo leer la salida JSON del generador MDB: ${error.message}`));
      }
    });
  });
}

ipcMain.handle('app:ping', () => ({
  ok: true,
  timestamp: new Date().toISOString()
}));

ipcMain.handle('app:get-defaults', () => ({
  appVersion: app.getVersion(),
  defaultCaseRoot: path.join(appRoot, 'CR')
}));

ipcMain.handle('dialog:open-folder', async (_event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title ?? 'Selecciona una carpeta',
    defaultPath: options.defaultPath,
    properties: ['openDirectory']
  });

  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.handle('dialog:save-file', async (_event, options = {}) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options.title ?? 'Guardar fichero',
    defaultPath: options.defaultPath,
    filters: options.filters
  });

  return result.canceled ? null : result.filePath;
});

ipcMain.handle('shell:show-item', async (_event, targetPath) => {
  if (!targetPath) {
    return false;
  }

  shell.showItemInFolder(targetPath);
  return true;
});

ipcMain.handle('case:inspect', async (_event, payload) => {
  const caseFolderPath = normalizeFolderPath(payload?.caseFolderPath);
  return inspectCaseFolder(caseFolderPath);
});

ipcMain.handle('case:export-report', async (_event, payload) => {
  const caseFolderPath = normalizeFolderPath(payload?.caseFolderPath);
  const outputPath = String(payload?.outputPath ?? '').trim();

  if (!outputPath) {
    throw new Error('Indica una ruta de salida para el informe JSON.');
  }

  return exportCaseReport(caseFolderPath, path.resolve(outputPath));
});

ipcMain.handle('case:discover-sources', async (_event, payload) => {
  const caseFolderPath = normalizeFolderPath(payload?.caseFolderPath);
  const outputPath = String(payload?.outputPath ?? '').trim();

  if (!outputPath) {
    throw new Error('Indica una ruta de salida para el manifest de fuentes.');
  }

  return exportSourceManifest(caseFolderPath, path.resolve(outputPath));
});

ipcMain.handle('case:build-vn-tree', async (_event, payload) => {
  const caseFolderPath = normalizeFolderPath(payload?.caseFolderPath);
  const outputRootPath = String(payload?.outputRootPath ?? '').trim();

  if (!outputRootPath) {
    throw new Error('Indica la carpeta de salida para construir el arbol VN.');
  }

  const buildResult = await buildVnTree(caseFolderPath, path.resolve(outputRootPath));
  const generatorArgs = [
    '-TemplatePath',
    bundledTemplatePath
  ];

  let metadataPath = null;
  if (buildResult.referenceMdbPath) {
    generatorArgs.push(
      '-ReferenceMdbPath',
      buildResult.referenceMdbPath
    );
  }
  else {
    const extractedMetadata = await extractProjectMetadata(buildResult.vnRootPath);
    const metadataPayload = {
      projectCode: buildResult.projectCode,
      projectLabel: buildResult.projectCode.replace(/-VN-B\d+$/i, ''),
      mainBuildingName: buildResult.mainBuildingName,
      coordinates: extractedMetadata.coordinates ?? {},
      vergunning: extractedMetadata.vergunning ?? null,
      diagnostics: extractedMetadata.diagnostics ?? null
    };

    metadataPath = path.join(buildResult.vnRootPath, `${buildResult.projectCode}.metadata.json`);
    fs.writeFileSync(metadataPath, JSON.stringify(metadataPayload, null, 2), 'utf8');

    generatorArgs.push(
      '-MetadataPath',
      metadataPath
    );
  }

  generatorArgs.push(
    '-OutputPath',
    buildResult.outputMdbPath
  );

  const mdbResult = await runPowerShellJson(vnMdbGeneratorScriptPath, generatorArgs);

  return {
    ...buildResult,
    metadataPath,
    mdbGenerated: true,
    mdbResult
  };
});

app.whenReady().then(() => {
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
