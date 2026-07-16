param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('RunOpenDocumentCommand', 'PickPointOnOpenDocument')]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$DwgPath,

    [string]$LispPath,

    [string]$CommandName,

    [string]$ProgressPath,
    [string]$OutputPath,
    [string]$PromptText,
    [int]$TimeoutSeconds = 600,
    [switch]$SaveDocument
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Resolve-NormalizedPath {
    param(
        [string]$Path,
        [switch]$AllowMissing
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    if ($AllowMissing) {
        return [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    }

    return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path).TrimEnd('\')
}

function Escape-LispString {
    param([string]$Value)

    return [string]$Value -replace '"', '\"'
}

function Convert-ToLispPath {
    param([string]$Path)

    return ([string]$Path).Replace('\', '/')
}

function Get-ActiveAutoCadApplication {
    $progIds = @(
        'AutoCAD.Application'
    )

    try {
        $registeredProgIds = Get-ChildItem Registry::HKEY_CLASSES_ROOT -ErrorAction SilentlyContinue |
            Where-Object { $_.PSChildName -like 'AutoCAD.Application*' } |
            Sort-Object PSChildName -Descending |
            Select-Object -ExpandProperty PSChildName
        $progIds += $registeredProgIds
    }
    catch {
    }

    foreach ($progId in ($progIds | Select-Object -Unique)) {
        try {
            $application = [System.Runtime.InteropServices.Marshal]::GetActiveObject($progId)
            if ($null -ne $application) {
                return $application
            }
        }
        catch {
        }
    }

    return $null
}

function Get-OpenDocumentByPath {
    param(
        [__ComObject]$Application,
        [string]$TargetPath
    )

    foreach ($document in $Application.Documents) {
        try {
            $documentPath = Resolve-NormalizedPath $document.FullName
            if ($null -ne $documentPath -and $documentPath -ieq $TargetPath) {
                return $document
            }
        }
        catch {
        }
    }

    return $null
}

function Send-DocumentCommand {
    param(
        [__ComObject]$Document,
        [string]$CommandText
    )

    $Document.SendCommand($CommandText + [Environment]::NewLine)
}

function Get-LispFunctionSymbol {
    param([string]$CommandName)

    return 'c:{0}' -f $CommandName
}

function Get-LoadAndRunExpression {
    param(
        [string]$LispPath,
        [string]$CommandName
    )

    $functionSymbol = Get-LispFunctionSymbol -CommandName $CommandName
    $escapedPath = Escape-LispString (Convert-ToLispPath $LispPath)

    return '(if (findfile "{0}") (progn (load "{0}") ({1})) (prompt "\\nFMDB: no se encontro el archivo Lisp {0}"))' -f $escapedPath, $functionSymbol
}

function Get-DocumentExecutionExpression {
    param(
        [string]$LispPath,
        [string]$CommandName
    )

    return '(progn (setvar "FILEDIA" 0) (setvar "CMDECHO" 0) (setvar "SECURELOAD" 0) {0})' -f (Get-LoadAndRunExpression -LispPath $LispPath -CommandName $CommandName)
}

function Test-AutoCadIdle {
    param([__ComObject]$Application)

    try {
        return [bool]$Application.GetAcadState().IsQuiescent
    }
    catch {
        return $true
    }
}

function Get-ProgressText {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8
}

function Wait-ForDocumentCommand {
    param(
        [__ComObject]$Application,
        [string]$ProgressPath,
        [string]$OutputPath,
        [int]$TimeoutSeconds,
        [string]$CommandName
    )

    $deadline = (Get-Date).AddSeconds([Math]::Max(30, $TimeoutSeconds))
    $resolvedOutputPath = Resolve-NormalizedPath -Path $OutputPath -AllowMissing

    while ((Get-Date) -lt $deadline) {
        $progressText = Get-ProgressText $ProgressPath
        $doneMarkerSeen = $null -ne $progressText -and $progressText -match 'FMDB_DONE:'
        $outputReady = $null -ne $resolvedOutputPath -and (Test-Path -LiteralPath $resolvedOutputPath)

        if (($doneMarkerSeen -or $outputReady) -and (Test-AutoCadIdle $Application)) {
            return
        }

        Start-Sleep -Milliseconds 400
    }

    throw "Tiempo de espera agotado ejecutando '$CommandName' sobre el DWG abierto."
}

function Convert-VariantPointToArray {
    param([object]$Point)

    if ($null -eq $Point) {
        return $null
    }

    try {
        if ($Point -is [System.Array]) {
            return @($Point)
        }

        return @([double]$Point[0], [double]$Point[1], [double]$Point[2])
    }
    catch {
        return $null
    }
}

switch ($Mode) {
    'RunOpenDocumentCommand' {
        $resolvedDwgPath = Resolve-NormalizedPath $DwgPath
        $resolvedLispPath = Resolve-NormalizedPath $LispPath
        $resolvedProgressPath = Resolve-NormalizedPath -Path $ProgressPath -AllowMissing
        $resolvedOutputPath = Resolve-NormalizedPath -Path $OutputPath -AllowMissing

        $application = Get-ActiveAutoCadApplication
        if ($null -eq $application) {
            [pscustomobject]@{
                handled = $false
                reason  = 'AutoCADNotRunning'
            } | ConvertTo-Json -Compress
            return
        }

        $document = $null

        try {
            $document = Get-OpenDocumentByPath -Application $application -TargetPath $resolvedDwgPath
            if ($null -eq $document) {
                [pscustomobject]@{
                    handled = $false
                    reason  = 'DocumentNotOpen'
                } | ConvertTo-Json -Compress
                return
            }

            if ($null -ne $resolvedProgressPath -and (Test-Path -LiteralPath $resolvedProgressPath)) {
                Remove-Item -LiteralPath $resolvedProgressPath -Force -ErrorAction SilentlyContinue
            }

            if ($null -ne $resolvedOutputPath -and (Test-Path -LiteralPath $resolvedOutputPath)) {
                Remove-Item -LiteralPath $resolvedOutputPath -Force -ErrorAction SilentlyContinue
            }

            $document.Activate()
            Start-Sleep -Milliseconds 250

            Send-DocumentCommand -Document $document -CommandText (Get-DocumentExecutionExpression -LispPath $resolvedLispPath -CommandName $CommandName)

            Wait-ForDocumentCommand -Application $application -ProgressPath $resolvedProgressPath -OutputPath $resolvedOutputPath -TimeoutSeconds $TimeoutSeconds -CommandName $CommandName

            if ($SaveDocument) {
                $document.Save()
            }

            [pscustomobject]@{
                handled         = $true
                mode            = 'open-document'
                dwgPath         = $resolvedDwgPath
                commandName     = $CommandName
                progressPath    = $resolvedProgressPath
                outputPath      = $resolvedOutputPath
                saveDocument    = [bool]$SaveDocument
            } | ConvertTo-Json -Compress
        }
        finally {
            if ($null -ne $document) {
                [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($document)
            }

            if ($null -ne $application) {
                [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($application)
            }
        }
    }

    'PickPointOnOpenDocument' {
        $resolvedDwgPath = Resolve-NormalizedPath $DwgPath
        $application = Get-ActiveAutoCadApplication
        if ($null -eq $application) {
            [pscustomobject]@{
                handled = $false
                reason  = 'AutoCADNotRunning'
            } | ConvertTo-Json -Compress
            return
        }

        $document = $null
        try {
            $document = Get-OpenDocumentByPath -Application $application -TargetPath $resolvedDwgPath
            if ($null -eq $document) {
                [pscustomobject]@{
                    handled = $false
                    reason  = 'DocumentNotOpen'
                } | ConvertTo-Json -Compress
                return
            }

            $document.Activate()
            Start-Sleep -Milliseconds 250

            $promptMessage = if ([string]::IsNullOrWhiteSpace($PromptText)) {
                'Selecciona un punto'
            }
            else {
                $PromptText.Trim()
            }

            $document.Utility.Prompt("`nFMDB: $promptMessage ")
            $point = $document.Utility.GetPoint([System.Type]::Missing, "`n$promptMessage: ")
            $pointValues = Convert-VariantPointToArray -Point $point

            if ($null -eq $pointValues -or $pointValues.Count -lt 2) {
                throw 'No se ha podido leer el punto seleccionado en AutoCAD.'
            }

            [pscustomobject]@{
                handled = $true
                mode    = 'open-document-pick'
                dwgPath = $resolvedDwgPath
                x       = [double]$pointValues[0]
                y       = [double]$pointValues[1]
                z       = if ($pointValues.Count -ge 3) { [double]$pointValues[2] } else { 0.0 }
            } | ConvertTo-Json -Compress
        }
        finally {
            if ($null -ne $document) {
                [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($document)
            }

            if ($null -ne $application) {
                [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($application)
            }
        }
    }
}
