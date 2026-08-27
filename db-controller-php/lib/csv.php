<?php
/**
 * CSV の読み書き。
 *
 * Oracle / SQL Server から抜いたデータを取り込むのが主目的なので、
 * 日本語の文字コードを取り違えないことを最優先にしている。
 *
 * 扱う文字コード:
 *   UTF-8 (BOM 付き / 無し) … Excel は BOM 付きを好む
 *   Shift_JIS (CP932)      … Windows の既定。丸数字などを含むため CP932 で扱う
 *   EUC-JP                 … 古い基幹系から出てくることがある
 */

declare(strict_types=1);

const DBC_BOM = "\xEF\xBB\xBF";

function csv_encodings(): array
{
    return [
        ['id' => 'utf-8',       'label' => 'UTF-8 (BOM 付き)', 'note' => 'Excel で開くならこれ'],
        ['id' => 'utf-8-nobom', 'label' => 'UTF-8 (BOM 無し)', 'note' => 'プログラムで読むならこれ'],
        ['id' => 'shift_jis',   'label' => 'Shift_JIS (CP932)', 'note' => 'Windows の古いソフト向け'],
        ['id' => 'euc-jp',      'label' => 'EUC-JP',            'note' => '古い基幹系向け'],
    ];
}

/** 内部の文字コード名へ。 */
function csv_charset(string $id): string
{
    // 「Shift_JIS」より CP932 の方が扱える字が多い
    if ($id === 'shift_jis') return 'CP932';
    if ($id === 'euc-jp')    return 'eucJP-win';
    return 'UTF-8';
}

/* ------------------------------------------------------------
 * 書き出し
 * ---------------------------------------------------------- */

/** 1 行分を RFC 4180 の形にする。 */
function csv_line(array $values, string $delimiter = ','): string
{
    $out = [];
    foreach ($values as $v) {
        if ($v === null) { $out[] = ''; continue; }
        $s = (string)$v;
        // 区切り・引用符・改行を含むときだけ囲む。内部の " は 2 個にする。
        if (preg_match('/[",\r\n\t]/', $s) || str_contains($s, $delimiter)) {
            $s = '"' . str_replace('"', '""', $s) . '"';
        }
        $out[] = $s;
    }
    // Excel が素直に読めるよう CRLF で終える
    return implode($delimiter, $out) . "\r\n";
}

/** UTF-8 の文字列を、指定の文字コードのバイト列にする。 */
function csv_encode(string $utf8, string $encodingId): string
{
    $charset = csv_charset($encodingId);
    if ($charset === 'UTF-8') return $utf8;

    // 変換できない文字は「?」ではなく、元の字が分かる形で残す
    $prev = mb_substitute_character();
    mb_substitute_character(0x3013);   // 〓（ゲタ記号）
    $out = mb_convert_encoding($utf8, $charset, 'UTF-8');
    mb_substitute_character($prev);
    return $out;
}

/* ------------------------------------------------------------
 * 読み込み
 * ---------------------------------------------------------- */

/**
 * 文字コードを推定する。
 *
 * BOM があればそれが答え。
 * 無ければ「UTF-8 として妥当か」を厳密に見る。妥当なら UTF-8。
 * 妥当でなければ、日本語の CSV でよくある CP932 とみなす。
 */
function csv_detect_encoding(string $bytes): string
{
    if (str_starts_with($bytes, DBC_BOM)) return 'utf-8';

    // 判定は先頭の一部で足りる。ただし文字の途中で切らない。
    $head = substr($bytes, 0, 65536);

    if (mb_check_encoding($head, 'UTF-8')) {
        // ASCII だけなら、どの文字コードでも同じなので UTF-8 とみなす
        return 'utf-8-nobom';
    }
    if (mb_check_encoding($head, 'eucJP-win') && !mb_check_encoding($head, 'CP932')) {
        return 'euc-jp';
    }
    return 'shift_jis';
}

/** 与えられたバイト列を UTF-8 の文字列にする。 */
function csv_decode(string $bytes, string $encodingId): string
{
    if (str_starts_with($bytes, DBC_BOM)) $bytes = substr($bytes, strlen(DBC_BOM));

    $charset = csv_charset($encodingId);
    if ($charset === 'UTF-8') {
        if (!mb_check_encoding($bytes, 'UTF-8')) {
            throw bad('UTF-8 として読めないバイトが含まれています。文字コードの指定を確認してください。');
        }
        return $bytes;
    }
    return mb_convert_encoding($bytes, 'UTF-8', $charset);
}

/** 区切り文字を推定する。1 行目に多く現れるものを選ぶ。 */
function csv_detect_delimiter(string $text): string
{
    $firstLine = strtok($text, "\r\n") ?: '';
    $best = ','; $bestCount = -1;
    foreach ([',', "\t", ';'] as $d) {
        $n = substr_count($firstLine, $d);
        if ($n > $bestCount) { $best = $d; $bestCount = $n; }
    }
    return $best;
}

/**
 * CSV を解析して、行の配列にする。
 * 引用符の中の改行・区切り・二重引用符を正しく扱う（RFC 4180）。
 */
function csv_parse(string $text, string $delimiter = ','): array
{
    $rows = [];
    $row = [];
    $field = '';
    $inQuotes = false;
    $len = strlen($text);
    $started = false;   // このフィールドに何か入ったか（空行の判定用）

    for ($i = 0; $i < $len; $i++) {
        $ch = $text[$i];

        if ($inQuotes) {
            if ($ch === '"') {
                if ($i + 1 < $len && $text[$i + 1] === '"') { $field .= '"'; $i++; }
                else { $inQuotes = false; }
            } else {
                $field .= $ch;
            }
            continue;
        }

        if ($ch === '"') { $inQuotes = true; $started = true; continue; }

        if ($ch === $delimiter) {
            $row[] = $field; $field = ''; $started = true; continue;
        }

        if ($ch === "\r") {
            // CRLF の CR は読み飛ばす
            if ($i + 1 < $len && $text[$i + 1] === "\n") continue;
            $ch = "\n";
        }

        if ($ch === "\n") {
            $row[] = $field;
            // 完全な空行は捨てる
            if (!($started === false && count($row) === 1 && $row[0] === '')) {
                $rows[] = $row;
            }
            $row = []; $field = ''; $started = false;
            continue;
        }

        $field .= $ch;
        $started = true;
    }

    // 最後の行に改行が無い場合
    if ($field !== '' || $row) {
        $row[] = $field;
        if (!(count($row) === 1 && $row[0] === '')) $rows[] = $row;
    }

    return $rows;
}
