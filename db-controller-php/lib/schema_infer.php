<?php
/**
 * CSV からテーブル構成を読み取る。
 *
 * 移行の受け皿を手で作らなくて済むようにするための仕組み。
 * CSV の全行を走査して、列ごとに「どの型なら全部の値が入るか」を決める。
 *
 * 考え方:
 *   - 判定は必ず「全行」で行う。先頭だけ見ると、後ろの方に混ざった
 *     例外的な値（空欄、桁の大きい数、日付でない文字）を取りこぼす。
 *   - 迷ったら広い型に倒す。数値として読めても、先頭ゼロがあれば文字列にする。
 *     移行では「入らない」より「入るが型が緩い」ほうが後から直せる。
 *   - 決めた型は画面で直せる。ここが出すのはあくまで「たたき台」。
 */

declare(strict_types=1);

/** 値を数えるときの上限。これを超えたら一意性の判定はあきらめる。 */
const DBC_INFER_MAX_DISTINCT = 200000;

/** varchar の桁は、この段階に切り上げる。1 文字違いで型が変わらないように。 */
const DBC_VARCHAR_STEPS = [10, 20, 30, 50, 80, 100, 150, 200, 255, 400, 600, 1000];

/** Oracle の月名表記（26-AUG-26 のような形）。 */
const DBC_MONTHS = ['JAN' => 1, 'FEB' => 2, 'MAR' => 3, 'APR' => 4,  'MAY' => 5,  'JUN' => 6,
                    'JUL' => 7, 'AUG' => 8, 'SEP' => 9, 'OCT' => 10, 'NOV' => 11, 'DEC' => 12];

/* ------------------------------------------------------------
 * 1 つの値を見分ける
 * ---------------------------------------------------------- */

function infer_is_int(string $v): bool
{
    return (bool)preg_match('/^[+-]?[0-9]{1,19}$/', $v);
}

function infer_is_decimal(string $v): bool
{
    return (bool)preg_match('/^[+-]?[0-9]{1,20}\.[0-9]{1,10}$/', $v);
}

function infer_is_bool(string $v): bool
{
    return in_array(strtolower($v), ['true', 'false', 't', 'f', 'yes', 'no', 'y', 'n'], true);
}

/** 日付として読めるか。読めたら [年, 月, 日] を返す。 */
function infer_date_parts(string $v): ?array
{
    // 2026-08-26 / 2026/08/26 / 2026.08.26
    if (preg_match('/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/', $v, $m)) {
        return [(int)$m[1], (int)$m[2], (int)$m[3]];
    }
    // 26-AUG-26 / 26-AUG-2026（Oracle の既定書式）
    if (preg_match('/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/', $v, $m)) {
        $mon = DBC_MONTHS[strtoupper($m[2])] ?? null;
        if ($mon === null) return null;
        $y = (int)$m[3];
        if ($y < 100) $y += ($y < 70) ? 2000 : 1900;
        return [$y, $mon, (int)$m[1]];
    }
    return null;
}

function infer_is_date(string $v): bool
{
    $p = infer_date_parts($v);
    if ($p === null) return false;
    return checkdate($p[1], $p[2], $p[0]);
}

/** 日時として読めるか。日付＋時刻の形だけを見る。 */
function infer_is_datetime(string $v): bool
{
    if (!preg_match('/^(.+?)[ T](\d{1,2}):(\d{2})(:(\d{2}))?(\.\d+)?$/', $v, $m)) return false;
    if (!infer_is_date($m[1])) return false;
    return (int)$m[2] <= 23 && (int)$m[3] <= 59 && (int)($m[5] ?? 0) <= 59;
}

/* ------------------------------------------------------------
 * 列名を、識別子として使える形にする
 * ---------------------------------------------------------- */

/**
 * 見出しを列名にする。
 *
 * 日本語の見出しはそのまま列名にできる（このツールは識別子を必ず引用符で囲むため）。
 * 落とすのは、SQL やファイルを壊す文字だけに絞る。
 */
function infer_column_name(string $header, int $index, array $used): string
{
    $n = trim($header);
    // 制御文字と引用符は落とす
    $n = preg_replace('/[\x00-\x1F\x7F`"\'\\\\]/u', '', $n);
    $n = trim((string)$n);
    if ($n === '') $n = 'col' . ($index + 1);
    if (mb_strlen($n) > 60) $n = mb_substr($n, 0, 60);

    // 同じ名前が既にあれば連番を足す
    $base = $n;
    $i = 2;
    while (in_array(strtolower($n), array_map('strtolower', $used), true)) {
        $n = $base . '_' . $i;
        $i++;
    }
    return $n;
}

/**
 * 名前から見て、識別子らしい列か。
 *
 * 「値が全行で一意」だけを根拠に主キーを決めると、
 * たまたま重複していない金額や日付を選んでしまう。
 * 行数が少ないほど当てにならないので、名前の裏付けも求める。
 */
function infer_looks_like_id(string $name): bool
{
    $n = strtolower($name);
    if (preg_match('/(^|[_\- ])(id|cd|code|no|num|key|seq)$/', $n)) return true;
    if (preg_match('/^(id|cd|code|no|num|key|seq)([_\- ]|$)/', $n)) return true;
    return (bool)preg_match('/(コード|番号|ＩＤ|キー)/u', $name);
}

/** ファイル名から、テーブル名のたたき台を作る。 */
function infer_table_name(string $filename): string
{
    $n = preg_replace('/\.(csv|txt|tsv)$/i', '', trim($filename));
    $n = preg_replace('/[\x00-\x1F\x7F`"\'\\\\.\/]/u', '', (string)$n);
    $n = trim((string)$n);
    if ($n === '') return 'new_table';
    if (mb_strlen($n) > 60) $n = mb_substr($n, 0, 60);
    return $n;
}

/* ------------------------------------------------------------
 * 列を 1 本まるごと見て、型を決める
 * ---------------------------------------------------------- */

/**
 * 集めた統計から、型の区分を決める。
 * 戻り値の kind は 'int' | 'bigint' | 'decimal' | 'bool' | 'date' | 'datetime' | 'varchar' | 'text'
 */
function infer_kind(array $s): array
{
    $filled = $s['filled'];

    // 全部空 → いちばん緩い形にしておく
    if ($filled === 0) {
        return ['kind' => 'varchar', 'length' => 255, 'precision' => null, 'scale' => null,
                'reason' => '値がすべて空のため、文字列にしています'];
    }

    // 先頭ゼロ（007、0120…）は数値にすると消えるので、必ず文字列で残す
    if ($s['leadingZero'] > 0) {
        return ['kind' => 'varchar', 'length' => infer_varchar_len($s['maxLen']),
                'precision' => null, 'scale' => null,
                'reason' => '先頭が 0 の値があるため、数値にせず文字列にしています'];
    }

    if ($s['allBool']) {
        return ['kind' => 'bool', 'length' => null, 'precision' => null, 'scale' => null,
                'reason' => 'true / false として読める値だけのため'];
    }

    if ($s['allInt']) {
        // 19 桁を超えるものは整数に収まらないので文字列にする
        if ($s['maxIntLen'] > 18) {
            return ['kind' => 'varchar', 'length' => infer_varchar_len($s['maxLen']),
                    'precision' => null, 'scale' => null,
                    'reason' => '桁が大きすぎて整数に収まらないため、文字列にしています'];
        }
        $kind = ($s['maxIntLen'] > 9) ? 'bigint' : 'int';
        return ['kind' => $kind, 'length' => null, 'precision' => null, 'scale' => null,
                'reason' => '整数として読める値だけのため'];
    }

    if ($s['allDecimal']) {
        // 桁数は「整数部の最大 + 小数部の最大」で取る
        $scale = min(10, max(1, $s['maxScale']));
        $prec  = min(38, max($s['maxIntPart'] + $scale, $scale + 1));
        return ['kind' => 'decimal', 'length' => null, 'precision' => $prec, 'scale' => $scale,
                'reason' => '小数として読める値だけのため'];
    }

    if ($s['allDatetime']) {
        return ['kind' => 'datetime', 'length' => null, 'precision' => null, 'scale' => null,
                'reason' => '日付と時刻として読める値だけのため'];
    }

    if ($s['allDate']) {
        return ['kind' => 'date', 'length' => null, 'precision' => null, 'scale' => null,
                'reason' => $s['oracleDate'] > 0
                    ? '日付として読める値だけのため（26-AUG-26 のような書式を含む）'
                    : '日付として読める値だけのため'];
    }

    $len = infer_varchar_len($s['maxLen']);
    if ($len === null) {
        return ['kind' => 'text', 'length' => null, 'precision' => null, 'scale' => null,
                'reason' => "いちばん長い値が {$s['maxLen']} 文字のため、長文用の型にしています"];
    }
    return ['kind' => 'varchar', 'length' => $len, 'precision' => null, 'scale' => null,
            'reason' => "いちばん長い値が {$s['maxLen']} 文字のため"];
}

/** 最大長から varchar の桁を決める。長すぎるときは null（= text 行き）。 */
function infer_varchar_len(int $maxLen): ?int
{
    foreach (DBC_VARCHAR_STEPS as $step) {
        if ($maxLen <= $step) return $step;
    }
    return null;
}

/* ------------------------------------------------------------
 * CSV 全体を読み取る
 * ---------------------------------------------------------- */

/**
 * CSV からテーブル構成を読み取る。
 *
 * $opts: encoding, delimiter, filename
 */
function csv_infer_schema(string $bytes, array $opts): array
{
    $encoding = (string)($opts['encoding'] ?? '');
    $detected = csv_detect_encoding($bytes);
    if ($encoding === '' || $encoding === 'auto') $encoding = $detected;

    $text = csv_decode($bytes, $encoding);
    $delimiter = ((string)($opts['delimiter'] ?? '')) !== ''
        ? (string)$opts['delimiter'] : csv_detect_delimiter($text);

    $rows = csv_parse($text, $delimiter);
    if (!$rows) throw bad('CSV に行がありません。');

    $header = array_map('trim', array_shift($rows));
    if (!$header) throw bad('1 行目に見出しがありません。');
    if (!$rows) throw bad('見出しだけで、データの行がありません。');

    $colCount = count($header);

    // 列ごとの集計を初期化
    $stats = [];
    for ($i = 0; $i < $colCount; $i++) {
        $stats[$i] = [
            'filled' => 0, 'blank' => 0, 'maxLen' => 0,
            'allInt' => true, 'allDecimal' => true, 'allBool' => true,
            'allDate' => true, 'allDatetime' => true,
            'maxIntLen' => 0, 'maxIntPart' => 0, 'maxScale' => 0,
            'leadingZero' => 0, 'oracleDate' => 0,
            'distinct' => [], 'distinctOverflow' => false,
            'samples' => [],
        ];
    }

    $ragged = [];
    $rowCount = 0;

    foreach ($rows as $ri => $r) {
        // 全部空の行は数えない（末尾の空行対策）
        if (count(array_filter($r, fn($v) => trim((string)$v) !== '')) === 0) continue;
        $rowCount++;

        if (count($r) !== $colCount && count($ragged) < 5) {
            $ragged[] = ['line' => $ri + 2, 'expected' => $colCount, 'actual' => count($r)];
        }

        for ($i = 0; $i < $colCount; $i++) {
            $v = trim((string)($r[$i] ?? ''));
            $s =& $stats[$i];

            if ($v === '') { $s['blank']++; continue; }
            $s['filled']++;

            $len = mb_strlen($v);
            if ($len > $s['maxLen']) $s['maxLen'] = $len;
            if (count($s['samples']) < 3) $s['samples'][] = $v;

            // 一意かどうかを見るため、値を数える（上限まで）
            if (!$s['distinctOverflow']) {
                if (count($s['distinct']) >= DBC_INFER_MAX_DISTINCT) {
                    $s['distinctOverflow'] = true;
                    $s['distinct'] = [];
                } else {
                    $s['distinct'][$v] = true;
                }
            }

            if ($s['allBool'] && !infer_is_bool($v)) $s['allBool'] = false;

            if ($s['allInt']) {
                if (infer_is_int($v)) {
                    $digits = ltrim($v, '+-');
                    // 0 単体は先頭ゼロ扱いしない
                    if (strlen($digits) > 1 && $digits[0] === '0') $s['leadingZero']++;
                    $s['maxIntLen'] = max($s['maxIntLen'], strlen($digits));
                } else {
                    $s['allInt'] = false;
                }
            }

            if ($s['allDecimal']) {
                if (infer_is_int($v) || infer_is_decimal($v)) {
                    $digits = ltrim($v, '+-');
                    if (strlen($digits) > 1 && $digits[0] === '0' && ($digits[1] ?? '') !== '.') {
                        $s['leadingZero']++;
                    }
                    $dot = strpos($digits, '.');
                    if ($dot === false) {
                        $s['maxIntPart'] = max($s['maxIntPart'], strlen($digits));
                    } else {
                        $s['maxIntPart'] = max($s['maxIntPart'], $dot);
                        $s['maxScale']   = max($s['maxScale'], strlen($digits) - $dot - 1);
                    }
                } else {
                    $s['allDecimal'] = false;
                }
            }

            if ($s['allDatetime'] && !infer_is_datetime($v)) $s['allDatetime'] = false;

            if ($s['allDate']) {
                if (infer_is_date($v)) {
                    if (preg_match('/^\d{1,2}-[A-Za-z]{3}-/', $v)) $s['oracleDate']++;
                } else {
                    $s['allDate'] = false;
                }
            }
            unset($s);
        }
    }
    // 値が空の列では上の unset を通らないため、参照が残ったままになる。
    // ここで必ず切る。切らずに下で $s へ代入すると、参照先の列を壊してしまう。
    unset($s);

    // 集計から列の定義を組み立てる
    $columns = [];
    $usedNames = [];
    foreach ($header as $i => $h) {
        $stat = $stats[$i];
        $name = infer_column_name($h, $i, $usedNames);
        $usedNames[] = $name;

        $t = infer_kind($stat);
        $distinct = $stat['distinctOverflow'] ? null : count($stat['distinct']);

        // 主キーの候補: 空が無く、値が全行で重複していない
        $unique = $stat['blank'] === 0
            && $distinct !== null && $rowCount > 0 && $distinct === $rowCount
            && in_array($t['kind'], ['int', 'bigint', 'varchar'], true);
        // そのうえで、名前が識別子らしいか、いちばん左の列であることを求める。
        // 一意なだけの列（金額や日付など）を主キーに選ばないため。
        $pkCandidate = $unique && ($i === 0 || infer_looks_like_id($name));

        $columns[] = [
            'index'        => $i,
            'csvColumn'    => $h === '' ? '(見出しなし)' : $h,
            'name'         => $name,
            'kind'         => $t['kind'],
            'length'       => $t['length'],
            'precision'    => $t['precision'],
            'scale'        => $t['scale'],
            'nullable'     => $stat['blank'] > 0,
            'blankCount'   => $stat['blank'],
            'filledCount'  => $stat['filled'],
            'maxLength'    => $stat['maxLen'],
            'distinctCount'=> $distinct,
            'isUnique'     => $unique,
            'primaryKey'   => false,          // 既定では付けない。下で 1 本だけ候補に立てる
            'pkCandidate'  => $pkCandidate,
            'reason'       => $t['reason'],
            'samples'      => $stat['samples'],
        ];
    }

    // 主キーの候補があれば、いちばん左の 1 本だけ既定で立てておく
    foreach ($columns as $k => $c) {
        if ($c['pkCandidate']) { $columns[$k]['primaryKey'] = true; break; }
    }
    $hasPk = false;
    foreach ($columns as $c) if ($c['primaryKey']) { $hasPk = true; break; }

    $notes = [];
    if ($ragged) {
        $notes[] = sprintf('見出しと列数が合わない行があります（例: %d 行目は %d 列）。読み取りは続けています。',
            $ragged[0]['line'], $ragged[0]['actual']);
    }
    if (!$hasPk) {
        $notes[] = '値が全行で一意になる列が無いため、主キーの候補が見つかりませんでした。'
                 . '「自動採番の id を追加」を使うと主キーを作れます。';
    }
    foreach ($columns as $c) {
        if ($c['filledCount'] === 0) {
            $notes[] = "列「{$c['name']}」は値がすべて空でした。型を確かめてください。";
        }
    }

    return [
        'encoding'         => $encoding,
        'encodingLabel'    => csv_encoding_label($encoding),
        'detectedEncoding' => $detected,
        'delimiter'        => $delimiter === "\t" ? 'tab' : $delimiter,
        'tableName'        => infer_table_name((string)($opts['filename'] ?? '')),
        'rowCount'         => $rowCount,
        'columnCount'      => $colCount,
        'columns'          => $columns,
        'addSurrogateKey'  => !$hasPk,
        'ragged'           => $ragged,
        'notes'            => $notes,
    ];
}
