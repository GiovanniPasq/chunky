$ErrorActionPreference = "Stop"

Write-Host "========================================="
Write-Host "       - Starting All Services    "
Write-Host "========================================="
Write-Host ""

$BackendProcess = $null
$FrontendProcess = $null
$InFrontendDirectory = $false
$ProjectRoot = (Get-Location).Path
$FrontendPath = Join-Path $ProjectRoot "frontend"
$FrontendPathPattern = [regex]::Escape($FrontendPath) -replace "\\\\", "[\\/]"

function Show-PortOwner {
    param([int]$Port)

    try {
        $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
    } catch {
        return
    }

    if (-not $connections) {
        return
    }

    Write-Host ""
    Write-Host "Process currently listening on port ${Port}:"
    $connections |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object {
            $process = Get-Process -Id $_ -ErrorAction SilentlyContinue
            $processName = if ($process) { $process.ProcessName } else { "unknown" }
            $processPath = if ($process) { $process.Path } else { "" }
            [PSCustomObject]@{
                PID = $_
                ProcessName = $processName
                Path = $processPath
            }
        } |
        Format-Table -AutoSize
    Write-Host ""
}

function Test-PortFree {
    param(
        [int]$Port,
        [string]$Label,
        [string]$ExpectedPattern
    )

    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
    } catch {
        if (Stop-MatchingPortOwner -Port $Port -Label $Label -ExpectedPattern $ExpectedPattern) {
            Start-Sleep -Milliseconds 500
            try {
                $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
                $listener.Start()
                return
            } catch {
            } finally {
                if ($listener) {
                    $listener.Stop()
                }
            }
        }

        [Console]::Error.WriteLine("$Label port $Port is already in use. Stop the existing service or change the port.")
        Show-PortOwner -Port $Port
        exit 1
    } finally {
        if ($listener) {
            $listener.Stop()
        }
    }
}

function Stop-MatchingPortOwner {
    param(
        [int]$Port,
        [string]$Label,
        [string]$ExpectedPattern
    )

    try {
        $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
    } catch {
        return $false
    }

    if (-not $connections) {
        return $false
    }

    $matchingProcesses = @()
    $unexpectedProcesses = @()
    foreach ($processId in ($connections | Select-Object -ExpandProperty OwningProcess -Unique)) {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
        $commandLine = if ($processInfo) { $processInfo.CommandLine } else { "" }
        if ($commandLine -and ($commandLine -match $ExpectedPattern)) {
            $matchingProcesses += $processId
        } else {
            $unexpectedProcesses += $processId
        }
    }

    if ($unexpectedProcesses.Count -gt 0 -or $matchingProcesses.Count -eq 0) {
        return $false
    }

    Write-Host "$Label port $Port is already used by a previous Chunky process. Restarting it..."
    foreach ($processId in $matchingProcesses) {
        Stop-ProcessTree -ProcessId $processId
    }

    Start-Sleep -Milliseconds 500
    return $true
}

function Stop-ProcessTree {
    param([int]$ProcessId)

    if (-not $ProcessId) {
        return
    }

    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process) {
        return
    }

    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
    foreach ($child in $children) {
        Stop-ProcessTree -ProcessId $child.ProcessId
    }

    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Stop-Services {
    Write-Host ""
    Write-Host "Shutting down services..."

    if ($FrontendProcess -and -not $FrontendProcess.HasExited) {
        Stop-ProcessTree -ProcessId $FrontendProcess.Id
    }
    if ($BackendProcess -and -not $BackendProcess.HasExited) {
        Stop-ProcessTree -ProcessId $BackendProcess.Id
    }
}

function Wait-ForUrl {
    param(
        [string]$Label,
        [string]$Url,
        [System.Diagnostics.Process]$Process
    )

    Write-Host "Waiting for $Label to be ready..."
    while ($true) {
        if ($Process.HasExited) {
            [Console]::Error.WriteLine("$Label failed to start. Check the output above for details.")
            exit 1
        }

        try {
            Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
            break
        } catch {
            Start-Sleep -Seconds 1
        }
    }

    Write-Host "$Label is ready!"
    Write-Host ""
}

try {
    Test-PortFree -Port 8000 -Label "Backend" -ExpectedPattern "uvicorn .*backend\.main:app|backend\.main:app .*uvicorn"
    Test-PortFree -Port 5173 -Label "Frontend" -ExpectedPattern "$FrontendPathPattern.*vite|vite.*$FrontendPathPattern"

    Write-Host "Starting FastAPI backend..."
    $VenvDir = if ($env:VENV_DIR) { $env:VENV_DIR } else { ".venv" }
    $PythonBin = if ($env:PYTHON_BIN) { $env:PYTHON_BIN } else { "python" }
    $VenvPython = Join-Path $VenvDir "Scripts\python.exe"

    if (-not (Test-Path $VenvPython)) {
        Write-Host "Python environment not found. Creating '$VenvDir'..."
        & $PythonBin -m venv $VenvDir
    }

    $RequirementsMarker = Join-Path $VenvDir ".requirements-installed"
    $InstallBackendDeps = $false
    if (-not (Test-Path $RequirementsMarker)) {
        $InstallBackendDeps = $true
    } elseif ((Get-Item "requirements.txt").LastWriteTimeUtc -gt (Get-Item $RequirementsMarker).LastWriteTimeUtc) {
        $InstallBackendDeps = $true
    }

    if ($InstallBackendDeps) {
        Write-Host "Installing Python dependencies..."
        & $VenvPython -m pip install --upgrade pip
        & $VenvPython -m pip install -r requirements.txt
        New-Item -ItemType File -Force -Path $RequirementsMarker | Out-Null
    }

    $BackendProcess = Start-Process -FilePath $VenvPython `
        -ArgumentList @("-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000") `
        -PassThru `
        -NoNewWindow
    Write-Host "Backend started (PID: $($BackendProcess.Id)) at http://localhost:8000"
    Write-Host ""

    Wait-ForUrl -Label "Backend" -Url "http://localhost:8000/api/health" -Process $BackendProcess

    Write-Host "Starting React frontend..."
    Push-Location "frontend"
    $InFrontendDirectory = $true

    $DepsMarker = "node_modules\.dependencies-installed"
    $InstallFrontendDeps = $false
    if (-not (Test-Path "node_modules") -or -not (Test-Path $DepsMarker)) {
        $InstallFrontendDeps = $true
    } elseif ((Get-Item "package.json").LastWriteTimeUtc -gt (Get-Item $DepsMarker).LastWriteTimeUtc) {
        $InstallFrontendDeps = $true
    } elseif ((Test-Path "package-lock.json") -and ((Get-Item "package-lock.json").LastWriteTimeUtc -gt (Get-Item $DepsMarker).LastWriteTimeUtc)) {
        $InstallFrontendDeps = $true
    }

    if ($InstallFrontendDeps) {
        Write-Host "Installing frontend dependencies..."
        if (Test-Path "package-lock.json") {
            & npm ci
        } else {
            & npm install
        }
        New-Item -ItemType File -Force -Path $DepsMarker | Out-Null
    }

    $NpmCommand = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
    if (-not $NpmCommand) {
        $NpmCommand = Get-Command "npm" -ErrorAction Stop
    }

    $FrontendProcess = Start-Process -FilePath $NpmCommand.Source `
        -ArgumentList @("run", "dev") `
        -PassThru `
        -NoNewWindow
    Write-Host "Frontend started (PID: $($FrontendProcess.Id)) at http://localhost:5173"
    Write-Host ""

    Wait-ForUrl -Label "Frontend" -Url "http://localhost:5173" -Process $FrontendProcess

    Write-Host "========================================="
    Write-Host "  Backend:  http://localhost:8000"
    Write-Host "  Frontend: http://localhost:5173"
    Write-Host "  Press Ctrl+C to stop all services"
    Write-Host "========================================="

    while ($true) {
        if ($BackendProcess.HasExited) {
            [Console]::Error.WriteLine("Backend stopped unexpectedly.")
            exit 1
        }
        if ($FrontendProcess.HasExited) {
            [Console]::Error.WriteLine("Frontend stopped unexpectedly.")
            exit 1
        }
        Start-Sleep -Seconds 1
    }
} finally {
    if ($InFrontendDirectory) {
        Pop-Location
    }
    Stop-Services
}
