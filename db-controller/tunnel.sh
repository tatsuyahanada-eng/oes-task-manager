#!/bin/bash
#
# DB Controller — SSH トンネルを張って DB Controller を起動する
#
# ロリポップなど、DB が「.lan」で終わる内部ホストにしか居ない場合、
# 手元の PC から直接は届きません。
# このスクリプトは SSH のトンネルを張り、手元の 13306 番を
# 向こうの MySQL に見せかけます。
#
#   手元の PC:13306  ──SSH──▶  ロリポップ  ──▶  mysqlXXX.phy.lolipop.lan:3306
#
# 使い方:
#   1. 下の設定を書き換える
#   2. ./tunnel.sh
#   3. 別の画面は要りません。DB Controller もこのスクリプトが起動します
#   4. 終わるときは Ctrl+C（トンネルも一緒に閉じます）
#

set -u

# ===================== 設定（ここを書き換える）=====================

# ロリポップの SSH。管理画面「サーバーの管理・設定 → SSH」で確認できます
SSH_USER="${DBC_SSH_USER:-アカウント名}"
SSH_HOST="${DBC_SSH_HOST:-ssh.lolipop.jp}"
SSH_PORT="${DBC_SSH_PORT:-2222}"

# 管理画面「データベース」の「サーバー」に書かれている名前
DB_HOST="${DBC_DB_HOST:-mysqlXXX.phy.lolipop.lan}"
DB_PORT="${DBC_DB_PORT:-3306}"

# 手元の何番に見せるか。DB Controller にはこの番号を登録します
LOCAL_PORT="${DBC_LOCAL_PORT:-13306}"

# ==================================================================

say()  { printf '%s\n' "$*"; }
fail() { printf '\n%s\n' "$*" >&2; exit 1; }

if [ "$SSH_USER" = "アカウント名" ] || [ "$DB_HOST" = "mysqlXXX.phy.lolipop.lan" ]; then
  fail "先に tunnel.sh の設定を書き換えてください（SSH_USER と DB_HOST）。

環境変数でも指定できます:
  DBC_SSH_USER=xxx DBC_DB_HOST=mysql151.phy.lolipop.lan ./tunnel.sh"
fi

command -v ssh >/dev/null 2>&1 || fail "ssh コマンドが見つかりません。
  macOS / Linux … 標準で入っています
  Windows       … 「設定 → アプリ → オプション機能」で OpenSSH クライアントを追加するか、
                   Git Bash / WSL を使ってください"

# 既に使われていないか確かめる
if command -v lsof >/dev/null 2>&1 && lsof -ti:"$LOCAL_PORT" >/dev/null 2>&1; then
  fail "ポート $LOCAL_PORT は既に使われています。
別の番号を使う場合: DBC_LOCAL_PORT=13307 ./tunnel.sh"
fi

say "SSH トンネルを張ります"
say "  $LOCAL_PORT  →  $SSH_USER@$SSH_HOST:$SSH_PORT  →  $DB_HOST:$DB_PORT"
say ""

# -N     … リモートでコマンドを実行しない（トンネルだけ）
# -T     … 端末を割り当てない
# ExitOnForwardFailure … 転送に失敗したら、黙って繋がったふりをせず終了する
ssh -N -T \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -p "$SSH_PORT" \
    -L "127.0.0.1:$LOCAL_PORT:$DB_HOST:$DB_PORT" \
    "$SSH_USER@$SSH_HOST" &
SSH_PID=$!

# 後片付け。DB Controller を止めたらトンネルも閉じる
cleanup() {
  say ""
  say "トンネルを閉じています…"
  kill "$SSH_PID" 2>/dev/null
  wait "$SSH_PID" 2>/dev/null
  exit 0
}
trap cleanup INT TERM

# 繋がるまで待つ（最大 30 秒）
say "接続を待っています…"
for i in $(seq 1 30); do
  if ! kill -0 "$SSH_PID" 2>/dev/null; then
    fail "SSH の接続に失敗しました。ユーザー名・ホスト・ポートと、鍵の設定を確認してください。"
  fi
  if (echo > /dev/tcp/127.0.0.1/"$LOCAL_PORT") >/dev/null 2>&1; then
    say "トンネルが開きました（$i 秒）"
    break
  fi
  sleep 1
  [ "$i" = 30 ] && { kill "$SSH_PID" 2>/dev/null; fail "30 秒待ちましたが開きませんでした。"; }
done

say ""
say "───────────────────────────────────────────"
say " DB Controller への登録内容"
say ""
say "   DB 種別        : MySQL / MariaDB"
say "   ホスト         : 127.0.0.1"
say "   ポート         : $LOCAL_PORT"
say "   既定データベース : （管理画面の「データベース名」）"
say "   ユーザー名      : （管理画面の「ユーザー名」）"
say "   SSL を使用      : オフ"
say "   読み取り専用    : オン（まずはこのまま）"
say "───────────────────────────────────────────"
say ""

# DB Controller を起動する。終了したらトンネルも閉じる
cd "$(dirname "$0")" || exit 1
npm start
cleanup
