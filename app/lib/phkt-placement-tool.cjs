function escapeLispString(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]+/g, ' ');
}

function toLispPath(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

function pointToLisp(point) {
  return `(${Number(point.x)} ${Number(point.y)} ${Number(point.z ?? 0)})`;
}

function buildProgressHelpers(progressFilePath) {
  return `
(setq fmdb-progress-file "${escapeLispString(toLispPath(progressFilePath))}")
(defun fmdb-progress (line / stream)
  (if (> (strlen fmdb-progress-file) 0)
    (progn
      (setq stream (open fmdb-progress-file "a"))
      (if stream (progn (write-line line stream) (close stream)))
    )
  )
)
(defun fmdb-stage (name) (fmdb-progress (strcat "FMDB_STAGE:" name)))
(defun fmdb-result (name value) (fmdb-progress (strcat "FMDB_RESULT:" name "=" value)))
(defun fmdb-done (name) (fmdb-progress (strcat "FMDB_DONE:" name)))
`;
}

function buildExtractionLisp({ outputFilePath, progressFilePath, commandName }) {
  return `(vl-load-com)
${buildProgressHelpers(progressFilePath)}
(setq fmdb-output-file "${escapeLispString(toLispPath(outputFilePath))}")

(defun fmdb-point-list (value)
  (cond
    ((= (type value) 'VARIANT) (fmdb-point-list (vlax-variant-value value)))
    ((= (type value) 'SAFEARRAY) (vlax-safearray->list value))
    ((listp value) value)
    (t nil)
  )
)

(defun fmdb-safe-text (value)
  (vl-string-translate (strcat (chr 9) (chr 10) (chr 13)) "   " (if value value ""))
)

(defun fmdb-effective-name (object / result)
  (setq result (vl-catch-all-apply 'vla-get-EffectiveName (list object)))
  (if (vl-catch-all-error-p result) (vla-get-Name object) result)
)

(defun fmdb-vla-object (entity / result)
  (setq result (vl-catch-all-apply 'vlax-ename->vla-object (list entity)))
  (if (vl-catch-all-error-p result) nil result)
)

(defun fmdb-logical-text-point (object / objectName alignment result)
  (setq objectName (vla-get-ObjectName object))
  (cond
    ((= objectName "AcDbMText")
      (fmdb-point-list (vla-get-InsertionPoint object)))
    ((= objectName "AcDbText")
      (setq alignment (vla-get-Alignment object))
      (if (= alignment 0)
        (fmdb-point-list (vla-get-InsertionPoint object))
        (progn
          (setq result (vl-catch-all-apply 'vla-get-TextAlignmentPoint (list object)))
          (if (vl-catch-all-error-p result)
            (fmdb-point-list (vla-get-InsertionPoint object))
            (fmdb-point-list result)
          )
        )
      ))
    (t nil)
  )
)

(defun fmdb-write-row (stream values)
  (write-line (apply 'strcat (cons (car values) (mapcar '(lambda (value) (strcat "\t" value)) (cdr values)))) stream)
)

(defun c:${commandName} (/ selection stream index entity object point allEntities maxParam vertexIndex vertexPoint objectName endpointCount textCount vertexCount rolCount oldError *error*)
  (setq textCount 0 vertexCount 0 rolCount 0)
  (setq oldError *error*)
  (setq *error* (lambda (message)
    (if stream (progn (close stream) (setq stream nil)))
    (fmdb-result "ERROR" (if message message "Error desconocido"))
    (fmdb-done "error")
    (setq *error* oldError)
    (princ)))
  (fmdb-stage "select-texts")
  (prompt "\nSeleccione los textos PHKT (TEXT o MTEXT) y pulse Enter: ")
  (setq selection (ssget '((0 . "TEXT,MTEXT"))))
  (setq stream (open fmdb-output-file "w"))
  (if (not stream)
    (progn (prompt "\nNo se pudo crear el fichero temporal.") (fmdb-done "error"))
    (progn
      (if selection
        (progn
          (setq index 0)
          (while (< index (sslength selection))
            (setq entity (ssname selection index)
                  object (fmdb-vla-object entity)
                  point (if object (fmdb-logical-text-point object) nil))
            (if (and object point)
              (progn
                (fmdb-write-row stream (list "TEXT" (vla-get-Handle object) (vla-get-ObjectName object) (fmdb-safe-text (vla-get-TextString object))
                  (rtos (car point) 2 12) (rtos (cadr point) 2 12) (rtos (if (caddr point) (caddr point) 0.0) 2 12)))
                (setq textCount (1+ textCount))
              )
            )
            (setq index (1+ index))
          )
        )
      )
      (fmdb-stage "extract-accessnet")
      (setq allEntities (ssget "_X" '((0 . "LWPOLYLINE"))))
      (if allEntities
        (progn
          (setq index 0)
          (while (< index (sslength allEntities))
            (setq entity (ssname allEntities index)
                  object (fmdb-vla-object entity))
            (if (and object (= (strcase (vla-get-Layer object)) "ACCESSNET"))
              (progn
                (setq maxParam (fix (vlax-curve-getEndParam object)) vertexIndex 0)
                (while (<= vertexIndex maxParam)
                  (setq vertexPoint (vlax-curve-getPointAtParam object vertexIndex))
                  (fmdb-write-row stream (list "VERTEX" (vla-get-Handle object) (itoa vertexIndex)
                    (if (or (= vertexIndex 0) (= vertexIndex maxParam)) "1" "0")
                    (rtos (car vertexPoint) 2 12) (rtos (cadr vertexPoint) 2 12) (rtos (if (caddr vertexPoint) (caddr vertexPoint) 0.0) 2 12)))
                  (setq vertexCount (1+ vertexCount) vertexIndex (1+ vertexIndex))
                )
              )
            )
            (setq index (1+ index))
          )
        )
      )
      (fmdb-stage "detect-rol")
      (setq allEntities (ssget "_X" '((0 . "INSERT"))))
      (if allEntities
        (progn
          (setq index 0)
          (while (< index (sslength allEntities))
            (setq entity (ssname allEntities index)
                  object (fmdb-vla-object entity))
            (if (and object (= (strcase (vla-get-Layer object)) "OPMERKING") (= (strcase (fmdb-effective-name object)) "ROL"))
              (progn
                (setq point (fmdb-point-list (vla-get-InsertionPoint object)))
                (fmdb-write-row stream (list "ROL" (vla-get-Handle object)
                  (rtos (car point) 2 12) (rtos (cadr point) 2 12) (rtos (if (caddr point) (caddr point) 0.0) 2 12)))
                (setq rolCount (1+ rolCount))
              )
            )
            (setq index (1+ index))
          )
        )
      )
      (close stream)
      (setq stream nil)
      (fmdb-result "TEXTS" (itoa textCount))
      (fmdb-result "VERTICES" (itoa vertexCount))
      (fmdb-result "ROLES" (itoa rolCount))
      (fmdb-done (if selection "extracted" "cancelled"))
      (if (not selection) (prompt "\nSeleccion cancelada; no se ha modificado el dibujo."))
    )
  )
  (setq *error* oldError)
  (princ)
)
(princ)
`;
}

function parseExtraction(text) {
  const extraction = { texts: [], vertices: [], roles: [] };
  for (const rawLine of String(text ?? '').replace(/\r/g, '').split('\n')) {
    if (!rawLine.trim()) continue;
    const fields = rawLine.split('\t');
    if (fields[0] === 'TEXT' && fields.length >= 7) {
      extraction.texts.push({
        handle: fields[1],
        type: fields[2],
        content: fields[3],
        point: { x: Number(fields[4]), y: Number(fields[5]), z: Number(fields[6]) }
      });
    }
    else if (fields[0] === 'VERTEX' && fields.length >= 7) {
      extraction.vertices.push({
        polylineHandle: fields[1],
        vertexIndex: Number(fields[2]),
        isEndpoint: fields[3] === '1',
        x: Number(fields[4]),
        y: Number(fields[5]),
        z: Number(fields[6])
      });
    }
    else if (fields[0] === 'ROL' && fields.length >= 5) {
      extraction.roles.push({ handle: fields[1], x: Number(fields[2]), y: Number(fields[3]), z: Number(fields[4]) });
    }
  }
  return extraction;
}

function buildCandidateLisp(candidate) {
  const handles = candidate.polylineHandles.map((handle) => `"${escapeLispString(handle)}"`).join(' ');
  return `("${escapeLispString(candidate.id)}" ${pointToLisp(candidate)} ${Number(candidate.distance ?? 0)} ${candidate.hasRol ? 1 : 0} "${escapeLispString(candidate.kind)}" (${handles}))`;
}

function buildReviewLisp({ model, outputFilePath, progressFilePath, commandName }) {
  const texts = model.texts.map((text) => {
    const candidates = text.candidates.map(buildCandidateLisp).join(' ');
    return `("${escapeLispString(text.handle)}" "${escapeLispString(text.content)}" ${pointToLisp(text.point)} "${escapeLispString(text.type)}" (${candidates}))`;
  }).join('\n  ');
  const vertices = model.candidates.map((candidate) => buildCandidateLisp({ ...candidate, distance: 0 })).join('\n  ');

  return `(vl-load-com)
${buildProgressHelpers(progressFilePath)}
(setq fmdb-output-file "${escapeLispString(toLispPath(outputFilePath))}")
(setq fmdb-texts '(${texts}))
(setq fmdb-vertices '(${vertices}))
(setq fmdb-decisions nil fmdb-highlighted nil)

(defun fmdb-object (handle / entity) (setq entity (handent handle)) (if entity (vlax-ename->vla-object entity) nil))
(defun fmdb-point-list (value)
  (cond ((= (type value) 'VARIANT) (fmdb-point-list (vlax-variant-value value)))
        ((= (type value) 'SAFEARRAY) (vlax-safearray->list value))
        ((listp value) value) (t nil)))
(defun fmdb-distance (a b) (distance a b))
(defun fmdb-logical-point (object / name alignment result)
  (setq name (vla-get-ObjectName object))
  (cond ((= name "AcDbMText") (fmdb-point-list (vla-get-InsertionPoint object)))
        ((= name "AcDbText")
          (setq alignment (vla-get-Alignment object))
          (if (= alignment 0) (fmdb-point-list (vla-get-InsertionPoint object))
            (progn (setq result (vl-catch-all-apply 'vla-get-TextAlignmentPoint (list object)))
              (if (vl-catch-all-error-p result) (fmdb-point-list (vla-get-InsertionPoint object)) (fmdb-point-list result)))))
        (t nil)))

(defun fmdb-unhighlight ()
  (foreach object fmdb-highlighted (if object (vl-catch-all-apply 'vla-Highlight (list object :vlax-false))))
  (setq fmdb-highlighted nil) (redraw))
(defun fmdb-highlight (handle / object)
  (setq object (fmdb-object handle))
  (if object (progn (vl-catch-all-apply 'vla-Highlight (list object :vlax-true)) (setq fmdb-highlighted (cons object fmdb-highlighted)))))
(defun fmdb-circle (center radius / index angle previous current)
  (setq index 0 previous nil)
  (while (<= index 24)
    (setq angle (* 2.0 pi (/ index 24.0)) current (list (+ (car center) (* radius (cos angle))) (+ (cadr center) (* radius (sin angle))) (if (caddr center) (caddr center) 0.0)))
    (if previous (grdraw previous current 1 1))
    (setq previous current index (1+ index))))
(defun fmdb-zoom-pair (a b / minPoint maxPoint span padding app)
  (setq span (max (abs (- (car a) (car b))) (abs (- (cadr a) (cadr b))) 1.0) padding (* span 0.35)
        minPoint (list (- (min (car a) (car b)) padding) (- (min (cadr a) (cadr b)) padding) 0.0)
        maxPoint (list (+ (max (car a) (car b)) padding) (+ (max (cadr a) (cadr b)) padding) 0.0)
        app (vlax-get-acad-object))
  (vl-catch-all-apply 'vla-ZoomWindow (list app (vlax-3d-point minPoint) (vlax-3d-point maxPoint))))
(defun fmdb-assignment-count (candidateId / count decision)
  (setq count 0)
  (foreach decision fmdb-decisions (if (and (= (cadr decision) candidateId) (= (car (cddddr decision)) "accepted")) (setq count (1+ count)))) count)
(defun fmdb-preview (text candidate / textPoint target handles radius)
  (fmdb-unhighlight)
  (fmdb-highlight (car text))
  (foreach handle (nth 5 candidate) (fmdb-highlight handle))
  (setq textPoint (nth 2 text) target (nth 1 candidate) radius (max 0.25 (* 0.02 (fmdb-distance textPoint target))))
  (fmdb-zoom-pair textPoint target)
  (setq textPoint (trans textPoint 0 1) target (trans target 0 1))
  (grdraw textPoint target 2 1)
  (grdraw (list (- (car target) radius) (cadr target) (caddr target)) (list (+ (car target) radius) (cadr target) (caddr target)) 1 1)
  (grdraw (list (car target) (- (cadr target) radius) (caddr target)) (list (car target) (+ (cadr target) radius) (caddr target)) 1 1)
  (fmdb-circle target radius))

(defun fmdb-find-decision (handle) (assoc handle fmdb-decisions))
(defun fmdb-remove-decision (handle) (setq fmdb-decisions (vl-remove-if '(lambda (item) (= (car item) handle)) fmdb-decisions)))
(defun fmdb-set-decision (text candidate method status)
  (fmdb-remove-decision (car text))
  (setq fmdb-decisions (cons (list (car text) (if candidate (car candidate) "") (if candidate (nth 1 candidate) nil) method status) fmdb-decisions)))
(defun fmdb-nearest-vertex (point / nearest nearestDistance candidate candidateDistance)
  (setq nearest nil nearestDistance nil)
  (foreach candidate fmdb-vertices
    (setq candidateDistance (fmdb-distance point (nth 1 candidate)))
    (if (or (not nearestDistance) (< candidateDistance nearestDistance)) (setq nearest candidate nearestDistance candidateDistance))) nearest)
(defun fmdb-prompt-candidate (text candidate candidateIndex total / choice assignments)
  (fmdb-preview text candidate)
  (setq assignments (fmdb-assignment-count (car candidate)))
  (prompt (strcat "\nPHKT: " (nth 1 text) " | Candidato " (itoa (1+ candidateIndex)) "/" (itoa total)
    " | Distancia: " (rtos (nth 2 candidate) 2 3) " | " (nth 4 candidate)
    " | ROL: " (if (= (nth 3 candidate) 1) "si" "no") " | Asignaciones: " (itoa assignments)))
  (initget "Aceptar Siguiente Anterior Manual Omitir Volver Terminar Cancelar")
  (setq choice (getkword "\n[Aceptar/Siguiente/Anterior/Manual/Omitir/Volver/Terminar/Cancelar] <Aceptar>: "))
  (if choice choice "Aceptar"))
(defun fmdb-manual (text / point candidate choice)
  (setq point (getpoint "\nSeleccione cerca de un vertice real de Accessnet: "))
  (if point
    (progn (setq candidate (fmdb-nearest-vertex (trans point 1 0)))
      (if candidate
        (progn (fmdb-preview text candidate)
          (prompt (strcat "\nVertice ajustado: " (rtos (car (nth 1 candidate)) 2 3) ", " (rtos (cadr (nth 1 candidate)) 2 3)
            " | " (nth 4 candidate) " | ROL: " (if (= (nth 3 candidate) 1) "si" "no")
            " | Asignaciones: " (itoa (fmdb-assignment-count (car candidate)))))
          (initget "Aceptar Cancelar")
          (setq choice (getkword "\n[Aceptar/Cancelar] <Aceptar>: "))
          (if (or (not choice) (= choice "Aceptar")) candidate nil))
        nil)) nil))

(defun fmdb-summary-values (/ assigned manual skipped noCandidates shared maximum candidateId count counts)
  (setq assigned 0 manual 0 skipped 0 noCandidates 0 shared 0 maximum 0 counts nil)
  (foreach text fmdb-texts (if (not (nth 4 text)) (setq noCandidates (1+ noCandidates))))
  (foreach decision fmdb-decisions
    (cond ((= (nth 4 decision) "accepted")
      (setq assigned (1+ assigned)) (if (= (nth 3 decision) "manual") (setq manual (1+ manual)))
      (setq candidateId (cadr decision) count (1+ (if (assoc candidateId counts) (cdr (assoc candidateId counts)) 0)))
      (setq counts (cons (cons candidateId count) (vl-remove (assoc candidateId counts) counts))))
      ((= (nth 4 decision) "skipped") (setq skipped (1+ skipped)))))
  (foreach item counts (if (> (cdr item) 1) (setq shared (1+ shared))) (if (> (cdr item) maximum) (setq maximum (cdr item))))
  (list (length fmdb-texts) assigned manual skipped noCandidates 0 shared maximum))
(defun fmdb-write-result (status summary errorText / stream)
  (setq stream (open fmdb-output-file "w"))
  (if stream (progn
    (write-line (strcat "STATUS\t" status) stream)
    (write-line (strcat "SELECTED\t" (itoa (nth 0 summary))) stream)
    (write-line (strcat "ASSIGNED\t" (itoa (nth 1 summary))) stream)
    (write-line (strcat "MANUAL\t" (itoa (nth 2 summary))) stream)
    (write-line (strcat "SKIPPED\t" (itoa (nth 3 summary))) stream)
    (write-line (strcat "WITHOUT_CANDIDATES\t" (itoa (nth 4 summary))) stream)
    (write-line (strcat "ERRORS\t" (itoa (nth 5 summary))) stream)
    (write-line (strcat "SHARED_VERTICES\t" (itoa (nth 6 summary))) stream)
    (write-line (strcat "MAXIMUM_ASSIGNMENTS\t" (itoa (nth 7 summary))) stream)
    (if errorText (write-line (strcat "ERROR\t" errorText) stream))
    (close stream))))

(defun fmdb-apply-moves (/ document moved decision object source target result failed errorText)
  (setq document (vla-get-ActiveDocument (vlax-get-acad-object)) moved nil failed nil errorText nil)
  (vla-StartUndoMark document)
  (foreach decision fmdb-decisions
    (if (and (not failed) (= (nth 4 decision) "accepted"))
      (progn (setq object (fmdb-object (car decision)) target (nth 2 decision) source (if object (fmdb-logical-point object) nil))
        (if (and object source target)
          (progn (setq result (vl-catch-all-apply 'vla-Move (list object (vlax-3d-point source) (vlax-3d-point target))))
            (if (vl-catch-all-error-p result) (setq failed T errorText (vl-catch-all-error-message result))
              (setq moved (cons (list object source target) moved))))
          (setq failed T errorText "No se pudo resolver uno de los textos seleccionados.")))))
  (if (not failed)
    (progn
      (setq result (vl-catch-all-apply 'vla-Save (list document)))
      (if (vl-catch-all-error-p result) (setq failed T errorText (vl-catch-all-error-message result)))))
  (if failed
    (foreach item moved (vl-catch-all-apply 'vla-Move (list (car item) (vlax-3d-point (nth 2 item)) (vlax-3d-point (nth 1 item))))))
  (vla-EndUndoMark document)
  (list (not failed) errorText))

(defun c:${commandName} (/ total index text candidates candidateIndex candidate choice done cancelled manualCandidate summary confirmation applyResult oldError *error*)
  (setq oldError *error*)
  (setq *error* (lambda (message)
    (vl-catch-all-apply 'fmdb-unhighlight nil)
    (setq summary (if fmdb-texts (fmdb-summary-values) (list 0 0 0 0 0 1 0 0)))
    (fmdb-write-result "ERROR" summary (if message message "Error desconocido"))
    (fmdb-result "ERROR" (if message message "Error desconocido"))
    (fmdb-done "error")
    (setq *error* oldError)
    (princ)))
  (setq total (length fmdb-texts) index 0 done nil cancelled nil)
  (fmdb-stage "review")
  (while (and (< index total) (not done) (not cancelled))
    (setq text (nth index fmdb-texts) candidates (nth 4 text) candidateIndex 0 choice nil)
    (if candidates
      (while (and (not choice) (not done) (not cancelled))
        (setq candidate (nth candidateIndex candidates) choice (fmdb-prompt-candidate text candidate candidateIndex (length candidates)))
        (cond
          ((= choice "Aceptar") (fmdb-set-decision text candidate "automatic" "accepted") (setq index (1+ index)))
          ((= choice "Siguiente") (setq candidateIndex (rem (1+ candidateIndex) (length candidates)) choice nil))
          ((= choice "Anterior") (setq candidateIndex (if (= candidateIndex 0) (1- (length candidates)) (1- candidateIndex)) choice nil))
          ((= choice "Manual") (setq manualCandidate (fmdb-manual text))
            (if manualCandidate (progn (fmdb-set-decision text manualCandidate "manual" "accepted") (setq index (1+ index))) (setq choice nil)))
          ((= choice "Omitir") (fmdb-set-decision text nil "none" "skipped") (setq index (1+ index)))
          ((= choice "Volver") (if (> index 0) (progn (setq index (1- index)) (fmdb-remove-decision (car (nth index fmdb-texts))))) )
          ((= choice "Terminar") (setq done T))
          ((= choice "Cancelar") (setq cancelled T))))
      (progn
        (prompt (strcat "\nPHKT sin candidatos dentro del radio: " (nth 1 text)))
        (initget "Manual Omitir Volver Terminar Cancelar")
        (setq choice (getkword "\n[Manual/Omitir/Volver/Terminar/Cancelar] <Omitir>: "))
        (if (not choice) (setq choice "Omitir"))
        (cond ((= choice "Manual") (setq manualCandidate (fmdb-manual text)) (if manualCandidate (progn (fmdb-set-decision text manualCandidate "manual" "accepted") (setq index (1+ index)))))
              ((= choice "Omitir") (fmdb-set-decision text nil "none" "skipped") (setq index (1+ index)))
              ((= choice "Volver") (if (> index 0) (progn (setq index (1- index)) (fmdb-remove-decision (car (nth index fmdb-texts))))))
              ((= choice "Terminar") (setq done T)) ((= choice "Cancelar") (setq cancelled T)))))
  )
  (fmdb-unhighlight)
  (setq summary (fmdb-summary-values))
  (if cancelled
    (progn (fmdb-write-result "CANCELLED" summary nil) (prompt "\nOperacion cancelada. No se ha movido ningun texto."))
    (progn
      (prompt (strcat "\nResumen: seleccionados " (itoa (nth 0 summary)) ", asignados " (itoa (nth 1 summary))
        ", manuales " (itoa (nth 2 summary)) ", omitidos " (itoa (nth 3 summary))
        ", sin candidatos " (itoa (nth 4 summary)) ", errores " (itoa (nth 5 summary))
        ", vertices compartidos " (itoa (nth 6 summary)) ", maximo por vertice " (itoa (nth 7 summary)) "."))
      (initget "Si No") (setq confirmation (getkword "\nAplicar todos los movimientos como una unica operacion [Si/No] <No>: "))
      (if (= confirmation "Si")
        (progn (fmdb-stage "apply") (setq applyResult (fmdb-apply-moves))
          (if (car applyResult) (fmdb-write-result "APPLIED" summary nil)
            (progn (setq summary (list (nth 0 summary) (nth 1 summary) (nth 2 summary) (nth 3 summary) (nth 4 summary) 1 (nth 6 summary) (nth 7 summary)))
              (fmdb-write-result "ROLLED_BACK" summary (cadr applyResult)))))
        (fmdb-write-result "CANCELLED" summary nil))))
  (fmdb-done "reviewed")
  (setq *error* oldError)
  (princ)
)
(princ)
`;
}

function parseReviewResult(text) {
  const values = {};
  for (const line of String(text ?? '').replace(/\r/g, '').split('\n')) {
    const [key, ...rest] = line.split('\t');
    if (key) values[key] = rest.join('\t');
  }
  return {
    status: values.STATUS ?? 'UNKNOWN',
    selected: Number(values.SELECTED ?? 0),
    assigned: Number(values.ASSIGNED ?? 0),
    manual: Number(values.MANUAL ?? 0),
    skipped: Number(values.SKIPPED ?? 0),
    withoutCandidates: Number(values.WITHOUT_CANDIDATES ?? 0),
    errors: Number(values.ERRORS ?? 0),
    sharedVertices: Number(values.SHARED_VERTICES ?? 0),
    maximumAssignments: Number(values.MAXIMUM_ASSIGNMENTS ?? 0),
    error: values.ERROR ?? null
  };
}

module.exports = {
  buildExtractionLisp,
  buildReviewLisp,
  parseExtraction,
  parseReviewResult
};
