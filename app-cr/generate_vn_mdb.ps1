param(
    [Parameter(Mandatory = $true)]
    [string]$TemplatePath,

    [string]$ReferenceMdbPath,

    [string]$MetadataPath,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Normalize-Text {
    param([object]$Value)

    if ($null -eq $Value -or $Value -is [System.DBNull]) {
        return $null
    }

    $text = [string]$Value
    $text = $text -replace '[\u00A0\u202F]', ' '
    $text = $text -replace '[\u00AD\u200B\u200C\u200D\u2060\uFEFF]', ''
    $text = $text.Trim()

    if ($text -eq '') {
        return $null
    }

    return $text
}

function Resolve-NormalizedPath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path)
}

function Open-Database {
    param([string]$Path)

    $dao = New-Object -ComObject DAO.DBEngine.120
    $database = $dao.OpenDatabase((Resolve-NormalizedPath $Path))

    return [pscustomobject]@{
        Dao      = $dao
        Database = $database
    }
}

function New-SequentialRows {
    param(
        [int]$Count,
        [scriptblock]$Factory
    )

    $rows = @()
    for ($index = 1; $index -le $Count; $index++) {
        $rows += & $Factory $index
    }
    return $rows
}

function Close-DatabaseContext {
    param([pscustomobject]$Context)

    if ($null -ne $Context.Database) {
        $Context.Database.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($Context.Database)
    }

    if ($null -ne $Context.Dao) {
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($Context.Dao)
    }
}

function Get-TableRows {
    param(
        [__ComObject]$Database,
        [string]$TableName
    )

    $rows = @()
    $recordset = $Database.OpenRecordset("SELECT * FROM [$TableName]")

    try {
        while (-not $recordset.EOF) {
            $row = [ordered]@{}
            for ($fieldIndex = 0; $fieldIndex -lt $recordset.Fields.Count; $fieldIndex++) {
                $field = $recordset.Fields.Item($fieldIndex)
                try {
                    $value = $field.Value
                    if ($value -is [System.DBNull]) {
                        $value = $null
                    }
                    elseif ($value -is [string] -or $value -is [char]) {
                        $value = Normalize-Text $value
                    }

                    $row[$field.Name] = $value
                }
                finally {
                    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($field)
                }
            }

            $rows += [pscustomobject]$row
            $recordset.MoveNext()
        }
    }
    finally {
        $recordset.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($recordset)
    }

    return @($rows)
}

function Clear-AccessTables {
    param(
        [__ComObject]$Database,
        [string[]]$TableNames
    )

    foreach ($tableName in $TableNames) {
        $Database.Execute("DELETE FROM [$tableName]")
    }
}

function Set-DaoFieldValue {
    param(
        [__ComObject]$Field,
        [object]$Value
    )

    $Field.GetType().InvokeMember(
        'Value',
        [System.Reflection.BindingFlags]::SetProperty,
        $null,
        $Field,
        @($Value)
    ) | Out-Null
}

function Set-AccessFieldValue {
    param(
        [__ComObject]$Recordset,
        [string]$FieldName,
        [object]$Value
    )

    $field = $Recordset.Fields($FieldName)
    $fieldType = [int]$field.Type

    if ($fieldType -eq 10 -or $fieldType -eq 12) {
        if ($Value -is [string] -and $Value.Length -eq 0) {
            if ($field.AllowZeroLength) {
                Set-DaoFieldValue -Field $field -Value ''
            }
            else {
                Set-DaoFieldValue -Field $field -Value ([System.DBNull]::Value)
            }
            return
        }

        $normalizedText = Normalize-Text $Value
        if ($null -eq $normalizedText) {
            return
        }

        Set-DaoFieldValue -Field $field -Value $normalizedText
        return
    }

    if ($null -eq $Value) {
        return
    }

    switch ($fieldType) {
        2 { Set-DaoFieldValue -Field $field -Value ([byte]$Value); return }
        3 { Set-DaoFieldValue -Field $field -Value ([int16]$Value); return }
        4 { Set-DaoFieldValue -Field $field -Value ([int]$Value); return }
        5 { Set-DaoFieldValue -Field $field -Value ([decimal]$Value); return }
        6 { Set-DaoFieldValue -Field $field -Value ([single]$Value); return }
        7 { Set-DaoFieldValue -Field $field -Value ([double]$Value); return }
        8 {
            if ($Value -is [datetime]) {
                Set-DaoFieldValue -Field $field -Value $Value
                return
            }

            Set-DaoFieldValue -Field $field -Value ([datetime]$Value)
            return
        }
        default { Set-DaoFieldValue -Field $field -Value $Value; return }
    }
}

function Write-AccessTable {
    param(
        [__ComObject]$Database,
        [string]$TableName,
        [object[]]$Rows
    )

    $fieldLookup = @{}
    foreach ($field in $Database.TableDefs[$TableName].Fields) {
        $fieldLookup[$field.Name] = [pscustomobject]@{
            Name         = $field.Name
            IsAutoNumber = (($field.Attributes -band 16) -ne 0)
        }
    }

    $recordset = $Database.OpenRecordset($TableName)
    try {
        foreach ($row in $Rows) {
            if ($null -eq $row) {
                continue
            }

            $rowProperties = @()
            if ($row -is [System.Collections.IDictionary]) {
                $rowProperties = @($row.GetEnumerator() | ForEach-Object {
                    [pscustomobject]@{
                        Name  = $_.Key
                        Value = $_.Value
                    }
                })
            }
            elseif ($null -ne $row.PSObject) {
                $rowProperties = @($row.PSObject.Properties)
            }

            $recordset.AddNew()
            foreach ($property in $rowProperties) {
                if ($fieldLookup.ContainsKey($property.Name) -and -not $fieldLookup[$property.Name].IsAutoNumber) {
                    Set-AccessFieldValue -Recordset $recordset -FieldName $property.Name -Value $property.Value
                }
            }
            $recordset.Update()
        }
    }
    finally {
        $recordset.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($recordset)
    }
}

function Get-JsonFile {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    return Get-Content -LiteralPath (Resolve-NormalizedPath $Path) -Raw | ConvertFrom-Json
}

function Get-ObjectProperties {
    param([object]$Value)

    if ($null -eq $Value) {
        return @()
    }

    if ($Value -is [System.Collections.IDictionary]) {
        return @($Value.GetEnumerator() | ForEach-Object {
            [pscustomobject]@{
                Name  = $_.Key
                Value = $_.Value
            }
        })
    }

    if ($null -ne $Value.PSObject) {
        return @($Value.PSObject.Properties | Where-Object { $_.MemberType -eq 'NoteProperty' })
    }

    return @()
}

function Build-MinimalRowsFromMetadata {
    param([pscustomobject]$Metadata)

    $projectCode = Normalize-Text $Metadata.projectCode
    $projectLabel = Normalize-Text $Metadata.projectLabel
    $buildingName = Normalize-Text $Metadata.mainBuildingName
    if ($null -eq $buildingName) {
        $buildingName = $projectLabel
    }

    $coordinateEntries = @(Get-ObjectProperties $Metadata.coordinates | Sort-Object Name)

    $popRows = @()
    $popRows += [pscustomobject]@{
        Label       = $buildingName
        Postcode    = $null
        Huisnr      = $null
        Toevoeging  = $null
        Soort_POP   = 'CP/AP Special'
        X           = $null
        Y           = $null
        ALIASNAME   = $null
        ADDRESSID   = $null
        ImportResult = $null
    }

    foreach ($entry in $coordinateEntries) {
        $popRows += [pscustomobject]@{
            Label       = $entry.Name
            Postcode    = $null
            Huisnr      = $null
            Toevoeging  = 'Nabij'
            Soort_POP   = 'OAP 720/40 MD4'
            X           = $entry.Value.x
            Y           = $entry.Value.y
            ALIASNAME   = $null
            ADDRESSID   = $null
            ImportResult = $null
        }
    }

    $cbnRows = foreach ($row in $popRows) {
        $cbnType = 'ODF_OAP-L_PPC01'
        if ($row.Label -eq $buildingName) {
            $cbnType = 'ODF_POP-L_PPC01'
        }

        [pscustomobject]@{
            Label        = '101'
            Locatie      = $row.Label
            CBNType      = $cbnType
            RIJ          = 1
            Floortile    = 'A'
            Verdieping   = $null
            Ruimte       = $null
            Toelichting  = $null
            ImportResult = $null
        }
    }

    $kabelRows = @()
    $odfRows = @()
    $afwerkRows = @()
    $accesspointRows = @()

    $portIndex = 1
    foreach ($entry in $coordinateEntries) {
        $cableLabel = '{0}-B{1}-K01-S01' -f $projectLabel, $portIndex.ToString('00')
        $kabelRows += [pscustomobject]@{
            Label            = $cableLabel
            Locatienaam_A    = $buildingName
            Locatienaam_B    = $entry.Name
            Afwerkeenheid_A  = '101'
            Afwerkeenheid_B  = '101'
            Kabeltype        = '96V_LTMC_PR02'
            PoortA           = $null
            PoortB           = $null
            Serienummer      = $null
            CATEGORIE        = $null
            ImportResult     = $null
        }

        $odfRows += [pscustomobject]@{
            Nummer        = (10 + ($portIndex * 2) - 1).ToString()
            Locatie       = $buildingName
            CBN           = '101'
            ODFTYPE       = 'LPL_POP-R_PPC01'
            HoogtePositie = 10 + ($portIndex * 2) - 1
            Zijde         = 'V'
            ImportResult  = $null
        }
        $odfRows += [pscustomobject]@{
            Nummer        = (10 + ($portIndex * 2)).ToString()
            Locatie       = $buildingName
            CBN           = '101'
            ODFTYPE       = 'LPL_POP-R_PPC01'
            HoogtePositie = 10 + ($portIndex * 2)
            Zijde         = 'V'
            ImportResult  = $null
        }

        foreach ($fiber in 1..192) {
            $afwerkRows += [pscustomobject]@{
                PP            = (($portIndex - 1) * 192) + $fiber
                Kabel         = $cableLabel
                Connectortype = 'LC/APC'
                Vezelnr       = $fiber
                CBN           = '101'
                ODF           = (10 + ($portIndex * 2) - 1).ToString()
                LOCATIE       = $buildingName
                Traynr        = 1
                ImportResult  = $null
                ImportResult1 = $null
            }
        }

        $accesspointRows += [pscustomobject]@{
            Label           = $entry.Name
            Accesspointtype = 'VK_14-10_CA02'
            X               = $entry.Value.x
            Y               = $entry.Value.y
            Z               = $entry.Value.z
            Toelichting     = $null
            Nauwkeurigheid  = 0
            ImportResult    = $null
        }

        $portIndex += 1
    }

    $vergunningRows = @()
    if ($null -ne $Metadata.vergunning -and (Normalize-Text $Metadata.vergunning.name)) {
        $granted = $null
        $expiry = $null
        if (Normalize-Text $Metadata.vergunning.grantedDate) {
            $granted = [datetime]$Metadata.vergunning.grantedDate
        }
        if (Normalize-Text $Metadata.vergunning.expiryDate) {
            $expiry = [datetime]$Metadata.vergunning.expiryDate
        }

        $vergunningRows += [pscustomobject]@{
            NAAM_VERGUNNING      = $Metadata.vergunning.name
            Verlenende_Instantie = $Metadata.vergunning.issuer
            Datum_verleend       = $granted
            Datum_verlopen       = $expiry
            X                    = $null
            Y                    = $null
            ImportResult         = $null
        }
    }

    return @{
        POP         = $popRows
        CBN         = $cbnRows
        ODF         = $odfRows
        AfwerkODF   = $afwerkRows
        Accesspoint = $accesspointRows
        Kabel       = $kabelRows
        Vergunning  = $vergunningRows
        Mantelbuis  = @()
        Ductlas     = @()
        SpliceBox   = @()
        Klant       = @()
        Las         = @()
        Patch       = @()
        Type        = @()
        Duct        = @()
        Traject     = @()
    }
}

$resolvedTemplatePath = Resolve-NormalizedPath $TemplatePath
$resolvedReferenceMdbPath = Resolve-NormalizedPath $ReferenceMdbPath
$resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
if ($null -eq $resolvedReferenceMdbPath -and [string]::IsNullOrWhiteSpace($MetadataPath)) {
    throw 'Debes indicar ReferenceMdbPath o MetadataPath.'
}

New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($resolvedOutputPath)) -Force | Out-Null
Copy-Item -LiteralPath $resolvedTemplatePath -Destination $resolvedOutputPath -Force

$outputContext = Open-Database -Path $resolvedOutputPath

try {
    $tableNames = @()
    foreach ($tableDef in $outputContext.Database.TableDefs) {
        if (-not $tableDef.Name.StartsWith('MSys')) {
            $tableNames += $tableDef.Name
        }
    }

    Clear-AccessTables -Database $outputContext.Database -TableNames $tableNames

    $counts = @{}
    if ($null -ne $resolvedReferenceMdbPath) {
        $referenceContext = Open-Database -Path $resolvedReferenceMdbPath
        try {
            foreach ($tableName in $tableNames) {
                $rows = @(Get-TableRows -Database $referenceContext.Database -TableName $tableName)
                Write-AccessTable -Database $outputContext.Database -TableName $tableName -Rows $rows
                $counts[$tableName] = $rows.Count
            }
        }
        finally {
            Close-DatabaseContext -Context $referenceContext
        }
    }
    else {
        $metadata = Get-JsonFile -Path $MetadataPath
        $minimalRows = Build-MinimalRowsFromMetadata -Metadata $metadata
        foreach ($tableName in $tableNames) {
            $rows = @($minimalRows[$tableName])
            Write-AccessTable -Database $outputContext.Database -TableName $tableName -Rows $rows
            $counts[$tableName] = $rows.Count
        }
    }

    $mode = 'metadata-minimal'
    if ($null -ne $resolvedReferenceMdbPath) {
        $mode = 'reference-copy'
    }

    [pscustomobject]@{
        outputPath = $resolvedOutputPath
        referenceMdbPath = $resolvedReferenceMdbPath
        mode = $mode
        tableCounts = $counts
    } | ConvertTo-Json -Depth 6
}
finally {
    Close-DatabaseContext -Context $outputContext
}
