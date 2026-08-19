'use strict';

const { spawnSync, spawn } = require('node:child_process');

const { apiKey, saveApiKey } = require('./store');

// ---------------------------------------------------------------------------
// 平台命令构建器（纯函数，无 I/O）：同步版与异步版共用同一套命令与文案。
// ---------------------------------------------------------------------------

function apiKeyPromptCommands(platform) {
  if (platform === 'darwin') {
    return [{
      command: 'osascript',
      args: ['-e', 'text returned of (display dialog "请输入个人 IsingQ API Key。Key 只保存在本机，不会发送给 Agent。" default answer "" with title "IsingQ MCP 配置" with hidden answer buttons {"取消", "保存"} default button "保存" cancel button "取消")'],
      allowMissing: false,
    }];
  }
  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$f=New-Object System.Windows.Forms.Form',
      '$f.Text="IsingQ MCP 配置"',
      '$f.Size=New-Object System.Drawing.Size(480,180)',
      '$f.StartPosition="CenterScreen"',
      '$f.TopMost=$true',
      '$l=New-Object System.Windows.Forms.Label',
      '$l.Text="请输入个人 IsingQ API Key。Key 只保存在本机。"',
      '$l.AutoSize=$true',
      '$l.Location=New-Object System.Drawing.Point(20,20)',
      '$f.Controls.Add($l)',
      '$b=New-Object System.Windows.Forms.TextBox',
      '$b.UseSystemPasswordChar=$true',
      '$b.Size=New-Object System.Drawing.Size(420,24)',
      '$b.Location=New-Object System.Drawing.Point(20,55)',
      '$f.Controls.Add($b)',
      '$ok=New-Object System.Windows.Forms.Button',
      '$ok.Text="保存"',
      '$ok.DialogResult=[System.Windows.Forms.DialogResult]::OK',
      '$ok.Location=New-Object System.Drawing.Point(280,95)',
      '$f.Controls.Add($ok)',
      '$f.AcceptButton=$ok',
      '$cancel=New-Object System.Windows.Forms.Button',
      '$cancel.Text="取消"',
      '$cancel.DialogResult=[System.Windows.Forms.DialogResult]::Cancel',
      '$cancel.Location=New-Object System.Drawing.Point(365,95)',
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
      { command: 'zenity', args: ['--password', '--title=IsingQ MCP 配置'], allowMissing: true },
      { command: 'kdialog', args: ['--password', '请输入个人 IsingQ API Key。Key 只保存在本机。'], allowMissing: true },
      { command: 'systemd-ask-password', args: ['--no-tty', '请输入个人 IsingQ API Key：'], allowMissing: true },
    ];
  }
  return null;
}

function confirmationCommands(platform, message) {
  if (platform === 'darwin') {
    return [{
      command: 'osascript',
      args: ['-e', 'on run argv', '-e', 'display dialog (item 1 of argv) with title "IsingQ 求解确认" buttons {"取消", "确认提交"} default button "确认提交" cancel button "取消"', '-e', 'end run', message],
      allowMissing: false,
    }];
  }
  if (platform === 'win32') {
    const encoded = Buffer.from(message, 'utf8').toString('base64');
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$m=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[0]))',
      '$r=[System.Windows.Forms.MessageBox]::Show($m,"IsingQ 求解确认",[System.Windows.Forms.MessageBoxButtons]::OKCancel,[System.Windows.Forms.MessageBoxIcon]::Question)',
      'if($r -ne [System.Windows.Forms.DialogResult]::OK){exit 2}',
    ].join(';');
    return [{ command: 'powershell', args: ['-NoProfile', '-STA', '-Command', script, encoded], allowMissing: false }];
  }
  if (platform === 'linux') {
    return [
      { command: 'zenity', args: ['--question', '--title=IsingQ 求解确认', `--text=${message}`, '--ok-label=确认提交', '--cancel-label=取消'], allowMissing: true },
      { command: 'kdialog', args: ['--title', 'IsingQ 求解确认', '--yesno', message, '--yes-label', '确认提交', '--no-label', '取消'], allowMissing: true },
    ];
  }
  return null;
}

// ---------------------------------------------------------------------------
// 同步执行（spawnSync）：供 MCP server（子进程）与既有测试使用。
// ---------------------------------------------------------------------------

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

function runConfirmation(command, args, { environment, spawn = spawnSync, allowMissing = false }) {
  const result = spawn(command, args, {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  if (result.error?.code === 'ENOENT' && allowMissing) return null;
  if (result.error) throw new Error(`无法打开 IsingQ 求解确认框（command=${command}, error=${result.error.message}）`);
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// 异步执行（spawn）：供原生 DSH 插件进程内调用，不阻塞 Host 事件循环。
// ---------------------------------------------------------------------------

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

function runConfirmationAsync(command, args, { environment, allowMissing = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    child.stdout.resume();
    child.stderr.resume();
    const fail = (message) => { if (!settled) { settled = true; reject(new Error(message)); } };
    child.on('error', (error) => {
      if (error.code === 'ENOENT' && allowMissing) { if (!settled) { settled = true; resolve(null); } }
      else fail(`无法打开 IsingQ 求解确认框（command=${command}, error=${error.message}）`);
    });
    child.on('close', (status) => { if (!settled) { settled = true; resolve(status === 0); } });
  });
}

// ---------------------------------------------------------------------------
// 对外函数：同步版（保持原签名/行为）与异步版。
// ---------------------------------------------------------------------------

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

function configureApiKey({
  force = false,
  environment = process.env,
  prompt = () => promptApiKey({ environment }),
} = {}) {
  if (!force) {
    try {
      apiKey(environment);
      return { configured: true, status: 'already_configured' };
    } catch (_) {
      // Continue to the OS-native private prompt.
    }
  }
  saveApiKey(prompt(), environment);
  apiKey(environment);
  return { configured: true, status: 'configured' };
}

async function configureApiKeyAsync({
  force = false,
  environment = process.env,
  prompt = () => promptApiKeyAsync({ environment }),
} = {}) {
  if (!force) {
    try {
      apiKey(environment);
      return { configured: true, status: 'already_configured' };
    } catch (_) {
      // Continue to the OS-native private prompt.
    }
  }
  saveApiKey(await prompt(), environment);
  apiKey(environment);
  return { configured: true, status: 'configured' };
}

function confirmationMessage(request) {
  const summary = String(request.model_summary || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  return [
    '即将使用你本机保存的 IsingQ API Key 提交远端求解。',
    '',
    `模型：${summary}`,
    `变量数：${request.num_bits}`,
    `矩阵 SHA-256：${request.matrix_sha256}`,
    `计算次数：${request.calculate_count}`,
    `使用积分：${request.use_credit ? '是' : '否'}`,
    '',
    '确认提交吗？',
  ].join('\n');
}

function confirmSolve(request, {
  platform = process.platform,
  environment = process.env,
  spawn = spawnSync,
} = {}) {
  const message = confirmationMessage(request);
  const commands = confirmationCommands(platform, message);
  if (!commands) throw new Error(`不支持的求解确认平台（platform=${platform}）；尚未提交求解`);
  for (const { command, args, allowMissing } of commands) {
    const confirmed = runConfirmation(command, args, { environment, spawn, allowMissing });
    if (confirmed !== null) return confirmed;
  }
  throw new Error('未找到 Linux 图形确认组件（需要 zenity 或 kdialog）；尚未提交求解');
}

async function confirmSolveAsync(request, {
  platform = process.platform,
  environment = process.env,
} = {}) {
  const message = confirmationMessage(request);
  const commands = confirmationCommands(platform, message);
  if (!commands) throw new Error(`不支持的求解确认平台（platform=${platform}）；尚未提交求解`);
  for (const { command, args, allowMissing } of commands) {
    const confirmed = await runConfirmationAsync(command, args, { environment, allowMissing });
    if (confirmed !== null) return confirmed;
  }
  throw new Error('未找到 Linux 图形确认组件（需要 zenity 或 kdialog）；尚未提交求解');
}

module.exports = {
  configureApiKey,
  configureApiKeyAsync,
  confirmSolve,
  confirmSolveAsync,
  confirmationMessage,
  promptApiKey,
  promptApiKeyAsync,
};
