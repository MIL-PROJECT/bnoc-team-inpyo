param(
  [ValidateSet('Start', 'Stop')]
  [string]$Action = 'Start'
)

$ErrorActionPreference = 'Stop'
$MediaRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ManifestPath = Join-Path $MediaRoot 'bundle-manifest.json'
$LocalRoot = Join-Path $env:LOCALAPPDATA 'BNOC-Demo'
$AppPort = 18081
$ProviderPort = 18082
$DatabasePort = 13307

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-Json([string]$Path, $Fallback = $null) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $Fallback }
  return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Write-Json([string]$Path, $Value) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $temporary = "$Path.$PID.tmp"
  $json = $Value | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($temporary, $json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Assert-Target {
  if (-not [Environment]::Is64BitOperatingSystem) { throw '64-bit Windows is required.' }
  $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  if ($architecture -ne 'AMD64') { throw "This package requires Windows x64. Detected: $architecture" }
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required.' }
  if (-not $env:LOCALAPPDATA) { throw 'The current Windows user has no writable LOCALAPPDATA folder.' }
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw 'CD package manifest is missing. Copy the complete package folder to CD.' }
}

function Get-ProcessCommandLine([int]$ProcessId) {
  try {
    $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    return $process.CommandLine
  } catch {
    throw "Cannot verify ownership of process $ProcessId. No process was stopped."
  }
}

function Test-ManagedProcess($Entry) {
  if (-not $Entry -or -not $Entry.pid -or -not $Entry.needle) { return $false }
  $commandLine = Get-ProcessCommandLine -ProcessId ([int]$Entry.pid)
  if (-not $commandLine) { return $false }
  return $commandLine.IndexOf([string]$Entry.needle, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Stop-RecordedProcess($Entry) {
  if (-not (Test-ManagedProcess $Entry)) { return }
  Stop-Process -Id ([int]$Entry.pid) -ErrorAction Stop
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (-not (Test-ManagedProcess $Entry)) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Process $($Entry.name) did not stop. See $($Entry.stderr)."
}

function Stop-Demo {
  $dataRoot = Join-Path (Join-Path $LocalRoot 'data') $script:ReleaseId
  $statePath = Join-Path $dataRoot 'services.json'
  $state = Read-Json $statePath
  if (-not $state) { Write-Host 'No running BNOC demo services found.'; return }
  foreach ($name in @('application', 'provider')) {
    if ($state.services.$name) { Stop-RecordedProcess $state.services.$name }
  }
  if ($state.services.mysql) {
    $mysqlAdmin = [string]$state.services.mysql.mysqlAdmin
    $clientFile = [string]$state.services.mysql.clientFile
    if ($mysqlAdmin -and $clientFile -and (Test-Path -LiteralPath $mysqlAdmin -PathType Leaf) -and (Test-Path -LiteralPath $clientFile -PathType Leaf)) {
      & $mysqlAdmin "--defaults-extra-file=$clientFile" shutdown 2>> (Join-Path $dataRoot 'logs/mysql-stop.err.log')
      if ($LASTEXITCODE -ne 0 -and (Test-ManagedProcess $state.services.mysql)) {
        Stop-RecordedProcess $state.services.mysql
      } else {
        for ($attempt = 0; $attempt -lt 30 -and (Test-ManagedProcess $state.services.mysql); $attempt++) { Start-Sleep -Milliseconds 250 }
        if (Test-ManagedProcess $state.services.mysql) { Stop-RecordedProcess $state.services.mysql }
      }
    } else {
      Stop-RecordedProcess $state.services.mysql
    }
  }
  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  Write-Host 'BNOC demo services stopped. Local database and attachments remain on this PC.'
}

function Test-VcRuntime {
  $registryPath = 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64'
  try {
    $runtime = Get-ItemProperty -LiteralPath $registryPath -ErrorAction Stop
    if ([int]$runtime.Installed -ne 1) { return $false }
    $versionText = ([string]$runtime.Version) -replace '^v', ''
    return ([version]$versionText -ge [version]'14.29.30139.0')
  } catch { return $false }
}

function Ensure-VcRuntime($Manifest) {
  if (Test-VcRuntime) { return }
  $dependency = $Manifest.dependencies.vcRuntime
  if (-not $dependency -or -not $dependency.path -or -not $dependency.sha256) {
    throw 'This package does not include the required Microsoft Visual C++ x64 runtime.'
  }
  $installer = Join-Path $MediaRoot ([string]$dependency.path)
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Visual C++ runtime installer is missing from the CD: $($dependency.path)" }
  if ((Get-Sha256 $installer) -ne [string]$dependency.sha256) { throw 'Visual C++ runtime installer failed its integrity check.' }
  try {
    $signature = Get-AuthenticodeSignature -FilePath $installer -ErrorAction Stop
  } catch {
    throw 'Could not verify the Visual C++ runtime installer signature. No elevated installer was started.'
  }
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or -not $signature.SignerCertificate) {
    throw "Visual C++ runtime installer signature is not trusted ($($signature.Status)). No elevated installer was started."
  }
  $publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  $subject = [string]$signature.SignerCertificate.Subject
  if ($publisher -ne 'Microsoft Corporation' -or $subject -notmatch '(?i)(?:^|,\s*)O=Microsoft Corporation(?:,|$)') {
    throw 'Visual C++ runtime installer is not signed by Microsoft Corporation. No elevated installer was started.'
  }
  Write-Host 'Installing the MySQL prerequisite from the CD. Windows may request UAC approval.'
  try {
    $process = Start-Process -FilePath $installer -ArgumentList '/install /passive /norestart' -Verb RunAs -Wait -PassThru
  } catch {
    throw 'The required Visual C++ runtime is missing. UAC/admin approval was not completed, so the demo did not start.'
  }
  if ($process.ExitCode -eq 3010) { throw 'Visual C++ runtime installation requires a Windows restart. Restart, then run START-DEMO.cmd again.' }
  if ($process.ExitCode -ne 0 -or -not (Test-VcRuntime)) {
    throw "Visual C++ runtime installation did not complete (exit code $($process.ExitCode)). No demo service was started."
  }
}

function Assert-PackageFiles($Manifest) {
  if (-not $Manifest.files -or @($Manifest.files).Count -eq 0) { throw 'CD package file list is missing.' }
  $listedPaths = @{}
  $mediaRoot = [IO.Path]::GetFullPath($MediaRoot)
  if (-not $mediaRoot.EndsWith([IO.Path]::DirectorySeparatorChar)) { $mediaRoot += [IO.Path]::DirectorySeparatorChar }
  foreach ($file in $Manifest.files) {
    $relativePath = [string]$file.path
    if ([string]::IsNullOrWhiteSpace($relativePath) -or [IO.Path]::IsPathRooted($relativePath) -or $relativePath -match '(^|[\\/])\.\.([\\/]|$)') {
      throw "CD package contains an unsafe path: $relativePath"
    }
    if ([string]$file.sha256 -notmatch '^[a-fA-F0-9]{64}$') {
      throw "CD package contains an invalid file hash: $relativePath"
    }
    if ($null -eq $file.size -or [long]$file.size -lt 1) { throw "CD package contains an invalid file size: $relativePath" }
    if ($listedPaths.ContainsKey($relativePath)) { throw "CD package lists a duplicate file: $relativePath" }
    $listedPaths[$relativePath] = $true
    $localPath = $relativePath.Replace([char]'/', [IO.Path]::DirectorySeparatorChar)
    $source = [IO.Path]::GetFullPath((Join-Path $mediaRoot $localPath))
    if (-not $source.StartsWith($mediaRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "CD package path escaped the media folder: $relativePath" }
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "CD package file is missing: $relativePath" }
    $sourceInfo = Get-Item -LiteralPath $source
    if ([long]$sourceInfo.Length -ne [long]$file.size) { throw "CD package file size check failed: $relativePath" }
    if ((Get-Sha256 $source) -ne [string]$file.sha256) { throw "CD package integrity check failed: $relativePath" }
  }
  foreach ($name in @('application', 'mysql', 'node', 'java', 'vcRuntime')) {
    $dependency = $Manifest.dependencies.$name
    if (-not $dependency -or -not $dependency.path -or -not $listedPaths.ContainsKey([string]$dependency.path)) {
      throw "CD package is missing its required $name artifact."
    }
  }
}

function Ensure-InstalledRuntime($Manifest, [bool]$PackageVerified) {
  $releaseRoot = Join-Path (Join-Path $LocalRoot 'releases') $Manifest.releaseId
  $payloadRoot = Join-Path $releaseRoot 'payload'
  $dependencyRoot = Join-Path $releaseRoot 'dependencies'
  $installedPath = Join-Path $releaseRoot 'installed.json'
  $installed = Read-Json $installedPath
  if ($installed -and $installed.releaseId -eq $Manifest.releaseId -and
      (Test-Path -LiteralPath (Join-Path $payloadRoot 'bnoc-server-1.0.0.jar') -PathType Leaf) -and
      (Test-Path -LiteralPath (Join-Path $payloadRoot 'mock-provider/server.mjs') -PathType Leaf) -and
      (Get-ChildItem -LiteralPath $dependencyRoot -Filter mysqld.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1) -and
      (Get-ChildItem -LiteralPath $dependencyRoot -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1) -and
      (Get-ChildItem -LiteralPath $dependencyRoot -Filter java.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1)) {
    return $releaseRoot
  }

  if (-not $PackageVerified) { Assert-PackageFiles $Manifest }
  New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $dependencyRoot -Force | Out-Null
  foreach ($name in @('mysql', 'node', 'java')) {
    $dependency = $Manifest.dependencies.$name
    $archive = Join-Path $MediaRoot ([string]$dependency.path)
    $destination = Join-Path $dependencyRoot $name
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
  }
  foreach ($file in $Manifest.files) {
    if ($file.path -like 'runtime/bnoc-server-1.0.0.jar') {
      Copy-Item -LiteralPath (Join-Path $MediaRoot $file.path) -Destination (Join-Path $payloadRoot 'bnoc-server-1.0.0.jar') -Force
    }
    if ($file.path -like 'runtime/mock-provider/server.mjs') {
      $providerRoot = Join-Path $payloadRoot 'mock-provider'
      New-Item -ItemType Directory -Path $providerRoot -Force | Out-Null
      Copy-Item -LiteralPath (Join-Path $MediaRoot $file.path) -Destination (Join-Path $providerRoot 'server.mjs') -Force
    }
  }
  foreach ($executable in @('mysqld.exe', 'mysql.exe', 'mysqladmin.exe', 'node.exe', 'java.exe')) {
    if (-not (Get-ChildItem -LiteralPath $dependencyRoot -Filter $executable -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1)) {
      throw "Runtime extraction did not provide $executable. See $releaseRoot."
    }
  }
  Write-Json $installedPath @{ releaseId = $Manifest.releaseId; installedAt = [DateTime]::UtcNow.ToString('o') }
  return $releaseRoot
}

function Find-Executable([string]$Root, [string]$Name) {
  $matches = @(Get-ChildItem -LiteralPath $Root -Filter $Name -File -Recurse -ErrorAction Stop)
  if ($matches.Count -ne 1) { throw "Expected one $Name under $Root, found $($matches.Count)." }
  return $matches[0].FullName
}

function New-RandomSecret {
  $bytes = New-Object byte[] 32
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return [System.BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

function Set-ProcessEnvironment($Environment) {
  $previous = @{}
  foreach ($key in $Environment.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable([string]$key, 'Process')
    [Environment]::SetEnvironmentVariable([string]$key, [string]$Environment[$key], 'Process')
  }
  return $previous
}

function Restore-ProcessEnvironment($Environment) {
  foreach ($key in $Environment.Keys) { [Environment]::SetEnvironmentVariable([string]$key, $Environment[$key], 'Process') }
}

function Quote-Argument([string]$Argument) {
  if ($Argument -notmatch '[\s"]') { return $Argument }
  return '"' + $Argument.Replace('"', '\"') + '"'
}

function Start-RecordedProcess([string]$Name, [string]$Executable, [string[]]$Arguments, [string]$Needle, $Environment, [string]$WorkingDirectory, [string]$LogRoot, $State) {
  $stdout = Join-Path $LogRoot "$Name.out.log"
  $stderr = Join-Path $LogRoot "$Name.err.log"
  New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
  $previous = Set-ProcessEnvironment $Environment
  try {
    $quoted = @($Arguments | ForEach-Object { Quote-Argument ([string]$_) }) -join ' '
    $process = Start-Process -FilePath $Executable -ArgumentList $quoted -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  } finally { Restore-ProcessEnvironment $previous }
  $State.services[$Name] = @{ name = $Name; pid = $process.Id; needle = $Needle; stderr = $stderr }
  Write-Json (Join-Path $script:DataRoot 'services.json') $State
  return $process
}

function Test-TcpReady([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync('127.0.0.1', $Port)
    if (-not $task.Wait(1000)) { return $false }
    return $client.Connected
  } catch { return $false } finally { $client.Dispose() }
}

function Wait-TcpReady([int]$Port, [string]$Name, $Process, [string]$LogPath) {
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if ($Process.HasExited) { throw "$Name exited during startup. Check $LogPath and $([System.IO.Path]::ChangeExtension($LogPath, '.out.log'))." }
    if (Test-TcpReady $Port) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "$Name did not become ready. Check $LogPath and $([System.IO.Path]::ChangeExtension($LogPath, '.out.log'))."
}

function Get-HttpStatus([string]$Url) {
  $request = [System.Net.HttpWebRequest]::Create($Url)
  $request.Proxy = $null
  $request.Timeout = 1500
  $request.AllowAutoRedirect = $false
  try {
    $response = $request.GetResponse()
    try { return [int]$response.StatusCode } finally { $response.Close() }
  } catch [System.Net.WebException] {
    if ($_.Exception.Response) {
      try { return [int]$_.Exception.Response.StatusCode } finally { $_.Exception.Response.Close() }
    }
    return 0
  }
}

function Wait-HttpReady([string]$Url, [int[]]$AcceptedStatus, [string]$Name, $Process, [string]$LogPath) {
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if ($Process.HasExited) { throw "$Name exited during startup. Check $LogPath and $([System.IO.Path]::ChangeExtension($LogPath, '.out.log'))." }
    $status = Get-HttpStatus $Url
    if ($AcceptedStatus -contains $status) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "$Name did not become ready at $Url. Check $LogPath and $([System.IO.Path]::ChangeExtension($LogPath, '.out.log'))."
}

function Test-MySqlReady($Entry) {
  if (-not $Entry -or -not $Entry.mysqlClient -or -not $Entry.clientFile) { return $false }
  if (-not (Test-ManagedProcess $Entry)) { return $false }
  if (-not (Test-TcpReady $DatabasePort)) { return $false }
  try {
    $output = & ([string]$Entry.mysqlClient) "--defaults-extra-file=$([string]$Entry.clientFile)" '--batch' '--skip-column-names' '--execute=SELECT 1' 2>$null
    return ($LASTEXITCODE -eq 0 -and @($output) -contains '1')
  } catch { return $false }
}

function Test-PortAvailable([int]$Port, [string]$Name) {
  $listener = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
  try { $listener.Start(); return $true } catch { throw "$Name port $Port is already in use. Close the other local service and try again." } finally { try { $listener.Stop() } catch {} }
}

function Start-Demo($Manifest) {
  $script:ReleaseId = [string]$Manifest.releaseId
  $script:DataRoot = Join-Path (Join-Path $LocalRoot 'data') $script:ReleaseId
  New-Item -ItemType Directory -Path (Join-Path $script:DataRoot 'logs') -Force | Out-Null
  $statePath = Join-Path $script:DataRoot 'services.json'
  $state = Read-Json $statePath
  $services = if ($state) { $state.services } else { $null }
  $appHealthy = $false
  $providerHealthy = $false
  $mysqlHealthy = $false
  if ($state -and $state.releaseId -eq $script:ReleaseId -and $services) {
    try { $appHealthy = (Test-ManagedProcess $services.application) -and ((Get-HttpStatus "http://127.0.0.1:$AppPort/api/session") -in @(200, 401)) } catch { $appHealthy = $false }
    try { $providerHealthy = (Test-ManagedProcess $services.provider) -and ((Get-HttpStatus "http://127.0.0.1:$ProviderPort/health") -eq 200) } catch { $providerHealthy = $false }
    try { $mysqlHealthy = Test-MySqlReady $services.mysql } catch { $mysqlHealthy = $false }
  }
  if ($appHealthy -and $providerHealthy -and $mysqlHealthy) {
    Start-Process "http://127.0.0.1:$AppPort"
    Write-Host "BNOC demo is already running. Browser opened at http://127.0.0.1:$AppPort"
    return
  }
  if ($state) { Stop-Demo }
  foreach ($port in @($AppPort, $ProviderPort, $DatabasePort)) { Test-PortAvailable $port "BNOC demo" | Out-Null }
  $packageVerified = $false
  if (-not (Test-VcRuntime)) { Assert-PackageFiles $Manifest; $packageVerified = $true }
  Ensure-VcRuntime $Manifest
  $releaseRoot = Ensure-InstalledRuntime $Manifest $packageVerified
  $payloadRoot = Join-Path $releaseRoot 'payload'
  $dependencyRoot = Join-Path $releaseRoot 'dependencies'
  $mysqlRoot = Join-Path $dependencyRoot 'mysql'
  $nodeRoot = Join-Path $dependencyRoot 'node'
  $javaRoot = Join-Path $dependencyRoot 'java'
  $mysqld = Find-Executable $mysqlRoot 'mysqld.exe'
  $mysql = Find-Executable $mysqlRoot 'mysql.exe'
  $mysqlAdmin = Find-Executable $mysqlRoot 'mysqladmin.exe'
  $mysqlHome = Split-Path -Parent (Split-Path -Parent $mysqld)
  $node = Find-Executable $nodeRoot 'node.exe'
  $java = Find-Executable $javaRoot 'java.exe'
  $mysqlData = Join-Path $script:DataRoot 'mysql'
  $attachmentRoot = Join-Path $script:DataRoot 'attachments'
  New-Item -ItemType Directory -Path $mysqlData -Force | Out-Null
  New-Item -ItemType Directory -Path $attachmentRoot -Force | Out-Null
  $mysqlLog = Join-Path (Join-Path $script:DataRoot 'logs') 'mysql-server.log'
  $secretsPath = Join-Path $script:DataRoot 'secrets.json'
  $secrets = Read-Json $secretsPath
  if (-not $secrets) {
    if (Test-Path -LiteralPath (Join-Path $mysqlData 'auto.cnf') -PathType Leaf) { throw "Database exists without local credentials. Preserve $script:DataRoot and inspect its logs." }
    $secrets = @{ rootPassword = New-RandomSecret; appPassword = New-RandomSecret; mockSecret = New-RandomSecret; initialized = $false }
    Write-Json $secretsPath $secrets
  }
  if (-not (Test-Path -LiteralPath (Join-Path $mysqlData 'auto.cnf') -PathType Leaf)) {
    & $mysqld --no-defaults --initialize-insecure "--basedir=$mysqlHome" "--datadir=$mysqlData" "--log-error=$mysqlLog"
    if ($LASTEXITCODE -ne 0) { throw "MySQL initialization failed. Check $mysqlLog." }
  }
  $clientFile = Join-Path $script:DataRoot 'mysql-client.ini'
  [System.IO.File]::WriteAllText($clientFile, "[client]`r`nuser=root`r`npassword=$($secrets.rootPassword)`r`nprotocol=TCP`r`nhost=127.0.0.1`r`nport=$DatabasePort`r`n", [System.Text.Encoding]::ASCII)
  $state = @{ releaseId = $script:ReleaseId; services = @{}; url = "http://127.0.0.1:$AppPort" }
  try {
    $mysqlProcess = Start-RecordedProcess 'mysql' $mysqld @('--no-defaults', "--basedir=$mysqlHome", "--datadir=$mysqlData", "--port=$DatabasePort", '--bind-address=127.0.0.1', '--mysqlx=OFF', '--skip-log-bin', "--log-error=$mysqlLog") $mysqlData @{} $mysqlHome (Join-Path $script:DataRoot 'logs') $state
    $state.services.mysql.mysqlAdmin = $mysqlAdmin
    $state.services.mysql.clientFile = $clientFile
    $state.services.mysql.mysqlClient = $mysql
    Write-Json $statePath $state
    Wait-TcpReady $DatabasePort 'MySQL' $mysqlProcess $mysqlLog
    if (-not $secrets.initialized) {
      $sql = "CREATE DATABASE IF NOT EXISTS bnoc CHARACTER SET utf8mb4; CREATE USER IF NOT EXISTS 'bnoc_app'@'localhost' IDENTIFIED BY '$($secrets.appPassword)'; CREATE USER IF NOT EXISTS 'bnoc_app'@'127.0.0.1' IDENTIFIED BY '$($secrets.appPassword)'; GRANT ALL PRIVILEGES ON bnoc.* TO 'bnoc_app'@'localhost'; GRANT ALL PRIVILEGES ON bnoc.* TO 'bnoc_app'@'127.0.0.1'; ALTER USER 'root'@'localhost' IDENTIFIED BY '$($secrets.rootPassword)';"
      & $mysql "--defaults-extra-file=$clientFile" '--batch' '--execute=SELECT 1' 2>> (Join-Path $script:DataRoot 'logs/mysql-client.err.log')
      $rootPasswordReady = $LASTEXITCODE -eq 0
      if (-not $rootPasswordReady) {
        & $mysql '--protocol=TCP' '--host=127.0.0.1' "--port=$DatabasePort" '--user=root' '--batch' "--execute=$sql"
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the local demo database and credentials.' }
      }
      $secrets.initialized = $true
      Write-Json $secretsPath $secrets
    } else {
      & $mysql "--defaults-extra-file=$clientFile" '--batch' '--execute=SELECT 1'
      if ($LASTEXITCODE -ne 0) { throw 'Could not authenticate to the existing local demo database.' }
    }

    $providerPath = Join-Path (Join-Path $payloadRoot 'mock-provider') 'server.mjs'
    $providerEnv = @{
      BNOC_MOCK_PORT = [string]$ProviderPort; BNOC_MOCK_SECRET = [string]$secrets.mockSecret;
      BNOC_MOCK_ALLOWED_ORIGINS = "http://127.0.0.1:$AppPort"
    }
    $providerLog = Join-Path (Join-Path $script:DataRoot 'logs') 'provider.err.log'
    $providerProcess = Start-RecordedProcess 'provider' $node @($providerPath) $providerPath $providerEnv $payloadRoot (Join-Path $script:DataRoot 'logs') $state
    Wait-HttpReady "http://127.0.0.1:$ProviderPort/health" @(200) 'Mock provider' $providerProcess $providerLog

    $appJar = Join-Path $payloadRoot 'bnoc-server-1.0.0.jar'
    $appEnvironment = @{
      BNOC_PORT = [string]$AppPort; BNOC_PUBLIC_URL = "http://127.0.0.1:$AppPort"; BNOC_BIND = '127.0.0.1';
      BNOC_DB_URL = "jdbc:mysql://127.0.0.1:$DatabasePort/bnoc?useUnicode=true&characterEncoding=UTF-8&serverTimezone=Asia/Seoul";
      BNOC_DB_USER = 'bnoc_app'; BNOC_DB_PASSWORD = [string]$secrets.appPassword;
      BNOC_MOCK_SECRET = [string]$secrets.mockSecret; BNOC_PROVIDER_URL = "http://127.0.0.1:$ProviderPort";
      BNOC_INTEGRATION_MODE = 'competition'; BNOC_FILE_ROOT = $attachmentRoot;
      BNOC_BOOTSTRAP_ADMIN = 'access-admin'; BNOC_DEPARTMENTS = ''
    }
    $appLog = Join-Path (Join-Path $script:DataRoot 'logs') 'application.err.log'
    $appProcess = Start-RecordedProcess 'application' $java @('-jar', $appJar) $appJar $appEnvironment $payloadRoot (Join-Path $script:DataRoot 'logs') $state
    Wait-HttpReady "http://127.0.0.1:$AppPort/api/session" @(200, 401) 'BNOC server' $appProcess $appLog
    Start-Process "http://127.0.0.1:$AppPort"
    Write-Host "BNOC demo is ready at http://127.0.0.1:$AppPort"
    Write-Host "Local database and attachments: $script:DataRoot"
    Write-Host "Logs: $(Join-Path $script:DataRoot 'logs')"
  } catch {
    try { Stop-Demo } catch { Write-Host "Cleanup needs attention: $($_.Exception.Message)" }
    throw
  }
}

try {
  Assert-Target
  $manifest = Read-Json $ManifestPath
  if ($manifest.schemaVersion -ne 1 -or $manifest.target.platform -ne 'win32' -or $manifest.target.architecture -ne 'x64') { throw 'Unsupported CD package manifest.' }
  $script:ReleaseId = [string]$manifest.releaseId
  if ($script:ReleaseId -notmatch '^bnoc-win-x64-[a-f0-9]{16}$') { throw 'CD package release ID is missing or invalid.' }
  if ($Action -eq 'Start') { Start-Demo $manifest } else { Stop-Demo }
  exit 0
} catch {
  Write-Host "BNOC demo could not continue: $($_.Exception.Message)" -ForegroundColor Red
  if ($script:DataRoot) { Write-Host "Logs, if created: $(Join-Path $script:DataRoot 'logs')" }
  exit 1
}
