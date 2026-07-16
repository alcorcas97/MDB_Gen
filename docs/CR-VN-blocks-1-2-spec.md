# CR VN Studio

## Especificacion tecnica
### Bloque 1 - Construccion del arbol VN
### Bloque 2 - Ingesta, normalizacion y copia documental

## Objetivo

Construir un generador de entregas `VN` que, a partir de la documentacion provista por obra y de posibles paquetes previos, sea capaz de:

1. Crear el arbol final de salida con la forma aceptada por Cocon/KPN.
2. Poblar dicho arbol con los ficheros documentales y de medicion correctos.
3. Generar la `.mdb` final del proyecto.

Objetivo funcional corregido tras revisar las carpetas descomprimidas:

- La app debe generar todo lo que va dentro de `VN-Bxxxx`.
- Se excluyen por ahora los `.txt`:
  - `Routes.txt`
  - `Email.txt`
  - `Crc.txt`
- `Checks.htm` no se considera excluido y debe tratarse como artefacto final del paquete si llegamos a resolver su origen.
- La aplicacion automatica de `RD` sigue fuera del alcance inmediato.

## Casos analizados

- `CR/Bodm`
- `CR/De Punt`
- `CR/Musseum`

## Hallazgos de referencia

### Estructura final comun

En los tres ejemplos aceptados aparece un paquete raiz con este patron:

```text
<PROJECT-CODE>-VN-B<NNNN>/
  <PROJECT-CODE>-VN-B<NNNN>.mdb
  <PROJECT-CODE>-VN-B<NNNN>.dwg
  Checks.htm
  Crc.txt
  Email.txt
  Routes.txt
  Boringen/
  Gebouwen/
  Klanten/
  Vergunningen/
```

### Objetivo minimo de generacion

Con la informacion revisada en las carpetas descomprimidas, el generador debe aspirar a crear:

- `<projectCode>.mdb`
- `<projectCode>.dwg`
- `Boringen/`
- `Gebouwen/`
- `Klanten/`
- `Vergunningen/`
- `Checks.htm` cuando su origen este resuelto

Y no depende por definicion de generar:

- `Routes.txt`
- `Email.txt`
- `Crc.txt`

### Variaciones detectadas

- `Vergunningen/` puede estar:
  - vacia pero presente
  - solo con la carpeta raiz
  - poblada con PDFs y subcarpetas de dibujos
- `Klanten/` aparece en los tres casos, pero no contiene carga relevante en los ejemplos analizados
- `Kastoverzicht` no tiene un formato unico:
  - `Bodm`: `PON Kastoverzicht POP ...xlsx`
  - `Musseum`: `Kastoverzicht ...pdf`
  - `De Punt`: el paquete final no muestra un unico archivo de kastoverzicht en raiz de `Gebouwen`, pero la fuente provista si lo contiene por OAP

### Fuentes documentales de entrada observadas

- `DWG` de revision o eindrevisie
- `Topo.dwg`
- `GOFC Export/*.csv` o equivalentes
- `HB-documenten/*`
- `Vergunning/*`
- `Boorprofielen/*`
- `Kastoverzicht OAP/*`
- `Meetfiles.zip`, carpetas de `SOR`, reportes PDF/XLSX
- `Te verwerken Revisie/`
- `Vragenlijst*.docx`
- `Reactiedocumenten/RD*`

## Modelo de datos de entrada para bloques 1 y 2

La herramienta no debe trabajar sobre un unico fichero, sino sobre un `case workspace`.

### Entrada minima

- `caseRoot`
  - carpeta del caso, por ejemplo `CR/De Punt`
- `projectCode`
  - por ejemplo `ASD-LWT-VN-B8700`
- `outputRoot`
  - carpeta donde se construira la salida

### Entradas opcionales pero relevantes

- `acceptedPackage`
  - `zip` o `rar` aceptado previo
- `providedArchives`
  - zips auxiliares tipo `OneDrive_2023-07-05.zip`, `Meetfiles.zip`, etc.
- `additionalInfoFolder`
  - normalmente `Aanvullende informatie`
- `reactionFolder`
  - `Reactiedocumenten` o `Reactie Document`

### Manifest interno recomendado

La app debe resolver todas las fuentes y escribir un manifest normalizado temporal antes de construir la salida.

```json
{
  "caseRoot": "C:\\\\...\\\\CR\\\\De Punt",
  "projectCode": "ASD-LWT-VN-B8700",
  "projectPrefix": "ASD-LWT",
  "deliveryId": "B8700",
  "acceptedPackage": {
    "path": "C:\\\\...\\\\ASD-LWT-VN-B8700.zip",
    "type": "zip"
  },
  "providedSources": [
    {
      "path": "C:\\\\...\\\\OneDrive_2023-07-05.zip",
      "type": "archive",
      "role": "provided-master"
    }
  ],
  "resolvedArtifacts": {
    "mainDwg": null,
    "boringen": [],
    "vergunningen": [],
    "kastoverzicht": [],
    "hbDocuments": [],
    "measurementSets": []
  }
}
```

## Bloque 1 - Construccion del arbol VN

### Objetivo

Crear una carpeta de salida consistente, independientemente de como venga ordenada la entrada.

### Regla de nombrado

La salida debe llamarse siempre con el `projectCode`:

```text
<outputRoot>\<projectCode>\
```

Ejemplo:

```text
...\Generated\ASD-LWT-VN-B8700\
```

### Estructura que siempre debe crearse

Aunque no se conozca aun el contenido final, la herramienta debe crear siempre:

```text
<projectCode>\
  Boringen\
  Gebouwen\
  Klanten\
  Vergunningen\
```

No debe esperar a tener todos los ficheros para crear la estructura.

### Ficheros raiz esperados

Estos ficheros deben reservarse como salidas objetivo del pipeline:

- `<projectCode>.mdb`
- `<projectCode>.dwg`
- `Checks.htm`
- `Crc.txt`
- `Email.txt`
- `Routes.txt`

En bloques 1 y 2 solo se resuelven o copian:

- `<projectCode>.dwg`

Se crean placeholders logicos, pero no contenido final, para:

- `<projectCode>.mdb`
- `Checks.htm`
- `Crc.txt`
- `Email.txt`
- `Routes.txt`

### Politica de construccion

- Si existe un paquete aceptado previo:
  - puede usarse como plantilla estructural, no como verdad absoluta
- Si no existe paquete aceptado:
  - la estructura se crea desde cero usando las reglas de este documento
- Nunca se debe copiar el `zip` o `rar` entero dentro de la salida final

### Politica de colisiones

Si la salida ya existe:

- modo recomendado: crear una carpeta de trabajo nueva
- modo alternativo: vaciar solo la carpeta generada por la app
- nunca mezclar sin control con restos de una ejecucion anterior

## Bloque 2 - Ingesta, normalizacion y copia documental

### Objetivo

Descubrir fuentes documentales heterogeneas y trasladarlas al arbol VN final con nombres y ubicaciones coherentes.

### Orden de prioridad de fuentes

Para cada tipo documental, la app debe aplicar esta prioridad:

1. Fuente provista revisada mas cercana al caso
2. Fuente en `Aanvullende informatie`
3. Fuente dentro de un paquete auxiliar
4. Fuente dentro del paquete aceptado previo, solo como fallback

La herramienta debe registrar siempre de donde ha salido cada fichero final.

## Descubrimiento de artefactos

### 1. DWG principal

#### Candidatos observados

- `*_eindrevisie*.dwg`
- `*_Revise_*.dwg`
- `*.dwg` en raiz de OAP o proyecto
- `Topo.dwg`

#### Regla

- priorizar `eindrevisie` o `revise`
- usar `Topo.dwg` solo como apoyo, no como `DWG` principal del `VN`
- cuando haya varios OAPs provistos:
  - no fusionar automaticamente en bloque 2
  - registrar cada OAP como fuente y dejar la consolidacion para un bloque posterior

#### Salida

- copiar el `DWG` principal resuelto a:

```text
<projectCode>\<projectCode>.dwg
```

### 2. Boringen

#### Candidatos observados

- `Boorprofielen/*.dwg`
- `Boorprofielen/*.pdf`
- otros `*.pdf` y `*.dwg` identificados como boring

#### Regla

- copiar solo revisiones finales o marcadas como validas
- excluir borradores cuando el nombre indique claramente diseno o provisional, salvo que no exista alternativa
- mantener nombre original del fichero

#### Salida

```text
<projectCode>\Boringen\<ficheros>
```

## Hallazgos MDB VN

### Tablas que se rellenan siempre

En los tres ejemplos aceptados se rellenan de forma consistente:

- `POP`
- `CBN`
- `ODF`
- `AfwerkODF`
- `Traject`
- `Duct`
- `Mantelbuis`
- `Kabel`
- `Accesspoint`
- `Vergunning` en casos concretos

En los tres ejemplos aparecen vacias:

- `Klant`
- `Las`
- `SpliceBox`
- `Patch`
- `Type`
- `Ductlas`

### Relaciones confirmadas

- `CBN.count = POP.count`
- `Kabel.count = POP.count - 1`
- `ODF.count = Kabel.count * 2`
- `AfwerkODF.count = Kabel.count * 192`

Estas relaciones se cumplen en `Bodm`, `De Punt` y `Musseum`.

### Fuente probable por tabla

- `Kabel`: rutas `K@...` en `Routes.txt`
- `Traject`: tramos `T@...` en `Routes.txt`
- `Duct`: `Routes.txt` mas reparto fijo de subductos por tramo
- `Accesspoint`: DWG final mas topologia de `Routes.txt`
- `Mantelbuis`: boorprofielen / boringen y coordenadas finales
- `Vergunning`: carpeta `Vergunningen` y metadatos de los PDF
- `POP`: necesita etiqueta, direccion y coordenada final por POP/OAP
- `CBN`, `ODF`, `AfwerkODF`: dependen del `Kastoverzicht` / `Template PON Kastoverzicht POP.xlsx` y de la relacion de cables

### Regla cerrada para documentos y mediciones

- Los documentos finales del entorno VN no se generan.
- Los ficheros de medicion `SOR` no se generan.
- Ambos se toman de `Aanvullende informatie` y se copian a la salida final:
  - documentacion final a `Gebouwen`, `Boringen` o `Vergunningen` segun corresponda
  - mediciones `SOR` y sus adjuntos a `Gebouwen\<edificio>\Meetgegevens\<destino>`

### Reglas confirmadas de Duct

- Tramo troncal `Txx-Syy`: genera `7` filas en `Duct` con tipo `7MK10-DB_WP01`
- Subductos troncales observados: `RD`, `WT`, `GL`, `BL`, `GZ`, `VI`, `BR`
- Ramal final `Txx-0n-S01`: genera `2` filas en `Duct` con tipo `2MK10-DB_WP01`
- Subductos de ramal observados: `RD` y `WT`
- El cable se asigna al subducto segun la secuencia de `K@...` en `Routes.txt`

### Huecos aun no resueltos

- En los datos crudos no siempre aparece una fuente obvia para la etiqueta final de cada OAP/POP
  - en `De Punt` los nombres tipo `ASD-GMK`, `ASD-GMG`, `ASD-GMD` aparecen en `GOFC Export`
  - en `Musseum`, con lo revisado hasta ahora, la fuente cruda de las etiquetas OAP finales aun no esta cerrada
- No esta cerrada todavia la regla exacta de numeracion final de `ODF` y la asignacion completa de `AfwerkODF`
- No esta cerrada todavia la reconstruccion al 100% de `Mantelbuis` sin apoyarse en una entrega aceptada
- Si un caso no trae `Routes.txt` desde el flujo CTTH, la topologia completa de `Kabel`, `Traject` y `Duct` no se puede reconstruir con certeza solo con lo analizado hasta ahora

### 3. Vergunningen

#### Candidatos observados

- `Vergunning/Gemeente/*`
- `Vergunning/Boring/*`
- `Instemming*.pdf`
- dibujos de instemming en subcarpetas

#### Regla

- crear siempre `Vergunningen\`
- copiar contenido solo cuando exista material real util
- preservar subcarpetas significativas cuando ya vengan organizadas por tipo o emisor
- no inventar nombres nuevos si el nombre original ya identifica bien el documento

#### Salida

```text
<projectCode>\Vergunningen\...
```

### 4. Kastoverzicht

#### Candidatos observados

- `Kastoverzicht OAP/*.pdf`
- `Template PON Kastoverzicht POP.xlsx`
- `PON Kastoverzicht POP *.xlsx`
- `Kastoverzicht *.pdf`

#### Regla

- no imponer aun un formato unico
- si existe un kastoverzicht final util, copiarlo a:

```text
<projectCode>\Gebouwen\<mainBuildingName>\
```

- si solo existe plantilla o soporte:
  - copiarla tambien, pero marcarla en manifest como `template`, no como `final`

### 5. Meetgegevens

#### Candidatos observados

- carpetas de `SOR`
- `Meetfiles.zip`
- `Meetrapport *.pdf`
- `Meetrapport *.xlsx`

#### Regla

- este es el artefacto mas importante de bloque 2
- conservar jerarquia funcional:
  - origen/destino
  - ida/vuelta
  - grupos `1-48`, `49-96` cuando existan
- mantener nombres originales de `SOR`
- copiar reportes asociados junto a la ruta correspondiente
- si la fuente viene comprimida, descomprimir primero a staging interno

#### Salida canonica

```text
<projectCode>\Gebouwen\<mainBuildingName>\Meetgegevens\<remoteNode>\...
```

Donde:

- `<mainBuildingName>` suele coincidir con el nodo principal del caso
  - `AMR-BDB`
  - `ASD-11D`
  - `ASD-Z`

### 6. HB-documenten

#### Regla

- no se ha observado que aparezcan en el paquete final aceptado de forma consistente
- por tanto, no deben copiarse al `VN` final en bloques 1 y 2
- deben quedar como fuente de apoyo en staging o manifest

### 7. GOFC Export / CSV / XLSX auxiliares

#### Regla

- no deben pasar al arbol final en bloques 1 y 2
- su papel es alimentar generacion de `.mdb` o revisiones posteriores
- deben indexarse en el manifest con su origen

### 8. Reactiedocumenten / RD

#### Regla

- no forman parte del paquete final `VN`
- no copiar al arbol final
- indexar en manifest para fases posteriores de correccion

## Normalizacion de nombres y carpetas

### Regla general

- preservar nombres originales siempre que no rompan la estructura final
- no castellanizar ni traducir nombres holandeses
- corregir solo cuando exista una regla de entrega clara

### Reglas permitidas en bloque 2

- normalizar separadores de carpeta
- quitar ficheros temporales de Office como `~$*.doc`
- excluir `bak`, `tmp`, descargas parciales y ficheros de sistema
- excluir carpetas o ficheros que sean claramente de trabajo intermedio

### Reglas no permitidas aun

- renombrar `SOR` en masa
- reinterpretar rutas OTDR
- deducir `Routes.txt`
- cambiar el nombre del edificio principal por heuristica insegura

## Staging interno recomendado

Antes de construir la salida final, la app debe crear un staging temporal:

```text
%TEMP%\cr-vn-staging\<projectCode>\
```

Uso del staging:

- descomprimir zips/rar
- detectar duplicados
- clasificar fuentes por tipo
- resolver conflictos antes de copiar a la salida final

## Registro de trazabilidad obligatorio

Cada fichero copiado al arbol final debe quedar anotado en un manifest de construccion:

```json
{
  "target": "Gebouwen/ASD-Z/Meetgegevens/ASD-GMZ/ASD-GMZ naar ASD-Z/0001.SOR",
  "source": "C:\\\\...\\\\OneDrive_2023-07-05.zip::De punt/.../0001.SOR",
  "sourceKind": "archive-entry",
  "resolutionRule": "best-measurement-source",
  "copied": true
}
```

## Criterios de aceptacion de bloque 1

- crea siempre el arbol VN base
- nombra correctamente la carpeta de salida
- reserva la posicion de los ficheros raiz obligatorios
- no mezcla restos de ejecuciones previas

## Criterios de aceptacion de bloque 2

- localiza y copia un `DWG` principal valido
- rellena `Boringen\` con revisiones utiles
- crea `Vergunningen\` y la puebla cuando haya documentos reales
- construye `Gebouwen\<mainBuilding>\Meetgegevens\...` con `SOR` y reportes
- copia `Kastoverzicht` cuando exista
- no copia `RD`, `HB-documenten`, `GOFC Export` ni auxiliares no finales al arbol de entrega
- genera manifest de trazabilidad

## Huecos que siguen pendientes

Estos puntos siguen fuera de alcance o sin trazabilidad cerrada:

- generacion exacta de `Routes.txt`
- generacion exacta de `Checks.htm`
- contenido y formato final de `Email.txt`
- algoritmo y alcance de `Crc.txt`
- reglas de consolidacion de multiples OAPs en una sola entrega `VN`
- criterio exacto para elegir entre varios `Kastoverzicht` o varios `DWG` candidatos

## Siguiente paso recomendado

Implementar primero un `builder` interno con dos comandos:

1. `discover-vn-sources`
   - genera el manifest normalizado de entrada
2. `build-vn-tree`
   - crea el arbol final y copia contenidos documentales segun este documento

Solo despues de estabilizar esos dos comandos debe arrancar el bloque 3:

- generacion y correccion de `.mdb`
