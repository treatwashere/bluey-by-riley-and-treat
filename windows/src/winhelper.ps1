# Bluey's Windows helper. One long-lived Windows PowerShell process that answers JSON requests on stdin:
#   ocr       read every line and word in a screenshot (Windows.Media.Ocr, built into Windows 10/11)
#   controls  clickable controls of the front window (UI Automation), like the Mac's Accessibility reader
#   focus     the focused field: its box, and whether it's a password field (never typed into)
#   front     the front app and window title
#   openapp   open an app by name from the Start menu (or switch to it if it's already running)
# Written for Windows PowerShell 5.1 (C# 5 in Add-Type). Never prints anything except one JSON line per request.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class BlueyWin {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    public static string Title(IntPtr h) { StringBuilder sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
    public static uint Pid(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
}
"@

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($operation, [Type] $type) {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($operation))
    $null = $task.Wait(-1)
    return $task.Result
}
$ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()

function Read-Text([string] $path) {
    if ($null -eq $ocrEngine) { throw 'Windows OCR is not available (add a language with text recognition in Settings).' }
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $result = Await ($ocrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    } finally { $stream.Dispose() }
    $lines = @()
    foreach ($line in $result.Lines) {
        $words = @()
        foreach ($word in $line.Words) {
            $r = $word.BoundingRect
            $words += @{ text = $word.Text; x = $r.X; y = $r.Y; w = $r.Width; h = $r.Height }
        }
        $lines += @{ text = $line.Text; words = $words }
    }
    return @{ width = $bitmap.PixelWidth; height = $bitmap.PixelHeight; lines = $lines }
}

$A = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$kinds = @{}
$kinds[$CT::Button.Id] = 'button'; $kinds[$CT::SplitButton.Id] = 'menu button'; $kinds[$CT::CheckBox.Id] = 'checkbox'
$kinds[$CT::RadioButton.Id] = 'radio button'; $kinds[$CT::ComboBox.Id] = 'pop-up'; $kinds[$CT::Edit.Id] = 'text field'
$kinds[$CT::Hyperlink.Id] = 'link'; $kinds[$CT::MenuItem.Id] = 'menu item'; $kinds[$CT::TabItem.Id] = 'tab'
$kinds[$CT::ListItem.Id] = 'list item'; $kinds[$CT::TreeItem.Id] = 'row'; $kinds[$CT::Slider.Id] = 'slider'
$kinds[$CT::Document.Id] = 'text area'

function Rect($element) {
    $r = $element.Current.BoundingRectangle
    if ($r.IsEmpty -or [double]::IsInfinity($r.X)) { return $null }
    return @{ x = $r.X; y = $r.Y; w = $r.Width; h = $r.Height }
}

function Read-Controls {
    $handle = [BlueyWin]::GetForegroundWindow()
    $found = @()
    if ($handle -eq [IntPtr]::Zero) { return @{ controls = $found } }
    $root = $A::FromHandle($handle)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $stack = New-Object System.Collections.Stack
    $stack.Push(@($root, 0))
    while ($stack.Count -gt 0 -and $found.Count -lt 150 -and $clock.ElapsedMilliseconds -lt 1800) {
        $item = $stack.Pop(); $element = $item[0]; $depth = $item[1]
        try {
            $current = $element.Current
            $kind = $kinds[$current.ControlType.Id]
            if ($kind -and -not $current.IsOffscreen) {
                $rect = Rect $element
                $label = $current.Name
                if (-not $label -and $kind -eq 'text field') { $label = $current.HelpText }
                if ($rect -and $rect.w -gt 3 -and $rect.h -gt 3 -and ($label -or $kind -eq 'text field')) {
                    $found += @{ kind = $kind; label = [string]$label; x = $rect.x; y = $rect.y; w = $rect.w; h = $rect.h }
                }
            }
            if ($depth -lt 40) {
                $children = @()
                $child = $walker.GetFirstChild($element)
                while ($null -ne $child -and $children.Count -lt 200) { $children += $child; $child = $walker.GetNextSibling($child) }
                for ($i = $children.Count - 1; $i -ge 0; $i--) { $stack.Push(@($children[$i], $depth + 1)) }
            }
        } catch { }
    }
    return @{ controls = $found }
}

function Read-Focus {
    try {
        $element = $A::FocusedElement
        if ($null -eq $element) { return @{ secure = $false } }
        return @{ secure = [bool]$element.Current.IsPassword; rect = (Rect $element); kind = $element.Current.ControlType.ProgrammaticName }
    } catch { return @{ secure = $false } }
}

function Read-Front {
    $handle = [BlueyWin]::GetForegroundWindow()
    $name = ''
    try { $name = (Get-Process -Id ([BlueyWin]::Pid($handle))).ProcessName } catch { }
    return @{ app = $name; title = [BlueyWin]::Title($handle) }
}

function Open-App([string] $wanted) {
    $wanted = $wanted.Trim()
    $key = $wanted.ToLowerInvariant() -replace '\.exe$', ''
    # Already running with a window: switch to it.
    $running = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName.ToLowerInvariant() -eq $key -or $_.MainWindowTitle.ToLowerInvariant() -eq $key) } | Select-Object -First 1
    if ($running) {
        $shell = New-Object -ComObject WScript.Shell
        $null = $shell.AppActivate($running.Id)
        return @{ text = "Switched to $($running.ProcessName)." }
    }
    $apps = Get-StartApps
    $match = $apps | Where-Object { $_.Name.ToLowerInvariant() -eq $key } | Select-Object -First 1
    if (-not $match) { $match = $apps | Where-Object { $_.Name.ToLowerInvariant().StartsWith($key) } | Sort-Object { $_.Name.Length } | Select-Object -First 1 }
    if (-not $match) { $match = $apps | Where-Object { $_.Name.ToLowerInvariant().Contains($key) } | Sort-Object { $_.Name.Length } | Select-Object -First 1 }
    if (-not $match) { return @{ text = "I couldn't find an app called $wanted." } }
    Start-Process ("shell:AppsFolder\" + $match.AppID)
    return @{ text = "Opened $($match.Name)." }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
    $request = $null
    try {
        $request = $line | ConvertFrom-Json
        switch ($request.cmd) {
            'ocr' { $result = Read-Text $request.path }
            'controls' { $result = Read-Controls }
            'focus' { $result = Read-Focus }
            'front' { $result = Read-Front }
            'openapp' { $result = Open-App $request.name }
            'ping' { $result = @{ pong = $true } }
            default { throw "unknown command $($request.cmd)" }
        }
        $result['id'] = $request.id; $result['ok'] = $true
    } catch {
        $result = @{ id = $(if ($request) { $request.id } else { 0 }); ok = $false; error = $_.Exception.Message }
    }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 8))
    [Console]::Out.Flush()
}
