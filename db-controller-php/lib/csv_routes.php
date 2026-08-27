<?php
/**
 * CSV の入出力エンドポイント。
 *
 * 取り込みは 2 段階に分ける:
 *   1. 下見 (preview) … 何が起きるかを見せるだけ。DB は触らない
 *   2. 実行 (execute) … 下見で確認した内容を実際に入れる
 *
 * 列の対応は「CSV の見出し」と「テーブルの列名」の一致で決める。
 * 一致しない見出しは取り込まず、下見の時点で知らせる。
 */

declare(strict_types=1);

const DBC_IMPORT_BATCH = 500;
const DBC_IMPORT_MAX_ROWS = 50000;

/** 書き出し。件数が多くても詰まらないよう、少しずつ流す。 */
function csv_export(DbDriver $drv, string $schema, string $table,
                    string $where, string $encoding, string $delimiter): void
{
    $detail = $drv->describeTable($schema, $table);
    $columns = array_map(fn($c) => $c['name'], $detail['columns']);

    $filename = sprintf('%s_%s_%s.csv', $schema, $table, gmdate('Ymd_His'));

    header('Content-Type: text/csv; charset=' . csv_charset($encoding));
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    header('Cache-Control: no-store');

    if ($encoding === 'utf-8') echo DBC_BOM;

    // 見出し
    echo csv_encode(csv_line($columns, $delimiter), $encoding);

    $sql = 'SELECT * FROM ' . $drv->qualify($schema, $table);
    if ($where !== '') $sql .= ' WHERE ' . $drv->assertWhere($where);

    $st = $drv->pdo()->query($sql);
    $buffer = '';
    $n = 0;
    while ($row = $st->fetch(PDO::FETCH_NUM)) {
        $buffer .= csv_line($row, $delimiter);
        // 一定量ごとに送り出す。全件をメモリに積まない。
        if (++$n % 500 === 0) {
            echo csv_encode($buffer, $encoding);
            $buffer = '';
            if (ob_get_level()) @ob_flush();
            @flush();
        }
    }
    if ($buffer !== '') echo csv_encode($buffer, $encoding);
    exit;
}

/**
 * 取り込みの下見。
 * 何が入るか・何が入らないかを返すだけで、DB は変更しない。
 */
function csv_preview(DbDriver $drv, string $schema, string $table,
                     string $bytes, array $opts): array
{
    $detail = $drv->describeTable($schema, $table);
    if ($detail['type'] !== 'TABLE') throw bad('ビューには取り込めません。');

    $encoding = $opts['encoding'] ?? '';
    $detected = csv_detect_encoding($bytes);
    if ($encoding === '' || $encoding === 'auto') $encoding = $detected;

    $text = csv_decode($bytes, $encoding);
    $delimiter = ($opts['delimiter'] ?? '') !== '' ? $opts['delimiter'] : csv_detect_delimiter($text);

    $rows = csv_parse($text, $delimiter);
    if (!$rows) throw bad('CSV に行がありません。');

    $header = array_map('trim', array_shift($rows));
    if (count($rows) > DBC_IMPORT_MAX_ROWS) {
        throw bad(sprintf('行数が多すぎます（%s 行）。一度に取り込めるのは %s 行までです。',
            number_format(count($rows)), number_format(DBC_IMPORT_MAX_ROWS)));
    }

    // 列の対応づけ
    $tableColumns = [];
    foreach ($detail['columns'] as $c) $tableColumns[$c['name']] = $c;

    $matched = [];      // 取り込む列
    $ignored = [];      // CSV にあるがテーブルに無い見出し
    foreach ($header as $i => $h) {
        if ($h !== '' && isset($tableColumns[$h])) {
            $matched[] = ['index' => $i, 'csvColumn' => $h, 'tableColumn' => $h,
                          'dataType' => $tableColumns[$h]['dataType'],
                          'nullable' => $tableColumns[$h]['nullable']];
        } else {
            $ignored[] = ['index' => $i, 'csvColumn' => $h === '' ? '(見出しなし)' : $h];
        }
    }

    // テーブルにあるが CSV に無い列
    $csvNames = array_column($matched, 'tableColumn');
    $missing = [];
    foreach ($detail['columns'] as $c) {
        if (in_array($c['name'], $csvNames, true)) continue;
        $missing[] = [
            'tableColumn' => $c['name'],
            'nullable'    => $c['nullable'],
            'isIdentity'  => $c['isIdentity'],
            'hasDefault'  => $c['defaultValue'] !== null,
            // 自動採番でも既定値でもなく NOT NULL なら、取り込みは失敗する
            'willFail'    => !$c['nullable'] && !$c['isIdentity'] && $c['defaultValue'] === null,
        ];
    }

    $problems = [];
    if (!$matched) {
        $problems[] = 'CSV の見出しと一致する列がありません。1 行目が見出しになっているか確認してください。';
    }
    foreach ($missing as $m) {
        if ($m['willFail']) {
            $problems[] = "列「{$m['tableColumn']}」は必須ですが、CSV にありません。";
        }
    }

    // 見出しと列数が合わない行を探す
    $ragged = [];
    foreach ($rows as $i => $r) {
        if (count($r) !== count($header)) {
            $ragged[] = ['line' => $i + 2, 'expected' => count($header), 'actual' => count($r)];
            if (count($ragged) >= 5) break;
        }
    }
    if ($ragged) {
        $problems[] = sprintf('見出しと列数が合わない行があります（例: %d 行目は %d 列）。',
            $ragged[0]['line'], $ragged[0]['actual']);
    }

    // 列の対応を、CSV の並び順どおりに 1 本の配列で返す。
    // 画面はこれをそのまま「CSV の見出し → テーブルの列」として描く。
    $mapping = [];
    foreach ($header as $i => $h) {
        $hit = null;
        foreach ($matched as $m) {
            if ($m['index'] === $i) { $hit = $m['tableColumn']; break; }
        }
        $mapping[] = ['index' => $i,
                      'csvColumn' => $h === '' ? '(見出しなし)' : $h,
                      'tableColumn' => $hit];
    }

    // 先頭 10 行を、CSV の並びのまま見せる（対応しない列も含めて確認できるように）
    $sample = [];
    foreach (array_slice($rows, 0, 10) as $r) {
        $one = [];
        foreach ($header as $i => $_) $one[] = $r[$i] ?? '';
        $sample[] = $one;
    }

    $canImport = !$problems && $matched && count($rows) > 0;

    return [
        'schema'           => $schema,
        'table'            => $table,
        'encoding'         => $encoding,
        'encodingLabel'    => csv_encoding_label($encoding),
        'detectedEncoding' => $detected,
        'delimiter'        => $delimiter === "\t" ? 'tab' : $delimiter,
        'hasHeader'        => true,
        'totalRows'        => count($rows),
        'rowCount'         => count($rows),
        'mapping'          => $mapping,
        'matched'          => $matched,
        'matchedColumns'   => array_column($matched, 'tableColumn'),
        'ignored'          => $ignored,
        'unmatchedColumns' => array_column($ignored, 'csvColumn'),
        'missing'          => $missing,
        'missingRequired'  => array_values(array_map(
            fn($m) => $m['tableColumn'],
            array_filter($missing, fn($m) => $m['willFail']))),
        'tableColumns'     => array_map(fn($c) => $c['name'], $detail['columns']),
        'sample'           => $sample,
        'ragged'           => $ragged,
        'warnings'         => $problems,
        'problems'         => $problems,
        'canImport'        => $canImport,
    ];
}

/** 文字コードの表示名。 */
function csv_encoding_label(string $id): string
{
    foreach (csv_encodings() as $e) {
        if ($e['id'] === $id) return $e['label'];
    }
    return $id;
}

/**
 * 取り込みの実行。
 *
 * 全体を 1 つのトランザクションで囲む。
 * 途中で 1 行でも失敗したら、すべて取り消す。
 * 「半分だけ入った」状態を作らないため。
 */
function csv_import(DbDriver $drv, string $schema, string $table,
                    string $bytes, array $opts): array
{
    $preview = csv_preview($drv, $schema, $table, $bytes, $opts);
    if (!$preview['canImport']) {
        throw bad('取り込めません: ' . implode(' ', $preview['problems']));
    }

    $text = csv_decode($bytes, $preview['encoding']);
    $delimiter = $preview['delimiter'] === 'tab' ? "\t" : $preview['delimiter'];
    $rows = csv_parse($text, $delimiter);
    array_shift($rows);   // 見出しを外す

    $matched = $preview['matched'];
    $cols = array_map(fn($m) => $drv->quote($m['tableColumn']), $matched);

    $sql = 'INSERT INTO ' . $drv->qualify($schema, $table)
         . ' (' . implode(', ', $cols) . ')'
         . ' VALUES (' . implode(', ', array_fill(0, count($cols), '?')) . ')';

    $pdo = $drv->pdo();
    $pdo->beginTransaction();

    $inserted = 0;
    try {
        $st = $pdo->prepare($sql);
        foreach ($rows as $i => $r) {
            $params = [];
            foreach ($matched as $m) {
                $v = $r[$m['index']] ?? null;
                // 空欄は NULL として入れる（空文字ではなく）
                $params[] = ($v === '' || $v === null) ? null : $v;
            }
            try {
                $st->execute($params);
            } catch (PDOException $e) {
                throw bad(sprintf('%d 行目で失敗しました: %s（すべて取り消しました）',
                    $i + 2, $e->getMessage()));
            }
            $inserted++;
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    return [
        'inserted' => $inserted,
        'encoding' => $preview['encoding'],
        'columns'  => array_column($matched, 'tableColumn'),
        'sql'      => $sql,
    ];
}

/**
 * スキーマ全体を CSV にまとめて ZIP で返す。
 * 取り込み前のバックアップに使う。
 *
 * ZipArchive は一時ファイルを必要とするので、作ってから読み出して消す。
 */
function csv_export_schema(DbDriver $drv, string $schema, string $encoding, string $delimiter): void
{
    if (!class_exists('ZipArchive')) {
        throw bad('この PHP には ZipArchive がありません。テーブルごとの CSV 書き出しをお使いください。', 500);
    }

    $tables = $drv->listTables($schema);
    if (!$tables) throw bad('このスキーマにはテーブルがありません。');

    $tmp = tempnam(sys_get_temp_dir(), 'dbc');
    if ($tmp === false) throw bad('一時ファイルを作れませんでした。', 500);

    $zip = new ZipArchive();
    if ($zip->open($tmp, ZipArchive::OVERWRITE) !== true) {
        @unlink($tmp);
        throw bad('ZIP を作れませんでした。', 500);
    }

    $summary = [];
    foreach ($tables as $t) {
        // ビューも中身は取れるが、戻せないので分けて記録する
        $detail = $drv->describeTable($schema, $t['name']);
        $columns = array_map(fn($c) => $c['name'], $detail['columns']);

        $body = '';
        if ($encoding === 'utf-8') $body .= DBC_BOM;
        $body .= csv_line($columns, $delimiter);

        $st = $drv->pdo()->query('SELECT * FROM ' . $drv->qualify($schema, $t['name']));
        $n = 0;
        while ($row = $st->fetch(PDO::FETCH_NUM)) { $body .= csv_line($row, $delimiter); $n++; }

        $zip->addFromString($t['name'] . '.csv', csv_encode($body, $encoding));
        $summary[] = sprintf('%-40s %8d 行  %s', $t['name'], $n, $t['type']);
    }

    // 何が入っているかの目録も同梱する
    $readme = "DB Controller — {$schema} の書き出し\n"
            . '作成: ' . gmdate('Y-m-d H:i:s') . " UTC\n"
            . "文字コード: {$encoding}\n\n"
            . implode("\n", $summary) . "\n";
    $zip->addFromString('_目録.txt', csv_encode($readme, $encoding));
    $zip->close();

    $filename = sprintf('%s_%s.zip', $schema, gmdate('Ymd_His'));
    header('Content-Type: application/zip');
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    header('Content-Length: ' . (string)filesize($tmp));
    header('Cache-Control: no-store');
    readfile($tmp);
    @unlink($tmp);
    exit;
}

/** 一括バックアップの対象を、実行前に知らせる。 */
function csv_schema_info(DbDriver $drv, string $schema): array
{
    $tables = $drv->listTables($schema);
    $tableCount = 0; $viewCount = 0;
    $out = [];
    foreach ($tables as $t) {
        if ($t['type'] === 'VIEW') $viewCount++; else $tableCount++;
        $out[] = ['name' => $t['name'], 'type' => $t['type'],
                  'estimatedRows' => $t['approxRows']];
    }
    return ['schema' => $schema, 'tableCount' => $tableCount,
            'viewCount' => $viewCount, 'tables' => $out];
}
