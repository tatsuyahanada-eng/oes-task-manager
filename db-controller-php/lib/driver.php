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

        // 上限より 1 行だけ多く読む。多く読めたら「まだ続きがある」と分かる。
        //
        // 以前は全行を読んでから上限まで切り捨てていた。
        // 中身の分からない DB で SELECT * FROM 巨大テーブル と打つと、
        // 捨てるだけの数十万行を丸ごとメモリに読み込んでいた。
        $rows = [];
        $columns = [];
        $started = microtime(true);
        try {
            $this->streamSelect(
                $s,
                function (array $row) use (&$rows, $limit) {
                    $rows[] = $row;
                    if (count($rows) > $limit) return false;   // ここで打ち切る
                },
                function (array $names) use (&$columns) { $columns = $names; }
            );
        } catch (PDOException $e) {
            throw bad('SQL の実行に失敗しました: ' . $e->getMessage(), 502);
        }

        $truncated = count($rows) > $limit;
        if ($truncated) array_pop($rows);

        return ['columns' => $columns, 'rows' => $rows, 'sql' => $s,
                'rowCount' => count($rows), 'truncated' => $truncated,
                'elapsedMs' => (int)round((microtime(true) - $started) * 1000)];
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

    /** 読み取った型の区分を、その DB の型名に直す。 */
    abstract public function sqlType(array $col): string;

    /**
     * 大量の行を、1 行ずつ受け取りながら処理する。
     *
     * 既定の PDO は、query() の時点で結果を全部 PHP 側のメモリに読み込む。
     * 数万行のテーブルを CSV に書き出すと、1 行目を書く前に数十 MB を使い、
     * 共用サーバのメモリ上限に当たって落ちる。
     * ここでは DB から少しずつ受け取り、使い終わった行は捨てていく。
     *
     * $onRow には数値添字の 1 行が渡される。false を返すとそこで打ち切る。
     * $onColumns を渡すと、最初の行を読む前に列名の配列で 1 度だけ呼ばれる
     * （0 件でも呼ばれる）。戻り値は実際に読んだ行数。
     *
     * 注意: 読んでいる最中に、同じ接続で別の問い合わせを投げてはいけない。
     * 必要な情報（列定義など）は、呼ぶ前に取っておくこと。
     */
    abstract public function streamSelect(string $sql, callable $onRow,
                                          ?callable $onColumns = null): int;

    /** PDOStatement から列名を並べる。 */
    protected function columnNames(PDOStatement $st): array
    {
        $columns = [];
        for ($i = 0; $i < $st->columnCount(); $i++) {
            $m = @$st->getColumnMeta($i);
            $columns[] = $m['name'] ?? ('col' . $i);
        }
        return $columns;
    }

    /** 自動採番の主キー 1 列分の定義。 */
    abstract public function surrogateKeySql(string $name): string;

    /* ------------------------------------------------------------
     * CSV から読み取った構成でテーブルを作る
     * ---------------------------------------------------------- */

    /** 画面から来た列の定義を検査して、安全な形に整える。 */
    public function assertColumnPlan(array $columns): array
    {
        $kinds = ['int', 'bigint', 'decimal', 'bool', 'date', 'datetime', 'varchar', 'text'];
        if (!$columns) throw bad('列が 1 つもありません。');
        if (count($columns) > 300) throw bad('列が多すぎます（300 列まで）。');

        $out = [];
        $seen = [];
        foreach ($columns as $c) {
            if (!is_array($c)) throw bad('列の指定が正しくありません。');
            // 取り込まない列は飛ばす
            if (!empty($c['skip'])) continue;

            $name = $this->assertIdentifier(trim((string)($c['name'] ?? '')), '列名');
            $key = mb_strtolower($name);
            if (isset($seen[$key])) throw bad("列名「{$name}」が重複しています。");
            $seen[$key] = true;

            $kind = (string)($c['kind'] ?? '');
            if (!in_array($kind, $kinds, true)) throw bad("列「{$name}」の型の指定が正しくありません。");

            $length = null;
            if ($kind === 'varchar') {
                $length = (int)($c['length'] ?? 255);
                if ($length < 1 || $length > 4000) {
                    throw bad("列「{$name}」の桁は 1〜4000 で指定してください。");
                }
            }

            $precision = $scale = null;
            if ($kind === 'decimal') {
                $precision = (int)($c['precision'] ?? 18);
                $scale     = (int)($c['scale'] ?? 2);
                if ($precision < 1 || $precision > 38) {
                    throw bad("列「{$name}」の全体の桁は 1〜38 で指定してください。");
                }
                if ($scale < 0 || $scale >= $precision) {
                    throw bad("列「{$name}」の小数の桁は、全体の桁より小さくしてください。");
                }
            }

            $out[] = [
                'name'       => $name,
                'kind'       => $kind,
                'length'     => $length,
                'precision'  => $precision,
                'scale'      => $scale,
                'nullable'   => (bool)($c['nullable'] ?? true),
                'primaryKey' => (bool)($c['primaryKey'] ?? false),
            ];
        }

        if (!$out) throw bad('取り込む列が 1 つもありません。');
        return $out;
    }

    /**
     * CREATE TABLE 文を組み立てる。
     * 識別子は必ず quote() を通し、型は決められた区分からしか作らない。
     */
    public function buildCreateTable(string $schema, string $table, array $columns,
                                     string $surrogateKey = '', bool $temporary = false): string
    {
        $this->assertIdentifier($schema, 'スキーマ名');
        $this->assertIdentifier($table, 'テーブル名');

        $lines = [];
        $pk = [];

        if ($surrogateKey !== '') {
            $sk = $this->assertIdentifier(trim($surrogateKey), '主キーの列名');
            foreach ($columns as $c) {
                if (mb_strtolower($c['name']) === mb_strtolower($sk)) {
                    throw bad("自動採番の列名「{$sk}」が、CSV の列と重なっています。別の名前にしてください。");
                }
            }
            $lines[] = '  ' . $this->surrogateKeySql($sk);
            $pk[] = $this->quote($sk);
        }

        foreach ($columns as $c) {
            $line = '  ' . $this->quote($c['name']) . ' ' . $this->sqlType($c);
            // 主キーにする列は、NULL を許さない
            if (!$c['nullable'] || $c['primaryKey']) $line .= ' NOT NULL';
            $lines[] = $line;
            if ($c['primaryKey'] && $surrogateKey === '') $pk[] = $this->quote($c['name']);
        }

        if ($pk) $lines[] = '  PRIMARY KEY (' . implode(', ', $pk) . ')';

        // お試し用の一時テーブルは、接続を切った時点で自動的に消える。
        // スキーマ名は付けない（一時テーブルは接続専用の置き場に作られるため）。
        $head = $temporary
            ? 'CREATE TEMPORARY TABLE ' . $this->quote($table)
            : 'CREATE TABLE ' . $this->qualify($schema, $table);

        return $head . " (\n" . implode(",\n", $lines) . "\n)";
    }

    /**
     * お試し用の一時テーブルを作る。
     *
     * 一時テーブルは、その接続からしか見えず、接続が切れると自動的に消える。
     * PHP はリクエストごとに接続を閉じるので、この 1 回の操作が終われば
     * 何も残らない。本番のデータに一切触れずに取り込みを試せる。
     */
    public function createTrialTable(string $schema, string $table, array $columns,
                                     string $surrogateKey = ''): string
    {
        $sql = $this->buildCreateTable($schema, $table, $columns, $surrogateKey, true);
        try {
            $this->pdo->exec($sql);
        } catch (PDOException $e) {
            throw bad('お試し用のテーブルを作れませんでした: ' . $e->getMessage()
                    . "\n" . self::trialCreateHint($e->getMessage()), 502);
        }
        return $sql;
    }

    /**
     * 一時テーブルを作れなかった理由を、直し方の分かる言い方にする。
     *
     * ここで出る失敗は、本番の CREATE TABLE でも同じように出るものがほとんど。
     * つまり「作る前に気づけた」ということなので、その旨も伝える。
     */
    protected static function trialCreateHint(string $message): string
    {
        if (stripos($message, 'Row size too large') !== false
            || stripos($message, 'row size') !== false) {
            return '1 行に入る大きさの上限を超えています。文字列の桁を減らすか、'
                 . '長い列を「長い文字列」にしてください。'
                 . '（この構成では本番のテーブルも作れません）';
        }
        if (stripos($message, 'Too many columns') !== false) {
            return '列が多すぎます。列を減らしてください。'
                 . '（この構成では本番のテーブルも作れません）';
        }
        if (stripos($message, 'denied') !== false || stripos($message, 'permission') !== false
            || stripos($message, 'privilege') !== false) {
            return 'DB の利用者に、一時テーブルを作る権限（CREATE TEMPORARY TABLES）が'
                 . '与えられていない可能性があります。';
        }
        return '構成に無理がないか確かめてください。'
             . '（お試しなので、本番のテーブルは何も変わっていません）';
    }

    /**
     * 既にあるテーブルと同じ構造の一時テーブルを作る。
     * 「この CSV を本番のテーブルに入れたらどうなるか」を、触らずに試すため。
     */
    abstract public function createTrialTableLike(string $schema, string $table, string $tempName): string;

    /** 同じ名前のテーブルが既にあるか。 */
    public function tableExists(string $schema, string $table): bool
    {
        foreach ($this->listTables($schema) as $t) {
            if (strcasecmp($t['name'], $table) === 0) return true;
        }
        return false;
    }

    /** テーブルを実際に作る。 */
    public function createTable(string $schema, string $table, array $columns,
                                string $surrogateKey = ''): string
    {
        if ($this->tableExists($schema, $table)) {
            throw bad("テーブル「{$table}」は既にあります。別の名前にしてください。");
        }
        $sql = $this->buildCreateTable($schema, $table, $columns, $surrogateKey);
        try {
            $this->pdo->exec($sql);
        } catch (PDOException $e) {
            throw bad('テーブルを作れませんでした: ' . $e->getMessage(), 502);
        }
        return $sql;
    }

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
