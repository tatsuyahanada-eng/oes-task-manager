<?php
/**
 * 操作の記録。誰がいつ何をしたかを後から追えるようにする。
 * data/audit.log へ 1 行 1 JSON で追記する。
 */

declare(strict_types=1);

const DBC_AUDIT_MAX_SQL = 2000;

function audit_file(): string { return data_path('audit.log'); }

function audit(array $entry): void
{
    $line = json_encode(array_merge(
        ['at' => now_iso()],
        $entry,
        isset($entry['sql']) ? ['sql' => mb_substr((string)$entry['sql'], 0, DBC_AUDIT_MAX_SQL)] : []
    ), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

    // 記録に失敗しても操作自体は妨げない
    @file_put_contents(audit_file(), $line . "\n", FILE_APPEND | LOCK_EX);
}

/** 直近の記録を新しい順に返す。 */
function audit_recent(int $limit = 100): array
{
    $file = audit_file();
    if (!is_file($file)) return [];

    $lines = @file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if ($lines === false) return [];

    $out = [];
    foreach (array_slice($lines, -$limit) as $line) {
        $row = json_decode($line, true);
        if (is_array($row)) $out[] = $row;
    }
    return array_reverse($out);
}
