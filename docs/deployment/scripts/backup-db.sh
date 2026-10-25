#!/usr/bin/env bash
# 智慧课程平台数据库在线备份
# ----------------------------------------------------------------------------
# 为什么用 `.backup` 而不是 `cp`：SQLite 处于 WAL 模式时，直接复制 .sqlite 单文件
# 会漏掉 WAL 里已提交的事务。`.backup` 是 SQLite 官方的在线备份接口，
# 不需要停服务，也不会锁住写入。
#
# 用法：
#   SCP_DB_PATH=/var/lib/course-platform/course-platform.sqlite \
#   BACKUP_DIR=/home/w-4090/backups \
#   KEEP_DAYS=7 \
#   ./backup-db.sh
#
# 退出码：0 成功；1 备份或校验失败（失败时会删掉半成品，避免留一个坏文件冒充备份）。
set -euo pipefail

DB_PATH="${SCP_DB_PATH:-/var/lib/course-platform/course-platform.sqlite}"
BACKUP_DIR="${BACKUP_DIR:-/home/w-4090/backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"
STAMP="$(date +%F-%H%M)"
TARGET="$BACKUP_DIR/course-$STAMP.sqlite"
LOG="$BACKUP_DIR/backup.log"

fail() {
  echo "$(date -Is) 备份失败：$1" >>"$LOG"
  rm -f "$TARGET" "$TARGET-wal" "$TARGET-shm"
  exit 1
}

[ -f "$DB_PATH" ] || fail "数据库文件不存在：$DB_PATH"
command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 未安装"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# 1) 在线备份
sqlite3 "$DB_PATH" ".backup '$TARGET'" || fail "sqlite3 .backup 执行失败"

# 2) 校验：完整性 + 关键表可读 + users 表条数（生产至少有 1 个注册用户）
INTEGRITY="$(sqlite3 "$TARGET" 'PRAGMA integrity_check;' 2>/dev/null | head -1 || true)"
[ "$INTEGRITY" = "ok" ] || fail "完整性校验未通过：$INTEGRITY"

USERS="$(sqlite3 "$TARGET" 'SELECT COUNT(*) FROM users;' 2>/dev/null || true)"
case "$USERS" in
  '' | *[!0-9]*) fail "无法读取 users 表" ;;
esac
[ "$USERS" -ge 1 ] || fail "users 表为空，备份可能不完整"

MIGRATIONS="$(sqlite3 "$TARGET" 'SELECT COUNT(*) FROM schema_migrations;' 2>/dev/null || true)"
case "$MIGRATIONS" in
  '' | *[!0-9]*) fail "无法读取 schema_migrations 表" ;;
esac

# 3) 定稿并记录
chmod 600 "$TARGET"
SIZE="$(stat -c%s "$TARGET")"
echo "$(date -Is) 备份成功 file=$TARGET size=${SIZE}B users=$USERS migrations=$MIGRATIONS" >>"$LOG"

# 4) 清理过期备份（只删本脚本生成的 course-*.sqlite）
find "$BACKUP_DIR" -maxdepth 1 -name 'course-*.sqlite' -mtime +"$KEEP_DAYS" -delete

exit 0
