param(
    [Parameter(Mandatory = $true)][string]$WindowHandle,
    [Parameter(Mandatory = $true)][string]$RuntimeId,
    [string]$Value = '',
    [Parameter(Mandatory = $true)][string]$OutPath
)

# Background text write for controls that expose no UIA ValuePattern
# (WinForms TextBox, some Electron/Chromium inputs).
#
# Strategy: locate the element by UIA runtime id, take its native window handle and
# post WM_SETTEXT directly to it. No focus change, no keystrokes, no clipboard.
#
# Writes a UTF-8 JSON result to $OutPath.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$signature = @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam);
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, System.Text.StringBuilder lParam);
[DllImport("user32.dll")]
public static extern bool IsWindow(IntPtr hWnd);
[DllImport("user32.dll")]
public static extern bool InvalidateRect(IntPtr hWnd, IntPtr lpRect, bool bErase);
[DllImport("user32.dll")]
public static extern bool UpdateWindow(IntPtr hWnd);
[DllImport("user32.dll")]
public static extern bool RedrawWindow(IntPtr hWnd, IntPtr lprcUpdate, IntPtr hrgnUpdate, uint flags);
'@

$Native = Add-Type -MemberDefinition $signature -Name KvCuSetText -Namespace KvCu -PassThru

$WM_SETTEXT = 0x000C
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
            $ridText = ($rid -join '.')
            if ($ridText -eq $want) { $target = $element; break }
        }
        $child = $walker.GetFirstChild($element)
        while ($null -ne $child) {
            $queue.Enqueue($child)
            $child = $walker.GetNextSibling($child)
        }
    }

    if ($null -eq $target) {
        Write-Result @{ ok = $false; error = 'ELEMENT_NOT_FOUND'; message = "runtime id $want not found in window $WindowHandle"; visited = $visited }
        exit 0
    }

    $nativeHandle = $target.Current.NativeWindowHandle
    if ($nativeHandle -eq 0) {
        Write-Result @{ ok = $false; error = 'NO_NATIVE_HANDLE'; message = 'element has no native window handle; WM_SETTEXT cannot be used (try type with focus instead)'; visited = $visited }
        exit 0
    }

    $previous = $target.Current.Name
    [void]$Native::SendMessage([IntPtr]$nativeHandle, $WM_SETTEXT, [IntPtr]::Zero, $Value)

    # WM_SETTEXT updates control state but WinForms does not repaint on its own
    # schedule; without an explicit redraw the new text stays invisible on screen
    # even though WM_GETTEXT already returns it.
    $RDW_INVALIDATE = 0x0001
    $RDW_UPDATENOW = 0x0100
    $RDW_ALLCHILDREN = 0x0080
    [void]$Native::InvalidateRect([IntPtr]$nativeHandle, [IntPtr]::Zero, $true)
    [void]$Native::UpdateWindow([IntPtr]$nativeHandle)
    [void]$Native::RedrawWindow([IntPtr]$nativeHandle, [IntPtr]::Zero, [IntPtr]::Zero, ($RDW_INVALIDATE -bor $RDW_UPDATENOW -bor $RDW_ALLCHILDREN))

    # Read back through UIA to prove the write landed.
    $readBack = $null
    try {
        $pattern = $null
        if ($target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
            $readBack = $pattern.Current.Value
        }
    } catch { }

    if ($null -eq $readBack) {
        try {
            $box = New-Object System.Text.StringBuilder 4096
            [void]$Native::SendMessage([IntPtr]$nativeHandle, $WM_GETTEXT, [IntPtr]$box.Capacity, $box)
            $readBack = $box.ToString()
        } catch { }
    }

    Write-Result @{
        ok          = $true
        method      = 'WM_SETTEXT'
        nativeHandle = $nativeHandle
        valueSet    = ($readBack -eq $Value)
        readBack    = $readBack
        previousName = $previous
        visited     = $visited
    }
}
catch {
    Write-Result @{ ok = $false; error = 'SETTEXT_FAILED'; message = $_.Exception.Message }
}
