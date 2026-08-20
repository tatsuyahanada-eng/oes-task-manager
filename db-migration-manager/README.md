# DB Migration Manager

Oracle / SQL Server から PostgreSQL への移行を支援する、ローカル実行の DB 管理ツールです。

サーバーごとに接続情報を登録しておき、ブラウザから**データベースの切り替え・テーブル定義の確認・データの参照と編集**をまとめて行えます。移行元 (Oracle / SQL Server) と移行先 (PostgreSQL) を同じ画面で扱うことを想定しています。

画面は黒地・白文字のターミナル風です。

---

## できること

| 機能 | 内容 |
|---|---|
| 接続管理 | サーバーごとに接続情報を登録・編集・削除。用途 (移行元 / 移行先) のラベル付け。接続テスト |
| DB 切り替え | 1 つの接続情報のまま、SQL Server / PostgreSQL のデータベースを切り替え |
| スキーマ / テーブル一覧 | スキーマ選択、テーブル・ビューの一覧、概算行数、テーブルコメント、名前での絞り込み |
| 列定義 | 列名・型 (長さ・精度つき)・NULL 許可・既定値・主キー・IDENTITY・列コメント |
| 索引・キー | 主キー、索引 (一意性・構成列)、外部キー (参照先テーブル・列) |
| データ参照 | ページング、列ヘッダクリックでの並び替え、WHERE 条件での絞り込み、`COUNT(*)` による正確な件数 |
| データ編集 | 行の追加・修正・削除。実行前に変更内容と SQL を確認 |
| SQL 実行 | `SELECT` / `WITH` の実行。書き込み可の接続では `INSERT` / `UPDATE` / `DELETE` / `MERGE` も (確認あり) |
| 操作履歴 | 更新操作の記録を画面から確認 (`data/audit.log`) |

### 現時点で「できないこと」

- CSV エクスポート / インポート（全テーブル一括バックアップを含む）
- スキーマ変換 (Oracle / SQL Server の型を PostgreSQL 型へマッピングした DDL 生成)
- 複数行の一括編集 (安全のため、変更は 1 行ずつに限定しています)
- DDL (`CREATE` / `DROP` / `ALTER` / `TRUNCATE`) — サーバー側で明示的に拒否します

---

## 動作要件

- Node.js 18 以降
- 接続先 DB へのネットワーク到達性と、参照権限を持つ DB ユーザー

| DB | 使用ドライバ | 備考 |
|---|---|---|
| Oracle Database | `oracledb` (Thin モード) | **Oracle Instant Client のインストールは不要**。Oracle Database 12.1 以降が対象 |
| SQL Server | `mssql` (tedious) | SQL Server 2012 以降。名前付きインスタンスにも対応 |
| PostgreSQL | `pg` | |

---

## セットアップ

```bash
npm install
npm start
```

起動後、ブラウザで <http://127.0.0.1:3000> を開きます。

ポートを変えたい場合:

```bash
PORT=8080 npm start
```

サーバに設置する場合は **[DEPLOY.md](DEPLOY.md)** を参照してください。

### ドライバを絞りたい場合

3 つの DB ドライバは `optionalDependencies` なので、インストールに失敗しても他は動きます。未導入のドライバは画面の「DB 種別」プルダウンで選択できない状態で表示されます。特定の DB だけ使う場合は個別に入れてください。

```bash
npm install pg          # PostgreSQL だけ使う場合
```

---

## 使い方

### 接続先を登録する

1. 左の **「+ 追加」** から接続先を登録します。
   - **DB 種別** を選ぶと、その DB に必要な項目だけが表示されます
     （Oracle → サービス名 / SID、SQL Server → 既定データベース / 名前付きインスタンス、など）。
   - **用途** に「移行元 / 移行先」を設定しておくと、一覧でバッジ表示されます。
   - **安全設定** の「読み取り専用」は既定でオンです。データを変更する接続だけオフにしてください。
   - 保存前に **「接続テスト」** で疎通を確認できます。

### データを見る

2. 一覧から接続先をクリックすると接続します。
3. 中央のペインで **database → schema** を選ぶと、テーブル・ビューの一覧が出ます。
4. テーブルをクリックすると、右側に **データ / 列定義 / 索引・キー** の 3 タブが表示されます。
   - データタブ: `WHERE` 条件を書いて「再取得」、列ヘッダのクリックで並び替え、「件数」で `COUNT(*)`
   - 実行された SQL は下部に表示されます
5. 右下の **`$ sql`** から `SELECT` を実行できます (Ctrl+Enter で実行)。

### データを変更する

書き込み可の接続 (読み取り専用がオフ) を選んでいるときだけ、編集用の操作が現れます。
画面右上に **`WRITE ENABLED`** と表示されているかで、いま変更できる状態かどうかが分かります。

| 操作 | 手順 |
|---|---|
| 追加 | データタブの **「+ 行を追加」**。値を入れなかった列は送らないので、DB の既定値がそのまま効きます |
| 修正 | 行の **「修正」**。変更した列だけが色付きになり、変更された列だけを更新します |
| 削除 | 行の **「削除」**。削除される行の全内容を表示して確認します |

いずれも、実行前に**変更内容と実行される SQL** を表示して確認を取ります。
`NULL` を設定したい列は、値欄の右にある **NULL** にチェックを入れてください
（空文字と `NULL` を取り違えないようにするためです）。

左上の **「履歴」** から、このツールで行った更新操作の記録を確認できます。

---

## 安全策

このツールは DB の認証情報を扱うため、次の方針で作っています。

**待ち受けは localhost のみ / 公開時は認証を強制**
既定で `127.0.0.1` にのみバインドします。
`DBM_HOST` を localhost 以外に設定した場合、`DBM_AUTH_USER` と `DBM_AUTH_PASS` (16 文字以上) が
無ければ**サーバは起動を拒否します**。認証なしで外部公開されることを防ぐためです。
認証情報を設定すると、画面・API・静的ファイルのすべてが Basic 認証で保護されます。
Basic 認証は平文で流れるため、公開時は必ず HTTPS 経由で使ってください。

**パスワードは暗号化して保存**
接続情報は `data/connections.json` に保存され、パスワードは AES-256-GCM で暗号化されます。API のレスポンスにパスワードは含まれません (`hasPassword` の真偽値のみ)。

暗号鍵は次の順で決まります。

1. 環境変数 `DBM_MASTER_KEY`
2. `data/.masterkey` (初回起動時に自動生成)

`data/connections.json` と `data/.masterkey` は `.gitignore` 済みです。**リポジトリにコミットしないでください。**
別のマシンへ設定を移す場合は、両方を一緒に移すか、`DBM_MASTER_KEY` を使ってください。鍵が変わるとパスワードは復号できません。

**接続は既定で読み取り専用**
新しく登録した接続は「読み取り専用」で始まります。この状態では、行の追加・修正・削除も更新系 SQL もサーバー側で拒否されます (HTTP 403)。書き込みを許可するには接続設定で明示的にチェックを外す必要があり、その際にも確認を挟みます。
この機能より前に保存した接続情報 (`readOnly` を持たないもの) も、安全側に倒して読み取り専用として扱います。

**変更は主キーで特定した 1 行ずつ**
行の追加・修正・削除は、主キーのあるテーブルでのみ行えます (主キーが無いと行を一意に特定できないため)。
更新・削除は**トランザクション内で実行し、影響行数がちょうど 1 行でなければ自動的にロールバック**します。
0 行なら「対象が既に無い」、2 行以上なら「キーの指定ミス」として、どちらもコミットしません。

**値はすべてバインド変数**
行の追加・修正・削除で使う値は、SQL 文字列に埋め込まず、必ずバインド変数として渡します。
確認画面に出る SQL の `?` は、この差し込み位置を表しています。

**SQL 実行の制限**
参照は `SELECT` / `WITH` で始まる 1 文のみ。更新系は書き込み可の接続でのみ、`INSERT` / `UPDATE` / `DELETE` / `MERGE` の 1 文だけを、確認を経て実行します。
**DDL (`CREATE` / `DROP` / `ALTER` / `TRUNCATE`) は常に拒否**します。
複数ステートメント (`;` 区切り) と、コメントで隠した更新文も拒否します。

**`WHERE` 句の無い `UPDATE` / `DELETE`**
テーブルの全行が対象になるため、通常の確認とは別に「全行が対象になることを理解しました」への
チェックを必須にしています。チェックが無い要求はサーバー側で拒否します。

**更新操作の記録**
成功した更新操作は `data/audit.log` に JSON Lines で追記され、画面の「履歴」から確認できます。

**識別子の検証**
スキーマ名・テーブル名・並び替え列名は SQL に埋め込む前に検証し、引用符やセミコロンを含む値を拒否します。

**`WHERE` 条件について**
`WHERE` 欄の内容は SQL にそのまま渡されます (自由な条件を書けるようにするため)。ここは参照 (`SELECT` / `COUNT`) にのみ使われ、更新・削除の条件には使いません。
DB ユーザーの権限がそのまま効くので、**移行元には参照専用の DB ユーザーを使うことを推奨します。**
ツール側の「読み取り専用」設定は誤操作を防ぐためのもので、DB 側の権限設定に代わるものではありません。

---

## 環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `PORT` | `3000` | 待ち受けポート |
| `DBM_HOST` | `127.0.0.1` | 待ち受けアドレス |
| `DBM_MASTER_KEY` | (なし) | パスワード暗号鍵。未設定なら `data/.masterkey` を自動生成 |
| `DBM_AUTH_USER` | (なし) | Basic 認証のユーザー名。localhost 以外で待ち受ける場合は必須 |
| `DBM_AUTH_PASS` | (なし) | Basic 認証のパスワード。公開時は 16 文字以上が必須 |
| `DBM_IDLE_TIMEOUT_MS` | `600000` | 接続を保持するアイドル時間 (既定 10 分) |

---

## 構成

```
server.js               Express アプリのエントリポイント
start.sh.example        起動スクリプトのひな形 (サーバ設置用)
DEPLOY.md               レンタルサーバへの設置手順
src/
  auth.js               Basic 認証と、公開時の起動ポリシー検査
  crypto.js             パスワードの暗号化・復号 (AES-256-GCM)
  store.js              接続プロファイルの永続化と検証
  pool.js               接続のキャッシュとアイドル切断
  drivers/
    index.js            ドライバのレジストリ
    util.js             値の正規化、参照専用ガード、識別子・主キー検証
    oracle.js           Oracle 用の実装 (all_tables / all_tab_columns など)
    mssql.js            SQL Server 用の実装 (sys.* カタログビュー)
    postgres.js         PostgreSQL 用の実装 (pg_catalog)
  audit.js              更新操作の記録 (data/audit.log)
  routes/
    connections.js      接続管理 API
    browse.js           参照系 API
    write.js            更新系 API (読み取り専用チェック・単一行保証)
public/
  index.html / app.js / style.css   画面 (ビルド不要の素の HTML/JS/CSS)
data/                   接続情報・暗号鍵・操作履歴 (gitignore 済み)
```

### ドライバの追加

`src/drivers/` の 3 ファイルは同じインターフェースを実装しています。新しい DB に対応するときは、同じ関数群 (`connect` / `listDatabases` / `listSchemas` / `listTables` / `describeTable` / `countRows` / `selectRows` / `runQuery` など) を実装して `src/drivers/index.js` に登録すれば、画面側の変更は不要です。

---

## API

すべて JSON。参照系は `?database=` でデータベースを切り替えます。

| メソッド | パス | 内容 |
|---|---|---|
| `GET` | `/api/connections/drivers` | 対応 DB 種別と導入状況 |
| `GET` | `/api/connections` | 接続一覧と、現在張っている接続 |
| `POST` | `/api/connections` | 接続の登録 |
| `PUT` | `/api/connections/:id` | 接続の更新 (パスワード省略時は既存値を維持) |
| `DELETE` | `/api/connections/:id` | 接続の削除 |
| `POST` | `/api/connections/test` | 未保存の入力値で接続テスト |
| `POST` | `/api/connections/:id/test` | 保存済み接続で接続テスト |
| `POST` | `/api/connections/:id/disconnect` | 接続を切断 |
| `GET` | `/api/db/:id/info` | サーバーのバージョン・接続ユーザー |
| `GET` | `/api/db/:id/databases` | データベース一覧 (Oracle は空配列) |
| `GET` | `/api/db/:id/schemas` | スキーマ一覧 |
| `GET` | `/api/db/:id/tables?schema=` | テーブル・ビュー一覧 |
| `GET` | `/api/db/:id/tables/:schema/:table` | 列定義・主キー・索引・外部キー |
| `GET` | `/api/db/:id/tables/:schema/:table/rows` | データ参照 (`limit` / `offset` / `orderBy` / `orderDir` / `where`) |
| `GET` | `/api/db/:id/tables/:schema/:table/count` | `COUNT(*)` (`where` 可) |
| `POST` | `/api/db/:id/query` | `SELECT` / `WITH` の実行 |
| `POST` | `/api/db/:id/tables/:schema/:table/rows` | 行の追加 |
| `PATCH` | `/api/db/:id/tables/:schema/:table/rows` | 行の修正 (主キー指定・1 行のみ) |
| `DELETE` | `/api/db/:id/tables/:schema/:table/rows` | 行の削除 (主キー指定・1 行のみ) |
| `POST` | `/api/db/:id/execute` | 更新系 SQL の実行 (`confirm: true` が必須。`WHERE` 無しなら `confirmAllRows: true` も必須) |
| `GET` | `/api/db/:id/audit` | 更新操作の履歴 |

更新系はすべて、接続が書き込み可でなければ HTTP 403 を返します。

---

## 日付・バイナリの扱い

移行ツールとして値をゆがめないよう、次のように扱っています。

- PostgreSQL の `date` / `timestamp without time zone` / `time` は、タイムゾーン情報を持たないため **DB が返した文字列のまま**表示します (JS の `Date` に変換するとローカルタイムゾーンの分だけずれるため)。
- Oracle は接続時にセッションの `NLS_DATE_FORMAT` などを `YYYY-MM-DD HH24:MI:SS` に固定し、`DATE` を文字列で受け取ります。
- `timestamp with time zone` は UTC の ISO 8601 形式で表示します。
- バイナリ (`bytea` / `BLOB` / `varbinary`) は先頭 32 バイトを 16 進数で表示し、全体のバイト数を添えます。
