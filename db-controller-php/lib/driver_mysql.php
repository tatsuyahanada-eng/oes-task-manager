<?php
/**
 * MySQL / MariaDB 用のドライバ。
 *
 * MySQL には PostgreSQL のような「データベースの中のスキーマ」という階層が無く、
 * データベース = スキーマ である。
 * 画面の階層を他の DB と揃えるため、スキーマ一覧には接続中のデータベースだけを返す。
 *
 * ロリポップなどの共用サーバでは、データベース名にハイフンが含まれることがある
 * （例: LAA1234567-shop）。識別子は必ずバッククォートで囲む。
 */

declare(strict_types=1);

/** MySQL 自身が使うデータベース。一覧から隠す。 */
const DBC_SYSTEM_DATABASES = ['information_schema', 'mysql', 'performance_schema', 'sys'];

function drivers(): array
{
    return [
        'mysql' => [
            'id' => 'mysql', 'label' => 'MySQL / MariaDB',
            'defaultPort' => 3306, 'supportsDatabaseSwitch' => true,
            'installed' => extension_loaded('pdo_mysql'), 'module' => 'pdo_mysql',
        ],
        'postgres' => [
            'id' => 'postgres', 'label' => 'PostgreSQL',
            'defaultPort' => 5432, 'supportsDatabaseSwitch' => true,
            'installed' => extension_loaded('pdo_pgsql'), 'module' => 'pdo_pgsql',
        ],
    ];
}

/** MySQL の識別子引用。内部のバッククォートは 2 個にする。 */
function q(string $name): string
{
    return '`' . str_replace('`', '``', $name) . '`';
}

/**
 * 識別子として妥当か確かめる。
 * 画面から来た名前をそのまま SQL に埋めないための最後の砦。
 */
function assert_identifier(string $name, string $what = '名前'): string
{
    if ($name === '' || mb_strlen($name) > 128) {
        throw bad("{$what}の長さが不正です。");
    }
    // 制御文字とバックスラッシュを弾く。ハイフンや日本語は許す。
    if (preg_match('/[\x00-\x1F\x7F\\\\]/u', $name)) {
        throw bad("{$what}に使えない文字が含まれています。");
    }
    return $name;
}

/** 接続する。 */
function db_connect(array $conn, string $database = ''): PDO
{
    if (!extension_loaded('pdo_mysql')) {
        throw bad('この PHP には pdo_mysql がありません。サーバの設定を確認してください。', 500);
    }

    $db = $database !== '' ? $database : (string)($conn['database'] ?? '');
    $dsn = sprintf('mysql:host=%s;port=%d;charset=utf8mb4', $conn['host'], (int)$conn['port']);
    if ($db !== '') $dsn .= ';dbname=' . $db;

    $options = [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        // プレースホルダを DB 側で処理させる。文字列に埋め込ませない。
        PDO::ATTR_EMULATE_PREPARES   => false,
        // 数値も日付も文字列のまま受け取り、勝手に変換させない
        PDO::ATTR_STRINGIFY_FETCHES  => true,
        PDO::ATTR_TIMEOUT            => 15,
        // UPDATE で「条件に一致した行数」を返させる。
        // 既定では「実際に変わった行数」なので、値が同じ UPDATE が 0 行に見えてしまう。
        PDO::MYSQL_ATTR_FOUND_ROWS   => true,
    ];
    if (!empty($conn['ssl'])) {
        $options[PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT] = false;
    }

    try {
        return new PDO($dsn, (string)$conn['username'], (string)$conn['password'], $options);
    } catch (PDOException $e) {
        throw bad('DB へ接続できませんでした: ' . $e->getMessage(), 502);
    }
}

/** 結果を配列で取る small helper。 */
function db_all(PDO $pdo, string $sql, array $params = []): array
{
    try {
        $st = $pdo->prepare($sql);
        $st->execute($params);
        return $st->fetchAll();
    } catch (PDOException $e) {
        throw bad('SQL の実行に失敗しました: ' . $e->getMessage(), 502);
    }
}

function db_one(PDO $pdo, string $sql, array $params = []): ?array
{
    $rows = db_all($pdo, $sql, $params);
    return $rows[0] ?? null;
}

/* ------------------------------------------------------------
 * 参照
 * ---------------------------------------------------------- */

function db_server_info(PDO $pdo): array
{
    $row = db_one($pdo, 'SELECT VERSION() AS version, DATABASE() AS db, CURRENT_USER() AS usr');
    return [
        'version'  => $row['version'] ?? '',
        'database' => $row['db'] ?? '',
        'user'     => $row['usr'] ?? '',
    ];
}

function db_list_databases(PDO $pdo): array
{
    $out = [];
    foreach (db_all($pdo, 'SHOW DATABASES') as $row) {
        $name = reset($row);
        if (!in_array($name, DBC_SYSTEM_DATABASES, true)) $out[] = $name;
    }
    sort($out);
    return $out;
}

/** MySQL では データベース = スキーマ。接続中のものだけ返す。 */
function db_list_schemas(PDO $pdo): array
{
    $row = db_one($pdo, 'SELECT DATABASE() AS db');
    $db = $row['db'] ?? '';
    if ($db === '') return [];

    $counts = db_one($pdo,
        'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?', [$db]);

    return [['name' => $db, 'tableCount' => (int)($counts['n'] ?? 0)]];
}

function db_list_tables(PDO $pdo, string $schema): array
{
    $rows = db_all($pdo,
        'SELECT table_name AS name, table_type AS type, table_comment AS comment,
                table_rows AS approx_rows, engine
           FROM information_schema.tables
          WHERE table_schema = ?
          ORDER BY table_type, table_name', [$schema]);

    return array_map(fn($r) => [
        'name'       => $r['name'],
        'type'       => ($r['type'] === 'VIEW') ? 'VIEW' : 'TABLE',
        'comment'    => $r['comment'] ?? '',
        'approxRows' => (int)($r['approx_rows'] ?? 0),
        'engine'     => $r['engine'] ?? '',
    ], $rows);
}

function db_describe_table(PDO $pdo, string $schema, string $table): array
{
    $columns = db_all($pdo,
        'SELECT column_name AS name, column_type AS type, is_nullable AS nullable,
                column_default AS dflt, column_key AS ckey, extra, column_comment AS comment,
                ordinal_position AS pos
           FROM information_schema.columns
          WHERE table_schema = ? AND table_name = ?
          ORDER BY ordinal_position', [$schema, $table]);

    if (!$columns) throw bad('テーブルが見つかりません。', 404);

    $primaryKey = [];
    $cols = [];
    foreach ($columns as $c) {
        if ($c['ckey'] === 'PRI') $primaryKey[] = $c['name'];
    }
    foreach ($columns as $c) {
        // 画面が読む名前に合わせる（Node 版と同じ形）
        $cols[] = [
            'position'     => (int)$c['pos'],
            'name'         => $c['name'],
            'dataType'     => $c['type'],
            'nullable'     => $c['nullable'] === 'YES',
            'defaultValue' => $c['dflt'],
            'comment'      => ($c['comment'] ?? '') !== '' ? $c['comment'] : null,
            'isIdentity'   => str_contains((string)$c['extra'], 'auto_increment'),
            'isPrimaryKey' => in_array($c['name'], $primaryKey, true),
        ];
    }

    // 索引
    $indexMap = [];
    foreach (db_all($pdo, 'SHOW INDEX FROM ' . q($table) . ' FROM ' . q($schema)) as $r) {
        $n = $r['Key_name'];
        if (!isset($indexMap[$n])) {
            $indexMap[$n] = [
                'name'    => $n,
                'primary' => $n === 'PRIMARY',
                'unique'  => (int)$r['Non_unique'] === 0,
                'columns' => [],
            ];
        }
        $indexMap[$n]['columns'][] = $r['Column_name'];
    }
    $indexes = [];
    foreach ($indexMap as $idx) {
        $prefix = $idx['primary'] ? 'PRIMARY KEY ' : ($idx['unique'] ? 'UNIQUE ' : '');
        $middle = $idx['primary'] ? '' : "INDEX {$idx['name']} ";
        $idx['definition'] = $prefix . $middle . '(' . implode(', ', $idx['columns']) . ')';
        $indexes[] = $idx;
    }

    // 外部キー
    $fkRows = db_all($pdo,
        'SELECT constraint_name AS name, column_name AS col,
                referenced_table_schema AS ref_schema,
                referenced_table_name AS ref_table, referenced_column_name AS ref_col
           FROM information_schema.key_column_usage
          WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL
          ORDER BY constraint_name, ordinal_position', [$schema, $table]);

    $fkMap = [];
    foreach ($fkRows as $r) {
        $n = $r['name'];
        if (!isset($fkMap[$n])) {
            $fkMap[$n] = [
                'name' => $n, 'columns' => [],
                'refSchema' => $r['ref_schema'], 'refTable' => $r['ref_table'],
                'refColumns' => [],
            ];
        }
        $fkMap[$n]['columns'][] = $r['col'];
        $fkMap[$n]['refColumns'][] = $r['ref_col'];
    }
    $foreignKeys = [];
    foreach ($fkMap as $fk) {
        $ref = ($fk['refSchema'] === $schema ? '' : $fk['refSchema'] . '.') . $fk['refTable'];
        $fk['definition'] = 'FOREIGN KEY (' . implode(', ', $fk['columns']) . ') REFERENCES '
                          . $ref . ' (' . implode(', ', $fk['refColumns']) . ')';
        $foreignKeys[] = $fk;
    }

    $meta = db_one($pdo,
        'SELECT table_comment AS comment, table_type AS type
           FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
        [$schema, $table]);

    return [
        'schema'      => $schema,
        'table'       => $table,
        'type'        => (($meta['type'] ?? '') === 'VIEW') ? 'VIEW' : 'TABLE',
        'comment'     => ($meta['comment'] ?? '') !== '' ? $meta['comment'] : null,
        'columns'     => $cols,
        'primaryKey'  => $primaryKey,
        'indexes'     => $indexes,
        'foreignKeys' => $foreignKeys,
    ];
}

function db_count_rows(PDO $pdo, string $schema, string $table, string $where = ''): int
{
    $sql = 'SELECT COUNT(*) AS n FROM ' . q($schema) . '.' . q($table);
    if ($where !== '') $sql .= ' WHERE ' . assert_where($where);
    $row = db_one($pdo, $sql);
    return (int)($row['n'] ?? 0);
}

/**
 * WHERE 句の検査。
 * 画面から自由に書ける欄なので、複文と危険な語を弾く。
 */
function assert_where(string $where): string
{
    $w = trim($where);
    if ($w === '') return '';
    if (mb_strlen($w) > 2000) throw bad('WHERE 条件が長すぎます。');
    if (str_contains($w, ';')) throw bad('WHERE 条件にセミコロンは使えません。');

    // コメント記法で残りを無効化する手口を塞ぐ
    if (preg_match('/(--|\/\*|#)/', $w)) {
        throw bad('WHERE 条件にコメント記法は使えません。');
    }
    // 参照以外の語を弾く
    if (preg_match('/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|INTO)\b/i', $w)) {
        throw bad('WHERE 条件には参照以外の命令を書けません。');
    }
    return $w;
}

function db_select_rows(PDO $pdo, string $schema, string $table,
                        string $where, string $orderBy, string $orderDir,
                        int $limit, int $offset): array
{
    $limit = max(1, min($limit, 1000));
    $offset = max(0, $offset);

    $sql = 'SELECT * FROM ' . q($schema) . '.' . q($table);
    if ($where !== '') $sql .= ' WHERE ' . assert_where($where);
    if ($orderBy !== '') {
        $dir = strtoupper($orderDir) === 'DESC' ? 'DESC' : 'ASC';
        $sql .= ' ORDER BY ' . q(assert_identifier($orderBy, '並び替えの列')) . ' ' . $dir;
    }
    // LIMIT / OFFSET は整数に固めてから埋める
    $sql .= sprintf(' LIMIT %d OFFSET %d', $limit, $offset);

    try {
        $st = $pdo->query($sql);
        $rows = $st->fetchAll(PDO::FETCH_NUM);
        $columns = [];
        for ($i = 0; $i < $st->columnCount(); $i++) {
            $m = $st->getColumnMeta($i);
            $columns[] = $m['name'] ?? ('col' . $i);
        }
        return ['columns' => $columns, 'rows' => $rows, 'sql' => $sql];
    } catch (PDOException $e) {
        throw bad('データを取得できませんでした: ' . $e->getMessage(), 502);
    }
}

/** 自由入力の SELECT。参照だけを許す。 */
function db_run_query(PDO $pdo, string $sql, int $limit): array
{
    $s = trim($sql);
    if ($s === '') throw bad('SQL を入力してください。');
    $s = rtrim($s, "; \t\n\r");
    if (str_contains($s, ';')) throw bad('複数の文はまとめて実行できません。');
    if (!preg_match('/^\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b/i', $s)) {
        throw bad('参照系（SELECT / SHOW / DESCRIBE / EXPLAIN）だけ実行できます。');
    }

    try {
        $st = $pdo->query($s);
        $rows = $st->fetchAll(PDO::FETCH_NUM);
        $columns = [];
        for ($i = 0; $i < $st->columnCount(); $i++) {
            $m = $st->getColumnMeta($i);
            $columns[] = $m['name'] ?? ('col' . $i);
        }
        if (count($rows) > $limit) $rows = array_slice($rows, 0, $limit);
        return ['columns' => $columns, 'rows' => $rows, 'sql' => $s];
    } catch (PDOException $e) {
        throw bad('SQL の実行に失敗しました: ' . $e->getMessage(), 502);
    }
}
