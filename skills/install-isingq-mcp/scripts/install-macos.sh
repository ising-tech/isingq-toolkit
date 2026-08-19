#!/bin/sh
set -eu
set +x
umask 077

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
INSTALL_PREFIX=${ISINGQ_MCP_NPM_PREFIX:-${XDG_DATA_HOME:-"$HOME/.local"}}
MCP_BIN="$INSTALL_PREFIX/bin/isingq-mcp"
TARGET_HOST=${ISINGQ_MCP_TARGET_HOST:-}

command -v osascript >/dev/null 2>&1 || { printf '缺少 macOS 安全输入组件 osascript。\n' >&2; exit 1; }
case "$TARGET_HOST" in
  workbuddy|codex|claude-code|cursor|vscode) registration=automatic ;;
  trae|generic) registration=manual ;;
  '') printf '{"distribution_mode":"source","runtime_available":false,"api_key_configured":false,"host_registered":false,"tools_loaded":false,"loaded_version":null,"blocked_by":"target_host_required","next_action":"设置 ISINGQ_MCP_TARGET_HOST"}\n' >&2; exit 2 ;;
  *) printf '不支持的目标 Host（host=%s）\n' "$TARGET_HOST" >&2; exit 2 ;;
esac

if ! ISINGQ_MCP_SKIP_ONBOARD=1 ISINGQ_MCP_NPM_PREFIX="$INSTALL_PREFIX" sh "$REPO_ROOT/install/install.sh"; then
  printf '{"distribution_mode":"source","runtime_available":false,"api_key_configured":false,"host_registered":false,"tools_loaded":false,"loaded_version":null,"blocked_by":"local_source_install_failed","next_action":"确认本机存在 Node.js 18+、npm，并批准写入用户安装目录"}\n' >&2
  exit 1
fi

loaded_version=$("$MCP_BIN" --version)
loaded_version=${loaded_version#isingq-mcp }

if "$MCP_BIN" self-check --json >/dev/null 2>&1; then
  :
else
  key=$(osascript <<'APPLESCRIPT'
text returned of (display dialog "请输入个人 IsingQ API Key。Key 只保存在本机，不会发送给 Agent。" default answer "" with title "IsingQ MCP 配置" with hidden answer buttons {"取消", "保存"} default button "保存" cancel button "取消")
APPLESCRIPT
  )
  [ -n "$key" ] || { printf 'IsingQ API Key 不能为空。\n' >&2; exit 1; }
  if ! printf '%s\n' "$key" | "$MCP_BIN" setup --stdin; then
    key=''; unset key
    printf '{"distribution_mode":"source","runtime_available":true,"api_key_configured":false,"host_registered":false,"tools_loaded":false,"loaded_version":"%s","blocked_by":"key_config_write_denied","next_action":"批准 Agent 写入本机私有配置目录后重试"}\n' "$loaded_version" >&2
    exit 1
  fi
  key=''; unset key
fi
"$MCP_BIN" self-check --json
if [ "$registration" = automatic ]; then
  if ! "$MCP_BIN" configure-host --name "$TARGET_HOST"; then
    "$MCP_BIN" config --json
    printf '{"distribution_mode":"source","runtime_available":true,"api_key_configured":true,"host_registered":false,"tools_loaded":false,"loaded_version":"%s","blocked_by":"host_config_write_denied","next_action":"批准 Host 配置写入或通过 MCP 设置导入上方 stdio 配置"}\n' "$loaded_version" >&2
    exit 2
  fi
  printf '{"distribution_mode":"source","runtime_available":true,"api_key_configured":true,"host_registered":true,"tools_loaded":false,"loaded_version":"%s","blocked_by":null,"next_action":"先重连 %s 的 isingq 连接器；不支持动态重载或工具未更新时再重启"}\n' "$loaded_version" "$TARGET_HOST"
else
  "$MCP_BIN" config --json
  printf '{"distribution_mode":"source","runtime_available":true,"api_key_configured":true,"host_registered":false,"tools_loaded":false,"loaded_version":"%s","blocked_by":null,"next_action":"通过 %s 的 MCP 设置导入上方 stdio 配置"}\n' "$loaded_version" "$TARGET_HOST"
fi
