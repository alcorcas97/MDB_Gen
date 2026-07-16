param(
    [string]$PackageZip = 'FiberMDBGenerator-win-unpacked.zip'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$zipPath = Join-Path $scriptRoot $PackageZip
if (-not (Test-Path -LiteralPath $zipPath)) {
    throw "No se ha encontrado el paquete comprimido: $zipPath"
}

$extractRoot = Join-Path $env:TEMP ("fiber-mdb-install-" + [guid]::NewGuid().ToString('N'))
$targetRoot = Join-Path ${env:ProgramFiles} 'Fiber MDB Generator'

try {
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force

    $sourceRoot = Join-Path $extractRoot 'win-unpacked'
    if (-not (Test-Path -LiteralPath $sourceRoot)) {
        throw "No se ha encontrado la carpeta win-unpacked en $extractRoot"
    }

    if (-not (Test-Path -LiteralPath $targetRoot)) {
        New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
    }

    $null = robocopy $sourceRoot $targetRoot /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP

    $exePath = Join-Path $targetRoot 'Fiber MDB Generator.exe'
    if (-not (Test-Path -LiteralPath $exePath)) {
        throw "No se ha encontrado el ejecutable instalado: $exePath"
    }

    $wsh = New-Object -ComObject WScript.Shell
    foreach ($shortcutPath in @(
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Fiber MDB Generator.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Programs')) 'Fiber MDB Generator.lnk')
    )) {
        $shortcut = $wsh.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $exePath
        $shortcut.WorkingDirectory = $targetRoot
        $shortcut.IconLocation = "$exePath,0"
        $shortcut.Save()
    }
}
finally {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
}
