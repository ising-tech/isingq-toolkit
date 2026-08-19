$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$InstallPrefix = if ($env:ISINGQ_MCP_NPM_PREFIX) { $env:ISINGQ_MCP_NPM_PREFIX } else { Join-Path $env:LOCALAPPDATA 'Programs\isingq-mcp-node' }
$Target = Join-Path $InstallPrefix 'isingq-mcp.cmd'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '缺少 Node.js 18 或更高版本' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw '缺少 npm' }
$NodeMajor = [int]((& node -p 'Number(process.versions.node.split(".")[0])').Trim())
if ($NodeMajor -lt 18) { throw "Node.js 版本过低（major=$NodeMajor, required=18）" }

Write-Host "正在从本地源码安装 isingq-mcp（source=$RepoRoot）..."
& npm install --global --prefix $InstallPrefix $RepoRoot
if ($LASTEXITCODE -ne 0) { throw "npm 安装失败（exit=$LASTEXITCODE, source=$RepoRoot）" }
if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { throw "npm 安装完成但未找到命令（path=$Target）" }

Write-Host "isingq-mcp 已安装：$Target"
if ($env:ISINGQ_MCP_SKIP_ONBOARD -eq '1') {
    Write-Host '已跳过终端配置；请通过安全输入方式配置 Key，再只配置用户指定的目标 Host。'
} else {
    Write-Host '现在配置个人 IsingQ API Key。输入内容不会回显。'
    & $Target onboard
    if ($LASTEXITCODE -ne 0) { throw "onboard 失败（exit=$LASTEXITCODE）" }
}
Write-Host '安装配置完成；请重启对应 Agent Host。'
