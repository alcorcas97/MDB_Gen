const fsp = require('node:fs/promises');
const path = require('node:path');
const XlsxPopulate = require('xlsx-populate');
const { parse } = require('csv-parse/sync');

function normalizeText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value)
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/[\u00AD\u200B\u200C\u200D\u2060\uFEFF]/g, '')
    .trim();

  return text || null;
}

function getRowValue(row, name) {
  if (!row || !name) {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(row, name)) {
    return row[name];
  }

  return null;
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

async function resolveTemplatePath(projectFolderPath, fallbackTemplatePath) {
  const candidates = [];

  if (normalizeText(projectFolderPath)) {
    candidates.push(path.join(projectFolderPath, 'Address cross check Cocon delivery 4.0.xlsx'));
  }

  if (normalizeText(fallbackTemplatePath)) {
    candidates.push(fallbackTemplatePath);
  }

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return path.resolve(candidate);
    }
  }

  throw new Error('No se ha encontrado el template de Address cross check Cocon delivery 4.0.');
}

function buildOutputPath(mdbPath) {
  const resolvedPath = path.resolve(mdbPath);
  const outputDirectory = path.dirname(resolvedPath);
  const baseName = path.basename(resolvedPath, path.extname(resolvedPath));
  return path.join(outputDirectory, `${baseName}.Address cross check Cocon delivery 4.0.xlsx`);
}

function buildRowObject(headers, values) {
  const result = {};
  const limit = Math.min(headers.length, values.length);

  for (let index = 0; index < limit; index += 1) {
    const header = headers[index];
    if (header === null || header === undefined || header === '') {
      continue;
    }

    result[String(header)] = values[index];
  }

  return result;
}

async function readFcRows(fcPath) {
  const workbook = await XlsxPopulate.fromFileAsync(fcPath);
  const sheet = workbook.sheet(0);
  const usedRange = sheet.usedRange();

  if (!usedRange) {
    return [];
  }

  const values = usedRange.value();
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }

  const headers = Array.isArray(values[0]) ? values[0] : [];
  const rows = [];

  for (const rowValues of values.slice(1)) {
    const row = buildRowObject(headers, Array.isArray(rowValues) ? rowValues : []);
    if (normalizeText(row['Kabel ID'])) {
      rows.push(row);
    }
  }

  return rows;
}

async function readBcRows(bcPath) {
  const rawCsv = await fsp.readFile(bcPath, 'utf8');
  const rows = parse(rawCsv, {
    bom: true,
    columns: true,
    delimiter: ';',
    relax_column_count: true,
    skip_empty_lines: true
  });

  return rows.filter((row) => normalizeText(row.KabelID));
}

function clearColumns(sheet, startRow, columnsToClear) {
  if (!Array.isArray(columnsToClear) || columnsToClear.length === 0) {
    return;
  }

  const usedRange = sheet.usedRange();
  if (!usedRange) {
    return;
  }

  const endRow = usedRange.endCell().rowNumber();
  if (!Number.isFinite(endRow) || endRow < startRow) {
    return;
  }

  for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
    for (const columnIndex of columnsToClear) {
      sheet.cell(rowIndex, columnIndex).clear();
    }
  }
}

function setCellValue(sheet, rowIndex, columnIndex, value) {
  const cell = sheet.cell(rowIndex, columnIndex);

  if (typeof value === 'string') {
    value = normalizeText(value);
  }

  if (value === null || value === undefined) {
    cell.clear();
    return;
  }

  cell.value(value);
}

function writeMappedRows(sheet, startRow, rows, clearCols, mapper) {
  clearColumns(sheet, startRow, clearCols);

  let rowIndex = startRow;
  for (const row of rows) {
    const rowMap = mapper(row);
    for (const [columnIndex, value] of Object.entries(rowMap)) {
      setCellValue(sheet, rowIndex, Number(columnIndex), value);
    }

    rowIndex += 1;
  }
}

async function exportCrossCheckWorkbook({
  projectFolderPath,
  templatePath,
  mdbPath,
  fcPath,
  bcPath,
  tableRows
}) {
  const resolvedTemplatePath = await resolveTemplatePath(projectFolderPath, templatePath);
  const outputPath = buildOutputPath(mdbPath);
  const [fcRows, bcRows] = await Promise.all([
    readFcRows(fcPath),
    readBcRows(bcPath)
  ]);

  const workbook = await XlsxPopulate.fromFileAsync(resolvedTemplatePath);

  writeMappedRows(workbook.sheet('FC'), 2, fcRows, Array.from({ length: 22 }, (_value, index) => index + 5), (row) => ({
    5: getRowValue(row, 'Projectnummer'),
    6: getRowValue(row, 'Postcode'),
    7: getRowValue(row, 'Huisnummer'),
    8: getRowValue(row, 'Huisnummer Toevoeging'),
    9: getRowValue(row, 'Kamer'),
    10: getRowValue(row, 'Straat'),
    11: getRowValue(row, 'Plaats'),
    12: getRowValue(row, 'FTU locatie'),
    13: getRowValue(row, 'Powermeter'),
    14: getRowValue(row, 'IP vezelwaarde'),
    15: getRowValue(row, 'Opleverstatus KPN'),
    16: getRowValue(row, 'Opleverdatum'),
    17: getRowValue(row, 'AP'),
    18: getRowValue(row, 'Werkgebied'),
    19: getRowValue(row, 'Opgeleverd'),
    20: getRowValue(row, 'KPN/Glaspoort'),
    21: getRowValue(row, 'Kast'),
    22: getRowValue(row, 'Kastrij'),
    23: getRowValue(row, 'ODF'),
    24: getRowValue(row, 'ODF Positie'),
    25: getRowValue(row, 'DP'),
    26: getRowValue(row, 'Kabel ID')
  }));

  writeMappedRows(workbook.sheet('BC'), 2, bcRows, Array.from({ length: 29 }, (_value, index) => index + 3), (row) => ({
    3: getRowValue(row, 'Postcode'),
    4: getRowValue(row, 'Huisnummer'),
    5: getRowValue(row, 'HuisnummerToevoeging'),
    6: getRowValue(row, 'Kamer'),
    7: getRowValue(row, 'Plandatum'),
    8: getRowValue(row, 'Opleverdatum'),
    9: getRowValue(row, 'Opleverstatus'),
    10: getRowValue(row, 'Areapop'),
    11: getRowValue(row, 'Rij'),
    12: getRowValue(row, 'Kast'),
    13: getRowValue(row, 'Blok'),
    14: getRowValue(row, 'ODF'),
    15: getRowValue(row, 'ODFpositie'),
    16: getRowValue(row, 'ODFCATV'),
    17: getRowValue(row, 'ODFCATVpositie'),
    18: getRowValue(row, 'Projectcode'),
    19: getRowValue(row, 'Hasdatum'),
    20: getRowValue(row, 'Toestemming'),
    21: getRowValue(row, 'Gebouwtype'),
    22: getRowValue(row, 'FTU-Type'),
    23: getRowValue(row, 'Toelichting'),
    24: getRowValue(row, 'Civieldatum'),
    25: getRowValue(row, 'Kavel'),
    26: getRowValue(row, 'KabelID'),
    27: getRowValue(row, 'HLopleverdatum'),
    28: getRowValue(row, 'Typebouw'),
    29: getRowValue(row, 'RedenNA'),
    30: getRowValue(row, 'StrengID'),
    31: getRowValue(row, 'Doorvoerafhankelijkheid')
  }));

  writeMappedRows(workbook.sheet('ODF'), 2, tableRows.ODF ?? [], Array.from({ length: 8 }, (_value, index) => index + 3), (row) => ({
    3: row.ID,
    4: row.Nummer,
    5: row.ODFTYPE,
    6: row.CBN,
    7: row.Locatie,
    8: row.HoogtePositie,
    9: row.Zijde,
    10: row.ImportResult
  }));

  writeMappedRows(workbook.sheet('AfwerkODF'), 2, tableRows.AfwerkODF ?? [], Array.from({ length: 10 }, (_value, index) => index + 1), (row) => ({
    1: row.ID,
    2: row.LOCATIE,
    3: row.CBN,
    4: row.ODF,
    5: row.Traynr,
    6: row.PP,
    7: row.Kabel,
    8: row.Vezelnr,
    9: row.Connectortype,
    10: row.ImportResult
  }));

  writeMappedRows(workbook.sheet('Accesspoint'), 2, tableRows.Accesspoint ?? [], Array.from({ length: 9 }, (_value, index) => index + 2), (row) => ({
    2: row.ID,
    3: row.Label,
    4: row.Accesspointtype,
    5: row.X,
    6: row.Y,
    7: row.Z,
    8: row.Toelichting,
    9: row.Nauwkeurigheid,
    10: row.ImportResult
  }));

  writeMappedRows(workbook.sheet('Kabel'), 2, tableRows.Kabel ?? [], Array.from({ length: 12 }, (_value, index) => index + 1), (row) => ({
    1: row.ID,
    2: row.Label,
    3: row.Kabeltype,
    4: row.Locatienaam_A,
    5: row.Afwerkeenheid_A,
    6: row.PoortA,
    7: row.Locatienaam_B,
    8: row.Afwerkeenheid_B,
    9: row.PoortB,
    10: row.Serienummer,
    11: row.ImportResult,
    12: row.CATEGORIE
  }));

  writeMappedRows(workbook.sheet('Klant'), 2, tableRows.Klant ?? [], [...Array.from({ length: 22 }, (_value, index) => index + 5), 28], (row) => ({
    5: row.ID,
    6: row.Postcode,
    7: row.Huisnr,
    8: row.Toevoeging,
    9: row.Kastnr,
    10: row.FTUType,
    11: row.Kabel,
    12: row.VEZELNR1,
    13: row.Dempingswaarde1A,
    14: row.Specificatie1A,
    15: row.Dempingswaarde1Z,
    16: row.Specificatie1Z,
    17: row.Vezelnr2,
    18: row.Dempingswaarde2A,
    19: row.Specificatie2A,
    20: row.Dempingswaarde2Z,
    21: row.Specificatie2Z,
    22: row.X,
    23: row.Y,
    24: row.ImportResult,
    25: row.COMPLEX,
    26: row.KAMER,
    28: row.FTU_SERIENUMMER
  }));

  writeMappedRows(workbook.sheet('LAS'), 3, tableRows.Las ?? [], Array.from({ length: 13 }, (_value, index) => index + 1), (row) => ({
    1: row.ID,
    2: row.LOCATIE,
    3: row.SPLICEBOX,
    4: row.KabelA,
    5: row.VezelnrA,
    6: row.Cassette,
    7: row.Positienr,
    8: row.CassetteType,
    9: row.Gelast,
    10: row.KabelB,
    11: row.VezelnrB,
    12: row.zijde_fasplaat,
    13: row.ImportResult
  }));

  await workbook.toFileAsync(outputPath);

  return {
    mdbPath: path.resolve(mdbPath),
    outputPath
  };
}

module.exports = {
  exportCrossCheckWorkbook
};
