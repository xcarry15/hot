#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/www/wwwroot/hot.kfxz.cn}"
APP_NAME="${APP_NAME:-h2-hot2}"
SITE_URL="${SITE_URL:-https://hot.kfxz.cn}"
LOCAL_HEALTH_URL="${LOCAL_HEALTH_URL:-http://127.0.0.1:3011/api/health}"
BACKUP_ROOT="${BACKUP_ROOT:-/www/backup/h2-hot2}"
INITIALIZATION_COMPLETE=0

fail() {
  echo "错误：$*" >&2
  exit 1
}

on_error() {
  exit_code=$?
  trap - ERR
  echo
  if [[ "$INITIALIZATION_COMPLETE" -eq 1 ]]; then
    echo "应用已完成初始化并启动，但外部健康检查失败。请检查上方地址、Nginx、域名和证书。" >&2
  else
    echo "初始化失败，已停止后续操作。请修复上方错误后重新执行。" >&2
  fi
  pm2 status "$APP_NAME" 2>/dev/null || true
  exit "$exit_code"
}
trap on_error ERR

for command in node npm pm2 curl; do
  command -v "$command" >/dev/null || fail "缺少命令：$command"
done

node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 20 || (major === 20 && minor >= 9) ? 0 : 1)" \
  || fail "Node.js 版本必须 >= 20.9.0，当前为 $(node --version)"
npm_version="$(npm --version)"
npm_major="${npm_version%%.*}"
[[ "$npm_major" =~ ^[0-9]+$ ]] && (( npm_major >= 10 )) \
  || fail "npm 版本必须 >= 10，当前为 $npm_version"

[[ -d "$APP_DIR" ]] || fail "项目目录不存在：$APP_DIR"
cd "$APP_DIR"

[[ -f package.json ]] || fail "项目根目录缺少 package.json，请重新解压部署包"
[[ -f package-lock.json ]] || fail "项目根目录缺少 package-lock.json，请重新打包并解压到正确目录"
[[ -f .env ]] || fail "缺少生产 .env；请先恢复或创建 .env，再执行初始化"

grep -Eq "^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*['\"]?file:\.\./db/custom\.db['\"]?[[:space:]]*$" .env \
  || fail ".env 中 DATABASE_URL 必须为 file:../db/custom.db"
grep -Eq '^[[:space:]]*API_TOKEN[[:space:]]*=[[:space:]]*[^[:space:]]+' .env \
  || fail ".env 中 API_TOKEN 不能为空"
grep -Eq '^[[:space:]]*NEXT_PUBLIC_SITE_URL[[:space:]]*=[[:space:]]*https?://' .env \
  || fail ".env 中 NEXT_PUBLIC_SITE_URL 必须是完整站点地址"

if [[ "${CONFIRM_RESET:-}" != "YES" ]]; then
  [[ -t 0 ]] || fail "非交互执行时必须显式设置 CONFIRM_RESET=YES"
  echo
  echo "警告：该操作会停止 $APP_NAME，删除现有 SQLite、node_modules 和 .next，随后从零初始化生产项目。"
  read -r -p "请输入 RESET 确认继续：" confirmation || fail "未收到确认输入"
  [[ "$confirmation" == "RESET" ]] || { echo "已取消。"; exit 0; }
fi

echo "[1/8] 停止并移除旧 PM2 应用"
pm2 stop "$APP_NAME" >/dev/null 2>&1 || true
pm2 delete "$APP_NAME" >/dev/null 2>&1 || true

if [[ -s db/custom.db ]]; then
  command -v sqlite3 >/dev/null || fail "现有数据库需要备份，但服务器缺少 sqlite3"
  backup_dir="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)-before-reset"
  echo "[2/8] 备份旧数据库到 $backup_dir"
  umask 077
  mkdir -p "$backup_dir"
  sqlite3 db/custom.db ".timeout 5000" ".backup '$backup_dir/custom.db'"
  [[ -s "$backup_dir/custom.db" ]] || fail "数据库备份无效，停止初始化"
  cp -a db/custom.db-wal db/custom.db-shm "$backup_dir/" 2>/dev/null || true
else
  echo "[2/8] 未发现旧数据库，跳过备份"
fi

echo "[3/8] 清理旧数据库、依赖和构建产物"
rm -rf -- .next node_modules
mkdir -p db
rm -f -- db/custom.db db/custom.db-journal db/custom.db-wal db/custom.db-shm

echo "[4/8] 按 package-lock.json 全新安装依赖"
npm ci

echo "[5/8] 创建数据库并生成 Prisma Client"
npm run db:migrate:deploy
npm run db:generate

echo "[6/8] 写入种子数据并优化 SQLite"
npm run db:seed
npm run db:optimize
npm run db:migrate:status

echo "[7/8] 创建生产构建"
npm run build

echo "[8/8] 以单实例启动 PM2"
pm2 start npm --name "$APP_NAME" -- start
pm2 save
INITIALIZATION_COMPLETE=1

if ! curl --fail --silent --show-error \
  --retry 10 --retry-delay 3 --retry-connrefused \
  "$LOCAL_HEALTH_URL" >/dev/null; then
  pm2 logs "$APP_NAME" --lines 80 --nostream || true
  fail "本机健康检查失败：$LOCAL_HEALTH_URL"
fi

if [[ -n "$SITE_URL" ]]; then
  if ! curl --fail --silent --show-error \
    --retry 5 --retry-delay 3 --retry-connrefused \
    "${SITE_URL%/}/api/health" >/dev/null; then
    fail "正式域名健康检查失败：${SITE_URL%/}/api/health；本机服务已启动，请检查 Nginx、域名和证书"
  fi
fi

echo
echo "初始化完成：${SITE_URL:-$LOCAL_HEALTH_URL}"
echo "PM2 应用：$APP_NAME（单实例）"
