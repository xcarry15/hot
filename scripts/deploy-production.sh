#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/www/wwwroot/hot.kfxz.cn}"
RELEASE_ARCHIVE="${RELEASE_ARCHIVE:?RELEASE_ARCHIVE is required}"
APP_NAME="${APP_NAME:-h2-hot2}"
SITE_URL="${SITE_URL:-https://hot.kfxz.cn}"
BACKUP_ROOT="${BACKUP_ROOT:-/www/backup/h2-hot2}"
RESET_PRODUCTION="${RESET_PRODUCTION:-NO}"
RESET_PRODUCTION="${RESET_PRODUCTION^^}"
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
[[ "$RESET_PRODUCTION" == "YES" || "$RESET_PRODUCTION" == "NO" ]] \
  || { echo 'RESET_PRODUCTION must be YES or NO.' >&2; exit 1; }
grep -Eq '^[[:space:]]*API_TOKEN[[:space:]]*=[[:space:]]*[^[:space:]]+' "$APP_DIR/.env" \
  || { echo 'Production API_TOKEN is missing or empty.' >&2; exit 1; }
grep -Eq '^[[:space:]]*SETTINGS_ENCRYPTION_KEY[[:space:]]*=[[:space:]]*[^[:space:]]+' "$APP_DIR/.env" \
  || { echo 'Production SETTINGS_ENCRYPTION_KEY is missing or empty.' >&2; exit 1; }
grep -Eq '^[[:space:]]*NEXT_PUBLIC_SITE_URL[[:space:]]*=[[:space:]]*https?://' "$APP_DIR/.env" \
  || { echo 'Production NEXT_PUBLIC_SITE_URL is missing or invalid.' >&2; exit 1; }

tar -xzf "$RELEASE_ARCHIVE" -C "$RELEASE_DIR"
[[ -f "$RELEASE_DIR/package.json" ]] || { echo 'Release archive is invalid' >&2; exit 1; }
[[ -d "$RELEASE_DIR/prisma/migrations" ]] || { echo 'Release archive is missing prisma migrations' >&2; exit 1; }
mapfile -t EXPECTED_MIGRATIONS < <(find "$RELEASE_DIR/prisma/migrations" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
[[ "${#EXPECTED_MIGRATIONS[@]}" -gt 0 ]] || { echo 'Release archive contains no migrations' >&2; exit 1; }
EXPECTED_MIGRATION_COUNT="${#EXPECTED_MIGRATIONS[@]}"
EXPECTED_MIGRATION_SQL="$(printf "'%s'," "${EXPECTED_MIGRATIONS[@]}")"
EXPECTED_MIGRATION_SQL="${EXPECTED_MIGRATION_SQL%,}"

if [[ "$RESET_PRODUCTION" == "NO" ]]; then
  MIGRATION_TABLE_EXISTS="$(sqlite3 "$APP_DIR/db/custom.db" "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations';")"
  if [[ "$MIGRATION_TABLE_EXISTS" != "1" ]]; then
    echo "Production database is not initialized with the release migration set." >&2
    echo "Run the manual Deploy production workflow with reset_production=yes after explicit approval." >&2
    exit 1
  fi
  UNEXPECTED_MIGRATIONS="$(sqlite3 "$APP_DIR/db/custom.db" "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name NOT IN ($EXPECTED_MIGRATION_SQL) OR finished_at IS NULL;")"
  CURRENT_MIGRATION_COUNT="$(sqlite3 "$APP_DIR/db/custom.db" "SELECT COUNT(DISTINCT migration_name) FROM _prisma_migrations WHERE migration_name IN ($EXPECTED_MIGRATION_SQL) AND finished_at IS NOT NULL;")"
  if [[ "$UNEXPECTED_MIGRATIONS" != "0" || "$CURRENT_MIGRATION_COUNT" != "$EXPECTED_MIGRATION_COUNT" ]]; then
    echo "Production database uses an obsolete migration history; refusing an in-place compatibility upgrade." >&2
    echo "Run the manual Deploy production workflow with reset_production=yes after explicit approval." >&2
    exit 1
  fi
else
  echo "RESET_PRODUCTION=YES: existing production SQLite will be deleted without backup."
fi

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  SERVICE_WAS_RUNNING=1
  pm2 stop "$APP_NAME"
fi

if [[ "$SERVICE_WAS_RUNNING" -ne 1 ]]; then
  echo "PM2 application is not registered: $APP_NAME" >&2
  exit 1
fi

if [[ "$RESET_PRODUCTION" == "YES" ]]; then
  rm -f -- "$APP_DIR/db/custom.db" "$APP_DIR/db/custom.db-journal" "$APP_DIR/db/custom.db-wal" "$APP_DIR/db/custom.db-shm"
else
  backup_dir="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup_dir"
  sqlite3 "$APP_DIR/db/custom.db" ".timeout 5000" ".backup '$backup_dir/custom.db'"
  cp -a "$APP_DIR/db/custom.db-wal" "$APP_DIR/db/custom.db-shm" "$backup_dir/" 2>/dev/null || true
fi

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
if [[ "$RESET_PRODUCTION" == "YES" ]]; then
  npm run db:seed
fi

npm run build

pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
pm2 start npm --name "$APP_NAME" -- start
pm2 save

curl --fail --silent --show-error --retry 10 --retry-delay 3 "$SITE_URL/api/health" >/dev/null
PUBLIC_HTML="$(curl --fail --silent --show-error --retry 10 --retry-delay 3 "${SITE_URL%/}/")"
PUBLIC_CSS_PATH="$(printf '%s' "$PUBLIC_HTML" | sed -n 's/.*href="\([^\"]*\.css\)".*/\1/p' | head -n 1)"
[[ -n "$PUBLIC_CSS_PATH" ]] || { echo "Deployment check failed: no Next.js CSS asset found in public HTML." >&2; exit 1; }
curl --fail --silent --show-error --retry 10 --retry-delay 3 "${SITE_URL%/}${PUBLIC_CSS_PATH}" >/dev/null
DEPLOY_SUCCEEDED=1
echo "Deployment completed: $SITE_URL"
