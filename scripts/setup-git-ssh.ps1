<#
.SYNOPSIS
  在任意机器上配置 jdbc-mcp-guard 仓库的 Git over SSH（适配 github.com:443 被墙的网络）。
.DESCRIPTION
  生成/复用一把仓库专用 deploy key，写入 ~/.ssh/config，并打印需要添加到 GitHub 的公钥。
  私钥永远不进 git；每台机器各用一把 key（同一仓库可以挂多把 deploy key）。
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/setup-git-ssh.ps1
#>
param(
  [string]$KeyPath = $env:USERPROFILE + '\.ssh\jdbc_mcp_guard_deploy',
  [string]$Repo = 'lyb-java/jdbc-mcp-guard'
)
$ErrorActionPreference = 'Stop'

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  throw '未找到 ssh，请先安装 Git for Windows 或启用 OpenSSH 客户端。'
}
$dir = Split-Path $KeyPath -Parent
New-Item -ItemType Directory -Force -Path $dir | Out-Null

if (-not (Test-Path $KeyPath)) {
  Write-Host ('生成 deploy key: ' + $KeyPath) -ForegroundColor Yellow
  ssh-keygen -t ed25519 -N '""' -C ('jdbc-mcp-guard deploy (' + $env:COMPUTERNAME + ')') -f $KeyPath
} else {
  Write-Host ('复用已有 deploy key: ' + $KeyPath) -ForegroundColor Yellow
}

$pub = (Get-Content ($KeyPath + '.pub') -Raw).Trim()
$cfg = Join-Path $env:USERPROFILE '.ssh\config'
$existing = if (Test-Path $cfg) { Get-Content $cfg -Raw } else { '' }
if ($existing -notmatch 'Host\s+ssh\.github\.com') {
  $keyFwd = $KeyPath -replace '\\', '/'
  $nl = [Environment]::NewLine
  $block = $nl + 'Host ssh.github.com' + $nl + '  HostName ssh.github.com' + $nl + '  Port 443' + $nl + '  User git' + $nl + '  IdentityFile ' + $keyFwd + $nl + '  IdentitiesOnly yes' + $nl
  Add-Content -Path $cfg -Value $block
  Write-Host ('已写入 ' + $cfg) -ForegroundColor Yellow
} else {
  Write-Host '~/.ssh/config 已有 ssh.github.com 配置，跳过' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '=== 1) 把这把公钥加到仓库（Settings -> Deploy keys -> Add deploy key，勾选 Allow write access）===' -ForegroundColor Cyan
Write-Host $pub
Write-Host ''
Write-Host '或者在本机已登录 gh 且 token 有 repo scope 时，直接：' -ForegroundColor Cyan
Write-Host ('  gh api -X POST /repos/' + $Repo + '/keys -f title="' + $env:COMPUTERNAME + ' deploy" -f key="' + $pub + '" -F read_only=false')
Write-Host ''
Write-Host '=== 2) 验证 ===' -ForegroundColor Cyan
Write-Host '  ssh -T git@ssh.github.com'
Write-Host ''
Write-Host '=== 3) 克隆 / 推送 ===' -ForegroundColor Cyan
Write-Host ('  git clone ssh://git@ssh.github.com:443/' + $Repo + '.git')
