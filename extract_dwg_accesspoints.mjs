import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web';

const dwgPath = process.argv[2];

if (!dwgPath) {
  console.error('Usage: node extract_dwg_accesspoints.mjs <dwg-path>');
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const wasmDir = path.join(__dirname, 'node_modules', '@mlightcad', 'libredwg-web', 'wasm') + path.sep;

const originalLog = console.log;
console.log = () => {};

try {
  const libredwg = await LibreDwg.create(wasmDir);
  const fileContent = fs.readFileSync(dwgPath);
  const dwg = libredwg.dwg_read_data(fileContent, Dwg_File_Type.DWG);
  const db = libredwg.convert(dwg);

  const coordinates = {};

  for (const entity of db.entities ?? []) {
    if (entity.type !== 'INSERT' || entity.layer !== 'Accesspoint') {
      continue;
    }

    const attribute = (entity.attribs ?? []).find((item) => item.tag === 'DBSB_NAAM');
    const label = attribute?.text?.text?.trim();
    if (!label) {
      continue;
    }

    coordinates[label] = {
      x: entity.insertionPoint?.x ?? 0,
      y: entity.insertionPoint?.y ?? 0,
      z: entity.insertionPoint?.z ?? 0
    };
  }

  process.stdout.write(JSON.stringify({ coordinates }));
}
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
finally {
  console.log = originalLog;
}
