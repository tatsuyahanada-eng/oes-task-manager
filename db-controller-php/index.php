<?php
/**
 * DB Controller (PHP 版) — 入口。
 *
 * レンタルサーバの中で動き、同じサーバの MySQL を直接見る。
 * Node.js も常駐プロセスも要らず、トンネルも要らない。
 *
 * すべてのリクエストが .htaccess でこのファイルへ集まる。
 */

declare(strict_types=1);

require __DIR__ . '/lib/util.php';
require __DIR__ . '/lib/crypto.php';
require __DIR__ . '/lib/users.php';
require __DIR__ . '/lib/session.php';
require __DIR__ . '/lib/store.php';
require __DIR__ . '/lib/audit.php';
require __DIR__ . '/lib/driver_mysql.php';
require __DIR__ . '/lib/write.php';

mb_internal_encoding('UTF-8');

// 最低限のセキュリティヘッダー
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: same-origin');
header('Permissions-Policy: geolocation=(), microphone=(), camera=()');

/* ------------------------------------------------------------
 * 経路の切り出し
 * ---------------------------------------------------------- */

$method = (string)($_SERVER['REQUEST_METHOD'] ?? 'GET');
$uri    = (string)($_SERVER['REQUEST_URI'] ?? '/');
$path   = parse_url($uri, PHP_URL_PATH) ?: '/';

// サブディレクトリに置かれても動くよう、自分の位置を差し引く
$base = rtrim(str_replace('\\', '/', dirname((string)$_SERVER['SCRIPT_NAME'])), '/');
if ($base !== '' && str_starts_with($path, $base)) {
    $path = substr($path, strlen($base));
}
$path = '/' . ltrim($path, '/');

/* ------------------------------------------------------------
 * 静的ファイル
 * ---------------------------------------------------------- */

$PUBLIC_FILES = [
    '/login.html', '/style.css', '/logo.svg', '/manifest.webmanifest', '/sw.js',
    '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
];

if (!str_starts_with($path, '/api/')) {
    serve_static($path, $PUBLIC_FILES);
    exit;
}

/* ------------------------------------------------------------
 * API
 * ---------------------------------------------------------- */

try {
    route_api($method, $path);
    json_out(['error' => "見つかりません: {$method} {$path}"], 404);
} catch (ApiError $e) {
    json_out(['error' => $e->getMessage()], $e->status);
} catch (Throwable $e) {
    error_log('[dbc] ' . $e->getMessage());
    json_out(['error' => 'サーバーエラーが発生しました。'], 500);
}

/* ============================================================
 * 静的ファイルの配信
 * ========================================================== */

function serve_static(string $path, array $publicFiles): void
{
    if ($path === '/' || $path === '/index.html') {
        // ログインしていなければログイン画面へ送る
        if (current_user() === null) {
            header('Location: login.html', true, 302);
            exit;
        }
        $path = '/index.html';
    } elseif (!in_array($path, $publicFiles, true)) {
        if (current_user() === null) {
            header('Location: login.html', true, 302);
            exit;
        }
    }

    $file = realpath(__DIR__ . '/public' . $path);
    $root = realpath(__DIR__ . '/public');

    // public/ の外へ出ようとする経路を弾く
    if ($file === false || $root === false || !str_starts_with($file, $root) || !is_file($file)) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=UTF-8');
        echo '見つかりません';
        exit;
    }

    $types = [
        'html' => 'text/html; charset=UTF-8',
        'css'  => 'text/css; charset=UTF-8',
        'js'   => 'application/javascript; charset=UTF-8',
        'svg'  => 'image/svg+xml',
        'png'  => 'image/png',
        'webmanifest' => 'application/manifest+json; charset=UTF-8',
    ];
    $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    header('Content-Type: ' . ($types[$ext] ?? 'application/octet-stream'));

    if ($ext === 'html') {
        header('Cache-Control: no-store');       // 画面は端末に残さない
    } elseif (basename($file) === 'sw.js') {
        header('Cache-Control: no-cache');       // 更新が反映されなくなるのを防ぐ
    }

    readfile($file);
    exit;
}

/* ============================================================
 * API の振り分け
 * ========================================================== */

function route_api(string $method, string $path): void
{
    $seg = array_values(array_filter(explode('/', $path), fn($s) => $s !== ''));
    // $seg[0] は必ず 'api'
    $area = $seg[1] ?? '';

    if ($area === 'health') {
        json_out(['ok' => true, 'app' => 'DB Controller (PHP)', 'php' => PHP_VERSION]);
    }
    if ($area === 'auth')        { route_auth($method, array_slice($seg, 2)); }
    if ($area === 'connections') { route_connections($method, array_slice($seg, 2)); }
    if ($area === 'db')          { route_db($method, array_slice($seg, 2)); }
}

/* ---------------- ログインと利用者 ---------------- */

function route_auth(string $method, array $seg): void
{
    $head = $seg[0] ?? '';

    if ($head === 'login' && $method === 'POST') {
        $in = json_in();
        $result = do_login((string)pick($in, 'username', ''), (string)pick($in, 'password', ''));
        audit(['action' => 'login', 'user' => $result['username'], 'connection' => '-',
               'target' => $result['username'],
               'sql' => "ログイン ({$result['role']} / " . client_ip() . ')']);
        json_out(array_merge(['ok' => true], $result));
    }

    if ($head === 'logout' && $method === 'POST') {
        $user = current_user();
        if ($user) {
            audit(['action' => 'logout', 'user' => $user['username'], 'connection' => '-',
                   'target' => $user['username'], 'sql' => 'ログアウト']);
        }
        session_destroy_now();
        json_out(['ok' => true]);
    }

    if ($head === 'me' && $method === 'GET') {
        $user = current_user();
        if ($user === null) json_out(['error' => 'ログインしていません。', 'needLogin' => true], 401);
        json_out([
            'username'           => $user['username'],
            'role'               => $user['role'],
            'roleLabel'          => roles()[$user['role']]['label'] ?? $user['role'],
            'canManageUsers'     => has_role($user, 'admin'),
            'canWrite'           => has_role($user, 'operator'),
            'isDefaultPassword'  => (bool)($user['isDefaultPassword'] ?? false),
            'loginAt'            => gmdate('Y-m-d\TH:i:s\Z', (int)($_SESSION['createdAt'] / 1000)),
            'idleTimeoutMinutes' => (int)(idle_ms() / 60000),
        ]);
    }

    if ($head === 'password' && $method === 'POST') {
        $user = require_login();
        $in = json_in();
        users_change_password($user['username'],
            (string)pick($in, 'currentPassword', ''), (string)pick($in, 'newPassword', ''));
        audit(['action' => 'password', 'user' => $user['username'], 'connection' => '-',
               'target' => $user['username'], 'sql' => 'パスワード変更（本人のセッションを無効化）']);
        session_destroy_now();
        json_out(['ok' => true, 'message' => 'パスワードを変更しました。もう一度ログインしてください。']);
    }

    if ($head === 'roles' && $method === 'GET') {
        require_login();
        $out = [];
        foreach (roles() as $id => $r) {
            $out[] = ['id' => $id, 'label' => $r['label'], 'rank' => $r['rank'],
                      'description' => $r['description']];
        }
        json_out(['roles' => $out]);
    }

    if ($head === 'audit' && $method === 'GET') {
        require_role('admin');
        $limit = min((int)($_GET['limit'] ?? 200), 1000);
        json_out(['entries' => audit_recent($limit)]);
    }

    if ($head === 'users') {
        $me = require_role('admin');
        $target = $seg[1] ?? '';

        if ($target === '' && $method === 'GET')  json_out(['users' => users_list()]);

        if ($target === '' && $method === 'POST') {
            $in = json_in();
            $created = users_create((string)pick($in, 'username', ''),
                                    (string)pick($in, 'password', ''),
                                    (string)pick($in, 'role', ''));
            audit(['action' => 'user-create', 'user' => $me['username'], 'connection' => '-',
                   'target' => $created['username'], 'sql' => "利用者を追加 (役割: {$created['role']})"]);
            json_out(['ok' => true, 'user' => $created]);
        }

        if ($target !== '' && ($seg[2] ?? '') === 'password' && $method === 'POST') {
            $in = json_in();
            users_reset_password($target, (string)pick($in, 'newPassword', ''));
            audit(['action' => 'user-password', 'user' => $me['username'], 'connection' => '-',
                   'target' => $target, 'sql' => '管理者がパスワードを再設定']);
            json_out(['ok' => true, 'message' => "{$target} のパスワードを再設定しました。"]);
        }

        if ($target !== '' && $method === 'PUT') {
            $in = json_in();
            $role = array_key_exists('role', $in) ? (string)$in['role'] : null;
            $disabled = array_key_exists('disabled', $in) ? (bool)$in['disabled'] : null;

            // 自分の権限を落として管理者が居なくなる事故を防ぐ
            if (strcasecmp($target, $me['username']) === 0) {
                if ($role !== null && $role !== 'admin') {
                    json_out(['error' => '自分自身の役割は下げられません。別の管理者に依頼してください。'], 400);
                }
                if ($disabled === true) {
                    json_out(['error' => '自分自身を利用停止にはできません。'], 400);
                }
            }

            $updated = users_update($target, $role, $disabled);
            audit(['action' => 'user-update', 'user' => $me['username'], 'connection' => '-',
                   'target' => $updated['username'],
                   'sql' => "利用者を変更 (役割: {$updated['role']} / 停止: "
                            . ($updated['disabled'] ? 'true' : 'false') . ')']);
            json_out(['ok' => true, 'user' => $updated]);
        }

        if ($target !== '' && $method === 'DELETE') {
            if (strcasecmp($target, $me['username']) === 0) {
                json_out(['error' => '自分自身は削除できません。'], 400);
            }
            users_remove($target);
            audit(['action' => 'user-delete', 'user' => $me['username'], 'connection' => '-',
                   'target' => $target, 'sql' => '利用者を削除']);
            json_out(['ok' => true]);
        }
    }
}

/* ---------------- 接続先の管理 ---------------- */

function route_connections(string $method, array $seg): void
{
    $head = $seg[0] ?? '';

    if ($head === 'drivers' && $method === 'GET') {
        require_login();
        json_out(['drivers' => array_values(drivers())]);
    }

    if ($head === '' && $method === 'GET') {
        require_login();
        json_out(['connections' => store_list(), 'sessions' => []]);
    }

    if ($head === '' && $method === 'POST') {
        $me = require_role('admin');
        $created = store_create(json_in());
        audit(['action' => 'conn-create', 'user' => $me['username'],
               'connection' => $created['name'],
               'target' => "{$created['type']} {$created['host']}:{$created['port']}",
               'sql' => '接続先を追加 (読み取り専用: '
                        . ($created['readOnly'] ? 'true' : 'false') . ')']);
        json_out(['connection' => $created], 201);
    }

    // 未保存のフォーム内容での接続テスト
    if ($head === 'test' && $method === 'POST') {
        require_role('admin');
        $in = json_in();
        $conn = [
            'host' => (string)pick($in, 'host', ''), 'port' => (int)pick($in, 'port', 3306),
            'username' => (string)pick($in, 'username', ''),
            'password' => (string)pick($in, 'password', ''),
            'database' => (string)pick($in, 'database', ''),
            'ssl' => (bool)pick($in, 'ssl', false),
        ];
        $started = microtime(true);
        $info = db_server_info(db_connect($conn));
        json_out(['ok' => true, 'elapsedMs' => (int)((microtime(true) - $started) * 1000),
                  'info' => $info]);
    }

    if ($head !== '' && ($seg[1] ?? '') === 'test' && $method === 'POST') {
        require_login();
        $conn = store_runtime($head);
        if ($conn === null) json_out(['error' => '接続が見つかりません。'], 404);
        $in = json_in();
        $started = microtime(true);
        $info = db_server_info(db_connect($conn, (string)pick($in, 'database', '')));
        json_out(['ok' => true, 'elapsedMs' => (int)((microtime(true) - $started) * 1000),
                  'info' => $info]);
    }

    if ($head !== '' && ($seg[1] ?? '') === 'disconnect' && $method === 'POST') {
        require_login();
        // PHP はリクエストごとに接続が閉じるので、保持している接続は無い
        json_out(['ok' => true]);
    }

    if ($head !== '' && $method === 'GET') {
        require_login();
        $c = store_get($head);
        if ($c === null) json_out(['error' => '接続が見つかりません。'], 404);
        json_out(['connection' => conn_public($c)]);
    }

    if ($head !== '' && $method === 'PUT') {
        $me = require_role('admin');
        $updated = store_update($head, json_in());
        audit(['action' => 'conn-update', 'user' => $me['username'],
               'connection' => $updated['name'],
               'target' => "{$updated['type']} {$updated['host']}:{$updated['port']}",
               'sql' => '接続先を変更 (読み取り専用: '
                        . ($updated['readOnly'] ? 'true' : 'false') . ')']);
        json_out(['connection' => $updated]);
    }

    if ($head !== '' && $method === 'DELETE') {
        $me = require_role('admin');
        $c = store_get($head);
        store_remove($head);
        audit(['action' => 'conn-delete', 'user' => $me['username'],
               'connection' => $c['name'] ?? $head, 'target' => '-', 'sql' => '接続先を削除']);
        json_out(['ok' => true]);
    }
}

/* ---------------- データの参照と変更 ---------------- */

function route_db(string $method, array $seg): void
{
    $connectionId = $seg[0] ?? '';
    if ($connectionId === '') return;

    $user = require_login();
    $conn = store_runtime($connectionId);
    if ($conn === null) json_out(['error' => '接続が見つかりません。'], 404);

    $database = (string)($_GET['database'] ?? pick(json_in(), 'database', ''));
    $rest = array_slice($seg, 1);
    $head = $rest[0] ?? '';

    if ($head === 'info' && $method === 'GET') {
        json_out(['info' => db_server_info(db_connect($conn, $database))]);
    }

    if ($head === 'databases' && $method === 'GET') {
        json_out(['databases' => db_list_databases(db_connect($conn, $database))]);
    }

    if ($head === 'schemas' && $method === 'GET') {
        json_out(['schemas' => db_list_schemas(db_connect($conn, $database))]);
    }

    if ($head === 'tables' && count($rest) === 1 && $method === 'GET') {
        $schema = assert_identifier((string)($_GET['schema'] ?? ''), 'スキーマ名');
        json_out(['tables' => db_list_tables(db_connect($conn, $database), $schema),
                  'schema' => $schema, 'database' => $database]);
    }

    if ($head === 'query' && $method === 'POST') {
        $in = json_in();
        $limit = min((int)pick($in, 'limit', 200), 1000);
        json_out(db_run_query(db_connect($conn, $database), (string)pick($in, 'sql', ''), $limit));
    }

    if ($head === 'audit' && $method === 'GET') {
        json_out(['entries' => audit_recent(min((int)($_GET['limit'] ?? 100), 1000))]);
    }

    // 自由入力の更新系 SQL。PHP 版では意図的に用意していない。
    // 権限の確認は通常どおり行い、権限のある人にだけ理由を返す。
    if ($head === 'execute' && $method === 'POST') {
        if (!has_role($user, 'operator')) {
            json_out(['error' => 'この操作には「運用者」以上の権限が必要です。'], 403);
        }
        assert_writable($conn);
        json_out(['error' =>
            'PHP 版では、更新系 SQL の自由入力に対応していません。' .
            '行の追加・修正・削除は画面から行ってください。' .
            '（参照系の SQL は CUI の \\query から実行できます）'], 501);
    }

    // /tables/:schema/:table...
    if ($head === 'tables' && count($rest) >= 3) {
        $schema = assert_identifier(urldecode($rest[1]), 'スキーマ名');
        $table  = assert_identifier(urldecode($rest[2]), 'テーブル名');
        $tail   = $rest[3] ?? '';

        if ($tail === '' && $method === 'GET') {
            // 画面は入れ子ではなく、直下に展開された形を読む
            json_out(array_merge(
                ['schema' => $schema, 'table' => $table, 'database' => $database],
                db_describe_table(db_connect($conn, $database), $schema, $table)
            ));
        }

        if ($tail === 'count' && $method === 'GET') {
            $where = (string)($_GET['where'] ?? '');
            json_out(['schema' => $schema, 'table' => $table,
                      'count' => db_count_rows(db_connect($conn, $database), $schema, $table, $where)]);
        }

        if ($tail === 'rows' && $method === 'GET') {
            json_out(array_merge(
                ['schema' => $schema, 'table' => $table, 'database' => $database],
                db_select_rows(
                db_connect($conn, $database), $schema, $table,
                (string)($_GET['where'] ?? ''),
                (string)($_GET['orderBy'] ?? ''),
                (string)($_GET['orderDir'] ?? 'ASC'),
                (int)($_GET['limit'] ?? 50),
                (int)($_GET['offset'] ?? 0)
            )));
        }

        /* ---- ここから更新系 ---- */

        if ($tail === 'rows' && in_array($method, ['POST', 'PATCH', 'DELETE'], true)) {
            // 0. 役割 → 1. 接続の読み取り専用、の順に確かめる
            if (!has_role($user, 'operator')) {
                json_out(['error' => 'この操作には「運用者」以上の権限が必要です。'], 403);
            }
            assert_writable($conn);

            $in = json_in();
            $pdo = db_connect($conn, $database);
            $detail = db_describe_table($pdo, $schema, $table);

            if ($detail['type'] !== 'TABLE') {
                json_out(['error' => 'ビューは変更できません。'], 400);
            }

            if ($method === 'POST') {
                $result = insert_row($pdo, $schema, $table, (array)pick($in, 'fields', []));
                $action = 'insert';
            } elseif ($method === 'PATCH') {
                $key = assert_row_key($detail, (array)pick($in, 'key', []));
                $result = update_row($pdo, $schema, $table, $key, (array)pick($in, 'fields', []));
                $action = 'update';
            } else {
                $key = assert_row_key($detail, (array)pick($in, 'key', []));
                $result = delete_row($pdo, $schema, $table, $key);
                $action = 'delete';
            }

            audit([
                'action' => $action, 'user' => $user['username'],
                'connection' => $conn['name'], 'type' => $conn['type'],
                'database' => $database, 'target' => "{$schema}.{$table}",
                'affected' => $result['affected'], 'sql' => $result['sql'],
            ]);
            json_out(['ok' => true, 'affected' => $result['affected'], 'sql' => $result['sql']]);
        }
    }
}
