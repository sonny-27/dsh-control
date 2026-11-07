param([switch]$Quiet)
. (Join-Path $PSScriptRoot 'scripts/Common.ps1')
$manifest=Test-BundleFiles
if (-not $Quiet) { Write-Output ('Verified ' + @($manifest.files).Count + ' files'); $manifest.packages | Select-Object name,version }
