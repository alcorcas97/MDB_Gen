param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('RunOpenDocumentCommand', 'PickPointOnOpenDocument', 'SetEntityHighlight')]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$DwgPath,

    [string]$LispPath,

    [string]$CommandName,

    [string]$ProgressPath,
    [string]$OutputPath,
    [string]$PromptText,
    [string]$EntityHandle,
    [string]$EntityEndpoints,
    [switch]$Enabled,
    [switch]$Disable,
    [int]$TimeoutSeconds = 600,
    [switch]$SaveDocument
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

try {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FmdbWindowTools {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@ -ErrorAction SilentlyContinue
}
catch {
}

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
            $documentPath = Resolve-NormalizedPath $document.FullName -AllowMissing
            if ($null -ne $documentPath -and $documentPath -ieq $TargetPath) {
                return $document
            }
        }
        catch {
        }
    }

    return $null
}

function Find-AutoCadDocumentForHighlight {
    param([string]$TargetPath)

    $progIds = @('AutoCAD.Application')
    try {
        $progIds += @(Get-ChildItem Registry::HKEY_CLASSES_ROOT -ErrorAction SilentlyContinue |
            Where-Object { $_.PSChildName -like 'AutoCAD.Application.*' } |
            Select-Object -ExpandProperty PSChildName)
    }
    catch { }
    $seen = @{}
    $matches = @()
    $paths = @()
    foreach ($progId in ($progIds | Select-Object -Unique)) {
        try {
            $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject($progId)
            $key = [string]$app.HWND
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            foreach ($doc in $app.Documents) {
                try {
                    $docPath = Resolve-NormalizedPath $doc.FullName -AllowMissing
                    $paths += $docPath
                    if ($docPath -ieq $TargetPath) { $matches += [pscustomobject]@{ application = $app; document = $doc } }
                }
                catch { }
            }
        }
        catch { }
    }
    if ($matches.Count -eq 1) { return $matches[0] }
    $reason = if ($matches.Count -gt 1) { 'AmbiguousDocument' } elseif ($seen.Count -eq 0) { 'AutoCADNotRunning' } else { 'DocumentNotOpen' }
    return [pscustomobject]@{ application = $null; document = $null; reason = "$reason (DWG: $TargetPath; abiertos: $($paths -join ' | '))" }
}

function Send-DocumentCommand {
    param(
        [__ComObject]$Document,
        [string]$CommandText
    )

    $Document.SendCommand($CommandText + [Environment]::NewLine)
}

function Focus-AutoCadWindow {
    param(
        [__ComObject]$Application,
        [__ComObject]$Document,
        [int]$WaitMilliseconds = 600
    )

    try {
        $Application.Visible = $true
    }
    catch {
    }

    try {
        $shell = New-Object -ComObject WScript.Shell
        $hwnd = $null
        try {
            $hwnd = [IntPtr]([int64]$Application.HWND)
        }
        catch {
            $hwnd = $null
        }

        if ($null -ne $hwnd -and $hwnd -ne [IntPtr]::Zero) {
            [void][FmdbWindowTools]::ShowWindowAsync($hwnd, 9)
            $processId = [uint32]0
            [void][FmdbWindowTools]::GetWindowThreadProcessId($hwnd, [ref]$processId)
            if ($processId -gt 0) {
                [void]$shell.AppActivate([int]$processId)
            }
            [void][FmdbWindowTools]::SetForegroundWindow($hwnd)
        }
        elseif (-not [string]::IsNullOrWhiteSpace($Document.Name)) {
            [void]$shell.AppActivate($Document.Name)
        }
        else {
            [void]$shell.AppActivate('AutoCAD')
        }
        if ($WaitMilliseconds -gt 0) {
            Start-Sleep -Milliseconds $WaitMilliseconds
        }
    }
    catch {
    }
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

function Set-AutoCadDocumentVariableSafe {
    param(
        [__ComObject]$Document,
        [string]$Name,
        [object]$Value
    )

    if ($null -eq $Document) {
        return
    }

    try {
        $Document.SetVariable($Name, $Value)
    }
    catch {
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
            Focus-AutoCadWindow -Application $application -Document $document
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
                Set-AutoCadDocumentVariableSafe -Document $document -Name 'FILEDIA' -Value 1
                Set-AutoCadDocumentVariableSafe -Document $document -Name 'CMDECHO' -Value 1
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
            $point = $document.Utility.GetPoint([System.Type]::Missing, ("`n{0}: " -f $promptMessage))
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

    'SetEntityHighlight' {
        $resolvedDwgPath = Resolve-NormalizedPath $DwgPath
        if ([string]::IsNullOrWhiteSpace($EntityHandle) -or ($Enabled -and $Disable) -or (-not $Enabled -and -not $Disable)) {
            [pscustomobject]@{
                handled     = $false
                applied     = $false
                highlighted = $false
                cleared     = $false
                reason      = 'InvalidHighlightRequest'
            } | ConvertTo-Json -Compress
            return
        }

        $match = Find-AutoCadDocumentForHighlight -TargetPath $resolvedDwgPath
        $application = $match.application
        if ($null -eq $application) {
            [pscustomobject]@{
                handled     = $false
                applied     = $false
                highlighted = $false
                cleared     = $false
                reason      = $match.reason
            } | ConvertTo-Json -Compress
            return
        }

        $document = $match.document
        $entity = $null
        try {
            try {
                if ($EntityHandle.Trim() -match '^[0-9a-fA-F]+$') {
                    $entity = $document.HandleToObject($EntityHandle.Trim())
                }
                elseif (-not [string]::IsNullOrWhiteSpace($EntityEndpoints)) {
                    $endpoints = @($EntityEndpoints.Split(',') | ForEach-Object { [double]::Parse($_, [System.Globalization.CultureInfo]::InvariantCulture) })
                    if ($endpoints.Count -ne 4) { throw 'InvalidEndpoints' }
                    $candidates = @()
                    foreach ($candidate in $document.ModelSpace) {
                        if ($candidate.ObjectName -ne 'AcDbMline') { continue }
                        try {
                            $coordinates = @($candidate.Coordinates)
                            if ($coordinates.Count -lt 6) { continue }
                            $last = $coordinates.Count - 3
                            $forward = [Math]::Abs($coordinates[0] - $endpoints[0]) -le 0.01 -and [Math]::Abs($coordinates[1] - $endpoints[1]) -le 0.01 -and [Math]::Abs($coordinates[$last] - $endpoints[2]) -le 0.01 -and [Math]::Abs($coordinates[$last + 1] - $endpoints[3]) -le 0.01
                            $reverse = [Math]::Abs($coordinates[0] - $endpoints[2]) -le 0.01 -and [Math]::Abs($coordinates[1] - $endpoints[3]) -le 0.01 -and [Math]::Abs($coordinates[$last] - $endpoints[0]) -le 0.01 -and [Math]::Abs($coordinates[$last + 1] - $endpoints[1]) -le 0.01
                            if ($forward -or $reverse) { $candidates += $candidate }
                        }
                        catch { }
                    }
                    if ($candidates.Count -gt 1) { throw 'AmbiguousEntity' }
                    if ($candidates.Count -eq 1) { $entity = $candidates[0] }
                }
                if ($null -eq $entity) { throw 'EntityNotFound' }
            }
            catch {
                [pscustomobject]@{
                    handled     = $true
                    applied     = $false
                    highlighted = $false
                    cleared     = $false
                    reason      = ('EntityNotFound: ' + $_.Exception.Message)
                } | ConvertTo-Json -Compress
                return
            }

            try {
                if ($Enabled) {
                    $document.Activate()
                    Focus-AutoCadWindow -Application $application -Document $document -WaitMilliseconds 0
                    try {
                        $minimum = $null
                        $maximum = $null
                        $entity.GetBoundingBox([ref]$minimum, [ref]$maximum)
                        $minPoint = @($minimum)
                        $maxPoint = @($maximum)
                        $width = [Math]::Max([Math]::Abs([double]$maxPoint[0] - [double]$minPoint[0]), 10.0)
                        $height = [Math]::Max([Math]::Abs([double]$maxPoint[1] - [double]$minPoint[1]), 10.0)
                        $centerX = ([double]$minPoint[0] + [double]$maxPoint[0]) / 2.0
                        $centerY = ([double]$minPoint[1] + [double]$maxPoint[1]) / 2.0
                        $application.ZoomWindow([double[]]@($centerX - $width, $centerY - $height, 0), [double[]]@($centerX + $width, $centerY + $height, 0))
                    }
                    catch {
                        # Highlighting remains useful when an entity cannot provide bounds.
                    }
                }
                $entity.Highlight([bool]$Enabled)
                $entity.Update()
                [pscustomobject]@{
                    handled     = $true
                    applied     = $true
                    highlighted = [bool]$Enabled
                    cleared     = [bool]$Disable
                    reason      = $null
                } | ConvertTo-Json -Compress
            }
            catch {
                [pscustomobject]@{
                    handled     = $true
                    applied     = $false
                    highlighted = $false
                    cleared     = $false
                    reason      = ('HighlightFailed: ' + $_.Exception.Message)
                } | ConvertTo-Json -Compress
            }
        }
        finally {
            if ($null -ne $entity) {
                [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($entity)
            }

            if ($null -ne $document) {
                [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($document)
            }

            if ($null -ne $application) {
                [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($application)
            }
        }
    }
}
