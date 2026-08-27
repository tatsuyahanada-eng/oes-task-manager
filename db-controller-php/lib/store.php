<?php
/**
 * 接続先の保存。
 * パスワードは暗号化して保存し、画面へは絶対に返さない。
 */

declare(strict_types=1);

function store_file(): string { return data_path('connections.json'); }

function store_all(): array
{
    $db = read_json(store_file());
    return ($db !== null && isset($db['connections']) && is_array($db['connections']))
        ? $db['connections'] : [];
}

function store_save(array $connections): void
{
    write_json(store_file(), ['version' => 1, 'connections' => array_values($connections)]);
}

/** 画面へ返してよい形。パスワードは出さず、有無だけ伝える。 */
function conn_public(array $c): array
{
    $out = $c;
    unset($out['password']);
    $out['hasPassword'] = !empty($c['password']);
    return $out;
}

function store_list(): array
{
    return array_map('conn_public', store_all());
}

function store_get(string $id): ?array
{
    foreach (store_all() as $c) {
        if ($c['id'] === $id) return $c;
    }
    return null;
}

/** 実際に接続するための形。パスワードを復号して入れる。 */
function store_runtime(string $id): ?array
{
    $c = store_get($id);
    if ($c === null) return null;
    $c['password'] = $c['password'] !== '' ? decrypt_secret($c['password']) : '';
    return $c;
}

/** 入力を検査して、保存できる形に整える。 */
function normalize_conn(array $input, ?array $existing = null): array
{
    $name = trim((string)pick($input, 'name', ''));
    if ($name === '') throw bad('表示名を入力してください。');
    if (mb_strlen($name) > 80) throw bad('表示名は 80 文字までにしてください。');

    $type = (string)pick($input, 'type', '');
    if (!isset(drivers()[$type])) throw bad('対応していない DB 種別です。');

    $host = trim((string)pick($input, 'host', ''));
    if ($host === '') throw bad('ホストを入力してください。');
    if (!preg_match('/^[A-Za-z0-9._\-:\[\]]+$/', $host)) throw bad('ホストの形式が正しくありません。');

    $port = (int)pick($input, 'port', 0);
    if ($port <= 0) $port = drivers()[$type]['defaultPort'];
    if ($port < 1 || $port > 65535) throw bad('ポートは 1〜65535 で指定してください。');

    $username = trim((string)pick($input, 'username', ''));
    if ($username === '') throw bad('ユーザー名を入力してください。');

    // パスワードが空なら、既存のものを引き継ぐ（変更しない、という意味）
    $rawPassword = (string)pick($input, 'password', '');
    if ($rawPassword !== '') {
        $password = encrypt_secret($rawPassword);
    } else {
        $password = $existing['password'] ?? '';
    }

    return [
        'id'        => $existing['id'] ?? new_id(),
        'name'      => $name,
        'type'      => $type,
        'host'      => $host,
        'port'      => $port,
        'database'  => trim((string)pick($input, 'database', '')),
        'username'  => $username,
        'password'  => $password,
        'role'      => (string)pick($input, 'role', ''),
        // 明示的に false でない限り読み取り専用として扱う（安全側に倒す）
        'readOnly'  => pick($input, 'readOnly', true) !== false,
        'ssl'       => (bool)pick($input, 'ssl', false),
        'note'      => mb_substr((string)pick($input, 'note', ''), 0, 500),
        'createdAt' => $existing['createdAt'] ?? now_iso(),
        'updatedAt' => now_iso(),
    ];
}

function store_create(array $input): array
{
    $conn = normalize_conn($input);
    $all = store_all();
    $all[] = $conn;
    store_save($all);
    return conn_public($conn);
}

function store_update(string $id, array $input): array
{
    $all = store_all();
    foreach ($all as $i => $c) {
        if ($c['id'] !== $id) continue;
        $all[$i] = normalize_conn($input, $c);
        store_save($all);
        return conn_public($all[$i]);
    }
    throw bad('接続が見つかりません。', 404);
}

function store_remove(string $id): void
{
    $all = store_all();
    $after = array_values(array_filter($all, fn($c) => $c['id'] !== $id));
    if (count($after) === count($all)) throw bad('接続が見つかりません。', 404);
    store_save($after);
}
