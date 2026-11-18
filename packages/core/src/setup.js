'use strict';

const { spawnSync, spawn } = require('node:child_process');

const { apiKey, saveApiKey } = require('./store');
const { normalizeSetupResult } = require('./effect-evidence');

const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
const PROMPT_MAX_BYTES = 64 * 1024;

function promptDeadline(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new Error('安全输入 timeoutMs 必须是 1 到 2147483647 的整数毫秒数；请修正配置后重试');
  }
  return timeoutMs;
}

function promptFailure(command, kind, timeoutMs) {
  if (kind === 'timeout') return new Error(`IsingQ API Key 安全输入超时（command=${command}, timeout_ms=${timeoutMs}）；请重新配置并及时完成输入`);
  if (kind === 'size') return new Error(`IsingQ API Key 安全输入输出超过上限（command=${command}, max_bytes=${PROMPT_MAX_BYTES}）；请核对安全输入组件`);
  return new Error(`IsingQ API Key 安全输入被取消或失败（command=${command}）；请重新配置或检查本机安全输入组件`);
}

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

function runPrompt(command, args, { environment, spawn = spawnSync, allowMissing = false, timeoutMs }) {
  let result;
  try { result = spawn(command, args, {
    encoding: 'utf8',
    env: environment,
    maxBuffer: PROMPT_MAX_BYTES,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    windowsHide: true,
  }); } catch { throw promptFailure(command); }
  if (result.error?.code === 'ENOENT' && allowMissing) return null;
  if (result.error?.code === 'ETIMEDOUT') throw promptFailure(command, 'timeout', timeoutMs);
  if (result.error?.code === 'ENOBUFS') throw promptFailure(command, 'size', timeoutMs);
  if (result.error || result.status !== 0) {
    throw promptFailure(command);
  }
  const value = String(result.stdout || '').trim();
  if (!value) throw new Error('IsingQ API Key 安全输入为空');
  return value;
}

// 异步执行供原生 DSH Plugin 使用，避免阻塞 Host 事件循环。

function runPromptAsync(command, args, { environment, allowMissing = false, spawn: start = spawn, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = start(command, args, { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { reject(promptFailure(command)); return; }
    let settled = false;
    let stdout = '';
    let bytes = 0;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout = '';
      child.stdout.removeListener('data', receive);
      child.stdout.resume();
      if (error) reject(error); else resolve(value);
    };
    const stop = kind => {
      if (settled) return;
      // Reject independently of close: a failed kill or a faulty component must
      // not leave the tool pending, and private output never enters diagnostics.
      finish(promptFailure(command, kind, timeoutMs));
      try { child.kill('SIGKILL'); } catch { /* The deadline error remains primary. */ }
    };
    const receive = chunk => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > PROMPT_MAX_BYTES) stop('size');
      else stdout += chunk;
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', receive);
    child.stdout.on('error', () => stop('failed'));
    child.stderr.on('error', () => stop('failed'));
    child.stderr.resume();
    child.on('error', (error) => {
      if (error.code === 'ENOENT' && allowMissing) finish(null, null);
      else finish(promptFailure(command));
    });
    child.on('close', (status) => {
      if (settled) return;
      if (status !== 0) finish(promptFailure(command));
      else {
        const value = stdout.trim();
        if (!value) finish(new Error('IsingQ API Key 安全输入为空'));
        else finish(null, value);
      }
    });
  });
}

function promptApiKey({
  platform = process.platform,
  environment = process.env,
  spawn = spawnSync,
  timeoutMs = PROMPT_TIMEOUT_MS,
} = {}) {
  promptDeadline(timeoutMs);
  const commands = apiKeyPromptCommands(platform);
  if (!commands) throw new Error(`不支持的 API Key 安全输入平台（platform=${platform}）`);
  for (const { command, args, allowMissing } of commands) {
    const value = runPrompt(command, args, { environment, spawn, allowMissing, timeoutMs });
    if (value !== null) return value;
  }
  throw new Error('未找到 Linux 安全输入组件（需要 zenity、kdialog 或 systemd-ask-password）');
}

async function promptApiKeyAsync({ platform = process.platform, environment = process.env, spawn: start = spawn, timeoutMs = PROMPT_TIMEOUT_MS } = {}) {
  promptDeadline(timeoutMs);
  const commands = apiKeyPromptCommands(platform);
  if (!commands) throw new Error(`不支持的 API Key 安全输入平台（platform=${platform}）`);
  for (const { command, args, allowMissing } of commands) {
    const value = await runPromptAsync(command, args, { environment, allowMissing, spawn: start, timeoutMs });
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
  timeoutMs = PROMPT_TIMEOUT_MS,
  prompt = () => promptApiKey({ environment, timeoutMs }),
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
  timeoutMs = PROMPT_TIMEOUT_MS,
  prompt = () => promptApiKeyAsync({ environment, timeoutMs }),
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
