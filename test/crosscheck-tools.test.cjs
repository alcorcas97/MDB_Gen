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
  afwerk.cell('C2').formula('"manual override"').style('fill', 'FFFFFF00');
  afwerk.cell('B3').value('old data');
  afwerk.cell('C4').formula('B4&"-helper"');
  afwerk.cell('H5').formula('SUM(A1:A4)');
  afwerk.column(8).hidden(true);
  await workbook.toFileAsync(templatePath);
}

test('cross check export replaces mapped formulas except explicit yellow overrides', async (t) => {
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
      AfwerkODF: [{ ID: 'new id', LOCATIE: 'new location', CBN: 'MDB CBN' }]
    }
  });
  const output = await XlsxPopulate.fromFileAsync(outputPath);
  const afwerk = output.sheet('AfwerkODF');

  assert.equal(afwerk.cell('A2').formula(), undefined);
  assert.equal(afwerk.cell('A2').value(), 'new id');
  assert.equal(afwerk.cell('B2').value(), 'new location');
  assert.equal(afwerk.cell('C2').formula(), '"manual override"');
  assert.equal(afwerk.cell('B3').value(), undefined);
  assert.equal(afwerk.cell('C4').formula(), undefined);
  assert.equal(afwerk.cell('H5').formula(), undefined);
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

test('cross check export extends only required helper checks and keeps Accesspoint lookup data separate', async (t) => {
  const tempDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'crosscheck-tools-formulas-'));
  t.after(() => fsp.rm(tempDirectory, { recursive: true, force: true }));

  const templatePath = path.join(tempDirectory, 'template.xlsx');
  const mdbPath = path.join(tempDirectory, 'output.mdb');
  const fcPath = path.join(tempDirectory, 'fc.xlsx');
  const bcPath = path.join(tempDirectory, 'bc.csv');
  await createTemplate(templatePath);

  const template = await XlsxPopulate.fromFileAsync(templatePath);
  const accesspoint = template.sheet('Accesspoint');
  accesspoint.cell('X2').value('Buiseinde').style('fill', 'FFFFFF00');
  accesspoint.cell('Y2').value(-60).style('fill', 'FFFFFF00');
  accesspoint.cell('X3').value('HH_29030_AT02').style('fill', 'FFFFFF00');
  accesspoint.cell('Y3').value(-60).style('fill', 'FFFFFF00');
  accesspoint.cell('X4').value('LB_BUDI-M-SP-A_TY01').style('fill', 'FFFFFF00');
  accesspoint.cell('Y4').value(0).style('fill', 'FFFFFF00');
  for (const column of [1, 2]) {
    template.sheet('ODF').cell(2, column).formula(`C2&" helper ${column}"`);
    template.sheet('ODF').cell(3, column).formula(`C3&" helper ${column}"`);
  }
  for (const [sheetName, column] of [['AfwerkODF', 16], ['Kabel', 16]]) {
    template.sheet(sheetName).cell(2, column).formula('A2&" helper"');
    template.sheet(sheetName).cell(3, column).formula('A3&" helper"');
    template.sheet(sheetName).column(column).hidden(true);
  }
  template.sheet('Kabel').cell('B2').formula('A2&" data formula"');
  template.sheet('Kabel').cell('B3').formula('A3&" data formula"');
  for (const column of [1, 2, 3, 4]) {
    template.sheet('Klant').cell(2, column).formula(`E2&" helper ${column}"`).style('fill', 'FFFFFF00');
    template.sheet('Klant').cell(3, column).formula(`E3&" helper ${column}"`).style('fill', 'FFFFFF00');
  }
  template.sheet('LAS').cell('O3').formula('A3&" row 3"');
  template.sheet('LAS').cell('O4').formula('A4&" row 4"');
  template.sheet('LAS').column(15).hidden(true);
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
      Accesspoint: Array.from({ length: 70 }, (_value, index) => ({
        ID: `AP-${index + 1}`,
        Accesspointtype: index < 15 ? 'Kabelmanteleinde' : index === 15 ? 'RC_OFDR-I_TY01' : 'A',
        Z: index < 15 ? 0 : index === 15 ? -60 : 1
      })),
      ODF: [{ ID: 'O-1' }, { ID: 'O-2' }, { ID: 'O-3' }],
      AfwerkODF: [{ ID: 'A-1' }, { ID: 'A-2' }, { ID: 'A-3' }],
      Kabel: [{ ID: 'K-1', Label: 'label 1' }, { ID: 'K-2', Label: 'label 2' }, { ID: 'K-3', Label: 'label 3' }],
      Klant: [{ ID: 'C-1' }, { ID: 'C-2' }, { ID: 'C-3' }],
      Las: [{ ID: 'L-1' }, { ID: 'L-2' }, { ID: 'L-3' }]
    }
  });
  const output = await XlsxPopulate.fromFileAsync(outputPath);

  assert.equal(output.sheet('Accesspoint').cell('A2').formula(), 'IF(D2="","",_xlfn.IFNA(IF(_xlfn.XLOOKUP(D2,$X$2:$X$6,$Y$2:$Y$6)=G2,"V","wrong depth"),"wrong type"))');
  assert.equal(output.sheet('Accesspoint').cell('A71').formula(), 'IF(D71="","",_xlfn.IFNA(IF(_xlfn.XLOOKUP(D71,$X$2:$X$6,$Y$2:$Y$6)=G71,"V","wrong depth"),"wrong type"))');
  assert.equal(output.sheet('Accesspoint').cell('B71').value(), 'AP-70');
  assert.deepEqual(output.sheet('Accesspoint').range('X2:Y6').value(), [
    ['Buiseinde', -60],
    ['HH_29030_AT02', -60],
    ['LB_BUDI-M-SP-A_TY01', 0],
    ['Kabelmanteleinde', 0],
    ['RC_OFDR-I_TY01', -60]
  ]);
  for (const column of [1, 2]) {
    assert.equal(output.sheet('ODF').cell(4, column).formula(), `C4&" helper ${column}"`);
  }
  assert.equal(output.sheet('AfwerkODF').cell('P4').formula(), 'A4&" helper"');
  assert.equal(output.sheet('AfwerkODF').column(16).hidden(), true);
  assert.equal(output.sheet('Kabel').cell('P4').formula(), 'A4&" helper"');
  assert.equal(output.sheet('Kabel').column(16).hidden(), true);
  assert.equal(output.sheet('Kabel').cell('B4').formula(), undefined);
  assert.equal(output.sheet('Kabel').cell('B4').value(), 'label 3');
  for (const column of [1, 2, 3, 4]) {
    assert.equal(output.sheet('Klant').cell(4, column).formula(), `E4&" helper ${column}"`);
  }
  assert.equal(output.sheet('LAS').cell('O5').formula(), 'A5&" row 4"');
  assert.equal(output.sheet('LAS').column(15).hidden(), true);
});
