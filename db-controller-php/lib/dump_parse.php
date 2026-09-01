<?php
/**
 * DUMP ファイル（SQL 形式）から、テーブルの構成とデータを読み取る。
 *
 * ねらい:
 *   CSV から型を「推定」するのと違い、DUMP には移行元が宣言した型がそのまま
 *   書いてある。桁も NULL の可否も主キーも分かるので、こちらの方が正確。
 *
 * 読めるもの（テキストの SQL）:
 *   - MySQL / MariaDB … mysqldump の出力
 *   - PostgreSQL      … pg_dump の平文出力（-Fp。COPY 形式・INSERT 形式の両方）
 *   - Oracle          … SQL Developer / Toad などが書き出す DDL + INSERT
 *   - SQL Server      … SSMS「スクリプトの生成」の出力
 *
 * 読めないもの（バイナリ）:
 *   - Oracle の .dmp（exp / expdp）
 *   - SQL Server の .bak
 *   - pg_dump の -Fc（カスタム形式）
 *   これらは各 DB の専用ツールでしか展開できない。テキストで出し直してもらう。
 *
 * 方針:
 *   読み取った構成は、CSV から推定した構成と「同じ形」にして返す。
 *   そうすれば、この後の一覧表示・お試し取り込み・テーブル作成・取り込みが、
 *   CSV のときとまったく同じ道を通る。
 */

declare(strict_types=1);

/** 一度に読む DUMP の上限。共用サーバのメモリを考えて抑える。 */
const DBC_DUMP_MAX_BYTES = 64 * 1024 * 1024;

/** 1 テーブルあたり、取り出す行の上限。 */
const DBC_DUMP_MAX_ROWS = 200000;

/* ------------------------------------------------------------
 * 入り口
 * ---------------------------------------------------------- */

/**
 * DUMP 全体を読み取る。
 *
 * 戻り値:
 *   dialect  … mysql / postgres / oracle / mssql / unknown
 *   tables   … テーブルごとの構成（列は CSV 推定と同じ形）
 *   notes    … 読み取れなかったもの・注意すべきことの説明
 */
function dump_parse(string $bytes, array $opts = []): array
{
    if ($bytes === '') throw bad('DUMP ファイルが空です。');
    if (strlen($bytes) > DBC_DUMP_MAX_BYTES) {
        throw bad(sprintf('DUMP が大きすぎます（%s）。一度に読めるのは %s までです。',
            dump_size_label(strlen($bytes)), dump_size_label(DBC_DUMP_MAX_BYTES)));
    }

    dump_reject_binary($bytes);

    $encoding = (string)($opts['encoding'] ?? '');
    if ($encoding === '' || $encoding === 'auto') $encoding = csv_detect_encoding($bytes);
    $text = csv_decode($bytes, $encoding);

    $dialect = dump_detect_dialect($text);
    $tables  = [];
    $notes   = [];

    foreach (dump_statements($text) as $stmt) {
        if (preg_match('/^\s*CREATE\s+(?:GLOBAL\s+TEMPORARY\s+|TEMPORARY\s+|UNLOGGED\s+)?TABLE\b/i', $stmt)) {
            $t = dump_parse_create_table($stmt, $dialect, $notes);
            if ($t !== null) $tables[dump_key($t['schema'], $t['name'])] = $t;
        } elseif (preg_match('/^\s*ALTER\s+TABLE\b/i', $stmt)) {
            dump_apply_alter($stmt, $tables);
        }
    }

    if (!$tables) {
        throw bad('CREATE TABLE が見つかりませんでした。' .
            'テキスト形式の SQL ダンプか確認してください。' .
            '（Oracle の .dmp、SQL Server の .bak、pg_dump の -Fc は読めません）');
    }

    // 行データの在りかを数える。実際の取り出しは、テーブルを選んでから行う。
    dump_count_rows($text, $dialect, $tables);

    foreach ($tables as $k => $t) {
        $tables[$k]['columnCount'] = count($t['columns']);
    }

    return [
        'dialect'      => $dialect,
        'dialectLabel' => dump_dialect_label($dialect),
        'encoding'     => $encoding,
        'encodingLabel'=> csv_encoding_label($encoding),
        'tables'       => array_values($tables),
        'notes'        => array_values(array_unique($notes)),
    ];
}

/** テーブル 1 つ分の行データを、CSV と同じ形にして返す。 */
function dump_extract_csv(string $bytes, string $schema, string $table, array $opts = []): array
{
    $encoding = (string)($opts['encoding'] ?? '');
    if ($encoding === '' || $encoding === 'auto') $encoding = csv_detect_encoding($bytes);
    $text = csv_decode($bytes, $encoding);
    $dialect = dump_detect_dialect($text);

    $parsed = dump_parse($bytes, $opts);
    $target = null;
    foreach ($parsed['tables'] as $t) {
        if (dump_same_table($t, $schema, $table)) { $target = $t; break; }
    }
    if ($target === null) throw bad("テーブル「{$table}」が DUMP の中に見つかりません。");

    $cols = array_column($target['columns'], 'name');
    $rows = dump_collect_rows($text, $dialect, $target);

    return ['columns' => $cols, 'rows' => $rows, 'csv' => dump_rows_to_csv($cols, $rows)];
}

/* ------------------------------------------------------------
 * 種別の判定
 * ---------------------------------------------------------- */

function dump_detect_dialect(string $text): string
{
    $head = substr($text, 0, 200000);

    if (preg_match('/^--\s*MySQL dump|\/\*!\d{5}|ENGINE=(InnoDB|MyISAM)|`\w+`\s+(int|varchar)/mi', $head)) {
        return 'mysql';
    }
    if (preg_match('/^--\s*PostgreSQL database dump|^COPY\s|character varying|SET search_path|OWNER TO/mi', $head)) {
        return 'postgres';
    }
    if (preg_match('/VARCHAR2\s*\(|NUMBER\s*\(|^\s*\/\s*$|CREATE OR REPLACE (?:FORCE )?VIEW|TABLESPACE\s+\w+/mi', $head)) {
        return 'oracle';
    }
    if (preg_match('/\[dbo\]\.|SET ANSI_NULLS|GO\s*$|NVARCHAR\s*\(|IDENTITY\s*\(\s*\d+\s*,/mi', $head)) {
        return 'mssql';
    }
    return 'unknown';
}

function dump_dialect_label(string $d): string
{
    return [
        'mysql'    => 'MySQL / MariaDB',
        'postgres' => 'PostgreSQL',
        'oracle'   => 'Oracle',
        'mssql'    => 'SQL Server',
        'unknown'  => '不明（一般的な SQL として読みます）',
    ][$d] ?? $d;
}

/** バイナリのダンプは読めないので、早い段階で分かりやすく断る。 */
function dump_reject_binary(string $bytes): void
{
    $head = substr($bytes, 0, 512);

    if (strncmp($bytes, "PGDMP", 5) === 0) {
        throw bad('pg_dump のカスタム形式（-Fc）です。テキスト形式で出し直してください: '
                . 'pg_dump -Fp（または pg_restore -f 出力.sql アーカイブ）');
    }
    if (strncmp($bytes, "TAPE", 4) === 0 || strpos($head, "Microsoft SQL Server") !== false && !dump_looks_text($head)) {
        throw bad('SQL Server の .bak（バックアップ）です。このツールでは展開できません。'
                . 'SSMS の「タスク → スクリプトの生成」で、スキーマとデータを SQL として出し直してください。');
    }
    if (strncmp($bytes, "\x03\x02", 2) === 0 || preg_match('/^EXPORT:V\d\d\.\d\d/', $head)) {
        throw bad('Oracle の .dmp（exp / expdp）です。このツールでは展開できません。'
                . 'SQL Developer の「データベースのエクスポート」などで、DDL と INSERT を SQL として出し直してください。');
    }
    if (!dump_looks_text($head)) {
        throw bad('テキストの SQL ファイルではないようです。'
                . 'バイナリ形式のダンプ（Oracle .dmp / SQL Server .bak / pg_dump -Fc）は読めません。');
    }
}

function dump_looks_text(string $head): bool
{
    // NUL が混ざっていればバイナリとみなす（UTF-16 も弾かれるが、そちらは別途案内される）
    return strpos($head, "\0") === false;
}

/* ------------------------------------------------------------
 * 文の切り出し
 * ---------------------------------------------------------- */

/**
 * SQL を 1 文ずつ取り出す。
 *
 * 文字列やコメントの中の「;」で切ってしまわないよう、頭から 1 文字ずつ見る。
 * COPY ... FROM stdin; の後ろに続く生データは、ここでは読み飛ばす
 * （行データは別途 dump_collect_rows() が行単位で拾う）。
 */
function dump_statements(string $text): Generator
{
    $len = strlen($text);
    $buf = '';
    $i = 0;

    while ($i < $len) {
        $c = $text[$i];
        $next = $i + 1 < $len ? $text[$i + 1] : '';

        // 行コメント
        if (($c === '-' && $next === '-') || $c === '#') {
            $nl = strpos($text, "\n", $i);
            $i = $nl === false ? $len : $nl + 1;
            continue;
        }
        // ブロックコメント。MySQL の /*!40101 ... */ は中身が SQL なので取り込む
        if ($c === '/' && $next === '*') {
            $end = strpos($text, '*/', $i + 2);
            $end = $end === false ? $len : $end + 2;
            $body = substr($text, $i, $end - $i);
            if (preg_match('/^\/\*!\d{5}(.*)\*\/$/s', $body, $m)) $buf .= ' ' . $m[1] . ' ';
            $i = $end;
            continue;
        }
        // 文字列（' は SQL 標準、" と ` は識別子だが、中の ; を無視する点は同じ）
        if ($c === "'" || $c === '"' || $c === '`') {
            $j = dump_skip_quoted($text, $i, $c);
            $buf .= substr($text, $i, $j - $i);
            $i = $j;
            continue;
        }
        // PostgreSQL のドル引用
        if ($c === '$' && preg_match('/\G(\$[A-Za-z_0-9]*\$)/', $text, $m, 0, $i)) {
            $tag = $m[1];
            $end = strpos($text, $tag, $i + strlen($tag));
            $end = $end === false ? $len : $end + strlen($tag);
            $buf .= substr($text, $i, $end - $i);
            $i = $end;
            continue;
        }
        // 文の終わり
        if ($c === ';') {
            if (trim($buf) !== '') {
                yield $buf;
                // COPY ... FROM stdin; のときは、続く生データを読み飛ばす
                if (preg_match('/^\s*COPY\b.*\bFROM\s+stdin/is', $buf)) {
                    $i = dump_skip_copy_body($text, $i + 1);
                    $buf = '';
                    continue;
                }
            }
            $buf = '';
            $i++;
            continue;
        }
        // Oracle / SQL Server の区切り（行頭の / と GO）
        if (($c === "\n") && preg_match('/\G\n\s*(\/|GO)[ \t]*(\r?\n|$)/i', $text, $m, 0, $i)) {
            if (trim($buf) !== '') yield $buf;
            $buf = '';
            $i += strlen($m[0]);
            continue;
        }

        $buf .= $c;
        $i++;
    }
    if (trim($buf) !== '') yield $buf;
}

/** 引用の終わりまでの位置を返す（終わりの記号を含む）。 */
function dump_skip_quoted(string $text, int $i, string $q): int
{
    $len = strlen($text);
    $j = $i + 1;
    while ($j < $len) {
        $c = $text[$j];
        if ($c === '\\' && $q === "'") { $j += 2; continue; }   // MySQL のバックスラッシュ
        if ($c === $q) {
            if ($j + 1 < $len && $text[$j + 1] === $q) { $j += 2; continue; }  // '' で 1 個の '
            return $j + 1;
        }
        $j++;
    }
    return $len;
}

/** COPY の生データ（\. で終わる）を読み飛ばし、その次の位置を返す。 */
function dump_skip_copy_body(string $text, int $i): int
{
    $end = preg_match('/\R\\\\\.\s*\R/', $text, $m, PREG_OFFSET_CAPTURE, $i)
        ? $m[0][1] + strlen($m[0][0]) : strlen($text);
    return $end;
}

/* ------------------------------------------------------------
 * CREATE TABLE の読み取り
 * ---------------------------------------------------------- */

function dump_parse_create_table(string $stmt, string $dialect, array &$notes): ?array
{
    if (!preg_match('/CREATE\s+(?:GLOBAL\s+TEMPORARY\s+|TEMPORARY\s+|UNLOGGED\s+)?TABLE\s+' .
                    '(?:IF\s+NOT\s+EXISTS\s+)?(.+?)\s*\((.*)\)\s*[^)]*$/is', $stmt, $m)) {
        return null;
    }
    [$schema, $name] = dump_split_name($m[1]);
    $body = $m[2];

    $columns = [];
    $pk = [];

    foreach (dump_split_items($body) as $item) {
        $item = trim($item);
        if ($item === '') continue;

        // 表制約
        if (preg_match('/^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*(?:CLUSTERED|NONCLUSTERED)?\s*\((.+?)\)/is', $item, $c)) {
            foreach (dump_split_items($c[1]) as $col) $pk[] = dump_index_column($col);
            continue;
        }
        if (preg_match('/^(?:CONSTRAINT\s+\S+\s+)?(UNIQUE|FOREIGN\s+KEY|CHECK|KEY|INDEX|FULLTEXT|SPATIAL)\b/is', $item)) {
            continue;
        }

        $col = dump_parse_column($item, $dialect, $notes);
        if ($col !== null) {
            $columns[] = $col;
            if (!empty($col['inlinePk'])) $pk[] = $col['name'];
        }
    }

    if (!$columns) return null;

    foreach ($columns as $i => $c) {
        $columns[$i]['primaryKey'] = in_array($c['name'], $pk, true);
        unset($columns[$i]['inlinePk']);
    }

    return [
        'schema'     => $schema,
        'name'       => $name,
        'columns'    => $columns,
        'primaryKey' => $pk,
        'rowCount'   => 0,
        'dataForm'   => 'none',
    ];
}

/** 1 列分の定義を読む。 */
function dump_parse_column(string $item, string $dialect, array &$notes): ?array
{
    if (!preg_match('/^([`"\[]?[^\s`"\]\[]+[`"\]]?)\s+(.+)$/s', $item, $m)) return null;

    $name = dump_unquote(trim($m[1]));
    if ($name === '' || preg_match('/^(PRIMARY|UNIQUE|KEY|CONSTRAINT|FOREIGN|CHECK|INDEX)$/i', $name)) return null;

    $rest = $m[2];

    // 型名は 2 語以上のものがある（character varying / timestamp without time zone など）。
    // 先に長い綴りから当てないと、character だけを型名と読んで桁を落としてしまう。
    $multi = 'national\s+character\s+varying|national\s+character|character\s+varying|'
           . 'double\s+precision|bit\s+varying|long\s+raw|'
           . 'timestamp\s+with(?:out)?\s+time\s+zone|time\s+with(?:out)?\s+time\s+zone|'
           . 'interval\s+day\s+to\s+second|interval\s+year\s+to\s+month';
    // SQL Server は型名も [int] のように括る
    if (!preg_match('/^\[?(' . $multi . '|[A-Za-z_][A-Za-z0-9_]*)\]?\s*(\(([^)]*)\))?/i', $rest, $t)) return null;

    $rawType = strtolower(preg_replace('/\s+/', ' ', trim($t[1])));
    $args    = isset($t[3]) ? trim($t[3]) : '';

    // NOT NULL / DEFAULT / IDENTITY など
    $nullable   = !preg_match('/\bNOT\s+NULL\b/i', $rest);
    $isIdentity = (bool)preg_match('/\b(AUTO_INCREMENT|IDENTITY|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY|SERIAL)\b/i', $rest);
    $inlinePk   = (bool)preg_match('/\bPRIMARY\s+KEY\b/i', $rest);

    $mapped = dump_map_type($rawType, $args, $dialect, $name, $notes);

    return [
        'csvColumn'  => $name,
        'name'       => $name,
        'kind'       => $mapped['kind'],
        'length'     => $mapped['length'],
        'precision'  => $mapped['precision'],
        'scale'      => $mapped['scale'],
        'nullable'   => $nullable,
        'primaryKey' => false,
        'inlinePk'   => $inlinePk,
        'isIdentity' => $isIdentity,
        'sourceType' => dump_source_type_label($rawType, $args),
        'reason'     => $mapped['reason'],
    ];
}

/** 移行元の型を、このツールの区分に対応づける。 */
function dump_map_type(string $type, string $args, string $dialect, string $col, array &$notes): array
{
    $a = array_map('trim', $args === '' ? [] : explode(',', $args));
    // Oracle は VARCHAR2(10 BYTE) / CHAR(4 CHAR) のように単位を付ける
    if (isset($a[0])) $a[0] = preg_replace('/\s+(BYTE|CHAR)\s*$/i', '', $a[0]);
    $n1 = isset($a[0]) && is_numeric($a[0]) ? (int)$a[0] : null;
    $n2 = isset($a[1]) && is_numeric($a[1]) ? (int)$a[1] : null;
    $t  = preg_replace('/\s+/', ' ', $type);

    $R = fn($kind, $len, $p, $s, $why) =>
        ['kind' => $kind, 'length' => $len, 'precision' => $p, 'scale' => $s, 'reason' => $why];

    // 文字列
    if (preg_match('/^(varchar2?|nvarchar2?|character varying|varchar|nchar|char|character|string)$/', $t)) {
        if (strtolower((string)($a[0] ?? '')) === 'max') {
            return $R('text', null, null, null, '長さ無制限の文字列のため');
        }
        $len = $n1 ?: 255;
        if ($len > 4000) return $R('text', null, null, null, "宣言が {$len} 文字と大きいため");
        return $R('varchar', $len, null, null, "元の宣言が {$t}({$len}) のため");
    }
    if (preg_match('/^(text|clob|nclob|longtext|mediumtext|tinytext|ntext|long)$/', $t)) {
        return $R('text', null, null, null, "元の宣言が {$t} のため");
    }

    // 真偽
    if (preg_match('/^(bool|boolean|bit)$/', $t)) {
        return $R('bool', null, null, null, "元の宣言が {$t} のため");
    }
    // MySQL の tinyint(1) は真偽として使われることが多い
    if ($t === 'tinyint' && $n1 === 1) {
        return $R('bool', null, null, null, 'tinyint(1) は真偽として使われるため');
    }

    // 整数
    if (preg_match('/^(tinyint|smallint|mediumint|int|integer|int2|int4|serial)$/', $t)) {
        return $R('int', null, null, null, "元の宣言が {$t} のため");
    }
    if (preg_match('/^(bigint|int8|bigserial)$/', $t)) {
        return $R('bigint', null, null, null, "元の宣言が {$t} のため");
    }

    // 数値（Oracle の NUMBER が要注意）
    if (preg_match('/^(number|numeric|decimal|dec|money|smallmoney)$/', $t)) {
        if ($n1 !== null && ($n2 === null || $n2 === 0)) {
            // NUMBER(10) のように小数点以下が無いものは整数として扱う
            return $n1 <= 9
                ? $R('int', null, null, null, "{$t}({$n1}) は整数のため")
                : $R('bigint', null, null, null, "{$t}({$n1}) は桁の大きい整数のため");
        }
        if ($n1 === null) {
            $notes[] = "列「{$col}」は桁の指定が無い {$t} でした。念のため decimal(38,10) にしています。確認してください。";
            return $R('decimal', null, 38, 10, '桁の指定が無かったため');
        }
        return $R('decimal', null, min($n1, 38), $n2 ?? 0, "元の宣言が {$t}({$n1}," . ($n2 ?? 0) . ') のため');
    }
    if (preg_match('/^(float|double|double precision|real|binary_float|binary_double)$/', $t)) {
        $notes[] = "列「{$col}」は {$t}（浮動小数）でした。桁落ちを避けるため decimal(38,10) にしています。";
        return $R('decimal', null, 38, 10, '浮動小数のため');
    }

    // 日付・時刻
    if ($t === 'date') {
        // Oracle の DATE は時刻も持つ。日付だけにすると時刻が落ちる。
        if ($dialect === 'oracle') {
            $notes[] = "列「{$col}」は Oracle の DATE（時刻も持つ）でした。時刻を落とさないよう datetime にしています。";
            return $R('datetime', null, null, null, 'Oracle の DATE は時刻を含むため');
        }
        return $R('date', null, null, null, '元の宣言が date のため');
    }
    if (preg_match('/^(datetime|datetime2|smalldatetime|timestamp|timestamptz|timestamp without time zone|timestamp with time zone)$/', $t)) {
        return $R('datetime', null, null, null, "元の宣言が {$t} のため");
    }
    if (preg_match('/^(time|time without time zone|interval|year)$/', $t)) {
        $notes[] = "列「{$col}」は {$t} でした。そのまま入る型が無いので、文字列として作ります。";
        return $R('varchar', 30, null, null, "{$t} は文字列として扱うため");
    }

    // そのまま入れられないもの
    if (preg_match('/^(blob|bytea|image|raw|long raw|varbinary|binary|bfile)$/', $t)) {
        $notes[] = "列「{$col}」は {$t}（バイナリ）でした。このツールでは中身を移せません。文字列として作りますが、確認してください。";
        return $R('text', null, null, null, 'バイナリ列のため');
    }
    if (preg_match('/^(uuid|uniqueidentifier)$/', $t)) {
        return $R('varchar', 36, null, null, "{$t} は 36 文字の文字列のため");
    }
    if (preg_match('/^(json|jsonb|xml)$/', $t)) {
        return $R('text', null, null, null, "元の宣言が {$t} のため");
    }

    $notes[] = "列「{$col}」の型「{$t}」は分かりませんでした。文字列として作ります。確認してください。";
    return $R('varchar', 255, null, null, "型「{$t}」が判別できなかったため");
}

function dump_source_type_label(string $type, string $args): string
{
    return strtoupper($type) . ($args !== '' ? "({$args})" : '');
}

/** ALTER TABLE ... ADD CONSTRAINT ... PRIMARY KEY (...) を取り込む。 */
function dump_apply_alter(string $stmt, array &$tables): void
{
    if (!preg_match('/ALTER\s+TABLE\s+(?:ONLY\s+)?(.+?)\s+(?:ADD|ALTER)\b/is', $stmt, $m)) return;
    [$schema, $name] = dump_split_name($m[1]);
    $key = dump_key($schema, $name);
    if (!isset($tables[$key])) return;

    if (preg_match('/PRIMARY\s+KEY\s*(?:CLUSTERED|NONCLUSTERED)?\s*\((.+?)\)/is', $stmt, $p)) {
        $pk = [];
        foreach (dump_split_items($p[1]) as $col) $pk[] = dump_index_column($col);
        $tables[$key]['primaryKey'] = $pk;
        foreach ($tables[$key]['columns'] as $i => $c) {
            $tables[$key]['columns'][$i]['primaryKey'] = in_array($c['name'], $pk, true);
        }
    }
}

/* ------------------------------------------------------------
 * 行データ
 * ---------------------------------------------------------- */

/** どのテーブルに何行あるかだけを数える（中身は取り出さない）。 */
function dump_count_rows(string $text, string $dialect, array &$tables): void
{
    foreach ($tables as $key => $t) {
        $n = 0;
        $form = 'none';

        // PostgreSQL の COPY
        $copy = dump_find_copy_block($text, $t);
        if ($copy !== null) {
            $n += substr_count(trim($copy['body']), "\n") + ($copy['body'] === '' ? 0 : 1);
            $form = 'copy';
        }
        // INSERT INTO ... VALUES
        $ins = dump_count_insert_rows($text, $t);
        if ($ins > 0) {
            $n += $ins;
            $form = $form === 'copy' ? 'copy+insert' : 'insert';
        }

        $tables[$key]['rowCount'] = $n;
        $tables[$key]['dataForm'] = $form;
    }
}

/** テーブル 1 つ分の行を取り出す。 */
function dump_collect_rows(string $text, string $dialect, array $table): array
{
    $cols = array_column($table['columns'], 'name');
    $rows = [];

    $copy = dump_find_copy_block($text, $table);
    if ($copy !== null) {
        foreach (explode("\n", $copy['body']) as $line) {
            if ($line === '' || $line === "\r") continue;
            $line = rtrim($line, "\r");
            $vals = array_map('dump_copy_value', explode("\t", $line));
            $rows[] = dump_align_row($vals, $copy['columns'], $cols);
            if (count($rows) >= DBC_DUMP_MAX_ROWS) return $rows;
        }
    }

    foreach (dump_iter_inserts($text, $table) as [$insCols, $tuple]) {
        $rows[] = dump_align_row($tuple, $insCols ?: $cols, $cols);
        if (count($rows) >= DBC_DUMP_MAX_ROWS) break;
    }

    return $rows;
}

/** COPY ブロックを探す。無ければ null。 */
function dump_find_copy_block(string $text, array $table): ?array
{
    $名 = preg_quote($table['name'], '/');
    $re = '/^COPY\s+(?:[`"\[]?[\w$]+[`"\]]?\s*\.\s*)?[`"\[]?' . $名 . '[`"\]]?\s*(?:\(([^)]*)\))?\s+FROM\s+stdin\s*;[ \t]*\R/mi';
    if (!preg_match($re, $text, $m, PREG_OFFSET_CAPTURE)) return null;

    $start = $m[0][1] + strlen($m[0][0]);
    $cols = [];
    if (!empty($m[1][0])) {
        foreach (dump_split_items($m[1][0]) as $c) $cols[] = dump_unquote(trim($c));
    }

    $end = preg_match('/\R\\\\\.\s*\R/', $text, $e, PREG_OFFSET_CAPTURE, $start)
        ? $e[0][1] : strlen($text);

    return ['columns' => $cols, 'body' => substr($text, $start, $end - $start)];
}

/** COPY の値。\N は NULL、その他はエスケープを戻す。 */
function dump_copy_value(string $v)
{
    if ($v === '\\N') return null;
    return strtr($v, ['\\t' => "\t", '\\n' => "\n", '\\r' => "\r", '\\\\' => '\\']);
}

function dump_count_insert_rows(string $text, array $table): int
{
    $n = 0;
    foreach (dump_iter_inserts($text, $table) as $_) $n++;
    return $n;
}

/**
 * INSERT INTO <table> [(cols)] VALUES (...),(...); を 1 行ずつ返す。
 * mysqldump のように 1 文へ大量にまとめられていても扱える。
 */
function dump_iter_inserts(string $text, array $table): Generator
{
    $名 = preg_quote($table['name'], '/');
    $re = '/INSERT\s+(?:IGNORE\s+)?(?:INTO\s+)?(?:[`"\[]?[\w$]+[`"\]]?\s*\.\s*)?[`"\[]?' . $名 .
          '[`"\]]?\s*(?:\(([^)]*)\))?\s+VALUES\s*/i';

    $offset = 0;
    while (preg_match($re, $text, $m, PREG_OFFSET_CAPTURE, $offset)) {
        $cols = [];
        if (!empty($m[1][0])) {
            foreach (dump_split_items($m[1][0]) as $c) $cols[] = dump_unquote(trim($c));
        }
        $i = $m[0][1] + strlen($m[0][0]);
        $len = strlen($text);

        // (...) の並びを、文の終わりまで拾う
        while ($i < $len) {
            while ($i < $len && (ctype_space($text[$i]) || $text[$i] === ',')) $i++;
            if ($i >= $len || $text[$i] !== '(') break;

            $j = dump_match_paren($text, $i);
            yield [$cols, dump_split_values(substr($text, $i + 1, $j - $i - 1))];
            $i = $j + 1;

            while ($i < $len && ctype_space($text[$i])) $i++;
            if ($i < $len && $text[$i] === ';') { $i++; break; }
        }
        $offset = $i;
    }
}

/** 対応する ) の位置を返す。文字列の中の括弧は数えない。 */
function dump_match_paren(string $text, int $i): int
{
    $len = strlen($text);
    $depth = 0;
    while ($i < $len) {
        $c = $text[$i];
        if ($c === "'" || $c === '"' || $c === '`') { $i = dump_skip_quoted($text, $i, $c); continue; }
        if ($c === '(') $depth++;
        elseif ($c === ')') { $depth--; if ($depth === 0) return $i; }
        $i++;
    }
    return $len - 1;
}

/** VALUES の中身を値ごとに分ける。 */
function dump_split_values(string $s): array
{
    $out = [];
    $len = strlen($s);
    $i = 0;
    $cur = '';
    $depth = 0;

    while ($i < $len) {
        $c = $s[$i];
        if ($c === "'") {
            $j = dump_skip_quoted($s, $i, "'");
            $cur .= substr($s, $i, $j - $i);
            $i = $j;
            continue;
        }
        // 関数呼び出しの中のカンマで切らない（to_date('..','..') など）
        if ($c === '(') $depth++;
        if ($c === ')') $depth--;
        if ($c === ',' && $depth === 0) { $out[] = dump_literal($cur); $cur = ''; $i++; continue; }
        $cur .= $c;
        $i++;
    }
    $out[] = dump_literal($cur);
    return $out;
}

/** SQL の値 1 つを、素の値に戻す。 */
function dump_literal(string $raw)
{
    $v = trim($raw);
    if ($v === '' || strcasecmp($v, 'NULL') === 0) return null;

    // SQL Server の N'...' / Oracle の q'[...]' のような接頭辞を外す
    if (preg_match("/^N'/i", $v)) $v = substr($v, 1);

    // 丸ごと引用されている値
    if (strlen($v) >= 2 && $v[0] === "'" && substr($v, -1) === "'") {
        $inner = substr($v, 1, -1);
        $inner = str_replace("''", "'", $inner);
        return strtr($inner, [
            "\\'" => "'", '\\"' => '"', '\\\\' => '\\',
            '\\n' => "\n", '\\r' => "\r", '\\t' => "\t", '\\0' => "\0", '\\Z' => "\x1a",
        ]);
    }

    if (strcasecmp($v, 'TRUE') === 0) return '1';
    if (strcasecmp($v, 'FALSE') === 0) return '0';

    // Oracle の to_date('2026-01-01','YYYY-MM-DD') などは、中の値だけを使う
    if (preg_match("/^TO_(?:DATE|TIMESTAMP)\s*\\(\s*N?'((?:[^']|'')*)'/i", $v, $m)) {
        return str_replace("''", "'", $m[1]);
    }
    // SQL Server の CAST(N'2026-08-01' AS Date) / CAST(125000.00 AS Decimal(12,2))
    if (preg_match("/^CAST\s*\\(\s*N?'((?:[^']|'')*)'/i", $v, $m)) {
        return str_replace("''", "'", $m[1]);
    }
    if (preg_match('/^CAST\s*\\(\s*([-\\d.]+)\s+AS\b/i', $v, $m)) return $m[1];

    return $v;
}

/** INSERT / COPY が列を並べ替えている場合に、テーブルの列順へそろえる。 */
function dump_align_row(array $vals, array $from, array $to): array
{
    if (!$from || $from === $to) {
        // 数が足りなければ NULL で埋める
        return array_pad(array_slice($vals, 0, count($to)), count($to), null);
    }
    $map = array_combine($from, array_pad(array_slice($vals, 0, count($from)), count($from), null));
    $out = [];
    foreach ($to as $c) $out[] = $map[$c] ?? null;
    return $out;
}

/** 取り出した行を、取り込みで使える CSV にする。 */
function dump_rows_to_csv(array $cols, array $rows): string
{
    $esc = function ($v) {
        if ($v === null) return '';
        $s = (string)$v;
        return preg_match('/[",\r\n]/', $s) ? '"' . str_replace('"', '""', $s) . '"' : $s;
    };
    $out = implode(',', array_map($esc, $cols)) . "\r\n";
    foreach ($rows as $r) $out .= implode(',', array_map($esc, $r)) . "\r\n";
    return $out;
}

/* ------------------------------------------------------------
 * 小さな道具
 * ---------------------------------------------------------- */

/** カンマ区切りを、括弧と引用を数えながら分ける。 */
function dump_split_items(string $s): array
{
    $out = [];
    $len = strlen($s);
    $depth = 0;
    $cur = '';
    $i = 0;

    while ($i < $len) {
        $c = $s[$i];
        if ($c === "'" || $c === '"' || $c === '`') {
            $j = dump_skip_quoted($s, $i, $c);
            $cur .= substr($s, $i, $j - $i);
            $i = $j;
            continue;
        }
        if ($c === '(') $depth++;
        if ($c === ')') $depth--;
        if ($c === ',' && $depth === 0) { $out[] = $cur; $cur = ''; $i++; continue; }
        $cur .= $c;
        $i++;
    }
    if (trim($cur) !== '') $out[] = $cur;
    return $out;
}

/** 索引の列指定（[COL] ASC など）から、列名だけを取り出す。 */
function dump_index_column(string $s): string
{
    return dump_unquote(trim(preg_replace('/\s+(ASC|DESC)\s*$/i', '', trim($s))));
}

/** `名前` "名前" [名前] の引用を外す。 */
function dump_unquote(string $s): string
{
    $s = trim($s);
    if ($s === '') return '';
    $first = $s[0];
    $last = substr($s, -1);
    if (($first === '`' && $last === '`') || ($first === '"' && $last === '"')) {
        return str_replace($first . $first, $first, substr($s, 1, -1));
    }
    if ($first === '[' && $last === ']') return substr($s, 1, -1);
    return $s;
}

/** スキーマ名とテーブル名に分ける。 */
function dump_split_name(string $s): array
{
    $s = trim($s);
    $parts = [];
    $cur = '';
    $len = strlen($s);
    $i = 0;
    while ($i < $len) {
        $c = $s[$i];
        if ($c === '`' || $c === '"' || $c === '[') {
            $q = $c === '[' ? ']' : $c;
            $j = $i + 1;
            while ($j < $len && $s[$j] !== $q) $j++;
            $cur .= substr($s, $i, $j - $i + 1);
            $i = $j + 1;
            continue;
        }
        if ($c === '.') { $parts[] = $cur; $cur = ''; $i++; continue; }
        $cur .= $c;
        $i++;
    }
    $parts[] = $cur;

    $name = dump_unquote(array_pop($parts));
    $schema = $parts ? dump_unquote(array_pop($parts)) : '';
    return [$schema, $name];
}

function dump_key(string $schema, string $name): string
{
    return strtolower(($schema !== '' ? $schema . '.' : '') . $name);
}

function dump_same_table(array $t, string $schema, string $name): bool
{
    if (strcasecmp($t['name'], $name) !== 0) return false;
    return $schema === '' || strcasecmp((string)$t['schema'], $schema) === 0;
}

function dump_size_label(int $bytes): string
{
    if ($bytes >= 1048576) return round($bytes / 1048576, 1) . ' MB';
    if ($bytes >= 1024) return round($bytes / 1024) . ' KB';
    return $bytes . ' B';
}
