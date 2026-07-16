param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('ExportCustomerDrawData', 'ImportCustomerCoordinates', 'SetOapCoordinate', 'ExportCrossCheckData', 'FixCustomerDempingValues', 'RebuildCustomerComplexes', 'ApplyFcUpdates', 'ApplyFcRefresh', 'ApplyGlaspoortProject', 'InspectConnectionBalance', 'ApplyConnectionSync', 'ApplyRiserData')]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$MdbPath,

    [string]$CoordinatesPath,
    [string]$AssignmentsPath,
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
    $items = @((ConvertFrom-Json -InputObject ($raw -replace '^\uFEFF', '')))
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

function Set-OapCoordinate {
    param(
        [__ComObject]$Database,
        [double]$XValue,
        [double]$YValue
    )

    $updatedPop = 0
    $updatedVergunning = 0

    foreach ($tableName in @('POP', 'Vergunning')) {
        $recordset = $Database.OpenRecordset("SELECT * FROM [$tableName]")

        try {
            while (-not $recordset.EOF) {
                $recordset.Edit()
                $recordset.Fields('X').Value = $XValue
                $recordset.Fields('Y').Value = $YValue
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

function Rebuild-CustomerComplexes {
    param(
        [__ComObject]$Database,
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "No se ha encontrado el fichero de asignaciones de COMPLEX: $Path"
    }

    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $items = @((ConvertFrom-Json -InputObject ($raw -replace '^\uFEFF', '')))
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

    try {
        while (-not $recordset.EOF) {
            $cableId = Normalize-Text $recordset.Fields('Kabel').Value
            $currentComplex = Normalize-Text $recordset.Fields('COMPLEX').Value
            $nextComplex = if ($null -ne $cableId -and $complexLookup.ContainsKey($cableId)) { $complexLookup[$cableId] } else { $null }

            $currentComparable = if ($null -eq $currentComplex) { '' } else { $currentComplex }
            $nextComparable = if ($null -eq $nextComplex) { '' } else { $nextComplex }

            if ($currentComparable -ne $nextComparable) {
                $recordset.Edit()
                if ($null -eq $nextComplex) {
                    $recordset.Fields('COMPLEX').Value = [System.DBNull]::Value
                    $cleared++
                }
                else {
                    $recordset.Fields('COMPLEX').Value = $nextComplex
                    $assigned++
                }

                $recordset.Update()
                $updated++
            }

            $recordset.MoveNext()
        }
    }
    finally {
        $recordset.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($recordset)
    }

    return [pscustomobject]@{
        updated   = $updated
        assigned  = $assigned
        cleared   = $cleared
        available = $complexLookup.Count
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
        $assignment = [pscustomobject]@{
            CableId        = $cableId
            Postcode       = Normalize-Text $item.Postcode
            HouseNumber    = Normalize-Text $item.HouseNumber
            HouseSuffix    = Normalize-Text $item.HouseSuffix
            Room           = Normalize-Text $item.Room
            AddressMatchKey = Normalize-Text $item.AddressMatchKey
            DeliveryStatus = $deliveryStatus
            FtuLocation    = Normalize-UpperStatus $item.FtuLocation
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
                $preferredFtuLocation = Normalize-UpperStatus $fcItem.FtuLocation
                $targetFtuLocation = if ($null -ne $preferredFtuLocation) {
                    $preferredFtuLocation
                }
                else {
                    Resolve-StatusLocation -DeliveryStatus $fcItem.DeliveryStatus -CurrentLocation $customerRecordset.Fields('Kastnr').Value -PreferredLocation $fcItem.FtuLocation
                }
                $targetFtuType = if ($fcItem.StatusIs2) { 'FTU_TK01' } else { $null }

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
                $preferredStatusLocation = Normalize-UpperStatus $fcItem.FtuLocation
                $targetStatusLocation = if ($null -ne $preferredStatusLocation) {
                    $preferredStatusLocation
                }
                else {
                    Resolve-StatusLocation -DeliveryStatus $fcItem.DeliveryStatus -CurrentLocation $cableRecordset.Fields('Afwerkeenheid_B').Value -PreferredLocation $fcItem.FtuLocation
                }
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
                if ($currentCableTypeComparable -ne $targetCableTypeComparable) {
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
    $sourceDuctRows = @($sourceData.TableRows.Duct)
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
    $customerFieldChanges = @{}
    $cableFieldChanges = @{}

    foreach ($sourceRow in $sourceCustomerRows) {
        $key = Get-ConnectionSyncKey -TableName 'Klant' -Row $sourceRow
        $existingRow = if ($null -ne $key -and $existingCustomersByKey.ContainsKey($key)) { $existingCustomersByKey[$key] } else { $null }
        $mergedRow = Merge-FcRefreshRow -TableName 'Klant' -SourceRow $sourceRow -ExistingRow $existingRow
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

$context = Open-Database -Path $MdbPath

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

        'SetOapCoordinate' {
            Set-OapCoordinate -Database $context.Database -XValue $X -YValue $Y | ConvertTo-Json -Depth 4
            break
        }

        'ExportCrossCheckData' {
            Export-CrossCheckData -Database $context.Database | ConvertTo-Json -Depth 8
            break
        }

        'FixCustomerDempingValues' {
            Fix-CustomerDempingValues -Database $context.Database | ConvertTo-Json -Depth 4
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

        'ApplyRiserData' {
            Apply-RiserData -Database $context.Database -Path $AssignmentsPath | ConvertTo-Json -Depth 6
            break
        }
    }
}
finally {
    Close-DatabaseContext -Context $context
}
