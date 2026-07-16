# Fiber MDB Generator

Este proyecto ya tiene dos formas de uso:

1. `generate_mdb.ps1` como motor por línea de comandos.
2. Una app de escritorio Electron para seleccionar rutas y generar el `.mdb` sin tocar comandos.

## Requisitos

Antes del primer uso:

```cmd
npm install
```

En el equipo donde se vaya a generar la base tiene que estar disponible el motor de Microsoft Access y Excel:

- `DAO.DBEngine.120`
- `Microsoft.ACE.OLEDB.12.0`

Sin eso, la app y el script no podrán leer el Excel ni escribir la `.mdb`.

## Uso Con La App

En desarrollo:

```cmd
npm run app:dev
```

La app pide estas rutas:

- `template.mdb`
- `FC ...xlsx`
- `BC ...csv`
- carpeta del proyecto, por ejemplo `RT-CMA-B11878`
- fichero `.mdb` de salida

La app hace esto:

- detecta el `.dwg` principal y saca coordenadas de `Accesspoint` y `SpliceBox`
- lee los PDF de `Vergunningen` y toma la fecha mas tardia como inicio
- suma 1 ano para la fecha final del vergunning
- busca carpetas en `Gebouwen` para resolver `COMPLEX`
- llama al generador PowerShell con un `metadata.json` temporal

## App Compilada

La salida final puede generarse como:

- portable de un solo `.exe`
- instalador de Windows que instala o actualiza una instalacion previa
- carpeta `win-unpacked` para pruebas internas

Para evitar el bloqueo anterior con `winCodeSign`, la configuracion de Windows usa `signAndEditExecutable = false`.

Para empaquetar de forma practica:

```cmd
package_app.cmd -Target all
```

O:

```powershell
powershell -ExecutionPolicy Bypass -File .\package_app.ps1 -Target all
```

Eso deja la entrega limpia en:

- `Entrega\Fiber MDB Generator Release\Portable`
- `Entrega\Fiber MDB Generator Release\Installer`
- `Entrega\Fiber MDB Generator Release\RESUMEN.txt`

Para sacar solo el portable:

```powershell
powershell -ExecutionPolicy Bypass -File .\package_app.ps1 -Target portable
```

Para sacar solo el instalador:

```powershell
powershell -ExecutionPolicy Bypass -File .\package_app.ps1 -Target nsis
```

Si ademas quieres pedir un `.zip` del contenido descomprimido de la version `dir`:

```powershell
powershell -ExecutionPolicy Bypass -File .\package_app.ps1 -Target dir -CreateZip
```

El instalador usa el mismo `appId`, asi que sirve tanto para instalar en un PC nuevo como para actualizar una instalacion anterior de la app a la version actual.

## Uso Del Script

Tambien se puede seguir usando el motor directamente:

```powershell
powershell -ExecutionPolicy Bypass -File .\generate_mdb.ps1 `
  -TemplatePath .\template.mdb `
  -FcPath '.\FC RT-CMA-B11878.xlsx' `
  -BcPath '.\BC RT-CMA-B11878.csv' `
  -OutputPath '.\RT-CMA-B11878.generated.mdb'
```

O con el `.cmd`:

```cmd
generate_mdb.cmd -TemplatePath .\template.mdb -FcPath ".\FC RT-CMA-B11878.xlsx" -BcPath ".\BC RT-CMA-B11878.csv" -OutputPath ".\RT-CMA-B11878.generated.mdb"
```

## Tablas Que Se Rellenan

- `POP`
- `Vergunning`
- `CBN`
- `ODF`
- `AfwerkODF`
- `Traject`
- `Duct`
- `Accesspoint`
- `SpliceBox`
- `Kabel`
- `Klant`
- `Las`

## Reglas Actuales

- Las coordenadas de `POP` y `Vergunning` se escriben a `0`.
- Las coordenadas de `Accesspoint` y `SpliceBox` se leen del `.dwg` principal.
- `Accesspoint.Z = -60` cuando el tipo es `HH_29030_AT02` y `0` para el resto.
- Los drop cables salen como `2V_DBC_PR01`.
- Los `Accesspoint` y `SpliceBox` salen como perfil normal (`HH_29030_AT02` / `LM_29050_AT01`) salvo que el segmento de fibras del DP sea mayor de `48`, en cuyo caso usa perfil BUDI (`LB_BUDI-M-SP-A_TY01`).
- `Kastnr` del cliente se rellena con `FTU locatie` del FC.
- `FTUType` del cliente se rellena como `FTU_TK01` cuando `Opleverstatus = 2`.
- En `Kabel`, los drops escriben `Afwerkeenheid_B = FTU locatie` solo cuando `Opleverstatus = 2`.
- `Locatienaam_B` del drop conserva `KAMER` cuando existe.
- `COMPLEX` del cliente se intenta resolver desde las carpetas de `Gebouwen`.
- `Vergunning` toma la fecha mas tardia encontrada en los PDF de `Vergunningen` como inicio y suma `1` ano para la fecha final.
- `Duct` se genera con dos subductos por trayecto (`RD` con cable y `WT` vacio), siguiendo el patron del ejemplo.
- `Las` se genera por reglas de segmento:
  - pass-through en `cassette 0`
  - parking de fibra `2` en los primeros cassettes del segmento
  - splices o unused de la fibra activa en el segundo bloque de cassettes
  - placeholders de un solo registro hasta `cassette 16`

## Limitaciones Conocidas

- No rellena `Mantelbuis`, `Patch` ni `Ductlas`.
- Si en un proyecto aparecen tipos de drop distintos de `2V_DBC_PR01`, hay que ajustar esa regla.
- El generador usa `FC` y `BC` como fuente de verdad. Los `crosscheck` se usan solo como referencia de estructura y reglas.
