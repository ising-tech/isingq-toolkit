'use strict';

const { spawnSync, spawn } = require('node:child_process');

const { apiKey, saveApiKey } = require('./store');
const { normalizeSetupResult } = require('./effect-evidence');

const API_KEY_PROMPT_LINES = [
  '官方控制台：https://console.isingq.com/',
  '登录后打开 API Key 入口：https://console.isingq.com/api-keys',
  '创建 API Key 并复制，然后粘贴到下方安全输入框。',
  '不要在对话中发送或粘贴 Key。Key 只保存在本机，不会发送给 Agent。',
];

// ---------------------------------------------------------------------------
// 平台命令构建器（纯函数，无 I/O）：同步版与异步版共用同一套 API Key 输入文案。
// ---------------------------------------------------------------------------

function apiKeyPromptCommands(platform) {
  if (platform === 'darwin') {
    return [{
      command: 'osascript',
      args: ['-e', `text returned of (display dialog (${API_KEY_PROMPT_LINES.map(line => JSON.stringify(line)).join(' & return & ')}) default answer "" with title "IsingQ MCP 配置" with hidden answer buttons {"取消", "保存"} default button "保存" cancel button "取消")`],
      allowMissing: false,
    }];
  }
  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$f=New-Object System.Windows.Forms.Form',
      '$f.Text="IsingQ MCP 配置"',
      '$f.Size=New-Object System.Drawing.Size(640,310)',
      '$f.StartPosition="CenterScreen"',
      '$f.TopMost=$true',
      '$l=New-Object System.Windows.Forms.Label',
      `$l.Text="${API_KEY_PROMPT_LINES.join('`r`n')}"`,
      '$l.AutoSize=$false',
      '$l.Size=New-Object System.Drawing.Size(590,150)',
      '$l.Location=New-Object System.Drawing.Point(20,20)',
      '$f.Controls.Add($l)',
      '$b=New-Object System.Windows.Forms.TextBox',
      '$b.UseSystemPasswordChar=$true',
      '$b.Size=New-Object System.Drawing.Size(590,24)',
      '$b.Location=New-Object System.Drawing.Point(20,190)',
      '$f.Controls.Add($b)',
      '$ok=New-Object System.Windows.Forms.Button',
      '$ok.Text="保存"',
      '$ok.DialogResult=[System.Windows.Forms.DialogResult]::OK',
      '$ok.Location=New-Object System.Drawing.Point(445,230)',
      '$f.Controls.Add($ok)',
      '$f.AcceptButton=$ok',
      '$cancel=New-Object System.Windows.Forms.Button',
      '$cancel.Text="取消"',
      '$cancel.DialogResult=[System.Windows.Forms.DialogResult]::Cancel',
      '$cancel.Location=New-Object System.Drawing.Point(535,230)',
      '$f.Controls.Add($cancel)',
      '$f.CancelButton=$cancel',
      'if($f.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK){exit 2}',
      '[Console]::Out.Write($b.Text)',
      '$b.Clear()',
    ].join(';');
    return [{ command: 'powershell', args: ['-NoProfile', '-STA', '-Command', script], allowMissing: false }];
  }
  if (platform === 'linux') {
    return [
      { command: 'zenity', args: ['--password', '--title=IsingQ MCP 配置', `--text=${API_KEY_PROMPT_LINES.join('\n')}`], allowMissing: true },
      { command: 'kdialog', args: ['--password', API_KEY_PROMPT_LINES.join('\n')], allowMissing: true },
      { command: 'systemd-ask-password', args: ['--no-tty', API_KEY_PROMPT_LINES.join('\n')], allowMissing: true },
    ];
  }
  return null;
}

// 同步执行供标准 MCP 使用。

function runPrompt(command, args, { environment, spawn = spawnSync, allowMissing = false }) {
  const result = spawn(command, args, {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  if (result.error?.code === 'ENOENT' && allowMissing) return null;
  if (result.error || result.status !== 0) {
    throw new Error(`IsingQ API Key 安全输入被取消或失败（command=${command}）`);
  }
  const value = String(result.stdout || '').trim();
  if (!value) throw new Error('IsingQ API Key 安全输入为空');
  return value;
}

// 异步执行供原生 DSH Plugin 使用，避免阻塞 Host 事件循环。

function runPromptAsync(command, args, { environment, allowMissing = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.resume();
    const fail = (message) => { if (!settled) { settled = true; reject(new Error(message)); } };
    child.on('error', (error) => {
      if (error.code === 'ENOENT' && allowMissing) { if (!settled) { settled = true; resolve(null); } }
      else fail(`IsingQ API Key 安全输入被取消或失败（command=${command}）`);
    });
    child.on('close', (status) => {
      if (status !== 0) fail(`IsingQ API Key 安全输入被取消或失败（command=${command}）`);
      else {
        const value = stdout.trim();
        if (!value) fail('IsingQ API Key 安全输入为空');
        else if (!settled) { settled = true; resolve(value); }
      }
    });
  });
}

function promptApiKey({
  platform = process.platform,
  environment = process.env,
  spawn = spawnSync,
} = {}) {
  const commands = apiKeyPromptCommands(platform);
  if (!commands) throw new Error(`不支持的 API Key 安全输入平台（platform=${platform}）`);
  for (const { command, args, allowMissing } of commands) {
    const value = runPrompt(command, args, { environment, spawn, allowMissing });
    if (value !== null) return value;
  }
  throw new Error('未找到 Linux 安全输入组件（需要 zenity、kdialog 或 systemd-ask-password）');
}

async function promptApiKeyAsync({ platform = process.platform, environment = process.env } = {}) {
  const commands = apiKeyPromptCommands(platform);
  if (!commands) throw new Error(`不支持的 API Key 安全输入平台（platform=${platform}）`);
  for (const { command, args, allowMissing } of commands) {
    const value = await runPromptAsync(command, args, { environment, allowMissing });
    if (value !== null) return value;
  }
  throw new Error('未找到 Linux 安全输入组件（需要 zenity、kdialog 或 systemd-ask-password）');
}

function localSetupResult(status) {
  return normalizeSetupResult({ configured: true, status, execution_mode: 'live', credential_effect: status === 'configured' ? 'written' : 'already_present', remote_verification: 'unverified', no_real_credentials: false, credential_presence: 'available' });
}

function configureApiKey({
  force = false,
  environment = process.env,
  prompt = () => promptApiKey({ environment }),
} = {}) {
  if (!force) {
    try {
      apiKey(environment);
      return localSetupResult('already_configured');
    } catch (_) {
      // Continue to the OS-native private prompt.
    }
  }
  saveApiKey(prompt(), environment);
  apiKey(environment);
  return localSetupResult('configured');
}

async function configureApiKeyAsync({
  force = false,
  environment = process.env,
  prompt = () => promptApiKeyAsync({ environment }),
} = {}) {
  if (!force) {
    try {
      apiKey(environment);
      return localSetupResult('already_configured');
    } catch (_) {
      // Continue to the OS-native private prompt.
    }
  }
  saveApiKey(await prompt(), environment);
  apiKey(environment);
  return localSetupResult('configured');
}

module.exports = {
  configureApiKey,
  configureApiKeyAsync,
  promptApiKey,
  promptApiKeyAsync,
};
