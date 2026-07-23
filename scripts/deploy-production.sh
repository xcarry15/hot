#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/www/wwwroot/hot.kfxz.cn}"
RELEASE_ARCHIVE="${RELEASE_ARCHIVE:?RELEASE_ARCHIVE is required}"
APP_NAME="${APP_NAME:-h2-hot2}"
SITE_URL="${SITE_URL:-https://hot.kfxz.cn}"
BACKUP_ROOT="${BACKUP_ROOT:-/www/backup/h2-hot2}"
RELEASE_DIR="$(mktemp -d /tmp/h2-hot2-release.XXXXXX)"
SERVICE_WAS_RUNNING=0
DEPLOY_SUCCEEDED=0

cleanup() {
  rm -rf -- "$RELEASE_DIR"
  rm -f -- "$RELEASE_ARCHIVE"
  if [[ "$DEPLOY_SUCCEEDED" -ne 1 && "$SERVICE_WAS_RUNNING" -eq 1 ]]; then
    pm2 start "$APP_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for command in node npm pm2 sqlite3 rsync tar curl; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done

[[ -d "$APP_DIR" ]] || { echo "Application directory does not exist: $APP_DIR" >&2; exit 1; }
[[ -f "$RELEASE_ARCHIVE" ]] || { echo "Release archive does not exist: $RELEASE_ARCHIVE" >&2; exit 1; }
[[ -f "$APP_DIR/.env" ]] || { echo "Production .env is missing: $APP_DIR/.env" >&2; exit 1; }
[[ -f "$APP_DIR/db/custom.db" ]] || { echo "Production database is missing: $APP_DIR/db/custom.db" >&2; exit 1; }

tar -xzf "$RELEASE_ARCHIVE" -C "$RELEASE_DIR"
[[ -f "$RELEASE_DIR/package.json" ]] || { echo 'Release archive is invalid' >&2; exit 1; }

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  SERVICE_WAS_RUNNING=1
  pm2 stop "$APP_NAME"
fi

if [[ "$SERVICE_WAS_RUNNING" -ne 1 ]]; then
  echo "PM2 application is not registered: $APP_NAME" >&2
  exit 1
fi

backup_dir="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
sqlite3 "$APP_DIR/db/custom.db" ".timeout 5000" ".backup '$backup_dir/custom.db'"
cp -a "$APP_DIR/db/custom.db-wal" "$APP_DIR/db/custom.db-shm" "$backup_dir/" 2>/dev/null || true

rsync -a --delete \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='db/' \
  --exclude='node_modules/' \
  "$RELEASE_DIR/" "$APP_DIR/"

cd "$APP_DIR"
npm ci
npm run db:migrate:deploy
npm run db:generate
npm run db:optimize

# The public feed sort migration added persisted snapshot fields with empty
# defaults. Rebuild only when an existing published Event still has the old
# empty snapshot, so normal deployments do not rescan the whole article set.
PUBLIC_REBUILD_NEEDED="$(sqlite3 "$APP_DIR/db/custom.db" "SELECT CASE WHEN EXISTS (SELECT 1 FROM events WHERE publicStatus = 'published' AND (publicDateKey = '' OR publicSortAt IS NULL)) THEN 1 ELSE 0 END;")"
if [[ "$PUBLIC_REBUILD_NEEDED" == "1" ]]; then
  echo "检测到旧公开发布快照，执行一次 db:rebuild-public"
  npm run db:rebuild-public
fi

npm run build

pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
pm2 start npm --name "$APP_NAME" -- start
pm2 save

curl --fail --silent --show-error --retry 10 --retry-delay 3 "$SITE_URL/api/health" >/dev/null
DEPLOY_SUCCEEDED=1
echo "Deployment completed: $SITE_URL"
