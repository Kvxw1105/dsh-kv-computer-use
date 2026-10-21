param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [Parameter(Mandatory = $true)][string]$OutPath,
    [string]$Language = ''
)

# WinRT OCR reader. Writes a UTF-8 JSON document to $OutPath so the caller never
# depends on console code pages.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
[void][Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

if ($Language -ne '') {
    $lang = [Windows.Globalization.Language]::new($Language)
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    if ($null -eq $engine) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
}
else {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}

if ($null -eq $engine) {
    $payload = @{ available = $false; reason = 'no OCR language pack installed' }
    $payload | ConvertTo-Json -Depth 6 -Compress | Out-File -FilePath $OutPath -Encoding UTF8
    exit 0
}

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$lines = @()
foreach ($line in $result.Lines) {
    $words = @()
    foreach ($word in $line.Words) {
        $words += @{ text = $word.Text; x = [math]::Round($word.BoundingRect.X); y = [math]::Round($word.BoundingRect.Y); w = [math]::Round($word.BoundingRect.Width); h = [math]::Round($word.BoundingRect.Height) }
    }
    $first = $line.Words | Select-Object -First 1
    $lines += @{
        text  = $line.Text
        x     = if ($first) { [math]::Round($first.BoundingRect.X) } else { 0 }
        y     = if ($first) { [math]::Round($first.BoundingRect.Y) } else { 0 }
        words = $words
    }
}

$payload = @{
    available      = $true
    engineLanguage = $engine.RecognizerLanguage.LanguageTag
    lineCount      = $lines.Count
    lines          = $lines
}

$payload | ConvertTo-Json -Depth 8 -Compress | Out-File -FilePath $OutPath -Encoding UTF8
