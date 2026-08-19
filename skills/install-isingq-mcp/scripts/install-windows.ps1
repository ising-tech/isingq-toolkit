$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$InstallPrefix = if ($env:ISINGQ_MCP_NPM_PREFIX) { $env:ISINGQ_MCP_NPM_PREFIX } else { Join-Path $env:LOCALAPPDATA 'Programs\isingq-mcp-node' }
$Target = Join-Path $InstallPrefix 'isingq-mcp.cmd'
$TargetHost = $env:ISINGQ_MCP_TARGET_HOST
$AutomaticHosts = @('workbuddy', 'codex', 'claude-code', 'cursor', 'vscode')
if ([string]::IsNullOrWhiteSpace($TargetHost)) {
    @{ distribution_mode = 'source'; runtime_available = $false; api_key_configured = $false; host_registered = $false; tools_loaded = $false; loaded_version = $null; blocked_by = 'target_host_required'; next_action = '设置 ISINGQ_MCP_TARGET_HOST' } | ConvertTo-Json -Compress
    exit 2
}
if (($AutomaticHosts -notcontains $TargetHost) -and ($TargetHost -notin @('trae', 'generic'))) {
    throw "不支持的目标 Host（host=$TargetHost）"
}

$PreviousSkip = $env:ISINGQ_MCP_SKIP_ONBOARD
$PreviousPrefix = $env:ISINGQ_MCP_NPM_PREFIX
try {
    $env:ISINGQ_MCP_SKIP_ONBOARD = '1'
    try {
        $env:ISINGQ_MCP_NPM_PREFIX = $InstallPrefix
        & (Join-Path $RepoRoot 'install\install.ps1')
    } catch {
        @{ distribution_mode = 'source'; runtime_available = $false; api_key_configured = $false; host_registered = $false; tools_loaded = $false; loaded_version = $null; blocked_by = 'local_source_install_failed'; next_action = '确认本机存在 Node.js 18+、npm，并批准写入用户安装目录' } | ConvertTo-Json -Compress
        throw
    }
} finally {
    $env:ISINGQ_MCP_SKIP_ONBOARD = $PreviousSkip
    $env:ISINGQ_MCP_NPM_PREFIX = $PreviousPrefix
}

$LoadedVersion = ((& $Target --version).Trim() -replace '^isingq-mcp\s+', '')
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($LoadedVersion)) {
    throw "无法读取 isingq-mcp 版本（path=$Target, exit=$LASTEXITCODE）"
}

& $Target self-check --json *> $null
if ($LASTEXITCODE -ne 0) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $Form = New-Object System.Windows.Forms.Form
    $Form.Text = 'IsingQ MCP 配置'
    $Form.Size = New-Object System.Drawing.Size(480, 180)
    $Form.StartPosition = 'CenterScreen'
    $Form.TopMost = $true

    $Label = New-Object System.Windows.Forms.Label
    $Label.Text = '请输入个人 IsingQ API Key。Key 只保存在本机，不会发送给 Agent。'
    $Label.AutoSize = $true
    $Label.Location = New-Object System.Drawing.Point(20, 20)
    $Form.Controls.Add($Label)

    $PasswordBox = New-Object System.Windows.Forms.TextBox
    $PasswordBox.UseSystemPasswordChar = $true
    $PasswordBox.Size = New-Object System.Drawing.Size(420, 24)
    $PasswordBox.Location = New-Object System.Drawing.Point(20, 55)
    $Form.Controls.Add($PasswordBox)

    $SaveButton = New-Object System.Windows.Forms.Button
    $SaveButton.Text = '保存'
    $SaveButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $SaveButton.Location = New-Object System.Drawing.Point(280, 95)
    $Form.Controls.Add($SaveButton)
    $Form.AcceptButton = $SaveButton

    $CancelButton = New-Object System.Windows.Forms.Button
    $CancelButton.Text = '取消'
    $CancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $CancelButton.Location = New-Object System.Drawing.Point(365, 95)
    $Form.Controls.Add($CancelButton)
    $Form.CancelButton = $CancelButton

    if ($Form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { throw '用户取消 IsingQ API Key 配置' }
    $Key = $PasswordBox.Text
    if ([string]::IsNullOrWhiteSpace($Key)) { throw 'IsingQ API Key 不能为空' }
    $Key | & $Target setup --stdin
    if ($LASTEXITCODE -ne 0) {
        $Key = $null
        @{ distribution_mode = 'source'; runtime_available = $true; api_key_configured = $false; host_registered = $false; tools_loaded = $false; loaded_version = $LoadedVersion; blocked_by = 'key_config_write_denied'; next_action = '批准 Agent 写入本机私有配置目录后重试' } | ConvertTo-Json -Compress
        exit 1
    }
    $Key = $null
    $PasswordBox.Clear()
}

& $Target self-check --json
if ($LASTEXITCODE -ne 0) { throw "isingq-mcp 自检失败（exit_code=$LASTEXITCODE）" }
if ($AutomaticHosts -contains $TargetHost) {
    & $Target configure-host --name $TargetHost
    if ($LASTEXITCODE -ne 0) {
        & $Target config --json
        @{ distribution_mode = 'source'; runtime_available = $true; api_key_configured = $true; host_registered = $false; tools_loaded = $false; loaded_version = $LoadedVersion; blocked_by = 'host_config_write_denied'; next_action = '批准 Host 配置写入或通过 MCP 设置导入上方 stdio 配置' } | ConvertTo-Json -Compress
        exit 2
    }
    @{ distribution_mode = 'source'; runtime_available = $true; api_key_configured = $true; host_registered = $true; tools_loaded = $false; loaded_version = $LoadedVersion; blocked_by = $null; next_action = "先重连 $TargetHost 的 isingq 连接器；不支持动态重载或工具未更新时再重启" } | ConvertTo-Json -Compress
} else {
    & $Target config --json
    @{ distribution_mode = 'source'; runtime_available = $true; api_key_configured = $true; host_registered = $false; tools_loaded = $false; loaded_version = $LoadedVersion; blocked_by = $null; next_action = "通过 $TargetHost 的 MCP 设置导入上方 stdio 配置" } | ConvertTo-Json -Compress
}
