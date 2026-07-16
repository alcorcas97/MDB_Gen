const fs = require('node:fs');
const XlsxPopulate = require('xlsx-populate');

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      }
      else {
        quoted = !quoted;
      }
      continue;
    }

    if (character === ',' && !quoted) {
      values.push(current);
      current = '';
      continue;
    }

    current += character;
  }

  values.push(current);
  return values;
}

async function main() {
  const csvPath = process.argv[2];
  const xlsxPath = process.argv[3];

  if (!csvPath || !xlsxPath) {
    throw new Error('Uso: node export_pop_areas_xlsx.cjs <csvPath> <xlsxPath>');
  }

  const rawCsv = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '').trim();
  const rows = rawCsv.split(/\r?\n/).map(parseCsvLine);

  const workbook = await XlsxPopulate.fromBlankAsync();
  const sheet = workbook.sheet(0);
  sheet.name('POP areas');

  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      sheet.cell(rowIndex + 1, columnIndex + 1).value(value);
    });
  });

  sheet.row(1).style({ bold: true });
  sheet.usedRange().style({ horizontalAlignment: 'left' });

  await workbook.toFileAsync(xlsxPath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
