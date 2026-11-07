$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing,UIAutomationClient,UIAutomationTypes,System.Web.Extensions,WindowsBase
Add-Type -Path @((Join-Path $PSScriptRoot '../native/Control.cs'),(Join-Path $PSScriptRoot '../native/Advanced.cs')) -ReferencedAssemblies System.Windows.Forms,System.Drawing,UIAutomationClient,UIAutomationTypes,System.Web.Extensions,WindowsBase
if(-not [DshControl.Host]::HumanInput($false,0,0x201)){throw 'Physical mouse down not recognized'}
if(-not [DshControl.Host]::HumanInput($false,0,0x20A)){throw 'Physical wheel not recognized'}
if([DshControl.Host]::HumanInput($false,1,0x201)){throw 'Injected mouse must not cause takeover'}
if([DshControl.Host]::HumanInput($false,0,0x200)){throw 'Mouse movement during observation must remain available'}
if(-not [DshControl.Host]::HumanInput($true,0,0x100)){throw 'Physical key down not recognized'}
if([DshControl.Host]::HumanInput($true,0x10,0x100)){throw 'Injected key must not cause takeover'}
if([DshControl.Host]::HumanInput($true,0,0x101)){throw 'Key release must not cause takeover'}
Write-Output 'PASS native physical/injected event classification (no hardware event injected)'
