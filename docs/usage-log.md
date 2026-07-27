# Usage Log

La app puede enviar un evento silencioso al arrancar para registrar quien la abre. Si no hay endpoint configurado, no hay conexion o el endpoint falla, no se muestra ningun error al usuario.

## Datos enviados

- `event`: siempre `app_launch`
- `app`: `Fiber MDB Generator`
- `version`: version instalada
- `username`: usuario de Windows
- `computerName`: nombre del PC
- `userDomain`: dominio/grupo de Windows si existe
- `timestamp`: fecha/hora ISO
- `platform`, `arch`, `osRelease`, `locale`, `packaged`

## Formas de configurar el endpoint

La app busca el endpoint en este orden:

1. Variable de entorno `FIBER_MDB_USAGE_LOG_ENDPOINT`
2. `C:\ProgramData\Fiber MDB Generator\usage-log-endpoint.json`
3. `C:\ProgramData\Fiber MDB Generator\usage-log-endpoint.txt`
4. `app\assets\usage-log-endpoint.json`
5. `app\assets\usage-log-endpoint.txt`
6. Asset de la ultima release de GitHub llamado `usage-log-endpoint.json` o `usage-log-endpoint.txt`

El fichero `.txt` puede contener solo la URL HTTPS. El `.json` permite controlar formato:

```json
{
  "endpoint": "https://script.google.com/macros/s/XXXX/exec",
  "format": "json"
}
```

## Ejemplo Google Apps Script

Crear una Google Sheet privada y desplegar este Apps Script como Web App con acceso para cualquiera que tenga la URL:

```javascript
const SHEET_NAME = 'usage_log';

function doPost(e) {
  const payload = JSON.parse(e.postData.contents || '{}');
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME)
    || SpreadsheetApp.getActiveSpreadsheet().insertSheet(SHEET_NAME);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'timestamp',
      'username',
      'computerName',
      'userDomain',
      'version',
      'osRelease',
      'locale',
      'raw'
    ]);
  }

  sheet.appendRow([
    payload.timestamp || new Date().toISOString(),
    payload.username || '',
    payload.computerName || '',
    payload.userDomain || '',
    payload.version || '',
    payload.osRelease || '',
    payload.locale || '',
    JSON.stringify(payload)
  ]);

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

La URL del Web App se puede subir como asset `usage-log-endpoint.json` en la ultima release para activar el log sin publicar una nueva version.
