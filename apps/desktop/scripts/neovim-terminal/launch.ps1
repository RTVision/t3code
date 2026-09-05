param(
  [Parameter(Mandatory=$true)][string]$Runtime,
  [Parameter(Mandatory=$true)][string]$Token
)

$ErrorActionPreference = 'Stop'
try {
  if ($Token -cnotmatch '^[A-Za-z0-9_-]+$' -or $Token.Length -gt 21846) {
    throw 'Invalid terminal-editor payload.'
  }
  # The packaged Electron executable supplies Node; no separate Windows runtime is required.
  $env:ELECTRON_RUN_AS_NODE = '1'
  # Start-Process waits for Electron's GUI-subsystem executable without
  # PowerShell competing with the child for console input.
  $helper = Join-Path $PSScriptRoot 'session.mjs'
  $child = Start-Process -FilePath $Runtime -ArgumentList @(('"' + $helper + '"'), $Token) -NoNewWindow -Wait -PassThru
  if ($child.ExitCode -ne 0) {
    throw "The editor session exited with code $($child.ExitCode)."
  }
} catch {
  Write-Host $_ -ForegroundColor Red
  Read-Host 'Press Enter to close this window'
  exit 1
}
