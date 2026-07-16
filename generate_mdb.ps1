param(
    [string]$TemplatePath = '.\template.mdb',
    [string]$FcPath = '.\FC RT-CMA-B11878.xlsx',
    [string]$BcPath = '.\BC RT-CMA-B11878.csv',
    [string]$OutputPath = '.\generated.mdb',
    [string]$ProjectFolderPath = $null,
    [string]$MetadataPath = $null,
    [switch]$AnalyzeOnly,
    [string]$AnalysisOutputPath = $null,
    [switch]$ExportComplexAssignmentsOnly,
    [string]$ComplexAssignmentsOutputPath = $null,
    [switch]$ExportFcUpdatesOnly,
    [string]$FcUpdatesOutputPath = $null,
    [switch]$ExportFcRefreshDataOnly,
    [string]$FcRefreshDataOutputPath = $null,
    [switch]$ExportConnectionSyncDataOnly,
    [string]$ConnectionSyncDataOutputPath = $null,
    [switch]$ExportRiserDataOnly,
    [string]$RiserDataOutputPath = $null
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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

function Normalize-Key {
    param([object]$Value)

    $text = Normalize-Text $Value
    if ($null -eq $text) {
        return $null
    }

    return $text.ToUpperInvariant()
}

function Normalize-Measurement {
    param([object]$Value)

    $text = Normalize-Text $Value
    if ($null -eq $text) {
        return $null
    }

    return $text.Replace('.', ',')
}

function Parse-DateValue {
    param([object]$Value)

    $text = Normalize-Text $Value
    if ($null -eq $text) {
        return $null
    }

    $culture = [System.Globalization.CultureInfo]::InvariantCulture
    $formats = @(
        'yyyyMMdd',
        'yyyy-MM-dd HH:mm:ss',
        'dd-MM-yyyy HH:mm',
        'dd/MM/yyyy',
        'yyyy-MM-dd'
    )

    foreach ($format in $formats) {
        try {
            return [datetime]::ParseExact($text, $format, $culture)
        }
        catch {
        }
    }

    try {
        return [datetime]$text
    }
    catch {
        return $null
    }
}

function Normalize-ComparableText {
    param([object]$Value)

    $text = Normalize-Text $Value
    if ($null -eq $text) {
        return $null
    }

    return (($text -replace '\s+', ' ').Trim().ToUpperInvariant())
}

function Normalize-StreetKey {
    param([object]$Value)

    $text = Normalize-Text $Value
    if ($null -eq $text) {
        return $null
    }

    $decomposed = $text.Normalize([System.Text.NormalizationForm]::FormD)
    $builder = [System.Text.StringBuilder]::new()

    foreach ($character in $decomposed.ToCharArray()) {
        if ([Globalization.CharUnicodeInfo]::GetUnicodeCategory($character) -ne [Globalization.UnicodeCategory]::NonSpacingMark) {
            [void]$builder.Append($character)
        }
    }

    $normalized = (($builder.ToString().Normalize([System.Text.NormalizationForm]::FormC) -replace '\s+', ' ').Trim().ToUpperInvariant())
    $normalized = $normalized -replace '\?\?', 'U'
    $normalized = $normalized -replace '\?', ''
    $normalized = $normalized -replace 'CK', 'K'
    $normalized = $normalized -replace 'SSTRAAT\b', 'STRAAT'

    return $normalized
}

function Try-ParseHouseNumber {
    param([object]$Value)

    $text = Normalize-Text $Value
    if ($null -eq $text) {
        return $null
    }

    if ($text -match '^(?<number>\d+)') {
        return [int]$Matches.number
    }

    return $null
}

function Normalize-HouseSuffix {
    param([object]$Value)

    $text = Normalize-Text $Value
    if ($null -eq $text) {
        return $null
    }

    $normalized = ($text -replace "[\s'’]+", '').ToUpperInvariant()
    $normalized = $normalized.Trim('-')

    if ($normalized -eq '') {
        return $null
    }

    if ($normalized -match '^([A-Z])S$') {
        return $Matches[1]
    }

    return $normalized
}

function Get-HouseSuffixRank {
    param([string]$Suffix)

    $normalizedSuffix = Normalize-HouseSuffix $Suffix
    if ($null -eq $normalizedSuffix) {
        return 0
    }

    if ($normalizedSuffix -eq 'H') {
        return 1
    }

    if ($normalizedSuffix -match '^\d+$') {
        return 10 + [int]$normalizedSuffix
    }

    if ($normalizedSuffix -match '^[A-Z]$') {
        return 20 + ([int][char]$normalizedSuffix)
    }

    return 100
}

function Parse-HouseReference {
    param([string]$Reference)

    $text = Normalize-Text $Reference
    if ($null -eq $text) {
        return $null
    }

    if ($text -notmatch '^(?<number>\d+)(?<suffix>.*)$') {
        return $null
    }

    $numberValue = [int]$Matches.number
    $suffixText = $Matches.suffix
    if ($suffixText -match '^\s*-\s*(?<value>.+)$') {
        $suffixText = $Matches.value
    }

    return [pscustomobject]@{
        Number = $numberValue
        Suffix = Normalize-HouseSuffix $suffixText
    }
}

function Compare-HouseReference {
    param(
        [int]$NumberA,
        [string]$SuffixA,
        [int]$NumberB,
        [string]$SuffixB
    )

    if ($NumberA -ne $NumberB) {
        return [Math]::Sign($NumberA - $NumberB)
    }

    return [Math]::Sign((Get-HouseSuffixRank $SuffixA) - (Get-HouseSuffixRank $SuffixB))
}

function Get-ExcelConnection {
    param([string]$Path)

    $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
    $connectionString = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$resolvedPath;Extended Properties='Excel 12.0 Xml;HDR=YES;IMEX=1';"
    return [System.Data.OleDb.OleDbConnection]::new($connectionString)
}

function Get-ExcelSheetNames {
    param([string]$Path)

    $connection = Get-ExcelConnection $Path
    $connection.Open()

    try {
        $schema = $connection.GetOleDbSchemaTable([System.Data.OleDb.OleDbSchemaGuid]::Tables, $null)
        return @(
            $schema |
                Where-Object {
                    $_.TABLE_NAME -notlike '*FilterDatabase*' -and
                    ([string]$_.TABLE_NAME).Contains('$')
                } |
                ForEach-Object { [string]$_.TABLE_NAME }
        )
    }
    finally {
        $connection.Close()
    }
}

function Import-ExcelSheet {
    param(
        [string]$Path,
        [string]$SheetName
    )

    $connection = Get-ExcelConnection $Path
    $connection.Open()

    try {
        $cleanSheetName = $SheetName.Trim()
        if ($cleanSheetName.StartsWith("'") -and $cleanSheetName.EndsWith("'")) {
            $cleanSheetName = $cleanSheetName.Substring(1, $cleanSheetName.Length - 2)
        }

        $command = $connection.CreateCommand()
        $command.CommandText = "SELECT * FROM [$cleanSheetName]"
        $adapter = [System.Data.OleDb.OleDbDataAdapter]::new($command)
        $table = [System.Data.DataTable]::new()
        [void]$adapter.Fill($table)
        return ,$table
    }
    finally {
        $connection.Close()
    }
}

function Import-FcRows {
    param([string]$Path)

    $sheetName = (Get-ExcelSheetNames $Path | Select-Object -First 1)
    if ($null -eq $sheetName) {
        throw "No se ha encontrado ninguna hoja legible en $Path"
    }

    $table = Import-ExcelSheet -Path $Path -SheetName $sheetName
    $rows = @()

    foreach ($row in $table.Rows) {
        $cableId = Normalize-Text (Get-RowValue -Row $row -Name 'Kabel ID')
        if ($null -eq $cableId) {
            continue
        }

        $rows += [pscustomobject]@{
            CableId         = $cableId
            ProjectNumber   = Normalize-Text (Get-RowValue -Row $row -Name 'Projectnummer')
            Postcode        = Normalize-Text (Get-RowValue -Row $row -Name 'Postcode')
            HouseNumber     = Normalize-Text (Get-RowValue -Row $row -Name 'Huisnummer')
            HouseSuffix     = Normalize-Text (Get-RowValue -Row $row -Name 'Huisnummer Toevoeging')
            Room            = Normalize-Text (Get-RowValue -Row $row -Name 'Kamer')
            Street          = Normalize-Text (Get-RowValue -Row $row -Name 'Straat')
            City            = Normalize-Text (Get-RowValue -Row $row -Name 'Plaats')
            FtuLocation     = Normalize-UpperStatus (Get-RowValue -Row $row -Name 'FTU locatie')
            Powermeter      = Normalize-Measurement (Get-RowValue -Row $row -Name 'Powermeter')
            IpFiberValue    = Normalize-Measurement (Get-RowValue -Row $row -Name 'IP vezelwaarde')
            DeliveryStatus  = Normalize-Text (Get-RowValue -Row $row -Name 'Opleverstatus KPN')
            DeliveryDate    = Parse-DateValue (Get-RowValue -Row $row -Name 'Opleverdatum')
            ProjectLabel    = Normalize-Text (Get-RowValue -Row $row -Name 'AP')
            WorkArea        = Normalize-Text (Get-RowValue -Row $row -Name 'Werkgebied')
            Cabinet         = Normalize-Text (Get-RowValue -Row $row -Name 'Kast')
            CabinetRow      = Normalize-Text (Get-RowValue -Row $row -Name 'Kastrij')
            Odf             = Normalize-Text (Get-RowValue -Row $row -Name 'ODF')
            Fiber           = [int](Normalize-Text (Get-RowValue -Row $row -Name 'ODF Positie'))
            DpLabel         = Normalize-Text (Get-RowValue -Row $row -Name 'DP')
            BuildingType    = Normalize-Text (Get-RowValue -Row $row -Name 'Gebouwtype')
        }
    }

    return $rows
}

function Import-BcRows {
    param([string]$Path)

    $rows = @()

    foreach ($row in (Import-Csv -LiteralPath $Path -Delimiter ';')) {
        $cableId = Normalize-Text (Get-FirstRowValue -Row $row -Names @('KabelID', 'Kabel ID'))
        if ($null -eq $cableId) {
            continue
        }

        $fiberText = Normalize-Text (Get-FirstRowValue -Row $row -Names @('ODFpositie', 'ODF Positie'))
        $fiberValue = if ($null -ne $fiberText) { [int]$fiberText } else { 0 }

        $rows += [pscustomobject]@{
            CableId                 = $cableId
            Postcode                = Normalize-Text (Get-FirstRowValue -Row $row -Names @('Postcode'))
            HouseNumber             = Normalize-Text (Get-FirstRowValue -Row $row -Names @('Huisnummer'))
            HouseSuffix             = Normalize-Text (Get-FirstRowValue -Row $row -Names @('HuisnummerToevoeging', 'Huisnummer Toevoeging'))
            Room                    = Normalize-Text (Get-FirstRowValue -Row $row -Names @('Kamer'))
            PlannedDate             = Parse-DateValue (Get-FirstRowValue -Row $row -Names @('Plandatum'))
            DeliveryDate            = Parse-DateValue (Get-FirstRowValue -Row $row -Names @('Opleverdatum'))
            DeliveryStatus          = Normalize-Text (Get-FirstRowValue -Row $row -Names @('Opleverstatus', 'Opleverstatus KPN'))
            AreaPop                 = Normalize-Text (Get-FirstRowValue -Row $row -Names @('Areapop'))
            CabinetRow              = Normalize-Text (Get-FirstRowValue -Row $row -Names @('Rij', 'Kastrij'))
            Cabinet                 = Normalize-Text (Get-FirstRowValue -Row $row -Names @('Kast'))
            CabinetBlock            = Normalize-Text (Get-FirstRowValue -Row $row -Names @('Blok'))
            Odf                     = Normalize-Text (Get-FirstRowValue -Row $row -Names @('ODF'))
            Fiber                   = $fiberValue
            ProjectNumber           = Normalize-Text (Get-FirstRowValue -Row $row -Names @('Projectcode', 'Project number'))
            HasDate                 = Parse-DateValue (Get-FirstRowValue -Row $row -Names @('Hasdatum'))
            Consent                 = Normalize-Text (Get-FirstRowValue -Row $row -Names @('Toestemming'))
            BuildingType            = Normalize-Text (Get-FirstRowValue -Row $row -Names @('Gebouwtype', 'Gebouwtype hoog laag etc'))
            FtuType                 = Normalize-Text (Get-FirstRowValue -Row $row -Names @('FTU-Type'))
            Notes                   = Normalize-Text (Get-FirstRowValue -Row $row -Names @('Toelichting'))
            CivilDate               = Parse-DateValue (Get-FirstRowValue -Row $row -Names @('Civieldatum'))
            Parcel                  = Normalize-Text (Get-FirstRowValue -Row $row -Names @('Kavel'))
            HighLevelDeliveryDate   = Parse-DateValue (Get-FirstRowValue -Row $row -Names @('HLopleverdatum'))
            BuildType               = Normalize-Text (Get-FirstRowValue -Row $row -Names @('Typebouw'))
            ReasonNa                = Normalize-Text (Get-FirstRowValue -Row $row -Names @('RedenNA'))
            StrandId                = Normalize-Text (Get-FirstRowValue -Row $row -Names @('StrengID'))
            DependsOnDuct           = Normalize-Text (Get-FirstRowValue -Row $row -Names @('Doorvoerafhankelijkheid'))
        }
    }

    return $rows
}

function Get-AddressLabel {
    param(
        [string]$Postcode,
        [string]$HouseNumber,
        [string]$HouseSuffix
    )

    $parts = @()

    if ($null -ne (Normalize-Text $Postcode)) {
        $parts += $Postcode.Trim().ToUpperInvariant()
    }

    if ($null -ne (Normalize-Text $HouseNumber)) {
        $parts += $HouseNumber.Trim()
    }

    if ($null -ne (Normalize-Text $HouseSuffix)) {
        $parts += ($HouseSuffix.Trim() -replace '\s+', '')
    }

    return ($parts -join '-')
}

function Get-DropLocationLabel {
    param(
        [string]$Postcode,
        [string]$HouseNumber,
        [string]$HouseSuffix,
        [string]$Room
    )

    $postcodeValue = Normalize-Text $Postcode
    $houseNumberValue = Normalize-Text $HouseNumber
    $houseSuffixValue = Normalize-Text $HouseSuffix
    $roomValue = Normalize-Text $Room

    if ($null -eq $postcodeValue -or $null -eq $houseNumberValue) {
        return Get-AddressLabel -Postcode $Postcode -HouseNumber $HouseNumber -HouseSuffix $HouseSuffix
    }

    if ($null -eq $roomValue) {
        return Get-AddressLabel -Postcode $Postcode -HouseNumber $HouseNumber -HouseSuffix $HouseSuffix
    }

    $suffixPart = if ($null -ne $houseSuffixValue) { ($houseSuffixValue.Trim() -replace '\s+', '') } else { '' }
    return '{0}-{1}-{2}-{3}' -f $postcodeValue.Trim().ToUpperInvariant(), $houseNumberValue.Trim(), $suffixPart, ($roomValue.Trim() -replace '\s+', '')
}

function Get-AddressMatchKey {
    param(
        [string]$Postcode,
        [string]$HouseNumber,
        [string]$HouseSuffix,
        [string]$Room
    )

    $parts = @()

    foreach ($value in @(
        (Normalize-Key $Postcode),
        (Normalize-Key $HouseNumber),
        (Normalize-Key $HouseSuffix),
        (Normalize-Key $Room)
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

function Parse-DpLabel {
    param([string]$Label)

    if ($Label -notmatch '^(?<project>.+)-ODP(?<code>\d{3})$') {
        throw "No se puede interpretar el DP '$Label'"
    }

    $code = [int]$Matches.code

    return [pscustomobject]@{
        Label        = $Label
        ProjectLabel = $Matches.project
        Code         = $code
        Stage        = [math]::Floor($code / 100)
        Suffix       = $code % 100
    }
}

function Get-ComplexDefinitions {
    param([string]$ProjectFolder)

    $definitions = @()

    if ($null -eq (Normalize-Text $ProjectFolder)) {
        return $definitions
    }

    $gebouwenFolder = Join-Path -Path $ProjectFolder -ChildPath 'Gebouwen'
    if (-not (Test-Path -LiteralPath $gebouwenFolder)) {
        return $definitions
    }

    foreach ($folder in (Get-ChildItem -LiteralPath $gebouwenFolder -Directory | Sort-Object Name)) {
        foreach ($part in ($folder.Name -split '\s+en\s+')) {
            $partText = $part.Trim()
            if ($partText -eq '') {
                continue
            }

            $street = $null
            $startReferenceText = $null
            $endReferenceText = $null
            $isCompactRange = $false

            if ($partText -match '^(?<street>.+?)\s+(?<start>\d+(?:\s*-\s*[A-Za-z0-9]+|[A-Za-z]+)?)\s*(?:tm|t\/m)\s*(?<end>\d+(?:\s*-\s*[A-Za-z0-9]+|[A-Za-z]+)?)$') {
                $street = $Matches.street.Trim()
                $startReferenceText = $Matches.start.Trim()
                $endReferenceText = $Matches.end.Trim()
            }
            elseif ($partText -match '^(?<street>.+?)\s+(?<start>\d+[A-Za-z]*)\s*-\s*(?<end>\d+[A-Za-z]*)$') {
                $street = $Matches.street.Trim()
                $startReferenceText = $Matches.start.Trim()
                $endReferenceText = $Matches.end.Trim()
                $isCompactRange = $true
            }

            if ($null -eq $street) {
                continue
            }

            $startReference = Parse-HouseReference $startReferenceText
            $endReference = Parse-HouseReference $endReferenceText
            if ($null -eq $startReference -or $null -eq $endReference) {
                continue
            }

            if ((Compare-HouseReference -NumberA $startReference.Number -SuffixA $startReference.Suffix -NumberB $endReference.Number -SuffixB $endReference.Suffix) -gt 0) {
                $swap = $startReference
                $startReference = $endReference
                $endReference = $swap
            }

            $step = if ($endReference.Number -gt $startReference.Number -and (($endReference.Number - $startReference.Number) % 2) -eq 0) { 2 } else { 1 }
            $requiredParity = $null
            if ($isCompactRange -and $null -eq $startReference.Suffix -and $null -eq $endReference.Suffix -and $step -eq 2) {
                $requiredParity = if (($startReference.Number % 2) -eq 0) { 'Even' } else { 'Odd' }
            }
            $exactSuffix = $null
            if ($isCompactRange -and $startReference.Suffix -eq 'H' -and $endReference.Suffix -eq 'H') {
                $endReference = [pscustomobject]@{
                    Number = $endReference.Number
                    Suffix = '2'
                }
            }
            elseif ($isCompactRange -and $null -eq $startReference.Suffix -and $null -eq $endReference.Suffix) {
                $exactSuffix = '<EMPTY>'
            }

            $definitions += [pscustomobject]@{
                Name         = $folder.Name
                Street       = $street
                StreetKey    = Normalize-StreetKey $street
                Start        = $startReference
                End          = $endReference
                Step         = $step
                RequiredParity = $requiredParity
                ExactSuffix  = $exactSuffix
            }
        }
    }

    return $definitions
}

function Test-HouseMatchesComplexDefinition {
    param(
        [int]$HouseNumberValue,
        [string]$HouseSuffix,
        [pscustomobject]$Definition
    )

    if ($HouseNumberValue -lt $Definition.Start.Number -or $HouseNumberValue -gt $Definition.End.Number) {
        return $false
    }

    if ($Definition.Step -gt 1 -and $HouseNumberValue -ne $Definition.Start.Number -and $HouseNumberValue -ne $Definition.End.Number) {
        if ((($HouseNumberValue - $Definition.Start.Number) % $Definition.Step) -ne 0) {
            return $false
        }
    }

    if ($Definition.RequiredParity -eq 'Even' -and (($HouseNumberValue % 2) -ne 0)) {
        return $false
    }

    if ($Definition.RequiredParity -eq 'Odd' -and (($HouseNumberValue % 2) -eq 0)) {
        return $false
    }

    $normalizedSuffix = Normalize-HouseSuffix $HouseSuffix
    if ($Definition.ExactSuffix -eq '<EMPTY>') {
        if ($null -ne $normalizedSuffix) {
            return $false
        }
    }
    elseif ($null -ne $Definition.ExactSuffix -and $normalizedSuffix -ne $Definition.ExactSuffix) {
        return $false
    }

    if ((Compare-HouseReference -NumberA $HouseNumberValue -SuffixA $normalizedSuffix -NumberB $Definition.Start.Number -SuffixB $Definition.Start.Suffix) -lt 0) {
        return $false
    }

    if ((Compare-HouseReference -NumberA $HouseNumberValue -SuffixA $normalizedSuffix -NumberB $Definition.End.Number -SuffixB $Definition.End.Suffix) -gt 0) {
        return $false
    }

    return $true
}

function Resolve-ComplexName {
    param(
        [string]$Street,
        [object]$HouseNumber,
        [string]$HouseSuffix,
        [object[]]$Definitions
    )

    if ($null -eq $Definitions -or $Definitions.Count -eq 0) {
        return $null
    }

    $streetKey = Normalize-StreetKey $Street
    $houseNumberValue = Try-ParseHouseNumber $HouseNumber

    if ($null -eq $streetKey -or $null -eq $houseNumberValue) {
        return $null
    }

    foreach ($definition in $Definitions) {
        if ($definition.StreetKey -ne $streetKey) {
            continue
        }

        if (Test-HouseMatchesComplexDefinition -HouseNumberValue $houseNumberValue -HouseSuffix $HouseSuffix -Definition $definition) {
            return $definition.Name
        }
    }

    return $null
}

function Get-PdfToTextPath {
    $command = Get-Command pdftotext.exe -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        return $null
    }

    return $command.Source
}

function Get-PdfText {
    param([string]$PdfPath)

    $pdfToTextPath = Get-PdfToTextPath
    if ($null -eq $pdfToTextPath) {
        return $null
    }

    $tempPath = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ('permit_' + [guid]::NewGuid().ToString() + '.txt')

    try {
        [void](Start-Process -FilePath $pdfToTextPath -ArgumentList @(('"' + $PdfPath + '"'), ('"' + $tempPath + '"')) -WindowStyle Hidden -Wait -PassThru)
        if (-not (Test-Path -LiteralPath $tempPath)) {
            return $null
        }

        return Get-Content -LiteralPath $tempPath -Raw -ErrorAction SilentlyContinue
    }
    finally {
        Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    }
}

function Get-DateCandidatesFromText {
    param([string]$Text)

    $candidates = @()
    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $candidates
    }

    $monthLookup = @{
        'januari'   = 1
        'februari'  = 2
        'maart'     = 3
        'april'     = 4
        'mei'       = 5
        'juni'      = 6
        'juli'      = 7
        'augustus'  = 8
        'september' = 9
        'oktober'   = 10
        'november'  = 11
        'december'  = 12
    }

    foreach ($match in [regex]::Matches($Text, '(?im)\b(?<day>\d{1,2})\s+(?<month>januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\s+(?<year>\d{4})\b')) {
        $monthNumber = $monthLookup[$match.Groups['month'].Value.ToLowerInvariant()]
        $candidates += [datetime]::new([int]$match.Groups['year'].Value, $monthNumber, [int]$match.Groups['day'].Value)
    }

    foreach ($match in [regex]::Matches($Text, '(?im)\b(?<day>\d{1,2})[\/\.-](?<month>\d{1,2})[\/\.-](?<year>\d{2,4})\b')) {
        $yearNumber = [int]$match.Groups['year'].Value
        if ($yearNumber -lt 100) {
            $yearNumber += 2000
        }

        try {
            $candidates += [datetime]::new($yearNumber, [int]$match.Groups['month'].Value, [int]$match.Groups['day'].Value)
        }
        catch {
        }
    }

    foreach ($match in [regex]::Matches($Text, '(?im)\b(?<year>\d{4})[\/\.-](?<month>\d{1,2})[\/\.-](?<day>\d{1,2})\b')) {
        try {
            $candidates += [datetime]::new([int]$match.Groups['year'].Value, [int]$match.Groups['month'].Value, [int]$match.Groups['day'].Value)
        }
        catch {
        }
    }

    return @($candidates | Sort-Object | Get-Unique)
}

function Get-VergunningInfo {
    param(
        [string]$ProjectFolder,
        [string]$ProjectNumber
    )

    $defaultName = if ($null -ne (Normalize-Text $ProjectNumber)) { 'Instemming Gemeente {0}' -f $ProjectNumber } else { 'Instemming Gemeente' }
    $info = [pscustomobject]@{
        Name        = $defaultName
        Issuer      = $null
        GrantedDate = $null
        ExpiryDate  = $null
    }

    if ($null -eq (Normalize-Text $ProjectFolder)) {
        return $info
    }

    $vergunningFolder = Join-Path -Path $ProjectFolder -ChildPath 'Vergunningen'
    if (-not (Test-Path -LiteralPath $vergunningFolder)) {
        return $info
    }

    $firstPermitFolder = Get-ChildItem -LiteralPath $vergunningFolder -Directory | Select-Object -First 1
    if ($null -ne $firstPermitFolder) {
        $info.Name = $firstPermitFolder.Name
    }

    $allText = New-Object System.Text.StringBuilder

    foreach ($file in (Get-ChildItem -LiteralPath $vergunningFolder -Recurse -File | Where-Object { $_.Extension -ieq '.pdf' })) {
        $text = Get-PdfText -PdfPath $file.FullName
        if ($null -eq $text) {
            continue
        }

        [void]$allText.AppendLine($text)
    }

    $combinedText = $allText.ToString()
    $monthLookup = @{
        'januari'   = 1
        'februari'  = 2
        'maart'     = 3
        'april'     = 4
        'mei'       = 5
        'juni'      = 6
        'juli'      = 7
        'augustus'  = 8
        'september' = 9
        'oktober'   = 10
        'november'  = 11
        'december'  = 12
    }
    $allDates = @()

    foreach ($match in [regex]::Matches($combinedText, '(?im)\b(?<day>\d{1,2})\s+(?<month>januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\s+(?<year>\d{4})\b')) {
        $monthNumber = $monthLookup[$match.Groups['month'].Value.ToLowerInvariant()]
        $allDates += [datetime]::new([int]$match.Groups['year'].Value, $monthNumber, [int]$match.Groups['day'].Value)
    }

    foreach ($match in [regex]::Matches($combinedText, '(?im)\b(?<day>\d{1,2})[\/\.-](?<month>\d{1,2})[\/\.-](?<year>\d{2,4})\b')) {
        $yearNumber = [int]$match.Groups['year'].Value
        if ($yearNumber -lt 100) {
            $yearNumber += 2000
        }

        try {
            $allDates += [datetime]::new($yearNumber, [int]$match.Groups['month'].Value, [int]$match.Groups['day'].Value)
        }
        catch {
        }
    }

    foreach ($match in [regex]::Matches($combinedText, '(?im)\b(?<year>\d{4})[\/\.-](?<month>\d{1,2})[\/\.-](?<day>\d{1,2})\b')) {
        try {
            $allDates += [datetime]::new([int]$match.Groups['year'].Value, [int]$match.Groups['month'].Value, [int]$match.Groups['day'].Value)
        }
        catch {
        }
    }

    if ($allDates.Count -gt 0) {
        $latestDate = @($allDates | Sort-Object | Select-Object -Last 1)[0]
        $info.GrantedDate = $latestDate.Date
        $info.ExpiryDate = $latestDate.Date.AddYears(1)
    }

    if ($combinedText -match '(?im)\bGemeente\s+Rotterdam\b') {
        $info.Issuer = 'Rotterdam Gemeente'
    }
    elseif ($combinedText -match '(?im)\bGemeente\s+(?<city>[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\b') {
        $cityName = ($Matches.city -replace '\s+', ' ').Trim()
        $info.Issuer = '{0} Gemeente' -f $cityName
    }

    return $info
}

function Get-DwgCoordinateMap {
    param(
        [string]$ProjectFolder,
        [string]$ProjectNumber
    )

    $coordinates = @{}

    if ($null -eq (Normalize-Text $ProjectFolder) -or $null -eq (Normalize-Text $ProjectNumber)) {
        return $coordinates
    }

    $dwgPath = Join-Path -Path $ProjectFolder -ChildPath ('{0}.dwg' -f $ProjectNumber)
    if (-not (Test-Path -LiteralPath $dwgPath)) {
        $dwgCandidate = Get-ChildItem -LiteralPath $ProjectFolder -File | Where-Object { $_.Extension -ieq '.dwg' } | Select-Object -First 1
        if ($null -ne $dwgCandidate) {
            $dwgPath = $dwgCandidate.FullName
        }
    }

    if (-not (Test-Path -LiteralPath $dwgPath)) {
        return $coordinates
    }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) {
        return $coordinates
    }

    $helperPath = Join-Path -Path (Get-Location) -ChildPath 'extract_dwg_accesspoints.mjs'
    $packagePath = Join-Path -Path (Get-Location) -ChildPath 'node_modules\@mlightcad\libredwg-web'
    if (-not (Test-Path -LiteralPath $helperPath) -or -not (Test-Path -LiteralPath $packagePath)) {
        return $coordinates
    }

    try {
        $jsonOutput = & $node.Source $helperPath $dwgPath 2>$null
        if ($LASTEXITCODE -ne 0) {
            return $coordinates
        }

        $jsonText = ($jsonOutput -join [Environment]::NewLine).Trim()
        if ($jsonText -eq '') {
            return $coordinates
        }

        $parsed = $jsonText | ConvertFrom-Json
        $items = if ($parsed.PSObject.Properties.Name -contains 'coordinates') { $parsed.coordinates.PSObject.Properties } else { $parsed.PSObject.Properties }

        foreach ($item in $items) {
            $coordinates[$item.Name] = [pscustomobject]@{
                X = [double]$item.Value.x
                Y = [double]$item.Value.y
                Z = if ($null -ne $item.Value.z) { [int]$item.Value.z } else { 0 }
            }
        }
    }
    catch {
        return @{}
    }

    return $coordinates
}

function Get-ExternalMetadata {
    param([string]$Path)

    if ($null -eq (Normalize-Text $Path)) {
        return $null
    }

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    try {
        return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
    }
    catch {
        throw "No se pudo leer el metadata JSON en '$Path': $($_.Exception.Message)"
    }
}

function Convert-ExternalCoordinates {
    param([object]$Coordinates)

    $result = @{}
    if ($null -eq $Coordinates) {
        return $result
    }

    foreach ($property in $Coordinates.PSObject.Properties) {
        $result[$property.Name] = [pscustomobject]@{
            X = [double]$property.Value.x
            Y = [double]$property.Value.y
            Z = if ($null -ne $property.Value.z) { [int]$property.Value.z } else { 0 }
        }
    }

    return $result
}

function Convert-ExternalVergunningInfo {
    param([object]$Vergunning)

    if ($null -eq $Vergunning) {
        return $null
    }

    return [pscustomobject]@{
        Name        = Normalize-Text $Vergunning.name
        Issuer      = Normalize-Text $Vergunning.issuer
        GrantedDate = Parse-DateValue $Vergunning.grantedDate
        ExpiryDate  = Parse-DateValue $Vergunning.expiryDate
    }
}

function Convert-ExternalInternalDpDecisions {
    param([object]$InternalDpDecisions)

    $result = @{}
    if ($null -eq $InternalDpDecisions) {
        return $result
    }

    foreach ($property in $InternalDpDecisions.PSObject.Properties) {
        $label = Normalize-Text $property.Name
        if ($null -eq $label) {
            continue
        }

        $result[$label] = [bool]$property.Value
    }

    return $result
}

function Get-DefaultBackboneCableNamingConfig {
    return [pscustomobject]@{
        Mode         = 'fixedK01'
        BPadLength   = 2
        KPadLength   = 2
        SegmentPadLength = 2
        BStart       = 1
        KStart       = 1
        KStep        = 0
    }
}

function Convert-ExternalBackboneCableNamingConfig {
    param([object]$BackboneCableNaming)

    $defaultConfig = Get-DefaultBackboneCableNamingConfig
    if ($null -eq $BackboneCableNaming) {
        return $defaultConfig
    }

    $mode = Normalize-Text $BackboneCableNaming.mode
    if ($null -eq $mode) {
        $mode = $defaultConfig.Mode
    }

    return [pscustomobject]@{
        Mode             = $mode
        BPadLength       = if ($null -ne $BackboneCableNaming.bPadLength) { [int]$BackboneCableNaming.bPadLength } else { $defaultConfig.BPadLength }
        KPadLength       = if ($null -ne $BackboneCableNaming.kPadLength) { [int]$BackboneCableNaming.kPadLength } else { $defaultConfig.KPadLength }
        SegmentPadLength = if ($null -ne $BackboneCableNaming.segmentPadLength) { [int]$BackboneCableNaming.segmentPadLength } else { $defaultConfig.SegmentPadLength }
        BStart           = if ($null -ne $BackboneCableNaming.bStart) { [int]$BackboneCableNaming.bStart } else { $defaultConfig.BStart }
        KStart           = if ($null -ne $BackboneCableNaming.kStart) { [int]$BackboneCableNaming.kStart } else { $defaultConfig.KStart }
        KStep            = if ($null -ne $BackboneCableNaming.kStep) { [int]$BackboneCableNaming.kStep } else { $defaultConfig.KStep }
    }
}

function Get-TableFieldNames {
    param(
        [__ComObject]$Database,
        [string]$TableName
    )

    return @(
        $Database.TableDefs[$TableName].Fields |
            ForEach-Object { $_.Name }
    )
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

function Write-AccessTable {
    param(
        [__ComObject]$Database,
        [string]$TableName,
        [object[]]$Rows
    )

    $fieldLookup = @{}
    foreach ($field in $Database.TableDefs[$TableName].Fields) {
        $fieldLookup[$field.Name] = [pscustomobject]@{
            Name          = $field.Name
            IsAutoNumber  = (($field.Attributes -band 16) -ne 0)
        }
    }

    $recordset = $Database.OpenRecordset($TableName)
    try {
        foreach ($row in $Rows) {
            $recordset.AddNew()
            foreach ($property in $row.PSObject.Properties) {
                if ($fieldLookup.ContainsKey($property.Name) -and -not $fieldLookup[$property.Name].IsAutoNumber) {
                    $field = $recordset.Fields($property.Name)
                    try {
                        Set-AccessFieldValue -Recordset $recordset -FieldName $property.Name -Value $property.Value
                    }
                    catch {
                        $value = $property.Value
                        $valueType = if ($null -eq $value) { 'null' } else { $value.GetType().FullName }
                        throw "Error escribiendo [$TableName].[$($property.Name)] (FieldType=$($field.Type), ValueType=$valueType, Value='$value'): $($_.Exception.Message)"
                    }
                }
            }
            try {
                $recordset.Update()
            }
            catch {
                throw "Error haciendo Update en tabla [$TableName]: $($_.Exception.Message)"
            }
        }
    }
    finally {
        $recordset.Close()
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

function Get-RowValue {
    param(
        [object]$Row,
        [string]$Name
    )

    if ($null -eq $Row -or $null -eq $Name) {
        return $null
    }

    if ($Row -is [System.Data.DataRow]) {
        if ($Row.Table.Columns.Contains($Name)) {
            $value = $Row[$Name]
            if ($value -is [System.DBNull]) {
                return $null
            }

            return $value
        }

        return $null
    }

    $property = $Row.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }

    return $property.Value
}

function Get-FirstRowValue {
    param(
        [object]$Row,
        [string[]]$Names
    )

    foreach ($name in $Names) {
        $value = Get-RowValue -Row $Row -Name $name
        if ($null -ne $value) {
            return $value
        }
    }

    return $null
}

function Get-CrossCheckTemplatePath {
    param([string]$ProjectFolder)

    $candidates = @()

    if ($null -ne (Normalize-Text $ProjectFolder)) {
        $candidates += (Join-Path -Path $ProjectFolder -ChildPath 'Address cross check Cocon delivery 4.0.xlsx')
    }

    $candidates += (Join-Path -Path $PSScriptRoot -ChildPath 'app\assets\Address cross check Cocon delivery 4.0.xlsx')
    $candidates += (Join-Path -Path $PSScriptRoot -ChildPath 'Address cross check Cocon delivery 4.0.xlsx')

    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if (Test-Path -LiteralPath $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    return $null
}

function Get-CrossCheckOutputPath {
    param([string]$OutputPath)

    $outputDirectory = [System.IO.Path]::GetDirectoryName($OutputPath)
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($OutputPath)

    return (Join-Path -Path $outputDirectory -ChildPath ('{0}.Address cross check Cocon delivery 4.0.xlsx' -f $baseName))
}

function Set-ExcelCellValue {
    param(
        [__ComObject]$Worksheet,
        [int]$RowIndex,
        [int]$ColumnIndex,
        [object]$Value
    )

    $cell = $Worksheet.Cells.Item($RowIndex, $ColumnIndex)

    try {
        if ($Value -is [string] -or $Value -is [char]) {
            $Value = Normalize-Text $Value
        }

        if ($null -eq $Value) {
            $cell.ClearContents() | Out-Null
            return
        }

        $cell.Value2 = $Value
    }
    finally {
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($cell)
    }
}

function Clear-ExcelColumns {
    param(
        [__ComObject]$Worksheet,
        [int]$StartRow,
        [int[]]$ColumnsToClear
    )

    if ($ColumnsToClear.Count -eq 0) {
        return
    }

    $usedRange = $Worksheet.UsedRange

    try {
        $usedLastRow = $usedRange.Row + $usedRange.Rows.Count - 1

        if ($usedLastRow -lt $StartRow) {
            return
        }

        foreach ($columnIndex in $ColumnsToClear) {
            $range = $Worksheet.Range($Worksheet.Cells.Item($StartRow, $columnIndex), $Worksheet.Cells.Item($usedLastRow, $columnIndex))

            try {
                $range.ClearContents() | Out-Null
            }
            finally {
                [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($range)
            }
        }
    }
    finally {
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($usedRange)
    }
}

function Write-ExcelMappedRows {
    param(
        [__ComObject]$Worksheet,
        [int]$StartRow,
        [object[]]$Rows,
        [scriptblock]$ColumnMapper,
        [int[]]$ColumnsToClear
    )

    Clear-ExcelColumns -Worksheet $Worksheet -StartRow $StartRow -ColumnsToClear $ColumnsToClear

    $rowIndex = $StartRow
    foreach ($row in $Rows) {
        $mappedValues = & $ColumnMapper $row
        foreach ($entry in $mappedValues.GetEnumerator()) {
            Set-ExcelCellValue -Worksheet $Worksheet -RowIndex $rowIndex -ColumnIndex ([int]$entry.Key) -Value $entry.Value
        }

        $rowIndex++
    }
}

function Export-CrossCheckWorkbook {
    param(
        [string]$ProjectFolder,
        [string]$OutputPath,
        [object[]]$FcSourceRows,
        [object[]]$BcSourceRows,
        [hashtable]$TableRows
    )

    $templatePath = Get-CrossCheckTemplatePath -ProjectFolder $ProjectFolder
    if ($null -eq $templatePath) {
        Write-Warning 'No se ha encontrado el template de Address cross check Cocon delivery 4.0. Se omite la exportacion del Excel.'
        return $null
    }

    $crossCheckOutputPath = Get-CrossCheckOutputPath -OutputPath $OutputPath
    Copy-Item -LiteralPath $templatePath -Destination $crossCheckOutputPath -Force

    try {
        $excel = New-Object -ComObject Excel.Application
    }
    catch {
        Write-Warning "No se ha podido abrir Excel para rellenar el Address cross check: $($_.Exception.Message)"
        return $null
    }

    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $excel.ScreenUpdating = $false
    $excel.EnableEvents = $false
    try {
        $excel.Calculation = -4135
        $excel.CalculateBeforeSave = $false
    }
    catch {
    }

    $workbook = $null
    $worksheets = @()

    try {
        $workbook = $excel.Workbooks.Open($crossCheckOutputPath)

        $worksheetLookup = @{
            FC          = $workbook.Worksheets.Item('FC')
            BC          = $workbook.Worksheets.Item('BC')
            ODF         = $workbook.Worksheets.Item('ODF')
            AfwerkODF   = $workbook.Worksheets.Item('AfwerkODF')
            Accesspoint = $workbook.Worksheets.Item('Accesspoint')
            Kabel       = $workbook.Worksheets.Item('Kabel')
            Klant       = $workbook.Worksheets.Item('Klant')
            LAS         = $workbook.Worksheets.Item('LAS')
        }

        $worksheets = @($worksheetLookup.Values)

        Write-ExcelMappedRows -Worksheet $worksheetLookup.FC -StartRow 2 -Rows $FcSourceRows -ColumnsToClear (5..26) -ColumnMapper {
            param($row)

            [ordered]@{
                5  = Get-RowValue -Row $row -Name 'Projectnummer'
                6  = Get-RowValue -Row $row -Name 'Postcode'
                7  = Get-RowValue -Row $row -Name 'Huisnummer'
                8  = Get-RowValue -Row $row -Name 'Huisnummer Toevoeging'
                9  = Get-RowValue -Row $row -Name 'Kamer'
                10 = Get-RowValue -Row $row -Name 'Straat'
                11 = Get-RowValue -Row $row -Name 'Plaats'
                12 = Get-RowValue -Row $row -Name 'FTU locatie'
                13 = Get-RowValue -Row $row -Name 'Powermeter'
                14 = Get-RowValue -Row $row -Name 'IP vezelwaarde'
                15 = Get-RowValue -Row $row -Name 'Opleverstatus KPN'
                16 = Get-RowValue -Row $row -Name 'Opleverdatum'
                17 = Get-RowValue -Row $row -Name 'AP'
                18 = Get-RowValue -Row $row -Name 'Werkgebied'
                19 = Get-RowValue -Row $row -Name 'Opgeleverd'
                20 = Get-RowValue -Row $row -Name 'KPN/Glaspoort'
                21 = Get-RowValue -Row $row -Name 'Kast'
                22 = Get-RowValue -Row $row -Name 'Kastrij'
                23 = Get-RowValue -Row $row -Name 'ODF'
                24 = Get-RowValue -Row $row -Name 'ODF Positie'
                25 = Get-RowValue -Row $row -Name 'DP'
                26 = Get-RowValue -Row $row -Name 'Kabel ID'
            }
        }

        Write-ExcelMappedRows -Worksheet $worksheetLookup.BC -StartRow 2 -Rows $BcSourceRows -ColumnsToClear (3..31) -ColumnMapper {
            param($row)

            [ordered]@{
                3  = Get-RowValue -Row $row -Name 'Postcode'
                4  = Get-RowValue -Row $row -Name 'Huisnummer'
                5  = Get-RowValue -Row $row -Name 'HuisnummerToevoeging'
                6  = Get-RowValue -Row $row -Name 'Kamer'
                7  = Get-RowValue -Row $row -Name 'Plandatum'
                8  = Get-RowValue -Row $row -Name 'Opleverdatum'
                9  = Get-RowValue -Row $row -Name 'Opleverstatus'
                10 = Get-RowValue -Row $row -Name 'Areapop'
                11 = Get-RowValue -Row $row -Name 'Rij'
                12 = Get-RowValue -Row $row -Name 'Kast'
                13 = Get-RowValue -Row $row -Name 'Blok'
                14 = Get-RowValue -Row $row -Name 'ODF'
                15 = Get-RowValue -Row $row -Name 'ODFpositie'
                16 = Get-RowValue -Row $row -Name 'ODFCATV'
                17 = Get-RowValue -Row $row -Name 'ODFCATVpositie'
                18 = Get-RowValue -Row $row -Name 'Projectcode'
                19 = Get-RowValue -Row $row -Name 'Hasdatum'
                20 = Get-RowValue -Row $row -Name 'Toestemming'
                21 = Get-RowValue -Row $row -Name 'Gebouwtype'
                22 = Get-RowValue -Row $row -Name 'FTU-Type'
                23 = Get-RowValue -Row $row -Name 'Toelichting'
                24 = Get-RowValue -Row $row -Name 'Civieldatum'
                25 = Get-RowValue -Row $row -Name 'Kavel'
                26 = Get-RowValue -Row $row -Name 'KabelID'
                27 = Get-RowValue -Row $row -Name 'HLopleverdatum'
                28 = Get-RowValue -Row $row -Name 'Typebouw'
                29 = Get-RowValue -Row $row -Name 'RedenNA'
                30 = Get-RowValue -Row $row -Name 'StrengID'
                31 = Get-RowValue -Row $row -Name 'Doorvoerafhankelijkheid'
            }
        }

        Write-ExcelMappedRows -Worksheet $worksheetLookup.ODF -StartRow 2 -Rows $TableRows.ODF -ColumnsToClear (3..10) -ColumnMapper {
            param($row)

            [ordered]@{
                3  = $row.ID
                4  = $row.Nummer
                5  = $row.ODFTYPE
                6  = $row.CBN
                7  = $row.Locatie
                8  = $row.HoogtePositie
                9  = $row.Zijde
                10 = $row.ImportResult
            }
        }

        Write-ExcelMappedRows -Worksheet $worksheetLookup.AfwerkODF -StartRow 2 -Rows $TableRows.AfwerkODF -ColumnsToClear (1..10) -ColumnMapper {
            param($row)

            [ordered]@{
                1  = $row.ID
                2  = $row.LOCATIE
                3  = $row.CBN
                4  = $row.ODF
                5  = $row.Traynr
                6  = $row.PP
                7  = $row.Kabel
                8  = $row.Vezelnr
                9  = $row.Connectortype
                10 = $row.ImportResult
            }
        }

        Write-ExcelMappedRows -Worksheet $worksheetLookup.Accesspoint -StartRow 2 -Rows $TableRows.Accesspoint -ColumnsToClear (2..10) -ColumnMapper {
            param($row)

            [ordered]@{
                2  = $row.ID
                3  = $row.Label
                4  = $row.Accesspointtype
                5  = $row.X
                6  = $row.Y
                7  = $row.Z
                8  = $row.Toelichting
                9  = $row.Nauwkeurigheid
                10 = $row.ImportResult
            }
        }

        Write-ExcelMappedRows -Worksheet $worksheetLookup.Kabel -StartRow 2 -Rows $TableRows.Kabel -ColumnsToClear (1..12) -ColumnMapper {
            param($row)

            [ordered]@{
                1  = $row.ID
                2  = $row.Label
                3  = $row.Kabeltype
                4  = $row.Locatienaam_A
                5  = $row.Afwerkeenheid_A
                6  = $row.PoortA
                7  = $row.Locatienaam_B
                8  = $row.Afwerkeenheid_B
                9  = $row.PoortB
                10 = $row.Serienummer
                11 = $row.ImportResult
                12 = $row.CATEGORIE
            }
        }

        Write-ExcelMappedRows -Worksheet $worksheetLookup.Klant -StartRow 2 -Rows $TableRows.Klant -ColumnsToClear @((5..26) + 28) -ColumnMapper {
            param($row)

            [ordered]@{
                5  = $row.ID
                6  = $row.Postcode
                7  = $row.Huisnr
                8  = $row.Toevoeging
                9  = $row.Kastnr
                10 = $row.FTUType
                11 = $row.Kabel
                12 = $row.VEZELNR1
                13 = $row.Dempingswaarde1A
                14 = $row.Specificatie1A
                15 = $row.Dempingswaarde1Z
                16 = $row.Specificatie1Z
                17 = $row.Vezelnr2
                18 = $row.Dempingswaarde2A
                19 = $row.Specificatie2A
                20 = $row.Dempingswaarde2Z
                21 = $row.Specificatie2Z
                22 = $row.X
                23 = $row.Y
                24 = $row.ImportResult
                25 = $row.COMPLEX
                26 = $row.KAMER
                28 = $row.FTU_SERIENUMMER
            }
        }

        Write-ExcelMappedRows -Worksheet $worksheetLookup.LAS -StartRow 3 -Rows $TableRows.Las -ColumnsToClear (1..13) -ColumnMapper {
            param($row)

            [ordered]@{
                1  = $row.ID
                2  = $row.LOCATIE
                3  = $row.SPLICEBOX
                4  = $row.KabelA
                5  = $row.VezelnrA
                6  = $row.Cassette
                7  = $row.Positienr
                8  = $row.CassetteType
                9  = $row.Gelast
                10 = $row.KabelB
                11 = $row.VezelnrB
                12 = $row.zijde_fasplaat
                13 = $row.ImportResult
            }
        }

        $workbook.Save()
        return $crossCheckOutputPath
    }
    finally {
        foreach ($worksheet in $worksheets) {
            if ($null -ne $worksheet) {
                [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($worksheet)
            }
        }

        if ($null -ne $workbook) {
            $workbook.Close($false)
            [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($workbook)
        }

        $excel.Quit()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
    }
}

function Get-BackboneCableLabel {
    param(
        [string]$ProjectLabel,
        [int]$Suffix,
        [int]$SegmentNumber
    )

    $config = if ($null -ne $script:BackboneCableNamingConfig) { $script:BackboneCableNamingConfig } else { Get-DefaultBackboneCableNamingConfig }
    $bNumber = $config.BStart + ($Suffix - 1)
    $kNumber = switch ($config.Mode) {
        'matchBlock' { $config.KStart + ($Suffix - 1) }
        'customSeries' { $config.KStart + (($Suffix - 1) * $config.KStep) }
        default { $config.KStart }
    }

    $bText = $bNumber.ToString(('D{0}' -f $config.BPadLength))
    $kText = $kNumber.ToString(('D{0}' -f $config.KPadLength))
    $segmentText = $SegmentNumber.ToString(('D{0}' -f $config.SegmentPadLength))

    return '{0}-B{1}-K{2}-S{3}' -f $ProjectLabel, $bText, $kText, $segmentText
}

function Build-ProjectModel {
    param(
        [object[]]$FcRows,
        [object[]]$BcRows,
        [hashtable]$InternalDpDecisions = @{}
    )

    $fcByCable = @{}
    foreach ($fcRow in $FcRows) {
        $fcByCable[(Normalize-Key $fcRow.CableId)] = $fcRow
    }

    $customers = @()
    foreach ($bcRow in $BcRows) {
        $key = Normalize-Key $bcRow.CableId
        if ($null -eq $key -or -not $fcByCable.ContainsKey($key)) {
            continue
        }

        $fcRow = $fcByCable[$key]
        $dpInfo = Parse-DpLabel $fcRow.DpLabel
        $ftuType = Normalize-Text $bcRow.FtuType

        $customers += [pscustomobject]@{
            CableId            = $bcRow.CableId
            DpLabel            = $fcRow.DpLabel
            ProjectLabel       = $dpInfo.ProjectLabel
            Stage              = $dpInfo.Stage
            Suffix             = $dpInfo.Suffix
            Fiber              = [int]$bcRow.Fiber
            Postcode           = $bcRow.Postcode
            HouseNumber        = $bcRow.HouseNumber
            HouseSuffix        = $bcRow.HouseSuffix
            Room               = $bcRow.Room
            Street             = $fcRow.Street
            FtuLocation        = Normalize-UpperStatus $fcRow.FtuLocation
            FtuType            = $ftuType
            StatusIs2          = ((Normalize-Text $bcRow.DeliveryStatus) -eq '2')
            DeliveryStatus     = $bcRow.DeliveryStatus
            DeliveryDate       = $bcRow.DeliveryDate
            PlannedDate        = $bcRow.PlannedDate
            Notes              = $bcRow.Notes
            CivilDate          = $bcRow.CivilDate
            Consent            = $bcRow.Consent
            BuildingType       = $bcRow.BuildingType
            Powermeter         = $fcRow.Powermeter
            IpFiberValue       = $fcRow.IpFiberValue
            Measurement        = if ($null -ne $fcRow.Powermeter) { $fcRow.Powermeter } else { $fcRow.IpFiberValue }
            AddressLabel       = Get-AddressLabel -Postcode $bcRow.Postcode -HouseNumber $bcRow.HouseNumber -HouseSuffix $bcRow.HouseSuffix
            DropLocationLabel  = Get-DropLocationLabel -Postcode $bcRow.Postcode -HouseNumber $bcRow.HouseNumber -HouseSuffix $bcRow.HouseSuffix -Room $bcRow.Room
            InstallDate        = $bcRow.DeliveryDate
        }
    }

    if ($customers.Count -eq 0) {
        throw 'No se ha podido construir ningún cliente uniendo FC y BC'
    }

    $projectLabel = ($customers | Select-Object -First 1).ProjectLabel
    $projectNumber = Normalize-Text (($BcRows | Select-Object -First 1).ProjectNumber)
    if ($null -eq $projectNumber) {
        $projectNumber = Normalize-Text (($FcRows | Select-Object -First 1).ProjectNumber)
    }

    $chains = @()
    foreach ($group in ($customers | Group-Object Suffix | Sort-Object Name)) {
        $segments = @()
        foreach ($segmentGroup in ($group.Group | Group-Object DpLabel | Sort-Object Name)) {
            $orderedCustomers = @($segmentGroup.Group | Sort-Object Fiber, CableId)
            $dpInfo = Parse-DpLabel $segmentGroup.Name

            $segments += [pscustomobject]@{
                DpLabel        = $segmentGroup.Name
                Stage          = $dpInfo.Stage
                Suffix         = $dpInfo.Suffix
                Customers      = $orderedCustomers
                CustomerCount  = $orderedCustomers.Count
                MinFiber       = ($orderedCustomers | Select-Object -First 1).Fiber
                MaxFiber       = ($orderedCustomers | Select-Object -Last 1).Fiber
            }
        }

        $segments = @($segments | Sort-Object Stage)

        for ($index = 0; $index -lt $segments.Count; $index++) {
            $segment = $segments[$index]
            $segmentNumber = $index + 1
            $incomingCable = Get-BackboneCableLabel -ProjectLabel $projectLabel -Suffix ([int]$segment.Suffix) -SegmentNumber $segmentNumber
            $outgoingCable = $null
            $segmentEnd = 96
            $forceInternal = $false
            $hasExplicitInternalDecision = ($segments.Count -eq 1 -and $InternalDpDecisions.ContainsKey($segment.DpLabel))

            if ($hasExplicitInternalDecision) {
                $forceInternal = [bool]$InternalDpDecisions[$segment.DpLabel]
            }

            if ($index -lt ($segments.Count - 1)) {
                $nextSegment = $segments[$index + 1]
                $outgoingCable = Get-BackboneCableLabel -ProjectLabel $projectLabel -Suffix ([int]$segment.Suffix) -SegmentNumber ($segmentNumber + 1)
                $segmentEnd = [int]$nextSegment.MinFiber - 1
            }
            elseif ($hasExplicitInternalDecision -and -not $forceInternal) {
                $segmentEnd = 48
            }
            elseif ($segments.Count -eq 1 -and [int]$segment.Stage -eq 0) {
                $segmentEnd = 48
            }

            $segmentSize = $segmentEnd - [int]$segment.MinFiber + 1
            $segmentCassettes = [math]::Ceiling($segmentSize / 12.0)
            if ($segmentSize -gt 48) {
                $cassetteType = '4SE12-A'
                $accesspointType = 'LB_BUDI-M-SP-A_TY01'
                $spliceBoxType = 'LB_BUDI-M-SP-A_TY01'
            }
            else {
                $cassetteType = '4SE12-AM'
                $accesspointType = 'HH_29030_AT02'
                $spliceBoxType = 'LM_29050_AT01'
            }

            $segments[$index] | Add-Member -NotePropertyName SegmentNumber -NotePropertyValue $segmentNumber
            $segments[$index] | Add-Member -NotePropertyName IncomingCable -NotePropertyValue $incomingCable
            $segments[$index] | Add-Member -NotePropertyName OutgoingCable -NotePropertyValue $outgoingCable
            $segments[$index] | Add-Member -NotePropertyName SegmentEnd -NotePropertyValue $segmentEnd
            $segments[$index] | Add-Member -NotePropertyName SegmentSize -NotePropertyValue $segmentSize
            $segments[$index] | Add-Member -NotePropertyName SegmentCassettes -NotePropertyValue $segmentCassettes
            $segments[$index] | Add-Member -NotePropertyName CassetteType -NotePropertyValue $cassetteType
            $segments[$index] | Add-Member -NotePropertyName AccesspointType -NotePropertyValue $accesspointType
            $segments[$index] | Add-Member -NotePropertyName SpliceBoxType -NotePropertyValue $spliceBoxType
        }

        $chains += [pscustomobject]@{
            Suffix   = [int]$group.Name
            Segments = $segments
        }
    }

    return [pscustomobject]@{
        ProjectLabel  = $projectLabel
        ProjectNumber = $projectNumber
        Customers     = $customers
        Chains        = $chains
    }
}

function Get-AmbiguousInternalDpCandidates {
    param(
        [pscustomobject]$Model,
        [hashtable]$InternalDpDecisions = @{}
    )

    $candidates = @()

    foreach ($chain in ($Model.Chains | Sort-Object Suffix)) {
        if ($chain.Segments.Count -ne 1) {
            continue
        }

        $segment = $chain.Segments | Select-Object -First 1
        if ([int]$segment.Stage -ne 0) {
            continue
        }

        if ($InternalDpDecisions.ContainsKey($segment.DpLabel)) {
            continue
        }

        $candidates += [pscustomobject]@{
            DpLabel             = $segment.DpLabel
            Suffix              = [int]$chain.Suffix
            Stage               = [int]$segment.Stage
            SuggestedIsInternal = $false
            Reason              = 'La cadena solo tiene un DP visible. Sin confirmacion adicional, puede interpretarse como un DP normal de 48 fibras o como un DP interno de 96 fibras.'
        }
    }

    return $candidates
}

function Build-PopRows {
    param([pscustomobject]$Model)

    return @(
        [pscustomobject]@{
            ID           = 1
            Soort_POP    = 'OAP 720/40 MD4'
            Label        = $Model.ProjectLabel
            X            = 0
            Y            = 0
            Postcode     = $null
            Huisnr       = $null
            Toevoeging   = $null
            ImportResult = $null
            ALIASNAME    = $null
            ADDRESSID    = $null
        }
    )
}

function Build-CbnRows {
    param([pscustomobject]$Model)

    return @(
        [pscustomobject]@{
            ID           = 1
            Label        = '101'
            Locatie      = $Model.ProjectLabel
            CBNType      = 'ODF_OAP-L_PPC01'
            RIJ          = 1
            Ruimte       = $null
            Verdieping   = $null
            Floortile    = 'A'
            Toelichting  = $null
            ImportResult = $null
            Campo1       = $null
        }
    )
}

function Build-OdfRows {
    param([pscustomobject]$Model)

    $rows = @()
    $id = 1
    $chainBySuffix = @{}
    foreach ($chain in $Model.Chains) {
        $chainBySuffix[[int]$chain.Suffix] = $chain
    }

    $maxSuffix = 8
    if ($chainBySuffix.Count -gt 0) {
        $maxSuffix = [Math]::Max($maxSuffix, (($chainBySuffix.Keys | Measure-Object -Maximum).Maximum))
    }

    for ($suffix = 1; $suffix -le $maxSuffix; $suffix++) {
        $number = 4 + $suffix
        $rows += [pscustomobject]@{
            ID            = $id
            Nummer        = $number
            ODFTYPE       = 'LPL_OAP-R_PPC02'
            CBN           = '101'
            Locatie       = $Model.ProjectLabel
            HoogtePositie = $number
            Zijde         = 'V'
            ImportResult  = $null
        }
        $id++
    }

    return $rows
}

function Build-AfwerkOdfRows {
    param([pscustomobject]$Model)

    $rows = @()
    $id = 1
    $chainBySuffix = @{}
    foreach ($chain in $Model.Chains) {
        $chainBySuffix[[int]$chain.Suffix] = $chain
    }

    $maxSuffix = 8
    if ($chainBySuffix.Count -gt 0) {
        $maxSuffix = [Math]::Max($maxSuffix, (($chainBySuffix.Keys | Measure-Object -Maximum).Maximum))
    }

    for ($suffix = 1; $suffix -le $maxSuffix; $suffix++) {
        $odf = 4 + $suffix
        $chain = $chainBySuffix[$suffix]
        $cable = if ($null -ne $chain) {
            Get-BackboneCableLabel -ProjectLabel $Model.ProjectLabel -Suffix $suffix -SegmentNumber 1
        }
        else {
            $null
        }

        if ($null -eq (Normalize-Text $cable)) {
            continue
        }

        for ($fiber = 1; $fiber -le 96; $fiber++) {
            $rows += [pscustomobject]@{
                ID            = $id
                LOCATIE       = $Model.ProjectLabel
                CBN           = '101'
                ODF           = $odf
                Traynr        = 1
                PP            = $fiber
                Kabel         = $cable
                Vezelnr       = $fiber
                Connectortype = 'LC/APC'
                ImportResult  = $null
            }
            $id++
        }
    }

    return $rows
}

function Build-TrajectRows {
    param([pscustomobject]$Model)

    $rows = @()
    $id = 1

    foreach ($chain in ($Model.Chains | Sort-Object Suffix)) {
        $previousLocation = $Model.ProjectLabel

        foreach ($segment in $chain.Segments) {
            $rows += [pscustomobject]@{
                ID             = $id
                Label          = '{0}-T{1:00}-S{2:00}' -f $Model.ProjectLabel, [int]$chain.Suffix, [int]$segment.SegmentNumber
                Locatie_A      = $previousLocation
                Locatie_B      = $segment.DpLabel
                Nauwkeurigheid = 0
                ImportResult   = $null
            }

            $previousLocation = $segment.DpLabel
            $id++
        }
    }

    return $rows
}

function Build-AccesspointRows {
    param(
        [pscustomobject]$Model,
        [hashtable]$CoordinatesByLabel
    )

    $rows = @()
    $id = 1

    foreach ($chain in ($Model.Chains | Sort-Object Suffix)) {
        foreach ($segment in $chain.Segments) {
            $coordinates = if ($null -ne $CoordinatesByLabel -and $CoordinatesByLabel.ContainsKey($segment.DpLabel)) { $CoordinatesByLabel[$segment.DpLabel] } else { [pscustomobject]@{ X = 0; Y = 0; Z = 0 } }
            $accesspointZ = if ($segment.AccesspointType -eq 'HH_29030_AT02') { -60 } else { 0 }
            $rows += [pscustomobject]@{
                ID              = $id
                Label           = $segment.DpLabel
                Accesspointtype = $segment.AccesspointType
                X               = $coordinates.X
                Y               = $coordinates.Y
                Z               = $accesspointZ
                Toelichting     = $null
                Nauwkeurigheid  = 0
                ImportResult    = $null
            }
            $id++
        }
    }

    return $rows
}

function Build-SpliceBoxRows {
    param(
        [pscustomobject]$Model,
        [hashtable]$CoordinatesByLabel
    )

    $rows = @()
    $id = 1

    foreach ($chain in ($Model.Chains | Sort-Object Suffix)) {
        foreach ($segment in $chain.Segments) {
            $coordinates = if ($null -ne $CoordinatesByLabel -and $CoordinatesByLabel.ContainsKey($segment.DpLabel)) { $CoordinatesByLabel[$segment.DpLabel] } else { [pscustomobject]@{ X = 0; Y = 0; Z = 0 } }
            $rows += [pscustomobject]@{
                ID             = $id
                Label          = $segment.DpLabel
                SpliceBoxType  = $segment.SpliceBoxType
                Locatie        = $segment.DpLabel
                X              = $coordinates.X
                Y              = $coordinates.Y
                Nauwkeurigheid = 0
                ImportResult   = $null
                Z              = $coordinates.Z
            }
            $id++
        }
    }

    return $rows
}

function Build-KabelRows {
    param([pscustomobject]$Model)

    $rows = @()
    $id = 1

    foreach ($chain in ($Model.Chains | Sort-Object Suffix)) {
        $previousLocation = $Model.ProjectLabel
        $previousTermination = '101'

        foreach ($segment in $chain.Segments) {
            $rows += [pscustomobject]@{
                ID              = $id
                Label           = $segment.IncomingCable
                Kabeltype       = '96V_LTMC_PR02'
                Locatienaam_A   = $previousLocation
                Afwerkeenheid_A = $previousTermination
                PoortA          = $null
                Locatienaam_B   = $segment.DpLabel
                Afwerkeenheid_B = $segment.DpLabel
                PoortB          = $null
                Serienummer     = $null
                ImportResult    = $null
                CATEGORIE       = $null
            }

            $id++
            $previousLocation = $segment.DpLabel
            $previousTermination = $segment.DpLabel
        }
    }

    foreach ($customer in ($Model.Customers | Sort-Object CableId)) {
        $rows += [pscustomobject]@{
            ID              = $id
            Label           = $customer.CableId
            Kabeltype       = Resolve-CustomerCableType -FtuLocation $customer.FtuLocation
            Locatienaam_A   = $customer.DpLabel
            Afwerkeenheid_A = $customer.DpLabel
            PoortA          = $null
            Locatienaam_B   = $customer.DropLocationLabel
            Afwerkeenheid_B = if ($customer.StatusIs2) { (Normalize-UpperStatus $customer.FtuLocation) } else { $null }
            PoortB          = $null
            Serienummer     = $null
            ImportResult    = $null
            CATEGORIE       = $null
        }
        $id++
    }

    return $rows
}

function Build-KlantRows {
    param(
        [pscustomobject]$Model,
        [object[]]$ComplexDefinitions
    )

    $rows = @()
    $id = 1

    foreach ($customer in ($Model.Customers | Sort-Object Fiber, CableId)) {
        $houseNumber = Normalize-Text $customer.HouseNumber
        $houseNumberValue = Try-ParseHouseNumber $houseNumber
        $complexName = Resolve-ComplexName -Street $customer.Street -HouseNumber $customer.HouseNumber -HouseSuffix $customer.HouseSuffix -Definitions $ComplexDefinitions

        $rows += [pscustomobject]@{
            ID               = $id
            Postcode         = $customer.Postcode
            Huisnr           = $houseNumberValue
            Toevoeging       = $customer.HouseSuffix
            Kastnr           = Normalize-UpperStatus $customer.FtuLocation
            FTUType          = if ($customer.StatusIs2) { 'FTU_TK01' } else { $null }
            Kabel            = $customer.CableId
            VEZELNR1         = 1
            Dempingswaarde1A = $customer.Measurement
            Specificatie1A   = $null
            Dempingswaarde1Z = $null
            Specificatie1Z   = $null
            Vezelnr2         = $null
            Dempingswaarde2A = $null
            Specificatie2A   = $null
            Dempingswaarde2Z = $null
            Specificatie2Z   = $null
            X                = 0
            Y                = 0
            ImportResult     = $null
            COMPLEX          = $complexName
            KAMER            = $customer.Room
            ALIASNAAM        = $null
            FTU_SERIENUMMER  = $null
        }
        $id++
    }

    return $rows
}

function Build-ComplexAssignments {
    param(
        [pscustomobject]$Model,
        [object[]]$ComplexDefinitions
    )

    $rows = @()

    foreach ($customer in ($Model.Customers | Sort-Object Fiber, CableId)) {
        $rows += [pscustomobject]@{
            CableId     = $customer.CableId
            Street      = $customer.Street
            HouseNumber = $customer.HouseNumber
            HouseSuffix = $customer.HouseSuffix
            Complex     = Resolve-ComplexName -Street $customer.Street -HouseNumber $customer.HouseNumber -HouseSuffix $customer.HouseSuffix -Definitions $ComplexDefinitions
        }
    }

    return $rows
}

function Build-FcUpdateAssignments {
    param(
        [object[]]$FcRows,
        [object[]]$BcRows = @()
    )

    $bcByCable = @{}
    $bcByAddress = @{}

    foreach ($bcRow in $BcRows) {
        $bcCableKey = Normalize-Key $bcRow.CableId
        if ($null -ne $bcCableKey) {
            $bcByCable[$bcCableKey] = $bcRow
        }

        $bcAddressKey = Get-AddressMatchKey -Postcode $bcRow.Postcode -HouseNumber $bcRow.HouseNumber -HouseSuffix $bcRow.HouseSuffix -Room $bcRow.Room
        if ($null -ne $bcAddressKey -and -not $bcByAddress.ContainsKey($bcAddressKey)) {
            $bcByAddress[$bcAddressKey] = $bcRow
        }
    }

    $rows = @()

    foreach ($fcRow in $FcRows) {
        $fcCableKey = Normalize-Key $fcRow.CableId
        $fcAddressKey = Get-AddressMatchKey -Postcode $fcRow.Postcode -HouseNumber $fcRow.HouseNumber -HouseSuffix $fcRow.HouseSuffix -Room $fcRow.Room
        $bcMatch = $null

        if ($null -ne $fcCableKey -and $bcByCable.ContainsKey($fcCableKey)) {
            $bcMatch = $bcByCable[$fcCableKey]
        }
        elseif ($null -ne $fcAddressKey -and $bcByAddress.ContainsKey($fcAddressKey)) {
            $bcMatch = $bcByAddress[$fcAddressKey]
        }

        $effectiveDeliveryStatus = Normalize-Text $fcRow.DeliveryStatus
        if ($null -ne $bcMatch -and $null -ne (Normalize-Text $bcMatch.DeliveryStatus)) {
            $effectiveDeliveryStatus = Normalize-Text $bcMatch.DeliveryStatus
        }

        $rows += [pscustomobject]@{
            CableId          = $fcRow.CableId
            Postcode         = $fcRow.Postcode
            HouseNumber      = $fcRow.HouseNumber
            HouseSuffix      = $fcRow.HouseSuffix
            Room             = $fcRow.Room
            AddressMatchKey  = $fcAddressKey
            FtuLocation      = Normalize-UpperStatus $fcRow.FtuLocation
            DeliveryStatus   = $effectiveDeliveryStatus
            StatusIs2        = ($effectiveDeliveryStatus -eq '2')
            Powermeter       = $fcRow.Powermeter
            IpFiberValue     = $fcRow.IpFiberValue
            Measurement      = if ($null -ne $fcRow.Powermeter) { $fcRow.Powermeter } else { $fcRow.IpFiberValue }
            DeliveryStatusFc = Normalize-Text $fcRow.DeliveryStatus
            DeliveryStatusBc = if ($null -ne $bcMatch) { Normalize-Text $bcMatch.DeliveryStatus } else { $null }
        }
    }

    return $rows
}

function Build-VergunningRows {
    param(
        [pscustomobject]$Model,
        [pscustomobject]$VergunningInfo
    )

    $name = if ($null -ne $VergunningInfo -and $null -ne (Normalize-Text $VergunningInfo.Name)) { $VergunningInfo.Name } elseif ($null -ne (Normalize-Text $Model.ProjectNumber)) { 'Instemming Gemeente {0}' -f $Model.ProjectNumber } else { 'Instemming Gemeente {0}' -f $Model.ProjectLabel }
    $issuer = if ($null -ne $VergunningInfo) { $VergunningInfo.Issuer } else { $null }
    $grantedDate = if ($null -ne $VergunningInfo) { $VergunningInfo.GrantedDate } else { $null }
    $expiryDate = if ($null -ne $VergunningInfo) { $VergunningInfo.ExpiryDate } else { $null }

    return @(
        [pscustomobject]@{
            ID                  = 1
            NAAM_VERGUNNING     = $name
            Verlenende_Instantie = $issuer
            Datum_verleend      = $grantedDate
            Datum_verlopen      = $expiryDate
            X                   = 0
            Y                   = 0
            ImportResult        = $null
        }
    )
}

function Build-DuctRows {
    param([pscustomobject]$Model)

    $rows = @()
    $id = 1

    foreach ($chain in ($Model.Chains | Sort-Object Suffix)) {
        foreach ($segment in $chain.Segments) {
            $ductLabel = '{0}-B{1:00}-S{2:00}' -f $Model.ProjectLabel, [int]$chain.Suffix, [int]$segment.SegmentNumber
            $trajectLabel = '{0}-T{1:00}-S{2:00}' -f $Model.ProjectLabel, [int]$chain.Suffix, [int]$segment.SegmentNumber

            $rows += [pscustomobject]@{
                ID              = $id
                Duct            = $ductLabel
                DUCTTYPE        = '2MK10-DB_WP01'
                StandA          = 0
                StandB          = 0
                DIAMETERDUCT    = 22
                Traject         = $trajectLabel
                Serienummer     = $null
                SubDuct         = 'RD'
                DiameterSubDuct = 10
                Kabel           = $segment.IncomingCable
                PoortA          = $null
                PoortB          = $null
                ImportResult    = $null
                OPMERKINGEN     = $null
            }
            $id++

            $rows += [pscustomobject]@{
                ID              = $id
                Duct            = $ductLabel
                DUCTTYPE        = '2MK10-DB_WP01'
                StandA          = 0
                StandB          = 0
                DIAMETERDUCT    = 22
                Traject         = $trajectLabel
                Serienummer     = $null
                SubDuct         = 'WT'
                DiameterSubDuct = 10
                Kabel           = $null
                PoortA          = $null
                PoortB          = $null
                ImportResult    = $null
                OPMERKINGEN     = $null
            }
            $id++
        }
    }

    return $rows
}

function New-LasRow {
    param(
        [int]$Id,
        [string]$Location,
        [string]$SpliceBox,
        [AllowNull()][string]$CableA,
        [int]$FiberA,
        [int]$Cassette,
        [int]$Position,
        [string]$CassetteType,
        [string]$Gelast,
        [AllowNull()][string]$CableB,
        [int]$FiberB,
        [AllowNull()][string]$Side
    )

    return [pscustomobject]@{
        ID             = $Id
        LOCATIE        = $Location
        SPLICEBOX      = $SpliceBox
        KabelA         = Normalize-Text $CableA
        VezelnrA       = $FiberA
        Cassette       = $Cassette
        Positienr      = $Position
        CassetteType   = $CassetteType
        Gelast         = $Gelast
        KabelB         = Normalize-Text $CableB
        VezelnrB       = $FiberB
        zijde_fasplaat = Normalize-Text $Side
        ImportResult   = $null
    }
}

function Build-LasRows {
    param([pscustomobject]$Model)

    $rows = @()
    $id = 1

    foreach ($chain in ($Model.Chains | Sort-Object Suffix)) {
        foreach ($segment in $chain.Segments) {
            $customerByFiber = @{}
            foreach ($customer in $segment.Customers) {
                $customerByFiber[[int]$customer.Fiber] = $customer
            }

            if ($null -ne $segment.OutgoingCable) {
                for ($fiber = $segment.SegmentEnd + 1; $fiber -le 96; $fiber++) {
                    $rows += (New-LasRow -Id $id -Location $segment.DpLabel -SpliceBox $segment.DpLabel -CableA $segment.IncomingCable -FiberA $fiber -Cassette 0 -Position 0 -CassetteType 'n.a.' -Gelast 'n' -CableB $segment.OutgoingCable -FiberB $fiber -Side $null)
                    $id++
                }
            }

            $usedParkingCassettes = @{}
            foreach ($customer in $segment.Customers) {
                $parkingOffset = [int]$customer.Fiber - [int]$segment.MinFiber + 1
                $cassette = [math]::Floor(($parkingOffset - 1) / 12) + 1
                $position = (($parkingOffset - 1) % 12) + 1
                $usedParkingCassettes[[int]$cassette] = $true

                $rows += (New-LasRow -Id $id -Location $segment.DpLabel -SpliceBox $segment.DpLabel -CableA $null -FiberA 0 -Cassette $cassette -Position $position -CassetteType $segment.CassetteType -Gelast 'j' -CableB $customer.CableId -FiberB 2 -Side 'V')
                $id++
            }

            for ($cassette = 1; $cassette -le $segment.SegmentCassettes; $cassette++) {
                if (-not $usedParkingCassettes.ContainsKey([int]$cassette)) {
                    $rows += (New-LasRow -Id $id -Location $segment.DpLabel -SpliceBox $segment.DpLabel -CableA $null -FiberA 0 -Cassette $cassette -Position 1 -CassetteType $segment.CassetteType -Gelast 'j' -CableB $null -FiberB 0 -Side 'V')
                    $id++
                }
            }

            $offset = 0
            for ($fiber = $segment.MinFiber; $fiber -le $segment.SegmentEnd; $fiber++) {
                $offset++
                $cassette = $segment.SegmentCassettes + [math]::Floor(($offset - 1) / 12) + 1
                $position = (($offset - 1) % 12) + 1

                if ($customerByFiber.ContainsKey($fiber)) {
                    $customer = $customerByFiber[$fiber]
                    $rows += (New-LasRow -Id $id -Location $segment.DpLabel -SpliceBox $segment.DpLabel -CableA $segment.IncomingCable -FiberA $fiber -Cassette $cassette -Position $position -CassetteType $segment.CassetteType -Gelast 'j' -CableB $customer.CableId -FiberB 1 -Side 'V')
                }
                else {
                    $rows += (New-LasRow -Id $id -Location $segment.DpLabel -SpliceBox $segment.DpLabel -CableA $segment.IncomingCable -FiberA $fiber -Cassette $cassette -Position $position -CassetteType $segment.CassetteType -Gelast 'n' -CableB $null -FiberB 0 -Side 'V')
                }

                $id++
            }

            for ($cassette = (2 * $segment.SegmentCassettes) + 1; $cassette -le 16; $cassette++) {
                $rows += (New-LasRow -Id $id -Location $segment.DpLabel -SpliceBox $segment.DpLabel -CableA $null -FiberA 0 -Cassette $cassette -Position 1 -CassetteType $segment.CassetteType -Gelast 'j' -CableB $null -FiberB 0 -Side 'V')
                $id++
            }
        }
    }

    return $rows
}

function Build-Summary {
    param(
        [pscustomobject]$Model,
        [hashtable]$TableRows
    )

    $summary = [ordered]@{}
    $summary.Project = $Model.ProjectLabel
    $summary.Customers = $Model.Customers.Count
    $summary.Chains = $Model.Chains.Count

    foreach ($entry in $TableRows.GetEnumerator() | Sort-Object Name) {
        $summary[$entry.Name] = $entry.Value.Count
    }

    return [pscustomobject]$summary
}

function Build-ConnectionSyncData {
    param(
        [object[]]$FcRows,
        [object[]]$BcRows,
        [pscustomobject]$Model,
        [hashtable]$TableRows
    )

    return [pscustomobject]@{
        SourceCounts = [pscustomobject]@{
            FcRows    = @($FcRows).Count
            BcRows    = @($BcRows).Count
            Customers = @($Model.Customers).Count
            Chains    = @($Model.Chains).Count
        }
        TableRows = $TableRows
    }
}

function Build-FcRefreshData {
    param(
        [object[]]$FcRows,
        [object[]]$BcRows,
        [pscustomobject]$Model,
        [hashtable]$TableRows
    )

    return [pscustomobject]@{
        SourceCounts = [pscustomobject]@{
            FcRows    = @($FcRows).Count
            BcRows    = @($BcRows).Count
            Customers = @($Model.Customers).Count
            Chains    = @($Model.Chains).Count
        }
        TableRows = [pscustomobject]@{
            Kabel = @($TableRows.Kabel)
            Klant = @($TableRows.Klant)
        }
    }
}

function Build-RiserData {
    param(
        [object[]]$FcRows,
        [object[]]$BcRows,
        [pscustomobject]$Model
    )

    $connections = @()

    foreach ($customer in @($Model.Customers | Sort-Object DpLabel, Postcode, HouseNumber, HouseSuffix, Room, Fiber, CableId)) {
        $connections += [pscustomobject]@{
            CableId           = Normalize-Text $customer.CableId
            DpLabel           = Normalize-Text $customer.DpLabel
            ProjectLabel      = Normalize-Text $customer.ProjectLabel
            Postcode          = Normalize-UpperStatus $customer.Postcode
            HouseNumber       = Normalize-Text $customer.HouseNumber
            HouseSuffix       = Normalize-Text $customer.HouseSuffix
            Room              = Normalize-Text $customer.Room
            AddressLabel      = Normalize-Text $customer.AddressLabel
            DropLocationLabel = Normalize-Text $customer.DropLocationLabel
            FtuLocation       = Normalize-UpperStatus $customer.FtuLocation
            DeliveryStatus    = Normalize-Text $customer.DeliveryStatus
            Fiber             = [int]$customer.Fiber
        }
    }

    return [pscustomobject]@{
        ProjectLabel  = Normalize-Text $Model.ProjectLabel
        ProjectNumber = if ($null -ne (Normalize-Text $Model.ProjectNumber)) { Normalize-Text $Model.ProjectNumber } else { Normalize-Text (($FcRows | Select-Object -First 1).ProjectNumber) }
        DpLabels      = @($connections | ForEach-Object { Normalize-Text $_.DpLabel } | Where-Object { $null -ne $_ } | Sort-Object -Unique)
        Connections   = $connections
    }
}

$resolvedFc = (Resolve-Path -LiteralPath $FcPath).Path

Write-Host "Leyendo FC desde $resolvedFc"
$fcRows = Import-FcRows -Path $resolvedFc

if ($ExportFcUpdatesOnly) {
    if ([string]::IsNullOrWhiteSpace($FcUpdatesOutputPath)) {
        throw 'Falta -FcUpdatesOutputPath para exportar la actualizacion desde FC.'
    }

    $bcRows = @()
    if (-not [string]::IsNullOrWhiteSpace($BcPath) -and (Test-Path -LiteralPath $BcPath)) {
        $resolvedBcForUpdates = (Resolve-Path -LiteralPath $BcPath).Path
        Write-Host "Leyendo BC desde $resolvedBcForUpdates"
        $bcRows = @(Import-BcRows -Path $resolvedBcForUpdates)
    }

    $assignments = @(Build-FcUpdateAssignments -FcRows $fcRows -BcRows $bcRows)
    $assignmentsJson = ConvertTo-Json -InputObject $assignments -Depth 6
    Set-Content -LiteralPath $FcUpdatesOutputPath -Value $assignmentsJson -Encoding UTF8
    Write-Output "Actualizacion de FC exportada en $FcUpdatesOutputPath"
    return
}

$resolvedTemplate = (Resolve-Path -LiteralPath $TemplatePath).Path
$resolvedBc = (Resolve-Path -LiteralPath $BcPath).Path

if ([System.IO.Path]::IsPathRooted($OutputPath)) {
    $resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
}
else {
    $resolvedOutput = [System.IO.Path]::GetFullPath((Join-Path -Path (Get-Location) -ChildPath $OutputPath))
}

$externalMetadata = Get-ExternalMetadata -Path $MetadataPath
$internalDpDecisions = Convert-ExternalInternalDpDecisions -InternalDpDecisions $(if ($null -ne $externalMetadata) { $externalMetadata.internalDpDecisions } else { $null })
$script:BackboneCableNamingConfig = Convert-ExternalBackboneCableNamingConfig -BackboneCableNaming $(if ($null -ne $externalMetadata) { $externalMetadata.backboneCableNaming } else { $null })

Write-Host "Leyendo BC desde $resolvedBc"
$bcRows = Import-BcRows -Path $resolvedBc

Write-Host 'Construyendo modelo del proyecto'
$model = Build-ProjectModel -FcRows $fcRows -BcRows $bcRows -InternalDpDecisions $internalDpDecisions
$ambiguousInternalDps = @(Get-AmbiguousInternalDpCandidates -Model $model -InternalDpDecisions $internalDpDecisions)

if ($AnalyzeOnly) {
    $analysis = [pscustomobject]@{
        ProjectLabel         = $model.ProjectLabel
        ProjectNumber        = $model.ProjectNumber
        AmbiguousInternalDps = $ambiguousInternalDps
    }

    $analysisJson = $analysis | ConvertTo-Json -Depth 8
    if ($null -ne (Normalize-Text $AnalysisOutputPath)) {
        [System.IO.File]::WriteAllText($AnalysisOutputPath, $analysisJson, [System.Text.UTF8Encoding]::new($false))
    }
    else {
        Write-Output $analysisJson
    }

    return
}

$resolvedProjectFolder = $null
if ($null -ne (Normalize-Text $ProjectFolderPath)) {
    $resolvedProjectFolder = (Resolve-Path -LiteralPath $ProjectFolderPath).Path
}
else {
    $candidateProjectFolders = @()

    if ($null -ne (Normalize-Text $model.ProjectNumber)) {
        $candidateProjectFolders += (Join-Path -Path (Get-Location) -ChildPath $model.ProjectNumber)
        $candidateProjectFolders += (Join-Path -Path (Get-Location) -ChildPath ('{0}-{1}' -f $model.ProjectLabel, $model.ProjectNumber))

        if ($model.ProjectNumber -match '^\d+$') {
            $candidateProjectFolders += (Join-Path -Path (Get-Location) -ChildPath ('{0}-B{1}' -f $model.ProjectLabel, $model.ProjectNumber))
        }
    }

    foreach ($candidateProjectFolder in $candidateProjectFolders | Select-Object -Unique) {
        if (Test-Path -LiteralPath $candidateProjectFolder) {
            $resolvedProjectFolder = (Resolve-Path -LiteralPath $candidateProjectFolder).Path
            break
        }
    }

    if ($null -eq $resolvedProjectFolder) {
        $matchedProjectFolder = Get-ChildItem -Path (Get-Location) -Directory |
            Where-Object {
                $_.Name -like ('{0}*' -f $model.ProjectLabel) -and
                (
                    $null -eq (Normalize-Text $model.ProjectNumber) -or
                    $_.Name -like ('*{0}*' -f $model.ProjectNumber)
                )
            } |
            Select-Object -First 1

        if ($null -ne $matchedProjectFolder) {
            $resolvedProjectFolder = $matchedProjectFolder.FullName
        }
    }
}

$complexDefinitions = @(Get-ComplexDefinitions -ProjectFolder $resolvedProjectFolder)

if ($ExportComplexAssignmentsOnly) {
    if ([string]::IsNullOrWhiteSpace($ComplexAssignmentsOutputPath)) {
        throw 'Falta -ComplexAssignmentsOutputPath para exportar los COMPLEX.'
    }

    $assignments = @(Build-ComplexAssignments -Model $model -ComplexDefinitions $complexDefinitions)
    $assignmentsJson = ConvertTo-Json -InputObject $assignments -Depth 6
    Set-Content -LiteralPath $ComplexAssignmentsOutputPath -Value $assignmentsJson -Encoding UTF8
    Write-Output "Asignaciones de COMPLEX exportadas en $ComplexAssignmentsOutputPath"
    return
}
$vergunningInfo = Convert-ExternalVergunningInfo -Vergunning $(if ($null -ne $externalMetadata) { $externalMetadata.vergunning } else { $null })
if ($null -eq $vergunningInfo) {
    $vergunningInfo = Get-VergunningInfo -ProjectFolder $resolvedProjectFolder -ProjectNumber $model.ProjectNumber
}

$dpCoordinates = Convert-ExternalCoordinates -Coordinates $(if ($null -ne $externalMetadata) { $externalMetadata.coordinates } else { $null })
if ($dpCoordinates.Count -eq 0) {
    $dpCoordinates = Get-DwgCoordinateMap -ProjectFolder $resolvedProjectFolder -ProjectNumber $model.ProjectNumber
}

$tableRows = @{
    POP         = @(Build-PopRows -Model $model)
    Vergunning  = @(Build-VergunningRows -Model $model -VergunningInfo $vergunningInfo)
    CBN         = @(Build-CbnRows -Model $model)
    ODF         = @(Build-OdfRows -Model $model)
    AfwerkODF   = @(Build-AfwerkOdfRows -Model $model)
    Traject     = @(Build-TrajectRows -Model $model)
    Duct        = @(Build-DuctRows -Model $model)
    Accesspoint = @(Build-AccesspointRows -Model $model -CoordinatesByLabel $dpCoordinates)
    SpliceBox   = @(Build-SpliceBoxRows -Model $model -CoordinatesByLabel $dpCoordinates)
    Kabel       = @(Build-KabelRows -Model $model)
    Klant       = @(Build-KlantRows -Model $model -ComplexDefinitions $complexDefinitions)
    Las         = @(Build-LasRows -Model $model)
}

if ($ExportConnectionSyncDataOnly) {
    if ([string]::IsNullOrWhiteSpace($ConnectionSyncDataOutputPath)) {
        throw 'Falta -ConnectionSyncDataOutputPath para exportar los datos de ajuste de conexiones.'
    }

    $syncData = Build-ConnectionSyncData -FcRows $fcRows -BcRows $bcRows -Model $model -TableRows $tableRows
    $syncDataJson = ConvertTo-Json -InputObject $syncData -Depth 8
    Set-Content -LiteralPath $ConnectionSyncDataOutputPath -Value $syncDataJson -Encoding UTF8
    Write-Output "Datos de ajuste de conexiones exportados en $ConnectionSyncDataOutputPath"
    return
}

if ($ExportFcRefreshDataOnly) {
    if ([string]::IsNullOrWhiteSpace($FcRefreshDataOutputPath)) {
        throw 'Falta -FcRefreshDataOutputPath para exportar los datos de refresco de FC.'
    }

    $refreshData = Build-FcRefreshData -FcRows $fcRows -BcRows $bcRows -Model $model -TableRows $tableRows
    $refreshDataJson = ConvertTo-Json -InputObject $refreshData -Depth 8
    Set-Content -LiteralPath $FcRefreshDataOutputPath -Value $refreshDataJson -Encoding UTF8
    Write-Output "Datos de refresco de FC exportados en $FcRefreshDataOutputPath"
    return
}

if ($ExportRiserDataOnly) {
    if ([string]::IsNullOrWhiteSpace($RiserDataOutputPath)) {
        throw 'Falta -RiserDataOutputPath para exportar los datos del riser.'
    }

    $riserData = Build-RiserData -FcRows $fcRows -BcRows $bcRows -Model $model
    $riserDataJson = ConvertTo-Json -InputObject $riserData -Depth 8
    Set-Content -LiteralPath $RiserDataOutputPath -Value $riserDataJson -Encoding UTF8
    Write-Output "Datos del riser exportados en $RiserDataOutputPath"
    return
}

Write-Host "Copiando template a $resolvedOutput"
Copy-Item -LiteralPath $resolvedTemplate -Destination $resolvedOutput -Force

$dao = New-Object -ComObject DAO.DBEngine.120
$database = $dao.OpenDatabase($resolvedOutput)

try {
    Clear-AccessTables -Database $database -TableNames @(
        'Las',
        'Klant',
        'Kabel',
        'Duct',
        'Traject',
        'SpliceBox',
        'Accesspoint',
        'AfwerkODF',
        'ODF',
        'CBN',
        'Vergunning',
        'POP'
    )

    foreach ($tableName in @('POP', 'Vergunning', 'CBN', 'ODF', 'AfwerkODF', 'Traject', 'Duct', 'Accesspoint', 'SpliceBox', 'Kabel', 'Klant', 'Las')) {
        Write-Host "Escribiendo $tableName ($($tableRows[$tableName].Count) filas)"
        Write-AccessTable -Database $database -TableName $tableName -Rows $tableRows[$tableName]
    }
}
finally {
    $database.Close()
}

$summary = Build-Summary -Model $model -TableRows $tableRows
Write-Host ''
Write-Host 'Resumen generado:'
$summary | Format-Table -AutoSize
