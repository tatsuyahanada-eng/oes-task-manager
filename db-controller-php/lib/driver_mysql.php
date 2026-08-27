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

class MysqlDriver extends DbDriver
{
    /** MySQL 自身が使うデータベース。一覧から隠す。 */
    private const SYSTEM_DATABASES = ['information_schema', 'mysql', 'performance_schema', 'sys'];

    public function __construct(array $conn, string $database = '')
    {
        $this->conn = $conn;
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
            $this->pdo = new PDO($dsn, (string)$conn['username'], (string)$conn['password'], $options);
        } catch (PDOException $e) {
            throw bad('DB へ接続できませんでした: ' . $e->getMessage(), 502);
        }
    }

    /** 内部のバッククォートは 2 個にする。 */
    public function quote(string $name): string
    {
        return '`' . str_replace('`', '``', $name) . '`';
    }

    public function serverInfo(): array
    {
        $row = $this->one('SELECT VERSION() AS version, DATABASE() AS db, CURRENT_USER() AS usr');
        return [
            'version'  => $row['version'] ?? '',
            'database' => $row['db'] ?? '',
            'user'     => $row['usr'] ?? '',
        ];
    }

    public function listDatabases(): array
    {
        $out = [];
        foreach ($this->all('SHOW DATABASES') as $row) {
            $name = reset($row);
            if (!in_array($name, self::SYSTEM_DATABASES, true)) $out[] = $name;
        }
        sort($out);
        return $out;
    }

    /** MySQL では データベース = スキーマ。接続中のものだけ返す。 */
    public function listSchemas(): array
    {
        $db = $this->one('SELECT DATABASE() AS db')['db'] ?? '';
        if ($db === '') return [];

        $n = $this->one(
            'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?', [$db]);

        return [['name' => $db, 'tableCount' => (int)($n['n'] ?? 0)]];
    }

    public function listTables(string $schema): array
    {
        $rows = $this->all(
            'SELECT table_name AS name, table_type AS type, table_comment AS comment,
                    table_rows AS approx_rows, engine
               FROM information_schema.tables
              WHERE table_schema = ?
              ORDER BY table_type, table_name', [$schema]);

        return array_map(fn($r) => [
            'name'       => $r['name'],
            'type'       => ($r['type'] === 'VIEW') ? 'VIEW' : 'TABLE',
            'comment'    => ($r['comment'] ?? '') !== '' ? $r['comment'] : null,
            'approxRows' => (int)($r['approx_rows'] ?? 0),
            'engine'     => $r['engine'] ?? '',
        ], $rows);
    }

    public function describeTable(string $schema, string $table): array
    {
        $columns = $this->all(
            'SELECT column_name AS name, column_type AS data_type, is_nullable AS nullable,
                    column_default AS default_value, column_key AS ckey, extra,
                    column_comment AS comment, ordinal_position AS position
               FROM information_schema.columns
              WHERE table_schema = ? AND table_name = ?
              ORDER BY ordinal_position', [$schema, $table]);

        if (!$columns) throw bad('テーブルが見つかりません。', 404);

        $primaryKey = [];
        foreach ($columns as $c) {
            if ($c['ckey'] === 'PRI') $primaryKey[] = $c['name'];
        }

        $cols = array_map(fn($c) => [
            'position'     => (int)$c['position'],
            'name'         => $c['name'],
            'dataType'     => $c['data_type'],
            'nullable'     => $c['nullable'] === 'YES',
            'defaultValue' => $c['default_value'],
            'comment'      => ($c['comment'] ?? '') !== '' ? $c['comment'] : null,
            'isIdentity'   => str_contains((string)$c['extra'], 'auto_increment'),
            'isPrimaryKey' => in_array($c['name'], $primaryKey, true),
        ], $columns);

        // 索引
        $indexMap = [];
        foreach ($this->all('SHOW INDEX FROM ' . $this->quote($table)
                            . ' FROM ' . $this->quote($schema)) as $r) {
            $n = $r['Key_name'];
            if (!isset($indexMap[$n])) {
                $indexMap[$n] = ['name' => $n, 'primary' => $n === 'PRIMARY',
                                 'unique' => (int)$r['Non_unique'] === 0, 'columns' => []];
            }
            $indexMap[$n]['columns'][] = $r['Column_name'];
        }

        // 外部キー
        $fkRows = $this->all(
            'SELECT constraint_name AS name, column_name AS col,
                    referenced_table_schema AS ref_schema,
                    referenced_table_name AS ref_table, referenced_column_name AS ref_col
               FROM information_schema.key_column_usage
              WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL
              ORDER BY constraint_name, ordinal_position', [$schema, $table]);

        $meta = $this->one(
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
            'indexes'     => build_indexes($indexMap),
            'foreignKeys' => build_foreign_keys($fkRows, $schema),
        ];
    }
}
