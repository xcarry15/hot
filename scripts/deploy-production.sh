#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/www/wwwroot/hot.kfxz.cn}"
RELEASE_ARCHIVE="${RELEASE_ARCHIVE:?RELEASE_ARCHIVE is required}"
APP_NAME="${APP_NAME:-hot}"
SITE_URL="${SITE_URL:-https://hot.kfxz.cn}"
BACKUP_ROOT="${BACKUP_ROOT:-/www/backup/h2-hot2}"
RESET_PRODUCTION="${RESET_PRODUCTION:-NO}"
RESET_PRODUCTION="${RESET_PRODUCTION^^}"
SHARED_DIR="${SHARED_DIR:-$APP_DIR/shared}"
RELEASES_DIR="${RELEASES_DIR:-$APP_DIR/releases}"
CURRENT_LINK="${CURRENT_LINK:-$APP_DIR/current}"
RELEASE_KEEP_COUNT="${RELEASE_KEEP_COUNT:-5}"
RELEASE_ID="${RELEASE_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
HEALTH_RETRY_COUNT="${HEALTH_RETRY_COUNT:-20}"
HEALTH_RETRY_DELAY="${HEALTH_RETRY_DELAY:-3}"

RELEASE_STAGING_DIR=""
RELEASE_DIR=""
OLD_CURRENT_TARGET=""
BACKUP_DIR=""
CURRENT_LINK_CHANGED=0
SERVICE_WAS_RUNNING=0
SERVICE_WAS_STOPPED=0
DATABASE_ROLLBACK_AVAILABLE=0
DEPLOY_SUCCEEDED=0

restore_current_link() {
  local rollback_link="$APP_DIR/.current-rollback.$$"
  rm -f -- "$rollback_link"
  if [[ -n "$OLD_CURRENT_TARGET" ]]; then
    ln -s -- "$OLD_CURRENT_TARGET" "$rollback_link"
    mv -Tf -- "$rollback_link" "$CURRENT_LINK"
  else
    rm -f -- "$CURRENT_LINK"
  fi
}

restart_service() {
  pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
  if [[ -L "$CURRENT_LINK" ]]; then
    cd "$CURRENT_LINK"
  else
    cd "$APP_DIR"
  fi
  pm2 start npm --name "$APP_NAME" -- start
  pm2 save
}

wait_for_health() {
  curl --fail --silent --show-error \
    --retry "$HEALTH_RETRY_COUNT" \
    --retry-delay "$HEALTH_RETRY_DELAY" \
    "$SITE_URL/api/health" >/dev/null
}

restore_database_backup() {
  local database_file="$SHARED_DIR/db/custom.db"
  [[ -n "$BACKUP_DIR" && -f "$BACKUP_DIR/custom.db" ]] || return 1
  rm -f -- "$database_file" "$database_file-journal" "$database_file-wal" "$database_file-shm"
  cp -a -- "$BACKUP_DIR/custom.db" "$database_file"
  cp -a "$BACKUP_DIR/custom.db-wal" "$BACKUP_DIR/custom.db-shm" "$SHARED_DIR/db/" 2>/dev/null || true
}

link_release_state() {
  local release_dir="$1"
  local env_path="$2"
  local db_path="$3"
  rm -f -- "$release_dir/.env" "$release_dir/db"
  ln -s -- "$env_path" "$release_dir/.env"
  ln -s -- "$db_path" "$release_dir/db"
}

promote_legacy_state() {
  if [[ ! -f "$SHARED_DIR/.env" ]]; then
    cp -a -- "$APP_DIR/.env" "$SHARED_DIR/.env"
  fi
  if [[ ! -f "$SHARED_DIR/db/custom.db" ]]; then
    [[ -d "$APP_DIR/db" ]] || {
      echo "Legacy production database directory is missing: $APP_DIR/db" >&2
      return 1
    }
    mv -- "$APP_DIR/db" "$SHARED_DIR/db"
    ln -s -- "$SHARED_DIR/db" "$APP_DIR/db"
  fi
}

prune_releases() {
  local current_target
  local entry
  local release_path
  local retained=0
  local -a release_entries=()

  current_target="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
  mapfile -t release_entries < <(
    find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '.staging.*' \
      -printf '%T@ %p\n' | sort -nr
  )
  for entry in "${release_entries[@]}"; do
    release_path="${entry#* }"
    [[ "$release_path" == "$current_target" ]] && continue
    if (( retained < RELEASE_KEEP_COUNT - 1 )); then
      retained=$((retained + 1))
    else
      rm -rf -- "$release_path"
    fi
  done
}

cleanup() {
  local exit_code=$?
  set +e

  if [[ "$DEPLOY_SUCCEEDED" -ne 1 ]]; then
    if [[ "$DATABASE_ROLLBACK_AVAILABLE" -eq 1 ]]; then
      restore_database_backup || true
      if [[ "$CURRENT_LINK_CHANGED" -eq 1 ]]; then
        restore_current_link || true
      fi
    fi
    if [[ "$SERVICE_WAS_STOPPED" -eq 1 ]]; then
      restart_service || true
    fi
    if [[ "$DATABASE_ROLLBACK_AVAILABLE" -eq 1 ]]; then
      [[ -z "$RELEASE_DIR" ]] || rm -rf -- "$RELEASE_DIR"
    fi
  fi

  [[ -z "$RELEASE_STAGING_DIR" ]] || rm -rf -- "$RELEASE_STAGING_DIR"
  rm -f -- "$RELEASE_ARCHIVE"
  return "$exit_code"
}
trap cleanup EXIT

for command in node npm pm2 sqlite3 tar curl; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done

[[ -d "$APP_DIR" ]] || { echo "Application directory does not exist: $APP_DIR" >&2; exit 1; }
[[ -f "$RELEASE_ARCHIVE" ]] || { echo "Release archive does not exist: $RELEASE_ARCHIVE" >&2; exit 1; }
[[ "$RESET_PRODUCTION" == "YES" || "$RESET_PRODUCTION" == "NO" ]] \
  || { echo 'RESET_PRODUCTION must be YES or NO.' >&2; exit 1; }
[[ "$RELEASE_KEEP_COUNT" =~ ^[2-9][0-9]*$ ]] \
  || { echo 'RELEASE_KEEP_COUNT must be an integer greater than or equal to 2.' >&2; exit 1; }
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9._-]+$ ]] \
  || { echo 'RELEASE_ID contains unsupported characters.' >&2; exit 1; }

mkdir -p -- "$SHARED_DIR" "$RELEASES_DIR"
if [[ -L "$CURRENT_LINK" ]]; then
  OLD_CURRENT_TARGET="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
  [[ -d "$OLD_CURRENT_TARGET" ]] || {
    echo "Current release target does not exist: $CURRENT_LINK" >&2
    exit 1
  }
elif [[ -e "$CURRENT_LINK" ]]; then
  echo "Current release path is not a symbolic link: $CURRENT_LINK" >&2
  exit 1
fi

if [[ -f "$SHARED_DIR/.env" ]]; then
  STATE_ENV="$SHARED_DIR/.env"
else
  STATE_ENV="$APP_DIR/.env"
fi
[[ -f "$STATE_ENV" ]] || { echo "Production .env is missing: $STATE_ENV" >&2; exit 1; }
if [[ -f "$SHARED_DIR/db/custom.db" ]]; then
  STATE_DB_DIR="$SHARED_DIR/db"
else
  STATE_DB_DIR="$APP_DIR/db"
fi
[[ -f "$STATE_DB_DIR/custom.db" ]] || { echo "Production database is missing: $STATE_DB_DIR/custom.db" >&2; exit 1; }
grep -Eq '^[[:space:]]*API_TOKEN[[:space:]]*=[[:space:]]*[^[:space:]]+' "$STATE_ENV" \
  || { echo 'Production API_TOKEN is missing or empty.' >&2; exit 1; }
grep -Eq '^[[:space:]]*SETTINGS_ENCRYPTION_KEY[[:space:]]*=[[:space:]]*[^[:space:]]+' "$STATE_ENV" \
  || { echo 'Production SETTINGS_ENCRYPTION_KEY is missing or empty.' >&2; exit 1; }
grep -Eq '^[[:space:]]*NEXT_PUBLIC_SITE_URL[[:space:]]*=[[:space:]]*https?://' "$STATE_ENV" \
  || { echo 'Production NEXT_PUBLIC_SITE_URL is missing or invalid.' >&2; exit 1; }

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  SERVICE_WAS_RUNNING=1
else
  echo "PM2 application is not registered: $APP_NAME" >&2
  exit 1
fi

RELEASE_STAGING_DIR="$(mktemp -d "$RELEASES_DIR/.staging.XXXXXX")"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
[[ ! -e "$RELEASE_DIR" ]] || { echo "Release already exists: $RELEASE_DIR" >&2; exit 1; }
tar -xzf "$RELEASE_ARCHIVE" -C "$RELEASE_STAGING_DIR"
[[ -f "$RELEASE_STAGING_DIR/package.json" ]] || { echo 'Release archive is invalid' >&2; exit 1; }
[[ -d "$RELEASE_STAGING_DIR/prisma/migrations" ]] || { echo 'Release archive is missing prisma migrations' >&2; exit 1; }
mapfile -t EXPECTED_MIGRATIONS < <(find "$RELEASE_STAGING_DIR/prisma/migrations" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
[[ "${#EXPECTED_MIGRATIONS[@]}" -gt 0 ]] || { echo 'Release archive contains no migrations' >&2; exit 1; }
EXPECTED_MIGRATION_SQL="$(printf "'%s'," "${EXPECTED_MIGRATIONS[@]}")"
EXPECTED_MIGRATION_SQL="${EXPECTED_MIGRATION_SQL%,}"

link_release_state "$RELEASE_STAGING_DIR" "$STATE_ENV" "$STATE_DB_DIR"
cd "$RELEASE_STAGING_DIR"
echo "[deploy] installing release dependencies: $RELEASE_ID"
npm ci
echo "[deploy] generating Prisma Client"
npm run db:generate
echo "[deploy] building release: $RELEASE_ID"
npm run build

mv -- "$RELEASE_STAGING_DIR" "$RELEASE_DIR"
RELEASE_STAGING_DIR=""

if [[ "$RESET_PRODUCTION" == "NO" ]]; then
  MIGRATION_TABLE_EXISTS="$(sqlite3 "$STATE_DB_DIR/custom.db" "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations';")"
  if [[ "$MIGRATION_TABLE_EXISTS" != "1" ]]; then
    echo "Production database is not initialized with the release migration set." >&2
    echo "Run the manual Deploy production workflow with reset_production=yes after explicit approval." >&2
    exit 1
  fi
  INVALID_MIGRATIONS="$(sqlite3 "$STATE_DB_DIR/custom.db" "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name NOT IN ($EXPECTED_MIGRATION_SQL) OR finished_at IS NULL;")"
  BASELINE_MIGRATION="${EXPECTED_MIGRATIONS[0]}"
  BASELINE_APPLIED="$(sqlite3 "$STATE_DB_DIR/custom.db" "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name = '$BASELINE_MIGRATION' AND finished_at IS NOT NULL;")"
  if [[ "$INVALID_MIGRATIONS" != "0" || "$BASELINE_APPLIED" != "1" ]]; then
    echo "Production database uses an obsolete migration history; refusing an in-place compatibility upgrade." >&2
    echo "Run the manual Deploy production workflow with reset_production=yes after explicit approval." >&2
    exit 1
  fi
fi

SERVICE_WAS_STOPPED=1
echo "[deploy] stopping PM2: $APP_NAME"
pm2 stop "$APP_NAME"

if [[ ! -f "$SHARED_DIR/.env" || ! -f "$SHARED_DIR/db/custom.db" ]]; then
  promote_legacy_state
fi
link_release_state "$RELEASE_DIR" "$SHARED_DIR/.env" "$SHARED_DIR/db"
DATABASE_FILE="$SHARED_DIR/db/custom.db"

if [[ "$RESET_PRODUCTION" == "YES" ]]; then
  echo "RESET_PRODUCTION=YES: existing production SQLite will be deleted without backup."
  rm -f -- "$DATABASE_FILE" "$DATABASE_FILE-journal" "$DATABASE_FILE-wal" "$DATABASE_FILE-shm"
else
  echo "[deploy] backing up production SQLite"
  BACKUP_DIR="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)"
  mkdir -p -- "$BACKUP_DIR"
  sqlite3 "$DATABASE_FILE" ".timeout 5000" ".backup '$BACKUP_DIR/custom.db'"
  cp -a "$DATABASE_FILE-wal" "$DATABASE_FILE-shm" "$BACKUP_DIR/" 2>/dev/null || true
  DATABASE_ROLLBACK_AVAILABLE=1
fi

cd "$RELEASE_DIR"
echo "[deploy] applying database migrations"
npm run db:migrate:deploy
echo "[deploy] optimizing SQLite"
npm run db:optimize
if [[ "$RESET_PRODUCTION" == "YES" ]]; then
  npm run db:seed
fi

CURRENT_LINK_TEMP="$APP_DIR/.current-$RELEASE_ID.$$"
echo "[deploy] switching current release atomically"
rm -f -- "$CURRENT_LINK_TEMP"
ln -s -- "$RELEASE_DIR" "$CURRENT_LINK_TEMP"
mv -Tf -- "$CURRENT_LINK_TEMP" "$CURRENT_LINK"
CURRENT_LINK_CHANGED=1

restart_service

echo "[deploy] restarting PM2 and checking health"
if ! wait_for_health; then
  echo "[deploy] health check did not stabilize; restarting PM2 once before rollback"
  restart_service
  wait_for_health
fi
PUBLIC_HTML="$(curl --fail --silent --show-error --retry 10 --retry-delay 3 "${SITE_URL%/}/")"
PUBLIC_CSS_PATH="$(printf '%s' "$PUBLIC_HTML" | sed -n 's/.*href="\([^\"]*\.css\)".*/\1/p' | head -n 1)"
[[ -n "$PUBLIC_CSS_PATH" ]] || { echo "Deployment check failed: no Next.js CSS asset found in public HTML." >&2; exit 1; }
curl --fail --silent --show-error --retry 10 --retry-delay 3 "${SITE_URL%/}${PUBLIC_CSS_PATH}" >/dev/null

DEPLOY_SUCCEEDED=1
prune_releases
echo "Deployment completed: $SITE_URL"
