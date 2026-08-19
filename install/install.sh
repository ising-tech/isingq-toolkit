#!/bin/sh
set -eu
set +x
umask 077

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
INSTALL_PREFIX=${ISINGQ_MCP_NPM_PREFIX:-${XDG_DATA_HOME:-"$HOME/.local"}}
MCP_BIN="$INSTALL_PREFIX/bin/isingq-mcp"

fail() { printf 'isingq-mcp 安装失败：%s\n' "$1" >&2; exit 1; }
command -v node >/dev/null 2>&1 || fail "缺少 Node.js 18 或更高版本"
command -v npm >/dev/null 2>&1 || fail "缺少 npm"
node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
[ "$node_major" -ge 18 ] || fail "Node.js 版本过低（major=$node_major, required=18）"

printf '正在从本地源码安装 isingq-mcp（source=%s）...\n' "$REPO_ROOT"
npm install --global --prefix "$INSTALL_PREFIX" "$REPO_ROOT"
[ -x "$MCP_BIN" ] || fail "npm 安装完成但未找到命令（path=$MCP_BIN）"

printf 'isingq-mcp 已安装：%s\n' "$MCP_BIN"
if [ "${ISINGQ_MCP_SKIP_ONBOARD:-0}" = 1 ]; then
  printf '已跳过终端配置；请通过安全输入方式配置 Key，再只配置用户指定的目标 Host。\n'
elif [ -r /dev/tty ]; then
  printf '现在配置个人 IsingQ API Key。输入内容不会回显。\n'
  "$MCP_BIN" onboard </dev/tty
else
  printf '当前不是交互终端；请稍后运行：%s onboard\n' "$MCP_BIN"
fi
printf '安装配置完成；请重启对应 Agent Host。\n'
