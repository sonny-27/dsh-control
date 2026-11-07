param([string]$StatePath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing,UIAutomationClient,UIAutomationTypes
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Threading; using System.Windows.Forms;
public class FixtureFilter : IMessageFilter {
    public static int Wheel; public static long WheelTarget;
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,System.Text.StringBuilder b,int n);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint f);
    public static string TargetClass() { var b=new System.Text.StringBuilder(256); GetClassName(new IntPtr(WheelTarget),b,256); return b.ToString()+" root="+GetAncestor(new IntPtr(WheelTarget),2).ToInt64(); }
    public bool PreFilterMessage(ref Message m) { if(m.Msg==0x20A) { Wheel += (short)(m.WParam.ToInt64()>>16); WheelTarget=m.HWnd.ToInt64(); } return false; }
}
public static class FixtureKeys {
    [DllImport("user32.dll")] static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint message, IntPtr w, IntPtr l);
    public static int FirstLine(IntPtr h) { return SendMessage(h,0xCE,IntPtr.Zero,IntPtr.Zero).ToInt32(); }
    public static void ClickButton(IntPtr h) { SendMessage(h,0xF5,IntPtr.Zero,IntPtr.Zero); }
    public static void ClickAt(int x,int y) { SetCursorPos(x,y);mouse_event(2,0,0,0,UIntPtr.Zero);Thread.Sleep(60);mouse_event(4,0,0,0,UIntPtr.Zero); }
    public static void Escape() { keybd_event(27,0,0,UIntPtr.Zero); Thread.Sleep(200); keybd_event(27,0,2,UIntPtr.Zero); }
}
'@ -ReferencedAssemblies System.Windows.Forms
[System.Windows.Forms.Application]::AddMessageFilter((New-Object FixtureFilter))
$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH Control Test Fixture'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(180,220)
$form.Size = New-Object System.Drawing.Size(700,450)
$form.AccessibleName = 'DSH Control Test Fixture'
$inputBox = New-Object System.Windows.Forms.TextBox
$inputBox.Location = New-Object System.Drawing.Point(30,45)
$inputBox.Size = New-Object System.Drawing.Size(350,28)
$inputBox.AccessibleName = 'Fixture input'
$secondInput = New-Object System.Windows.Forms.TextBox
$secondInput.Location = New-Object System.Drawing.Point(400,45)
$secondInput.Size = New-Object System.Drawing.Size(220,28)
$secondInput.AccessibleName = 'Fixture second input'
$checkOne = New-Object System.Windows.Forms.CheckBox
$checkOne.Text = 'Fixture option one'
$checkOne.AccessibleName = 'Fixture option one'
$checkOne.Location = New-Object System.Drawing.Point(210,325)
$checkOne.Size = New-Object System.Drawing.Size(180,28)
$checkTwo = New-Object System.Windows.Forms.CheckBox
$checkTwo.Text = 'Fixture option two'
$checkTwo.AccessibleName = 'Fixture option two'
$checkTwo.Location = New-Object System.Drawing.Point(400,325)
$checkTwo.Size = New-Object System.Drawing.Size(180,28)
$script:lastKey = ''
$inputBox.add_KeyDown({ param($sender,$event) $script:lastKey = "$($event.KeyCode):$($event.Control)"; if ($event.Control -and $event.KeyCode -eq 'A') { $sender.SelectAll(); $event.SuppressKeyPress = $true } })
$button = New-Object System.Windows.Forms.Button
$button.Text = 'Fixture button'
$button.AccessibleName = 'Fixture button'
$button.Location = New-Object System.Drawing.Point(30,100)
$button.Size = New-Object System.Drawing.Size(160,45)
$label = New-Object System.Windows.Forms.Label
$label.Location = New-Object System.Drawing.Point(30,165)
$label.Size = New-Object System.Drawing.Size(220,50)
$label.Text = 'Clicks: 0'
$script:count = 0
$script:moveOnClick=$false
$button.add_Click({ $script:count++; $label.Text = "Clicks: $script:count";if($script:moveOnClick){$secondInput.Left+=25;$script:moveOnClick=$false} })
$script:drags=0
$script:strokeCount=0
$script:strokeTrace=New-Object System.Collections.ArrayList
$dragPanel=New-Object System.Windows.Forms.Panel
$dragPanel.Location=New-Object System.Drawing.Point(30,230)
$dragPanel.Size=New-Object System.Drawing.Size(140,80)
$dragPanel.BackColor=[System.Drawing.Color]::RoyalBlue
$dragPanel.AccessibleName='Fixture drag'
$dragPanel.add_MouseDown({param($sender,$event) $sender.Capture=$true;$script:strokeCount++;[void]$script:strokeTrace.Add(@{stroke=$script:strokeCount;x=$event.X;y=$event.Y;kind='down'})})
$dragPanel.add_MouseMove({param($sender,$event) if($event.Button -ne 'None') { $script:drags++;[void]$script:strokeTrace.Add(@{stroke=$script:strokeCount;x=$event.X;y=$event.Y;kind='move'});$sender.Invalidate() }})
$dragPanel.add_Paint({param($sender,$event) $previous=$null;foreach($point in $script:strokeTrace){if($previous -and $previous.stroke -eq $point.stroke){$event.Graphics.DrawLine([System.Drawing.Pens]::White,[int]$previous.x,[int]$previous.y,[int]$point.x,[int]$point.y)};$previous=$point}})
$dragPanel.add_MouseUp({param($sender,$event) $sender.Capture=$false})
$script:wheel=0
$scrollBox=New-Object System.Windows.Forms.TextBox
$scrollBox.Location=New-Object System.Drawing.Point(270,100)
$scrollBox.Size=New-Object System.Drawing.Size(350,210)
$scrollBox.Multiline=$true
$scrollBox.ReadOnly=$true
$scrollBox.ScrollBars='Vertical'
$scrollBox.AccessibleName='Fixture scroll'
$scrollBox.Text=(1..100 | ForEach-Object {"Scroll line $_"}) -join "`r`n"
$scrollBox.add_MouseWheel({param($sender,$event) $script:wheel += $event.Delta})
$form.Controls.AddRange(@($inputBox,$secondInput,$checkOne,$checkTwo,$button,$label,$dragPanel,$scrollBox))
$cover = New-Object System.Windows.Forms.Form
$cover.Text = 'DSH Control Background Test Cover'
$cover.StartPosition = 'Manual'
$cover.Location = New-Object System.Drawing.Point(900,220)
$cover.Size = New-Object System.Drawing.Size(480,450)
$coverLabel = New-Object System.Windows.Forms.Label
$coverLabel.Dock = 'Fill'
$coverLabel.Text = 'DSH 测试窗口（自动关闭）'
$coverLabel.TextAlign = 'MiddleCenter'
$cover.Controls.Add($coverLabel)
$borderless = New-Object System.Windows.Forms.Form
$borderless.Text = ''
$borderless.FormBorderStyle = 'None'
$borderless.StartPosition = 'Manual'
$borderless.Location = New-Object System.Drawing.Point(900,700)
$borderless.Size = New-Object System.Drawing.Size(360,150)
$borderButton = New-Object System.Windows.Forms.Button
$borderButton.Text = 'No caption mouse test'
$borderButton.Location = New-Object System.Drawing.Point(20,30)
$borderButton.Size = New-Object System.Drawing.Size(300,70)
$script:borderClicks=0
$borderButton.add_Click({$script:borderClicks++})
$borderless.Controls.Add($borderButton)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.add_Tick({
    $state = @{windowId=$form.Handle.ToInt64(); coverId=$cover.Handle.ToInt64(); borderId=$borderless.Handle.ToInt64(); borderClicks=$script:borderClicks; minimized=($form.WindowState -eq 'Minimized'); clicks=$script:count; text=$inputBox.Text; secondText=$secondInput.Text; optionOne=$checkOne.Checked;optionTwo=$checkTwo.Checked;buttonEnabled=$button.Enabled;buttonName=$button.AccessibleName; strokeCount=$script:strokeCount;strokeTrace=@($script:strokeTrace.ToArray()); lastKey=$script:lastKey; drags=$script:drags; wheel=$script:wheel; firstVisibleLine=[FixtureKeys]::FirstLine($scrollBox.Handle); capture=$dragPanel.Capture; focus=$form.ActiveControl.AccessibleName; scrollFocused=$scrollBox.Focused; nativeWheel=[FixtureFilter]::Wheel; wheelTarget=[FixtureFilter]::WheelTarget; scrollHandle=$scrollBox.Handle.ToInt64(); wheelClass=[FixtureFilter]::TargetClass(); cursorX=[System.Windows.Forms.Cursor]::Position.X; cursorY=[System.Windows.Forms.Cursor]::Position.Y}
    [IO.File]::WriteAllText($StatePath, ($state | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    $commandPath = $StatePath + '.command'
    if (Test-Path -LiteralPath $commandPath) {
        $command = Get-Content -Raw -Encoding UTF8 -LiteralPath $commandPath | ConvertFrom-Json
        Remove-Item -LiteralPath $commandPath
        if ($command.action -eq 'cover') { $cover.Location=$form.Location; $cover.Size=$form.Size; $cover.TopMost=$true; $cover.Activate() }
        if ($command.action -eq 'cover-at-hud') { $cover.Location=New-Object System.Drawing.Point([int]$command.x,[int]$command.y);$cover.Size=New-Object System.Drawing.Size(600,160);$cover.TopMost=$true;$cover.Activate() }
        if ($command.action -eq 'uncover') { $cover.TopMost=$false; $cover.Location=New-Object System.Drawing.Point(900,220); $form.Activate() }
        if ($command.action -eq 'activate') { $form.Activate() }
        if ($command.action -eq 'activate-owned-browser') { [FixtureKeys]::ShowWindow([IntPtr]([long]$command.windowId),9);[FixtureKeys]::SetForegroundWindow([IntPtr]([long]$command.windowId)) | Out-Null }
        if ($command.action -eq 'disable-button') { $button.Enabled=$false }
        if ($command.action -eq 'enable-button') { $button.Enabled=$true }
        if ($command.action -eq 'rename-button') { $button.AccessibleName='Fixture changed button' }
        if ($command.action -eq 'reset-button') { $button.AccessibleName='Fixture button';$button.Enabled=$true }
        if ($command.action -eq 'arm-move-second') { $script:moveOnClick=$true }
        if ($command.action -eq 'reset-second') { $secondInput.Left=400;$script:moveOnClick=$false }
        if ($command.action -eq 'clear-trace') { $script:strokeCount=0;$script:strokeTrace.Clear() }
        if ($command.action -eq 'add-control') { $extraButton=New-Object System.Windows.Forms.Button;$extraButton.Text='Fixture new control';$extraButton.AccessibleName='Fixture new control';$extraButton.Location=New-Object System.Drawing.Point(30,350);$form.Controls.Add($extraButton) }
        if ($command.action -eq 'background') { $cover.Activate() }
        if ($command.action -eq 'minimize') { [FixtureKeys]::ShowWindow($form.Handle,6); $cover.Activate() }
        if ($command.action -eq 'borderless') { $borderless.Show(); [FixtureKeys]::ShowWindow($borderless.Handle,4); $cover.Activate() }
        if ($command.action -eq 'border-move') { $borderless.Left += 15 }
        if ($command.action -eq 'border-at-hud') { $borderless.Location=New-Object System.Drawing.Point(([int]$command.x+20),([int]$command.y));$borderless.Show() }
        if ($command.action -eq 'border-hide') { $borderless.Hide() }
        if ($command.action -eq 'cover-element') { $label.Width=500; $label.BringToFront() }
        if ($command.action -eq 'uncover-element') { $label.Width=220 }
        if ($command.action -eq 'capture') {
            $r=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
            $bmp=New-Object System.Drawing.Bitmap(500,40)
            $g=[System.Drawing.Graphics]::FromImage($bmp)
            $g.CopyFromScreen(($r.Right-520),($r.Top+16),0,0,$bmp.Size)
            $bmp.Save([string]$command.path,[System.Drawing.Imaging.ImageFormat]::Png)
            $g.Dispose(); $bmp.Dispose()
        }
        if ($command.action -eq 'escape') { [FixtureKeys]::Escape() }
        if ($command.action -eq 'indicator-stop') {
            [FixtureKeys]::ClickAt([int]$command.x,[int]$command.y)
        }
        if ($command.action -eq 'close') { $borderless.Close(); $cover.Close(); $form.Close() }
    }
})
$form.add_Shown({ [FixtureKeys]::ShowWindow($form.Handle,4); $cover.Show(); [FixtureKeys]::ShowWindow($cover.Handle,4); $cover.Activate(); $timer.Start() })
[System.Windows.Forms.Application]::Run($form)
$timer.Dispose(); $borderless.Dispose(); $cover.Dispose(); $form.Dispose()
