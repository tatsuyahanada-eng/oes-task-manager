<?php
/**
 * DB ドライバの共通部分。
 *
 * MySQL と PostgreSQL で SQL の書き方が違うところを、この層で吸収する。
 * 画面と更新処理は、どちらの DB でも同じ形の結果を受け取れる。
 */

declare(strict_types=1);

abstract class DbDriver
{
    protected PDO $pdo;
    protected array $conn;

    /** 画面のプルダウン用のメタデータ。 */
    public static function catalog(): array
    {
        return [
            [
                'id' => 'mysql', 'label' => 'MySQL / MariaDB',
                'defaultPort' => 3306, 'supportsDatabaseSwitch' => true,
                'installed' => extension_loaded('pdo_mysql'), 'module' => 'pdo_mysql',
                'hint' => 'ロリポップなど共用サーバの DB。ホストは管理画面の「サーバー」欄',
            ],
            [
                'id' => 'postgres', 'label' => 'PostgreSQL',
                'defaultPort' => 5432, 'supportsDatabaseSwitch' => true,
                'installed' => extension_loaded('pdo_pgsql'), 'module' => 'pdo_pgsql',
                'hint' => '自前の PostgreSQL。スキーマ（public など）でテーブルが分かれます',
            ],
            [
                'id' => 'supabase', 'label' => 'Supabase (PostgreSQL)',
                'defaultPort' => 6543, 'supportsDatabaseSwitch' => false,
                'installed' => extension_loaded('pdo_pgsql'), 'module' => 'pdo_pgsql',
                'hint' => 'Supabase の Connection Pooler を使います。SSL は必須です',
            ],
        ];
    }

    /**
     * 接続情報をどこから持ってくるか、種別ごとの案内。
     * 画面の入力欄の下に出して、管理画面のどの項目を写せばよいかを示す。
     */
    public static function guide(string $type): array
    {
        $guides = [
            'mysql' => [
                'title' => 'ロリポップなど共用サーバの MySQL',
                'where' => '管理画面「サーバーの管理・設定 → データベース」',
                'fields' => [
                    'host'     => ['label' => 'ホスト', 'from' => '「サーバー」欄',
                                   'example' => 'mysql151.phy.lolipop.lan',
                                   'note' => '.lan で終わる名前は、そのサーバの中からしか届きません'],
                    'port'     => ['label' => 'ポート', 'from' => '記載が無ければ既定のまま',
                                   'example' => '3306', 'note' => ''],
                    'database' => ['label' => 'データベース', 'from' => '「データベース名」欄',
                                   'example' => 'LAA1234567-shop',
                                   'note' => 'ハイフンを含んでいて構いません'],
                    'username' => ['label' => 'ユーザー名', 'from' => '「ユーザー名」欄',
                                   'example' => 'LAA1234567', 'note' => ''],
                    'ssl'      => ['label' => 'SSL', 'from' => '通常はオフ',
                                   'example' => 'オフ',
                                   'note' => '共用サーバは SSL を受け付けないことがあります'],
                ],
            ],
            'postgres' => [
                'title' => '自前の PostgreSQL',
                'where' => 'サーバの設定（postgresql.conf / pg_hba.conf）',
                'fields' => [
                    'host'     => ['label' => 'ホスト', 'from' => 'サーバのアドレス',
                                   'example' => 'db.example.com', 'note' => ''],
                    'port'     => ['label' => 'ポート', 'from' => '既定は 5432',
                                   'example' => '5432', 'note' => ''],
                    'database' => ['label' => 'データベース', 'from' => 'CREATE DATABASE で作った名前',
                                   'example' => 'welsys_db',
                                   'note' => 'PostgreSQL は接続後に切り替えられません。DB ごとに登録します'],
                    'username' => ['label' => 'ユーザー名', 'from' => 'ロール名',
                                   'example' => 'welsys', 'note' => ''],
                    'ssl'      => ['label' => 'SSL', 'from' => 'インターネット越しなら必ずオン',
                                   'example' => 'オン', 'note' => ''],
                ],
            ],
            'supabase' => [
                'title' => 'Supabase',
                'where' => 'Supabase の画面 → Project Settings → Database → Connection string',
                'fields' => [
                    'host'     => ['label' => 'ホスト', 'from' => 'Connection pooling の Host',
                                   'example' => 'aws-0-ap-northeast-1.pooler.supabase.com',
                                   'note' => 'db.xxxx.supabase.co ではなく pooler の方を使います'],
                    'port'     => ['label' => 'ポート', 'from' => 'Transaction は 6543 / Session は 5432',
                                   'example' => '6543',
                                   'note' => 'まずは 6543 で試してください'],
                    'database' => ['label' => 'データベース', 'from' => 'ほぼ postgres 固定',
                                   'example' => 'postgres', 'note' => ''],
                    'username' => ['label' => 'ユーザー名', 'from' => 'Connection pooling の User',
                                   'example' => 'postgres.abcdefghijklmnop',
                                   'note' => 'postgres だけではなく、後ろにプロジェクト ID が付きます'],
                    'ssl'      => ['label' => 'SSL', 'from' => '必須',
                                   'example' => 'オン（自動）',
                                   'note' => 'Supabase は SSL 必須なので、指定に関わらず有効にします'],
                ],
            ],
        ];
        return $guides[$type] ?? ['title' => '', 'where' => '', 'fields' => []];

    }

    public static function meta(string $type): ?array
    {
        foreach (self::catalog() as $d) {
            if ($d['id'] === $type) return $d;
        }
        return null;
    }

    /** 接続情報から、対応するドライバを作る。 */
    public static function open(array $conn, string $database = ''): DbDriver
    {
        $type = (string)($conn['type'] ?? '');
        $meta = self::meta($type);
        if ($meta === null) throw bad('対応していない DB 種別です。');
        if (!$meta['installed']) {
            throw bad("この PHP には {$meta['module']} がありません。"
                . "「{$meta['label']}」は使えません。サーバの設定を確認してください。", 500);
        }

        if ($type === 'mysql') return new MysqlDriver($conn, $database);
        return new PgsqlDriver($conn, $database);
    }

    public function pdo(): PDO { return $this->pdo; }

    /* ------------------------------------------------------------
     * 共通の小道具
     * ---------------------------------------------------------- */

    protected function all(string $sql, array $params = []): array
    {
        try {
            $st = $this->pdo->prepare($sql);
            $st->execute($params);
            return $st->fetchAll();
        } catch (PDOException $e) {
            throw bad('SQL の実行に失敗しました: ' . $e->getMessage(), 502);
        }
    }

    protected function one(string $sql, array $params = []): ?array
    {
        return $this->all($sql, $params)[0] ?? null;
    }

    /** 結果セットを { columns, rows } の形にして返す。 */
    protected function fetchGrid(PDOStatement $st): array
    {
        $rows = $st->fetchAll(PDO::FETCH_NUM);
        $columns = [];
        for ($i = 0; $i < $st->columnCount(); $i++) {
            $m = @$st->getColumnMeta($i);
            $columns[] = $m['name'] ?? ('col' . $i);
        }
        return ['columns' => $columns, 'rows' => $rows];
    }

    /**
     * WHERE 句の検査。
     * 画面から自由に書ける欄なので、複文と参照以外の語を弾く。
     */
    public function assertWhere(string $where): string
    {
        $w = trim($where);
        if ($w === '') return '';
        if (mb_strlen($w) > 2000) throw bad('WHERE 条件が長すぎます。');
        if (str_contains($w, ';')) throw bad('WHERE 条件にセミコロンは使えません。');
        if (preg_match('/(--|\/\*|#)/', $w)) {
            throw bad('WHERE 条件にコメント記法は使えません。');
        }
        if (preg_match('/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|INTO|COPY)\b/i', $w)) {
            throw bad('WHERE 条件には参照以外の命令を書けません。');
        }
        return $w;
    }

    /**
     * 識別子として妥当か確かめる。
     * 画面から来た名前をそのまま SQL に埋めないための最後の砦。
     */
    public function assertIdentifier(string $name, string $what = '名前'): string
    {
        if ($name === '' || mb_strlen($name) > 128) {
            throw bad("{$what}の長さが不正です。");
        }
        if (preg_match('/[\x00-\x1F\x7F\\\\]/u', $name)) {
            throw bad("{$what}に使えない文字が含まれています。");
        }
        return $name;
    }

    /** 自由入力の SQL。参照系だけを許す。 */
    public function runQuery(string $sql, int $limit): array
    {
        $s = trim($sql);
        if ($s === '') throw bad('SQL を入力してください。');
        $s = rtrim($s, "; \t\n\r");
        if (str_contains($s, ';')) throw bad('複数の文はまとめて実行できません。');
        if (!preg_match('/^\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b/i', $s)) {
            throw bad('参照系（SELECT / SHOW / DESCRIBE / EXPLAIN）だけ実行できます。');
        }

        try {
            $grid = $this->fetchGrid($this->pdo->query($s));
        } catch (PDOException $e) {
            throw bad('SQL の実行に失敗しました: ' . $e->getMessage(), 502);
        }
        if (count($grid['rows']) > $limit) $grid['rows'] = array_slice($grid['rows'], 0, $limit);
        return $grid + ['sql' => $s];
    }

    /* ------------------------------------------------------------
     * 各 DB が実装するもの
     * ---------------------------------------------------------- */

    abstract public function quote(string $name): string;
    abstract public function serverInfo(): array;
    abstract public function listDatabases(): array;
    abstract public function listSchemas(): array;
    abstract public function listTables(string $schema): array;
    abstract public function describeTable(string $schema, string $table): array;

    /** 完全修飾したテーブル名。 */
    public function qualify(string $schema, string $table): string
    {
        return $this->quote($schema) . '.' . $this->quote($table);
    }

    public function countRows(string $schema, string $table, string $where = '', bool $whereValidated = false): int
    {
        $sql = 'SELECT COUNT(*) AS n FROM ' . $this->qualify($schema, $table);
        if ($where !== '') $sql .= ' WHERE ' . ($whereValidated ? $where : $this->assertWhere($where));
        return (int)($this->one($sql)['n'] ?? 0);
    }

    /** 検索パネルで選べる演算子。ここに無いものは弾く。 */
    private const FILTER_OPS = [
        'eq', 'ne', 'gt', 'gte', 'lt', 'lte',
        'contains', 'starts_with', 'ends_with',
        'between', 'in', 'is_null', 'is_not_null',
    ];

    /**
     * 検索パネルの条件（列・演算子・値の組）を WHERE 句の断片にする。
     * 値は必ず PDO::quote() を通し、列名は assertIdentifier() で検査してから
     * quote() で囲む。文字列を直接つなげないことで、検索欄からの注入を防ぐ。
     */
    public function filtersToWhere(array $filters): string
    {
        $parts = [];
        foreach ($filters as $f) {
            if (!is_array($f)) continue;
            $col = $this->assertIdentifier((string)($f['column'] ?? ''), '検索項目');
            $op  = (string)($f['op'] ?? 'eq');
            if (!in_array($op, self::FILTER_OPS, true)) throw bad('不正な検索条件です。');
            $qcol = $this->quote($col);

            if ($op === 'is_null')     { $parts[] = "{$qcol} IS NULL"; continue; }
            if ($op === 'is_not_null') { $parts[] = "{$qcol} IS NOT NULL"; continue; }

            if ($op === 'between') {
                $v1 = trim((string)($f['value'] ?? ''));
                $v2 = trim((string)($f['value2'] ?? ''));
                if ($v1 === '' && $v2 === '') continue;
                if ($v1 !== '' && $v2 !== '') {
                    $parts[] = "{$qcol} BETWEEN " . $this->pdo->quote($v1) . ' AND ' . $this->pdo->quote($v2);
                } elseif ($v1 !== '') {
                    $parts[] = "{$qcol} >= " . $this->pdo->quote($v1);
                } else {
                    $parts[] = "{$qcol} <= " . $this->pdo->quote($v2);
                }
                continue;
            }

            if ($op === 'in') {
                $items = preg_split('/[,\n]/', (string)($f['value'] ?? ''));
                $items = array_values(array_filter(array_map('trim', $items), fn($v) => $v !== ''));
                if (!$items) continue;
                $parts[] = "{$qcol} IN (" . implode(', ', array_map(fn($v) => $this->pdo->quote($v), $items)) . ')';
                continue;
            }

            $val = trim((string)($f['value'] ?? ''));
            if ($val === '') continue;

            if (in_array($op, ['contains', 'starts_with', 'ends_with'], true)) {
                $esc = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $val);
                $pattern = $op === 'contains' ? "%{$esc}%" : ($op === 'starts_with' ? "{$esc}%" : "%{$esc}");
                $parts[] = "{$qcol} LIKE " . $this->pdo->quote($pattern) . " ESCAPE '\\\\'";
                continue;
            }

            $map = ['eq' => '=', 'ne' => '<>', 'gt' => '>', 'gte' => '>=', 'lt' => '<', 'lte' => '<='];
            $parts[] = "{$qcol} {$map[$op]} " . $this->pdo->quote($val);
        }
        return implode(' AND ', $parts);
    }

    /** 検索パネルの条件と、自由入力の WHERE を一つにまとめる。 */
    public function combineWhere(string $rawWhere, array $filters): string
    {
        $a = $this->assertWhere($rawWhere);
        $b = $this->filtersToWhere($filters);
        if ($a !== '' && $b !== '') return "({$a}) AND ({$b})";
        return $a !== '' ? $a : $b;
    }

    public function selectRows(string $schema, string $table, string $where,
                               string $orderBy, string $orderDir, int $limit, int $offset,
                               bool $whereValidated = false): array
    {
        $limit = max(1, min($limit, 1000));
        $offset = max(0, $offset);

        $sql = 'SELECT * FROM ' . $this->qualify($schema, $table);
        if ($where !== '') $sql .= ' WHERE ' . ($whereValidated ? $where : $this->assertWhere($where));
        if ($orderBy !== '') {
            $dir = strtoupper($orderDir) === 'DESC' ? 'DESC' : 'ASC';
            $sql .= ' ORDER BY ' . $this->quote($this->assertIdentifier($orderBy, '並び替えの列')) . ' ' . $dir;
        }
        // LIMIT / OFFSET は整数に固めてから埋める
        $sql .= sprintf(' LIMIT %d OFFSET %d', $limit, $offset);

        try {
            return $this->fetchGrid($this->pdo->query($sql)) + ['sql' => $sql];
        } catch (PDOException $e) {
            throw bad('データを取得できませんでした: ' . $e->getMessage(), 502);
        }
    }
}

/* ------------------------------------------------------------
 * 索引と外部キーの整形（どの DB でも同じ形にする）
 * ---------------------------------------------------------- */

function build_indexes(array $indexMap): array
{
    $out = [];
    foreach ($indexMap as $idx) {
        $prefix = $idx['primary'] ? 'PRIMARY KEY ' : ($idx['unique'] ? 'UNIQUE ' : '');
        $middle = $idx['primary'] ? '' : "INDEX {$idx['name']} ";
        $idx['definition'] = $prefix . $middle . '(' . implode(', ', $idx['columns']) . ')';
        $out[] = $idx;
    }
    return $out;
}

/** $fkRows は name / col / ref_schema / ref_table / ref_col を持つ行の配列。 */
function build_foreign_keys(array $fkRows, string $schema): array
{
    $map = [];
    foreach ($fkRows as $r) {
        $n = $r['name'];
        if (!isset($map[$n])) {
            $map[$n] = ['name' => $n, 'columns' => [],
                        'refSchema' => $r['ref_schema'], 'refTable' => $r['ref_table'],
                        'refColumns' => []];
        }
        $map[$n]['columns'][] = $r['col'];
        $map[$n]['refColumns'][] = $r['ref_col'];
    }

    $out = [];
    foreach ($map as $fk) {
        $ref = ($fk['refSchema'] === $schema ? '' : $fk['refSchema'] . '.') . $fk['refTable'];
        $fk['definition'] = 'FOREIGN KEY (' . implode(', ', $fk['columns']) . ') REFERENCES '
                          . $ref . ' (' . implode(', ', $fk['refColumns']) . ')';
        $out[] = $fk;
    }
    return $out;
}
