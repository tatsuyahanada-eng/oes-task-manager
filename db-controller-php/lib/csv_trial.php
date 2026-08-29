<?php
/**
 * CSV の「お試し取り込み」。
 *
 * 本番のテーブルに触れずに、取り込みが通るかどうかだけを確かめる。
 *
 * しくみ:
 *   DB の「一時テーブル」に入れて試す。一時テーブルは、
 *     - その接続からしか見えない（他の利用者に影響しない）
 *     - 接続が切れると自動的に消える
 *   PHP はリクエストごとに接続を閉じるので、この 1 回で終わり、何も残らない。
 *   本番と同じ DB・同じ型・同じ文字コードで試すため、結果はそのまま信用できる。
 *
 * なぜトランザクションで戻す方式にしないか:
 *   MySQL は CREATE TABLE の時点で暗黙にコミットしてしまい、戻せない。
 *   （PostgreSQL は戻せるが、DB によって挙動が変わる方式は避けた）
 *
 * 本番の取り込みと違い、1 行目で止めずに最後まで試し、
 * 失敗した行を全部集めて返す。どこを直せばよいかを一度に見せるため。
 */

declare(strict_types=1);

/** お試しで報告する失敗の上限。これを超えたら件数だけ数える。 */
const DBC_TRIAL_MAX_ERRORS = 50;

/** お試し用の一時テーブル名。本番と混ざらないよう、毎回変える。 */
function csv_trial_table_name(): string
{
    return 'dbc_trial_' . bin2hex(random_bytes(5));
}

/**
 * 一時テーブルへ CSV を入れてみて、結果を返す。
 *
 * $columns は ['name'=>, 'nullable'=>, 'dataType'=>] の配列。
 * 一時テーブルは information_schema に出ないので、列の情報は呼び出し側から渡す。
 */
function csv_trial_import(DbDriver $drv, string $tempName, array $columns,
                          string $bytes, array $opts): array
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
    if (!$rows) throw bad('見出しだけで、データの行がありません。');

    // 列の対応づけ（本番の取り込みと同じく、見出しと列名の一致で決める）
    $byName = [];
    foreach ($columns as $c) $byName[$c['name']] = $c;

    $matched = [];
    $ignored = [];
    foreach ($header as $i => $h) {
        if ($h !== '' && isset($byName[$h])) {
            $matched[] = ['index' => $i, 'column' => $h,
                          'nullable' => (bool)($byName[$h]['nullable'] ?? true),
                          'dataType' => (string)($byName[$h]['dataType'] ?? '')];
        } else {
            $ignored[] = $h === '' ? '(見出しなし)' : $h;
        }
    }
    if (!$matched) {
        throw bad('CSV の見出しと一致する列がありません。1 行目が見出しになっているか確認してください。');
    }

    $emptyAsNull = !array_key_exists('emptyAsNull', $opts) || (bool)$opts['emptyAsNull'];

    $cols = array_map(fn($m) => $drv->quote($m['column']), $matched);
    $sql = 'INSERT INTO ' . $drv->quote($tempName)
         . ' (' . implode(', ', $cols) . ')'
         . ' VALUES (' . implode(', ', array_fill(0, count($cols), '?')) . ')';

    $pdo = $drv->pdo();
    $st = $pdo->prepare($sql);

    $okCount = 0;
    $errors = [];
    $errorTotal = 0;

    foreach ($rows as $i => $r) {
        // 全部空の行は飛ばす（末尾の空行対策）
        if (count(array_filter($r, fn($v) => trim((string)$v) !== '')) === 0) continue;

        $params = [];
        foreach ($matched as $m) {
            $v = $r[$m['index']] ?? null;
            if ($v === '' || $v === null) {
                $params[] = ($emptyAsNull && $m['nullable']) ? null : ($v === null ? null : '');
                continue;
            }
            if (csv_is_bool_column($m['dataType']))      $v = csv_bool_value((string)$v);
            elseif (csv_is_date_column($m['dataType']))  $v = csv_date_value((string)$v);
            $params[] = $v;
        }

        try {
            $st->execute($params);
            $okCount++;
        } catch (PDOException $e) {
            $errorTotal++;
            if (count($errors) < DBC_TRIAL_MAX_ERRORS) {
                $errors[] = [
                    'line'    => $i + 2,          // 見出しが 1 行目
                    'message' => csv_trial_reason($e->getMessage()),
                    'raw'     => $e->getMessage(),
                ];
            }
        }
    }

    // 入った中身を少しだけ見せる（本当に入ったかを目で確かめられるように）
    $sample = [];
    try {
        // 見出しと数を揃えたいので、対応づいた列だけを取り出す
        $q = $pdo->query('SELECT ' . implode(', ', $cols)
                       . ' FROM ' . $drv->quote($tempName) . ' LIMIT 10');
        $sample = $q->fetchAll(PDO::FETCH_NUM);
    } catch (PDOException $e) { /* 見せられなくても本題ではない */ }

    return [
        'ok'             => $errorTotal === 0,
        'tried'          => $okCount + $errorTotal,
        'inserted'       => $okCount,
        'failed'         => $errorTotal,
        'errors'         => $errors,
        'errorsShown'    => count($errors),
        'columns'        => array_column($matched, 'column'),
        'ignoredColumns' => $ignored,
        'encoding'       => $encoding,
        'encodingLabel'  => csv_encoding_label($encoding),
        'delimiter'      => $delimiter === "\t" ? 'tab' : $delimiter,
        'sample'         => $sample,
        'sql'            => $sql,
    ];
}

/**
 * DB のエラー文を、何を直せばよいか分かる言い方にする。
 * 元の文は raw に残してあるので、詳しく見たい人はそちらを見られる。
 */
function csv_trial_reason(string $message): string
{
    $m = $message;
    if (strpos($m, '1062') !== false || stripos($m, 'Duplicate entry') !== false
        || stripos($m, 'duplicate key') !== false) {
        return '主キーか一意制約が重複しています。同じ値の行が既にあります。';
    }
    if (strpos($m, '1406') !== false || stripos($m, 'Data too long') !== false
        || stripos($m, 'value too long') !== false) {
        return '値が桁からあふれています。列の桁を広げてください。';
    }
    if (strpos($m, '1048') !== false || stripos($m, 'cannot be null') !== false
        || stripos($m, 'not-null constraint') !== false) {
        return '必須の列が空です。値を入れるか、その列を NULL 可にしてください。';
    }
    if (stripos($m, 'Incorrect date') !== false || stripos($m, 'Incorrect datetime') !== false
        || stripos($m, 'invalid input syntax for type date') !== false
        || stripos($m, 'invalid input syntax for type timestamp') !== false) {
        return '日付として読めない値です。書式を確かめてください。';
    }
    if (stripos($m, 'Incorrect integer') !== false || stripos($m, 'Incorrect decimal') !== false
        || stripos($m, 'invalid input syntax for type') !== false
        || stripos($m, 'Out of range') !== false) {
        return '数値として読めない値か、桁が大きすぎます。';
    }
    if (stripos($m, 'Incorrect string value') !== false) {
        return '文字コードで扱えない文字が含まれています。';
    }
    return '取り込めませんでした。下の元のメッセージを確認してください。';
}
