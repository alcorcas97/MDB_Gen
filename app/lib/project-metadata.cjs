const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { Dwg_File_Type, LibreDwg } = require('@mlightcad/libredwg-web');
const { PDFParse } = require('pdf-parse');

const DUTCH_MONTHS = new Map([
  ['januari', 1],
  ['februari', 2],
  ['maart', 3],
  ['april', 4],
  ['mei', 5],
  ['juni', 6],
  ['juli', 7],
  ['augustus', 8],
  ['september', 9],
  ['oktober', 10],
  ['november', 11],
  ['december', 12]
]);

function normalizeText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  return text === '' ? null : text;
}

function formatIsoDate(date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function uniqueSortedDates(candidates) {
  const lookup = new Map();

  for (const candidate of candidates) {
    if (!(candidate instanceof Date) || Number.isNaN(candidate.getTime())) {
      continue;
    }

    lookup.set(formatIsoDate(candidate), candidate);
  }

  return [...lookup.values()].sort((left, right) => left.getTime() - right.getTime());
}

function extractDateCandidates(text) {
  const source = normalizeText(text) ?? '';
  const candidates = [];

  for (const match of source.matchAll(/\b(?<day>\d{1,2})\s+(?<month>januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\s+(?<year>\d{4})\b/gi)) {
    const month = DUTCH_MONTHS.get(match.groups.month.toLowerCase());
    const year = Number.parseInt(match.groups.year, 10);
    const day = Number.parseInt(match.groups.day, 10);

    if (!month) {
      continue;
    }

    candidates.push(new Date(year, month - 1, day));
  }

  for (const match of source.matchAll(/\b(?<day>\d{1,2})[\/.-](?<month>\d{1,2})[\/.-](?<year>\d{2,4})\b/g)) {
    let year = Number.parseInt(match.groups.year, 10);
    const month = Number.parseInt(match.groups.month, 10);
    const day = Number.parseInt(match.groups.day, 10);

    if (year < 100) {
      year += 2000;
    }

    candidates.push(new Date(year, month - 1, day));
  }

  for (const match of source.matchAll(/\b(?<year>\d{4})[\/.-](?<month>\d{1,2})[\/.-](?<day>\d{1,2})\b/g)) {
    const year = Number.parseInt(match.groups.year, 10);
    const month = Number.parseInt(match.groups.month, 10);
    const day = Number.parseInt(match.groups.day, 10);

    candidates.push(new Date(year, month - 1, day));
  }

  return uniqueSortedDates(candidates);
}

function parseIssuer(text) {
  const source = normalizeText(text) ?? '';

  if (/\bGemeente\s+Rotterdam\b/i.test(source)) {
    return 'Rotterdam Gemeente';
  }

  const match = source.match(/\bGemeente\s+([A-Z][A-Za-z]+(?:[\s-][A-Z][A-Za-z]+){0,2})\b/);
  if (!match) {
    return null;
  }

  return `${match[1].replace(/\s+/g, ' ').trim()} Gemeente`;
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

async function collectFilesRecursive(folderPath, predicate) {
  const files = [];

  if (!(await pathExists(folderPath))) {
    return files;
  }

  const entries = await fsp.readdir(folderPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFilesRecursive(fullPath, predicate)));
      continue;
    }

    if (predicate(fullPath, entry)) {
      files.push(fullPath);
    }
  }

  return files;
}

async function getFirstDwgPath(projectFolderPath) {
  if (!(await pathExists(projectFolderPath))) {
    return null;
  }

  const entries = await fsp.readdir(projectFolderPath, { withFileTypes: true });
  const dwgEntry = entries.find((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.dwg');
  return dwgEntry ? path.join(projectFolderPath, dwgEntry.name) : null;
}

async function readPdfText(pdfPath) {
  const pdfBuffer = await fsp.readFile(pdfPath);
  const parser = new PDFParse({ data: pdfBuffer });

  try {
    const result = await parser.getText();
    return result.text ?? '';
  }
  finally {
    await parser.destroy().catch(() => {});
  }
}

async function withSuppressedConsole(action) {
  const originalLog = console.log;
  console.log = () => {};

  try {
    return await action();
  }
  finally {
    console.log = originalLog;
  }
}

async function inspectProjectFolder(projectFolderPath) {
  const normalizedPath = normalizeText(projectFolderPath);

  if (!normalizedPath || !(await pathExists(normalizedPath))) {
    return {
      projectFolderName: normalizeText(path.basename(normalizedPath ?? '')) ?? null,
      hasDwg: false,
      dwgPath: null,
      permitFolderName: null,
      permitPdfCount: 0,
      buildingFolderCount: 0
    };
  }

  const dwgPath = await getFirstDwgPath(normalizedPath);
  const vergunningFolder = path.join(normalizedPath, 'Vergunningen');
  const gebouwenFolder = path.join(normalizedPath, 'Gebouwen');

  let permitFolderName = null;
  let permitPdfCount = 0;
  let buildingFolderCount = 0;

  if (await pathExists(vergunningFolder)) {
    const permitEntries = await fsp.readdir(vergunningFolder, { withFileTypes: true });
    const permitDirectory = permitEntries.find((entry) => entry.isDirectory());
    permitFolderName = permitDirectory ? permitDirectory.name : null;
    permitPdfCount = (
      await collectFilesRecursive(
        vergunningFolder,
        (fullPath) => path.extname(fullPath).toLowerCase() === '.pdf'
      )
    ).length;
  }

  if (await pathExists(gebouwenFolder)) {
    const buildingEntries = await fsp.readdir(gebouwenFolder, { withFileTypes: true });
    buildingFolderCount = buildingEntries.filter((entry) => entry.isDirectory()).length;
  }

  return {
    projectFolderName: path.basename(normalizedPath),
    hasDwg: Boolean(dwgPath),
    dwgPath,
    permitFolderName,
    permitPdfCount,
    buildingFolderCount
  };
}

async function extractCoordinatesFromDwg(projectFolderPath) {
  const warnings = [];
  const dwgPath = await getFirstDwgPath(projectFolderPath);
  const coordinates = {};

  if (!dwgPath) {
    warnings.push('No se ha encontrado un DWG en la carpeta del proyecto.');

    return {
      dwgPath: null,
      coordinates,
      coordinateCount: 0,
      warnings
    };
  }

  const rootDirectory = path.resolve(__dirname, '..', '..');
  const wasmDirectory = path.join(rootDirectory, 'node_modules', '@mlightcad', 'libredwg-web', 'wasm') + path.sep;

  if (!fs.existsSync(wasmDirectory)) {
    warnings.push('No se ha encontrado la carpeta WASM de libredwg.');

    return {
      dwgPath,
      coordinates,
      coordinateCount: 0,
      warnings
    };
  }

  try {
    await withSuppressedConsole(async () => {
      const libredwg = await LibreDwg.create(wasmDirectory);
      const fileContent = fs.readFileSync(dwgPath);
      const dwg = libredwg.dwg_read_data(fileContent, Dwg_File_Type.DWG);
      const database = libredwg.convert(dwg);

      for (const entity of database.entities ?? []) {
        if (entity.type !== 'INSERT' || entity.layer !== 'Accesspoint') {
          continue;
        }

        const attribute = (entity.attribs ?? []).find((item) => item.tag === 'DBSB_NAAM');
        const label = normalizeText(attribute?.text?.text);

        if (!label) {
          continue;
        }

        coordinates[label] = {
          x: entity.insertionPoint?.x ?? 0,
          y: entity.insertionPoint?.y ?? 0,
          z: entity.insertionPoint?.z ?? 0
        };
      }
    });
  }
  catch (error) {
    warnings.push(`No se pudo leer el DWG: ${error instanceof Error ? error.message : String(error)}`);
  }

  const coordinateCount = Object.keys(coordinates).length;

  if (coordinateCount === 0) {
    warnings.push('No se han encontrado bloques de Accesspoint con etiqueta DBSB_NAAM.');
  }

  return {
    dwgPath,
    coordinates,
    coordinateCount,
    warnings
  };
}

async function extractVergunningInfo(projectFolderPath) {
  const projectLabel = normalizeText(path.basename(projectFolderPath ?? ''));
  const warnings = [];
  const vergunningFolder = path.join(projectFolderPath, 'Vergunningen');

  const info = {
    name: projectLabel ? `Instemming Gemeente ${projectLabel}` : 'Instemming Gemeente',
    issuer: null,
    grantedDate: null,
    expiryDate: null,
    permitFolderName: null,
    permitPdfCount: 0,
    warnings
  };

  if (!(await pathExists(vergunningFolder))) {
    warnings.push('No se ha encontrado la carpeta Vergunningen.');
    return info;
  }

  const permitEntries = await fsp.readdir(vergunningFolder, { withFileTypes: true });
  const permitDirectory = permitEntries.find((entry) => entry.isDirectory());

  if (permitDirectory) {
    info.name = permitDirectory.name;
    info.permitFolderName = permitDirectory.name;
  }

  const pdfPaths = await collectFilesRecursive(
    vergunningFolder,
    (fullPath) => path.extname(fullPath).toLowerCase() === '.pdf'
  );

  info.permitPdfCount = pdfPaths.length;

  if (pdfPaths.length === 0) {
    warnings.push('No se han encontrado PDFs dentro de Vergunningen.');
    return info;
  }

  let combinedText = '';

  for (const pdfPath of pdfPaths) {
    try {
      combinedText += `\n${await readPdfText(pdfPath)}`;
    }
    catch (error) {
      warnings.push(`No se pudo leer el PDF '${path.basename(pdfPath)}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const allDates = extractDateCandidates(combinedText);

  if (allDates.length > 0) {
    const grantedDate = allDates.at(-1);
    const expiryDate = new Date(grantedDate.getFullYear() + 1, grantedDate.getMonth(), grantedDate.getDate());

    info.grantedDate = formatIsoDate(grantedDate);
    info.expiryDate = formatIsoDate(expiryDate);
  }
  else {
    warnings.push('No se ha encontrado ninguna fecha legible en los PDFs de vergunning.');
  }

  info.issuer = parseIssuer(combinedText);

  return info;
}

async function extractProjectMetadata(projectFolderPath) {
  const [inspection, coordinateResult, vergunningResult] = await Promise.all([
    inspectProjectFolder(projectFolderPath),
    extractCoordinatesFromDwg(projectFolderPath),
    extractVergunningInfo(projectFolderPath)
  ]);

  return {
    coordinates: coordinateResult.coordinates,
    vergunning: {
      name: vergunningResult.name,
      issuer: vergunningResult.issuer,
      grantedDate: vergunningResult.grantedDate,
      expiryDate: vergunningResult.expiryDate
    },
    diagnostics: {
      ...inspection,
      coordinateCount: coordinateResult.coordinateCount,
      permitPdfCount: vergunningResult.permitPdfCount,
      permitFolderName: vergunningResult.permitFolderName,
      warnings: [...coordinateResult.warnings, ...vergunningResult.warnings]
    }
  };
}

module.exports = {
  extractProjectMetadata,
  inspectProjectFolder
};
