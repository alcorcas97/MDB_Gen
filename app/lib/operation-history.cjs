const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const HISTORY_FOLDER_NAME = 'Fiber MDB Generator';
const HISTORY_MANIFEST_NAME = 'history.json';
const RESTORABLE_EXTENSIONS = new Set(['.mdb', '.dwg']);

function sanitizeToken(value, fallback = 'operacion') {
  const token = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return token || fallback;
}

function resolveHistoryBase(projectOrFilePath) {
  const inputPath = String(projectOrFilePath ?? '').trim();
  if (!inputPath) {
    throw new Error('Falta la carpeta del proyecto para gestionar el historial.');
  }
  const resolved = path.resolve(inputPath);
  const extension = path.extname(resolved).toLowerCase();
  let base = extension ? path.dirname(resolved) : resolved;

  if (/-B\d+$/i.test(path.basename(base))) {
    base = path.dirname(base);
  }

  return base;
}

function getHistoryRoot(projectOrFilePath) {
  return path.join(resolveHistoryBase(projectOrFilePath), 'Back', HISTORY_FOLDER_NAME);
}

function getManifestPath(projectOrFilePath) {
  return path.join(getHistoryRoot(projectOrFilePath), HISTORY_MANIFEST_NAME);
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  }
  catch {
    return false;
  }
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function readManifest(projectOrFilePath) {
  const manifestPath = getManifestPath(projectOrFilePath);
  if (!(await pathExists(manifestPath))) {
    return { schemaVersion: 1, entries: [] };
  }

  const parsed = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  return {
    schemaVersion: 1,
    entries: Array.isArray(parsed?.entries) ? parsed.entries : []
  };
}

async function writeManifest(projectOrFilePath, manifest) {
  const historyRoot = getHistoryRoot(projectOrFilePath);
  const manifestPath = path.join(historyRoot, HISTORY_MANIFEST_NAME);
  const temporaryPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.mkdir(historyRoot, { recursive: true });
  await fsp.writeFile(temporaryPath, JSON.stringify(manifest, null, 2), 'utf8');
  await fsp.rename(temporaryPath, manifestPath);
}

async function createOperationBackup({ projectPath, operation, label, filePaths }) {
  const uniquePaths = [...new Set((filePaths ?? [])
    .map((filePath) => String(filePath ?? '').trim())
    .filter(Boolean)
    .map((filePath) => path.resolve(filePath)))];
  const existingFiles = [];

  for (const filePath of uniquePaths) {
    const extension = path.extname(filePath).toLowerCase();
    if (!RESTORABLE_EXTENSIONS.has(extension) || !(await pathExists(filePath))) {
      continue;
    }

    const stats = await fsp.stat(filePath);
    if (stats.isFile()) {
      existingFiles.push({ filePath, stats });
    }
  }

  if (existingFiles.length === 0) {
    return null;
  }

  const historyRoot = getHistoryRoot(projectPath);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const folderName = `${createdAt.replace(/[:.]/g, '-')}_${sanitizeToken(operation)}_${id.slice(0, 8)}`;
  const backupFolder = path.join(historyRoot, folderName);
  await fsp.mkdir(backupFolder, { recursive: true });

  const files = [];
  for (let index = 0; index < existingFiles.length; index += 1) {
    const source = existingFiles[index];
    const backupName = `${String(index + 1).padStart(2, '0')}_${path.basename(source.filePath)}`;
    const backupPath = path.join(backupFolder, backupName);
    await fsp.copyFile(source.filePath, backupPath);
    const [sourceHash, backupHash, backupStats] = await Promise.all([
      hashFile(source.filePath),
      hashFile(backupPath),
      fsp.stat(backupPath)
    ]);

    if (source.stats.size !== backupStats.size || sourceHash !== backupHash) {
      throw new Error(`La copia de seguridad no coincide con el archivo original: ${source.filePath}`);
    }

    files.push({
      sourcePath: source.filePath,
      backupRelativePath: path.relative(historyRoot, backupPath),
      size: backupStats.size,
      sha256: backupHash
    });
  }

  const entry = {
    id,
    createdAt,
    operation: String(operation ?? 'operation'),
    label: String(label ?? operation ?? 'Operación'),
    status: 'ready',
    files
  };
  const manifest = await readManifest(projectPath);
  manifest.entries.unshift(entry);
  await writeManifest(projectPath, manifest);
  return entry;
}

async function listOperationHistory(projectPath) {
  const manifest = await readManifest(projectPath);
  return manifest.entries.map((entry) => ({
    ...entry,
    fileCount: Array.isArray(entry.files) ? entry.files.length : 0
  }));
}

async function updateOperationBackup({ projectPath, entryId, status, summary }) {
  const manifest = await readManifest(projectPath);
  const entry = manifest.entries.find((item) => item.id === entryId);
  if (!entry) {
    return null;
  }

  if (status) {
    entry.status = String(status);
  }
  if (summary && typeof summary === 'object') {
    entry.summary = summary;
  }
  entry.updatedAt = new Date().toISOString();
  await writeManifest(projectPath, manifest);
  return entry;
}

function resolveBackupPath(historyRoot, relativePath) {
  const resolved = path.resolve(historyRoot, String(relativePath ?? ''));
  const rootWithSeparator = `${path.resolve(historyRoot)}${path.sep}`;
  if (resolved !== path.resolve(historyRoot) && !resolved.startsWith(rootWithSeparator)) {
    throw new Error('El historial contiene una ruta de copia no válida.');
  }
  return resolved;
}

async function restoreOperation({ projectPath, entryId }) {
  const manifest = await readManifest(projectPath);
  const entry = manifest.entries.find((item) => item.id === entryId);
  if (!entry || !Array.isArray(entry.files) || entry.files.length === 0) {
    throw new Error('No se ha encontrado la operación seleccionada en el historial.');
  }

  const historyRoot = getHistoryRoot(projectPath);
  const verifiedFiles = [];
  for (const file of entry.files) {
    const targetPath = path.resolve(String(file.sourcePath ?? ''));
    if (!RESTORABLE_EXTENSIONS.has(path.extname(targetPath).toLowerCase())) {
      throw new Error(`El historial contiene un tipo de archivo no restaurable: ${targetPath}`);
    }

    const backupPath = resolveBackupPath(historyRoot, file.backupRelativePath);
    if (!(await pathExists(backupPath)) || await hashFile(backupPath) !== file.sha256) {
      throw new Error(`La copia está ausente o dañada: ${backupPath}`);
    }
    verifiedFiles.push({ targetPath, backupPath, sha256: file.sha256 });
  }

  const safetyBackup = await createOperationBackup({
    projectPath,
    operation: 'before-restore',
    label: `Antes de restaurar: ${entry.label}`,
    filePaths: verifiedFiles.map((file) => file.targetPath)
  });

  for (const file of verifiedFiles) {
    await fsp.mkdir(path.dirname(file.targetPath), { recursive: true });
    const temporaryPath = `${file.targetPath}.fiber-restore-${entry.id.slice(0, 8)}.tmp`;
    await fsp.copyFile(file.backupPath, temporaryPath);
    if (await hashFile(temporaryPath) !== file.sha256) {
      throw new Error(`No se ha podido verificar la restauración de ${file.targetPath}`);
    }
    await fsp.copyFile(temporaryPath, file.targetPath);
    await fsp.rm(temporaryPath, { force: true });
  }

  return {
    restoredEntry: entry,
    safetyBackup,
    restoredFiles: verifiedFiles.map((file) => file.targetPath)
  };
}

module.exports = {
  createOperationBackup,
  getHistoryRoot,
  hashFile,
  listOperationHistory,
  restoreOperation,
  updateOperationBackup
};
