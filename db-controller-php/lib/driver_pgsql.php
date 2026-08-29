<?php
/**
 * PostgreSQL / Supabase 用のドライバ。
 *
 * MySQL との大きな違い:
 *   - 「データベース > スキーマ > テーブル」の 3 階層がある（public が既定）
 *   - 接続後にデータベースを切り替えられない。別の DB は別接続になる
 *   - 識別子は二重引用符で囲む。囲まないと小文字に畳まれる
 *
 * Supabase も中身は PostgreSQL だが、接続の作法が決まっている:
 *   - Connection Pooler 経由（ポート 6543 = Transaction / 5432 = Session）
 *   - SSL が必須
 *   - ユーザー名が「postgres.プロジェクトID」の形になる
 */

declare(strict_types=1);

class PgsqlDriver extends DbDriver
{
    /** PostgreSQL 自身が使うスキーマ。一覧から隠す。 */
    private const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

    public function __construct(array $conn, string $database = '')
    {
        $this->conn = $conn;
        $db = $database !== '' ? $database : (string)($conn['database'] ?? '');
        if ($db === '') $db = 'postgres';

        $dsn = sprintf('pgsql:host=%s;port=%d;dbname=%s', $conn['host'], (int)$conn['port'], $db);

        // Supabase は SSL 必須。PostgreSQL でも指定があれば要求する。
        $isSupabase = ($conn['type'] ?? '') === 'supabase';
        if ($isSupabase || !empty($conn['ssl'])) {
            $dsn .= ';sslmode=require';
        }
        $dsn .= ';connect_timeout=15';

        $options = [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
            // 数値も日付も文字列のまま受け取る（タイムゾーンでずらさない）
            PDO::ATTR_STRINGIFY_FETCHES  => true,
        ];

        try {
            $this->pdo = new PDO($dsn, (string)$conn['username'], (string)$conn['password'], $options);
        } catch (PDOException $e) {
            throw bad($this->explain($e, $isSupabase), 502);
        }
    }

    /**
     * 接続エラーを、次に何をすればよいか分かる文言にする。
     * PostgreSQL の生のメッセージは原因が読み取りにくいため。
     */
    private function explain(PDOException $e, bool $isSupabase): string
    {
        $m = $e->getMessage();

        if (str_contains($m, 'SSL') || str_contains($m, 'server does not support SSL')) {
            return 'SSL で接続できませんでした。接続設定の「SSL を使用」を切り替えて試してください。'
                 . '（元のメッセージ: ' . $m . '）';
        }
        if (str_contains($m, 'password authentication failed')) {
            return 'ユーザー名またはパスワードが違います。'
                 . ($isSupabase
                    ? 'Supabase ではユーザー名が「postgres.プロジェクトID」の形になります。'
                    : '');
        }
        if (str_contains($m, 'does not exist')) {
            return 'データベース名かユーザー名が見つかりません。綴りを確認してください。'
                 . '（元のメッセージ: ' . $m . '）';
        }
        if (str_contains($m, 'Connection refused') || str_contains($m, 'timeout')
            || str_contains($m, 'could not connect')) {
            return 'サーバへ届きませんでした。ホスト名とポートを確認してください。'
                 . ($isSupabase
                    ? 'Supabase は Pooler のポート（Transaction 6543 / Session 5432）を使います。'
                    : '')
                 . '（元のメッセージ: ' . $m . '）';
        }
        return 'DB へ接続できませんでした: ' . $m;
    }

    /** 内部の二重引用符は 2 個にする。 */
    public function quote(string $name): string
    {
        return '"' . str_replace('"', '""', $name) . '"';
    }

    /** 読み取った型の区分を PostgreSQL の型名に直す。 */
    public function sqlType(array $col): string
    {
        switch ($col['kind']) {
            case 'int':      return 'INTEGER';
            case 'bigint':   return 'BIGINT';
            case 'decimal':  return "NUMERIC({$col['precision']},{$col['scale']})";
            case 'bool':     return 'BOOLEAN';
            case 'date':     return 'DATE';
            case 'datetime': return 'TIMESTAMP';
            case 'varchar':  return "VARCHAR({$col['length']})";
            default:         return 'TEXT';
        }
    }

    public function surrogateKeySql(string $name): string
    {
        return $this->quote($name) . ' BIGINT GENERATED ALWAYS AS IDENTITY';
    }

    /**
     * サーバ側カーソルで、1 行ずつ受け取る。
     *
     * PostgreSQL の PDO は、非バッファの指定が無く、query() で全行を受け取ってしまう。
     * カーソルを宣言して少しずつ FETCH すれば、必要な分だけ取り寄せられる。
     * カーソルはトランザクションの中でしか使えないので、ここで開いて閉じる。
     */
    public function streamSelect(string $sql, callable $onRow, ?callable $onColumns = null): int
    {
        // 呼び出し側が既にトランザクションを開いていれば、それに乗る
        $ownTx = !$this->pdo->inTransaction();
        if ($ownTx) $this->pdo->beginTransaction();

        // 同時に複数開いても衝突しないよう、名前を毎回変える
        $cur = 'dbc_cur_' . bin2hex(random_bytes(6));
        $n = 0;
        try {
            $this->pdo->exec("DECLARE {$cur} NO SCROLL CURSOR FOR " . $sql);
            $stop = false;
            $told = false;
            while (!$stop) {
                $st = $this->pdo->query("FETCH 1000 FROM {$cur}");
                // 列名は 0 件でも取れるので、最初の FETCH の時点で伝える
                if (!$told && $onColumns !== null) { $onColumns($this->columnNames($st)); $told = true; }
                $batch = $st->fetchAll(PDO::FETCH_NUM);
                if (!$batch) break;
                foreach ($batch as $row) {
                    $n++;
                    if ($onRow($row) === false) { $stop = true; break; }
                }
            }
            $this->pdo->exec("CLOSE {$cur}");
            if ($ownTx) $this->pdo->commit();
        } catch (Throwable $e) {
            if ($ownTx && $this->pdo->inTransaction()) $this->pdo->rollBack();
            throw $e;
        }
        return $n;
    }

    public function serverInfo(): array
    {
        $row = $this->one(
            'SELECT version() AS version, current_database() AS db, current_user AS usr');
        return [
            'version'  => $row['version'] ?? '',
            'database' => $row['db'] ?? '',
            'user'     => $row['usr'] ?? '',
        ];
    }

    public function listDatabases(): array
    {
        $rows = $this->all(
            'SELECT datname FROM pg_database
              WHERE datistemplate = false AND datallowconn = true
              ORDER BY datname');
        return array_map(fn($r) => $r['datname'], $rows);
    }

    public function listSchemas(): array
    {
        $rows = $this->all(
            "SELECT n.nspname AS name,
                    (SELECT COUNT(*) FROM information_schema.tables t
                      WHERE t.table_schema = n.nspname) AS table_count
               FROM pg_namespace n
              WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
                AND n.nspname NOT LIKE 'pg_temp%'
                AND n.nspname NOT LIKE 'pg_toast_temp%'
              ORDER BY n.nspname");

        return array_map(fn($r) => [
            'name' => $r['name'], 'tableCount' => (int)$r['table_count'],
        ], $rows);
    }

    public function listTables(string $schema): array
    {
        $rows = $this->all(
            "SELECT c.relname AS name,
                    CASE WHEN c.relkind IN ('v','m') THEN 'VIEW' ELSE 'TABLE' END AS type,
                    obj_description(c.oid) AS comment,
                    c.reltuples AS approx_rows
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = ? AND c.relkind IN ('r','p','v','m')
              ORDER BY type, c.relname", [$schema]);

        return array_map(fn($r) => [
            'name'       => $r['name'],
            'type'       => $r['type'],
            'comment'    => ($r['comment'] ?? '') !== '' ? $r['comment'] : null,
            'approxRows' => max(0, (int)(float)$r['approx_rows']),
            'engine'     => '',
        ], $rows);
    }

    public function describeTable(string $schema, string $table): array
    {
        $columns = $this->all(
            "SELECT a.attname AS name,
                    format_type(a.atttypid, a.atttypmod) AS data_type,
                    NOT a.attnotnull AS nullable,
                    pg_get_expr(d.adbin, d.adrelid) AS default_value,
                    col_description(a.attrelid, a.attnum) AS comment,
                    a.attnum AS position,
                    (a.attidentity <> '' OR pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval%')
                      AS is_identity
               FROM pg_attribute a
               JOIN pg_class c ON c.oid = a.attrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
               LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
              WHERE n.nspname = ? AND c.relname = ? AND a.attnum > 0 AND NOT a.attisdropped
              ORDER BY a.attnum", [$schema, $table]);

        if (!$columns) throw bad('テーブルが見つかりません。', 404);

        // 主キー
        $pkRows = $this->all(
            "SELECT a.attname AS name
               FROM pg_index i
               JOIN pg_class c ON c.oid = i.indrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
               JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
              WHERE n.nspname = ? AND c.relname = ? AND i.indisprimary
              ORDER BY array_position(i.indkey, a.attnum)", [$schema, $table]);
        $primaryKey = array_map(fn($r) => $r['name'], $pkRows);

        $cols = array_map(fn($c) => [
            'position'     => (int)$c['position'],
            'name'         => $c['name'],
            'dataType'     => $c['data_type'],
            // PDO は bool を 't'/'f' や 1/'' で返すことがあるので緩く判定する
            'nullable'     => in_array($c['nullable'], [true, 't', '1', 1], true),
            'defaultValue' => $c['default_value'],
            'comment'      => ($c['comment'] ?? '') !== '' ? $c['comment'] : null,
            'isIdentity'   => in_array($c['is_identity'], [true, 't', '1', 1], true),
            'isPrimaryKey' => in_array($c['name'], $primaryKey, true),
        ], $columns);

        // 索引
        $idxRows = $this->all(
            "SELECT i.relname AS name, ix.indisprimary AS is_primary, ix.indisunique AS is_unique,
                    a.attname AS column_name, array_position(ix.indkey, a.attnum) AS ord
               FROM pg_index ix
               JOIN pg_class i ON i.oid = ix.indexrelid
               JOIN pg_class c ON c.oid = ix.indrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
               JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(ix.indkey)
              WHERE n.nspname = ? AND c.relname = ?
              ORDER BY i.relname, ord", [$schema, $table]);

        $indexMap = [];
        foreach ($idxRows as $r) {
            $n = $r['name'];
            if (!isset($indexMap[$n])) {
                $indexMap[$n] = [
                    'name'    => $n,
                    'primary' => in_array($r['is_primary'], [true, 't', '1', 1], true),
                    'unique'  => in_array($r['is_unique'], [true, 't', '1', 1], true),
                    'columns' => [],
                ];
            }
            $indexMap[$n]['columns'][] = $r['column_name'];
        }

        // 外部キー
        $fkRows = $this->all(
            "SELECT con.conname AS name, att.attname AS col,
                    fn.nspname AS ref_schema, fc.relname AS ref_table, fatt.attname AS ref_col
               FROM pg_constraint con
               JOIN pg_class c ON c.oid = con.conrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
               JOIN pg_class fc ON fc.oid = con.confrelid
               JOIN pg_namespace fn ON fn.oid = fc.relnamespace
               JOIN LATERAL unnest(con.conkey, con.confkey)
                    WITH ORDINALITY AS k(att_num, fatt_num, ord) ON true
               JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum = k.att_num
               JOIN pg_attribute fatt ON fatt.attrelid = fc.oid AND fatt.attnum = k.fatt_num
              WHERE n.nspname = ? AND c.relname = ? AND con.contype = 'f'
              ORDER BY con.conname, k.ord", [$schema, $table]);

        $meta = $this->one(
            "SELECT obj_description(c.oid) AS comment,
                    CASE WHEN c.relkind IN ('v','m') THEN 'VIEW' ELSE 'TABLE' END AS type
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = ? AND c.relname = ?", [$schema, $table]);

        return [
            'schema'      => $schema,
            'table'       => $table,
            'type'        => $meta['type'] ?? 'TABLE',
            'comment'     => ($meta['comment'] ?? '') !== '' ? $meta['comment'] : null,
            'columns'     => $cols,
            'primaryKey'  => $primaryKey,
            'indexes'     => build_indexes($indexMap),
            'foreignKeys' => build_foreign_keys($fkRows, $schema),
        ];
    }
}
