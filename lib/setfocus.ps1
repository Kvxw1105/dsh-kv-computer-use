param(
    [Parameter(Mandatory = $true)][string]$WindowHandle,
    [Parameter(Mandatory = $true)][string]$RuntimeId,
    [Parameter(Mandatory = $true)][string]$OutPath
)

# Give keyboard focus to one specific UIA element.
#
# Typing via SendInput is delivered to whatever control currently owns keyboard
# focus, not to "the window". Without this step a type action can land on the wrong
# control inside the right window. This runs before the keystrokes so the target is
# the element the model actually addressed.
#
# Writes a UTF-8 JSON result to $OutPath.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Write-Result($payload) {
    $payload | ConvertTo-Json -Depth 5 -Compress | Out-File -FilePath $OutPath -Encoding UTF8
}

try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$WindowHandle)
    if ($null -eq $root) {
        Write-Result @{ ok = $false; error = 'WINDOW_NOT_FOUND'; message = "no element for window $WindowHandle" }
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
        if ($null -ne $rid -and $rid.Length -gt 0 -and ($rid -join '.') -eq $want) {
            $target = $element
            break
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

    if (-not $target.Current.IsKeyboardFocusable) {
        Write-Result @{ ok = $false; error = 'NOT_FOCUSABLE'; message = 'element cannot take keyboard focus'; visited = $visited }
        exit 0
    }

    $target.SetFocus()
    Start-Sleep -Milliseconds 60

    # Confirm by asking UIA who owns focus now.
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    $focusedId = $null
    $focusedType = $null
    if ($null -ne $focused) {
        $focusedId = ($focused.GetRuntimeId() -join '.')
        $focusedType = $focused.Current.ControlType.ProgrammaticName
    }

    Write-Result @{
        ok           = $true
        focused      = ($focusedId -eq $want)
        focusedId    = $focusedId
        focusedType  = $focusedType
        targetType   = $target.Current.ControlType.ProgrammaticName
        visited      = $visited
    }
}
catch {
    Write-Result @{ ok = $false; error = 'FOCUS_FAILED'; message = $_.Exception.Message }
}
