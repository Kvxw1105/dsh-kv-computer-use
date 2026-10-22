param(
    [Parameter(Mandatory = $true)][string]$WindowHandle,
    [Parameter(Mandatory = $true)][string]$RuntimeId,
    [int]$MaxChars = 2000,
    [Parameter(Mandatory = $true)][string]$OutPath
)

# Read text out of a control through the UIA TextPattern.
#
# TextPattern is read-only, which makes it useless for writing but ideal for
# reading: it works on controls that expose neither ValuePattern nor a readable
# value field (WinForms TextBox, rich text surfaces, Electron documents).
#
# Fallback order: TextPattern -> ValuePattern -> WM_GETTEXT.
# Writes a UTF-8 JSON result to $OutPath.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$signature = @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, System.Text.StringBuilder lParam);
[DllImport("user32.dll")]
public static extern bool IsWindow(IntPtr hWnd);
'@

$Native = Add-Type -MemberDefinition $signature -Name KvCuReadText -Namespace KvCu -PassThru
$WM_GETTEXT = 0x000D

function Write-Result($payload) {
    $payload | ConvertTo-Json -Depth 6 -Compress | Out-File -FilePath $OutPath -Encoding UTF8
}

try {
    $handle = [IntPtr][int64]$WindowHandle
    if (-not $Native::IsWindow($handle)) {
        Write-Result @{ ok = $false; error = 'WINDOW_NOT_FOUND'; message = "window $WindowHandle does not exist" }
        exit 0
    }

    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    if ($null -eq $root) {
        Write-Result @{ ok = $false; error = 'WINDOW_NOT_FOUND'; message = "no automation element for window $WindowHandle" }
        exit 0
    }

    $want = $RuntimeId.Trim()
    if ($want.StartsWith('uia:')) { $want = $want.Substring(4) }

    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($root)
    $target = $null
    $visited = 0

    while ($queue.Count -gt 0 -and $null -eq $target -and $visited -lt 4000) {
        $element = $queue.Dequeue()
        $visited += 1
        $rid = $element.GetRuntimeId()
        if ($null -ne $rid -and $rid.Length -gt 0) {
            if (($rid -join '.') -eq $want) { $target = $element; break }
        }
        $child = $walker.GetFirstChild($element)
        while ($null -ne $child) {
            $queue.Enqueue($child)
            $child = $walker.GetNextSibling($child)
        }
    }

    if ($null -eq $target) {
        Write-Result @{ ok = $false; error = 'ELEMENT_NOT_FOUND'; message = "runtime id $want not found"; visited = $visited }
        exit 0
    }

    $text = $null
    $method = $null

    # Each rung only wins if it actually produced text. A pattern that answers with
    # an empty string must NOT stop the ladder: WPF TextBox exposes TextPattern but
    # DocumentRange.GetText() returns "" there, which would hide the real contents
    # that WM_GETTEXT can still read.
    # 1) TextPattern: the richest source for document-like controls.
    try {
        $pattern = $null
        if ($target.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
            $candidate = $pattern.DocumentRange.GetText($MaxChars)
            if (-not [string]::IsNullOrEmpty($candidate)) {
                $text = $candidate
                $method = 'TextPattern'
            }
        }
    } catch { }

    # 2) ValuePattern: form fields.
    if ([string]::IsNullOrEmpty($text)) {
        try {
            $pattern = $null
            if ($target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
                $candidate = $pattern.Current.Value
                if (-not [string]::IsNullOrEmpty($candidate)) {
                    $text = $candidate
                    $method = 'ValuePattern'
                }
            }
        } catch { }
    }

    # 3) WM_GETTEXT: last resort through the native handle.
    if ([string]::IsNullOrEmpty($text)) {
        $nativeHandle = $target.Current.NativeWindowHandle
        if ($nativeHandle -ne 0) {
            $box = New-Object System.Text.StringBuilder ($MaxChars + 16)
            [void]$Native::SendMessage([IntPtr]$nativeHandle, $WM_GETTEXT, [IntPtr]$box.Capacity, $box)
            $text = $box.ToString()
            $method = 'WM_GETTEXT'
        }
    }

    if ($null -eq $text) {
        Write-Result @{ ok = $false; error = 'NO_TEXT_SOURCE'; message = 'control exposes no TextPattern, ValuePattern or native handle'; visited = $visited }
        exit 0
    }

    if ($text.Length -gt $MaxChars) { $text = $text.Substring(0, $MaxChars) }

    Write-Result @{
        ok       = $true
        method   = $method
        text     = $text
        length   = $text.Length
        truncated = ($text.Length -ge $MaxChars)
        controlType = $target.Current.ControlType.ProgrammaticName
        automationId = $target.Current.AutomationId
        name     = $target.Current.Name
        visited  = $visited
    }
}
catch {
    Write-Result @{ ok = $false; error = 'READ_FAILED'; message = $_.Exception.Message }
}
