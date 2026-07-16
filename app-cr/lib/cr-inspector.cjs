const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  }
  catch {
    return false;
  }
}

function detectArchiveType(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.zip' || extension === '.rar') {
    return extension.slice(1);
  }

  return null;
}

function normalizeSlashes(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).filter(Boolean))];
}

function isOfficeTempFile(fileName) {
  return /^~\$/i.test(fileName);
}

function isIgnoredFileName(fileName) {
  const normalized = String(fileName ?? '').toLowerCase();
  return (
    isOfficeTempFile(normalized) ||
    normalized.endsWith('.bak') ||
    normalized.endsWith('.tmp') ||
    normalized.endsWith('.downloaden') ||
    normalized === 'thumbs.db' ||
    normalized === '.ds_store'
  );
}

function safeProjectCode(value) {
  return String(value ?? '')
    .trim()
    .replace(/\.[^.]+$/, '')
    .replace(/\s+/g, ' ')
    .replace(/[<>:"/\\|?*]+/g, '-')
    .trim();
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      cwd: options.cwd
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
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(stderr.trim() || `El comando ha fallado con codigo ${code}.`));
    });
  });
}

async function listImmediateEntries(folderPath) {
  const entries = await fsp.readdir(folderPath, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    fullPath: path.join(folderPath, entry.name),
    isDirectory: entry.isDirectory(),
    isFile: entry.isFile()
  }));
}

async function listArchiveEntries(archivePath) {
  const rawOutput = await runCommand('tar.exe', ['-tf', archivePath]);
  return rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function extractArchiveTextFile(archivePath, archiveEntries, targetBasename) {
  const match = archiveEntries.find((entry) => path.basename(entry).toLowerCase() === targetBasename.toLowerCase());
  if (!match) {
    return null;
  }

  try {
    const rawText = await runCommand('tar.exe', ['-xOf', archivePath, match]);
    return rawText.replace(/^\uFEFF/, '').trim() || null;
  }
  catch {
    return null;
  }
}

async function ensureArchiveExtracted(archivePath, cache) {
  const existing = cache.get(archivePath);
  if (existing) {
    return existing;
  }

  const stagingRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'cr-vn-staging-'));
  await runCommand('tar.exe', ['-xf', archivePath, '-C', stagingRoot]);
  cache.set(archivePath, stagingRoot);
  return stagingRoot;
}

async function collectFilesRecursive(folderPath, options = {}) {
  const results = [];
  const queue = [folderPath];

  while (queue.length > 0) {
    const currentPath = queue.shift();
    const entries = await fsp.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!options.includeIgnored && isIgnoredFileName(entry.name)) {
        continue;
      }

      results.push(fullPath);
    }
  }

  return results;
}

function takeFirstLines(value, maxLines = 8) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines);
}

function summarizeRoutes(routesText) {
  if (!routesText) {
    return null;
  }

  const lines = routesText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const trajectoryCount = lines.filter((line) => line.startsWith('T@')).length;
  const cableCount = lines.filter((line) => line.startsWith('K@')).length;

  return {
    trajectoryCount,
    cableCount,
    preview: lines.slice(0, 5)
  };
}

function summarizeChecks(checksText) {
  if (!checksText) {
    return null;
  }

  const titleMatch = checksText.match(/<TITLE>([^<]+)<\/TITLE>/i);
  const title = titleMatch ? titleMatch[1].trim() : null;

  return {
    title,
    hasCtthReference: /CTTH/i.test(checksText),
    preview: takeFirstLines(checksText.replace(/<[^>]+>/g, ' '), 5)
  };
}

function summarizeEmail(emailText) {
  if (!emailText) {
    return null;
  }

  const emails = [...new Set((emailText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map((value) => value.toLowerCase()))];

  return {
    emails,
    preview: takeFirstLines(emailText, 3)
  };
}

function scoreDwgCandidate(filePath) {
  const normalized = normalizeSlashes(filePath).toLowerCase();
  let score = 0;

  if (normalized.endsWith('.dwg')) {
    score += 10;
  }
  if (/eindrevisie|einderevisie|revise|revisie/.test(normalized)) {
    score += 40;
  }
  if (/te verwerken revisie/.test(normalized)) {
    score += 12;
  }
  if (/topo/.test(normalized)) {
    score -= 25;
  }
  if (/boring|boorprofiel|boorprofielen/.test(normalized)) {
    score -= 30;
  }
  if (/reactie/.test(normalized)) {
    score -= 20;
  }

  return score;
}

function getRelativeFromMeetgegevens(filePath) {
  const normalized = normalizeSlashes(filePath);
  const marker = '/Meetgegevens/';
  const index = normalized.toLowerCase().indexOf(marker.toLowerCase());
  if (index < 0) {
    return null;
  }

  return normalized.slice(index + marker.length);
}

function getRelativeFromToken(filePath, token) {
  const normalized = normalizeSlashes(filePath);
  const marker = `/${token}/`;
  const index = normalized.toLowerCase().indexOf(marker.toLowerCase());
  if (index < 0) {
    return null;
  }

  return normalized.slice(index + marker.length);
}

function getFirstPathSegment(relativePath) {
  const normalized = normalizeSlashes(relativePath);
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? parts[0] : null;
}

async function collectRdDocuments(reactieFolderPath) {
  if (!(await pathExists(reactieFolderPath))) {
    return [];
  }

  const results = [];
  const queue = [reactieFolderPath];

  while (queue.length > 0) {
    const currentPath = queue.shift();
    const entries = await fsp.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (!entry.isFile() || isIgnoredFileName(entry.name)) {
        continue;
      }

      if (/\bRD\d+\b/i.test(entry.name) || /\bAD\d+\b/i.test(entry.name) || /reactie/i.test(entry.name)) {
        results.push({
          name: entry.name,
          fullPath,
          relativePath: path.relative(reactieFolderPath, fullPath)
        });
      }
    }
  }

  return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'es'));
}

async function inspectAcceptedPackage(caseFolderPath, archives) {
  if (archives.length === 0) {
    return {
      archivePath: null,
      archiveType: null,
      topLevelFolder: null,
      rootFiles: [],
      routes: null,
      checks: null,
      email: null,
      hints: [],
      warnings: ['No se ha encontrado ningun paquete .zip o .rar en la carpeta del caso.']
    };
  }

  const primaryArchive = archives[0];
  const archiveEntries = await listArchiveEntries(primaryArchive.fullPath);
  const topLevelFolder = archiveEntries.length > 0 ? archiveEntries[0].split(/[\\/]/)[0] : null;

  const rootFiles = archiveEntries
    .filter((entry) => {
      const normalized = entry.replace(/\\/g, '/');
      return normalized.split('/').filter(Boolean).length <= 2;
    })
    .slice(0, 80);

  const routesText = await extractArchiveTextFile(primaryArchive.fullPath, archiveEntries, 'Routes.txt');
  const checksText = await extractArchiveTextFile(primaryArchive.fullPath, archiveEntries, 'Checks.htm');
  const emailText = await extractArchiveTextFile(primaryArchive.fullPath, archiveEntries, 'Email.txt');

  const hints = [];
  if (archiveEntries.some((entry) => /\/[^/]+\.mdb$/i.test(entry.replace(/\\/g, '/')))) {
    hints.push('El paquete aceptado incluye una MDB lista para entrega.');
  }
  if (archiveEntries.some((entry) => /\/[^/]+\.dwg$/i.test(entry.replace(/\\/g, '/')))) {
    hints.push('El paquete aceptado incluye un DWG principal.');
  }
  if (archiveEntries.some((entry) => /Checks\.htm$/i.test(entry))) {
    hints.push('Checks.htm parece venir como salida externa de validacion, no como documento manual.');
  }
  if (archiveEntries.some((entry) => /Routes\.txt$/i.test(entry))) {
    hints.push('Routes.txt parece describir trayectos y bloqueos a nivel estructural.');
  }

  return {
    archivePath: primaryArchive.fullPath,
    archiveType: primaryArchive.archiveType,
    topLevelFolder,
    rootFiles,
    routes: summarizeRoutes(routesText),
    checks: summarizeChecks(checksText),
    email: summarizeEmail(emailText),
    hints,
    warnings: []
  };
}

function buildOpenQuestions(report) {
  const questions = [];

  if (report.acceptedPackage.routes) {
    questions.push('Confirmar el origen real de Routes.txt: exportacion externa, DWG o sistema intermedio.');
  }

  if (report.acceptedPackage.checks) {
    questions.push('Confirmar si Checks.htm se genera fuera de la app y solo hay que leerlo, o si debe generarse.');
  }

  if (report.additionalInfo.archives.length > 0) {
    questions.push('Definir si los paquetes de Aanvullende informatie son fuente de verdad o solo soporte para correcciones.');
  }

  if (report.reactiedocumenten.documents.length > 0) {
    questions.push('Definir que tipos de cambios de RD deben automatizarse frente a los que se quedaran como revision manual.');
  }

  return questions;
}

function buildSourceSummary(report) {
  const sources = [];

  if (report.acceptedPackage.archivePath) {
    sources.push('Paquete aceptado');
  }
  if (report.additionalInfo.exists) {
    sources.push('Aanvullende informatie');
  }
  if (report.reactiedocumenten.exists) {
    sources.push('Reactiedocumenten');
  }

  return {
    sourceCount: sources.length,
    labels: sources
  };
}

async function inspectCaseFolder(caseFolderPath) {
  const resolvedCasePath = path.resolve(caseFolderPath);
  const exists = await pathExists(resolvedCasePath);

  if (!exists) {
    throw new Error('La carpeta del caso no existe.');
  }

  const entries = await listImmediateEntries(resolvedCasePath);
  const archives = entries
    .filter((entry) => entry.isFile)
    .map((entry) => ({
      ...entry,
      archiveType: detectArchiveType(entry.name)
    }))
    .filter((entry) => Boolean(entry.archiveType))
    .sort((left, right) => left.name.localeCompare(right.name, 'es'));

  const acceptedPackage = await inspectAcceptedPackage(resolvedCasePath, archives);

  const additionalInfoPath = path.join(resolvedCasePath, 'Aanvullende informatie');
  const reactiedocumentenPath = path.join(resolvedCasePath, 'Reactiedocumenten');
  const reactieDocumentPath = path.join(resolvedCasePath, 'Reactie Document');
  const effectiveReactionPath = (await pathExists(reactiedocumentenPath)) ? reactiedocumentenPath : reactieDocumentPath;

  const additionalInfoEntries = (await pathExists(additionalInfoPath))
    ? await listImmediateEntries(additionalInfoPath)
    : [];
  const rdDocuments = await collectRdDocuments(effectiveReactionPath);

  const report = {
    caseFolderPath: resolvedCasePath,
    caseName: path.basename(resolvedCasePath),
    acceptedPackage,
    additionalInfo: {
      exists: await pathExists(additionalInfoPath),
      folders: additionalInfoEntries.filter((entry) => entry.isDirectory).map((entry) => entry.name),
      archives: additionalInfoEntries.filter((entry) => entry.isFile && detectArchiveType(entry.name)).map((entry) => entry.name),
      files: additionalInfoEntries.filter((entry) => entry.isFile).map((entry) => entry.name).slice(0, 40)
    },
    reactiedocumenten: {
      exists: await pathExists(effectiveReactionPath),
      folderPath: (await pathExists(effectiveReactionPath)) ? effectiveReactionPath : null,
      documents: rdDocuments
    }
  };

  report.sourceSummary = buildSourceSummary(report);
  report.openQuestions = buildOpenQuestions(report);

  return report;
}

function classifyArchiveRole(caseName, archiveName, acceptedArchivePath) {
  const normalizedArchiveName = String(archiveName ?? '').toLowerCase();
  if (acceptedArchivePath && path.basename(acceptedArchivePath).toLowerCase() === normalizedArchiveName) {
    return 'accepted-package';
  }

  if (/onedrive/.test(normalizedArchiveName)) {
    return 'provided-master';
  }
  if (/meetfiles/.test(normalizedArchiveName)) {
    return 'measurements';
  }
  if (/backup|archief|archive/.test(normalizedArchiveName)) {
    return 'archive-backup';
  }
  if (caseName && normalizedArchiveName.includes(String(caseName).toLowerCase())) {
    return 'case-related';
  }

  return 'support';
}

function classifyFolderRole(folderName, projectCode) {
  const normalizedName = String(folderName ?? '').toLowerCase();
  const normalizedProjectCode = String(projectCode ?? '').toLowerCase();

  if (normalizedProjectCode && normalizedName === normalizedProjectCode) {
    return 'accepted-folder';
  }

  return 'support-folder';
}

function sortPreferred(first, second) {
  if (first.score !== second.score) {
    return second.score - first.score;
  }

  return first.relativePath.localeCompare(second.relativePath, 'es');
}

function stripRuntimeFieldsFromManifest(manifest) {
  if (!manifest || !manifest.artifacts) {
    return manifest;
  }

  const cloneArtifact = (artifact) => {
    if (!artifact) {
      return artifact;
    }

    const { sourceRootPath, ...rest } = artifact;
    return rest;
  };

  const cloneArtifactList = (artifacts) => (artifacts ?? []).map(cloneArtifact);

    return {
    ...manifest,
    artifacts: {
      mainDwg: cloneArtifact(manifest.artifacts.mainDwg),
      referenceMdb: cloneArtifact(manifest.artifacts.referenceMdb),
      mainMdb: cloneArtifact(manifest.artifacts.mainMdb),
      boringen: cloneArtifactList(manifest.artifacts.boringen),
      vergunningen: cloneArtifactList(manifest.artifacts.vergunningen),
      kastoverzicht: cloneArtifactList(manifest.artifacts.kastoverzicht),
      meetgegevens: cloneArtifactList(manifest.artifacts.meetgegevens)
    }
  };
}

function scorePreferredSource(file) {
  const sourcePriority = new Map([
    ['additional-info', 0],
    ['accepted-folder', 1],
    ['provided-master', 2],
    ['accepted-package', 3],
    ['measurements', 4],
    ['case-related', 5],
    ['support', 6],
    ['support-folder', 7],
    ['archive-backup', 8]
  ]);

  return sourcePriority.get(file.sourceRole) ?? 99;
}

function sortByPreferredSource(left, right) {
  const leftOrder = scorePreferredSource(left);
  const rightOrder = scorePreferredSource(right);

  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  return left.relativePath.localeCompare(right.relativePath, 'es');
}

function pickSingleArtifact(files, targetPath) {
  if (!files || files.length === 0) {
    return null;
  }

  const preferred = [...files].sort(sortByPreferredSource)[0];
  return {
    sourcePath: preferred.sourcePath,
    sourceRootPath: preferred.rootPath,
    sourceRole: preferred.sourceRole,
    relativePath: preferred.relativePath,
    targetPath
  };
}

async function discoverVnSourcesInternal(caseFolderPath, options = {}) {
  const cleanup = options.cleanup !== false;
  const inspection = await inspectCaseFolder(caseFolderPath);
  const resolvedCasePath = inspection.caseFolderPath;
  const entries = await listImmediateEntries(resolvedCasePath);
  const archives = entries
    .filter((entry) => entry.isFile && detectArchiveType(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, 'es'));

  const additionalInfoPath = path.join(resolvedCasePath, 'Aanvullende informatie');
  const reactionFolderPath = inspection.reactiedocumenten.folderPath;
  const extractionCache = new Map();
  const sourceLocations = [];

  try {
    if (await pathExists(additionalInfoPath)) {
      sourceLocations.push({
        type: 'folder',
        role: 'additional-info',
        label: 'Aanvullende informatie',
        path: additionalInfoPath,
        rootPath: additionalInfoPath
      });
    }

    for (const archive of archives) {
      const role = classifyArchiveRole(inspection.caseName, archive.name, inspection.acceptedPackage.archivePath);
      const extractedPath = await ensureArchiveExtracted(archive.fullPath, extractionCache);
      sourceLocations.push({
        type: 'archive',
        role,
        label: archive.name,
        path: archive.fullPath,
        rootPath: extractedPath
      });
    }

    const acceptedTopLevelHint = inspection.acceptedPackage.topLevelFolder;
    const acceptedFolderHint = safeProjectCode(acceptedTopLevelHint || path.basename(inspection.acceptedPackage.archivePath || '') || inspection.caseName);
    const acceptedFolderPath = path.join(resolvedCasePath, acceptedFolderHint);
    if (acceptedFolderHint && await pathExists(acceptedFolderPath)) {
      sourceLocations.push({
        type: 'folder',
        role: classifyFolderRole(path.basename(acceptedFolderPath), acceptedFolderHint),
        label: path.basename(acceptedFolderPath),
        path: acceptedFolderPath,
        rootPath: acceptedFolderPath
      });
    }

    const allFiles = [];
    for (const source of sourceLocations) {
      const files = await collectFilesRecursive(source.rootPath);
      for (const filePath of files) {
        allFiles.push({
          sourceType: source.type,
          sourceRole: source.role,
          sourceLabel: source.label,
          sourcePath: source.path,
          rootPath: source.rootPath,
          fullPath: filePath,
          relativePath: normalizeSlashes(path.relative(source.rootPath, filePath)),
          baseName: path.basename(filePath),
          extension: path.extname(filePath).toLowerCase()
        });
      }
    }

    const acceptedTopLevel = inspection.acceptedPackage.topLevelFolder;
    let projectCode = safeProjectCode(acceptedTopLevel || path.basename(inspection.acceptedPackage.archivePath || '') || inspection.caseName);
    if (!projectCode) {
      projectCode = safeProjectCode(inspection.caseName);
    }

    const buildingCandidates = uniqueStrings([
      ...allFiles.map((file) => {
        const relativeFromGebouwen = getRelativeFromToken(file.relativePath, 'Gebouwen');
        if (!relativeFromGebouwen) {
          return null;
        }
        return getFirstPathSegment(relativeFromGebouwen);
      }).filter(Boolean),
      acceptedTopLevel ? null : null
    ]);

    const packageBuilding = inspection.acceptedPackage.rootFiles
      .map((entry) => normalizeSlashes(entry))
      .map((entry) => {
        const relativeFromGebouwen = getRelativeFromToken(entry, 'Gebouwen');
        if (!relativeFromGebouwen) {
          return null;
        }
        return getFirstPathSegment(relativeFromGebouwen);
      })
      .find(Boolean);

    const mainBuildingName = packageBuilding || buildingCandidates[0] || projectCode.replace(/-VN-B\d+$/i, '');

    const dwgCandidates = allFiles
      .filter((file) => file.extension === '.dwg')
      .map((file) => ({
        ...file,
        score: scoreDwgCandidate(file.relativePath)
      }))
      .filter((file) => file.score > 0)
      .sort(sortPreferred);

    const mainDwg = dwgCandidates[0] ?? null;

    const boringenFiles = allFiles
      .filter((file) => ['.dwg', '.pdf'].includes(file.extension))
      .filter((file) => /boring|boorprofiel|boorprofielen/i.test(normalizeSlashes(file.relativePath)))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'es'));

    const vergunningFiles = allFiles
      .filter((file) => ['.pdf', '.dwg', '.doc', '.docx'].includes(file.extension))
      .filter((file) => /vergunning|instemming/i.test(normalizeSlashes(file.relativePath)))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'es'));

    const kastoverzichtFiles = allFiles
      .filter((file) => ['.pdf', '.xlsx', '.xls'].includes(file.extension))
      .filter((file) => /kastoverzicht|pon kastoverzicht/i.test(file.baseName))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'es'));

    const measurementFiles = allFiles
      .filter((file) => ['.sor', '.pdf', '.xlsx', '.xls'].includes(file.extension))
      .filter((file) => {
        const normalized = normalizeSlashes(file.relativePath);
        return normalized.includes('/Meetgegevens/') || /\.sor$/i.test(file.baseName) || /meetrapport/i.test(file.baseName);
      })
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'es'));

    const measurementNodes = uniqueStrings(measurementFiles.map((file) => {
      const relative = getRelativeFromMeetgegevens(file.relativePath);
      return relative ? getFirstPathSegment(relative) : null;
    }).filter(Boolean));

    const mainMdb = pickSingleArtifact(
      allFiles.filter((file) => file.extension === '.mdb' && safeProjectCode(path.basename(file.fullPath, file.extension)) === projectCode),
      `${projectCode}/${projectCode}.mdb`
    ) ?? pickSingleArtifact(
      allFiles.filter((file) => file.extension === '.mdb'),
      `${projectCode}/${projectCode}.mdb`
    );

    const referenceMdb = pickSingleArtifact(
      allFiles.filter((file) => file.extension === '.mdb' && file.sourceRole === 'accepted-folder' && safeProjectCode(path.basename(file.fullPath, file.extension)) === projectCode),
      `${projectCode}/${projectCode}.mdb`
    );

    const sourceManifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      caseFolderPath: resolvedCasePath,
      caseName: inspection.caseName,
      projectCode,
      mainBuildingName,
      acceptedPackage: inspection.acceptedPackage,
      reactionFolderPath,
      sourceLocations: sourceLocations.map((source) => ({
        type: source.type,
        role: source.role,
        label: source.label,
        path: source.path
      })),
      artifacts: {
        mainDwg: mainDwg ? {
          sourcePath: mainDwg.sourcePath,
          sourceRootPath: mainDwg.rootPath,
          sourceRole: mainDwg.sourceRole,
          relativePath: mainDwg.relativePath,
          targetPath: `${projectCode}/${projectCode}.dwg`
        } : null,
        referenceMdb,
        mainMdb,
        boringen: boringenFiles.map((file) => ({
          sourcePath: file.sourcePath,
          sourceRootPath: file.rootPath,
          sourceRole: file.sourceRole,
          relativePath: file.relativePath,
          targetPath: `${projectCode}/Boringen/${path.basename(file.fullPath)}`
        })),
        vergunningen: vergunningFiles.map((file) => {
          const relative = getRelativeFromToken(file.relativePath, 'Vergunning') || getRelativeFromToken(file.relativePath, 'Vergunningen') || path.basename(file.fullPath);
          return {
            sourcePath: file.sourcePath,
            sourceRootPath: file.rootPath,
            sourceRole: file.sourceRole,
            relativePath: file.relativePath,
            targetPath: `${projectCode}/Vergunningen/${relative}`
          };
        }),
        kastoverzicht: kastoverzichtFiles.map((file) => ({
          sourcePath: file.sourcePath,
          sourceRootPath: file.rootPath,
          sourceRole: file.sourceRole,
          relativePath: file.relativePath,
          targetPath: `${projectCode}/Gebouwen/${mainBuildingName}/${path.basename(file.fullPath)}`
        })),
        meetgegevens: measurementFiles.map((file) => {
          const relative = getRelativeFromMeetgegevens(file.relativePath) || path.basename(file.fullPath);
          return {
            sourcePath: file.sourcePath,
            sourceRootPath: file.rootPath,
            sourceRole: file.sourceRole,
            relativePath: file.relativePath,
            targetPath: `${projectCode}/Gebouwen/${mainBuildingName}/Meetgegevens/${relative}`
          };
        })
      },
      support: {
        reactiedocumenten: inspection.reactiedocumenten.documents,
        measurementNodes,
        buildingCandidates
      },
      warnings: [
        mainDwg ? null : 'No se ha resuelto un DWG principal.',
        referenceMdb ? null : 'No se ha resuelto una MDB de referencia descomprimida; la app tendra que generar la base desde los datos del caso.',
        measurementFiles.length === 0 ? 'No se han localizado mediciones para Meetgegevens.' : null
      ].filter(Boolean)
    };

    return {
      manifest: sourceManifest,
      cleanup: async () => {
        for (const extractedPath of extractionCache.values()) {
          await fsp.rm(extractedPath, { recursive: true, force: true }).catch(() => {});
        }
      }
    };
  }
  finally {
    if (cleanup) {
      for (const extractedPath of extractionCache.values()) {
        await fsp.rm(extractedPath, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

async function discoverVnSources(caseFolderPath) {
  const discovery = await discoverVnSourcesInternal(caseFolderPath);
  return stripRuntimeFieldsFromManifest(discovery.manifest);
}

async function writeJsonFile(outputPath, payload) {
  const resolvedOutputPath = path.resolve(outputPath);
  await fsp.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await fsp.writeFile(resolvedOutputPath, JSON.stringify(payload, null, 2), 'utf8');
  return resolvedOutputPath;
}

async function exportCaseReport(caseFolderPath, outputPath) {
  const report = await inspectCaseFolder(caseFolderPath);
  const resolvedOutputPath = await writeJsonFile(outputPath, report);

  return {
    outputPath: resolvedOutputPath,
    caseName: report.caseName
  };
}

async function exportSourceManifest(caseFolderPath, outputPath) {
  const manifest = await discoverVnSources(caseFolderPath);
  const resolvedOutputPath = await writeJsonFile(outputPath, manifest);

  return {
    outputPath: resolvedOutputPath,
    caseName: manifest.caseName,
    projectCode: manifest.projectCode
  };
}

async function copyFileWithTrace(sourcePath, targetPath, traces, tracePayload) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.copyFile(sourcePath, targetPath);
  traces.push({
    ...tracePayload,
    copied: true
  });
}

function pickPreferredArtifacts(artifacts) {
  const grouped = new Map();

  for (const artifact of artifacts) {
    if (!grouped.has(artifact.targetPath)) {
      grouped.set(artifact.targetPath, []);
    }
    grouped.get(artifact.targetPath).push(artifact);
  }

  const preferredOrder = new Map([
    ['additional-info', 0],
    ['accepted-folder', 1],
    ['provided-master', 2],
    ['measurements', 3],
    ['case-related', 4],
    ['support', 5],
    ['accepted-package', 6],
    ['support-folder', 7],
    ['archive-backup', 8]
  ]);

  const resolved = [];
  for (const variants of grouped.values()) {
    variants.sort((left, right) => {
      const leftOrder = preferredOrder.get(left.sourceRole) ?? 99;
      const rightOrder = preferredOrder.get(right.sourceRole) ?? 99;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return left.relativePath.localeCompare(right.relativePath, 'es');
    });
    resolved.push(variants[0]);
  }

  return resolved;
}

async function buildVnTree(caseFolderPath, outputRootPath) {
  const discovery = await discoverVnSourcesInternal(caseFolderPath, { cleanup: false });
  const manifest = discovery.manifest;

  try {
    const resolvedOutputRoot = path.resolve(outputRootPath);
    const vnRoot = path.join(resolvedOutputRoot, manifest.projectCode);

    await fsp.rm(vnRoot, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(path.join(vnRoot, 'Boringen'), { recursive: true });
    await fsp.mkdir(path.join(vnRoot, 'Gebouwen', manifest.mainBuildingName, 'Afwijkingsformulieren'), { recursive: true });
    await fsp.mkdir(path.join(vnRoot, 'Gebouwen', manifest.mainBuildingName, 'Meetgegevens'), { recursive: true });
    await fsp.mkdir(path.join(vnRoot, 'Gebouwen', manifest.mainBuildingName, 'V&G plannen'), { recursive: true });
    await fsp.mkdir(path.join(vnRoot, 'Klanten'), { recursive: true });
    await fsp.mkdir(path.join(vnRoot, 'Vergunningen'), { recursive: true });

    const traceEntries = [];
    const copiedTargets = [];

    const copySingleArtifact = async (artifact, resolutionRule) => {
      if (!artifact) {
        return false;
      }

      const targetPath = path.join(resolvedOutputRoot, artifact.targetPath);
      await copyFileWithTrace(
        path.join(artifact.sourceRootPath, artifact.relativePath),
        targetPath,
        traceEntries,
        {
          target: artifact.targetPath,
          source: `${artifact.sourcePath}::${artifact.relativePath}`,
          sourceKind: 'archive-or-folder',
          resolutionRule
        }
      );
      copiedTargets.push(artifact.targetPath);
      return true;
    };

    await copySingleArtifact(manifest.artifacts.mainDwg, 'preferred-main-dwg');

    for (const groupName of ['boringen', 'vergunningen', 'kastoverzicht', 'meetgegevens']) {
      const preferredArtifacts = pickPreferredArtifacts(manifest.artifacts[groupName]);
      for (const artifact of preferredArtifacts) {
        const targetPath = path.join(resolvedOutputRoot, artifact.targetPath);
        await copyFileWithTrace(
          path.join(artifact.sourceRootPath, artifact.relativePath),
          targetPath,
          traceEntries,
          {
            target: artifact.targetPath,
            source: `${artifact.sourcePath}::${artifact.relativePath}`,
            sourceKind: 'archive-or-folder',
            resolutionRule: `preferred-${groupName}`
          }
        );
        copiedTargets.push(artifact.targetPath);
      }
    }

    const placeholders = [
      `${manifest.projectCode}.mdb`
    ];

    for (const fileName of placeholders.filter(Boolean)) {
      const placeholderPath = path.join(vnRoot, fileName);
      if (!(await pathExists(placeholderPath))) {
        await fsp.writeFile(placeholderPath, '', 'utf8');
      }
    }

    const tracePath = path.join(vnRoot, `${manifest.projectCode}.trace.json`);
    const manifestPath = path.join(vnRoot, `${manifest.projectCode}.sources.json`);

    await writeJsonFile(tracePath, {
      generatedAt: new Date().toISOString(),
      caseName: manifest.caseName,
      projectCode: manifest.projectCode,
      targetRoot: vnRoot,
      copiedCount: copiedTargets.length,
      entries: traceEntries
    });

    await writeJsonFile(manifestPath, stripRuntimeFieldsFromManifest(manifest));

    return {
      caseName: manifest.caseName,
      projectCode: manifest.projectCode,
      outputRootPath: resolvedOutputRoot,
      vnRootPath: vnRoot,
      copiedCount: copiedTargets.length,
      mainBuildingName: manifest.mainBuildingName,
      referenceMdbPath: manifest.artifacts.referenceMdb
        ? path.join(manifest.artifacts.referenceMdb.sourceRootPath, manifest.artifacts.referenceMdb.relativePath)
        : null,
      outputMdbPath: path.join(vnRoot, `${manifest.projectCode}.mdb`),
      measurementCount: pickPreferredArtifacts(manifest.artifacts.meetgegevens).length,
      boringenCount: pickPreferredArtifacts(manifest.artifacts.boringen).length,
      vergunningenCount: pickPreferredArtifacts(manifest.artifacts.vergunningen).length,
      kastoverzichtCount: pickPreferredArtifacts(manifest.artifacts.kastoverzicht).length,
      tracePath,
      manifestPath,
      warnings: manifest.warnings
    };
  }
  finally {
    await discovery.cleanup();
  }
}

module.exports = {
  inspectCaseFolder,
  exportCaseReport,
  discoverVnSources,
  exportSourceManifest,
  buildVnTree
};
