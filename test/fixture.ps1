# Isolated UIA fixture window for live tests.
# Creates a WinForms form with one multiline TextBox named kvTarget and writes its
# own PID to the given path so the test can address exactly this process.
param(
    [Parameter(Mandatory = $true)][string]$PidPath
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'KV CU Test Surface'
$form.Width = 560
$form.Height = 320
$form.StartPosition = 'CenterScreen'

$box = New-Object System.Windows.Forms.TextBox
$box.Name = 'kvTarget'
$box.Multiline = $true
$box.AcceptsReturn = $true
$box.ScrollBars = 'Vertical'
$box.Dock = [System.Windows.Forms.DockStyle]::Fill
$box.Text = ''
$form.Controls.Add($box)

$form.Add_Shown({
        $box.Focus()
        Set-Content -Path $PidPath -Value $PID -Encoding ASCII
    })

[void]$form.ShowDialog()
