# レンタルサーバへの設置手順

このツールは **Node.js アプリケーション**です。PHP しか動かない共有レンタルサーバでは動作しません。
先に「動作する環境かどうか」を確認してください。

---

## 0. まず最初に — 公開範囲の判断

このツールは **DB の接続情報 (ホスト・ユーザー・パスワード) を保持し、画面から DB を操作できます。**
インターネットに公開する場合、そこが実質的に「DB の管理コンソール」になります。

安全な順に、次の 3 つの選択肢があります。

| 方式 | 安全性 | 手間 | 向いている場合 |
|---|---|---|---|
| **A. 手元の PC で動かす** | ◎ 最も安全 | 小 | 移行作業を自分（少人数）で行う。**推奨** |
| **B. サーバに置き、SSH ポートフォワード経由で使う** | ◎ 安全 | 中 | サーバから DB へしか到達できない場合 |
| **C. サーバに置き、HTTPS + 認証で公開する** | △ 要注意 | 大 | 複数人が別々の場所から使う必要がある |

**移行作業が目的なら A で足ります。** DB へ到達できる PC で `npm start` するだけです。
C を選ぶ場合は、後述の「公開時の必須設定」を必ず全部行ってください。

---

## 1. 動作要件の確認

サーバに SSH でログインして確認します。

```bash
node -v     # v18.0.0 以上であること
npm -v
```

`node: command not found` の場合、そのサーバでは動きません。以下のいずれかが必要です。

- **VPS / クラウド** (さくらの VPS、ConoHa、AWS Lightsail、Xserver VPS など) — 自分で Node.js を入れられます
- **Node.js 対応の共有サーバ** (mixhost、CPI の一部プランなど) — 管理画面に「Node.js アプリ設定」があるか確認
- **PaaS** (Render、Railway、Fly.io など)

### Node.js の導入 (VPS の場合)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

---

## 2. どのファイルを使うか

配布ファイルは 4 つありますが、**中身は 2 種類、形式が 2 つあるだけ**です。
**使うのは 1 つだけ**で、4 つ全部をアップロードする必要はありません。

|  | tar.gz (Linux / Mac 向け) | zip (Windows / FTP 向け) |
|---|---|---|
| **full** (`node_modules` 同梱) | `db-migration-manager-full.tar.gz` | `db-migration-manager-full.zip` |
| **src** (ソースのみ) | `db-migration-manager-src.tar.gz` | `db-migration-manager-src.zip` |

同じ行の tar.gz と zip は**完全に同一の中身**です。展開後のファイルは 1 バイトも変わりません。

### 選び方

```
サーバで npm install を実行できますか？
├─ いいえ / わからない  → full を選ぶ   ← 迷ったらこちら
└─ はい                 → src を選ぶ

どうやってアップロードしますか？
├─ SSH (scp / rsync)    → tar.gz
└─ FTP / 管理画面から   → zip
```

| 種類 | 圧縮時 | 展開後 | 中身 |
|---|---|---|---|
| **full** | 12MB (tar.gz) / 16MB (zip) | 約 78MB | ソース + `node_modules` (依存ライブラリ込みで約 8,140 ファイル) |
| **src** | 70KB (tar.gz) / 85KB (zip) | 約 300KB | ソースのみ (24 ファイル) |

full 版の `node_modules` には Linux (x64 / arm64)、macOS、Windows 向けのバイナリがすべて含まれています。
**展開するだけで動きます。`npm install` もコンパイルも不要**です。

> **迷ったら `db-migration-manager-full.tar.gz`** (FTP なら `-full.zip`) を選んでください。
> src 版はサーバが npm レジストリに到達できないと `npm install` が失敗します。

---

## 3. どのディレクトリに置くか

### ⚠️ 公開ディレクトリには絶対に置かないでください

`public_html` / `www` / `htdocs` / `htdocs/public` などの **Web 公開ディレクトリに置いてはいけません。**

そこに置くと、Web サーバがファイルをそのまま配信してしまい、
`data/connections.json` (DB の接続情報) や `data/.masterkey` (暗号鍵) が
**URL を直接叩くだけでダウンロードできてしまいます。**

```
✗ /home/ユーザー名/public_html/db-migration-manager     ← 危険
✗ /var/www/html/db-migration-manager                    ← 危険
✓ /home/ユーザー名/apps/db-migration-manager            ← 安全
```

このツールは Node.js が自分で HTTP サーバを持っています。
Web サーバ (Apache / nginx) は**リバースプロキシとして前段に置くだけ**で、
ファイルを直接配信させる必要はありません。

### 推奨する配置場所

| サーバの種類 | 配置ディレクトリ | 補足 |
|---|---|---|
| **VPS / クラウド** (さくら VPS、ConoHa、Xserver VPS など) | `/home/ユーザー名/apps/db-migration-manager` | root ではなく一般ユーザーで動かす |
| **VPS (システム全体で運用)** | `/opt/db-migration-manager` | systemd で常駐させる場合。専用ユーザーを作ると安全 |
| **Node.js 対応の共有サーバ** (mixhost など) | 管理画面の「Node.js アプリ」で指定された<br>アプリケーションルート (公開ディレクトリの外) | 管理画面側で起動ファイルに `server.js` を指定 |
| **手元の PC** | どこでも可 (例: `~/db-migration-manager`) | 移行作業だけならこれで十分 |

**ディレクトリ名は `db-migration-manager` のままにしてください** (アーカイブを展開するとこの名前で作られます)。
変更しても動きますが、DEPLOY.md 中のコマンド例と食い違います。

### 展開後の中身

```
db-migration-manager/          ← このディレクトリごと配置する
├── server.js                  起動ファイル (これを node で実行する)
├── package.json
├── package-lock.json
├── README.md                  機能と安全策の説明
├── DEPLOY.md                  このファイル
├── start.sh.example           起動スクリプトのひな形
├── .gitignore
├── src/                       サーバ側のコード
├── public/                    画面 (HTML / JS / CSS)
├── data/                      接続情報・暗号鍵・履歴が作られる (権限 700)
└── node_modules/              依存ライブラリ (full 版のみ)
```

---

## 4. アップロード手順

### A. SSH が使える場合 (tar.gz / 推奨)

**圧縮ファイルのまま送って、サーバ側で展開します。** これが最も速く確実です。

```bash
# 1. 手元の PC から圧縮ファイルを送る
scp db-migration-manager-full.tar.gz ユーザー名@サーバ:~/

# 2. サーバにログイン
ssh ユーザー名@サーバ

# 3. 置き場所を作って展開する
mkdir -p ~/apps
cd ~/apps
tar xzf ~/db-migration-manager-full.tar.gz
#   → ~/apps/db-migration-manager/ ができる

# 4. 権限を整える
cd db-migration-manager
chmod 700 data

# 5. 送った圧縮ファイルは消してよい
rm ~/db-migration-manager-full.tar.gz

# 6. src 版を使った場合のみ (full 版では不要)
npm install --omit=dev
```

### B. FTP しか使えない場合 (zip)

FTP は 1 ファイルずつ転送するため、full 版 (約 8,140 ファイル) をそのまま送ると
**数時間かかったり、途中で失敗したりします。** 次のどちらかにしてください。

**B-1. サーバ上に展開機能がある場合 (推奨)**

多くのレンタルサーバのファイルマネージャには「解凍」機能があります。

1. `db-migration-manager-full.zip` を**そのまま**アップロード
   （置き場所は公開ディレクトリの**外**。管理画面上では `public_html` と同じ階層にある領域）
2. ファイルマネージャで zip を右クリック →「解凍 / 展開」
3. `db-migration-manager/` ができたら、zip ファイルは削除
4. `data` ディレクトリのパーミッションを `700` に変更

**B-2. 展開機能が無い場合**

手元の PC で zip を展開してから、できた `db-migration-manager` フォルダを丸ごと転送します。
**転送モードは必ずバイナリ (Binary)** にしてください（アスキーモードだと壊れます）。

転送後、ファイル数が合っているか確認してください（full 版は約 8,140 ファイル）。
足りない場合は転送が途中で失敗しています。

> FTP しか使えない環境なら、**src 版 (20 ファイル) を送って、サーバ側で `npm install` するほうが確実**です。
> ただしサーバが npm レジストリ (`registry.npmjs.org`) に到達できる必要があります。

---

## 5. 動作確認 (ローカル待ち受け)

まずは公開せずに起動できるか確認します。

```bash
cd ~/apps/db-migration-manager
npm start
```

```
db-migration-manager: http://127.0.0.1:3000
  認証: 無効 (localhost 専用)
```

と出れば起動成功です。`Ctrl+C` で止めます。

### 方式 B: SSH ポートフォワードで使う (推奨)

サーバ側は `127.0.0.1` のまま起動しておき、手元の PC から SSH トンネルを張ります。
**インターネットには一切公開されないので、これが最も安全です。**

```bash
# 手元の PC で実行
ssh -L 3000:127.0.0.1:3000 ユーザー名@サーバ
```

このまま手元のブラウザで <http://127.0.0.1:3000> を開くと、サーバ上のツールが使えます。

---

## 6. 公開時の必須設定 (方式 C)

インターネットに公開する場合、**以下は「推奨」ではなく「必須」**です。

### 6-1. 認証 (これが無いと起動しません)

`DBM_HOST` を `127.0.0.1` 以外にすると、認証情報が無い限りサーバは起動を拒否します。

```bash
# パスワードを生成する
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

起動スクリプト `start.sh` を作ります。

```bash
#!/bin/bash
cd "$(dirname "$0")"

export PORT=3000
export DBM_HOST=127.0.0.1                       # リバースプロキシ経由にするので localhost のまま
export DBM_AUTH_USER='dbadmin'
export DBM_AUTH_PASS='ここに生成したパスワード'   # 16文字以上が必須
export DBM_MASTER_KEY='ここに別途生成した文字列'   # 接続情報の暗号鍵 (後述)

exec node server.js
```

```bash
chmod 700 start.sh    # パスワードが入るので、他ユーザーから読めないようにする
```

> リバースプロキシ (nginx / Apache) を前段に置く構成では、`DBM_HOST` は `127.0.0.1` のままにします。
> プロキシを使わず直接公開する場合のみ `DBM_HOST=0.0.0.0` にしてください。

### 6-2. HTTPS

Basic 認証は、HTTP のままだと**パスワードが平文同然で流れます**。
必ず HTTPS 経由でアクセスしてください。Let's Encrypt で取得できます。

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d dbtool.example.com
```

### 6-3. リバースプロキシ

**nginx**

```nginx
server {
    listen 443 ssl;
    server_name dbtool.example.com;

    ssl_certificate     /etc/letsencrypt/live/dbtool.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dbtool.example.com/privkey.pem;

    # 接続元 IP を制限できるなら、これが最も効果的です
    # allow 203.0.113.10;
    # deny  all;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;   # 大きなテーブルの COUNT(*) に備えて長めに
    }
}

server {
    listen 80;
    server_name dbtool.example.com;
    return 301 https://$host$request_uri;
}
```

**Apache** (`.htaccess` ではなく VirtualHost 設定に書きます)

```apache
<VirtualHost *:443>
    ServerName dbtool.example.com

    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/dbtool.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/dbtool.example.com/privkey.pem

    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:3000/
    ProxyPassReverse / http://127.0.0.1:3000/
    ProxyTimeout     300
</VirtualHost>
```

> Apache の `mod_proxy` を使う場合、`Authorization` ヘッダはそのまま転送されます。
> 万一 Basic 認証が効かない場合は `SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1` を追加してください。

### 6-4. アクセス元の制限 (できるなら必ず)

固定 IP から使うなら、6-3 の nginx 設定の `allow` / `deny` を有効にしてください。
**認証より確実に効きます。**

---

## 7. 常駐させる

### systemd (VPS で推奨)

`/etc/systemd/system/db-migration-manager.service`

```ini
[Unit]
Description=DB Migration Manager
After=network.target

[Service]
Type=simple
User=あなたのユーザー名
WorkingDirectory=/home/あなたのユーザー名/apps/db-migration-manager
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

Environment=PORT=3000
Environment=DBM_HOST=127.0.0.1
Environment=DBM_AUTH_USER=dbadmin
Environment=DBM_AUTH_PASS=ここにパスワード
Environment=DBM_MASTER_KEY=ここに暗号鍵

# 環境変数にパスワードを直接書きたくない場合は EnvironmentFile を使う
# EnvironmentFile=/home/ユーザー名/apps/db-migration-manager/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo chmod 600 /etc/systemd/system/db-migration-manager.service
sudo systemctl daemon-reload
sudo systemctl enable --now db-migration-manager
sudo systemctl status db-migration-manager
journalctl -u db-migration-manager -f      # ログを見る
```

### pm2 (共有サーバなどで systemd が使えない場合)

```bash
npm install -g pm2
pm2 start start.sh --name db-migration-manager
pm2 save
pm2 startup          # 表示されたコマンドを実行すると自動起動になります
pm2 logs db-migration-manager
```

---

## 8. データの保存場所と引き継ぎ

| ファイル | 中身 | 扱い |
|---|---|---|
| `data/connections.json` | 接続情報 (パスワードは暗号化済み) | バックアップ対象 |
| `data/.masterkey` | 暗号鍵 (自動生成) | **最重要。これが変わるとパスワードを復号できません** |
| `data/audit.log` | 更新操作の履歴 | 監査用 |

```bash
chmod 700 data          # 他ユーザーから読めないようにする
```

### 環境を移すとき

`DBM_MASTER_KEY` を環境変数で明示しておくと、`data/.masterkey` に依存せず設定を移せます。

```bash
# 鍵を生成して控えておく
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

この値を `DBM_MASTER_KEY` に設定しておけば、`data/connections.json` だけをコピーすれば移行できます。
**設定しない場合は `data/.masterkey` も一緒にコピーしてください。**

---

## 9. 設置後のチェックリスト

```bash
# 認証なしでアクセスできてしまわないか (401 が返れば正しい)
curl -s -o /dev/null -w '%{http_code}\n' https://dbtool.example.com/

# 正しい認証情報でアクセスできるか (200 が返れば正しい)
curl -s -o /dev/null -w '%{http_code}\n' -u 'dbadmin:パスワード' https://dbtool.example.com/api/health

# HTTP でアクセスしたら HTTPS に飛ぶか (301 が返れば正しい)
curl -s -o /dev/null -w '%{http_code}\n' http://dbtool.example.com/
```

- [ ] 認証なしのアクセスが 401 になる
- [ ] HTTPS でアクセスできる / HTTP は HTTPS に転送される
- [ ] 可能なら接続元 IP を制限した
- [ ] `data/` のパーミッションが 700
- [ ] `start.sh` / systemd unit のパーミッションが 600〜700
- [ ] 登録した接続がすべて「読取専用」になっている (変更が必要なものだけ解除)
- [ ] 移行元 DB には**参照専用の DB ユーザー**を使っている
- [ ] `DBM_MASTER_KEY` を控えた

---

## 10. トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| `起動を中止しました` と出て起動しない | `DBM_HOST` が localhost 以外なのに `DBM_AUTH_USER` / `DBM_AUTH_PASS` が未設定。表示されたメッセージのとおり設定してください |
| `ポート 3000 は既に使用されています` | 別のプロセスが使用中。`PORT=3001` など別のポートを指定してください |
| ブラウザで認証ダイアログが出続ける | パスワードの打ち間違いか、プロキシが `Authorization` ヘッダを落としています。6-3 の注記を参照 |
| `Oracle ドライバが未インストールです` | ソース版で `npm install` が途中で失敗しています。`npm install oracledb` を個別に実行してください |
| DB に接続できない | サーバから DB へ到達できるか確認: `nc -zv DBホスト 1521` （Oracle）/ `1433`（SQL Server）/ `5432`（PostgreSQL）。DB 側のファイアウォールでサーバの IP を許可する必要があります |
| 接続情報を開くとパスワードの復号エラー | `DBM_MASTER_KEY` または `data/.masterkey` が変わっています。元の鍵に戻すか、接続情報を登録し直してください |
| 大きなテーブルで「件数」がタイムアウトする | `COUNT(*)` は全走査です。プロキシの `proxy_read_timeout` を延ばすか、概算行数 (テーブル一覧の `~` 付きの数値) で代用してください |
