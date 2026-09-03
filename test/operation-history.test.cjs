const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createOperationBackup,
  listOperationHistory,
  restoreOperation,
  updateOperationBackup
} = require('../app/lib/operation-history.cjs');

test('operation history backs up, verifies and restores project files', async (t) => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'fiber-history-'));
  t.after(() => fs.rm(projectPath, { recursive: true, force: true }));
  const mdbPath = path.join(projectPath, 'Project-B1.mdb');
  const dwgPath = path.join(projectPath, 'Project-B1.dwg');
  await fs.writeFile(mdbPath, 'mdb-before');
  await fs.writeFile(dwgPath, 'dwg-before');

  const entry = await createOperationBackup({
    projectPath,
    operation: 'test-change',
    label: 'Cambio de prueba',
    filePaths: [mdbPath, dwgPath]
  });
  await fs.writeFile(mdbPath, 'mdb-after');
  await fs.writeFile(dwgPath, 'dwg-after');

  const history = await listOperationHistory(projectPath);
  assert.equal(history.length, 1);
  assert.equal(history[0].fileCount, 2);
  await updateOperationBackup({
    projectPath,
    entryId: entry.id,
    status: 'completed',
    summary: { updatedRows: 4 }
  });
  const completed = await listOperationHistory(projectPath);
  assert.equal(completed[0].status, 'completed');
  assert.equal(completed[0].summary.updatedRows, 4);

  const restored = await restoreOperation({ projectPath, entryId: entry.id });
  assert.equal(await fs.readFile(mdbPath, 'utf8'), 'mdb-before');
  assert.equal(await fs.readFile(dwgPath, 'utf8'), 'dwg-before');
  assert.equal(restored.restoredFiles.length, 2);

  const historyAfterRestore = await listOperationHistory(projectPath);
  assert.equal(historyAfterRestore.length, 2);
  assert.match(historyAfterRestore[0].label, /^Antes de restaurar:/);
});

test('operation history ignores missing and unsupported files', async (t) => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'fiber-history-empty-'));
  t.after(() => fs.rm(projectPath, { recursive: true, force: true }));
  const entry = await createOperationBackup({
    projectPath,
    operation: 'nothing',
    filePaths: [path.join(projectPath, 'missing.mdb'), path.join(projectPath, 'notes.txt')]
  });
  assert.equal(entry, null);
  assert.deepEqual(await listOperationHistory(projectPath), []);
});
