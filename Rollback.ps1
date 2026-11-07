param([string]$BackupPath,[string]$DshHome,[string]$Profile='desktop',[switch]$Force,[switch]$PlanOnly)
. (Join-Path $PSScriptRoot 'scripts/Common.ps1')
if (-not $DshHome) { $DshHome=if($env:DSH_HOME){$env:DSH_HOME}else{Join-Path $env:USERPROFILE '.dsh'} }
$DshHome=[IO.Path]::GetFullPath($DshHome)
if (-not $BackupPath) { $BackupPath=(Get-Content -LiteralPath (Join-Path $DshHome ('plugins/plugin-handoff/last-backup-'+$Profile+'.txt')) -Raw -Encoding UTF8).Trim() }
$BackupPath=[IO.Path]::GetFullPath($BackupPath)
$metadata=Get-Content -LiteralPath (Join-Path $BackupPath 'restore.json') -Raw -Encoding UTF8|ConvertFrom-Json
if ($metadata.schema -ne 1) { throw 'Unsupported backup' }
$profileDir=[IO.Path]::GetFullPath($metadata.profileDir)
$profilesRoot=[IO.Path]::GetFullPath((Join-Path $DshHome 'profiles'))+[IO.Path]::DirectorySeparatorChar
if (-not $profileDir.StartsWith($profilesRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Backup profile is outside this DSH home' }
foreach($item in $metadata.files){if($item.name -notin @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml','cordis.patch.yml')){throw 'Unexpected backup file'}}
if (-not $Force -and $metadata.status -eq 'installed') {foreach($item in $metadata.afterHashes.PSObject.Properties){if($item.Name -notin @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml','cordis.patch.yml')){throw 'Unexpected backup hash path'};$path=Join-Path $profileDir $item.Name;if(-not(Test-Path -LiteralPath $path) -or (Get-BundleHash $path) -ne $item.Value){throw 'Profile changed since install; review backup and use -Force only if intentional'}}}
if($PlanOnly){[pscustomobject]@{Action='Rollback';Profile=$profileDir;Backup=$BackupPath;Writes=$false};return}
$context=Resolve-DshContext $DshHome $metadata.profile '' $metadata.nodePath $metadata.pnpmPath
$safety=Join-Path $DshHome ('backups/plugin-handoff/pre-rollback-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff'));New-Item -ItemType Directory -Path $safety -Force|Out-Null
foreach($item in $metadata.files){$path=Join-Path $profileDir $item.name;if(Test-Path -LiteralPath $path){Copy-Item -LiteralPath $path -Destination (Join-Path $safety $item.name)}}
foreach($item in $metadata.files){$path=Join-Path $profileDir $item.name;if($item.existed){Copy-Item -LiteralPath (Join-Path $BackupPath $item.name) -Destination $path -Force}elseif(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path}}
$arguments=@('install','--config.auto-install-peers=false','--ignore-scripts');if(Test-Path -LiteralPath (Join-Path $profileDir 'pnpm-lock.yaml')){$arguments+='--frozen-lockfile'}
Invoke-BundlePnpm $context $arguments
Write-Output ('Rollback complete. Pre-rollback copy: '+$safety)
Write-Output 'Browser profile, sessions, login state and user files were not deleted. Restart DSH.'
