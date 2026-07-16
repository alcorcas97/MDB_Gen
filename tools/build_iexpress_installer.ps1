param(
    [string]$Version = '',
    [string]$SourceFolder = '.\dist\win-unpacked',
    [string]$OutputDirectory = '.\Entrega\Fiber MDB Generator Installer',
    [string]$PackageName = 'Fiber MDB Generator Installer.exe'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$rootPath = (Get-Location).Path
if ([string]::IsNullOrWhiteSpace($Version)) {
    $packageJson = Join-Path $rootPath 'package.json'
    $Version = (Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json).version
}

$sourceRoot = [System.IO.Path]::GetFullPath((Join-Path $rootPath $SourceFolder))
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $rootPath $OutputDirectory))
$stageRoot = Join-Path $outputRoot 'iexpress-stage'
$payloadZip = Join-Path $stageRoot 'FiberMDBGenerator-win-unpacked.zip'
$installerPath = Join-Path $outputRoot $PackageName
$sedPath = Join-Path $stageRoot 'fiber-mdb-generator-installer.sed'
$installCmdSource = Join-Path $rootPath 'tools\iexpress\install.cmd'
$installPs1Source = Join-Path $rootPath 'tools\iexpress\install.ps1'
$bootstrapSource = Join-Path $rootPath 'tools\iexpress\BootstrapInstaller.cs'
$bootstrapOutput = Join-Path $outputRoot $PackageName

if (-not (Test-Path -LiteralPath $sourceRoot)) {
    throw "No existe la carpeta fuente: $sourceRoot"
}

if (Test-Path -LiteralPath $outputRoot) {
    Remove-Item -LiteralPath $outputRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

Copy-Item -LiteralPath $installCmdSource -Destination (Join-Path $stageRoot 'install.cmd') -Force
Copy-Item -LiteralPath $installPs1Source -Destination (Join-Path $stageRoot 'install.ps1') -Force

$sevenZipExe = Join-Path $rootPath 'node_modules\7zip-bin\win\x64\7za.exe'
if (Test-Path -LiteralPath $sevenZipExe) {
    Push-Location (Split-Path -Parent $sourceRoot)
    try {
        & $sevenZipExe a -tzip -mx=1 $payloadZip (Split-Path -Leaf $sourceRoot) | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "7za ha fallado con codigo $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}
else {
    Compress-Archive -Path $sourceRoot -DestinationPath $payloadZip -Force
}

$sedContent = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=Fiber MDB Generator $Version instalado correctamente.
TargetName=$installerPath
FriendlyName=Fiber MDB Generator Installer $Version
AppLaunched=install.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=install.cmd
UserQuietInstCmd=install.cmd
SourceFiles=SourceFiles
[Strings]
FILE0=install.cmd
FILE1=install.ps1
FILE2=FiberMDBGenerator-win-unpacked.zip
[SourceFiles]
SourceFiles0=$stageRoot
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
"@

Set-Content -LiteralPath $sedPath -Value $sedContent -Encoding ASCII

& "$env:SystemRoot\System32\iexpress.exe" /N $sedPath | Out-Host
if ($LASTEXITCODE -ne 0) {
    $cscCandidates = @(
        "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
        "$env:SystemRoot\Microsoft.NET\Framework\v4.0.30319\csc.exe"
    )
    $cscPath = @($cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1)
    if ($cscPath.Count -eq 0) {
        throw "IExpress ha fallado con codigo $LASTEXITCODE y no se ha encontrado csc.exe para generar el instalador alternativo."
    }

    & $cscPath[0] /target:winexe /out:$bootstrapOutput /reference:System.Windows.Forms.dll $bootstrapSource | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "IExpress ha fallado con codigo $LASTEXITCODE y la compilacion del instalador alternativo tambien ha fallado."
    }
}

if (-not (Test-Path -LiteralPath $installerPath)) {
    throw "No se ha generado el instalador esperado: $installerPath"
}

Copy-Item -LiteralPath (Join-Path $stageRoot 'install.cmd') -Destination (Join-Path $outputRoot 'install.cmd') -Force
Copy-Item -LiteralPath (Join-Path $stageRoot 'install.ps1') -Destination (Join-Path $outputRoot 'install.ps1') -Force
Copy-Item -LiteralPath $payloadZip -Destination (Join-Path $outputRoot 'FiberMDBGenerator-win-unpacked.zip') -Force

Set-Content -LiteralPath (Join-Path $outputRoot 'LEEME.txt') -Value @"
Fiber MDB Generator Installer $Version

Uso:
1. Ejecuta "Fiber MDB Generator Installer.exe".
2. Acepta el aviso de Windows si solicita permisos.
3. El instalador copiara la app a C:\Program Files\Fiber MDB Generator.
4. Mantén juntos el EXE, el ZIP y los scripts de esta misma carpeta.
"@ -Encoding UTF8

Write-Output $installerPath
