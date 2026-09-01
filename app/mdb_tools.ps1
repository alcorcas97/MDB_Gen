param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('ExportCustomerDrawData', 'ImportCustomerCoordinates', 'ExportDpCoordinateTargets', 'ImportDpCoordinates', 'MoveResvCoordinatesToDp', 'SetOapCoordinate', 'UppercaseOap', 'ExportCrossCheckData', 'FixCustomerDempingValues', 'ApplyDempingContingency', 'RebuildCustomerComplexes', 'ApplyFcUpdates', 'ApplyFcRefresh', 'ApplyGlaspoortProject', 'InspectConnectionBalance', 'ApplyConnectionSync', 'ExportRiserState', 'ApplyRiserData', 'AddRiserData', 'DeleteRiserData', 'ApplyBuiseind', 'ExportPartialDeliveryData', 'ApplyPartialDelivery')]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$MdbPath,

    [string]$CoordinatesPath,
    [string]$AssignmentsPath,
    [string]$NearestDpLabel,
    [double]$X = 0,
    [double]$Y = 0
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

function Get-JsonPropertyValue {
    param(
        [object]$Object,
        [string[]]$Names
    )

    if ($null -eq $Object) {
        return $null
    }

    foreach ($name in $Names) {
        $property = $Object.PSObject.Properties[$name]
        if ($null -ne $property) {
            return $property.Value
        }
    }

    return $null
}

function Normalize-UpperStatus {
    param([object]$Value)

    $text = Normalize-Text $Value
    if ($null -eq $text) {
        return $null
    }

    return $text.ToUpperInvariant()
}

function Resolve-CustomerCableType {
    param([object]$FtuLocation)

    if ((Normalize-UpperStatus $FtuLocation) -eq 'RESV') {
        return ''
    }

    return '2V_DBC_PR01'
}

function Get-AllowedStatusLocations {
    param([string]$DeliveryStatus)

    switch (Normalize-Text $DeliveryStatus) {
        '1'  { return @('GV') }
        '31' { return @('GV') }
        '2'  { return @('MTK', 'WNK', 'ANDE', 'KLDR') }
        '5'  { return @('EG', 'GL') }
        '35' { return @('EG', 'GL') }
        '14' { return @('RESV') }
        '34' { return @('RESV') }
        '33' { return @('IHB') }
        '11' { return @('SMK', 'SWON') }
        '0'  { return @() }
        '30' { return @() }
        default { return @() }
    }
}

function Resolve-StatusLocation {
    param(
        [string]$DeliveryStatus,
        [object]$CurrentLocation,
        [object]$PreferredLocation
    )

    $allowedLocations = @(Get-AllowedStatusLocations -DeliveryStatus $DeliveryStatus)
    if ($allowedLocations.Count -eq 0) {
        return $null
    }

    $currentNormalized = Normalize-UpperStatus $CurrentLocation
    if ($null -ne $currentNormalized -and $currentNormalized -in $allowedLocations) {
        return $currentNormalized
    }

    $preferredNormalized = Normalize-UpperStatus $PreferredLocation
    if ($null -ne $preferredNormalized -and $preferredNormalized -in $allowedLocations) {
        return $preferredNormalized
    }

    return $allowedLocations[0]
}

function Resolve-StatusFtuLocation {
    param(
        [string]$DeliveryStatus,
        [object]$PreferredLocation,
        [object]$CableId,
        [object]$AddressLabel
    )

    $allowedLocations = @(Get-AllowedStatusLocations -DeliveryStatus $DeliveryStatus)
    if ($allowedLocations.Count -eq 0) {
        return [pscustomobject]@{
            Location    = $null
            IsAmbiguous = $false
            Allowed     = @()
            Warning     = $null
        }
    }

    if ($allowedLocations.Count -eq 1) {
        return [pscustomobject]@{
            Location    = $allowedLocations[0]
            IsAmbiguous = $false
            Allowed     = $allowedLocations
            Warning     = $null
        }
    }

    $preferredNormalized = Normalize-UpperStatus $PreferredLocation
    if ($null -ne $preferredNormalized -and $preferredNormalized -in $allowedLocations) {
        return [pscustomobject]@{
            Location    = $preferredNormalized
            IsAmbiguous = $false
            Allowed     = $allowedLocations
            Warning     = $null
        }
    }

    return [pscustomobject]@{
        Location    = 'XXXX'
        IsAmbiguous = $true
        Allowed     = $allowedLocations
        Warning     = [pscustomobject]@{
            CableId        = Normalize-Text $CableId
            AddressCode    = Normalize-Text $AddressLabel
            DeliveryStatus = Normalize-Text $DeliveryStatus
            Allowed        = @($allowedLocations)
        }
    }
}

function Get-AddressMatchKey {
    param(
        [object]$Postcode,
        [object]$HouseNumber,
        [object]$HouseSuffix,
        [object]$Room
    )

    $parts = @()

    foreach ($value in @(
        (Normalize-UpperStatus $Postcode),
        (Normalize-UpperStatus $HouseNumber),
        (Normalize-UpperStatus $HouseSuffix),
        (Normalize-UpperStatus $Room)
    )) {
        if ($null -ne $value) {
            $parts += $value
        }
    }

    if ($parts.Count -eq 0) {
        return $null
    }

    return ($parts -join '|')
}

function Convert-ToAccessTextLiteral {
    param([object]$Value)

    $text = Normalize-Text $Value
    if ($null -eq $text) {
        return 'NULL'
    }

    return "'{0}'" -f $text.Replace("'", "''")
}

function Convert-ToNullableDouble {
    param([object]$Value)

    if ($null -eq $Value -or $Value -is [System.DBNull]) {
        return $null
    }

    if ($Value -is [System.IConvertible]) {
        $valueTypeCode = $Value.GetTypeCode()
        if ($valueTypeCode -in @(
            [System.TypeCode]::Byte,
            [System.TypeCode]::SByte,
            [System.TypeCode]::UInt16,
            [System.TypeCode]::UInt32,
            [System.TypeCode]::UInt64,
            [System.TypeCode]::Int16,
            [System.TypeCode]::Int32,
            [System.TypeCode]::Int64,
            [System.TypeCode]::Decimal,
            [System.TypeCode]::Double,
            [System.TypeCode]::Single
        )) {
            return [double]$Value
        }
    }

    $text = Normalize-Text $Value
    if ($null -eq $text) {
        return $null
    }

    $parsedValue = 0.0
    foreach ($culture in @(
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.CultureInfo]::CurrentCulture,
        [System.Globalization.CultureInfo]::GetCultureInfo('nl-NL'),
        [System.Globalization.CultureInfo]::GetCultureInfo('es-ES')
    )) {
        if ([double]::TryParse($text, [System.Globalization.NumberStyles]::Float, $culture, [ref]$parsedValue)) {
            return $parsedValue
        }
    }

    return $null
}

function Resolve-NormalizedPath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    try {
        return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path).TrimEnd('\')
    }
    catch {
        return $null
    }
}

function Get-ActiveAccessApplication {
    $progIds = @(
        'Access.Application',
        'Access.Application.16'
    )

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

function Open-Database {
    param([string]$Path)

    $resolvedPath = Resolve-NormalizedPath $Path
    if ($null -eq $resolvedPath) {
        throw "No se ha encontrado la base de datos: $Path"
    }

    $accessApplication = Get-ActiveAccessApplication
    if ($null -ne $accessApplication) {
        try {
            $currentProjectPath = Resolve-NormalizedPath $accessApplication.CurrentProject.FullName
            if ($null -ne $currentProjectPath -and $currentProjectPath -ieq $resolvedPath) {
                $database = $accessApplication.CurrentDb()
                return [pscustomobject]@{
                    Mode      = 'Access'
                    Dao       = $null
                    Database  = $database
                    AccessApp = $accessApplication
                }
            }
        }
        catch {
            [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($accessApplication)
            $accessApplication = $null
        }
    }

    if ($null -ne $accessApplication) {
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($accessApplication)
        $accessApplication = $null
    }

    $dao = New-Object -ComObject DAO.DBEngine.120
    $database = $dao.OpenDatabase($resolvedPath)

    return [pscustomobject]@{
        Mode      = 'Dao'
        Dao       = $dao
        Database  = $database
        AccessApp = $null
    }
}

function Close-DatabaseContext {
    param([pscustomobject]$Context)

    if ($null -ne $Context.Database) {
        if ($Context.Mode -eq 'Dao') {
            $Context.Database.Close()
        }
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($Context.Database)
    }

    if ($null -ne $Context.Dao) {
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($Context.Dao)
    }

    if ($null -ne $Context.AccessApp) {
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($Context.AccessApp)
    }
}

function Get-KabelLocationMap {
    param([__ComObject]$Database)

    $lookup = @{}
    $recordset = $Database.OpenRecordset('SELECT [Label], [Locatienaam_B] FROM [Kabel]')

    try {
        while (-not $recordset.EOF) {
            $kabelLabel = Normalize-Text $recordset.Fields('Label').Value
            $locationLabel = Normalize-Text $recordset.Fields('Locatienaam_B').Value

            if ($null -ne $kabelLabel) {
                $lookup[$kabelLabel] = $locationLabel
            }

            $recordset.MoveNext()
        }
    }
    finally {
        $recordset.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($recordset)
    }

    return $lookup
}

function Export-CustomerDrawData {
    param([__ComObject]$Database)

    $kabelLookup = Get-KabelLocationMap -Database $Database
    $rows = @()
    $recordset = $Database.OpenRecordset('SELECT [ID], [Kastnr], [Kabel], [X], [Y] FROM [Klant]')

    try {
        while (-not $recordset.EOF) {
            $kabelLabel = Normalize-Text $recordset.Fields('Kabel').Value
            $locationLabel = if ($null -ne $kabelLabel -and $kabelLookup.ContainsKey($kabelLabel)) { $kabelLookup[$kabelLabel] } else { $null }

            $rows += [pscustomobject]@{
                klantId       = [int]$recordset.Fields('ID').Value
                kabelLabel    = $kabelLabel
                locationLabel = $locationLabel
                kastnr        = Normalize-Text $recordset.Fields('Kastnr').Value
                x             = Convert-ToNullableDouble $recordset.Fields('X').Value
                y             = Convert-ToNullableDouble $recordset.Fields('Y').Value
            }

            $recordset.MoveNext()
        }
    }
    finally {
        $recordset.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($recordset)
    }

    return @($rows | Where-Object { $null -ne (Normalize-Text $_.locationLabel) })
}

function Import-CustomerCoordinates {
    param(
        [__ComObject]$Database,
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "No se ha encontrado el fichero de coordenadas: $Path"
    }

    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $sourceData = ConvertFrom-Json -InputObject ($raw -replace '^\uFEFF', '')
    $items = if ($sourceData.PSObject.Properties.Name -contains 'Assignments') {
        @($sourceData.Assignments)
    }
    else {
        @($sourceData)
    }
    $complexDefinitions = if ($sourceData.PSObject.Properties.Name -contains 'ComplexDefinitions') {
        @($sourceData.ComplexDefinitions)
    }
    else {
        @()
    }
    $coordinateLookup = @{}

    foreach ($item in $items) {
        $label = Normalize-Text $item.label
        if ($null -eq $label) {
            continue
        }

        $coordinateLookup[$label] = [pscustomobject]@{
            x     = Convert-ToNullableDouble $item.x
            y     = Convert-ToNullableDouble $item.y
            layer = Normalize-UpperStatus $item.layer
        }
    }

    $kabelLookup = Get-KabelLocationMap -Database $Database
    $recordset = $Database.OpenRecordset('SELECT [ID], [Kabel], [Kastnr], [X], [Y] FROM [Klant]')
    $updated = 0
    $updatedCoordinates = 0
    $updatedStatuses = 0

    try {
        while (-not $recordset.EOF) {
            $kabelLabel = Normalize-Text $recordset.Fields('Kabel').Value
            $locationLabel = if ($null -ne $kabelLabel -and $kabelLookup.ContainsKey($kabelLabel)) { $kabelLookup[$kabelLabel] } else { $null }

            if ($null -ne $locationLabel -and $coordinateLookup.ContainsKey($locationLabel)) {
                $coordinate = $coordinateLookup[$locationLabel]
                $targetLayer = Normalize-UpperStatus $coordinate.layer
                $currentKastnr = Normalize-UpperStatus $recordset.Fields('Kastnr').Value
                $shouldApplyStatus = $targetLayer -in @('EG', 'GL')
                $coordinatesChanged = $null -ne $coordinate.x -and $null -ne $coordinate.y
                $statusChanged = $shouldApplyStatus -and $currentKastnr -ne $targetLayer

                if ($coordinatesChanged -or $statusChanged) {
                    $recordset.Edit()

                    if ($coordinatesChanged) {
                        $recordset.Fields('X').Value = [double]$coordinate.x
                        $recordset.Fields('Y').Value = [double]$coordinate.y
                        $updatedCoordinates++
                    }

                    if ($statusChanged) {
                        $recordset.Fields('Kastnr').Value = $targetLayer
                        $updatedStatuses++
                    }

                    $recordset.Update()
                    $updated++
                }
            }

            $recordset.MoveNext()
        }
    }
    finally {
        $recordset.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($recordset)
    }

    return [pscustomobject]@{
        updated            = $updated
        updatedCoordinates = $updatedCoordinates
        updatedStatuses    = $updatedStatuses
        importedLabels     = $coordinateLookup.Count
    }
}

function Export-DpCoordinateTargets {
    param([__ComObject]$Database)

    $rows = @()
    $recordset = $Database.OpenRecordset("SELECT [Label], [Accesspointtype], [X], [Y] FROM [Accesspoint] WHERE [Label] LIKE '*-ODP*' ORDER BY [Label]")

    try {
        while (-not $recordset.EOF) {
            $label = Normalize-Text $recordset.Fields('Label').Value
            if ($null -ne $label) {
                $rows += [pscustomobject]@{
                    label           = $label
                    shortLabel      = ($label -replace '^.*-(ODP[0-9A-Z]+)$', '$1')
                    accesspointType = Normalize-Text $recordset.Fields('Accesspointtype').Value
                    x               = Convert-ToNullableDouble $recordset.Fields('X').Value
                    y               = Convert-ToNullableDouble $recordset.Fields('Y').Value
                }
            }

            $recordset.MoveNext()
        }
    }
    finally {
        $recordset.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($recordset)
    }

    return @($rows)
}

function Update-DpCoordinateTable {
    param(
        [__ComObject]$Database,
        [string]$TableName,
        [hashtable]$CoordinateLookup
    )

    $recordset = $Database.OpenRecordset("SELECT [Label], [X], [Y] FROM [$TableName] WHERE [Label] LIKE '*-ODP*'")
    $targetRows = 0
    $updatedRows = 0
    $unchangedRows = 0
    $notMatched = @()

    try {
        while (-not $recordset.EOF) {
            $targetRows++
            $label = Normalize-Text $recordset.Fields('Label').Value
            $key = if ($null -ne $label) { $label.ToUpperInvariant() } else { $null }
            $coordinate = if ($null -ne $key -and $CoordinateLookup.ContainsKey($key)) { $CoordinateLookup[$key] } else { $null }

            if ($null -eq $coordinate) {
                $notMatched += $label
                $recordset.MoveNext()
                continue
            }

            $currentX = Convert-ToNullableDouble $recordset.Fields('X').Value
            $currentY = Convert-ToNullableDouble $recordset.Fields('Y').Value
            $xChanged = $null -eq $currentX -or [math]::Abs(([double]$currentX) - $coordinate.X) -gt 0.000001
            $yChanged = $null -eq $currentY -or [math]::Abs(([double]$currentY) - $coordinate.Y) -gt 0.000001

            if ($xChanged -or $yChanged) {
                $recordset.Edit()
                $recordset.Fields('X').Value = $coordinate.X
                $recordset.Fields('Y').Value = $coordinate.Y
                $recordset.Update()
                $updatedRows++
            }
            else {
                $unchangedRows++
            }

            $recordset.MoveNext()
        }
    }
    finally {
        $recordset.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($recordset)
    }

    return [pscustomobject]@{
        targetRows      = $targetRows
        updatedRows     = $updatedRows
        unchangedRows   = $unchangedRows
        notMatchedCount = $notMatched.Count
        notMatched      = @($notMatched | Where-Object { $null -ne $_ } | Select-Object -First 20)
    }
}

function Import-DpCoordinates {
    param(
        [__ComObject]$Database,
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "No se ha encontrado el fichero de coordenadas de DP: $Path"
    }

    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $items = @((ConvertFrom-Json -InputObject ($raw -replace '^\uFEFF', '')))
    $coordinateLookup = @{}

    foreach ($item in $items) {
        $label = Normalize-Text (Get-JsonPropertyValue -Object $item -Names @('label', 'Label'))
        $x = Convert-ToNullableDouble (Get-JsonPropertyValue -Object $item -Names @('x', 'X'))
        $y = Convert-ToNullableDouble (Get-JsonPropertyValue -Object $item -Names @('y', 'Y'))

        if ($null -ne $label -and $null -ne $x -and $null -ne $y) {
            $coordinateLookup[$label.ToUpperInvariant()] = [pscustomobject]@{
                Label = $label
                X     = [double]$x
                Y     = [double]$y
            }
        }
    }

    $accesspointResult = Update-DpCoordinateTable -Database $Database -TableName 'Accesspoint' -CoordinateLookup $coordinateLookup
    $spliceBoxResult = Update-DpCoordinateTable -Database $Database -TableName 'SpliceBox' -CoordinateLookup $coordinateLookup

    return [pscustomobject]@{
        targetRows               = $accesspointResult.targetRows
        coordinateRows           = $coordinateLookup.Count
        updatedRows              = $accesspointResult.updatedRows
        unchangedRows            = $accesspointResult.unchangedRows
        notMatchedCount          = $accesspointResult.notMatchedCount
        notMatched               = @($accesspointResult.notMatched)
        spliceBoxTargetRows      = $spliceBoxResult.targetRows
        spliceBoxUpdatedRows     = $spliceBoxResult.updatedRows
        spliceBoxUnchangedRows   = $spliceBoxResult.unchangedRows
        spliceBoxNotMatchedCount = $spliceBoxResult.notMatchedCount
        spliceBoxNotMatched      = @($spliceBoxResult.notMatched)
    }
}

function Move-ResvCoordinatesToDp {
    param([__ComObject]$Database)

    $kabelToDp = @{}
    $kabelRecordset = $Database.OpenRecordset('SELECT [Label], [Locatienaam_A] FROM [Kabel]')

    try {
        while (-not $kabelRecordset.EOF) {
            $kabelLabel = Normalize-Text $kabelRecordset.Fields('Label').Value
            $dpLabel = Normalize-Text $kabelRecordset.Fields('Locatienaam_A').Value

            if ($null -ne $kabelLabel -and $null -ne $dpLabel) {
                $kabelToDp[$kabelLabel] = $dpLabel
            }

            $kabelRecordset.MoveNext()
        }
    }
    finally {
        $kabelRecordset.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($kabelRecordset)
    }

    $dpCoordinates = @{}
    $accesspointRecordset = $Database.OpenRecordset('SELECT [Label], [X], [Y] FROM [Accesspoint]')

    try {
        while (-not $accesspointRecordset.EOF) {
            $label = Normalize-Text $accesspointRecordset.Fields('Label').Value
            $x = Convert-ToNullableDouble $accesspointRecordset.Fields('X').Value
            $y = Convert-ToNullableDouble $accesspointRecordset.Fields('Y').Value

            if ($null -ne $label -and $null -ne $x -and $null -ne $y) {
                $dpCoordinates[$label] = [pscustomobject]@{
                    X = [double]$x
                    Y = [double]$y
                }
            }

            $accesspointRecordset.MoveNext()
        }
    }
    finally {
        $accesspointRecordset.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($accesspointRecordset)
    }

    $recordset = $Database.OpenRecordset("SELECT [ID], [Kabel], [Kastnr], [X], [Y] FROM [Klant] WHERE UCASE([Kastnr]) = 'RESV'")
    $resvRows = 0
    $updatedRows = 0
    $unchangedRows = 0
    $notMatched = @()

    try {
        while (-not $recordset.EOF) {
            $resvRows++
            $customerId = [int]$recordset.Fields('ID').Value
            $kabelLabel = Normalize-Text $recordset.Fields('Kabel').Value
            $dpLabel = if ($null -ne $kabelLabel -and $kabelToDp.ContainsKey($kabelLabel)) { $kabelToDp[$kabelLabel] } else { $null }
            $coordinate = if ($null -ne $dpLabel -and $dpCoordinates.ContainsKey($dpLabel)) { $dpCoordinates[$dpLabel] } else { $null }

            if ($null -eq $coordinate) {
                $notMatched += [pscustomobject]@{
                    ID    = $customerId
                    Kabel = $kabelLabel
                    DP    = $dpLabel
                }
                $recordset.MoveNext()
                continue
            }

            $currentX = Convert-ToNullableDouble $recordset.Fields('X').Value
            $currentY = Convert-ToNullableDouble $recordset.Fields('Y').Value
            $xChanged = $null -eq $currentX -or [math]::Abs(([double]$currentX) - $coordinate.X) -gt 0.000001
            $yChanged = $null -eq $currentY -or [math]::Abs(([double]$currentY) - $coordinate.Y) -gt 0.000001

            if ($xChanged -or $yChanged) {
                $recordset.Edit()
                $recordset.Fields('X').Value = $coordinate.X
                $recordset.Fields('Y').Value = $coordinate.Y
                $recordset.Update()
                $updatedRows++
            }
            else {
                $unchangedRows++
            }

            $recordset.MoveNext()
        }
    }
    finally {
        $recordset.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($recordset)
    }

    return [pscustomobject]@{
        resvRows        = $resvRows
        updatedRows     = $updatedRows
        unchangedRows   = $unchangedRows
        notMatchedCount = $notMatched.Count
        notMatched      = @($notMatched | Select-Object -First 20)
    }
}

function Set-OapCoordinate {
    param(
        [__ComObject]$Database,
        [double]$XValue,
        [double]$YValue,
        [string]$NearestDpLabel = $null
    )

    $updatedPop = 0
    $updatedVergunning = 0
    $updatedPopAddress = 0
    $nearestAddress = $null
    $nearestAddressSource = $null
    $xSqlValue = [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, '{0:R}', $XValue)
    $ySqlValue = [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, '{0:R}', $YValue)

    $customerSql = @"
SELECT TOP 1
    [Postcode],
    [Huisnr],
    [Toevoeging],
    [Kabel]
FROM [Klant]
WHERE (([X] <> 0) OR ([Y] <> 0))
ORDER BY ((([X] - $xSqlValue) * ([X] - $xSqlValue)) + (([Y] - $ySqlValue) * ([Y] - $ySqlValue)))
"@
    $customerRecordset = $Database.OpenRecordset($customerSql)

    try {
        if (-not $customerRecordset.EOF) {
            $nearestAddress = [pscustomobject]@{
                Postcode   = Normalize-Text $customerRecordset.Fields('Postcode').Value
                Huisnr     = Normalize-Text $customerRecordset.Fields('Huisnr').Value
                Toevoeging = Normalize-Text $customerRecordset.Fields('Toevoeging').Value
                Kabel      = Normalize-Text $customerRecordset.Fields('Kabel').Value
            }
            $nearestAddressSource = 'KlantXY'
        }
    }
    finally {
        $customerRecordset.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($customerRecordset)
    }

    $normalizedNearestDpLabel = Normalize-Text $NearestDpLabel
    if ($null -eq $nearestAddress -and $null -ne $normalizedNearestDpLabel) {
        $addressSql = @"
SELECT TOP 1
    [Klant].[Postcode] AS [Postcode],
    [Klant].[Huisnr] AS [Huisnr],
    [Klant].[Toevoeging] AS [Toevoeging],
    [Klant].[Kabel] AS [Kabel]
FROM [Klant]
INNER JOIN [Kabel] ON [Klant].[Kabel] = [Kabel].[Label]
WHERE [Kabel].[Locatienaam_A] = $(Convert-ToAccessTextLiteral $normalizedNearestDpLabel)
ORDER BY [Klant].[ID]
"@
        $addressRecordset = $Database.OpenRecordset($addressSql)

        try {
            if (-not $addressRecordset.EOF) {
                $nearestAddress = [pscustomobject]@{
                    Postcode   = Normalize-Text $addressRecordset.Fields('Postcode').Value
                    Huisnr     = Normalize-Text $addressRecordset.Fields('Huisnr').Value
                    Toevoeging = Normalize-Text $addressRecordset.Fields('Toevoeging').Value
                    Kabel      = Normalize-Text $addressRecordset.Fields('Kabel').Value
                }
                $nearestAddressSource = 'NearestDp'
            }
        }
        finally {
            $addressRecordset.Close()
            [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($addressRecordset)
        }
    }

    foreach ($tableName in @('POP', 'Vergunning')) {
        $recordset = $Database.OpenRecordset("SELECT * FROM [$tableName]")

        try {
            while (-not $recordset.EOF) {
                $recordset.Edit()
                $recordset.Fields('X').Value = $XValue
                $recordset.Fields('Y').Value = $YValue

                if ($tableName -eq 'POP') {
                    if ($null -ne $nearestAddress) {
                        $recordset.Fields('Postcode').Value = $nearestAddress.Postcode
                        $recordset.Fields('Huisnr').Value = $nearestAddress.Huisnr
                    }

                    $recordset.Fields('Toevoeging').Value = 'Nabij'
                    $updatedPopAddress++
                }

                $recordset.Update()

                if ($tableName -eq 'POP') {
                    $updatedPop++
                }
                else {
                    $updatedVergunning++
                }

                $recordset.MoveNext()
            }
        }
        finally {
            $recordset.Close()
            [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($recordset)
        }
    }

    return [pscustomobject]@{
        x                  = $XValue
        y                  = $YValue
        updatedPop         = $updatedPop
        updatedVergunning  = $updatedVergunning
        updatedPopAddress  = $updatedPopAddress
        nearestDpLabel     = $normalizedNearestDpLabel
        nearestKabel       = if ($null -ne $nearestAddress) { $nearestAddress.Kabel } else { $null }
        nearestPostcode    = if ($null -ne $nearestAddress) { $nearestAddress.Postcode } else { $null }
        nearestHuisnr      = if ($null -ne $nearestAddress) { $nearestAddress.Huisnr } else { $null }
        nearestToevoeging  = 'Nabij'
        nearestSource      = $nearestAddressSource
    }
}

function Get-NormalizedDempingValue {
    param([object]$Value)

    $numericValue = Convert-ToNullableDouble $Value
    if ($null -eq $numericValue) {
        return $null
    }

    if ($numericValue -gt 1000) {
        $numericValue = $numericValue / 100
    }

    if ($numericValue -gt 3) {
        $numericValue = -1 * [math]::Abs($numericValue)
    }

    return [math]::Round($numericValue, 2)
}

function Fix-CustomerDempingValues {
    param([__ComObject]$Database)

    $fieldNames = @(
        'Dempingswaarde1A',
        'Dempingswaarde1Z',
        'Dempingswaarde2A',
        'Dempingswaarde2Z'
    )

    $recordset = $Database.OpenRecordset('SELECT [ID], [Dempingswaarde1A], [Dempingswaarde1Z], [Dempingswaarde2A], [Dempingswaarde2Z] FROM [Klant]')
    $updatedRows = 0
    $updatedFields = 0

    try {
        while (-not $recordset.EOF) {
            $rowChanged = $false

            foreach ($fieldName in $fieldNames) {
                $field = $recordset.Fields($fieldName)
                $currentValue = Convert-ToNullableDouble $field.Value
                $normalizedValue = Get-NormalizedDempingValue $field.Value

                if ($null -eq $currentValue -or $null -eq $normalizedValue) {
                    continue
                }

                if ([math]::Abs($currentValue - $normalizedValue) -lt 0.000001) {
                    continue
                }

                if (-not $rowChanged) {
                    $recordset.Edit()
                    $rowChanged = $true
                }

                $field.Value = [double]$normalizedValue
                $updatedFields++
            }

            if ($rowChanged) {
                $recordset.Update()
                $updatedRows++
            }

            $recordset.MoveNext()
        }
    }
    finally {
        $recordset.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($recordset)
    }

    return [pscustomobject]@{
        updatedRows = $updatedRows
        updatedFields = $updatedFields
    }
}

function Apply-DempingContingency {
    param(
        [__ComObject]$Database,
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "No se ha encontrado el fichero de contingencia demping: $Path"
    }

    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $items = @((ConvertFrom-Json -InputObject ($raw -replace '^\uFEFF', '')))
    $allowedFields = @(
        'VEZELNR1',
        'Vezelnr2',
        'FTUType',
        'Dempingswaarde1A',
        'Dempingswaarde1Z',
        'Dempingswaarde2A',
        'Dempingswaarde2Z'
    )
    $updatedRows = 0
    $updatedFields = 0
    $notMatched = @()

    foreach ($item in $items) {
        $klantId = Normalize-Text (Get-JsonPropertyValue -Object $item -Names @('klantId', 'klant_id', 'klantid'))
        $kabel = Normalize-Text (Get-JsonPropertyValue -Object $item -Names @('kabel', 'Kabel'))
        $fields = Get-JsonPropertyValue -Object $item -Names @('fields', 'Fields')
        $clearFields = @(Get-JsonPropertyValue -Object $item -Names @('clearFields', 'ClearFields'))
        $whereParts = @()

        if ($null -ne $klantId) {
            $whereParts += "[ID] = $([int]$klantId)"
        }

        if ($null -ne $kabel) {
            $whereParts += "[Kabel] = $(Convert-ToAccessTextLiteral $kabel)"
        }

        if ($whereParts.Count -eq 0) {
            $notMatched += $item
            continue
        }

        $sql = "SELECT [ID], [Kabel], [VEZELNR1], [Vezelnr2], [FTUType], [Dempingswaarde1A], [Dempingswaarde1Z], [Dempingswaarde2A], [Dempingswaarde2Z] FROM [Klant] WHERE " + ($whereParts -join ' OR ')
        $recordset = $Database.OpenRecordset($sql)

        try {
            if ($recordset.EOF) {
                $notMatched += $item
                continue
            }

            $recordset.Edit()
            $rowChanged = $false

            foreach ($fieldName in $allowedFields) {
                if ($null -eq $fields -or -not ($fields.PSObject.Properties.Name -contains $fieldName)) {
                    continue
                }

                $targetValue = Convert-ToNullableDouble (Get-JsonPropertyValue -Object $fields -Names @($fieldName))
                if ($null -eq $targetValue) {
                    continue
                }

                $field = $recordset.Fields($fieldName)
                $currentValue = Convert-ToNullableDouble $field.Value

                if ($null -ne $currentValue -and [math]::Abs($currentValue - $targetValue) -lt 0.000001) {
                    continue
                }

                $field.Value = [double]$targetValue
                $updatedFields++
                $rowChanged = $true
            }

            foreach ($fieldName in $clearFields) {
                $normalizedFieldName = Normalize-Text $fieldName
                if ($null -eq $normalizedFieldName -or -not ($normalizedFieldName -in $allowedFields)) {
                    continue
                }

                $field = $recordset.Fields($normalizedFieldName)
                $currentValue = Normalize-Text $field.Value
                if ($null -eq $currentValue) {
                    continue
                }

                $field.Value = [System.DBNull]::Value
                $updatedFields++
                $rowChanged = $true
            }

            if ($rowChanged) {
                $recordset.Update()
                $updatedRows++
            }
            else {
                $recordset.CancelUpdate()
            }
        }
        finally {
            $recordset.Close()
            [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($recordset)
        }
    }

    return [pscustomobject]@{
        updatedRows     = $updatedRows
        updatedFields   = $updatedFields
        notMatchedCount = $notMatched.Count
        requestedRows   = $items.Count
    }
}

function Rebuild-CustomerComplexes {
    param(
        [__ComObject]$Database,
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "No se ha encontrado el fichero de asignaciones de COMPLEX: $Path"
    }

    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $sourceData = ConvertFrom-Json -InputObject ($raw -replace '^\uFEFF', '')
    $items = if ($sourceData.PSObject.Properties.Name -contains 'Assignments') {
        @($sourceData.Assignments)
    }
    else {
        @($sourceData)
    }
    $complexDefinitions = if ($sourceData.PSObject.Properties.Name -contains 'ComplexDefinitions') {
        @($sourceData.ComplexDefinitions)
    }
    else {
        @()
    }
    $complexLookup = @{}

    foreach ($item in $items) {
        $cableId = Normalize-Text $item.CableId
        if ($null -eq $cableId) {
            continue
        }

        $complexLookup[$cableId] = Normalize-Text $item.Complex
    }

    $recordset = $Database.OpenRecordset('SELECT [ID], [Kabel], [COMPLEX] FROM [Klant]')
    $updated = 0
    $assigned = 0
    $cleared = 0
    $usedComplexLookup = @{}

    try {
        while (-not $recordset.EOF) {
            $cableId = Normalize-Text $recordset.Fields('Kabel').Value
            $currentComplex = Normalize-Text $recordset.Fields('COMPLEX').Value
            $nextComplex = if ($null -ne $cableId -and $complexLookup.ContainsKey($cableId)) { $complexLookup[$cableId] } else { $null }
            $complexField = $recordset.Fields('COMPLEX')
            $nextStoredComplex = if ($null -ne $nextComplex) { Limit-AccessTextValue -Field $complexField -Value $nextComplex } else { $null }

            $currentComparable = if ($null -eq $currentComplex) { '' } else { $currentComplex }
            $nextComparable = if ($null -eq $nextStoredComplex) { '' } else { $nextStoredComplex }

            if ($currentComparable -ne $nextComparable) {
                $recordset.Edit()
                if ($null -eq $nextComplex) {
                    $recordset.Fields('COMPLEX').Value = [System.DBNull]::Value
                    $cleared++
                }
                else {
                    $recordset.Fields('COMPLEX').Value = $nextStoredComplex
                    $assigned++
                }

                $recordset.Update()
                $updated++
            }

            if ($null -ne $nextComplex) {
                $usedComplexLookup[$nextComplex] = $true
            }

            $recordset.MoveNext()
        }
    }
    finally {
        $recordset.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($recordset)
    }

    $allComplexFolders = @($complexDefinitions | ForEach-Object { Normalize-Text $_.Name } | Where-Object { $null -ne $_ } | Sort-Object -Unique)
    $unusedComplexFolders = @($allComplexFolders | Where-Object { -not $usedComplexLookup.ContainsKey($_) })

    return [pscustomobject]@{
        updated   = $updated
        assigned  = $assigned
        cleared   = $cleared
        available = if ($allComplexFolders.Count -gt 0) { $allComplexFolders.Count } else { $complexLookup.Count }
        unusedComplexFolders = @($unusedComplexFolders)
    }
}

function Apply-FcUpdates {
    param(
        [__ComObject]$Database,
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "No se ha encontrado el fichero de actualizacion de FC: $Path"
    }

    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $items = @((ConvertFrom-Json -InputObject ($raw -replace '^\uFEFF', '')))
    $fcLookup = @{}
    $fcAddressLookup = @{}
    $fallbackCableLookup = @{}

    foreach ($item in $items) {
        $cableId = Normalize-Text $item.CableId
        $deliveryStatus = Normalize-Text $item.DeliveryStatus
        $ftuReviewWarning = Get-JsonPropertyValue -Object $item -Names @('FtuReviewWarning')
        $assignment = [pscustomobject]@{
            CableId        = $cableId
            Postcode       = Normalize-Text $item.Postcode
            HouseNumber    = Normalize-Text $item.HouseNumber
            HouseSuffix    = Normalize-Text $item.HouseSuffix
            Room           = Normalize-Text $item.Room
            AddressMatchKey = Normalize-Text $item.AddressMatchKey
            DeliveryStatus = $deliveryStatus
            FtuLocation    = Normalize-UpperStatus $item.FtuLocation
            SourceFtuLocation = Normalize-UpperStatus $item.SourceFtuLocation
            FtuReviewRequired = [bool](Get-JsonPropertyValue -Object $item -Names @('FtuReviewRequired'))
            FtuAllowedLocations = @(Get-JsonPropertyValue -Object $item -Names @('FtuAllowedLocations'))
            FtuReviewWarning = $ftuReviewWarning
            StatusIs2      = ($deliveryStatus -eq '2')
            Measurement    = Convert-ToNullableDouble $item.Measurement
        }

        if ($null -ne $cableId) {
            $fcLookup[$cableId] = $assignment
        }

        $addressMatchKey = if ($null -ne (Normalize-Text $assignment.AddressMatchKey)) {
            Normalize-Text $assignment.AddressMatchKey
        }
        else {
            Get-AddressMatchKey -Postcode $assignment.Postcode -HouseNumber $assignment.HouseNumber -HouseSuffix $assignment.HouseSuffix -Room $assignment.Room
        }

        if ($null -ne $addressMatchKey -and -not $fcAddressLookup.ContainsKey($addressMatchKey)) {
            $fcAddressLookup[$addressMatchKey] = $assignment
        }
    }

    $updatedCustomers = 0
    $updatedCustomerFields = 0
    $updatedCables = 0
    $updatedCableFields = 0
    $statusChangeWarnings = [System.Collections.Generic.List[object]]::new()
    $pendingCustomerUpdates = [System.Collections.Generic.List[object]]::new()
    $ductCableLookup = Get-DuctCableLookup -Database $Database

    $customerRecordset = $Database.OpenRecordset('SELECT [ID], [Kabel], [Kastnr], [FTUType], [Postcode], [Huisnr], [Toevoeging], [KAMER] FROM [Klant]')
    try {
        while (-not $customerRecordset.EOF) {
            $rowId = [int]$customerRecordset.Fields('ID').Value
            $cableId = Normalize-Text $customerRecordset.Fields('Kabel').Value
            $addressMatchKey = Get-AddressMatchKey `
                -Postcode $customerRecordset.Fields('Postcode').Value `
                -HouseNumber $customerRecordset.Fields('Huisnr').Value `
                -HouseSuffix $customerRecordset.Fields('Toevoeging').Value `
                -Room $customerRecordset.Fields('KAMER').Value

            $fcItem = $null
            $matchedByAddress = $false

            if ($null -ne $cableId -and $fcLookup.ContainsKey($cableId)) {
                $fcItem = $fcLookup[$cableId]
            }
            elseif ($null -ne $addressMatchKey -and $fcAddressLookup.ContainsKey($addressMatchKey)) {
                $fcItem = $fcAddressLookup[$addressMatchKey]
                $matchedByAddress = $true
            }

            if ($null -ne $fcItem) {
                $targetFtuLocation = Normalize-UpperStatus $fcItem.FtuLocation
                $targetFtuType = if ($fcItem.StatusIs2) { 'FTU_TK01' } else { $null }

                if ($fcItem.FtuReviewRequired -and $null -ne $fcItem.FtuReviewWarning) {
                    $statusChangeWarnings.Add($fcItem.FtuReviewWarning)
                }

                $currentFtuLocation = Normalize-UpperStatus $customerRecordset.Fields('Kastnr').Value
                $currentFtuType = Normalize-Text $customerRecordset.Fields('FTUType').Value

                $rowChanged = $false
                $shouldUpdateFtuLocation = $false
                $shouldUpdateFtuType = $false

                $currentFtuLocationComparable = if ($null -eq $currentFtuLocation) { '' } else { $currentFtuLocation }
                $targetFtuLocationComparable = if ($null -eq $targetFtuLocation) { '' } else { $targetFtuLocation }
                if ($currentFtuLocationComparable -ne $targetFtuLocationComparable) {
                    $currentIsSensitive = @('GL', 'EG', 'RESV') -contains $currentFtuLocationComparable
                    $targetIsSensitive = @('GL', 'EG', 'RESV') -contains $targetFtuLocationComparable
                    if ($currentFtuLocationComparable -ne 'GV' -and ($currentIsSensitive -or $targetIsSensitive)) {
                        $addressCodeParts = @(@(
                            (Normalize-Text $customerRecordset.Fields('Postcode').Value),
                            (Normalize-Text $customerRecordset.Fields('Huisnr').Value),
                            (Normalize-Text $customerRecordset.Fields('Toevoeging').Value),
                            (Normalize-Text $customerRecordset.Fields('KAMER').Value)
                        ) | Where-Object { $null -ne $_ })

                        $statusChangeWarnings.Add([pscustomobject]@{
                            CableId     = $cableId
                            AddressCode = if ($addressCodeParts.Count -gt 0) { ($addressCodeParts -join '-') } else { $null }
                            From        = if ($currentFtuLocationComparable -eq '') { $null } else { $currentFtuLocationComparable }
                            To          = if ($targetFtuLocationComparable -eq '') { $null } else { $targetFtuLocationComparable }
                        })
                    }

                    $rowChanged = $true
                    $shouldUpdateFtuLocation = $true
                    $updatedCustomerFields++
                }

                $currentFtuTypeComparable = if ($null -eq $currentFtuType) { '' } else { $currentFtuType }
                $targetFtuTypeComparable = if ($null -eq $targetFtuType) { '' } else { $targetFtuType }
                if ($currentFtuTypeComparable -ne $targetFtuTypeComparable) {
                    $rowChanged = $true
                    $shouldUpdateFtuType = $true
                    $updatedCustomerFields++
                }

                if ($rowChanged) {
                    $pendingCustomerUpdates.Add([pscustomobject]@{
                        RowId                 = $rowId
                        TargetFtuLocation     = if ($shouldUpdateFtuLocation) { $targetFtuLocation } else { $currentFtuLocation }
                        TargetFtuType         = if ($shouldUpdateFtuType) { $targetFtuType } else { $currentFtuType }
                    })
                    $updatedCustomers++
                }

                if ($matchedByAddress -and $null -ne $cableId -and -not $fallbackCableLookup.ContainsKey($cableId)) {
                    $fallbackCableLookup[$cableId] = $fcItem
                }
            }

            $customerRecordset.MoveNext()
        }
    }
    finally {
        $customerRecordset.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($customerRecordset)
    }

    foreach ($customerUpdate in $pendingCustomerUpdates) {
        $Database.Execute((
            'UPDATE [Klant] SET [Kastnr] = {0}, [FTUType] = {1} WHERE [ID] = {2}' -f
            (Convert-ToAccessTextLiteral $customerUpdate.TargetFtuLocation),
            (Convert-ToAccessTextLiteral $customerUpdate.TargetFtuType),
            [int]$customerUpdate.RowId
        ))
    }

    $cableRecordset = $Database.OpenRecordset('SELECT [ID], [Label], [Afwerkeenheid_B], [Kabeltype] FROM [Kabel]')
    try {
        while (-not $cableRecordset.EOF) {
            $label = Normalize-Text $cableRecordset.Fields('Label').Value

            $fcItem = $null
            if ($null -ne $label -and $fcLookup.ContainsKey($label)) {
                $fcItem = $fcLookup[$label]
            }
            elseif ($null -ne $label -and $fallbackCableLookup.ContainsKey($label)) {
                $fcItem = $fallbackCableLookup[$label]
            }

            if ($null -ne $fcItem) {
                $targetStatusLocation = Normalize-UpperStatus $fcItem.FtuLocation
                $targetTermination = if ($fcItem.StatusIs2) { $fcItem.FtuLocation } else { $null }
                $targetCableType = Resolve-CustomerCableType -FtuLocation $targetStatusLocation
                $currentTermination = Normalize-UpperStatus $cableRecordset.Fields('Afwerkeenheid_B').Value
                $currentCableType = Normalize-Text $cableRecordset.Fields('Kabeltype').Value
                $rowChanged = $false

                $currentTerminationComparable = if ($null -eq $currentTermination) { '' } else { $currentTermination }
                $targetTerminationComparable = if ($null -eq $targetTermination) { '' } else { $targetTermination }
                if ($currentTerminationComparable -ne $targetTerminationComparable) {
                    if (-not $rowChanged) {
                        $cableRecordset.Edit()
                        $rowChanged = $true
                    }

                    $cableRecordset.Fields('Afwerkeenheid_B').Value = if ($null -eq $targetTermination) { [System.DBNull]::Value } else { [string]$targetTermination }
                    $updatedCableFields++
                }

                $currentCableTypeComparable = if ($null -eq $currentCableType) { '' } else { $currentCableType }
                $targetCableTypeComparable = if ($null -eq $targetCableType) { '' } else { $targetCableType }
                $isDuctCable = $null -ne $label -and $ductCableLookup.ContainsKey($label.ToUpperInvariant())
                if (-not $isDuctCable -and $currentCableTypeComparable -ne $targetCableTypeComparable) {
                    if (-not $rowChanged) {
                        $cableRecordset.Edit()
                        $rowChanged = $true
                    }

                    if ($null -eq $targetCableType -or ($targetCableType -is [string] -and $targetCableType.Length -eq 0)) {
                        $cableRecordset.Fields('Kabeltype').Value = [System.DBNull]::Value
                    }
                    else {
                        $cableRecordset.Fields('Kabeltype').Value = [string]$targetCableType
                    }
                    $updatedCableFields++
                }

                if ($rowChanged) {
                    $cableRecordset.Update()
                    $updatedCables++
                }
            }

            $cableRecordset.MoveNext()
        }
    }
    finally {
        $cableRecordset.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($cableRecordset)
    }

    return [pscustomobject]@{
        updatedCustomers      = $updatedCustomers
        updatedCustomerFields = $updatedCustomerFields
        updatedCables         = $updatedCables
        updatedCableFields    = $updatedCableFields
        available             = $fcLookup.Count
        warnings              = @($statusChangeWarnings)
    }
}

function Apply-GlaspoortProject {
    param([__ComObject]$Database)

    $targetRows = @(
        [pscustomobject]@{
            ID     = 2
            NAAM   = 'Projectomschrijving'
            WAARDE = 'Oplevering Glaspoort aansluitingen'
        },
        [pscustomobject]@{
            ID     = 3
            NAAM   = 'Olo'
            WAARDE = 'Glaspoort'
        }
    )

    $existingById = @{}
    $recordset = $Database.OpenRecordset('SELECT [ID], [NAAM], [WAARDE] FROM [Instellingen] WHERE [ID] IN (2, 3)')

    try {
        while (-not $recordset.EOF) {
            $existingById[[int]$recordset.Fields('ID').Value] = @{
                NAAM   = Normalize-Text $recordset.Fields('NAAM').Value
                WAARDE = Normalize-Text $recordset.Fields('WAARDE').Value
            }
            $recordset.MoveNext()
        }
    }
    finally {
        $recordset.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($recordset)
    }

    $updated = 0
    $inserted = 0

    foreach ($targetRow in $targetRows) {
        $sqlNaam = $targetRow.NAAM.Replace("'", "''")
        $sqlWaarde = $targetRow.WAARDE.Replace("'", "''")

        if ($existingById.ContainsKey([int]$targetRow.ID)) {
            $currentRow = $existingById[[int]$targetRow.ID]
            if ($currentRow.NAAM -ne $targetRow.NAAM -or $currentRow.WAARDE -ne $targetRow.WAARDE) {
                $Database.Execute("UPDATE [Instellingen] SET [NAAM] = '$sqlNaam', [WAARDE] = '$sqlWaarde' WHERE [ID] = $($targetRow.ID)")
                $updated++
            }
        }
        else {
            $Database.Execute("INSERT INTO [Instellingen] ([ID], [NAAM], [WAARDE]) VALUES ($($targetRow.ID), '$sqlNaam', '$sqlWaarde')")
            $inserted++
        }
    }

    return [pscustomobject]@{
        updated  = $updated
        inserted = $inserted
    }
}

function Get-RiserData {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "No se ha encontrado el fichero de datos del riser: $Path"
    }

    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    return (ConvertFrom-Json -InputObject ($raw -replace '^\uFEFF', ''))
}

function Test-StartsWithNormalized {
    param(
        [object]$Value,
        [string]$Prefix
    )

    $normalizedValue = Normalize-Text $Value
    $normalizedPrefix = Normalize-Text $Prefix

    if ($null -eq $normalizedValue -or $null -eq $normalizedPrefix) {
        return $false
    }

    return $normalizedValue.StartsWith($normalizedPrefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Clear-AccessTableSavedOrder {
    param(
        [__ComObject]$Database,
        [string]$TableName
    )

    try {
        $tableDef = $Database.TableDefs[$TableName]
        foreach ($propertyName in @('OrderBy', 'Filter')) {
            try {
                $tableDef.Properties[$propertyName].Value = ''
            }
            catch {
            }
        }

        foreach ($propertyName in @('OrderByOn', 'FilterOn')) {
            try {
                $tableDef.Properties[$propertyName].Value = $false
            }
            catch {
            }
        }
    }
    catch {
    }
}

function Get-RiserStateEntry {
    param(
        [hashtable]$Lookup,
        [string]$DpLabel
    )

    $key = $DpLabel.ToUpperInvariant()
    if (-not $Lookup.ContainsKey($key)) {
        $Lookup[$key] = [pscustomobject]@{
            DpLabel         = $DpLabel
            TubeNumbers     = [System.Collections.Generic.HashSet[int]]::new()
            TrajectRows     = 0
            DuctRows        = 0
            AccesspointRows = 0
            CableIds        = [System.Collections.Generic.HashSet[string]]::new()
        }
    }

    return $Lookup[$key]
}

function Export-RiserState {
    param([__ComObject]$Database)

    $lookup = @{}

    foreach ($row in @(Get-TableRows -Database $Database -TableName 'Traject')) {
        $label = Normalize-Text $row.Label
        if ($null -ne $label -and $label -match '^(?<dp>.+-ODP[0-9A-Z]+)-TK(?<tube>\d+)-S\d+$') {
            $entry = Get-RiserStateEntry -Lookup $lookup -DpLabel $Matches.dp
            [void]$entry.TubeNumbers.Add([int]$Matches.tube)
            $entry.TrajectRows++
        }
    }

    foreach ($row in @(Get-TableRows -Database $Database -TableName 'Duct')) {
        $label = Normalize-Text $row.Traject
        if ($null -eq $label) {
            $label = Normalize-Text $row.Duct
        }

        if ($null -ne $label -and $label -match '^(?<dp>.+-ODP[0-9A-Z]+)-TK(?<tube>\d+)-S\d+$') {
            $entry = Get-RiserStateEntry -Lookup $lookup -DpLabel $Matches.dp
            [void]$entry.TubeNumbers.Add([int]$Matches.tube)
            $entry.DuctRows++
            $cableId = Normalize-Text $row.Kabel
            if ($null -ne $cableId) {
                [void]$entry.CableIds.Add($cableId)
            }
        }
    }

    foreach ($row in @(Get-TableRows -Database $Database -TableName 'Accesspoint')) {
        $label = Normalize-Text $row.Label
        if ($null -ne $label -and $label -match '^(?<dp>.+-ODP[0-9A-Z]+)-ET-(?<tube>\d+)$') {
            $entry = Get-RiserStateEntry -Lookup $lookup -DpLabel $Matches.dp
            [void]$entry.TubeNumbers.Add([int]$Matches.tube)
            $entry.AccesspointRows++
        }
    }

    $items = @()
    foreach ($entry in $lookup.Values) {
        $tubeNumbers = @($entry.TubeNumbers | Sort-Object)
        $nextTubeNumber = if ($tubeNumbers.Count -gt 0) { ([int]($tubeNumbers | Measure-Object -Maximum).Maximum) + 1 } else { 1 }
        $items += [pscustomobject]@{
            DpLabel         = $entry.DpLabel
            TubeNumbers     = $tubeNumbers
            NextTubeNumber  = $nextTubeNumber
            TrajectRows     = $entry.TrajectRows
            DuctRows        = $entry.DuctRows
            AccesspointRows = $entry.AccesspointRows
            CableIds        = @($entry.CableIds | Sort-Object)
        }
    }

    return [pscustomobject]@{
        Risers = @($items | Sort-Object DpLabel)
    }
}

function Apply-RiserData {
    param(
        [__ComObject]$Database,
        [string]$Path
    )

    $sourceData = Get-RiserData -Path $Path
    $dpLabel = Normalize-Text $sourceData.DpLabel
    if ($null -eq $dpLabel) {
        throw 'Los datos del riser no incluyen DpLabel.'
    }

    $sourceTrajectRows = @($sourceData.TableRows.Traject)
    $sourceDuctRows = @($sourceData.TableRows.Duct | Sort-Object { [int]$_.ID })
    $sourceAccesspointRows = @($sourceData.TableRows.Accesspoint)
    $kabelTypeUpdates = @($sourceData.KabelTypeUpdates)

    $existingTrajectRows = @(Get-TableRows -Database $Database -TableName 'Traject')
    $existingDuctRows = @(Get-TableRows -Database $Database -TableName 'Duct')
    $existingAccesspointRows = @(Get-TableRows -Database $Database -TableName 'Accesspoint')
    $existingKabelRows = @(Get-TableRows -Database $Database -TableName 'Kabel')

    $targetTrajectRows = @()
    foreach ($row in $existingTrajectRows) {
        if (-not (Test-StartsWithNormalized -Value $row.Label -Prefix ('{0}-TK' -f $dpLabel))) {
            $targetTrajectRows += $row
        }
    }
    $targetTrajectRows += $sourceTrajectRows
    $targetTrajectRows = @(Reset-ConnectionSyncIds -Rows $targetTrajectRows)

    $targetDuctRows = @()
    foreach ($row in $existingDuctRows) {
        $matchesRiser = (Test-StartsWithNormalized -Value $row.Duct -Prefix ('{0}-TK' -f $dpLabel)) -or
            (Test-StartsWithNormalized -Value $row.Traject -Prefix ('{0}-TK' -f $dpLabel))
        if (-not $matchesRiser) {
            $targetDuctRows += $row
        }
    }
    $targetDuctRows += $sourceDuctRows
    $targetDuctRows = @(Reset-ConnectionSyncIds -Rows $targetDuctRows)

    $targetAccesspointRows = @()
    foreach ($row in $existingAccesspointRows) {
        if (-not (Test-StartsWithNormalized -Value $row.Label -Prefix ('{0}-ET-' -f $dpLabel))) {
            $targetAccesspointRows += $row
        }
    }
    $targetAccesspointRows += $sourceAccesspointRows
    $targetAccesspointRows = @(Reset-ConnectionSyncIds -Rows $targetAccesspointRows)

    $updatedKabelRows = @()
    $kabelUpdateLookup = @{}
    foreach ($update in $kabelTypeUpdates) {
        $cableId = Normalize-Text $update.CableId
        if ($null -ne $cableId) {
            $kabelUpdateLookup[$cableId.ToUpperInvariant()] = Normalize-Text $update.Kabeltype
        }
    }

    $updatedCableCount = 0
    $missingCableIds = [System.Collections.Generic.List[string]]::new()
    foreach ($row in $existingKabelRows) {
        $rowCableId = Normalize-Text $row.Label
        if ($null -ne $rowCableId -and $kabelUpdateLookup.ContainsKey($rowCableId.ToUpperInvariant())) {
            $targetType = $kabelUpdateLookup[$rowCableId.ToUpperInvariant()]
            $currentType = Normalize-Text $row.Kabeltype
            $currentComparable = if ($null -eq $currentType) { '' } else { $currentType }
            $targetComparable = if ($null -eq $targetType) { '' } else { $targetType }
            if ($currentComparable -ne $targetComparable) {
                $row.Kabeltype = $targetType
                $updatedCableCount++
            }

            $updatedKabelRows += $row
            [void]$kabelUpdateLookup.Remove($rowCableId.ToUpperInvariant())
            continue
        }

        $updatedKabelRows += $row
    }

    foreach ($missingKey in $kabelUpdateLookup.Keys) {
        $missingCableIds.Add($missingKey)
    }

    $updatedKabelRows = @(Reset-ConnectionSyncIds -Rows $updatedKabelRows)

    Clear-AccessTables -Database $Database -TableNames @('Traject', 'Duct', 'Accesspoint', 'Kabel')
    Write-AccessTable -Database $Database -TableName 'Traject' -Rows $targetTrajectRows
    Write-AccessTable -Database $Database -TableName 'Duct' -Rows $targetDuctRows
    Write-AccessTable -Database $Database -TableName 'Accesspoint' -Rows $targetAccesspointRows
    Write-AccessTable -Database $Database -TableName 'Kabel' -Rows $updatedKabelRows
    Clear-AccessTableSavedOrder -Database $Database -TableName 'Duct'

    return [pscustomobject]@{
        dpLabel             = $dpLabel
        trajectRowsAdded    = @($sourceTrajectRows).Count
        ductRowsAdded       = @($sourceDuctRows).Count
        accesspointRowsAdded = @($sourceAccesspointRows).Count
        kabelUpdated        = $updatedCableCount
        missingCableIds     = @($missingCableIds | Sort-Object)
        finalTrajectRows    = @($targetTrajectRows).Count
        finalDuctRows       = @($targetDuctRows).Count
        finalAccesspointRows = @($targetAccesspointRows).Count
    }
}

function Add-RiserData {
    param(
        [__ComObject]$Database,
        [string]$Path
    )

    $sourceData = Get-RiserData -Path $Path
    $dpLabel = Normalize-Text $sourceData.DpLabel
    if ($null -eq $dpLabel) {
        throw 'Los datos del riser no incluyen DpLabel.'
    }

    $sourceTrajectRows = @($sourceData.TableRows.Traject)
    $sourceDuctRows = @($sourceData.TableRows.Duct | Sort-Object { [int]$_.ID })
    $sourceAccesspointRows = @($sourceData.TableRows.Accesspoint)
    $kabelTypeUpdates = @($sourceData.KabelTypeUpdates)

    $existingTrajectRows = @(Get-TableRows -Database $Database -TableName 'Traject')
    $existingDuctRows = @(Get-TableRows -Database $Database -TableName 'Duct')
    $existingAccesspointRows = @(Get-TableRows -Database $Database -TableName 'Accesspoint')
    $existingKabelRows = @(Get-TableRows -Database $Database -TableName 'Kabel')

    $existingTrajectLabels = @{}
    foreach ($row in $existingTrajectRows) {
        $label = Normalize-Text $row.Label
        if ($null -ne $label) { $existingTrajectLabels[$label.ToUpperInvariant()] = $true }
    }

    $existingAccesspointLabels = @{}
    foreach ($row in $existingAccesspointRows) {
        $label = Normalize-Text $row.Label
        if ($null -ne $label) { $existingAccesspointLabels[$label.ToUpperInvariant()] = $true }
    }

    $existingDuctKeys = @{}
    foreach ($row in $existingDuctRows) {
        $ductLabel = Normalize-Text $row.Duct
        $subDuct = Normalize-Text $row.SubDuct
        if ($null -ne $ductLabel -and $null -ne $subDuct) {
            $existingDuctKeys[('{0}|{1}' -f $ductLabel, $subDuct).ToUpperInvariant()] = $true
        }
    }

    $collisions = [System.Collections.Generic.List[string]]::new()
    foreach ($row in $sourceTrajectRows) {
        $label = Normalize-Text $row.Label
        if ($null -ne $label -and $existingTrajectLabels.ContainsKey($label.ToUpperInvariant())) {
            $collisions.Add("Traject $label")
        }
    }
    foreach ($row in $sourceAccesspointRows) {
        $label = Normalize-Text $row.Label
        if ($null -ne $label -and $existingAccesspointLabels.ContainsKey($label.ToUpperInvariant())) {
            $collisions.Add("Accesspoint $label")
        }
    }
    foreach ($row in $sourceDuctRows) {
        $ductLabel = Normalize-Text $row.Duct
        $subDuct = Normalize-Text $row.SubDuct
        if ($null -ne $ductLabel -and $null -ne $subDuct -and $existingDuctKeys.ContainsKey(('{0}|{1}' -f $ductLabel, $subDuct).ToUpperInvariant())) {
            $collisions.Add("Duct $ductLabel / $subDuct")
        }
    }

    if ($collisions.Count -gt 0) {
        throw "No se puede anadir el ET porque ya existen filas para ese riser: $(@($collisions | Select-Object -First 12) -join ', ')"
    }

    $targetTrajectRows = @(Reset-ConnectionSyncIds -Rows @($existingTrajectRows + $sourceTrajectRows))
    $targetDuctRows = @(Reset-ConnectionSyncIds -Rows @($existingDuctRows + $sourceDuctRows))
    $targetAccesspointRows = @(Reset-ConnectionSyncIds -Rows @($existingAccesspointRows + $sourceAccesspointRows))

    $updatedKabelRows = @()
    $kabelUpdateLookup = @{}
    foreach ($update in $kabelTypeUpdates) {
        $cableId = Normalize-Text $update.CableId
        if ($null -ne $cableId) {
            $kabelUpdateLookup[$cableId.ToUpperInvariant()] = Normalize-Text $update.Kabeltype
        }
    }

    $updatedCableCount = 0
    $missingCableIds = [System.Collections.Generic.List[string]]::new()
    foreach ($row in $existingKabelRows) {
        $rowCableId = Normalize-Text $row.Label
        if ($null -ne $rowCableId -and $kabelUpdateLookup.ContainsKey($rowCableId.ToUpperInvariant())) {
            $targetType = $kabelUpdateLookup[$rowCableId.ToUpperInvariant()]
            $currentType = Normalize-Text $row.Kabeltype
            $currentComparable = if ($null -eq $currentType) { '' } else { $currentType }
            $targetComparable = if ($null -eq $targetType) { '' } else { $targetType }
            if ($currentComparable -ne $targetComparable) {
                $row.Kabeltype = $targetType
                $updatedCableCount++
            }

            $updatedKabelRows += $row
            [void]$kabelUpdateLookup.Remove($rowCableId.ToUpperInvariant())
            continue
        }

        $updatedKabelRows += $row
    }

    foreach ($missingKey in $kabelUpdateLookup.Keys) {
        $missingCableIds.Add($missingKey)
    }

    $updatedKabelRows = @(Reset-ConnectionSyncIds -Rows $updatedKabelRows)

    Clear-AccessTables -Database $Database -TableNames @('Traject', 'Duct', 'Accesspoint', 'Kabel')
    Write-AccessTable -Database $Database -TableName 'Traject' -Rows $targetTrajectRows
    Write-AccessTable -Database $Database -TableName 'Duct' -Rows $targetDuctRows
    Write-AccessTable -Database $Database -TableName 'Accesspoint' -Rows $targetAccesspointRows
    Write-AccessTable -Database $Database -TableName 'Kabel' -Rows $updatedKabelRows
    Clear-AccessTableSavedOrder -Database $Database -TableName 'Duct'

    return [pscustomobject]@{
        dpLabel              = $dpLabel
        trajectRowsAdded     = @($sourceTrajectRows).Count
        ductRowsAdded        = @($sourceDuctRows).Count
        accesspointRowsAdded = @($sourceAccesspointRows).Count
        kabelUpdated         = $updatedCableCount
        missingCableIds      = @($missingCableIds | Sort-Object)
        finalTrajectRows     = @($targetTrajectRows).Count
        finalDuctRows        = @($targetDuctRows).Count
        finalAccesspointRows = @($targetAccesspointRows).Count
    }
}

function Delete-RiserData {
    param(
        [__ComObject]$Database,
        [string]$Path
    )

    $sourceData = Get-RiserData -Path $Path
    $dpLabel = Normalize-Text $sourceData.DpLabel
    if ($null -eq $dpLabel) {
        throw 'Los datos del riser no incluyen DpLabel.'
    }

    $existingTrajectRows = @(Get-TableRows -Database $Database -TableName 'Traject')
    $existingDuctRows = @(Get-TableRows -Database $Database -TableName 'Duct')
    $existingAccesspointRows = @(Get-TableRows -Database $Database -TableName 'Accesspoint')

    $targetTrajectRows = @()
    $removedTrajectRows = 0
    foreach ($row in $existingTrajectRows) {
        if (Test-StartsWithNormalized -Value $row.Label -Prefix ('{0}-TK' -f $dpLabel)) {
            $removedTrajectRows++
            continue
        }

        $targetTrajectRows += $row
    }
    $targetTrajectRows = @(Reset-ConnectionSyncIds -Rows $targetTrajectRows)

    $targetDuctRows = @()
    $removedDuctRows = 0
    $affectedCableLookup = @{}
    foreach ($row in $existingDuctRows) {
        $matchesRiser = (Test-StartsWithNormalized -Value $row.Duct -Prefix ('{0}-TK' -f $dpLabel)) -or
            (Test-StartsWithNormalized -Value $row.Traject -Prefix ('{0}-TK' -f $dpLabel))

        if ($matchesRiser) {
            $removedDuctRows++
            $cableId = Normalize-Text $row.Kabel
            if ($null -ne $cableId) {
                $affectedCableLookup[$cableId.ToUpperInvariant()] = $cableId
            }
            continue
        }

        $targetDuctRows += $row
    }
    $targetDuctRows = @(Reset-ConnectionSyncIds -Rows $targetDuctRows)

    $targetAccesspointRows = @()
    $removedAccesspointRows = 0
    foreach ($row in $existingAccesspointRows) {
        if (Test-StartsWithNormalized -Value $row.Label -Prefix ('{0}-ET-' -f $dpLabel)) {
            $removedAccesspointRows++
            continue
        }

        $targetAccesspointRows += $row
    }
    $targetAccesspointRows = @(Reset-ConnectionSyncIds -Rows $targetAccesspointRows)

    if ($removedTrajectRows -gt 0 -or $removedDuctRows -gt 0 -or $removedAccesspointRows -gt 0) {
        Clear-AccessTables -Database $Database -TableNames @('Traject', 'Duct', 'Accesspoint')
        Write-AccessTable -Database $Database -TableName 'Traject' -Rows $targetTrajectRows
        Write-AccessTable -Database $Database -TableName 'Duct' -Rows $targetDuctRows
        Write-AccessTable -Database $Database -TableName 'Accesspoint' -Rows $targetAccesspointRows
        Clear-AccessTableSavedOrder -Database $Database -TableName 'Duct'
    }

    return [pscustomobject]@{
        dpLabel                = $dpLabel
        removedTrajectRows     = $removedTrajectRows
        removedDuctRows        = $removedDuctRows
        removedAccesspointRows = $removedAccesspointRows
        affectedCableIds       = @($affectedCableLookup.Values | Sort-Object)
        finalTrajectRows       = @($targetTrajectRows).Count
        finalDuctRows          = @($targetDuctRows).Count
        finalAccesspointRows   = @($targetAccesspointRows).Count
    }
}

function Test-AccessValueExists {
    param(
        [__ComObject]$Database,
        [string]$TableName,
        [string]$FieldName,
        [string]$Value
    )

    $recordset = $Database.OpenRecordset("SELECT COUNT(*) AS [Cnt] FROM [$TableName] WHERE [$FieldName] = $(Convert-ToAccessTextLiteral $Value)")
    try {
        return ([int]$recordset.Fields('Cnt').Value) -gt 0
    }
    finally {
        $recordset.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($recordset)
    }
}

function Get-ProjectLabelFromDatabase {
    param([__ComObject]$Database)

    $recordset = $Database.OpenRecordset('SELECT TOP 1 [Label] FROM [POP]')
    try {
        if (-not $recordset.EOF) {
            $label = Normalize-Text $recordset.Fields('Label').Value
            if ($null -ne $label) {
                return $label
            }
        }
    }
    finally {
        $recordset.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($recordset)
    }

    foreach ($lookup in @(
        @{ Table = 'Kabel'; Fields = @('Locatienaam_A', 'Afwerkeenheid_A', 'Label') },
        @{ Table = 'Accesspoint'; Fields = @('Label') },
        @{ Table = 'SpliceBox'; Fields = @('Label') },
        @{ Table = 'Las'; Fields = @('LOCATIE', 'SPLICEBOX', 'KabelA', 'KabelB') }
    )) {
        foreach ($fieldName in $lookup.Fields) {
            $fallbackRecordset = $null
            try {
                $fallbackRecordset = $Database.OpenRecordset("SELECT TOP 50 [$fieldName] FROM [$($lookup.Table)] WHERE [$fieldName] Is Not Null")
                while (-not $fallbackRecordset.EOF) {
                    $candidate = Normalize-Text $fallbackRecordset.Fields($fieldName).Value
                    if ($null -ne $candidate) {
                        $candidate = $candidate -replace '^(?i:K-)', ''
                        $match = [regex]::Match($candidate, '^(.+?)-(?:O?DP\d+|B\d+|T\d+)(?:-|$)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
                        if ($match.Success) { return $match.Groups[1].Value }
                    }
                    $fallbackRecordset.MoveNext()
                }
            }
            catch {
                continue
            }
            finally {
                if ($null -ne $fallbackRecordset) {
                    $fallbackRecordset.Close()
                    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($fallbackRecordset)
                }
            }
        }
    }

    throw 'No se ha podido resolver el Label del proyecto desde POP, Kabel, Accesspoint, SpliceBox ni Las.'
}

function Convert-ToAccessNumberLiteral {
    param([double]$Value)

    return [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, '{0:R}', $Value)
}

function Apply-Buiseind {
    param(
        [__ComObject]$Database,
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "No se ha encontrado el fichero de Buiseind: $Path"
    }

    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $sourceData = ConvertFrom-Json -InputObject ($raw -replace '^\uFEFF', '')
    $projectLabel = Get-ProjectLabelFromDatabase -Database $Database
    $buisNumber = Normalize-Text $sourceData.BuisNumber

    if ($null -eq $buisNumber -or $buisNumber -notmatch '^\d{2,3}$') {
        throw 'Numero de Buiseind no valido. Usa valores como B06 o 06.'
    }

    $xValue = Convert-ToNullableDouble $sourceData.X
    $yValue = Convert-ToNullableDouble $sourceData.Y
    if ($null -eq $xValue -or $null -eq $yValue) {
        throw 'Las coordenadas del Buiseind no son validas.'
    }

    $accesspointLabel = '{0}-B{1}-BE-01' -f $projectLabel, $buisNumber
    $trajectLabel = '{0}-T{1}-S01' -f $projectLabel, $buisNumber
    $ductLabel = '{0}-B{1}-S01' -f $projectLabel, $buisNumber

    if (Test-AccessValueExists -Database $Database -TableName 'Accesspoint' -FieldName 'Label' -Value $accesspointLabel) {
        throw "Ya existe Accesspoint [$accesspointLabel]."
    }

    if (Test-AccessValueExists -Database $Database -TableName 'Traject' -FieldName 'Label' -Value $trajectLabel) {
        throw "Ya existe Traject [$trajectLabel]."
    }

    if (Test-AccessValueExists -Database $Database -TableName 'Duct' -FieldName 'Duct' -Value $ductLabel) {
        throw "Ya existe Duct [$ductLabel]."
    }

    $Database.Execute("INSERT INTO [Accesspoint] ([Label], [Accesspointtype], [X], [Y], [Z], [Nauwkeurigheid]) VALUES ($(Convert-ToAccessTextLiteral $accesspointLabel), $(Convert-ToAccessTextLiteral 'Buiseinde'), $(Convert-ToAccessNumberLiteral ([double]$xValue)), $(Convert-ToAccessNumberLiteral ([double]$yValue)), -60, 0)")

    $Database.Execute("INSERT INTO [Traject] ([Label], [Locatie_A], [Locatie_B], [Nauwkeurigheid]) VALUES ($(Convert-ToAccessTextLiteral $trajectLabel), $(Convert-ToAccessTextLiteral $projectLabel), $(Convert-ToAccessTextLiteral $accesspointLabel), 0)")

    foreach ($subduct in @('RD', 'WT')) {
        $Database.Execute("INSERT INTO [Duct] ([Duct], [DUCTTYPE], [StandA], [StandB], [DIAMETERDUCT], [Traject], [SubDuct], [DiameterSubDuct]) VALUES ($(Convert-ToAccessTextLiteral $ductLabel), $(Convert-ToAccessTextLiteral '2MK10-DB_WP01'), 0, 0, 22, $(Convert-ToAccessTextLiteral $trajectLabel), $(Convert-ToAccessTextLiteral $subduct), 10)")
    }

    Clear-AccessTableSavedOrder -Database $Database -TableName 'Duct'

    return [pscustomobject]@{
        projectLabel = $projectLabel
        buisNumber = $buisNumber
        accesspointLabel = $accesspointLabel
        trajectLabel = $trajectLabel
        ductLabel = $ductLabel
        accesspointRowsAdded = 1
        trajectRowsAdded = 1
        ductRowsAdded = 2
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
            $fieldCount = $recordset.Fields.Count

            for ($fieldIndex = 0; $fieldIndex -lt $fieldCount; $fieldIndex++) {
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
        Reset-AccessAutoNumber -Database $Database -TableName $tableName
    }
}

function Reset-AccessAutoNumber {
    param(
        [__ComObject]$Database,
        [string]$TableName
    )

    foreach ($field in $Database.TableDefs[$TableName].Fields) {
        if (($field.Attributes -band 16) -ne 0) {
            $Database.Execute("ALTER TABLE [$tableName] ALTER COLUMN [$($field.Name)] COUNTER (1, 1)")
        }
    }
}

function Compress-AccessDatabase {
    param([string]$Path)

    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    $directory = [System.IO.Path]::GetDirectoryName($resolvedPath)
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($resolvedPath)
    $compactPath = Join-Path $directory ('.{0}.{1}.compact.mdb' -f $baseName, [guid]::NewGuid().ToString('N'))
    $backupPath = Join-Path $directory ('.{0}.{1}.backup.mdb' -f $baseName, [guid]::NewGuid().ToString('N'))
    $engine = $null

    try {
        $engine = New-Object -ComObject DAO.DBEngine.120
        $engine.CompactDatabase($resolvedPath, $compactPath)
        [System.IO.File]::Replace($compactPath, $resolvedPath, $backupPath, $true)
        Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
    }
    finally {
        if ($null -ne $engine) {
            [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($engine)
        }
        Remove-Item -LiteralPath $compactPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
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

function Limit-AccessTextValue {
    param(
        [__ComObject]$Field,
        [object]$Value
    )

    $normalizedText = Normalize-Text $Value
    if ($null -eq $normalizedText) {
        return $null
    }

    $fieldType = [int]$Field.Type
    $fieldSize = [int]$Field.Size
    if ($fieldType -eq 10 -and $fieldSize -gt 0 -and $normalizedText.Length -gt $fieldSize) {
        return $normalizedText.Substring(0, $fieldSize)
    }

    return $normalizedText
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

        $normalizedText = Limit-AccessTextValue -Field $field -Value $Value
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
            $recordset.AddNew()
            foreach ($property in $row.PSObject.Properties) {
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

function Get-ConnectionSyncTableNames {
    return @('Traject', 'Duct', 'Accesspoint', 'SpliceBox', 'Kabel', 'Klant', 'Las')
}

function Get-ConnectionSyncKey {
    param(
        [string]$TableName,
        [object]$Row
    )

    switch ($TableName) {
        'ODF'         { return "NUMMER|$(Normalize-Text $Row.Nummer)" }
        'AfwerkODF'   { return "ODF|$(Normalize-Text $Row.ODF)|PP|$(Normalize-Text $Row.PP)" }
        'Traject'     { return Normalize-Text $Row.Label }
        'Duct'        { return "DUCT|$(Normalize-Text $Row.Duct)|SUB|$(Normalize-Text $Row.SubDuct)" }
        'Accesspoint' { return Normalize-Text $Row.Label }
        'SpliceBox'   { return Normalize-Text $Row.Label }
        'Kabel'       { return Normalize-Text $Row.Label }
        'Klant'       { return Normalize-Text $Row.Kabel }
        'Las' {
            return @(
                Normalize-Text $Row.Locatie,
                Normalize-Text $Row.SpliceBox,
                Normalize-Text $Row.KabelA,
                Normalize-Text $Row.VezelnrA,
                Normalize-Text $Row.Cassette,
                Normalize-Text $Row.Positie,
                Normalize-Text $Row.KabelB,
                Normalize-Text $Row.VezelnrB,
                Normalize-Text $Row.zijde_fasplaat
            ) -join '|'
        }
        default { return $null }
    }
}

function Get-ConnectionSyncPreservedFieldNames {
    param([string]$TableName)

    switch ($TableName) {
        'Accesspoint' { return @('X', 'Y', 'Z', 'Toelichting', 'Nauwkeurigheid', 'ImportResult') }
        'SpliceBox'   { return @('X', 'Y', 'Z', 'Nauwkeurigheid', 'ImportResult') }
        'Kabel'       { return @('Afwerkeenheid_A', 'Afwerkeenheid_B', 'PoortA', 'PoortB', 'Serienummer', 'ImportResult', 'CATEGORIE') }
        'Klant' {
            return @(
                'Kastnr', 'FTUType',
                'VEZELNR1', 'Dempingswaarde1A', 'Specificatie1A', 'Dempingswaarde1Z', 'Specificatie1Z',
                'Vezelnr2', 'Dempingswaarde2A', 'Specificatie2A', 'Dempingswaarde2Z', 'Specificatie2Z',
                'X', 'Y', 'ImportResult', 'COMPLEX', 'KAMER', 'ALIASNAAM', 'FTU_SERIENUMMER'
            )
        }
        default { return @() }
    }
}

function Merge-ConnectionSyncRow {
    param(
        [string]$TableName,
        [object]$SourceRow,
        [object]$ExistingRow
    )

    $merged = [ordered]@{}
    foreach ($property in $SourceRow.PSObject.Properties) {
        $merged[$property.Name] = $property.Value
    }

    foreach ($fieldName in (Get-ConnectionSyncPreservedFieldNames -TableName $TableName)) {
        if ($ExistingRow.PSObject.Properties.Name -contains $fieldName) {
            $existingValue = $ExistingRow.$fieldName
            if ($null -ne $existingValue -and ($existingValue -isnot [string] -or (Normalize-Text $existingValue) -ne $null)) {
                $merged[$fieldName] = $existingValue
            }
        }
    }

    return [pscustomobject]$merged
}

function Reset-ConnectionSyncIds {
    param([object[]]$Rows)

    $nextId = 1
    foreach ($row in $Rows) {
        if ($row.PSObject.Properties.Name -contains 'ID') {
            $row.ID = $nextId
            $nextId++
        }
    }

    return @($Rows)
}

function Get-SourceConnectionSyncData {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "No se ha encontrado el fichero de ajuste de conexiones: $Path"
    }

    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    return (ConvertFrom-Json -InputObject ($raw -replace '^\uFEFF', ''))
}

function Get-FcRefreshData {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "No se ha encontrado el fichero de refresco de FC: $Path"
    }

    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    return (ConvertFrom-Json -InputObject ($raw -replace '^\uFEFF', ''))
}

function Get-FcRefreshPreservedFieldNames {
    param([string]$TableName)

    switch ($TableName) {
        'Kabel' {
            return @(
                'PoortA', 'PoortB', 'Serienummer', 'ImportResult', 'CATEGORIE'
            )
        }
        'Klant' {
            return @(
                'Dempingswaarde1A', 'Specificatie1A', 'Dempingswaarde1Z', 'Specificatie1Z',
                'Dempingswaarde2A', 'Specificatie2A', 'Dempingswaarde2Z', 'Specificatie2Z',
                'X', 'Y', 'ImportResult', 'COMPLEX', 'ALIASNAAM', 'FTU_SERIENUMMER'
            )
        }
        default { return @() }
    }
}

function Get-DuctCableLookup {
    param([__ComObject]$Database)

    $lookup = @{}
    $ductRows = @(Get-TableRows -Database $Database -TableName 'Duct')
    foreach ($row in $ductRows) {
        $cableId = Normalize-Text $row.Kabel
        if ($null -ne $cableId) {
            $lookup[$cableId.ToUpperInvariant()] = $true
        }
    }

    return $lookup
}

function Merge-FcRefreshRow {
    param(
        [string]$TableName,
        [object]$SourceRow,
        [object]$ExistingRow
    )

    $merged = [ordered]@{}
    foreach ($property in $SourceRow.PSObject.Properties) {
        $merged[$property.Name] = $property.Value
    }

    if ($null -eq $ExistingRow) {
        return [pscustomobject]$merged
    }

    foreach ($fieldName in (Get-FcRefreshPreservedFieldNames -TableName $TableName)) {
        if ($ExistingRow.PSObject.Properties.Name -contains $fieldName) {
            $existingValue = $ExistingRow.$fieldName
            if ($null -ne $existingValue -and ($existingValue -isnot [string] -or (Normalize-Text $existingValue) -ne $null)) {
                $merged[$fieldName] = $existingValue
            }
        }
    }

    return [pscustomobject]$merged
}

function Compare-RowChangeCount {
    param(
        [object]$ExistingRow,
        [object]$TargetRow
    )

    if ($null -eq $ExistingRow) {
        $fieldCount = @($TargetRow.PSObject.Properties | Where-Object { $_.Name -ne 'ID' }).Count
        return [pscustomobject]@{
            Changed = $true
            Fields  = $fieldCount
        }
    }

    $changedFields = 0
    foreach ($property in $TargetRow.PSObject.Properties) {
        if ($property.Name -eq 'ID') {
            continue
        }

        $targetValue = $property.Value
        $existingValue = if ($ExistingRow.PSObject.Properties.Name -contains $property.Name) { $ExistingRow.$($property.Name) } else { $null }

        $targetComparable = if ($null -eq $targetValue) { '' } else { [string]$targetValue }
        $existingComparable = if ($null -eq $existingValue) { '' } else { [string]$existingValue }

        if ($targetComparable -ne $existingComparable) {
            $changedFields++
        }
    }

    return [pscustomobject]@{
        Changed = ($changedFields -gt 0)
        Fields  = $changedFields
    }
}

function Get-RowChangeDetails {
    param(
        [object]$ExistingRow,
        [object]$TargetRow
    )

    $names = [System.Collections.Generic.List[string]]::new()

    if ($null -eq $ExistingRow) {
        foreach ($property in $TargetRow.PSObject.Properties) {
            if ($property.Name -ne 'ID') {
                $names.Add($property.Name)
            }
        }

        return @($names)
    }

    foreach ($property in $TargetRow.PSObject.Properties) {
        if ($property.Name -eq 'ID') {
            continue
        }

        $targetValue = $property.Value
        $existingValue = if ($ExistingRow.PSObject.Properties.Name -contains $property.Name) { $ExistingRow.$($property.Name) } else { $null }
        $targetComparable = if ($null -eq $targetValue) { '' } else { [string]$targetValue }
        $existingComparable = if ($null -eq $existingValue) { '' } else { [string]$existingValue }

        if ($targetComparable -ne $existingComparable) {
            $names.Add($property.Name)
        }
    }

    return @($names)
}

function Apply-FcRefresh {
    param(
        [__ComObject]$Database,
        [string]$Path
    )

    $sourceData = Get-FcRefreshData -Path $Path
    $sourceCustomerRows = @(Reset-ConnectionSyncIds -Rows @($sourceData.TableRows.Klant))
    $sourceCableRows = @(Reset-ConnectionSyncIds -Rows @($sourceData.TableRows.Kabel))
    $existingCustomerRows = @(Get-TableRows -Database $Database -TableName 'Klant')
    $existingCableRows = @(Get-TableRows -Database $Database -TableName 'Kabel')
    $ductCableLookup = Get-DuctCableLookup -Database $Database
    $noDempingCableLookup = @{}
    foreach ($cableIdValue in @(Get-JsonPropertyValue -Object $sourceData -Names @('NoDempingCableIds'))) {
        $normalizedCableId = Normalize-Text $cableIdValue
        if ($null -ne $normalizedCableId) {
            $noDempingCableLookup[$normalizedCableId.ToUpperInvariant()] = $true
        }
    }

    $existingCustomersByKey = @{}
    foreach ($row in $existingCustomerRows) {
        $key = Get-ConnectionSyncKey -TableName 'Klant' -Row $row
        if ($null -ne $key) {
            $existingCustomersByKey[$key] = $row
        }
    }

    $existingCablesByKey = @{}
    foreach ($row in $existingCableRows) {
        $key = Get-ConnectionSyncKey -TableName 'Kabel' -Row $row
        if ($null -ne $key) {
            $existingCablesByKey[$key] = $row
        }
    }

    $targetCustomerRows = @()
    $targetCableRows = @()
    $updatedCustomers = 0
    $updatedCustomerFields = 0
    $updatedCables = 0
    $updatedCableFields = 0
    $statusChangeWarnings = [System.Collections.Generic.List[object]]::new()
    $preservedDrawingStatuses = [System.Collections.Generic.List[object]]::new()
    $customerFieldChanges = @{}
    $cableFieldChanges = @{}

    foreach ($warning in @($sourceData.FtuReviewWarnings)) {
        if ($null -ne $warning) {
            $statusChangeWarnings.Add($warning)
        }
    }

    foreach ($sourceRow in $sourceCustomerRows) {
        $key = Get-ConnectionSyncKey -TableName 'Klant' -Row $sourceRow
        $existingRow = if ($null -ne $key -and $existingCustomersByKey.ContainsKey($key)) { $existingCustomersByKey[$key] } else { $null }
        $mergedRow = Merge-FcRefreshRow -TableName 'Klant' -SourceRow $sourceRow -ExistingRow $existingRow
        if ($null -ne $existingRow) {
            $existingFtuLocation = Normalize-UpperStatus $existingRow.Kastnr
            $sourceFtuLocation = Normalize-UpperStatus $sourceRow.Kastnr
            $isDrawingStatusOverride = (
                $existingFtuLocation -in @('GL', 'EG') -and
                $sourceFtuLocation -in @('GL', 'EG') -and
                $existingFtuLocation -ne $sourceFtuLocation
            )

            if ($isDrawingStatusOverride) {
                $mergedRow.Kastnr = $existingFtuLocation
                $addressCodeParts = @(@(
                    (Normalize-Text $mergedRow.Postcode),
                    (Normalize-Text $mergedRow.Huisnr),
                    (Normalize-Text $mergedRow.Toevoeging),
                    (Normalize-Text $mergedRow.KAMER)
                ) | Where-Object { $null -ne $_ })

                $preservedDrawingStatuses.Add([pscustomobject]@{
                    CableId       = Normalize-Text $mergedRow.Kabel
                    AddressCode   = if ($addressCodeParts.Count -gt 0) { ($addressCodeParts -join '-') } else { $null }
                    FcValue       = $sourceFtuLocation
                    PreservedValue = $existingFtuLocation
                })
            }
        }
        $customerCableId = Normalize-Text $mergedRow.Kabel
        if ($null -ne $customerCableId -and $noDempingCableLookup.ContainsKey($customerCableId.ToUpperInvariant())) {
            foreach ($fieldName in @('Dempingswaarde1A', 'Dempingswaarde1Z', 'Dempingswaarde2A', 'Dempingswaarde2Z')) {
                $mergedRow.$fieldName = $null
            }
        }
        $targetCustomerRows += $mergedRow

        $diff = Compare-RowChangeCount -ExistingRow $existingRow -TargetRow $mergedRow
        if ($diff.Changed) {
            $updatedCustomers++
            $updatedCustomerFields += [int]$diff.Fields
            foreach ($fieldName in (Get-RowChangeDetails -ExistingRow $existingRow -TargetRow $mergedRow)) {
                if (-not $customerFieldChanges.ContainsKey($fieldName)) {
                    $customerFieldChanges[$fieldName] = 0
                }
                $customerFieldChanges[$fieldName]++
            }
        }

        if ($null -ne $existingRow) {
            $currentFtuLocation = Normalize-UpperStatus $existingRow.Kastnr
            $targetFtuLocation = Normalize-UpperStatus $mergedRow.Kastnr
            $currentComparable = if ($null -eq $currentFtuLocation) { '' } else { $currentFtuLocation }
            $targetComparable = if ($null -eq $targetFtuLocation) { '' } else { $targetFtuLocation }

            if ($currentComparable -ne $targetComparable) {
                $currentIsSensitive = @('GL', 'EG', 'RESV') -contains $currentComparable
                $targetIsSensitive = @('GL', 'EG', 'RESV') -contains $targetComparable
                if ($currentComparable -ne 'GV' -and ($currentIsSensitive -or $targetIsSensitive)) {
                    $addressCodeParts = @(@(
                        (Normalize-Text $mergedRow.Postcode),
                        (Normalize-Text $mergedRow.Huisnr),
                        (Normalize-Text $mergedRow.Toevoeging),
                        (Normalize-Text $mergedRow.KAMER)
                    ) | Where-Object { $null -ne $_ })

                    $statusChangeWarnings.Add([pscustomobject]@{
                        CableId     = Normalize-Text $mergedRow.Kabel
                        AddressCode = if ($addressCodeParts.Count -gt 0) { ($addressCodeParts -join '-') } else { $null }
                        From        = if ($currentComparable -eq '') { $null } else { $currentComparable }
                        To          = if ($targetComparable -eq '') { $null } else { $targetComparable }
                    })
                }
            }
        }
    }

    foreach ($sourceRow in $sourceCableRows) {
        $key = Get-ConnectionSyncKey -TableName 'Kabel' -Row $sourceRow
        $existingRow = if ($null -ne $key -and $existingCablesByKey.ContainsKey($key)) { $existingCablesByKey[$key] } else { $null }
        $mergedRow = Merge-FcRefreshRow -TableName 'Kabel' -SourceRow $sourceRow -ExistingRow $existingRow
        $label = Normalize-Text $mergedRow.Label
        if ($null -ne $existingRow -and $null -ne $label -and $ductCableLookup.ContainsKey($label.ToUpperInvariant())) {
            $mergedRow.Kabeltype = $existingRow.Kabeltype
        }
        $targetCableRows += $mergedRow

        $diff = Compare-RowChangeCount -ExistingRow $existingRow -TargetRow $mergedRow
        if ($diff.Changed) {
            $updatedCables++
            $updatedCableFields += [int]$diff.Fields
            foreach ($fieldName in (Get-RowChangeDetails -ExistingRow $existingRow -TargetRow $mergedRow)) {
                if (-not $cableFieldChanges.ContainsKey($fieldName)) {
                    $cableFieldChanges[$fieldName] = 0
                }
                $cableFieldChanges[$fieldName]++
            }
        }
    }

    $targetCustomerRows = @(Reset-ConnectionSyncIds -Rows $targetCustomerRows)
    $targetCableRows = @(Reset-ConnectionSyncIds -Rows $targetCableRows)

    Clear-AccessTables -Database $Database -TableNames @('Klant', 'Kabel')
    Write-AccessTable -Database $Database -TableName 'Kabel' -Rows $targetCableRows
    Write-AccessTable -Database $Database -TableName 'Klant' -Rows $targetCustomerRows

    $sourceCustomerIds = @(Get-ConnectionCableIdsFromRows -Rows $sourceCustomerRows)
    $existingCustomerIds = @(Get-ConnectionCableIdsFromRows -Rows $existingCustomerRows)
    $sourceSet = @{}
    foreach ($id in $sourceCustomerIds) { $sourceSet[$id.ToUpperInvariant()] = $true }
    $existingSet = @{}
    foreach ($id in $existingCustomerIds) { $existingSet[$id.ToUpperInvariant()] = $true }

    $removedCustomerIds = @($existingCustomerIds | Where-Object { -not $sourceSet.ContainsKey($_.ToUpperInvariant()) } | Sort-Object)
    $addedCustomerIds = @($sourceCustomerIds | Where-Object { -not $existingSet.ContainsKey($_.ToUpperInvariant()) } | Sort-Object)

    return [pscustomobject]@{
        updatedCustomers      = $updatedCustomers
        updatedCustomerFields = $updatedCustomerFields
        updatedCables         = $updatedCables
        updatedCableFields    = $updatedCableFields
        available             = $sourceCustomerRows.Count
        rebuiltCustomers      = $sourceCustomerRows.Count
        rebuiltCables         = $sourceCableRows.Count
        finalCustomers        = $targetCustomerRows.Count
        finalCables           = $targetCableRows.Count
        addedCustomers        = $addedCustomerIds.Count
        removedCustomers      = $removedCustomerIds.Count
        customerFieldChanges  = [pscustomobject]$customerFieldChanges
        cableFieldChanges     = [pscustomobject]$cableFieldChanges
        warnings              = @($statusChangeWarnings)
        preservedDrawingStatusCount = $preservedDrawingStatuses.Count
        preservedDrawingStatuses = @($preservedDrawingStatuses)
    }
}

function Get-ConnectionCableIdsFromRows {
    param([object[]]$Rows)

    $ids = @{}
    foreach ($row in $Rows) {
        $cableId = Normalize-Text $row.Kabel
        if ($null -ne $cableId) {
            $ids[$cableId.ToUpperInvariant()] = $cableId
        }
    }

    return @($ids.Values | Sort-Object)
}

function Inspect-ConnectionBalance {
    param(
        [__ComObject]$Database,
        [string]$Path
    )

    $sourceData = Get-SourceConnectionSyncData -Path $Path
    $sourceCustomerRows = @($sourceData.TableRows.Klant)
    $sourceCableIds = @(Get-ConnectionCableIdsFromRows -Rows $sourceCustomerRows)
    $mdbCustomerRows = @(Get-TableRows -Database $Database -TableName 'Klant')
    $mdbCableIds = @(Get-ConnectionCableIdsFromRows -Rows $mdbCustomerRows)

    $sourceSet = @{}
    foreach ($id in $sourceCableIds) { $sourceSet[$id.ToUpperInvariant()] = $true }
    $mdbSet = @{}
    foreach ($id in $mdbCableIds) { $mdbSet[$id.ToUpperInvariant()] = $true }

    $missingInMdb = @($sourceCableIds | Where-Object { -not $mdbSet.ContainsKey($_.ToUpperInvariant()) })
    $extraInMdb = @($mdbCableIds | Where-Object { -not $sourceSet.ContainsKey($_.ToUpperInvariant()) })

    return [pscustomobject]@{
        fcCount      = [int]$sourceData.SourceCounts.FcRows
        bcCount      = [int]$sourceData.SourceCounts.BcRows
        sourceCount  = $sourceCableIds.Count
        mdbCount     = $mdbCableIds.Count
        missingInMdb = @($missingInMdb | Sort-Object)
        extraInMdb   = @($extraInMdb | Sort-Object)
        isBalanced   = ($missingInMdb.Count -eq 0 -and $extraInMdb.Count -eq 0)
    }
}

function Apply-ConnectionSync {
    param(
        [__ComObject]$Database,
        [string]$Path
    )

    $sourceData = Get-SourceConnectionSyncData -Path $Path
    $inspection = Inspect-ConnectionBalance -Database $Database -Path $Path
    $tableNames = @(Get-ConnectionSyncTableNames)
    $existingTables = @{}

    foreach ($tableName in $tableNames) {
        $existingTables[$tableName] = @(Get-TableRows -Database $Database -TableName $tableName)
    }

    $targetTables = @{}
    foreach ($tableName in $tableNames) {
        $sourceRows = @($sourceData.TableRows.$tableName)
        if ($tableName -eq 'Las') {
            $targetTables[$tableName] = @(Reset-ConnectionSyncIds -Rows $sourceRows)
            continue
        }

        $existingByKey = @{}
        foreach ($existingRow in $existingTables[$tableName]) {
            $key = Get-ConnectionSyncKey -TableName $tableName -Row $existingRow
            if ($null -ne $key) {
                $existingByKey[$key] = $existingRow
            }
        }

        $targetRows = @()
        foreach ($sourceRow in $sourceRows) {
            $key = Get-ConnectionSyncKey -TableName $tableName -Row $sourceRow
            if ($null -ne $key -and $existingByKey.ContainsKey($key)) {
                $targetRows += Merge-ConnectionSyncRow -TableName $tableName -SourceRow $sourceRow -ExistingRow $existingByKey[$key]
            }
            else {
                $targetRows += $sourceRow
            }
        }

        $targetTables[$tableName] = @(Reset-ConnectionSyncIds -Rows $targetRows)
    }

    Clear-AccessTables -Database $Database -TableNames @('Las', 'Klant', 'Kabel', 'Duct', 'Traject', 'SpliceBox', 'Accesspoint')
    foreach ($tableName in $tableNames) {
        Write-AccessTable -Database $Database -TableName $tableName -Rows $targetTables[$tableName]
    }

    return [pscustomobject]@{
        fcCount        = $inspection.fcCount
        bcCount        = $inspection.bcCount
        sourceCount    = $inspection.sourceCount
        mdbCountBefore = $inspection.mdbCount
        addedCount     = $inspection.missingInMdb.Count
        removedCount   = $inspection.extraInMdb.Count
        addedCableIds  = $inspection.missingInMdb
        removedCableIds = $inspection.extraInMdb
        finalCount     = $inspection.sourceCount
    }
}

function Export-CrossCheckData {
    param([__ComObject]$Database)

    return [pscustomobject]@{
        ODF         = @(Get-TableRows -Database $Database -TableName 'ODF')
        AfwerkODF   = @(Get-TableRows -Database $Database -TableName 'AfwerkODF')
        Accesspoint = @(Get-TableRows -Database $Database -TableName 'Accesspoint')
        Kabel       = @(Get-TableRows -Database $Database -TableName 'Kabel')
        Klant       = @(Get-TableRows -Database $Database -TableName 'Klant')
        Las         = @(Get-TableRows -Database $Database -TableName 'Las')
    }
}

function Uppercase-OapLabels {
    param([__ComObject]$Database)

    $projectLabel = Get-ProjectLabelFromDatabase -Database $Database
    if ($null -eq $projectLabel) { throw 'No se ha podido resolver el OAP/proyecto desde la tabla POP.' }
    $upperLabel = $projectLabel.ToUpperInvariant()
    $updatedFields = 0
    $tableDefs = $Database.TableDefs
    for ($tableIndex = 0; $tableIndex -lt $tableDefs.Count; $tableIndex++) {
        $tableDef = $tableDefs.Item($tableIndex)
        try {
            $tableName = Normalize-Text $tableDef.Name
            if ($null -eq $tableName -or $tableName.StartsWith('MSys', [System.StringComparison]::OrdinalIgnoreCase)) { continue }
            $fields = $tableDef.Fields
            for ($fieldIndex = 0; $fieldIndex -lt $fields.Count; $fieldIndex++) {
                $field = $fields.Item($fieldIndex)
                try {
                    if ($field.Type -notin @(10, 12)) { continue }
                    $fieldName = Normalize-Text $field.Name
                    $oldLiteral = Convert-ToAccessTextLiteral $projectLabel
                    $newLiteral = Convert-ToAccessTextLiteral $upperLabel
                    $sql = "UPDATE [$tableName] SET [$fieldName] = Replace([$fieldName], $oldLiteral, $newLiteral, 1, -1, 1) WHERE [$fieldName] Is Not Null"
                    $Database.Execute($sql)
                    $updatedFields++
                }
                finally { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($field) }
            }
        }
        finally { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($tableDef) }
    }
    return [pscustomobject]@{ projectLabel = $projectLabel; uppercaseProjectLabel = $upperLabel; fieldsScanned = $updatedFields }
}

function Export-PartialDeliveryData {
    param([__ComObject]$Database)

    $customerRows = @(Get-TableRows -Database $Database -TableName 'Klant')
    $cableRows = @(Get-TableRows -Database $Database -TableName 'Kabel')
    $lasRows = @(Get-TableRows -Database $Database -TableName 'Las')
    $cableLookup = @{}
    $lasLookup = @{}
    foreach ($row in $cableRows) {
        $label = Normalize-Text $row.Label
        if ($null -ne $label) {
            $cableLookup[$label.ToUpperInvariant()] = $row
        }
    }
    foreach ($row in $lasRows) {
        $lasCableB = Normalize-Text $row.KabelB
        $lasFiberB = Normalize-Text $row.VezelnrB
        if ($null -ne $lasCableB -and $null -ne $lasFiberB) {
            $lasKey = '{0}|{1}' -f $lasCableB.ToUpperInvariant(), $lasFiberB
            if (-not $lasLookup.ContainsKey($lasKey)) { $lasLookup[$lasKey] = $row }
        }
    }

    $connections = @()
    foreach ($customer in $customerRows) {
        $kabelId = Normalize-Text $customer.Kabel
        if ($null -eq $kabelId) { continue }
        $cable = $cableLookup[$kabelId.ToUpperInvariant()]
        $lasKey = '{0}|1' -f $kabelId.ToUpperInvariant()
        $parkingLasKey = '{0}|2' -f $kabelId.ToUpperInvariant()
        $las = if ($lasLookup.ContainsKey($lasKey)) { @($lasLookup[$lasKey]) } else { @() }
        $parkingLas = if ($lasLookup.ContainsKey($parkingLasKey)) { @($lasLookup[$parkingLasKey]) } else { @() }
        $connections += [pscustomobject]@{
            id          = $customer.ID
            kabelId     = $kabelId
            phkt        = if ($null -ne $cable) { Normalize-Text $cable.Locatienaam_B } else { $null }
            postcode    = Normalize-Text $customer.Postcode
            houseNumber = Normalize-Text $customer.Huisnr
            houseSuffix = Normalize-Text $customer.Toevoeging
            room        = Normalize-Text $customer.KAMER
            complex     = Normalize-Text $customer.COMPLEX
            dpLabel     = if ($null -ne $cable) { Normalize-Text $cable.Locatienaam_A } else { $null }
            kastnr      = Normalize-Text $customer.Kastnr
            ftuType     = Normalize-Text $customer.FTUType
            demping1A   = Convert-ToNullableDouble $customer.Dempingswaarde1A
            demping1Z   = Convert-ToNullableDouble $customer.Dempingswaarde1Z
            demping2A   = Convert-ToNullableDouble $customer.Dempingswaarde2A
            demping2Z   = Convert-ToNullableDouble $customer.Dempingswaarde2Z
            fiber       = if (@($las).Count -gt 0) { [int]$las[0].VezelnrA } else { $null }
            cassette    = if (@($las).Count -gt 0) { [int]$las[0].Cassette } else { $null }
            cassettePosition = if (@($las).Count -gt 0) { [int]$las[0].Positienr } else { $null }
            parkingCassette = if (@($parkingLas).Count -gt 0) { [int]$parkingLas[0].Cassette } else { $null }
            parkingPosition = if (@($parkingLas).Count -gt 0) { [int]$parkingLas[0].Positienr } else { $null }
        }
    }

    return [pscustomobject]@{
        connections = @($connections | Sort-Object postcode, houseNumber, houseSuffix, room, kabelId)
        totalConnections = $connections.Count
        totalComplexes = @($connections | ForEach-Object { $_.complex } | Where-Object { $null -ne $_ } | Sort-Object -Unique).Count
    }
}

function Test-ContiguousTableIds {
    param(
        [__ComObject]$Database,
        [string]$TableName
    )

    $rows = @(Get-TableRows -Database $Database -TableName $TableName)
    $ids = @($rows | ForEach-Object { [int]$_.ID } | Sort-Object)
    $isContiguous = $true
    for ($index = 0; $index -lt $ids.Count; $index++) {
        if ($ids[$index] -ne ($index + 1)) {
            $isContiguous = $false
            break
        }
    }

    return [pscustomobject]@{
        table = $TableName
        count = $ids.Count
        firstId = if ($ids.Count -gt 0) { $ids[0] } else { $null }
        lastId = if ($ids.Count -gt 0) { $ids[-1] } else { $null }
        contiguousFromOne = $isContiguous
    }
}

function Apply-PartialDelivery {
    param(
        [__ComObject]$Database,
        [string]$Path
    )

    $selection = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    $connectionEdits = @()
    if ($selection.PSObject.Properties.Name -contains 'connections') {
        $connectionEdits = @($selection.connections)
    }
    $requestedCableIds = if (@($connectionEdits).Count -gt 0) {
        @($connectionEdits | ForEach-Object { Normalize-Text $_.kabelId } | Where-Object { $null -ne $_ })
    }
    else {
        @($selection.cableIds | ForEach-Object { Normalize-Text $_ } | Where-Object { $null -ne $_ })
    }
    if (@($requestedCableIds).Count -eq 0) {
        throw 'No hay conexiones seleccionadas para el Partial Delivery.'
    }

    $requestedSet = @{}
    foreach ($cableId in $requestedCableIds) {
        $requestedSet[$cableId.ToUpperInvariant()] = $cableId
    }

    $allCustomers = @(Get-TableRows -Database $Database -TableName 'Klant')
    $allCables = @(Get-TableRows -Database $Database -TableName 'Kabel')
    $allLas = @(Get-TableRows -Database $Database -TableName 'Las')
    $allAccesspoints = @(Get-TableRows -Database $Database -TableName 'Accesspoint')
    $allSpliceBoxes = @(Get-TableRows -Database $Database -TableName 'SpliceBox')
    $allSettings = @(Get-TableRows -Database $Database -TableName 'Instellingen')

    $selectedCustomers = @($allCustomers | Where-Object {
        $cableId = Normalize-Text $_.Kabel
        $null -ne $cableId -and $requestedSet.ContainsKey($cableId.ToUpperInvariant())
    } | Sort-Object ID)
    $found = @{}
    foreach ($row in $selectedCustomers) { $found[(Normalize-Text $row.Kabel).ToUpperInvariant()] = $true }
    $newConnectionCount = 0
    $newTopologyWarnings = @()
    foreach ($missingKey in @($requestedSet.Keys | Where-Object { -not $found.ContainsKey($_) })) {
        $edit = @($connectionEdits | Where-Object { (Normalize-Text $_.kabelId).ToUpperInvariant() -eq $missingKey } | Select-Object -First 1)
        if (@($edit).Count -eq 0) { throw "La conexion $missingKey no existe en el MDB y no trae datos BC para crearla." }
        $edit = @($edit)[0]
        $newCableId = Normalize-Text $edit.kabelId
        $newDp = Normalize-Text $edit.dpLabel
        if ($null -eq $newDp) {
            $dpMatch = [regex]::Match($newCableId, '^(?:K-)?(.+?-DP\d+)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
            if ($dpMatch.Success) { $newDp = $dpMatch.Groups[1].Value }
        }
        if ($null -eq $newDp) { throw "La conexion nueva $newCableId no tiene DP identificable en el BC." }
        $newStatus = Normalize-UpperStatus $edit.status
        if ($null -eq $newStatus) { $newStatus = Resolve-StatusLocation -DeliveryStatus (Normalize-Text $edit.statusCode) -CurrentLocation $null -PreferredLocation $null }
        $newHouseNumber = 0
        $houseNumberText = Normalize-Text $edit.houseNumber
        if ($null -ne $houseNumberText) { [void][int]::TryParse($houseNumberText, [ref]$newHouseNumber) }
        $newAddressParts = @((Normalize-Text $edit.postcode), (Normalize-Text $edit.houseNumber), (Normalize-Text $edit.houseSuffix)) | Where-Object { $null -ne $_ }
        $newAddress = ($newAddressParts -join '-').ToUpperInvariant()
        $newCustomer = [pscustomobject]@{
            ID = 0; Postcode = Normalize-Text $edit.postcode; Huisnr = $newHouseNumber; Toevoeging = Normalize-Text $edit.houseSuffix;
            Kastnr = $newStatus; FTUType = if ($newStatus -eq 'GV') { $null } else { Normalize-Text $edit.ftuType }; Kabel = $newCableId; VEZELNR1 = 1;
            Dempingswaarde1A = Convert-ToNullableDouble $edit.demping1A; Specificatie1A = $null; Dempingswaarde1Z = Convert-ToNullableDouble $edit.demping1Z;
            Specificatie1Z = $null; Vezelnr2 = $null; Dempingswaarde2A = Convert-ToNullableDouble $edit.demping2A; Specificatie2A = $null;
            Dempingswaarde2Z = Convert-ToNullableDouble $edit.demping2Z; Specificatie2Z = $null; X = 0; Y = 0; ImportResult = $null;
            COMPLEX = Normalize-Text $edit.complex; KAMER = Normalize-Text $edit.room; ALIASNAAM = $null; FTU_SERIENUMMER = $null
        }
        $newCable = [pscustomobject]@{
            ID = 0; Label = $newCableId; Kabeltype = '2V_DBC_PR01'; Locatienaam_A = $newDp; Afwerkeenheid_A = $newDp;
            PoortA = $null; Locatienaam_B = $newAddress; Afwerkeenheid_B = if ((Normalize-Text $edit.statusCode) -eq '2') { $newStatus } else { $null };
            PoortB = $null; Serienummer = $null; ImportResult = $null; CATEGORIE = $null
        }
        $selectedCustomers += $newCustomer
        $allCables += $newCable
        $newConnectionCount++
        $requestedFiber = 0
        $fiberText = if ($edit.PSObject.Properties.Name -contains 'fiber') { Normalize-Text $edit.fiber } else { $null }
        if ($null -ne $fiberText) { [void][int]::TryParse($fiberText, [ref]$requestedFiber) }
        $templateCable = @($allCables | Where-Object { $location = Normalize-Text $_.Locatienaam_A; $label = Normalize-Text $_.Label; $null -ne $location -and $null -ne $label -and $location.ToUpperInvariant() -eq $newDp.ToUpperInvariant() -and $label.ToUpperInvariant() -ne $newCableId.ToUpperInvariant() } | Select-Object -First 1)
        $templateLas = if (@($templateCable).Count -gt 0) { @($allLas | Where-Object { $cableB = Normalize-Text $_.KabelB; $null -ne $cableB -and $cableB.ToUpperInvariant() -eq (Normalize-Text @($templateCable)[0].Label).ToUpperInvariant() } | Sort-Object VezelnrB) } else { @() }
        # Prefer the accepted LAS topology for this exact BC fibre.  This keeps
        # cassette/position/cable-A consistent with the full project instead of
        # blindly cloning an unrelated customer in the same DP.
        $exactLas = if ($requestedFiber -gt 0) {
            @($allLas | Where-Object {
                $location = Normalize-Text $_.LOCATIE
                $cableA = Normalize-Text $_.KabelA
                $fiberA = 0; [void][int]::TryParse((Normalize-Text $_.VezelnrA), [ref]$fiberA)
                $null -ne $location -and $location.ToUpperInvariant() -eq $newDp.ToUpperInvariant() -and $null -ne $cableA -and $fiberA -eq $requestedFiber
            } | Select-Object -First 1)
        } else { @() }
        $spliceTemplate = if (@($exactLas).Count -gt 0) { $exactLas[0] } elseif (@($templateLas).Count -gt 0) { $templateLas | Where-Object { (Normalize-Text $_.VezelnrB) -eq '1' } | Select-Object -First 1 } else { $null }
        if ($null -ne $spliceTemplate) {
            $clone = [ordered]@{}
            foreach ($property in $spliceTemplate.PSObject.Properties) { $clone[$property.Name] = $property.Value }
            $clone.KabelB = $newCableId; $clone.VezelnrB = 1
            if ($requestedFiber -gt 0) { $clone.VezelnrA = $requestedFiber }
            $requestedCassette = 0; $requestedPosition = 0
            if ($edit.PSObject.Properties.Name -contains 'cassette') { [void][int]::TryParse((Normalize-Text $edit.cassette), [ref]$requestedCassette) }
            if ($edit.PSObject.Properties.Name -contains 'cassettePosition') { [void][int]::TryParse((Normalize-Text $edit.cassettePosition), [ref]$requestedPosition) }
            if ($requestedCassette -gt 0) { $clone.Cassette = $requestedCassette }
            if ($requestedPosition -gt 0) { $clone.Positienr = $requestedPosition }
            $allLas += [pscustomobject]$clone
            $parkingTemplate = @($templateLas | Where-Object { (Normalize-Text $_.VezelnrB) -eq '2' } | Select-Object -First 1)
            if (@($parkingTemplate).Count -gt 0) {
                $parkingClone = [ordered]@{}
                foreach ($property in $parkingTemplate[0].PSObject.Properties) { $parkingClone[$property.Name] = $property.Value }
                $parkingClone.KabelB = $newCableId; $parkingClone.VezelnrB = 2
                $parkingCassette = 0; $parkingPosition = 0
                if ($edit.PSObject.Properties.Name -contains 'parkingCassette') { [void][int]::TryParse((Normalize-Text $edit.parkingCassette), [ref]$parkingCassette) }
                if ($edit.PSObject.Properties.Name -contains 'parkingPosition') { [void][int]::TryParse((Normalize-Text $edit.parkingPosition), [ref]$parkingPosition) }
                if ($parkingCassette -gt 0) { $parkingClone.Cassette = $parkingCassette }
                if ($parkingPosition -gt 0) { $parkingClone.Positienr = $parkingPosition }
                $allLas += [pscustomobject]$parkingClone
            }
        }
        else {
            $newTopologyWarnings += $newCableId
        }
    }

    $editLookup = @{}
    foreach ($edit in $connectionEdits) {
        $editCableId = Normalize-Text $edit.kabelId
        if ($null -ne $editCableId) { $editLookup[$editCableId.ToUpperInvariant()] = $edit }
    }
    foreach ($customer in $selectedCustomers) {
        $customerCableId = Normalize-Text $customer.Kabel
        if ($null -eq $customerCableId -or -not $editLookup.ContainsKey($customerCableId.ToUpperInvariant())) { continue }
        $edit = $editLookup[$customerCableId.ToUpperInvariant()]
        if ($edit.PSObject.Properties.Name -contains 'status') { $customer.Kastnr = Normalize-UpperStatus $edit.status; if ($customer.Kastnr -eq 'GV') { $customer.FTUType = $null } }
        if ($edit.PSObject.Properties.Name -contains 'ftuType') { $customer.FTUType = Normalize-Text $edit.ftuType }
        foreach ($mapping in @(
            @{ Json = 'demping1A'; Field = 'Dempingswaarde1A' },
            @{ Json = 'demping1Z'; Field = 'Dempingswaarde1Z' },
            @{ Json = 'demping2A'; Field = 'Dempingswaarde2A' },
            @{ Json = 'demping2Z'; Field = 'Dempingswaarde2Z' }
        )) {
            if ($edit.PSObject.Properties.Name -contains $mapping.Json) {
                $customer.($mapping.Field) = Convert-ToNullableDouble $edit.($mapping.Json)
            }
        }
    }

    # Reconcile LAS rows for every selected BC record.  The accepted project is
    # the source of topology, while BC is authoritative for the customer fibre.
    foreach ($edit in $connectionEdits) {
        $editCableId = Normalize-Text $edit.kabelId
        $fiberText = if ($edit.PSObject.Properties.Name -contains 'fiber') { Normalize-Text $edit.fiber } else { $null }
        $fiber = 0
        if ($null -eq $editCableId -or $null -eq $fiberText -or -not [int]::TryParse($fiberText, [ref]$fiber) -or $fiber -le 0) { continue }
        $lasRows = @($allLas | Where-Object { $cableB = Normalize-Text $_.KabelB; $null -ne $cableB -and $cableB.ToUpperInvariant() -eq $editCableId.ToUpperInvariant() -and (Normalize-Text $_.VezelnrB) -eq '1' })
        foreach ($las in $lasRows) {
            $las.VezelnrA = $fiber
            $dp = Normalize-Text $las.LOCATIE
            $source = @($allLas | Where-Object {
                $sourceDp = Normalize-Text $_.LOCATIE; $sourceCableA = Normalize-Text $_.KabelA; $sourceFiber = 0
                [void][int]::TryParse((Normalize-Text $_.VezelnrA), [ref]$sourceFiber)
                $sourceDp -and $sourceCableA -and $sourceDp.ToUpperInvariant() -eq $dp.ToUpperInvariant() -and $sourceFiber -eq $fiber
            } | Select-Object -First 1)
            if (@($source).Count -gt 0) {
                $las.KabelA = $source[0].KabelA
                $las.Cassette = $source[0].Cassette
                $las.Positienr = $source[0].Positienr
                $las.CassetteType = $source[0].CassetteType
                $las.zijde_fasplaat = $source[0].zijde_fasplaat
                $las.Gelast = 'j'
            }
            $cassette = 0; $position = 0
            if ($edit.PSObject.Properties.Name -contains 'cassette') { [void][int]::TryParse((Normalize-Text $edit.cassette), [ref]$cassette) }
            if ($edit.PSObject.Properties.Name -contains 'cassettePosition') { [void][int]::TryParse((Normalize-Text $edit.cassettePosition), [ref]$position) }
            if ($cassette -gt 0) { $las.Cassette = $cassette }
            if ($position -gt 0) { $las.Positienr = $position }
        }
        $parkingRows = @($allLas | Where-Object { $cableB = Normalize-Text $_.KabelB; $null -ne $cableB -and $cableB.ToUpperInvariant() -eq $editCableId.ToUpperInvariant() -and (Normalize-Text $_.VezelnrB) -eq '2' })
        $parkingCassette = 0; $parkingPosition = 0
        if ($edit.PSObject.Properties.Name -contains 'parkingCassette') { [void][int]::TryParse((Normalize-Text $edit.parkingCassette), [ref]$parkingCassette) }
        if ($edit.PSObject.Properties.Name -contains 'parkingPosition') { [void][int]::TryParse((Normalize-Text $edit.parkingPosition), [ref]$parkingPosition) }
        foreach ($parking in $parkingRows) {
            if ($parkingCassette -gt 0) { $parking.Cassette = $parkingCassette }
            if ($parkingPosition -gt 0) { $parking.Positienr = $parkingPosition }
        }
    }

    $selectedCustomerCableSet = @{}
    foreach ($row in $selectedCustomers) {
        $selectedCustomerCableSet[(Normalize-Text $row.Kabel).ToUpperInvariant()] = $true
    }

    $customerCables = @($allCables | Where-Object {
        $label = Normalize-Text $_.Label
        $null -ne $label -and $selectedCustomerCableSet.ContainsKey($label.ToUpperInvariant())
    })
    $dpSet = @{}
    foreach ($row in $customerCables) {
        $dp = Normalize-Text $row.Locatienaam_A
        if ($null -ne $dp) { $dpSet[$dp.ToUpperInvariant()] = $dp }
    }

    $feederCables = @($allCables | Where-Object {
        $label = Normalize-Text $_.Label
        if ($null -ne $label -and $selectedCustomerCableSet.ContainsKey($label.ToUpperInvariant())) { return $false }
        $locationB = Normalize-Text $_.Locatienaam_B
        $terminationB = Normalize-Text $_.Afwerkeenheid_B
        ($null -ne $locationB -and $dpSet.ContainsKey($locationB.ToUpperInvariant())) -or
        ($null -ne $terminationB -and $dpSet.ContainsKey($terminationB.ToUpperInvariant()))
    } | Sort-Object ID)
    $targetCables = @($feederCables + @($customerCables | Sort-Object ID))

    $targetAccesspoints = @($allAccesspoints | Where-Object {
        $label = Normalize-Text $_.Label
        $null -ne $label -and $dpSet.ContainsKey($label.ToUpperInvariant())
    } | Sort-Object ID)
    $targetSpliceBoxes = @($allSpliceBoxes | Where-Object {
        $label = Normalize-Text $_.Label
        $null -ne $label -and $dpSet.ContainsKey($label.ToUpperInvariant())
    } | Sort-Object ID)
    $targetLas = @($allLas | Where-Object {
        $cableA = Normalize-Text $_.KabelA
        $cableB = Normalize-Text $_.KabelB
        ($null -ne $cableA -and $selectedCustomerCableSet.ContainsKey($cableA.ToUpperInvariant())) -or
        ($null -ne $cableB -and $selectedCustomerCableSet.ContainsKey($cableB.ToUpperInvariant()))
    } | Sort-Object ID)

    $emailSetting = @($allSettings | Where-Object { (Normalize-Text $_.NAAM) -eq 'email' } | Select-Object -First 1)
    $targetSettings = @()
    if (@($emailSetting).Count -gt 0) {
        $targetSettings += [pscustomobject]@{ NAAM = 'email'; WAARDE = Normalize-Text $emailSetting[0].WAARDE }
    }
    $targetSettings += [pscustomobject]@{ NAAM = 'Dataset'; WAARDE = 'PARTIAL' }

    $clearOrder = @(
        'Ductlas', 'Patch', 'Las', 'Klant', 'Kabel', 'Duct', 'Traject', 'SpliceBox', 'Accesspoint',
        'AfwerkODF', 'ODF', 'CBN', 'Mantelbuis', 'POP', 'Vergunning', 'Type', 'Instellingen'
    )
    Clear-AccessTables -Database $Database -TableNames $clearOrder

    Write-AccessTable -Database $Database -TableName 'Instellingen' -Rows $targetSettings
    Write-AccessTable -Database $Database -TableName 'Accesspoint' -Rows $targetAccesspoints
    Write-AccessTable -Database $Database -TableName 'SpliceBox' -Rows $targetSpliceBoxes
    Write-AccessTable -Database $Database -TableName 'Kabel' -Rows $targetCables
    Write-AccessTable -Database $Database -TableName 'Klant' -Rows $selectedCustomers
    Write-AccessTable -Database $Database -TableName 'Las' -Rows $targetLas

    $idChecks = @('Instellingen', 'Accesspoint', 'SpliceBox', 'Kabel', 'Klant', 'Las') |
        ForEach-Object { Test-ContiguousTableIds -Database $Database -TableName $_ }
    $failedIdChecks = @($idChecks | Where-Object { -not $_.contiguousFromOne })
    if (@($failedIdChecks).Count -gt 0) {
        throw "Las IDs no son consecutivas desde 1 en: $(@($failedIdChecks.table) -join ', ')."
    }

    return [pscustomobject]@{
        customers = @($selectedCustomers).Count
        customerCables = @($customerCables).Count
        feederCables = @($feederCables).Count
        cables = @($targetCables).Count
        las = @($targetLas).Count
        accesspoints = @($targetAccesspoints).Count
        spliceBoxes = @($targetSpliceBoxes).Count
        dpLabels = @($dpSet.Values | Sort-Object)
        complexes = @($selectedCustomers | ForEach-Object { Normalize-Text $_.COMPLEX } | Where-Object { $null -ne $_ } | Sort-Object -Unique)
        newConnections = $newConnectionCount
        newTopologyWarnings = @($newTopologyWarnings)
        idChecks = $idChecks
    }
}

$context = Open-Database -Path $MdbPath
$compactAfterClose = (
    $context.Mode -eq 'Dao' -and
    $Mode -in @(
        'ImportCustomerCoordinates', 'ImportDpCoordinates', 'MoveResvCoordinatesToDp',
        'SetOapCoordinate', 'UppercaseOap', 'FixCustomerDempingValues', 'ApplyDempingContingency',
        'RebuildCustomerComplexes', 'ApplyFcUpdates', 'ApplyFcRefresh',
        'ApplyGlaspoortProject', 'ApplyConnectionSync', 'ApplyRiserData',
        'AddRiserData', 'DeleteRiserData', 'ApplyBuiseind', 'ApplyPartialDelivery'
    )
)

try {
    switch ($Mode) {
        'ExportCustomerDrawData' {
            Export-CustomerDrawData -Database $context.Database | ConvertTo-Json -Depth 6
            break
        }

        'ImportCustomerCoordinates' {
            Import-CustomerCoordinates -Database $context.Database -Path $CoordinatesPath | ConvertTo-Json -Depth 4
            break
        }

        'ExportDpCoordinateTargets' {
            Export-DpCoordinateTargets -Database $context.Database | ConvertTo-Json -Depth 5
            break
        }

        'ImportDpCoordinates' {
            Import-DpCoordinates -Database $context.Database -Path $CoordinatesPath | ConvertTo-Json -Depth 5
            break
        }

        'MoveResvCoordinatesToDp' {
            Move-ResvCoordinatesToDp -Database $context.Database | ConvertTo-Json -Depth 5
            break
        }

        'SetOapCoordinate' {
            Set-OapCoordinate -Database $context.Database -XValue $X -YValue $Y -NearestDpLabel $NearestDpLabel | ConvertTo-Json -Depth 4
            break
        }

        'UppercaseOap' {
            Uppercase-OapLabels -Database $context.Database | ConvertTo-Json -Depth 4
            break
        }

        'ExportCrossCheckData' {
            Export-CrossCheckData -Database $context.Database | ConvertTo-Json -Depth 8
            break
        }

        'ExportPartialDeliveryData' {
            Export-PartialDeliveryData -Database $context.Database | ConvertTo-Json -Depth 6
            break
        }

        'ApplyPartialDelivery' {
            Apply-PartialDelivery -Database $context.Database -Path $AssignmentsPath | ConvertTo-Json -Depth 6
            break
        }

        'FixCustomerDempingValues' {
            Fix-CustomerDempingValues -Database $context.Database | ConvertTo-Json -Depth 4
            break
        }

        'ApplyDempingContingency' {
            Apply-DempingContingency -Database $context.Database -Path $AssignmentsPath | ConvertTo-Json -Depth 4
            break
        }

        'RebuildCustomerComplexes' {
            Rebuild-CustomerComplexes -Database $context.Database -Path $AssignmentsPath | ConvertTo-Json -Depth 4
            break
        }

        'ApplyFcUpdates' {
            Apply-FcUpdates -Database $context.Database -Path $AssignmentsPath | ConvertTo-Json -Depth 4
            break
        }

        'ApplyFcRefresh' {
            Apply-FcRefresh -Database $context.Database -Path $AssignmentsPath | ConvertTo-Json -Depth 4
            break
        }

        'ApplyGlaspoortProject' {
            Apply-GlaspoortProject -Database $context.Database | ConvertTo-Json -Depth 4
            break
        }

        'InspectConnectionBalance' {
            Inspect-ConnectionBalance -Database $context.Database -Path $AssignmentsPath | ConvertTo-Json -Depth 6
            break
        }

        'ApplyConnectionSync' {
            Apply-ConnectionSync -Database $context.Database -Path $AssignmentsPath | ConvertTo-Json -Depth 6
            break
        }

        'ExportRiserState' {
            Export-RiserState -Database $context.Database | ConvertTo-Json -Depth 6
            break
        }

        'ApplyRiserData' {
            Apply-RiserData -Database $context.Database -Path $AssignmentsPath | ConvertTo-Json -Depth 6
            break
        }

        'AddRiserData' {
            Add-RiserData -Database $context.Database -Path $AssignmentsPath | ConvertTo-Json -Depth 6
            break
        }

        'DeleteRiserData' {
            Delete-RiserData -Database $context.Database -Path $AssignmentsPath | ConvertTo-Json -Depth 6
            break
        }

        'ApplyBuiseind' {
            Apply-Buiseind -Database $context.Database -Path $AssignmentsPath | ConvertTo-Json -Depth 6
            break
        }
    }
}
finally {
    Close-DatabaseContext -Context $context
}

if ($compactAfterClose) {
    Compress-AccessDatabase -Path $MdbPath
}
