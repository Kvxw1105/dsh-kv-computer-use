param(
    [Parameter(Mandatory = $true)][string]$DllPath
)

# Resident input worker.
#
# One PowerShell process stays alive and loads the compiled input helper once, so
# each keystroke batch costs a round-trip instead of a process start (~1.4s).
# Protocol: one JSON request per stdin line, one JSON reply per stdout line.
#   {"id":"1","op":"type","text":"..."}      -> {"id":"1","ok":true,"result":3}
#   {"id":"2","op":"key","vk":17}            -> {"id":"2","ok":true,"result":2}
#   {"id":"3","op":"click","x":10,"y":20}    -> {"id":"3","ok":true,"result":true}
#   {"id":"4","op":"scroll","notches":-3}    -> {"id":"4","ok":true,"result":1}
#   {"id":"5","op":"fg"}                     -> {"id":"5","ok":true,"result":8460476}
#   {"id":"6","op":"quit"}                   -> exits
#
# Requests may carry "textB64" (base64 of a UTF-16LE string) instead of "text" so
# Chinese survives any console code page.

$ErrorActionPreference = 'Stop'

$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$stdout = [Console]::Out

function Reply($payload) {
    $stdout.WriteLine(($payload | ConvertTo-Json -Depth 5 -Compress))
    $stdout.Flush()
}

try {
    Add-Type -Path $DllPath
}
catch {
    Reply @{ id = 'init'; ok = $false; error = "helper load failed: $($_.Exception.Message)" }
    exit 1
}

Reply @{ id = 'ready'; ok = $true; result = 'input-daemon' }

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq '') { continue }

    $id = '?'
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        switch ($req.op) {
            'type' {
                $text = if ($req.textB64) { [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($req.textB64)) } else { [string]$req.text }
                Reply @{ id = $id; ok = $true; result = [KvCuInput]::TypeText($text) }
            }
            'key' {
                Reply @{ id = $id; ok = $true; result = [KvCuInput]::PressVirtualKey([int]$req.vk) }
            }
            'keydown' {
                Reply @{ id = $id; ok = $true; result = [KvCuInput]::KeyDown([int]$req.vk) }
            }
            'keyup' {
                Reply @{ id = $id; ok = $true; result = [KvCuInput]::KeyUp([int]$req.vk) }
            }
            'click' {
                $button = if ($req.button) { [string]$req.button } else { 'left' }
                Reply @{ id = $id; ok = $true; result = [KvCuInput]::ClickPoint([int]$req.x, [int]$req.y, $button) }
            }
            'scroll' {
                $horizontal = [bool]$req.horizontal
                Reply @{ id = $id; ok = $true; result = [KvCuInput]::Scroll([int]$req.notches, $horizontal) }
            }
            'fg' {
                Reply @{ id = $id; ok = $true; result = [KvCuInput]::ForegroundHandle() }
            }
            'ping' {
                Reply @{ id = $id; ok = $true; result = 'pong' }
            }
            'quit' {
                Reply @{ id = $id; ok = $true; result = 'bye' }
                exit 0
            }
            default {
                Reply @{ id = $id; ok = $false; error = "unknown op '$($req.op)'" }
            }
        }
    }
    catch {
        Reply @{ id = $id; ok = $false; error = $_.Exception.Message }
    }
}
