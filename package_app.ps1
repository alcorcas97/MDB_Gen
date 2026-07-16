param(
    [string]$OutputDirectory = '.\dist',
    [string]$DeliveryDirectory = $null,
    [ValidateSet('portable', 'dir', 'nsis', 'all')]
    [string]$Target = 'all',
    [switch]$CreateZip = $false
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$rootPath = (Get-Location).Path

function Get-DefaultDeliveryDirectory {
    param([string]$SelectedTarget)

    switch ($SelectedTarget) {
        'portable' { return '.\Entrega\Fiber MDB Generator Portable' }
        'nsis' { return '.\Entrega\Fiber MDB Generator Installer' }
        'dir' { return '.\Entrega\Fiber MDB Generator' }
        default { return '.\Entrega\Fiber MDB Generator Release' }
    }
}

function Assert-PathInsideProject {
    param([string]$TargetPath)

    if (-not $TargetPath.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Ruta fuera del proyecto: $TargetPath"
    }
}

function Get-ReleaseLabel {
    param([string]$TargetName)

    switch ($TargetName) {
        'portable' { return 'Portable' }
        'nsis' { return 'Installer' }
        default { return 'App' }
    }
}

function Get-DeliveryExeName {
    param([string]$TargetName)

    switch ($TargetName) {
        'portable' { return 'Fiber MDB Generator Portable.exe' }
        'nsis' { return 'Fiber MDB Generator Installer.exe' }
        default { return 'Fiber MDB Generator.exe' }
    }
}

function Get-DeliveryReadme {
    param([string]$TargetName)

    switch ($TargetName) {
        'portable' {
            return @'
Fiber MDB Generator Portable

Uso:
1. Ejecuta "Fiber MDB Generator Portable.exe".
2. No requiere instalacion.
3. Puedes copiarlo a otra carpeta o a un USB y abrirlo desde alli.

Nota:
- Este equipo necesita el motor de Microsoft Access y Excel (ACE/DAO).
- El portable guarda su configuracion de usuario en el perfil de Windows.
'@
        }

        'nsis' {
            return @'
Fiber MDB Generator Installer

Uso:
1. Ejecuta "Fiber MDB Generator Installer.exe".
2. Si ya existe una instalacion previa de Fiber MDB Generator, el instalador la actualiza a esta version.
3. Si no existe, la instala desde cero en el equipo.
4. Puedes elegir la carpeta de instalacion durante el asistente.

Nota:
- Este equipo necesita el motor de Microsoft Access y Excel (ACE/DAO).
- El instalador crea accesos directos de inicio y escritorio.
'@
        }

        default {
            return @'
Fiber MDB Generator

Uso:
1. Abre "Fiber MDB Generator.exe" desde esta misma carpeta.
2. No separes el EXE de los demas ficheros que lo acompanian.
3. Selecciona Template MDB, FC Excel, BC CSV y la carpeta del proyecto.
4. Elige el fichero MDB de salida.
5. Pulsa "Generar MDB".

Nota:
- Este equipo necesita el motor de Microsoft Access y Excel (ACE/DAO).
- Esta entrega usa la app desempaquetada para que el arranque visual sea mas inmediato.
'@
        }
    }
}

function Get-TopLevelExeArtifact {
    param([string]$OutputPath)

    $artifacts = @(
        Get-ChildItem -LiteralPath $OutputPath -File -Filter *.exe |
        Sort-Object LastWriteTime -Descending
    )

    if ($artifacts.Count -eq 0) {
        throw "No se ha encontrado ningun artefacto .exe en $OutputPath"
    }

    return $artifacts[0].FullName
}

function Invoke-BuildTarget {
    param(
        [string]$TargetName,
        [string]$OutputPath,
        [string]$DeliveryPath,
        [switch]$CreateZipArtifact
    )

    if (Test-Path -LiteralPath $OutputPath) {
        Remove-Item -LiteralPath $OutputPath -Recurse -Force
    }

    if (Test-Path -LiteralPath $DeliveryPath) {
        Remove-Item -LiteralPath $DeliveryPath -Recurse -Force
    }

    [void](New-Item -ItemType Directory -Path $OutputPath -Force)
    [void](New-Item -ItemType Directory -Path $DeliveryPath -Force)

    Write-Host "Compilando app Electron para Windows ($TargetName)..."

    & node .\node_modules\electron-builder\cli.js --win $TargetName "--config.directories.output=$OutputPath" | Out-Host
    $builderExitCode = $LASTEXITCODE

    if ($builderExitCode -ne 0) {
        throw "La compilacion ha fallado y no se ha generado el artefacto '$TargetName'."
    }

    $deliveryExePath = Join-Path -Path $DeliveryPath -ChildPath (Get-DeliveryExeName $TargetName)
    $deliveryReadmePath = Join-Path -Path $DeliveryPath -ChildPath 'LEEME.txt'
    $deliveryHashPath = Join-Path -Path $DeliveryPath -ChildPath 'SHA256.txt'
    $zipArtifactPath = Join-Path -Path $DeliveryPath -ChildPath 'Fiber-MDB-Generator-win-unpacked.zip'

    if ($TargetName -eq 'dir') {
        $unpackedDirectory = Join-Path -Path $OutputPath -ChildPath 'win-unpacked'
        if (-not (Test-Path -LiteralPath $unpackedDirectory)) {
            throw "No se ha encontrado la carpeta desempaquetada en $unpackedDirectory"
        }

        Copy-Item -Path (Join-Path -Path $unpackedDirectory -ChildPath '*') -Destination $DeliveryPath -Recurse -Force
    }
    else {
        $artifactPath = Get-TopLevelExeArtifact -OutputPath $OutputPath
        Copy-Item -LiteralPath $artifactPath -Destination $deliveryExePath -Force
    }

    if (-not (Test-Path -LiteralPath $deliveryExePath)) {
        throw "No se ha encontrado el ejecutable final de entrega en $deliveryExePath"
    }

    $hash = (Get-FileHash -LiteralPath $deliveryExePath -Algorithm SHA256).Hash
    Set-Content -LiteralPath $deliveryHashPath -Value $hash -Encoding ASCII
    Set-Content -LiteralPath $deliveryReadmePath -Value (Get-DeliveryReadme $TargetName) -Encoding ASCII

    if ($TargetName -eq 'dir' -and $CreateZipArtifact) {
        if (Test-Path -LiteralPath $zipArtifactPath) {
            Remove-Item -LiteralPath $zipArtifactPath -Force
        }

        Write-Host 'Generando zip distribuible desde la carpeta desempaquetada...'
        Compress-Archive -Path (Join-Path -Path $DeliveryPath -ChildPath '*') -DestinationPath $zipArtifactPath -Force
    }

    return [pscustomobject]@{
        Target        = $TargetName
        DeliveryPath  = $DeliveryPath
        Executable    = $deliveryExePath
        Hash          = $hash
        ZipArtifact   = if (Test-Path -LiteralPath $zipArtifactPath) { $zipArtifactPath } else { $null }
    }
}

$defaultDeliveryDirectory = if ($null -ne $DeliveryDirectory -and $DeliveryDirectory.Trim() -ne '') {
    $DeliveryDirectory
}
else {
    Get-DefaultDeliveryDirectory -SelectedTarget $Target
}

$resolvedOutputDirectory = [System.IO.Path]::GetFullPath((Join-Path -Path $rootPath -ChildPath $OutputDirectory))
$resolvedDeliveryDirectory = [System.IO.Path]::GetFullPath((Join-Path -Path $rootPath -ChildPath $defaultDeliveryDirectory))

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

Write-Host 'Generando icono de la app...'

& node .\tools\generate_app_icon.cjs
if ($LASTEXITCODE -ne 0) {
    throw 'No se pudo generar el icono de la app.'
}

$targetsToBuild = if ($Target -eq 'all') { @('portable', 'nsis') } else { @($Target) }
$buildResults = @()

foreach ($targetName in $targetsToBuild) {
    $targetOutputDirectory = if ($Target -eq 'all') {
        Join-Path -Path $resolvedOutputDirectory -ChildPath $targetName
    }
    else {
        $resolvedOutputDirectory
    }

    $targetDeliveryDirectory = if ($Target -eq 'all') {
        Join-Path -Path $resolvedDeliveryDirectory -ChildPath (Get-ReleaseLabel $targetName)
    }
    else {
        $resolvedDeliveryDirectory
    }

    Assert-PathInsideProject -TargetPath $targetOutputDirectory
    Assert-PathInsideProject -TargetPath $targetDeliveryDirectory

    $buildResults += Invoke-BuildTarget -TargetName $targetName -OutputPath $targetOutputDirectory -DeliveryPath $targetDeliveryDirectory -CreateZipArtifact:$CreateZip
}

$summaryPath = if ($Target -eq 'all') {
    Join-Path -Path $resolvedDeliveryDirectory -ChildPath 'RESUMEN.txt'
}
else {
    $null
}

if ($null -ne $summaryPath) {
    $summaryLines = @(
        'Fiber MDB Generator Release'
        ''
    )

    foreach ($result in $buildResults) {
        $summaryLines += @(
            ('Target:    ' + $result.Target)
            ('Entrega:   ' + $result.DeliveryPath)
            ('EXE:       ' + $result.Executable)
            ('SHA256:    ' + $result.Hash)
        )

        if ($null -ne $result.ZipArtifact) {
            $summaryLines += ('ZIP:       ' + $result.ZipArtifact)
        }

        $summaryLines += ''
    }

    Set-Content -LiteralPath $summaryPath -Value $summaryLines -Encoding ASCII
}

if (Test-Path -LiteralPath $resolvedOutputDirectory) {
    Remove-Item -LiteralPath $resolvedOutputDirectory -Recurse -Force
}

Write-Host ''
Write-Host 'Artefactos disponibles:'
foreach ($result in $buildResults) {
    Write-Host "  [$($result.Target)]"
    Write-Host "    Entrega: $($result.DeliveryPath)"
    Write-Host "    EXE:     $($result.Executable)"
    Write-Host "    SHA256:  $($result.Hash)"
    if ($null -ne $result.ZipArtifact) {
        Write-Host "    ZIP:     $($result.ZipArtifact)"
    }
}

if ($null -ne $summaryPath) {
    Write-Host "  Resumen:  $summaryPath"
}
