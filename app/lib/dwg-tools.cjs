const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { Dwg_File_Type, LibreDwg } = require('@mlightcad/libredwg-web');
const {
  DEFAULT_PHKT_PLACEMENT_CONFIG,
  buildPlacementModel
} = require('./phkt-placement-domain.cjs');
const {
  buildExtractionLisp: buildPhktExtractionLisp,
  buildReviewLisp: buildPhktReviewLisp,
  parseExtraction: parsePhktExtraction,
  parseReviewResult: parsePhktReviewResult
} = require('./phkt-placement-tool.cjs');
let cachedAccoreConsolePath = null;
const appRoot = path.resolve(__dirname, '..');
const autocadToolsScriptPath = path.join(appRoot, 'autocad_tools.ps1');
const DWG_PROGRESS_POLL_MS = 400;
const DRAW_COMMAND_NAME = 'FIBER_DRAW_CUSTOMERS';
const EXPORT_COMMAND_NAME = 'FIBER_EXPORT_CUSTOMER_COORDS';
const CLEAN_COMMAND_NAME = 'FIBER_CLEAR_CUSTOMER_COORDS';
const REMOVE_EXTRA_ROLES_COMMAND_NAME = 'FIBER_REMOVE_EXTRA_ROLES';
const DRAW_ACCESSNET_WITHOUT_ADDRESS_COMMAND_NAME = 'FIBER_DRAW_ACCESSNET_WITHOUT_ADDRESS';
const EXPORT_BORING_REFERENCES_COMMAND_NAME = 'FIBER_EXPORT_BORING_REFERENCES';
const APPLY_BORING_RENAMES_COMMAND_NAME = 'FIBER_APPLY_BORING_RENAMES';
const EXTRACT_PHKT_PLACEMENT_COMMAND_NAME = 'FIBER_EXTRACT_PHKT_PLACEMENT';
const REVIEW_PHKT_PLACEMENT_COMMAND_NAME = 'FIBER_REVIEW_PHKT_PLACEMENT';
const EXTRA_ROLE_BLOCK_NAME = 'ROL';
const EXTRA_ROLE_CHECK_CODE = 'M-30173';
const EXTRA_ROLE_TOLERANCE = 1;
const ACCESSNET_WITHOUT_ADDRESS_CHECK_CODE = 'M-30001';
const ACCESSNET_MARK_LAYER_NAME = 'FMDB_ACCESSNET_NO_ADDRESS';
const ACCESSNET_MARK_COLOR = 1;
const ACCESSNET_MARK_RADIUS = 1.5;
const ROUTING_PROBLEM_SECTION_PATTERN = /routing\s+problem/i;
const ROUTING_NO_NETWORK_MESSAGE_PATTERN = /no\s+network\s+connection\s+found\s+within\s+0\s*[,\.]\s*1\s*m\s+from\s+the\s+point/i;

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
  ['SWON', 3],
  ['XXXX', 30]
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
  const dwgEntries = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.dwg')
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
  const expectedName = `${path.basename(path.resolve(projectFolderPath))}.dwg`;
  const dwgEntry = dwgEntries.find((entry) => entry.name.toLowerCase() === expectedName.toLowerCase())
    ?? dwgEntries[0];
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

function toBoringRenameLispData(items) {
  const lines = items.map((item) => {
    const handle = escapeLispString(item.handle);
    const newText = escapeLispString(item.newText);
    return `  ("${handle}" "${newText}")`;
  });

  return `(\n${lines.join('\n')}\n)\n`;
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
(vl-load-com)

(defun fmdb-format-real (value)
  (rtos value 2 8)
)

(defun fmdb-write-coordinate (handle label layerName point sourceType / zValue)
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
          (chr 9)
          sourceType
        )
        handle
      )
      T
    )
    nil
  )
)

(defun fmdb-export-attribute-array (handle attributes insertPoint insertLayer / exported attributeList attribute label)
  (setq exported 0)
  (if (and attributes (not (vl-catch-all-error-p attributes)))
    (progn
      (setq attributeList (vl-catch-all-apply 'vlax-safearray->list (list (vlax-variant-value attributes))))
      (if (not (vl-catch-all-error-p attributeList))
        (foreach attribute attributeList
          (setq label (vla-get-TextString attribute))
          (if (fmdb-write-coordinate handle label insertLayer insertPoint "ATTRIB")
            (setq exported (1+ exported))
          )
        )
      )
    )
  )
  exported
)

(defun fmdb-export-insert-com-attributes (handle insertEntity insertPoint insertLayer / exported object attributes constantAttributes)
  (setq exported 0)
  (setq object (vlax-ename->vla-object insertEntity))
  (if object
    (progn
      (setq attributes (vl-catch-all-apply 'vla-GetAttributes (list object)))
      (if (not (vl-catch-all-error-p attributes))
        (setq exported (+ exported (fmdb-export-attribute-array handle attributes insertPoint insertLayer)))
      )
      (setq constantAttributes (vl-catch-all-apply 'vla-GetConstantAttributes (list object)))
      (if (not (vl-catch-all-error-p constantAttributes))
        (setq exported (+ exported (fmdb-export-attribute-array handle constantAttributes insertPoint insertLayer)))
      )
    )
  )
  exported
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
        (if (fmdb-write-coordinate handle label insertLayer insertPoint "ATTRIB")
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

(defun c:FIBER_EXPORT_CUSTOMER_COORDS (/ handle selection index entity entityData layerName label point exportedCount blockObject effectiveName)
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

            (if (fmdb-write-coordinate handle label layerName point "TEXT")
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
            (setq blockObject (vlax-ename->vla-object entity))
            (setq effectiveName (if blockObject (vl-catch-all-apply 'vla-get-EffectiveName (list blockObject)) nil))
            (if (and effectiveName (not (vl-catch-all-error-p effectiveName)))
              (setq label effectiveName)
            )

            (if (fmdb-write-coordinate handle label layerName point "INSERT")
              (setq exportedCount (1+ exportedCount))
            )

            (if (= (cdr (assoc 66 entityData)) 1)
              (setq exportedCount (+ exportedCount (fmdb-export-insert-attributes handle entity point layerName)))
            )
            (setq exportedCount (+ exportedCount (fmdb-export-insert-com-attributes handle entity point layerName)))
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

function buildExportBoringReferencesLisp({ outputFilePath, progressFilePath }) {
  return `(setq fmdb-output-file "${escapeLispString(toAutoLispPath(outputFilePath))}")
${buildProgressHelpersLisp(progressFilePath)}
(vl-load-com)

(defun fmdb-string-has (haystack needle)
  (and haystack needle (wcmatch (strcase haystack) (strcat "*" (strcase needle) "*")))
)

(defun fmdb-format-real (value)
  (rtos value 2 8)
)

(defun fmdb-point-to-list (value / variant safearray)
  (cond
    ((= (type value) 'LIST) value)
    ((= (type value) 'VARIANT)
      (setq variant (vlax-variant-value value))
      (if (= (type variant) 'SAFEARRAY)
        (vlax-safearray->list variant)
        nil
      )
    )
    ((= (type value) 'SAFEARRAY) (vlax-safearray->list value))
    (t nil)
  )
)

(defun fmdb-get-text (object / value)
  (setq value nil)
  (if (vlax-property-available-p object 'TextString)
    (setq value (vl-catch-all-apply 'vlax-get (list object 'TextString)))
  )
  (if (vl-catch-all-error-p value)
    nil
    value
  )
)

(defun fmdb-get-point (object / value point minimumPoint maximumPoint minimumList maximumList)
  (setq point nil)
  (foreach property '(TextLocation InsertionPoint TextAlignmentPoint)
    (if (and (not point) (vlax-property-available-p object property))
      (progn
        (setq value (vl-catch-all-apply 'vlax-get (list object property)))
        (if (not (vl-catch-all-error-p value))
          (setq point (fmdb-point-to-list value))
        )
      )
    )
  )
  (if (not point)
    (progn
      (vla-GetBoundingBox object 'minimumPoint 'maximumPoint)
      (setq minimumList (fmdb-point-to-list minimumPoint))
      (setq maximumList (fmdb-point-to-list maximumPoint))
      (if (and minimumList maximumList)
        (setq point
          (list
            (/ (+ (car minimumList) (car maximumList)) 2.0)
            (/ (+ (cadr minimumList) (cadr maximumList)) 2.0)
            (/ (+ (caddr minimumList) (caddr maximumList)) 2.0)
          )
        )
      )
    )
  )
  point
)

(defun fmdb-reset-output-file (/ handle)
  (setq handle (open fmdb-output-file "w"))
  (if handle
    (progn
      (close handle)
      T
    )
    nil
  )
)

(defun fmdb-write-output-line (text / handle)
  (setq handle (open fmdb-output-file "a"))
  (if handle
    (progn
      (write-line text handle)
      (close handle)
      T
    )
    nil
  )
)

(defun fmdb-boring-reference-p (text)
  (and text
       (or
         (fmdb-string-has text ".DWG")
         (fmdb-string-has text " DWG")
         (fmdb-string-has text "BORING")
       )
  )
)

(defun c:FIBER_EXPORT_BORING_REFERENCES (/ document modelspace handle object objectName text point x y z total)
  (setq document (vla-get-ActiveDocument (vlax-get-acad-object)))
  (setq modelspace (vla-get-ModelSpace document))
  (setq total 0)
  (fmdb-report-stage "scan")
  (if (fmdb-reset-output-file)
    (progn
      (vlax-for object modelspace
        (setq objectName (vla-get-ObjectName object))
        (if (member objectName '("AcDbMLeader" "AcDbMText" "AcDbText"))
          (progn
            (setq text (fmdb-get-text object))
            (setq point (fmdb-get-point object))
            (if (and (fmdb-boring-reference-p text) point)
              (progn
                (setq handle (vla-get-Handle object))
                (setq x (if (car point) (car point) 0.0))
                (setq y (if (cadr point) (cadr point) 0.0))
                (setq z (if (caddr point) (caddr point) 0.0))
                (fmdb-write-output-line
                  (strcat handle (chr 9) text (chr 9) (fmdb-format-real x) (chr 9) (fmdb-format-real y) (chr 9) (fmdb-format-real z) (chr 9) objectName)
                )
                (setq total (1+ total))
              )
            )
          )
        )
      )
    )
    (fmdb-report-result "ERROR" "No se ha podido abrir el fichero de salida de boringen")
  )
  (fmdb-report-result "FOUND" (itoa total))
  (fmdb-report-done "EXPORT_BORING_REFERENCES")
  (princ)
)
`;
}

function buildApplyBoringRenamesLisp({ renameItems, progressFilePath }) {
  const embeddedItems = toBoringRenameLispData(renameItems);
  return `(setq fmdb-boring-renames '${embeddedItems})
${buildProgressHelpersLisp(progressFilePath)}
(vl-load-com)

(defun fmdb-set-text (object value / result)
  (setq result nil)
  (if (vlax-property-available-p object 'TextString)
    (progn
      (setq result (vl-catch-all-apply 'vlax-put (list object 'TextString value)))
      (not (vl-catch-all-error-p result))
    )
    nil
  )
)

(defun c:FIBER_APPLY_BORING_RENAMES (/ document modelspace item targetHandle newText object updated total)
  (setq document (vla-get-ActiveDocument (vlax-get-acad-object)))
  (setq modelspace (vla-get-ModelSpace document))
  (setq updated 0)
  (setq total (length fmdb-boring-renames))
  (fmdb-report-stage "update")
  (if (> total 0)
    (fmdb-report-progress 0 total)
  )
  (foreach item fmdb-boring-renames
    (setq targetHandle (strcase (nth 0 item)))
    (setq newText (nth 1 item))
    (vlax-for object modelspace
      (if (= (strcase (vla-get-Handle object)) targetHandle)
        (if (fmdb-set-text object newText)
          (setq updated (1+ updated))
        )
      )
    )
    (fmdb-report-progress updated total)
  )
  (fmdb-report-result "UPDATED" (itoa updated))
  (fmdb-report-done "APPLY_BORING_RENAMES")
  (princ)
)
`;
}

function buildClearCustomerCoordinatesLisp({ progressFilePath, purge = true }) {
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
  ${purge ? '(fmdb-report-stage "purge")\n  (command "_.-PURGE" "_All" "*" "_No")' : ';; Partial Delivery: conservar layers y omitir PURGE ALL'}
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

function getProjectLabel(projectFolderPath) {
  const resolved = path.resolve(String(projectFolderPath ?? '').trim());
  const folderName = path.basename(resolved);
  const match = /^(?<project>.+)-B\d+$/i.exec(folderName);
  return normalizeText(match?.groups?.project) ?? folderName;
}

function normalizeBoringReference(value) {
  const text = normalizeText(value);
  if (!text) {
    return null;
  }

  return text
    .replace(/\.dwg\b/gi, '')
    .replace(/\bdwg\b/gi, '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase()
    || null;
}

function sortBoringReference(left, right) {
  const xDelta = Number(left.x ?? 0) - Number(right.x ?? 0);
  if (Math.abs(xDelta) > 0.000001) {
    return xDelta;
  }

  const yDelta = Number(left.y ?? 0) - Number(right.y ?? 0);
  if (Math.abs(yDelta) > 0.000001) {
    return yDelta;
  }

  return String(left.text ?? '').localeCompare(String(right.text ?? ''));
}

async function getBoringDwgFiles(projectFolderPath) {
  const boringFolderPath = path.join(projectFolderPath, 'Boringen');
  if (!(await pathExists(boringFolderPath))) {
    throw new Error(`No se ha encontrado la carpeta Boringen en ${projectFolderPath}.`);
  }

  const entries = await fsp.readdir(boringFolderPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.dwg')
    .map((entry) => {
      const fullPath = path.join(boringFolderPath, entry.name);
      return {
        name: entry.name,
        fullPath,
        matchKey: normalizeBoringReference(path.basename(entry.name, path.extname(entry.name)))
      };
    });
}

function parseBoringReferenceExport(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .map((line) => {
      const [handle, rawText, x, y, z, entityType] = line.split('\t');
      return {
        handle: normalizeText(handle),
        text: normalizeText(rawText),
        matchKey: normalizeBoringReference(rawText),
        x: Number(x ?? 0),
        y: Number(y ?? 0),
        z: Number(z ?? 0),
        entityType: normalizeText(entityType)
      };
    })
    .filter((item) => item.handle && item.text && item.matchKey && Number.isFinite(item.x) && Number.isFinite(item.y));
}

async function extractBoringReferencesFromDwg(projectFolderPath, options = {}) {
  const dwgPath = await getFirstDwgPath(projectFolderPath);
  if (!dwgPath) {
    throw new Error('No se ha encontrado un DWG en la carpeta del proyecto.');
  }

  const projectToken = path.basename(path.resolve(projectFolderPath)).replace(/[^A-Za-z0-9._-]+/g, '_');
  const scriptToken = `${projectToken}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const lispFilePath = path.join(os.tmpdir(), `fiber-export-borings-${scriptToken}.lsp`);
  const progressFilePath = path.join(os.tmpdir(), `fiber-export-borings-${scriptToken}.progress`);
  const outputFilePath = path.join(projectFolderPath, `.fiber-export-borings-${scriptToken}.txt`);
  const scriptFilePath = path.join(os.tmpdir(), `fiber-export-borings-${scriptToken}.scr`);
  const timeoutMs = 90000;
  let usedOpenDocument = false;
  let accoreConsolePath = null;
  let completed = false;

  try {
    await removeFileIfExists(progressFilePath);
    await removeFileIfExists(outputFilePath);
    await fsp.writeFile(
      lispFilePath,
      buildExportBoringReferencesLisp({ outputFilePath, progressFilePath }),
      'utf8'
    );

    if (typeof options.onStage === 'function') {
      options.onStage('scan');
    }

    const openDocumentResult = await tryRunCommandOnOpenDocument({
      dwgPath,
      lispFilePath,
      commandName: EXPORT_BORING_REFERENCES_COMMAND_NAME,
      progressFilePath,
      outputFilePath,
      timeoutMs,
      saveDocument: false
    });

    if (openDocumentResult?.handled) {
      usedOpenDocument = true;
    }
    else {
      accoreConsolePath = await findAccoreConsolePath();
      if (!accoreConsolePath) {
        throw new Error('No se ha encontrado accoreconsole.exe. Hace falta AutoCAD abierto o una instalacion local de AutoCAD.');
      }

      await runAccoreConsoleCommand({
        accoreConsolePath,
        dwgPath,
        lispFilePath,
        scriptFilePath,
        commandName: EXPORT_BORING_REFERENCES_COMMAND_NAME,
        timeoutMs,
        saveDocument: false
      });
    }

    if (!(await pathExists(outputFilePath))) {
      const progressText = await fsp.readFile(progressFilePath, 'utf8').catch(() => '');
      const suffix = progressText ? ` Ultimo progreso de AutoCAD: ${progressText.replace(/\s+/g, ' ').trim()}` : '';
      throw new Error(
        `AutoCAD no ha generado el fichero temporal de referencias de Boringen.${suffix} `
        + `DWG analizado: ${dwgPath}. Diagnostico conservado en ${lispFilePath}.`
      );
    }

    const references = parseBoringReferenceExport(await fsp.readFile(outputFilePath, 'utf8'));
    completed = true;
    return {
      dwgPath,
      usedOpenDocument,
      accoreConsolePath,
      references
    };
  }
  finally {
    if (completed) {
      await removeFileIfExists(progressFilePath);
      await removeFileIfExists(outputFilePath);
      await removeFileIfExists(lispFilePath);
    }
  }
}

function buildBoringRenamePlan({ projectLabel, references, boringFiles }) {
  const filesByKey = new Map();
  const duplicateFileKeys = new Set();

  for (const file of boringFiles) {
    if (!file.matchKey) {
      continue;
    }

    if (filesByKey.has(file.matchKey)) {
      duplicateFileKeys.add(file.matchKey);
      continue;
    }

    filesByKey.set(file.matchKey, file);
  }

  if (duplicateFileKeys.size > 0) {
    throw new Error(`Hay DWG de Boringen con nombres ambiguos o duplicados: ${[...duplicateFileKeys].join(', ')}.`);
  }

  const usedFileKeys = new Set();
  const matched = [];
  const unmatchedReferences = [];

  for (const reference of [...references].sort(sortBoringReference)) {
    const file = filesByKey.get(reference.matchKey);
    if (!file) {
      unmatchedReferences.push(reference);
      continue;
    }

    usedFileKeys.add(reference.matchKey);
    matched.push({
      ...reference,
      file
    });
  }

  const boringFolderPath = boringFiles.length > 0 ? path.dirname(boringFiles[0].fullPath) : null;
  const usedTargetNames = new Set();
  const items = matched.map((item, index) => {
    const number = String(index + 1).padStart(2, '0');
    const newName = `${projectLabel}-Boring${number}.dwg`;
    const targetPath = path.join(boringFolderPath, newName);
    const sourcePath = item.file.fullPath;
    const needsFileRename = path.resolve(sourcePath).toLowerCase() !== path.resolve(targetPath).toLowerCase();
    const needsTextUpdate = normalizeText(item.text) !== newName;

    if (usedTargetNames.has(newName.toLowerCase())) {
      throw new Error(`Nombre de Boring duplicado calculado: ${newName}.`);
    }
    usedTargetNames.add(newName.toLowerCase());

    return {
      handle: item.handle,
      oldText: item.text,
      newText: newName,
      oldFileName: item.file.name,
      newFileName: newName,
      sourcePath,
      targetPath,
      x: item.x,
      y: item.y,
      z: item.z,
      entityType: item.entityType,
      needsFileRename,
      needsTextUpdate
    };
  });

  const unmatchedFiles = boringFiles
    .filter((file) => file.matchKey && !usedFileKeys.has(file.matchKey))
    .map((file) => file.name)
    .sort((left, right) => left.localeCompare(right));

  return {
    items,
    unmatchedReferences,
    unmatchedFiles
  };
}

async function assertBoringRenameTargetsAvailable(items) {
  for (const item of items) {
    if (!item.needsFileRename) {
      continue;
    }

    if (await pathExists(item.targetPath)) {
      throw new Error(`No se puede renombrar ${item.oldFileName}: ya existe ${item.newFileName}.`);
    }
  }
}

async function renameBoringFiles(items) {
  const renamed = [];
  try {
    for (const item of items) {
      if (!item.needsFileRename) {
        continue;
      }

      await fsp.rename(item.sourcePath, item.targetPath);
      renamed.push(item);
    }
  }
  catch (error) {
    for (const item of [...renamed].reverse()) {
      try {
        await fsp.rename(item.targetPath, item.sourcePath);
      }
      catch {
      }
    }

    throw error;
  }

  return renamed;
}

async function rollbackBoringRenames(renamedItems) {
  for (const item of [...renamedItems].reverse()) {
    try {
      if ((await pathExists(item.targetPath)) && !(await pathExists(item.sourcePath))) {
        await fsp.rename(item.targetPath, item.sourcePath);
      }
    }
    catch {
    }
  }
}

async function applyBoringTextRenames({ projectFolderPath, dwgPath, items, options = {} }) {
  const projectToken = path.basename(path.resolve(projectFolderPath)).replace(/[^A-Za-z0-9._-]+/g, '_');
  const scriptToken = `${projectToken}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const lispFilePath = path.join(os.tmpdir(), `fiber-apply-borings-${scriptToken}.lsp`);
  const progressFilePath = path.join(os.tmpdir(), `fiber-apply-borings-${scriptToken}.progress`);
  const scriptFilePath = path.join(os.tmpdir(), `fiber-apply-borings-${scriptToken}.scr`);
  const timeoutMs = Math.max(90000, items.length * 2500);
  let usedOpenDocument = false;
  let accoreConsolePath = null;
  let updatedTextCount = 0;

  try {
    await removeFileIfExists(progressFilePath);
    await fsp.writeFile(
      lispFilePath,
      buildApplyBoringRenamesLisp({ renameItems: items, progressFilePath }),
      'utf8'
    );

    const progressMonitor = startProgressMonitor(progressFilePath, {
      onStage: (stage) => {
        if (typeof options.onStage === 'function') {
          options.onStage(stage);
        }
      },
      onResult: (result) => {
        if (result.name === 'UPDATED') {
          const parsedValue = Number(result.value);
          if (Number.isFinite(parsedValue)) {
            updatedTextCount = parsedValue;
          }
        }
      }
    });

    try {
      const openDocumentResult = await tryRunCommandOnOpenDocument({
        dwgPath,
        lispFilePath,
        commandName: APPLY_BORING_RENAMES_COMMAND_NAME,
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
          throw new Error('No se ha encontrado accoreconsole.exe. Hace falta AutoCAD abierto o una instalacion local de AutoCAD.');
        }

        await runAccoreConsoleCommand({
          accoreConsolePath,
          dwgPath,
          lispFilePath,
          scriptFilePath,
          commandName: APPLY_BORING_RENAMES_COMMAND_NAME,
          timeoutMs,
          saveDocument: true
        });
      }
    }
    finally {
      await progressMonitor.stop();
    }

    return {
      usedOpenDocument,
      accoreConsolePath,
      updatedTextCount,
      manualScriptPath: scriptFilePath
    };
  }
  finally {
    await removeFileIfExists(progressFilePath);
    await removeFileIfExists(lispFilePath);
  }
}

async function writeBoringRenameLog({ projectFolderPath, dwgPath, boringFolderPath, items }) {
  const logPath = path.join(boringFolderPath, 'BORING_conversiones.txt');
  const lines = [
    '',
    '============================================================',
    `Fecha=${new Date().toISOString()}`,
    `Proyecto=${projectFolderPath}`,
    `DWG=${dwgPath}`,
    `Boringen=${boringFolderPath}`
  ];

  for (const [index, item] of items.entries()) {
    lines.push('---');
    lines.push(`Orden=${index + 1}`);
    lines.push(`Handle=${item.handle}`);
    lines.push(`X=${item.x}`);
    lines.push(`Y=${item.y}`);
    lines.push(`TextoOriginal=${item.oldText}`);
    lines.push(`TextoNuevo=${item.newText}`);
    lines.push(`ArchivoOriginal=${item.oldFileName}`);
    lines.push(`ArchivoNuevo=${item.newFileName}`);
  }

  lines.push('');
  await fsp.appendFile(logPath, lines.join('\n'), 'utf8');
  return logPath;
}

async function createGestuurdeBoringen(projectFolderPath, options = {}) {
  if (typeof options.onStage === 'function') {
    options.onStage('files');
  }

  const resolvedProjectFolder = path.resolve(String(projectFolderPath ?? '').trim());
  const projectLabel = getProjectLabel(resolvedProjectFolder);
  const boringFiles = await getBoringDwgFiles(resolvedProjectFolder);
  if (boringFiles.length === 0) {
    throw new Error(`No se han encontrado archivos DWG en ${path.join(resolvedProjectFolder, 'Boringen')}.`);
  }

  const extraction = await extractBoringReferencesFromDwg(resolvedProjectFolder, options);
  if (extraction.references.length === 0) {
    throw new Error('No se han encontrado referencias DWG en multileaders/textos del dibujo principal.');
  }

  if (typeof options.onStage === 'function') {
    options.onStage('plan');
  }

  const plan = buildBoringRenamePlan({
    projectLabel,
    references: extraction.references,
    boringFiles
  });

  if (plan.items.length === 0) {
    throw new Error('No se ha podido emparejar ninguna referencia del DWG con archivos dentro de Boringen.');
  }

  await assertBoringRenameTargetsAvailable(plan.items);

  if (typeof options.onStage === 'function') {
    options.onStage('rename');
  }

  const renamedItems = await renameBoringFiles(plan.items);
  try {
    const applyResult = await applyBoringTextRenames({
      projectFolderPath: resolvedProjectFolder,
      dwgPath: extraction.dwgPath,
      items: plan.items,
      options
    });

    if (applyResult.updatedTextCount < plan.items.length) {
      throw new Error(`AutoCAD solo ha actualizado ${applyResult.updatedTextCount} referencias de ${plan.items.length}.`);
    }

    const logPath = await writeBoringRenameLog({
      projectFolderPath: resolvedProjectFolder,
      dwgPath: extraction.dwgPath,
      boringFolderPath: path.dirname(boringFiles[0].fullPath),
      items: plan.items
    });

    return {
      projectLabel,
      dwgPath: extraction.dwgPath,
      boringFolderPath: path.dirname(boringFiles[0].fullPath),
      logPath,
      referenceCount: extraction.references.length,
      matchedCount: plan.items.length,
      renamedFileCount: renamedItems.length,
      updatedTextCount: applyResult.updatedTextCount,
      unmatchedFiles: plan.unmatchedFiles,
      unmatchedReferences: plan.unmatchedReferences.map((item) => item.text),
      usedOpenDocument: extraction.usedOpenDocument || applyResult.usedOpenDocument,
      accoreConsolePath: extraction.accoreConsolePath || applyResult.accoreConsolePath
    };
  }
  catch (error) {
    await rollbackBoringRenames(renamedItems);
    throw error;
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

function stripHtmlToText(value) {
  return decodeHtmlEntities(String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/caption>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCheckHeader(value) {
  return stripHtmlToText(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseCheckTableRows(tableHtml) {
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows = [];
  let trMatch;

  while ((trMatch = trRegex.exec(String(tableHtml ?? ''))) !== null) {
    const cellRegex = /<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
    const cells = [];
    let cellMatch;

    while ((cellMatch = cellRegex.exec(trMatch[1])) !== null) {
      cells.push(stripHtmlToText(cellMatch[1]));
    }

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  return rows;
}

function parseRoutingProblemLabelsFromCheckHtml(htmlText) {
  const html = String(htmlText ?? '').replace(/\r/g, '');
  const tableRegex = /<table\b[\s\S]*?<\/table>/gi;
  const labels = [];
  const seen = new Set();
  let tableMatch;

  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const tableHtml = tableMatch[0];
    const tableContextHtml = html.slice(Math.max(0, tableMatch.index - 800), tableMatch.index) + tableHtml;
    const tableContextText = stripHtmlToText(tableContextHtml);
    if (!ROUTING_PROBLEM_SECTION_PATTERN.test(tableContextText)) {
      continue;
    }

    const rows = parseCheckTableRows(tableHtml);
    if (rows.length < 2) {
      continue;
    }

    const headers = rows[0].map(normalizeCheckHeader);
    const locationBIndex = headers.findIndex((header) => header === 'locatienaamb');
    const errorMessageIndex = headers.findIndex((header) => header === 'errormessage');
    if (locationBIndex < 0) {
      continue;
    }

    for (const cells of rows.slice(1)) {
      const errorMessage = stripHtmlToText(cells[errorMessageIndex] ?? '');
      if (!ROUTING_NO_NETWORK_MESSAGE_PATTERN.test(errorMessage)) {
        continue;
      }

      const label = normalizeText(cells[locationBIndex]);
      if (!label) {
        continue;
      }

      const key = label.toUpperCase();
      if (!seen.has(key)) {
        seen.add(key);
        labels.push(label);
      }
    }
  }

  return labels;
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

async function placePhktTextsAtAccessnetVertices(projectFolderPath, options = {}) {
  const dwgPath = await getFirstDwgPath(projectFolderPath);
  if (!dwgPath) {
    throw new Error('No se ha encontrado un DWG en la carpeta del proyecto.');
  }

  const token = `${path.basename(dwgPath).replace(/[^A-Za-z0-9._-]+/g, '_')}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const extractionLispPath = path.join(os.tmpdir(), `fiber-phkt-extract-${token}.lsp`);
  const extractionOutputPath = path.join(os.tmpdir(), `fiber-phkt-extract-${token}.tsv`);
  const extractionProgressPath = path.join(os.tmpdir(), `fiber-phkt-extract-${token}.progress`);
  const reviewLispPath = path.join(os.tmpdir(), `fiber-phkt-review-${token}.lsp`);
  const reviewOutputPath = path.join(os.tmpdir(), `fiber-phkt-review-${token}.tsv`);
  const reviewProgressPath = path.join(os.tmpdir(), `fiber-phkt-review-${token}.progress`);
  const temporaryPaths = [
    extractionLispPath,
    extractionOutputPath,
    extractionProgressPath,
    reviewLispPath,
    reviewOutputPath,
    reviewProgressPath
  ];
  const timeoutMs = Number(options.timeoutMs) || (4 * 60 * 60 * 1000);
  const config = { ...DEFAULT_PHKT_PLACEMENT_CONFIG, ...(options.config ?? {}) };

  try {
    await Promise.all(temporaryPaths.map((targetPath) => removeFileIfExists(targetPath)));
    await fsp.writeFile(extractionLispPath, buildPhktExtractionLisp({
      outputFilePath: extractionOutputPath,
      progressFilePath: extractionProgressPath,
      commandName: EXTRACT_PHKT_PLACEMENT_COMMAND_NAME,
      targetLabels: options.targetLabels ?? []
    }), 'utf8');

    const extractionMonitor = startProgressMonitor(extractionProgressPath, {
      onStage: (stage) => options.onStage?.(stage)
    });
    let extractionRun;
    try {
      extractionRun = await tryRunCommandOnOpenDocument({
        dwgPath,
        lispFilePath: extractionLispPath,
        commandName: EXTRACT_PHKT_PLACEMENT_COMMAND_NAME,
        progressFilePath: extractionProgressPath,
        outputFilePath: extractionOutputPath,
        timeoutMs,
        saveDocument: false
      });
    }
    finally {
      await extractionMonitor.stop();
    }

    if (!extractionRun?.handled) {
      throw new Error('Abra el DWG del proyecto en AutoCAD antes de iniciar la asignacion PHKT. Esta herramienta necesita una sesion interactiva.');
    }
    if (!(await pathExists(extractionOutputPath))) {
      throw new Error('AutoCAD no ha generado la seleccion y geometria temporal para la asignacion PHKT.');
    }

    const extractionProgress = await fsp.readFile(extractionProgressPath, 'utf8').catch(() => '');
    const extractionError = extractionProgress.match(/FMDB_RESULT:ERROR=([^\r\n]+)/i)?.[1];
    if (extractionError) {
      throw new Error(`AutoCAD no ha podido extraer la geometria PHKT: ${extractionError}`);
    }
    if (!/FMDB_DONE:(?:extracted|cancelled)/i.test(extractionProgress)) {
      throw new Error('AutoCAD no ha finalizado correctamente la extraccion de textos y vertices PHKT.');
    }

    const extraction = parsePhktExtraction(await fsp.readFile(extractionOutputPath, 'utf8'));
    if (extraction.texts.length === 0) {
      if (Array.isArray(options.targetLabels) && options.targetLabels.length > 0) {
        throw new Error(`No se ha encontrado ningun TEXT en el DWG que coincida con las ${options.targetLabels.length} direcciones del check.`);
      }

      return {
        status: 'CANCELLED',
        cancelled: true,
        dwgPath,
        selected: 0,
        assigned: 0,
        manual: 0,
        skipped: 0,
        withoutCandidates: 0,
        errors: 0,
        sharedVertices: 0,
        maximumAssignments: 0,
        config
      };
    }
    if (extraction.vertices.length === 0) {
      throw new Error('No se han encontrado vertices de Polyline en la layer Accessnet.');
    }

    const model = buildPlacementModel(extraction, config);
    options.onModelReady?.({
      textCount: model.texts.length,
      rawVertexCount: extraction.vertices.length,
      candidateCount: model.candidates.length,
      rolCount: extraction.roles.length,
      config
    });
    await fsp.writeFile(reviewLispPath, buildPhktReviewLisp({
      model,
      outputFilePath: reviewOutputPath,
      progressFilePath: reviewProgressPath,
      commandName: REVIEW_PHKT_PLACEMENT_COMMAND_NAME
    }), 'utf8');

    const reviewMonitor = startProgressMonitor(reviewProgressPath, {
      onStage: (stage) => options.onStage?.(stage)
    });
    let reviewRun;
    try {
      reviewRun = await tryRunCommandOnOpenDocument({
        dwgPath,
        lispFilePath: reviewLispPath,
        commandName: REVIEW_PHKT_PLACEMENT_COMMAND_NAME,
        progressFilePath: reviewProgressPath,
        outputFilePath: reviewOutputPath,
        timeoutMs,
        saveDocument: false
      });
    }
    finally {
      await reviewMonitor.stop();
    }

    if (!reviewRun?.handled || !(await pathExists(reviewOutputPath))) {
      throw new Error('AutoCAD no ha completado la revision interactiva de textos PHKT.');
    }

    const result = parsePhktReviewResult(await fsp.readFile(reviewOutputPath, 'utf8'));
    if (result.status === 'ROLLED_BACK') {
      throw new Error(`Ha fallado un movimiento y se han revertido todos los cambios. ${result.error ?? ''}`.trim());
    }
    if (result.status === 'ERROR' || result.status === 'UNKNOWN') {
      throw new Error(`AutoCAD no ha podido completar la revision PHKT. ${result.error ?? ''}`.trim());
    }
    return {
      ...result,
      cancelled: result.status !== 'APPLIED',
      dwgPath,
      config,
      candidateCount: model.candidates.length,
      rawVertexCount: extraction.vertices.length,
      rolCount: extraction.roles.length
    };
  }
  finally {
    await Promise.all(temporaryPaths.map((targetPath) => removeFileIfExists(targetPath)));
  }
}

async function placeRoutingProblemPhktFromCheck(projectFolderPath, options = {}) {
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
  const targetLabels = parseRoutingProblemLabelsFromCheckHtml(htmlText);
  if (targetLabels.length === 0) {
    throw new Error(`No se han encontrado direcciones locatienaam_b en la tabla cable: Routing problem de ${checkPath}.`);
  }

  const result = await placePhktTextsAtAccessnetVertices(projectFolderPath, {
    ...options,
    targetLabels
  });

  return {
    ...result,
    checkPath,
    routingProblemLabelCount: targetLabels.length,
    routingProblemLabels: targetLabels
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
        const [label, layer, x, y, z, entityType] = line.split('\t');
        return {
          label: normalizeText(label),
          layer: normalizeText(layer),
          entityType: normalizeText(entityType) || 'TEXT',
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
    await fsp.writeFile(lispFilePath, buildClearCustomerCoordinatesLisp({ progressFilePath, purge: options.purge !== false }), 'utf8');

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
  _internal: {
    parseRoutingProblemLabelsFromCheckHtml
  },
  drawAccessnetWithoutAddressFromCheck,
  clearCustomerCoordinatesInDwg,
  createGestuurdeBoringen,
  drawCustomerCoordinatesToDwg,
  extractCustomerTextCoordinates,
  extractOapCoordinate,
  getFirstDwgPath,
  placeRoutingProblemPhktFromCheck,
  placePhktTextsAtAccessnetVertices,
  pickPointFromOpenDocument,
  removeExtraRolesFromCheck
};
