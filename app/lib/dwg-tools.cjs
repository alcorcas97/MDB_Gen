const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { Dwg_File_Type, LibreDwg } = require('@mlightcad/libredwg-web');
let cachedAccoreConsolePath = null;
const appRoot = path.resolve(__dirname, '..');
const autocadToolsScriptPath = path.join(appRoot, 'autocad_tools.ps1');
const DWG_PROGRESS_POLL_MS = 400;
const DRAW_COMMAND_NAME = 'FIBER_DRAW_CUSTOMERS';
const EXPORT_COMMAND_NAME = 'FIBER_EXPORT_CUSTOMER_COORDS';
const CLEAN_COMMAND_NAME = 'FIBER_CLEAR_CUSTOMER_COORDS';
const REMOVE_EXTRA_ROLES_COMMAND_NAME = 'FIBER_REMOVE_EXTRA_ROLES';
const DRAW_ACCESSNET_WITHOUT_ADDRESS_COMMAND_NAME = 'FIBER_DRAW_ACCESSNET_WITHOUT_ADDRESS';
const EXTRA_ROLE_BLOCK_NAME = 'ROL';
const EXTRA_ROLE_CHECK_CODE = 'M-30173';
const EXTRA_ROLE_TOLERANCE = 1;
const ACCESSNET_WITHOUT_ADDRESS_CHECK_CODE = 'M-30001';
const ACCESSNET_MARK_LAYER_NAME = 'FMDB_ACCESSNET_NO_ADDRESS';
const ACCESSNET_MARK_COLOR = 1;
const ACCESSNET_MARK_RADIUS = 1.5;

const CUSTOMER_LAYER_COLORS = new Map([
  ['ANDE', 3],
  ['GL', 1],
  ['EG', 30],
  ['GV', 2],
  ['IHB', 3],
  ['KLDR', 3],
  ['MTK', 3],
  ['WNK', 3],
  ['RESV', 6],
  ['SMK', 3],
  ['SWON', 3]
]);

function normalizeText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value)
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/[\u00AD\u200B\u200C\u200D\u2060\uFEFF]/g, '')
    .trim();
  return text === '' ? null : text;
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

async function getFirstDwgPath(projectFolderPath) {
  if (!(await pathExists(projectFolderPath))) {
    return null;
  }

  const entries = await fsp.readdir(projectFolderPath, { withFileTypes: true });
  const dwgEntry = entries.find((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.dwg');
  return dwgEntry ? path.join(projectFolderPath, dwgEntry.name) : null;
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

async function getDatabase(projectFolderPath) {
  const dwgPath = await getFirstDwgPath(projectFolderPath);
  if (!dwgPath) {
    throw new Error('No se ha encontrado un DWG en la carpeta del proyecto.');
  }

  const rootDirectory = path.resolve(__dirname, '..', '..');
  const wasmDirectory = path.join(rootDirectory, 'node_modules', '@mlightcad', 'libredwg-web', 'wasm') + path.sep;

  if (!fs.existsSync(wasmDirectory)) {
    throw new Error('No se ha encontrado la carpeta WASM de libredwg.');
  }

  const database = await withSuppressedConsole(async () => {
    const libredwg = await LibreDwg.create(wasmDirectory);
    const fileContent = fs.readFileSync(dwgPath);
    const dwg = libredwg.dwg_read_data(fileContent, Dwg_File_Type.DWG);
    return libredwg.convert(dwg);
  });

  return {
    dwgPath,
    database
  };
}

function getEntityText(entity) {
  return normalizeText(entity?.text?.text ?? entity?.text);
}

function getEntityPoint(entity) {
  const point = entity?.startPoint ?? entity?.insertionPoint ?? entity?.point;
  if (!point) {
    return null;
  }

  return {
    x: Number(point.x ?? 0),
    y: Number(point.y ?? 0),
    z: Number(point.z ?? 0)
  };
}

function getInsertBlockName(entity) {
  return normalizeText(
    entity?.name
    ?? entity?.blockName
    ?? entity?.block
    ?? entity?.blockHeader?.name
    ?? entity?.block_header?.name
  );
}

function pointsMatchWithinTolerance(point, target, tolerance = EXTRA_ROLE_TOLERANCE) {
  if (!point || !target) {
    return false;
  }

  const dx = Math.abs(Number(point.x ?? 0) - Number(target.x ?? 0));
  const dy = Math.abs(Number(point.y ?? 0) - Number(target.y ?? 0));
  return dx <= tolerance && dy <= tolerance;
}

async function countRoleBlocksAtCoordinates(projectFolderPath, coordinates, tolerance = EXTRA_ROLE_TOLERANCE) {
  const { database } = await getDatabase(projectFolderPath);
  let count = 0;

  for (const entity of database.entities ?? []) {
    if (entity.type !== 'INSERT') {
      continue;
    }

    const blockName = getInsertBlockName(entity);
    if (!blockName || blockName.toUpperCase() !== EXTRA_ROLE_BLOCK_NAME) {
      continue;
    }

    const point = getEntityPoint(entity);
    if (!point) {
      continue;
    }

    if (coordinates.some((target) => pointsMatchWithinTolerance(point, target, tolerance))) {
      count++;
    }
  }

  return count;
}

async function extractCustomerTextCoordinates(projectFolderPath) {
  const dwgPath = await getFirstDwgPath(projectFolderPath);
  if (!dwgPath) {
    throw new Error('No se ha encontrado un DWG en la carpeta del proyecto.');
  }

  const openDocumentExtraction = await extractCustomerTextCoordinatesFromOpenDocument(dwgPath);
  if (openDocumentExtraction) {
    return openDocumentExtraction;
  }

  return extractCustomerTextCoordinatesFromFile(projectFolderPath);
}

async function extractCustomerTextCoordinatesFromFile(projectFolderPath) {
  const { dwgPath, database } = await getDatabase(projectFolderPath);
  const coordinates = [];

  for (const entity of database.entities ?? []) {
    if (entity.type === 'INSERT') {
      const label = getInsertBlockName(entity);
      const point = getEntityPoint(entity);

      if (label && point) {
        coordinates.push({
          label,
          layer: normalizeText(entity.layer),
          entityType: entity.type,
          x: point.x,
          y: point.y,
          z: point.z
        });
      }

      continue;
    }

    if (entity.type !== 'TEXT' && entity.type !== 'MTEXT') {
      continue;
    }

    const label = getEntityText(entity);
    const point = getEntityPoint(entity);

    if (!label || !point) {
      continue;
    }

    coordinates.push({
      label,
      layer: normalizeText(entity.layer),
      entityType: entity.type,
      x: point.x,
      y: point.y,
      z: point.z
    });
  }

  return {
    dwgPath,
    source: 'file',
    coordinateCount: coordinates.length,
    coordinates
  };
}

function buildPolylineCandidate(entity) {
  const vertices = Array.isArray(entity?.vertices) ? entity.vertices : [];
  if (vertices.length < 4) {
    return null;
  }

  const xs = vertices.map((vertex) => Number(vertex.x ?? 0));
  const ys = vertices.map((vertex) => Number(vertex.y ?? 0));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const area = Math.abs((maxX - minX) * (maxY - minY));

  if (area <= 0) {
    return null;
  }

  return {
    area,
    centerX: minX + ((maxX - minX) / 2),
    centerY: minY + ((maxY - minY) / 2),
    vertexCount: vertices.length,
    handle: normalizeText(entity.handle)
  };
}

async function extractOapCoordinate(projectFolderPath) {
  const { dwgPath, database } = await getDatabase(projectFolderPath);
  const candidates = [];

  for (const entity of database.entities ?? []) {
    if (entity.type !== 'LWPOLYLINE') {
      continue;
    }

    if (normalizeText(entity.layer)?.toUpperCase() !== 'OPMERKING') {
      continue;
    }

    const candidate = buildPolylineCandidate(entity);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  if (candidates.length === 0) {
    throw new Error('No se ha encontrado ningun rectangulo valido en la layer Opmerking.');
  }

  candidates.sort((left, right) => left.area - right.area);
  const selected = candidates[0];

  return {
    dwgPath,
    candidateCount: candidates.length,
    handle: selected.handle,
    x: selected.centerX,
    y: selected.centerY
  };
}

async function getAccoreConsoleCandidates() {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const autodeskRoot = path.join(programFiles, 'Autodesk');

  if (!(await pathExists(autodeskRoot))) {
    return [];
  }

  const entries = await fsp.readdir(autodeskRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^AutoCAD\s+\d{4}$/i.test(entry.name))
    .map((entry) => ({
      version: Number.parseInt(entry.name.replace(/[^\d]/g, ''), 10),
      executablePath: path.join(autodeskRoot, entry.name, 'accoreconsole.exe')
    }))
    .sort((left, right) => getAccoreConsolePriority(right.version) - getAccoreConsolePriority(left.version));
}

async function findAccoreConsolePath() {
  if (cachedAccoreConsolePath && await pathExists(cachedAccoreConsolePath)) {
    return cachedAccoreConsolePath;
  }

  const candidates = await getAccoreConsoleCandidates();

  for (const candidate of candidates) {
    if (!(await pathExists(candidate.executablePath))) {
      continue;
    }

    cachedAccoreConsolePath = candidate.executablePath;
    return cachedAccoreConsolePath;
  }

  return null;
}

function escapeLispString(value) {
  return String(value ?? '')
    .replace(/"/g, '\\"');
}

function toAutoLispPath(filePath) {
  return String(filePath ?? '').replace(/\\/g, '/');
}

function toLispStringList(values) {
  return `(${values.map((value) => `"${escapeLispString(value)}"`).join(' ')})`;
}

function sanitizeProcessOutput(value) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r/g, '')
    .trim();
}

function filterCustomerCoordinates(coordinates) {
  const allowedLayers = new Set([...CUSTOMER_LAYER_COLORS.keys()].map((layer) => layer.toUpperCase()));
  return coordinates.filter((item) => allowedLayers.has(normalizeText(item.layer)?.toUpperCase()));
}

function buildProgressHelpersLisp(progressFilePath) {
  return `
(setq fmdb-progress-file "${escapeLispString(toAutoLispPath(progressFilePath ?? ''))}")

(defun fmdb-append-progress-line (text / handle)
  (if (> (strlen fmdb-progress-file) 0)
    (progn
      (setq handle (open fmdb-progress-file "a"))
      (if handle
        (progn
          (write-line text handle)
          (close handle)
        )
      )
    )
  )
  text
)

(defun fmdb-report-stage (stage)
  (fmdb-append-progress-line (strcat "FMDB_STAGE:" stage))
)

(defun fmdb-report-progress (current total)
  (fmdb-append-progress-line (strcat "FMDB_PROGRESS:" (itoa current) "/" (itoa total)))
)

(defun fmdb-report-result (name value)
  (fmdb-append-progress-line (strcat "FMDB_RESULT:" name "=" value))
)

(defun fmdb-report-done (stage)
  (fmdb-append-progress-line (strcat "FMDB_DONE:" stage))
)
`;
}

function getAccoreConsolePriority(version) {
  if (version === 2019) {
    return 30000;
  }

  if (version >= 2020 && version <= 2024) {
    return 20000 + version;
  }

  if (version === 2025) {
    return 10000 + version;
  }

  return version;
}

function toLispData(items) {
  const lines = items.map((item) => {
    const label = escapeLispString(item.locationLabel);
    const layer = escapeLispString(item.kastnr ?? 'ANDE');
    return `  ("${label}" "${layer}" ${Number(item.x ?? 0)} ${Number(item.y ?? 0)})`;
  });

  return `(\n${lines.join('\n')}\n)\n`;
}

function buildDrawLisp(drawItems, { progressFilePath, progressStep }) {
  const embeddedItems = toLispData(drawItems);
  const layerCases = [...CUSTOMER_LAYER_COLORS.entries()]
    .map(([layer, color]) => `    ((= upperLayer "${layer}") ${color})`)
    .join('\n');

  const safeProgressStep = Math.max(1, Number(progressStep) || 1);

  return `(setq fmdb-items '${embeddedItems})
(setq fmdb-progress-step ${safeProgressStep})
${buildProgressHelpersLisp(progressFilePath)}

(defun fmdb-layer-color (layerName / upperLayer)
  (setq upperLayer (strcase layerName))
  (cond
${layerCases}
    (t 7)
  )
)

(defun fmdb-ensure-layer (layerName colorCode)
  (if (not (tblsearch "LAYER" layerName))
    (command "._-LAYER" "_Make" layerName "_Color" (itoa colorCode) layerName "")
    (command "._-LAYER" "_Color" (itoa colorCode) layerName "_On" layerName "")
  )
)

(defun fmdb-string-member (target items / found)
  (setq found nil)
  (while (and items (not found))
    (if (= target (car items))
      (setq found T)
      (setq items (cdr items))
    )
  )
  found
)

(defun fmdb-collect-layers (items / layers item layerName)
  (setq layers '())
  (foreach item items
    (setq layerName (strcase (nth 1 item)))
    (if (and layerName (not (fmdb-string-member layerName layers)))
      (setq layers (cons layerName layers))
    )
  )
  layers
)

(defun fmdb-delete-existing-on-layers (layerNames / selection index entity entityData entityLayer)
  (if (and layerNames (setq selection (ssget "_X" '((0 . "TEXT,MTEXT")))))
    (progn
      (setq index 0)
      (repeat (sslength selection)
        (setq entity (ssname selection index))
        (setq entityData (entget entity))
        (setq entityLayer (cdr (assoc 8 entityData)))

        (if (and entityLayer
                 (fmdb-string-member (strcase entityLayer) layerNames))
          (entdel entity)
        )

        (setq index (1+ index))
      )
    )
  )
)

(defun c:FIBER_DRAW_CUSTOMERS (/ items item label layerName x y colorCode layerNames total drawn)
  (setq items fmdb-items)
  (setq layerNames (fmdb-collect-layers items))
  (setq total (length items))
  (setq drawn 0)

  (fmdb-report-stage "layers")
  (foreach layerName layerNames
    (setq colorCode (fmdb-layer-color layerName))
    (fmdb-ensure-layer layerName colorCode)
  )

  (fmdb-report-stage "delete")
  (fmdb-delete-existing-on-layers layerNames)
  (fmdb-report-stage "draw")
  (if (> total 0)
    (fmdb-report-progress 0 total)
  )

  (foreach item items
    (setq label (nth 0 item))
    (setq layerName (strcase (nth 1 item)))
    (setq x (nth 2 item))
    (setq y (nth 3 item))

    (if (and label layerName (numberp x) (numberp y) (/= x 0.0) (/= y 0.0))
      (progn
        (setq colorCode (fmdb-layer-color layerName))
        (entmakex
          (list
            '(0 . "TEXT")
            (cons 8 layerName)
            (cons 10 (list x y 0.0))
            (cons 40 1.25)
            (cons 1 label)
            (cons 50 0.0)
          )
        )
        (setq drawn (1+ drawn))
        (if (or (= drawn total)
                (= (rem drawn fmdb-progress-step) 0))
          (fmdb-report-progress drawn total)
        )
      )
    )
  )
  (fmdb-report-done "DRAW")
  (princ)
)
`;
}

function buildExportCustomerCoordinatesLisp({ outputFilePath, progressFilePath }) {
  return `(setq fmdb-output-file "${escapeLispString(toAutoLispPath(outputFilePath))}")
${buildProgressHelpersLisp(progressFilePath)}

(defun fmdb-format-real (value)
  (rtos value 2 8)
)

(defun fmdb-write-coordinate (handle label layerName point / zValue)
  (if (and handle layerName label point)
    (progn
      (setq zValue (if (and point (caddr point)) (caddr point) 0.0))
      (write-line
        (strcat
          label
          (chr 9)
          (strcase layerName)
          (chr 9)
          (fmdb-format-real (car point))
          (chr 9)
          (fmdb-format-real (cadr point))
          (chr 9)
          (fmdb-format-real zValue)
        )
        handle
      )
      T
    )
    nil
  )
)

(defun fmdb-export-insert-attributes (handle insertEntity insertPoint insertLayer / nextEntity nextData exported label)
  (setq exported 0)
  (setq nextEntity (entnext insertEntity))
  (while nextEntity
    (setq nextData (entget nextEntity))
    (cond
      ((= (cdr (assoc 0 nextData)) "SEQEND")
        (setq nextEntity nil)
      )
      ((= (cdr (assoc 0 nextData)) "ATTRIB")
        (setq label (cdr (assoc 1 nextData)))
        (if (fmdb-write-coordinate handle label insertLayer insertPoint)
          (setq exported (1+ exported))
        )
        (setq nextEntity (entnext nextEntity))
      )
      (T
        (setq nextEntity (entnext nextEntity))
      )
    )
  )
  exported
)

(defun c:FIBER_EXPORT_CUSTOMER_COORDS (/ handle selection index entity entityData layerName label point exportedCount)
  (fmdb-report-stage "export")
  (setq exportedCount 0)
  (setq handle (open fmdb-output-file "w"))
  (if handle
    (progn
      (if (setq selection (ssget "_X" '((0 . "TEXT,MTEXT"))))
        (progn
          (setq index 0)
          (repeat (sslength selection)
            (setq entity (ssname selection index))
            (setq entityData (entget entity))
            (setq layerName (cdr (assoc 8 entityData)))
            (setq label (cdr (assoc 1 entityData)))
            (setq point (cdr (assoc 10 entityData)))

            (if (fmdb-write-coordinate handle label layerName point)
              (setq exportedCount (1+ exportedCount))
            )

            (setq index (1+ index))
          )
        )
      )
      (if (setq selection (ssget "_X" '((0 . "INSERT"))))
        (progn
          (setq index 0)
          (repeat (sslength selection)
            (setq entity (ssname selection index))
            (setq entityData (entget entity))
            (setq layerName (cdr (assoc 8 entityData)))
            (setq label (cdr (assoc 2 entityData)))
            (setq point (cdr (assoc 10 entityData)))

            (if (fmdb-write-coordinate handle label layerName point)
              (setq exportedCount (1+ exportedCount))
            )

            (if (= (cdr (assoc 66 entityData)) 1)
              (setq exportedCount (+ exportedCount (fmdb-export-insert-attributes handle entity point layerName)))
            )
            (setq index (1+ index))
          )
        )
      )
      (close handle)
    )
  )
  (fmdb-report-result "EXPORTED" (itoa exportedCount))
  (fmdb-report-done "EXPORT")
  (princ)
)
`;
}

function buildClearCustomerCoordinatesLisp({ progressFilePath }) {
  return `(setq fmdb-customer-layers '${toLispStringList([...CUSTOMER_LAYER_COLORS.keys()])})
${buildProgressHelpersLisp(progressFilePath)}

(defun fmdb-string-member (target items / found)
  (setq found nil)
  (while (and items (not found))
    (if (= target (car items))
      (setq found T)
      (setq items (cdr items))
    )
  )
  found
)

(defun fmdb-delete-existing-on-layers (layerNames / selection index entity entityData entityLayer deletedCount)
  (setq deletedCount 0)
  (if (and layerNames (setq selection (ssget "_X" '((0 . "TEXT,MTEXT")))))
    (progn
      (setq index 0)
      (repeat (sslength selection)
        (setq entity (ssname selection index))
        (setq entityData (entget entity))
        (setq entityLayer (cdr (assoc 8 entityData)))

        (if (and entityLayer
                 (fmdb-string-member (strcase entityLayer) layerNames))
          (progn
            (entdel entity)
            (setq deletedCount (1+ deletedCount))
          )
        )

        (setq index (1+ index))
      )
    )
  )
  deletedCount
)

(defun c:FIBER_CLEAR_CUSTOMER_COORDS (/ deletedCount)
  (fmdb-report-stage "delete")
  (setq deletedCount (fmdb-delete-existing-on-layers fmdb-customer-layers))
  (fmdb-report-result "DELETED" (itoa deletedCount))
  (fmdb-report-stage "purge")
  (command "_.-PURGE" "_All" "*" "_No")
  (fmdb-report-stage "audit")
  (command "_.AUDIT" "_Y")
  (fmdb-report-done "CLEAN")
  (princ)
)
`;
}

function buildRoleCoordinateLispData(items) {
  const lines = items.map((item) => `  (${Number(item.x ?? 0)} ${Number(item.y ?? 0)})`);
  return `(\n${lines.join('\n')}\n)\n`;
}

function buildRemoveExtraRolesLisp({ coordinates, progressFilePath, tolerance = EXTRA_ROLE_TOLERANCE }) {
  return `(setq fmdb-role-targets '${buildRoleCoordinateLispData(coordinates)})
(setq fmdb-role-name "${escapeLispString(EXTRA_ROLE_BLOCK_NAME)}")
(setq fmdb-role-tolerance ${Number(tolerance) || EXTRA_ROLE_TOLERANCE})
${buildProgressHelpersLisp(progressFilePath)}

(defun fmdb-abs (value)
  (if (< value 0.0) (- value) value)
)

(defun fmdb-point-matches-target (point target / dx dy)
  (if (and point target)
    (progn
      (setq dx (fmdb-abs (- (car point) (car target))))
      (setq dy (fmdb-abs (- (cadr point) (cadr target))))
      (and (<= dx fmdb-role-tolerance)
           (<= dy fmdb-role-tolerance))
    )
    nil
  )
)

(defun fmdb-point-in-targets (point targets / found)
  (setq found nil)
  (while (and targets (not found))
    (if (fmdb-point-matches-target point (car targets))
      (setq found T)
      (setq targets (cdr targets))
    )
  )
  found
)

(defun c:FIBER_REMOVE_EXTRA_ROLES (/ selection index entity entityData blockName point removedCount)
  (fmdb-report-stage "delete")
  (setq removedCount 0)
  (if (setq selection (ssget "_X" '((0 . "INSERT"))))
    (progn
      (setq index 0)
      (repeat (sslength selection)
        (setq entity (ssname selection index))
        (setq entityData (entget entity))
        (setq blockName (cdr (assoc 2 entityData)))
        (setq point (cdr (assoc 10 entityData)))

        (if (and blockName
                 point
                 (= (strcase blockName) (strcase fmdb-role-name))
                 (fmdb-point-in-targets point fmdb-role-targets))
          (progn
            (entdel entity)
            (setq removedCount (1+ removedCount))
          )
        )

        (setq index (1+ index))
      )
    )
  )
  (fmdb-report-result "DELETED" (itoa removedCount))
  (fmdb-report-stage "purge")
  (command "_.-PURGE" "_All" "*" "_No")
  (fmdb-report-stage "audit")
  (command "_.AUDIT" "_Y")
  (fmdb-report-done "REMOVE_EXTRA_ROLES")
  (princ)
)
`;
}

function buildDrawAccessnetWithoutAddressLisp({ coordinates, progressFilePath, radius = ACCESSNET_MARK_RADIUS }) {
  return `(setq fmdb-accessnet-targets '${buildRoleCoordinateLispData(coordinates)})
(setq fmdb-accessnet-layer "${escapeLispString(ACCESSNET_MARK_LAYER_NAME)}")
(setq fmdb-accessnet-radius ${Number(radius) || ACCESSNET_MARK_RADIUS})
${buildProgressHelpersLisp(progressFilePath)}

(defun fmdb-ensure-accessnet-layer ()
  (if (not (tblsearch "LAYER" fmdb-accessnet-layer))
    (command "._-LAYER" "_Make" fmdb-accessnet-layer "_Color" "${ACCESSNET_MARK_COLOR}" fmdb-accessnet-layer "")
    (command "._-LAYER" "_Color" "${ACCESSNET_MARK_COLOR}" fmdb-accessnet-layer "_On" fmdb-accessnet-layer "")
  )
)

(defun c:FIBER_DRAW_ACCESSNET_WITHOUT_ADDRESS (/ target drawnCount)
  (fmdb-report-stage "layers")
  (fmdb-ensure-accessnet-layer)
  (fmdb-report-stage "draw")
  (setq drawnCount 0)
  (foreach target fmdb-accessnet-targets
    (if (and target
             (numberp (car target))
             (numberp (cadr target)))
      (progn
        (entmakex
          (list
            '(0 . "CIRCLE")
            (cons 8 fmdb-accessnet-layer)
            (cons 10 (list (car target) (cadr target) 0.0))
            (cons 40 fmdb-accessnet-radius)
            '(62 . 1)
          )
        )
        (setq drawnCount (1+ drawnCount))
      )
    )
  )
  (fmdb-report-result "DRAWN" (itoa drawnCount))
  (fmdb-report-stage "purge")
  (command "_.-PURGE" "_All" "*" "_No")
  (fmdb-report-stage "audit")
  (command "_.AUDIT" "_Y")
  (fmdb-report-done "DRAW_ACCESSNET_WITHOUT_ADDRESS")
  (princ)
)
`;
}

function parseProgressLine(line) {
  const trimmed = normalizeText(line);
  if (!trimmed) {
    return null;
  }

  let match = trimmed.match(/^FMDB_PROGRESS:(\d+)\/(\d+)$/);
  if (match) {
    return {
      type: 'progress',
      current: Number(match[1]),
      total: Number(match[2])
    };
  }

  match = trimmed.match(/^FMDB_STAGE:([A-Za-z0-9_-]+)$/);
  if (match) {
    return {
      type: 'stage',
      stage: match[1]
    };
  }

  match = trimmed.match(/^FMDB_RESULT:([^=]+)=(.*)$/);
  if (match) {
    return {
      type: 'result',
      name: match[1],
      value: match[2]
    };
  }

  match = trimmed.match(/^FMDB_DONE:([A-Za-z0-9_-]+)$/);
  if (match) {
    return {
      type: 'done',
      stage: match[1]
    };
  }

  return null;
}

function startProgressMonitor(progressFilePath, handlers = {}) {
  if (!progressFilePath) {
    return {
      stop: async () => {}
    };
  }

  let processedLineCount = 0;
  let disposed = false;
  let reading = false;

  const tick = async (force = false) => {
    if ((!force && disposed) || reading || !(await pathExists(progressFilePath))) {
      return;
    }

    reading = true;

    try {
      const content = await fsp.readFile(progressFilePath, 'utf8');
      const lines = content
        .replace(/\r/g, '')
        .split('\n')
        .filter((line) => line !== '');
      const nextLines = lines.slice(processedLineCount);
      processedLineCount = lines.length;

      for (const line of nextLines) {
        const parsed = parseProgressLine(line);
        if (!parsed) {
          continue;
        }

        if (parsed.type === 'progress' && typeof handlers.onProgress === 'function') {
          handlers.onProgress({
            drawnCount: parsed.current,
            totalCount: parsed.total
          });
          continue;
        }

        if (parsed.type === 'stage' && typeof handlers.onStage === 'function') {
          handlers.onStage(parsed.stage);
          continue;
        }

        if (parsed.type === 'result' && typeof handlers.onResult === 'function') {
          handlers.onResult(parsed);
        }
      }
    }
    finally {
      reading = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, DWG_PROGRESS_POLL_MS);

  return {
    stop: async () => {
      clearInterval(timer);
      await tick(true);
      disposed = true;
    }
  };
}

async function runProcess(executablePath, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, {
      windowsHide: true,
      ...options
    });

    let stdout = '';
    let stderr = '';
    let timeoutHandle = null;
    let settled = false;

    const settleReject = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    const settleResolve = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(value);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      settleReject(error);
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (code === 0) {
        settleResolve({ stdout, stderr });
        return;
      }

      const details = [sanitizeProcessOutput(stdout), sanitizeProcessOutput(stderr)].filter(Boolean).join('\n');
      settleReject(new Error([`El proceso ha fallado con codigo ${code}.`, details].filter(Boolean).join('\n')));
    });

    if (options.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }

        const details = [sanitizeProcessOutput(stdout), sanitizeProcessOutput(stderr)].filter(Boolean).join('\n');
        child.kill();
        setTimeout(() => {
          if (child.exitCode === null) {
            spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
              windowsHide: true
            });
          }
        }, 1000);
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        settleReject(new Error([`Tiempo de espera agotado.`, details].filter(Boolean).join('\n')));
      }, options.timeoutMs);
    }
  });
}

async function removeFileIfExists(targetPath) {
  if (!targetPath) {
    return;
  }

  try {
    await fsp.unlink(targetPath);
  }
  catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function findCheckHtmlPath(projectFolderPath) {
  const queue = [path.resolve(projectFolderPath)];
  const candidates = [];

  while (queue.length > 0) {
    const currentFolder = queue.shift();
    const entries = await fsp.readdir(currentFolder, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentFolder, entry.name);

      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!/^checks?\.html?$/i.test(entry.name)) {
        continue;
      }

      const stats = await fsp.stat(fullPath);
      candidates.push({
        fullPath,
        modifiedTimeMs: stats.mtimeMs
      });
    }
  }

  candidates.sort((left, right) => right.modifiedTimeMs - left.modifiedTimeMs);
  return candidates[0]?.fullPath ?? null;
}

function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function parseExtraRoleCoordinatesFromCheckHtml(htmlText) {
  const normalizedText = decodeHtmlEntities(String(htmlText ?? ''))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/caption>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r/g, '');

  const coordinateRegex = new RegExp(
    String.raw`On the coordinate of the slack symbol[\s\S]*?\((-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\)\s*\(${EXTRA_ROLE_CHECK_CODE}\)`,
    'gi'
  );
  const coordinates = [];
  const seen = new Set();
  let match = coordinateRegex.exec(normalizedText);

  while (match) {
    const x = Number(match[1]);
    const y = Number(match[2]);

    if (Number.isFinite(x) && Number.isFinite(y)) {
      const key = `${x}|${y}`;
      if (!seen.has(key)) {
        seen.add(key);
        coordinates.push({ x, y });
      }
    }

    match = coordinateRegex.exec(normalizedText);
  }

  return coordinates;
}

function parseCoordinatesFromCheckHtmlByCode(htmlText, { checkCode, prefixPattern }) {
  const html = String(htmlText ?? '').replace(/\r/g, '');
  const tableRegex = /<TABLE\b[\s\S]*?<\/TABLE>/gi;
  const coordinateRegex = new RegExp(
    `${prefixPattern}\\s*\\((-?\\d+(?:\\.\\d+)?)\\s*,\\s*(-?\\d+(?:\\.\\d+)?)\\)`,
    'gi'
  );
  const coordinates = [];
  const seen = new Set();
  let tableMatch = tableRegex.exec(html);

  while (tableMatch) {
    const tableHtml = tableMatch[0];
    const tableText = decodeHtmlEntities(tableHtml)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/caption>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');

    if (tableText.includes(`(${checkCode})`)) {
      let coordinateMatch = coordinateRegex.exec(tableText);

      while (coordinateMatch) {
        const x = Number(coordinateMatch[1]);
        const y = Number(coordinateMatch[2]);

        if (Number.isFinite(x) && Number.isFinite(y)) {
          const key = `${x}|${y}`;
          if (!seen.has(key)) {
            seen.add(key);
            coordinates.push({ x, y });
          }
        }

        coordinateMatch = coordinateRegex.exec(tableText);
      }

      break;
    }

    tableMatch = tableRegex.exec(html);
  }

  return coordinates;
}

async function runPowerShellFile(scriptPath, scriptArgs, options = {}) {
  return runProcess('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    ...scriptArgs
  ], options);
}

function parsePowerShellJsonOutput(stdout) {
  const sanitized = sanitizeProcessOutput(stdout);
  if (!sanitized) {
    return null;
  }

  const lines = sanitized.split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

async function tryRunCommandOnOpenDocument({
  dwgPath,
  lispFilePath,
  commandName,
  progressFilePath,
  outputFilePath,
  timeoutMs,
  saveDocument = false
}) {
  const timeoutSeconds = Math.max(30, Math.ceil((timeoutMs ?? 60000) / 1000));
  const args = [
    '-Mode',
    'RunOpenDocumentCommand',
    '-DwgPath',
    dwgPath,
    '-LispPath',
    lispFilePath,
    '-CommandName',
    commandName,
    '-TimeoutSeconds',
    String(timeoutSeconds)
  ];

  if (progressFilePath) {
    args.push('-ProgressPath', progressFilePath);
  }

  if (outputFilePath) {
    args.push('-OutputPath', outputFilePath);
  }

  if (saveDocument) {
    args.push('-SaveDocument');
  }

  const result = await runPowerShellFile(autocadToolsScriptPath, args, {
    timeoutMs: (timeoutMs ?? 60000) + 15000
  });

  return parsePowerShellJsonOutput(result.stdout) ?? {
    handled: false,
    reason: 'NoHelperResult'
  };
}

async function tryPickPointOnOpenDocument({
  dwgPath,
  prompt,
  timeoutMs
}) {
  const timeoutSeconds = Math.max(30, Math.ceil((timeoutMs ?? 300000) / 1000));
  const result = await runPowerShellFile(autocadToolsScriptPath, [
    '-Mode',
    'PickPointOnOpenDocument',
    '-DwgPath',
    dwgPath,
    '-PromptText',
    String(prompt ?? '')
  ], {
    timeoutMs: (timeoutMs ?? 300000) + 15000
  });

  return parsePowerShellJsonOutput(result.stdout) ?? {
    handled: false,
    reason: 'NoHelperResult'
  };
}

async function extractCustomerTextCoordinatesFromOpenDocument(dwgPath) {
  const scriptToken = `${path.basename(dwgPath).replace(/[^A-Za-z0-9._-]+/g, '_')}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const lispFilePath = path.join(os.tmpdir(), `fiber-export-customers-${scriptToken}.lsp`);
  const progressFilePath = path.join(os.tmpdir(), `fiber-export-customers-${scriptToken}.progress`);
  const outputFilePath = path.join(os.tmpdir(), `fiber-export-customers-${scriptToken}.txt`);

  try {
    await removeFileIfExists(progressFilePath);
    await removeFileIfExists(outputFilePath);
    await fsp.writeFile(
      lispFilePath,
      buildExportCustomerCoordinatesLisp({
        outputFilePath,
        progressFilePath
      }),
      'utf8'
    );

    const openDocumentResult = await tryRunCommandOnOpenDocument({
      dwgPath,
      lispFilePath,
      commandName: EXPORT_COMMAND_NAME,
      progressFilePath,
      outputFilePath,
      timeoutMs: 60000,
      saveDocument: false
    });

    if (!openDocumentResult?.handled) {
      return null;
    }

    if (!(await pathExists(outputFilePath))) {
      throw new Error('AutoCAD no ha generado el fichero temporal de coordenadas del DWG abierto.');
    }

    const exportedText = await fsp.readFile(outputFilePath, 'utf8');
    const coordinates = exportedText
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => normalizeText(line))
      .filter(Boolean)
      .map((line) => {
        const [label, layer, x, y, z] = line.split('\t');
        return {
          label: normalizeText(label),
          layer: normalizeText(layer),
          entityType: 'TEXT',
          x: Number(x ?? 0),
          y: Number(y ?? 0),
          z: Number(z ?? 0)
        };
      })
      .filter((item) => item.label && item.layer && Number.isFinite(item.x) && Number.isFinite(item.y));

    return {
      dwgPath,
      source: 'open-document',
      coordinateCount: coordinates.length,
      coordinates
    };
  }
  finally {
    await removeFileIfExists(progressFilePath);
    await removeFileIfExists(outputFilePath);
    await removeFileIfExists(lispFilePath);
  }
}

async function pickPointFromOpenDocument(projectFolderPath, options = {}) {
  const dwgPath = await getFirstDwgPath(projectFolderPath);
  if (!dwgPath) {
    throw new Error('No se ha encontrado un DWG en la carpeta del proyecto.');
  }

  try {
    const openDocumentResult = await tryPickPointOnOpenDocument({
      dwgPath,
      prompt: normalizeText(options.prompt) ?? 'Selecciona ET del riser en AutoCAD',
      timeoutMs: 300000,
    });

    if (!openDocumentResult?.handled) {
      if (openDocumentResult?.reason === 'AutoCADNotRunning') {
        throw new Error('AutoCAD no esta abierto. Abre el DWG del proyecto antes de elegir el ET.');
      }

      if (openDocumentResult?.reason === 'DocumentNotOpen') {
        throw new Error('El DWG del proyecto no esta abierto en AutoCAD. Abre ese dibujo y vuelve a intentarlo.');
      }

      throw new Error('No se ha podido ejecutar la captura del ET sobre el DWG abierto.');
    }

    const x = Number(openDocumentResult.x);
    const y = Number(openDocumentResult.y);
    const z = Number(openDocumentResult.z ?? 0);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('La coordenada recibida desde AutoCAD no es valida.');
    }

    return {
      dwgPath,
      source: 'open-document',
      x,
      y,
      z: Number.isFinite(z) ? z : 0
    };
  }
  finally {
  }
}

async function runAccoreConsoleCommand({
  accoreConsolePath,
  dwgPath,
  lispFilePath,
  scriptFilePath,
  commandName,
  timeoutMs,
  saveDocument = true
}) {
  const scriptLines = [
    'FILEDIA 0',
    'CMDECHO 0',
    'SECURELOAD 0',
    `(load "${escapeLispString(toAutoLispPath(lispFilePath))}")`,
    commandName
  ];

  if (saveDocument) {
    scriptLines.push('FILEDIA 1');
    scriptLines.push('CMDECHO 1');
    scriptLines.push('_.QSAVE');
  }
  else {
    scriptLines.push('FILEDIA 1');
    scriptLines.push('CMDECHO 1');
  }

  scriptLines.push('_.QUIT');

  await fsp.writeFile(scriptFilePath, scriptLines.join('\r\n'), 'utf8');

  return runProcess(accoreConsolePath, [
    '/i',
    dwgPath,
    '/s',
    scriptFilePath
  ], {
    timeoutMs
  });
}

async function drawCustomerCoordinatesToDwg(projectFolderPath, drawItems, options = {}) {
  const dwgPath = await getFirstDwgPath(projectFolderPath);
  if (!dwgPath) {
    throw new Error('No se ha encontrado un DWG en la carpeta del proyecto.');
  }

  const filteredItems = drawItems.filter((item) => {
    const label = normalizeText(item.locationLabel);
    const layer = normalizeText(item.kastnr);
    return label && layer && Number(item.x ?? 0) !== 0 && Number(item.y ?? 0) !== 0;
  });

  if (filteredItems.length === 0) {
    throw new Error('No hay clientes con X/Y validos en el MDB para dibujar sobre el DWG.');
  }

  const projectToken = path.basename(path.resolve(projectFolderPath)).replace(/[^A-Za-z0-9._-]+/g, '_');
  const scriptToken = `${projectToken}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const timeoutMs = Math.max(90000, filteredItems.length * 150);
  const progressStep = Math.max(1, Math.ceil(filteredItems.length / 25));
  const lispFilePath = path.join(os.tmpdir(), `fiber-draw-customers-${scriptToken}.lsp`);
  const progressFilePath = path.join(os.tmpdir(), `fiber-draw-customers-${scriptToken}.progress`);
  const scriptFilePath = path.join(os.tmpdir(), `fiber-draw-customers-${scriptToken}.scr`);
  let accoreConsolePath = null;

  try {
    await removeFileIfExists(progressFilePath);
    await fsp.writeFile(lispFilePath, buildDrawLisp(filteredItems, { progressFilePath, progressStep }), 'utf8');

    let processResult = { stdout: '', stderr: '' };
    let timedOut = false;
    let usedOpenDocument = false;
    const progressMonitor = startProgressMonitor(progressFilePath, {
      onProgress: (progress) => {
        if (typeof options.onProgress === 'function') {
          options.onProgress(progress);
        }
      },
      onStage: (stage) => {
        if (typeof options.onStage === 'function') {
          options.onStage(stage);
        }
      }
    });

    try {
      const openDocumentResult = await tryRunCommandOnOpenDocument({
        dwgPath,
        lispFilePath,
        commandName: DRAW_COMMAND_NAME,
        progressFilePath,
        timeoutMs,
        saveDocument: true
      });

      if (openDocumentResult?.handled) {
        usedOpenDocument = true;
      }
      else {
        accoreConsolePath = await findAccoreConsolePath();
        if (!accoreConsolePath) {
          throw new Error('No se ha encontrado accoreconsole.exe. Hace falta una instalacion local de AutoCAD.');
        }

        processResult = await runAccoreConsoleCommand({
          accoreConsolePath,
          dwgPath,
          lispFilePath,
          scriptFilePath,
          commandName: DRAW_COMMAND_NAME,
          timeoutMs,
          saveDocument: true
        });
      }
    }
    catch (error) {
      if (/Tiempo de espera agotado/i.test(String(error?.message ?? ''))) {
        timedOut = true;
      }
      else {
        throw error;
      }
    }
    finally {
      await progressMonitor.stop();
    }

    const verification = await extractCustomerTextCoordinates(projectFolderPath);
    const hitCount = filterCustomerCoordinates(verification.coordinates).filter((item) =>
      filteredItems.some((row) => row.locationLabel === item.label)
    ).length;

    if (hitCount < filteredItems.length) {
      throw new Error(`AutoCAD no ha dejado todos los textos en el DWG. Se ha dejado el script listo en ${scriptFilePath}`);
    }

    return {
      dwgPath,
      accoreConsolePath,
      drawnCount: filteredItems.length,
      manualScriptPath: scriptFilePath,
      timeoutMs,
      timedOut,
      usedOpenDocument,
      stdout: processResult.stdout,
      stderr: processResult.stderr
    };
  }
  catch (error) {
    const rootMessage = String(error?.message ?? error).split('\n')[0];
    throw new Error(`No se ha podido completar el dibujo automatico. Se ha dejado el script listo en ${scriptFilePath}. ${rootMessage}`);
  }
  finally {
    await removeFileIfExists(progressFilePath);
  }
}

async function clearCustomerCoordinatesInDwg(projectFolderPath, options = {}) {
  const dwgPath = await getFirstDwgPath(projectFolderPath);
  if (!dwgPath) {
    throw new Error('No se ha encontrado un DWG en la carpeta del proyecto.');
  }

  const beforeExtraction = await extractCustomerTextCoordinates(projectFolderPath);
  const beforeCustomerCoordinates = filterCustomerCoordinates(beforeExtraction.coordinates);
  const projectToken = path.basename(path.resolve(projectFolderPath)).replace(/[^A-Za-z0-9._-]+/g, '_');
  const scriptToken = `${projectToken}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const timeoutMs = Math.max(90000, beforeCustomerCoordinates.length * 120);
  const lispFilePath = path.join(os.tmpdir(), `fiber-clear-customers-${scriptToken}.lsp`);
  const progressFilePath = path.join(os.tmpdir(), `fiber-clear-customers-${scriptToken}.progress`);
  const scriptFilePath = path.join(os.tmpdir(), `fiber-clear-customers-${scriptToken}.scr`);
  let accoreConsolePath = null;
  let deletedCount = beforeCustomerCoordinates.length;

  try {
    await removeFileIfExists(progressFilePath);
    await fsp.writeFile(lispFilePath, buildClearCustomerCoordinatesLisp({ progressFilePath }), 'utf8');

    let timedOut = false;
    let usedOpenDocument = false;
    const progressMonitor = startProgressMonitor(progressFilePath, {
      onStage: (stage) => {
        if (typeof options.onStage === 'function') {
          options.onStage(stage);
        }
      },
      onResult: (result) => {
        if (result.name === 'DELETED') {
          const parsedValue = Number(result.value);
          if (Number.isFinite(parsedValue)) {
            deletedCount = parsedValue;
          }
        }
      }
    });

    try {
      const openDocumentResult = await tryRunCommandOnOpenDocument({
        dwgPath,
        lispFilePath,
        commandName: CLEAN_COMMAND_NAME,
        progressFilePath,
        timeoutMs,
        saveDocument: true
      });

      if (openDocumentResult?.handled) {
        usedOpenDocument = true;
      }
      else {
        accoreConsolePath = await findAccoreConsolePath();
        if (!accoreConsolePath) {
          throw new Error('No se ha encontrado accoreconsole.exe. Hace falta una instalacion local de AutoCAD.');
        }

        await runAccoreConsoleCommand({
          accoreConsolePath,
          dwgPath,
          lispFilePath,
          scriptFilePath,
          commandName: CLEAN_COMMAND_NAME,
          timeoutMs,
          saveDocument: true
        });
      }
    }
    catch (error) {
      if (/Tiempo de espera agotado/i.test(String(error?.message ?? ''))) {
        timedOut = true;
      }
      else {
        throw error;
      }
    }
    finally {
      await progressMonitor.stop();
    }

    const afterExtraction = await extractCustomerTextCoordinates(projectFolderPath);
    const remainingCustomerCoordinates = filterCustomerCoordinates(afterExtraction.coordinates);
    if (remainingCustomerCoordinates.length > 0) {
      throw new Error(`Todavia quedan ${remainingCustomerCoordinates.length} etiquetas de clientes en el DWG. Se ha dejado el script listo en ${scriptFilePath}`);
    }

    return {
      dwgPath,
      accoreConsolePath,
      removedCount: deletedCount,
      remainingCount: 0,
      manualScriptPath: scriptFilePath,
      timeoutMs,
      timedOut,
      usedOpenDocument
    };
  }
  catch (error) {
    const rootMessage = String(error?.message ?? error).split('\n')[0];
    throw new Error(`No se ha podido limpiar el DWG. Se ha dejado el script listo en ${scriptFilePath}. ${rootMessage}`);
  }
  finally {
    await removeFileIfExists(progressFilePath);
  }
}

async function removeExtraRolesFromCheck(projectFolderPath, options = {}) {
  if (typeof options.onStage === 'function') {
    options.onStage('locate');
  }

  const checkPath = await findCheckHtmlPath(projectFolderPath);
  if (!checkPath) {
    throw new Error('No se ha encontrado ningun Checks.htm dentro de la carpeta del proyecto.');
  }

  if (typeof options.onStage === 'function') {
    options.onStage('parse');
  }

  const htmlText = await fsp.readFile(checkPath, 'utf8');
  const coordinates = parseExtraRoleCoordinatesFromCheckHtml(htmlText);
  if (coordinates.length === 0) {
    throw new Error(`No se han encontrado coordenadas del error ${EXTRA_ROLE_CHECK_CODE} en ${checkPath}.`);
  }

  const dwgPath = await getFirstDwgPath(projectFolderPath);
  if (!dwgPath) {
    throw new Error('No se ha encontrado un DWG en la carpeta del proyecto.');
  }

  const projectToken = path.basename(path.resolve(projectFolderPath)).replace(/[^A-Za-z0-9._-]+/g, '_');
  const scriptToken = `${projectToken}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const timeoutMs = Math.max(90000, coordinates.length * 250);
  const lispFilePath = path.join(os.tmpdir(), `fiber-remove-extra-roles-${scriptToken}.lsp`);
  const progressFilePath = path.join(os.tmpdir(), `fiber-remove-extra-roles-${scriptToken}.progress`);
  const scriptFilePath = path.join(os.tmpdir(), `fiber-remove-extra-roles-${scriptToken}.scr`);
  let accoreConsolePath = null;
  let removedCount = 0;
  let initialRoleCount = 0;

  try {
    initialRoleCount = await countRoleBlocksAtCoordinates(projectFolderPath, coordinates, EXTRA_ROLE_TOLERANCE);
    await removeFileIfExists(progressFilePath);
    await fsp.writeFile(
      lispFilePath,
      buildRemoveExtraRolesLisp({ coordinates, progressFilePath, tolerance: EXTRA_ROLE_TOLERANCE }),
      'utf8'
    );

    let timedOut = false;
    let usedOpenDocument = false;
    const progressMonitor = startProgressMonitor(progressFilePath, {
      onStage: (stage) => {
        if (typeof options.onStage === 'function') {
          options.onStage(stage);
        }
      },
      onResult: (result) => {
        if (result.name === 'DELETED') {
          const parsedValue = Number(result.value);
          if (Number.isFinite(parsedValue)) {
            removedCount = parsedValue;
          }
        }
      }
    });

    try {
      const openDocumentResult = await tryRunCommandOnOpenDocument({
        dwgPath,
        lispFilePath,
        commandName: REMOVE_EXTRA_ROLES_COMMAND_NAME,
        progressFilePath,
        timeoutMs,
        saveDocument: true
      });

      if (openDocumentResult?.handled) {
        usedOpenDocument = true;
      }
      else {
        accoreConsolePath = await findAccoreConsolePath();
        if (!accoreConsolePath) {
          throw new Error('No se ha encontrado accoreconsole.exe. Hace falta una instalacion local de AutoCAD.');
        }

        await runAccoreConsoleCommand({
          accoreConsolePath,
          dwgPath,
          lispFilePath,
          scriptFilePath,
          commandName: REMOVE_EXTRA_ROLES_COMMAND_NAME,
          timeoutMs,
          saveDocument: true
        });
      }
    }
    catch (error) {
      if (/Tiempo de espera agotado/i.test(String(error?.message ?? ''))) {
        timedOut = true;
      }
      else {
        throw error;
      }
    }
    finally {
      await progressMonitor.stop();
    }

    const remainingRoleCount = await countRoleBlocksAtCoordinates(projectFolderPath, coordinates, EXTRA_ROLE_TOLERANCE);
    if (removedCount <= 0 && remainingRoleCount < initialRoleCount) {
      removedCount = Math.max(0, initialRoleCount - remainingRoleCount);
    }

    if (remainingRoleCount > 0) {
      throw new Error(`No se ha eliminado ningun bloque ${EXTRA_ROLE_BLOCK_NAME}. Revisa si el nombre del bloque coincide exactamente en el DWG.`);
    }

    return {
      checkPath,
      dwgPath,
      accoreConsolePath,
      coordinateCount: coordinates.length,
      initialRoleCount,
      remainingRoleCount,
      removedCount,
      manualScriptPath: scriptFilePath,
      timeoutMs,
      timedOut,
      usedOpenDocument
    };
  }
  catch (error) {
    const rootMessage = String(error?.message ?? error).split('\n')[0];
    throw new Error(`No se ha podido completar la contingencia de roles extra. Se ha dejado el script listo en ${scriptFilePath}. ${rootMessage}`);
  }
  finally {
    await removeFileIfExists(progressFilePath);
  }
}

async function drawAccessnetWithoutAddressFromCheck(projectFolderPath, options = {}) {
  if (typeof options.onStage === 'function') {
    options.onStage('locate');
  }

  const checkPath = await findCheckHtmlPath(projectFolderPath);
  if (!checkPath) {
    throw new Error('No se ha encontrado ningun Checks.htm dentro de la carpeta del proyecto.');
  }

  if (typeof options.onStage === 'function') {
    options.onStage('parse');
  }

  const htmlText = await fsp.readFile(checkPath, 'utf8');
  const coordinates = parseCoordinatesFromCheckHtmlByCode(htmlText, {
    checkCode: ACCESSNET_WITHOUT_ADDRESS_CHECK_CODE,
    prefixPattern: String.raw`Coordinate endpoint:`
  });

  if (coordinates.length === 0) {
    throw new Error(`No se han encontrado coordenadas del error ${ACCESSNET_WITHOUT_ADDRESS_CHECK_CODE} en ${checkPath}.`);
  }

  const dwgPath = await getFirstDwgPath(projectFolderPath);
  if (!dwgPath) {
    throw new Error('No se ha encontrado un DWG en la carpeta del proyecto.');
  }

  const projectToken = path.basename(path.resolve(projectFolderPath)).replace(/[^A-Za-z0-9._-]+/g, '_');
  const scriptToken = `${projectToken}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const timeoutMs = Math.max(90000, coordinates.length * 200);
  const lispFilePath = path.join(os.tmpdir(), `fiber-draw-accessnet-without-address-${scriptToken}.lsp`);
  const progressFilePath = path.join(os.tmpdir(), `fiber-draw-accessnet-without-address-${scriptToken}.progress`);
  const scriptFilePath = path.join(os.tmpdir(), `fiber-draw-accessnet-without-address-${scriptToken}.scr`);
  let accoreConsolePath = null;
  let drawnCount = 0;

  try {
    await removeFileIfExists(progressFilePath);
    await fsp.writeFile(
      lispFilePath,
      buildDrawAccessnetWithoutAddressLisp({ coordinates, progressFilePath }),
      'utf8'
    );

    let timedOut = false;
    let usedOpenDocument = false;
    const progressMonitor = startProgressMonitor(progressFilePath, {
      onStage: (stage) => {
        if (typeof options.onStage === 'function') {
          options.onStage(stage);
        }
      },
      onResult: (result) => {
        if (result.name === 'DRAWN') {
          const parsedValue = Number(result.value);
          if (Number.isFinite(parsedValue)) {
            drawnCount = parsedValue;
          }
        }
      }
    });

    try {
      const openDocumentResult = await tryRunCommandOnOpenDocument({
        dwgPath,
        lispFilePath,
        commandName: DRAW_ACCESSNET_WITHOUT_ADDRESS_COMMAND_NAME,
        progressFilePath,
        timeoutMs,
        saveDocument: true
      });

      if (openDocumentResult?.handled) {
        usedOpenDocument = true;
      }
      else {
        accoreConsolePath = await findAccoreConsolePath();
        if (!accoreConsolePath) {
          throw new Error('No se ha encontrado accoreconsole.exe. Hace falta una instalacion local de AutoCAD.');
        }

        await runAccoreConsoleCommand({
          accoreConsolePath,
          dwgPath,
          lispFilePath,
          scriptFilePath,
          commandName: DRAW_ACCESSNET_WITHOUT_ADDRESS_COMMAND_NAME,
          timeoutMs,
          saveDocument: true
        });
      }
    }
    catch (error) {
      if (/Tiempo de espera agotado/i.test(String(error?.message ?? ''))) {
        timedOut = true;
      }
      else {
        throw error;
      }
    }
    finally {
      await progressMonitor.stop();
    }

    if (drawnCount <= 0) {
      throw new Error('No se ha dibujado ningun circulo de contingencia en el DWG.');
    }

    return {
      checkPath,
      dwgPath,
      accoreConsolePath,
      coordinateCount: coordinates.length,
      drawnCount,
      manualScriptPath: scriptFilePath,
      timeoutMs,
      timedOut,
      usedOpenDocument
    };
  }
  catch (error) {
    const rootMessage = String(error?.message ?? error).split('\n')[0];
    throw new Error(`No se ha podido completar la contingencia de accessnet sin direccion. Se ha dejado el script listo en ${scriptFilePath}. ${rootMessage}`);
  }
  finally {
    await removeFileIfExists(progressFilePath);
  }
}

module.exports = {
  CUSTOMER_LAYER_COLORS,
  drawAccessnetWithoutAddressFromCheck,
  clearCustomerCoordinatesInDwg,
  drawCustomerCoordinatesToDwg,
  extractCustomerTextCoordinates,
  extractOapCoordinate,
  getFirstDwgPath,
  pickPointFromOpenDocument,
  removeExtraRolesFromCheck
};
