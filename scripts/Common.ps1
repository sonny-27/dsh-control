$ErrorActionPreference = 'Stop'
function Get-BundleRoot { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')) }
function Get-BundleHash([string]$Path) {
    $algorithm=[Security.Cryptography.SHA256]::Create();$fileStream=[IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($algorithm.ComputeHash($fileStream)).Replace('-','').ToLowerInvariant() }
    finally { $fileStream.Dispose();$algorithm.Dispose() }
}
function Read-BundleManifest {
    $manifest = Get-Content -LiteralPath (Join-Path (Get-BundleRoot) 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.schema -ne 1 -or @($manifest.packages).Count -ne 2) { throw 'Invalid handoff manifest' }
    return $manifest
}
function Test-BundleFiles {
    $root = Get-BundleRoot
    $manifest = Read-BundleManifest
    foreach ($entry in $manifest.files) {
        $path = [IO.Path]::GetFullPath((Join-Path $root $entry.path))
        if (-not $path.StartsWith($root + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe bundle path' }
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw ('Missing file: ' + $entry.path) }
        if ((Get-BundleHash $path) -ne $entry.sha256) { throw ('Hash mismatch: ' + $entry.path) }
    }
    return $manifest
}
function Resolve-DshContext([string]$DshHome,[string]$Profile,[string]$AppDirectory,[string]$NodePath,[string]$PnpmPath) {
    if ($Profile -notmatch '^[A-Za-z0-9_-][A-Za-z0-9._-]*$' -or $Profile -in @('.','..')) { throw 'Invalid profile name' }
    if (-not $DshHome) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' } }
    $DshHome = [IO.Path]::GetFullPath($DshHome)
    $profileDir = [IO.Path]::GetFullPath((Join-Path $DshHome ('profiles/' + $Profile)))
    if (-not $profileDir.StartsWith(([IO.Path]::GetFullPath((Join-Path $DshHome 'profiles')) + [IO.Path]::DirectorySeparatorChar),[StringComparison]::OrdinalIgnoreCase)) { throw 'Profile path escaped DSH home' }
    if (-not (Test-Path -LiteralPath (Join-Path $profileDir 'package.json'))) { throw ('DSH profile not found: ' + $profileDir) }
    if (-not $AppDirectory) { $AppDirectory = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness' }
    if (-not $NodePath) { $NodePath = Join-Path $AppDirectory 'resources/runtime/primary-runtime/dependencies/node/bin/node.exe'; if (-not (Test-Path -LiteralPath $NodePath)) { $NodePath = (Get-Command node -ErrorAction Stop).Source } }
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node executable not found' }
    if (-not $PnpmPath) {
        foreach ($relative in @('resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs','resources/runtime/pnpm/bin/pnpm.mjs')) {
            $candidate = Join-Path $AppDirectory $relative
            if (Test-Path -LiteralPath $candidate) { $PnpmPath = $candidate; break }
        }
    }
    if (-not $PnpmPath -or -not (Test-Path -LiteralPath $PnpmPath -PathType Leaf)) { throw 'DSH bundled pnpm not found; supply -PnpmPath' }
    return [pscustomobject]@{ DshHome=$DshHome; Profile=$Profile; ProfileDir=$profileDir; NodePath=[IO.Path]::GetFullPath($NodePath); PnpmPath=[IO.Path]::GetFullPath($PnpmPath) }
}
function Invoke-BundlePnpm($Context,[string[]]$Arguments) {
    & $Context.NodePath $Context.PnpmPath --dir $Context.ProfileDir @Arguments
    if ($LASTEXITCODE -ne 0) { throw ('pnpm failed: ' + $LASTEXITCODE) }
}
function Write-BundleJson([string]$Path,$Value) { [IO.File]::WriteAllText($Path,($Value | ConvertTo-Json -Depth 40),(New-Object Text.UTF8Encoding($false))) }
function Repair-MovedPnpmMetadata($Context,[string]$Backup) {
    $path=Join-Path $Context.ProfileDir 'node_modules/.modules.yaml'
    if (-not (Test-Path -LiteralPath $path)) { return }
    $text=[IO.File]::ReadAllText($path)
    $oldStore=[regex]::Match($text,'(?m)^storeDir: ([^\r\n]+)');$oldVirtual=[regex]::Match($text,'(?m)^virtualStoreDir: ([^\r\n]+)')
    if (-not $oldStore.Success -or -not $oldVirtual.Success) { return }
    $store=$oldStore.Groups[1].Value.Trim().Trim([char]39,[char]34);$virtual=$oldVirtual.Groups[1].Value.Trim().Trim([char]39,[char]34)
    $currentVirtual=Join-Path $Context.ProfileDir 'node_modules/.pnpm'
    if ([IO.Path]::IsPathRooted($store) -and [IO.Path]::IsPathRooted($virtual) -and -not (Test-Path -LiteralPath $store) -and -not (Test-Path -LiteralPath $virtual) -and (Test-Path -LiteralPath $currentVirtual)) {
        $storeOutput = & $Context.NodePath $Context.PnpmPath --dir $Context.ProfileDir store path --silent
        if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve pnpm store' }
        $currentStore=[IO.Path]::GetFullPath(([string]($storeOutput|Select-Object -Last 1)).Trim())
        Copy-Item -LiteralPath $path -Destination (Join-Path $Backup 'modules.yaml')
        $text=[regex]::Replace($text,'(?m)^storeDir: [^\r\n]+',{param($m) 'storeDir: '+$currentStore.Replace('\','/')})
        $text=[regex]::Replace($text,'(?m)^virtualStoreDir: [^\r\n]+',{param($m) 'virtualStoreDir: '+$currentVirtual.Replace('\','/')})
        [IO.File]::WriteAllText($path,$text,(New-Object Text.UTF8Encoding($false)))
    }
}
