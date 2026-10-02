param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$WorkbookPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$excel = $null
$workbooks = $null
$workbook = $null
$warning = $null

try {
    $resolvedWorkbookPath = (Resolve-Path -LiteralPath $WorkbookPath -ErrorAction Stop).Path
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $excel.EnableEvents = $false
    $excel.ScreenUpdating = $false
    $workbooks = $excel.Workbooks
    $workbook = $workbooks.Open($resolvedWorkbookPath, 0, $false)

    $workbook.ForceFullCalculation = $true
    $excel.CalculateFullRebuild()
    $workbook.Save()
}
catch {
    # The XLSX written by the exporter remains usable with its forced calcPr settings.
    $warning = $_.Exception.Message
}
finally {
    if ($null -ne $workbook) {
        try {
            $workbook.Close($false)
        }
        catch {}
        try {
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($workbook)
        }
        catch {}
    }

    if ($null -ne $excel) {
        try {
            $excel.Quit()
        }
        catch {}
    }

    if ($null -ne $workbooks) {
        try {
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($workbooks)
        }
        catch {}
    }

    if ($null -ne $excel) {
        try {
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($excel)
        }
        catch {}
    }

    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}

if ($null -ne $warning) {
    Write-Output "WARNING: Excel COM no disponible o no pudo recalcular el workbook; se conserva el XLSX con recalculo al abrir. $warning"
    exit 0
}

Write-Output "OK: Excel recalculado y guardado."
