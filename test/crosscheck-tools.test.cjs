const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const XlsxPopulate = require('xlsx-populate');

const { exportCrossCheckWorkbook } = require('../app/lib/crosscheck-tools.cjs');

const SHEETS = ['FC', 'BC', 'ODF', 'AfwerkODF', 'Accesspoint', 'Kabel', 'Klant', 'LAS'];

async function createTemplate(templatePath) {
  const workbook = await XlsxPopulate.fromBlankAsync();
  workbook.sheet(0).name(SHEETS[0]);
  for (const name of SHEETS.slice(1)) {
    workbook.addSheet(name);
  }

  const afwerk = workbook.sheet('AfwerkODF');
  afwerk.cell('A2').formula('1+1');
  afwerk.cell('B3').value('old data');
  afwerk.cell('C4').formula('B4&"-helper"');
  afwerk.cell('H5').formula('SUM(A1:A4)');
  afwerk.column(8).hidden(true);
  await workbook.toFileAsync(templatePath);
}

test('cross check export preserves template formulas while replacing mapped values', async (t) => {
  const tempDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'crosscheck-tools-'));
  t.after(() => fsp.rm(tempDirectory, { recursive: true, force: true }));

  const templatePath = path.join(tempDirectory, 'template.xlsx');
  const mdbPath = path.join(tempDirectory, 'output.mdb');
  const fcPath = path.join(tempDirectory, 'fc.xlsx');
  const bcPath = path.join(tempDirectory, 'bc.csv');
  await createTemplate(templatePath);

  const fcWorkbook = await XlsxPopulate.fromBlankAsync();
  fcWorkbook.sheet(0).cell('A1').value('Kabel ID');
  fcWorkbook.sheet(0).cell('B1').value('Projectnummer');
  fcWorkbook.sheet(0).cell('A2').value('K-1');
  fcWorkbook.sheet(0).cell('B2').value('project-1');
  await fcWorkbook.toFileAsync(fcPath);
  await fsp.writeFile(bcPath, 'KabelID\n');

  const { outputPath } = await exportCrossCheckWorkbook({
    templatePath,
    mdbPath,
    fcPath,
    bcPath,
    tableRows: {
      AfwerkODF: [{ ID: 'new id', LOCATIE: 'new location' }]
    }
  });
  const output = await XlsxPopulate.fromFileAsync(outputPath);
  const afwerk = output.sheet('AfwerkODF');

  assert.equal(afwerk.cell('A2').formula(), '1+1');
  assert.equal(afwerk.cell('B2').value(), 'new location');
  assert.equal(afwerk.cell('B3').value(), undefined);
  assert.equal(afwerk.cell('C4').formula(), 'B4&"-helper"');
  assert.equal(afwerk.cell('H5').formula(), 'SUM(A1:A4)');
  assert.equal(afwerk.column(8).hidden(), true);
  assert.equal(output._node.children.find((node) => node.name === 'calcPr').attributes.forceFullCalc, 1);
  assert.equal(output.sheet('FC').cell('E2').value(), 'project-1');
});

test('cross check export does not materialize an inflated worksheet tail', async (t) => {
  const tempDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'crosscheck-tools-tail-'));
  t.after(() => fsp.rm(tempDirectory, { recursive: true, force: true }));

  const templatePath = path.join(tempDirectory, 'template.xlsx');
  const mdbPath = path.join(tempDirectory, 'output.mdb');
  const fcPath = path.join(tempDirectory, 'fc.xlsx');
  const bcPath = path.join(tempDirectory, 'bc.csv');
  await createTemplate(templatePath);

  const template = await XlsxPopulate.fromFileAsync(templatePath);
  template.sheet('Klant').cell('E1048529').value('stale tail value');
  await template.toFileAsync(templatePath);

  const fcWorkbook = await XlsxPopulate.fromBlankAsync();
  fcWorkbook.sheet(0).cell('A1').value('Kabel ID');
  await fcWorkbook.toFileAsync(fcPath);
  await fsp.writeFile(bcPath, 'KabelID\n');

  const { outputPath } = await exportCrossCheckWorkbook({
    templatePath,
    mdbPath,
    fcPath,
    bcPath,
    tableRows: { Klant: [{ ID: 'new customer' }] }
  });
  const output = await XlsxPopulate.fromFileAsync(outputPath);
  const size = (await fsp.stat(outputPath)).size;

  const klant = output.sheet('Klant');
  assert.equal(klant._rows[1048529], undefined);
  assert.equal(klant.usedRange().endCell().rowNumber(), 2);
  assert.equal(klant.cell('E2').value(), 'new customer');
  assert.ok(size < 1024 * 1024, `expected compact workbook, got ${size} bytes`);
});

test('cross check export extends dense formula series through the final data row', async (t) => {
  const tempDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'crosscheck-tools-formulas-'));
  t.after(() => fsp.rm(tempDirectory, { recursive: true, force: true }));

  const templatePath = path.join(tempDirectory, 'template.xlsx');
  const mdbPath = path.join(tempDirectory, 'output.mdb');
  const fcPath = path.join(tempDirectory, 'fc.xlsx');
  const bcPath = path.join(tempDirectory, 'bc.csv');
  await createTemplate(templatePath);

  const template = await XlsxPopulate.fromFileAsync(templatePath);
  for (const column of [2, 3, 4, 5, 7, 8]) {
    template.sheet('Kabel').cell(2, column).formula('A2&" row 2"');
    template.sheet('Kabel').cell(3, column).formula('A3&" row 3"');
  }
  template.sheet('Kabel').cell('C2').formula('SUM($A$2,A:A,A2,"A2 ""quoted""")');
  template.sheet('Kabel').cell('C3').formula('SUM($A$2,A:A,A3,"A3 ""quoted""")');
  template.sheet('Kabel').cell('P1').formula('COUNTA(A:A)');
  for (const column of [1, 2, 3, 4, 9, 10, 11, 13, 22]) {
    template.sheet('Klant').cell(2, column).formula('E2&" row 2"');
    template.sheet('Klant').cell(3, column).formula('E3&" row 3"');
  }
  template.sheet('LAS').cell('O3').formula('A3&" row 3"');
  template.sheet('LAS').cell('O4').formula('A4&" row 4"');
  await template.toFileAsync(templatePath);

  const fcWorkbook = await XlsxPopulate.fromBlankAsync();
  fcWorkbook.sheet(0).cell('A1').value('Kabel ID');
  await fcWorkbook.toFileAsync(fcPath);
  await fsp.writeFile(bcPath, 'KabelID\n');

  const { outputPath } = await exportCrossCheckWorkbook({
    templatePath,
    mdbPath,
    fcPath,
    bcPath,
    tableRows: {
      Kabel: [{ ID: 'K-1' }, { ID: 'K-2' }, { ID: 'K-3' }],
      Klant: [{ ID: 'C-1' }, { ID: 'C-2' }, { ID: 'C-3' }],
      Las: [{ ID: 'L-1' }, { ID: 'L-2' }, { ID: 'L-3' }]
    }
  });
  const output = await XlsxPopulate.fromFileAsync(outputPath);

  for (const column of [2, 4, 5, 7, 8]) {
    assert.equal(output.sheet('Kabel').cell(4, column).formula(), 'A4&" row 3"');
  }
  assert.equal(output.sheet('Kabel').cell('C4').formula(), 'SUM($A$2,A:A,A4,"A3 ""quoted""")');
  for (const column of [1, 2, 3, 4, 9, 10, 11, 13, 22]) {
    assert.equal(output.sheet('Klant').cell(4, column).formula(), 'E4&" row 3"');
  }
  assert.equal(output.sheet('LAS').cell('O5').formula(), 'A5&" row 4"');
  assert.equal(output.sheet('Kabel').cell('P4').formula(), undefined);
});
