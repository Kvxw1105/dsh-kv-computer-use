# Isolated UIA fixture window (WPF) for live tests.
#
# WPF TextBox exposes the UIA Value pattern, unlike a WinForms TextBox which only
# offers TextPattern. This gives the driver a genuinely writable target.
# Writes its own PID to the given path so the test can address exactly this process.
param(
    [Parameter(Mandatory = $true)][string]$PidPath,
    [string]$KeyLog = ''
)

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="KV CU Test Surface" Height="320" Width="560"
        WindowStartupLocation="CenterScreen">
  <Grid Margin="8">
    <TextBox x:Name="kvTarget" AutomationProperties.Name="kvTarget"
             AcceptsReturn="True" TextWrapping="Wrap"
             VerticalScrollBarVisibility="Auto" />
  </Grid>
</Window>
'@

$reader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($xaml))
$window = [System.Windows.Markup.XamlReader]::Load($reader)

$box = $window.FindName('kvTarget')

# Probe: record every key that actually reaches the control, so a test can tell
# "keystroke never delivered" apart from "delivered but the TextBox ignored it".
if ($KeyLog -ne '') {
    $box.Add_KeyDown({
            param($sender, $args)
            $line = "$($args.Key)|$([int]$args.Key)|$($box.Text.Length)"
            Add-Content -Path $KeyLog -Value $line -Encoding UTF8
        })
    $box.Add_TextChanged({
            Add-Content -Path $KeyLog -Value "TEXT:$($box.Text)" -Encoding UTF8
        })
}

$window.Add_ContentRendered({
        $window.Activate() | Out-Null
        $box.Focus() | Out-Null
        Set-Content -Path $PidPath -Value $PID -Encoding ASCII
    })

[void]$window.ShowDialog()
