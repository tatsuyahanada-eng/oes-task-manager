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
            throw bad($this->explain($e, (string)$conn['username'], $db,
                                     (string)$conn['password']), 502);
        }
    }

    /**
     * 受け取ったパスワードの「形」だけを伝える。
     *
     * 中身は出さない。長さと、前後の空白の有無だけ。
     * 貼り付けたつもりの値と食い違っていないか（ブラウザの自動入力が
     * 別の値を入れていないか、改行が混ざっていないか）を、
     * 利用者自身が確かめられるようにするため。
     */
    private function passwordShape(string $password): string
    {
        if ($password === '') {
            return "\n\n※ パスワードが送られていません（空でした）。";
        }

        $len = strlen($password);
        $out = "\n\n［送信されたパスワードの形］"
             . "\n・長さ: {$len} 文字"
             . "\n　管理画面の値と長さが違うなら、別の値が入っています。";

        if (trim($password) !== $password) {
            $out .= "\n・<<前後に空白か改行が混ざっています>>"
                  . "\n　貼り付けのときに紛れ込んだ可能性があります。入れ直してください。";
        }
        return $out;
    }

    /**
     * 接続エラーを、次に何をすればよいか分かる文言にする。
     * MySQL の生のメッセージ（SQLSTATE[HY000] [1045] ...）は
     * 原因が読み取りにくいため。
     */
    private function explain(PDOException $e, string $user, string $db,
                             string $password = ''): string
    {
        $m = $e->getMessage();
        // 説明を付けても、元のメッセージは必ず最後に残す。
        // 分類を誤ったときに、こちらが手掛かりになる。
        $raw = "\n\n［サーバからの元のメッセージ］\n" . $m;

        // 1044: ユーザーは正しいが、その DB を使う権限が無い
        if (str_contains($m, '[1044]')) {
            return "ユーザー「{$user}」に、データベース「{$db}」を使う権限がありません。"
                 . '管理画面で、そのデータベースに割り当てられているユーザー名を確認してください。' . $raw;
        }

        // 1045: ユーザー名かパスワードが違う
        if (str_contains($m, '[1045]') || str_contains($m, 'Access denied for user')) {
            return 'ユーザー名かパスワードが違います。'
                 . '（サーバまでは届いています）'
                 . "\n\n確認すること:"
                 . "\n・管理画面の「ユーザー名」を、そのまま写しているか（いまの指定: {$user}）"
                 . "\n・パスワードを貼り直したか"
                 . "\n　ブラウザがログイン用のパスワードを自動で入れてしまうことがあります。"
                 . "\n　欄をいったん空にして、管理画面の値を貼り付けてください。"
                 . "\n・「SSL を使用」を外して試したか"
                 . "\n　SSL 必須の設定になっていない限り、共用サーバでは通常オフです。"
                 . "\n・phpMyAdmin に同じユーザー名とパスワードで入れるか"
                 . "\n　入れないなら認証情報そのものが違います。入れるならこちらの設定の問題です。"
                 . $this->passwordShape($password)
                 . $raw;
        }

        // 1049: データベース名が違う
        if (str_contains($m, '[1049]') || str_contains($m, 'Unknown database')) {
            return "データベース「{$db}」が見つかりません。"
                 . '管理画面の「データベース名」を、そのまま写してください。'
                 . 'ハイフンを含む名前（LAA1234567-shop など）でも構いません。' . $raw;
        }

        // ホスト名を引けない。MySQL は 2005 ではなく
        // 2002 + getaddrinfo 失敗として返すことがある。
        if (str_contains($m, '[2005]') || str_contains($m, 'Unknown MySQL server host')
            || str_contains($m, 'getaddrinfo')) {
            return 'ホスト名が見つかりません。管理画面の「サーバー」欄を確認してください。'
                 . '（.lan で終わる名前は、そのサーバの中からしか引けません）' . $raw;
        }

        // 2002 / 2003: 届かない
        if (str_contains($m, '[2002]') || str_contains($m, '[2003]')
            || str_contains($m, 'Connection refused') || str_contains($m, 'timed out')) {
            return 'サーバへ届きませんでした。ホスト名とポート（通常 3306）を確認してください。' . $raw;
        }

        // 1130: この接続元からは受け付けない
        if (str_contains($m, '[1130]')) {
            return "この場所からの接続が許可されていません。"
                 . 'DB の利用者に、接続元の制限がかかっている可能性があります。' . $raw;
        }

        return 'DB へ接続できませんでした: ' . $m;
    }

    /** 内部のバッククォートは 2 個にする。 */
    public function quote(string $name): string
    {
        return '`' . str_replace('`', '``', $name) . '`';
    }

    /** 読み取った型の区分を MySQL の型名に直す。 */
    public function sqlType(array $col): string
    {
        switch ($col['kind']) {
            case 'int':      return 'INT';
            case 'bigint':   return 'BIGINT';
            case 'decimal':  return "DECIMAL({$col['precision']},{$col['scale']})";
            case 'bool':     return 'TINYINT(1)';
            case 'date':     return 'DATE';
            case 'datetime': return 'DATETIME';
            case 'varchar':  return "VARCHAR({$col['length']})";
            default:         return 'TEXT';
        }
    }

    public function surrogateKeySql(string $name): string
    {
        return $this->quote($name) . ' BIGINT NOT NULL AUTO_INCREMENT';
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
