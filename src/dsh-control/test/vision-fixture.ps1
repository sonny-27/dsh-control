param([string]$StatePath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class DshVisionFixtureWindow{[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window,int command);}'
$form=New-Object System.Windows.Forms.Form
$form.Text='DSH Vision Test Fixture'
$form.StartPosition='Manual'
$form.Location=New-Object System.Drawing.Point(120,180)
$form.ClientSize=New-Object System.Drawing.Size(600,360)
$form.BackColor=[Drawing.Color]::White
$form.TopMost=$true
$target=New-Object System.Windows.Forms.Panel
$target.Location=New-Object System.Drawing.Point(160,110)
$target.Size=New-Object System.Drawing.Size(120,70)
$target.BackColor=[Drawing.Color]::Red
$form.Controls.Add($target)
$form.add_Shown({[void][DshVisionFixtureWindow]::ShowWindow($form.Handle,4);[IO.File]::WriteAllText($StatePath,(@{windowId=$form.Handle.ToInt64()}|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))})
[System.Windows.Forms.Application]::Run($form)
$form.Dispose()
