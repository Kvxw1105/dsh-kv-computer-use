param(
    [Parameter(Mandatory = $true)][string]$StatePath,
    [int]$Thickness = 6,
    [string]$Color = '255,140,40'
)

# System-wide activity glow.
#
# A border-only overlay spanning every monitor, shown while the plug-in is driving
# the desktop. It must never interfere with what it is reporting on:
#   WS_EX_TRANSPARENT  clicks pass straight through to the window underneath
#   WS_EX_NOACTIVATE   it never takes focus
#   WS_EX_TOOLWINDOW   it stays out of Alt+Tab and the taskbar
#   ShowWithoutActivation leaves the host window's activation untouched
#
# The window class is written in C# because PowerShell classes cannot override
# CreateParams or ShowWithoutActivation; the script only instantiates it and pumps
# a timer. Visibility follows a state file so showing costs a write, not a process.

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public sealed class KvGlowForm : Form
{
    private readonly Pen borderPen;
    private readonly string statePath;

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    public KvGlowForm(Pen pen, string statePath)
    {
        this.borderPen = pen;
        this.statePath = statePath;

        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        ShowInTaskbar = false;
        BackColor = Color.Black;
        TransparencyKey = Color.Black;
        DoubleBuffered = true;
        Opacity = 0.9;
        Text = "KV CU Activity Glow";

        Bounds = new Rectangle(
            GetSystemMetrics(76), GetSystemMetrics(77),
            GetSystemMetrics(78), GetSystemMetrics(79));
    }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= 0x00000020; // WS_EX_TRANSPARENT  - click through
            cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE   - never take focus
            cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW   - out of Alt+Tab
            return cp;
        }
    }

    protected override bool ShowWithoutActivation
    {
        get { return true; }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        int w = ClientSize.Width;
        int h = ClientSize.Height;
        int t = Math.Max(2, (int)(borderPen.Width / 2));
        e.Graphics.DrawRectangle(borderPen, t, t, w - (t * 2), h - (t * 2));
    }

    public void Tick()
    {
        bool fresh = false;
        try
        {
            if (File.Exists(statePath))
            {
                string raw = File.ReadAllText(statePath).Trim();
                long stamp;
                if (long.TryParse(raw, out stamp))
                {
                    long age = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - stamp;
                    fresh = age >= 0 && age < 2500;
                }
            }
        }
        catch
        {
            // a torn read just means "not fresh this tick"
        }

        if (fresh && !Visible) Show();
        else if (!fresh && Visible) Hide();

        if (Visible)
        {
            double phase = (DateTime.UtcNow.Millisecond / 900.0) * Math.PI;
            Opacity = 0.55 + (0.35 * Math.Abs(Math.Sin(phase)));
            Invalidate();
        }
    }
}
'@

Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms, System.Drawing -Language CSharp

$rgb = $Color.Split(',') | ForEach-Object { [int]$_.Trim() }
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, $rgb[0], $rgb[1], $rgb[2])), $Thickness

[System.Windows.Forms.Application]::EnableVisualStyles()
$form = [KvGlowForm]::new($pen, $StatePath)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 120
$timer.Add_Tick({ $form.Tick() })
$timer.Start()

# Diagnostic breadcrumb: proves the window was created even if a later probe cannot
# find it by title (a borderless transparent form can report an empty caption).
$diag = "$StatePath.diag"
try {
    $form.CreateControl()
    "created handle=$($form.Handle) title='$($form.Text)' bounds=$($form.Bounds)" |
        Out-File -FilePath $diag -Encoding utf8
} catch {
    "create failed: $($_.Exception.Message)" | Out-File -FilePath $diag -Encoding utf8
}

[System.Windows.Forms.Application]::Run($form)
