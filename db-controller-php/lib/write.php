<?php
/**
 * 更新系。安全側に倒すため、次の条件をすべて満たさなければ実行しない。
 *
 *  0. ログイン中の利用者が「運用者」以上であること（閲覧者は変更できない）
 *  1. 接続プロファイルが読み取り専用でないこと（既定は読み取り専用）
 *  2. 対象テーブルに主キーがあること（行を一意に特定できること）
 *  3. トランザクション内で実行し、影響行数がちょうど 1 行であること
 *     （0 行 = 対象が既に無い / 2 行以上 = キーの指定ミス。いずれもロールバックする）
 */

declare(strict_types=1);

/** 読み取り専用の接続では更新系を一切通さない。 */
function assert_writable(array $conn): void
{
    // 明示的に false でない限り読み取り専用として扱う
    if (($conn['readOnly'] ?? true) !== false) {
        throw bad(
            "接続「{$conn['name']}」は読み取り専用です。" .
            'データを変更するには、接続設定で「読み取り専用」を解除してください。', 403);
    }
}

/**
 * 主キーが無いテーブルは、行を一意に特定できないので変更させない。
 *
 * 画面は主キーの値も { value, isNull } の形で送ってくるので、
 * ここで素の値へ戻す。戻し忘れると、WHERE に配列を渡すことになり
 * 「対象の行が見つからない」という誤った結果になる。
 */
function assert_row_key(array $detail, array $key): array
{
    $pk = $detail['primaryKey'];
    if (!$pk) {
        throw bad('このテーブルには主キーがありません。行を一意に特定できないため変更できません。');
    }
    $out = [];
    foreach ($pk as $col) {
        if (!array_key_exists($col, $key)) {
            throw bad("主キー {$col} の値が指定されていません。");
        }
        $value = normalize_value($key[$col]);
        if ($value === null) {
            throw bad("主キー {$col} の値が指定されていません。");
        }
        $out[$col] = $value;
    }
    return $out;
}

/**
 * 画面から来た 1 つの値を、DB へ渡せる形にする。
 * { value: "...", isNull: true } の形で受け取る。
 */
function normalize_value($field)
{
    if (!is_array($field)) return $field;
    if (!empty($field['isNull'])) return null;
    return array_key_exists('value', $field) ? $field['value'] : null;
}

/**
 * トランザクションで実行し、影響行数が 1 行でなければ取り消す。
 * ここが「壊さない」ことの中心。
 */
function run_single_row(DbDriver $drv, callable $operation, string $describe): array
{
    $pdo = $drv->pdo();
    $pdo->beginTransaction();
    try {
        $result = $operation();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    if ($result['affected'] !== 1) {
        $pdo->rollBack();
        $reason = $result['affected'] === 0
            ? '対象の行が見つかりませんでした。他の利用者が既に変更・削除した可能性があります。'
            : "{$result['affected']} 行が対象になりました。1 行だけを対象にできないため取り消しました。";
        throw bad("{$describe}は実行されませんでした。{$reason}");
    }

    $pdo->commit();
    return $result;
}

function insert_row(DbDriver $drv, string $schema, string $table, array $fields): array
{
    if (!$fields) throw bad('追加する値がありません。');

    $cols = [];
    $params = [];
    foreach ($fields as $name => $field) {
        $cols[] = $drv->quote($drv->assertIdentifier((string)$name, '列名'));
        $params[] = normalize_value($field);
    }

    $sql = 'INSERT INTO ' . $drv->qualify($schema, $table)
         . ' (' . implode(', ', $cols) . ')'
         . ' VALUES (' . implode(', ', array_fill(0, count($cols), '?')) . ')';

    $pdo = $drv->pdo();
    return run_single_row($drv, function () use ($pdo, $sql, $params) {
        $st = $pdo->prepare($sql);
        $st->execute($params);
        return ['affected' => $st->rowCount(), 'sql' => $sql];
    }, '追加');
}

function update_row(DbDriver $drv, string $schema, string $table, array $key, array $fields): array
{
    if (!$fields) throw bad('変更する値がありません。');

    $sets = [];
    $params = [];
    foreach ($fields as $name => $field) {
        $sets[] = $drv->quote($drv->assertIdentifier((string)$name, '列名')) . ' = ?';
        $params[] = normalize_value($field);
    }

    $wheres = [];
    foreach ($key as $name => $value) {
        $wheres[] = $drv->quote($drv->assertIdentifier((string)$name, '主キーの列名')) . ' = ?';
        $params[] = $value;
    }

    $sql = 'UPDATE ' . $drv->qualify($schema, $table)
         . ' SET ' . implode(', ', $sets)
         . ' WHERE ' . implode(' AND ', $wheres);

    $pdo = $drv->pdo();
    return run_single_row($drv, function () use ($pdo, $sql, $params) {
        $st = $pdo->prepare($sql);
        $st->execute($params);
        // MySQL は接続時に MYSQL_ATTR_FOUND_ROWS を立ててあるので、
        // rowCount() は「条件に一致した行数」を返す。
        // 値が変わらない UPDATE も 1 行として正しく数えられる。
        // PostgreSQL はもともと一致した行数を返す。
        return ['affected' => $st->rowCount(), 'sql' => $sql];
    }, '修正');
}

function delete_row(DbDriver $drv, string $schema, string $table, array $key): array
{
    $wheres = [];
    $params = [];
    foreach ($key as $name => $value) {
        $wheres[] = $drv->quote($drv->assertIdentifier((string)$name, '主キーの列名')) . ' = ?';
        $params[] = $value;
    }
    if (!$wheres) throw bad('削除する行を特定できません。');

    $sql = 'DELETE FROM ' . $drv->qualify($schema, $table) . ' WHERE ' . implode(' AND ', $wheres);

    $pdo = $drv->pdo();
    return run_single_row($drv, function () use ($pdo, $sql, $params) {
        $st = $pdo->prepare($sql);
        $st->execute($params);
        return ['affected' => $st->rowCount(), 'sql' => $sql];
    }, '削除');
}
