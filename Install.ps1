param([string]$DshHome,[string]$Profile='desktop',[string]$AppDirectory,[string]$NodePath,[string]$PnpmPath,[switch]$KeepLegacyPlugins,[switch]$PlanOnly)
. (Join-Path $PSScriptRoot 'scripts/Common.ps1')
$manifest=Test-BundleFiles
$context=Resolve-DshContext $DshHome $Profile $AppDirectory $NodePath $PnpmPath
$profileFiles=@('package.json','pnpm-lock.yaml','pnpm-workspace.yaml','cordis.patch.yml')
if ($PlanOnly) { [pscustomobject]@{Action='Install';Profile=$context.ProfileDir;Packages=($manifest.packages|ForEach-Object {$_.name+'@'+$_.version});DisableLegacy=(-not $KeepLegacyPlugins);Writes=$false}; return }
$stamp=(Get-Date -Format 'yyyyMMdd-HHmmss-fff')
$backup=Join-Path $context.DshHome ('backups/plugin-handoff/'+$stamp)
$archiveRoot=Join-Path $context.DshHome ('plugins/plugin-handoff/'+$stamp)
New-Item -ItemType Directory -Path $backup,$archiveRoot -Force|Out-Null
$saved=@();foreach($name in $profileFiles){$path=Join-Path $context.ProfileDir $name;$exists=Test-Path -LiteralPath $path;if($exists){Copy-Item -LiteralPath $path -Destination (Join-Path $backup $name)};$saved+=@{name=$name;existed=$exists}}
$metadata=@{schema=1;profile=$context.Profile;profileDir=$context.ProfileDir;dshHome=$context.DshHome;nodePath=$context.NodePath;pnpmPath=$context.PnpmPath;files=$saved;status='started';createdAt=(Get-Date).ToString('o')}
Write-BundleJson (Join-Path $backup 'restore.json') $metadata
try {
    Repair-MovedPnpmMetadata $context $backup
    $archives=@();foreach($package in $manifest.packages){$destination=Join-Path $archiveRoot ([IO.Path]::GetFileName($package.archive));Copy-Item -LiteralPath (Join-Path $PSScriptRoot $package.archive) -Destination $destination;$archives+='file:'+$destination.Replace('\','/')}
    Invoke-BundlePnpm $context (@('add')+$archives+@('--config.auto-install-peers=false','--ignore-scripts'))
    $packagePath=Join-Path $context.ProfileDir 'package.json';$config=Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8|ConvertFrom-Json
    if (-not $config.dsh.profile) { throw 'Missing dsh.profile metadata' }
    foreach($package in $manifest.packages){if($config.dsh.profile.bundles -notcontains $package.name){$config.dsh.profile.bundles=@($config.dsh.profile.bundles)+$package.name}}
    Write-BundleJson $packagePath $config
    $patchPath=Join-Path $context.ProfileDir 'cordis.patch.yml';$patch=if(Test-Path -LiteralPath $patchPath){[IO.File]::ReadAllText($patchPath)}else{''}
    $block="`r`n# BEGIN DSH PLUGIN HANDOFF`r`n- id: dsh-control`r`n  disabled: false`r`n- id: dsh-agent-supervisor`r`n  disabled: false`r`n"
    if (-not $KeepLegacyPlugins) { $block+="- id: dsh-click`r`n  disabled: true`r`n- id: tool-browseruse`r`n  disabled: true`r`n- id: dsh-browseruse`r`n  disabled: true`r`n" }
    $block+="# END DSH PLUGIN HANDOFF`r`n"
    $patch=[regex]::Replace($patch,'(?ms)^# BEGIN DSH PLUGIN HANDOFF\r?\n.*?^# END DSH PLUGIN HANDOFF\r?\n?','')
    [IO.File]::WriteAllText($patchPath,$patch+$block,(New-Object Text.UTF8Encoding($false)))
    $hashes=@{};foreach($name in $profileFiles){$path=Join-Path $context.ProfileDir $name;if(Test-Path -LiteralPath $path){$hashes[$name]=Get-BundleHash $path}}
    $metadata.status='installed';$metadata.afterHashes=$hashes;Write-BundleJson (Join-Path $backup 'restore.json') $metadata
    [IO.File]::WriteAllText((Join-Path $context.DshHome ('plugins/plugin-handoff/last-backup-'+$Profile+'.txt')),$backup,(New-Object Text.UTF8Encoding($false)))
    Write-Output ('Installed both plugins. Backup: '+$backup)
    Write-Output 'Restart DSH to load the installed code.'
} catch {
    foreach($item in $saved){$path=Join-Path $context.ProfileDir $item.name;if($item.existed){Copy-Item -LiteralPath (Join-Path $backup $item.name) -Destination $path -Force}elseif(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path}}
    if(Test-Path -LiteralPath (Join-Path $backup 'modules.yaml')){Copy-Item -LiteralPath (Join-Path $backup 'modules.yaml') -Destination (Join-Path $context.ProfileDir 'node_modules/.modules.yaml') -Force}
    $metadata.status='failed';Write-BundleJson (Join-Path $backup 'restore.json') $metadata
    throw ('Installation failed; profile files restored. Backup: '+$backup+'. '+$_.Exception.Message)
}
