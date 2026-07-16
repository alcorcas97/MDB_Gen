param(
    [string]$OutputDirectory = '.\dist-cr',
    [string]$DeliveryDirectory = '.\Entrega\CR VN Studio Installer'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$rootPath = (Get-Location).Path
$resolvedOutputDirectory = [System.IO.Path]::GetFullPath((Join-Path -Path $rootPath -ChildPath $OutputDirectory))
$resolvedDeliveryDirectory = [System.IO.Path]::GetFullPath((Join-Path -Path $rootPath -ChildPath $DeliveryDirectory))

function Assert-PathInsideProject {
    param([string]$TargetPath)

    if (-not $TargetPath.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Ruta fuera del proyecto: $TargetPath"
    }
}

foreach ($targetPath in @($resolvedOutputDirectory, $resolvedDeliveryDirectory)) {
    Assert-PathInsideProject -TargetPath $targetPath
}

if (Test-Path -LiteralPath $resolvedOutputDirectory) {
    Remove-Item -LiteralPath $resolvedOutputDirectory -Recurse -Force
}

if (Test-Path -LiteralPath $resolvedDeliveryDirectory) {
    Remove-Item -LiteralPath $resolvedDeliveryDirectory -Recurse -Force
}

[void](New-Item -ItemType Directory -Path $resolvedOutputDirectory -Force)
[void](New-Item -ItemType Directory -Path $resolvedDeliveryDirectory -Force)

Write-Host 'Compilando instalador de CR VN Studio...'

& node .\node_modules\electron-builder\cli.js --win nsis "--config=$(Join-Path $rootPath 'cr-builder.json')" "--config.directories.output=$resolvedOutputDirectory" | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw 'La compilacion del instalador ha fallado.'
}

$installer = Get-ChildItem -LiteralPath $resolvedOutputDirectory -File -Filter *.exe | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($null -eq $installer) {
    throw 'No se ha encontrado el instalador generado.'
}

$deliveryInstallerPath = Join-Path -Path $resolvedDeliveryDirectory -ChildPath 'CR VN Studio Installer.exe'
$deliveryReadmePath = Join-Path -Path $resolvedDeliveryDirectory -ChildPath 'LEEME.txt'
$deliveryHashPath = Join-Path -Path $resolvedDeliveryDirectory -ChildPath 'SHA256.txt'

Copy-Item -LiteralPath $installer.FullName -Destination $deliveryInstallerPath -Force

$hash = (Get-FileHash -LiteralPath $deliveryInstallerPath -Algorithm SHA256).Hash
Set-Content -LiteralPath $deliveryHashPath -Value $hash -Encoding ASCII
Set-Content -LiteralPath $deliveryReadmePath -Value @'
CR VN Studio Installer

Uso:
1. Ejecuta "CR VN Studio Installer.exe".
2. Instala una app separada de Fiber MDB Generator.
3. La app esta orientada a inspeccion y trazabilidad de casos CR / VN / RD.

Nota:
- Esta entrega genera instalador, no portable.
- La app actual no reemplaza Fiber MDB Generator; conviven como herramientas distintas.
'@ -Encoding ASCII

if (Test-Path -LiteralPath $resolvedOutputDirectory) {
    Remove-Item -LiteralPath $resolvedOutputDirectory -Recurse -Force
}

Write-Host ''
Write-Host 'Artefactos disponibles:'
Write-Host "  Entrega: $resolvedDeliveryDirectory"
Write-Host "  EXE:     $deliveryInstallerPath"
Write-Host "  SHA256:  $hash"
