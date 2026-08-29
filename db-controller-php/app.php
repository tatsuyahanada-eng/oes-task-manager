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
require __DIR__ . '/lib/driver.php';
require __DIR__ . '/lib/driver_mysql.php';
require __DIR__ . '/lib/driver_pgsql.php';
require __DIR__ . '/lib/write.php';
require __DIR__ . '/lib/csv.php';
require __DIR__ . '/lib/csv_routes.php';
require __DIR__ . '/lib/schema_infer.php';
require __DIR__ . '/lib/csv_trial.php';
require __DIR__ . '/lib/theme.php';

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

// mod_rewrite が使えないサーバでは、
//   https://例.com/dbc/index.php/api/health
// のように index.php を挟んだ URL でも動くようにする。
// 画面側は「いまいる場所からの相対」で API を呼ぶので、
// ここで /index.php を取り除けば、両方の形が同じ経路に乗る。
if (str_starts_with($path, '/index.php')) {
    $path = substr($path, strlen('/index.php'));
    $path = '/' . ltrim($path, '/');
}

/* ------------------------------------------------------------
 * 静的ファイル
 * ---------------------------------------------------------- */

$PUBLIC_FILES = [
    '/login.html', '/style.css', '/theme.css', '/logo.svg', '/manifest.webmanifest', '/sw.js',
    '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
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
    if ($area === 'theme') {
        // 読むのは全員。変えられるのは管理者だけ。
        if ($method === 'GET') {
            require_login();
            json_out(theme_public());
        }
        if ($method === 'PUT') {
            $me = require_role('admin');
            $saved = theme_save(json_in());
            audit(['action' => 'theme', 'user' => $me['username'], 'connection' => '-',
                   'target' => '-', 'sql' => '配色・文言を変更']);
            json_out(['ok' => true, 'applied' => $saved]);
        }
        if ($method === 'DELETE') {
            $me = require_role('admin');
            theme_reset();
            audit(['action' => 'theme', 'user' => $me['username'], 'connection' => '-',
                   'target' => '-', 'sql' => '配色・文言を既定へ戻す']);
            json_out(['ok' => true, 'applied' => ['tokens' => [], 'sizes' => [], 'labels' => []]]);
        }
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
            'loginAt'            => gmdate('Y-m-d\TH:i:s\Z', (int)(session_created_at() / 1000)),
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
        $drivers = DbDriver::catalog();
        foreach ($drivers as &$d) $d['guide'] = DbDriver::guide($d['id']);
        unset($d);
        json_out(['drivers' => $drivers]);
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
        $type = (string)pick($in, 'type', '');
        $meta = DbDriver::meta($type);
        if ($meta === null) json_out(['error' => '対応していない DB 種別です。'], 400);
        // パスワード欄が空のときは「変更しない」という意味なので、
        // 既存の接続を編集中なら保存済みのパスワードを使う。
        // ここで拾わないと、パスワードなしで接続を試みて
        // 「認証失敗」という誤った結果を返してしまう。
        $password = (string)pick($in, 'password', '');
        $id = (string)pick($in, 'id', '');
        if ($password === '' && $id !== '') {
            $saved = store_runtime($id);
            if ($saved !== null) $password = (string)$saved['password'];
        }

        $conn = [
            'type' => $type,
            'host' => (string)pick($in, 'host', ''),
            'port' => (int)pick($in, 'port', 0) ?: $meta['defaultPort'],
            'username' => (string)pick($in, 'username', ''),
            'password' => $password,
            'database' => (string)pick($in, 'database', ''),
            'ssl' => (bool)pick($in, 'ssl', false),
        ];
        $started = microtime(true);
        $info = DbDriver::open($conn)->serverInfo();
        json_out(['ok' => true, 'elapsedMs' => (int)((microtime(true) - $started) * 1000),
                  'info' => $info]);
    }

    if ($head !== '' && ($seg[1] ?? '') === 'test' && $method === 'POST') {
        require_login();
        $conn = store_runtime($head);
        if ($conn === null) json_out(['error' => '接続が見つかりません。'], 404);
        $in = json_in();
        $started = microtime(true);
        $info = DbDriver::open($conn, (string)pick($in, 'database', ''))->serverInfo();
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

    // CSV の取り込みでは本文が JSON ではないので、JSON として読めるときだけ見る
    $database = (string)($_GET['database'] ?? pick(json_in_optional(), 'database', ''));
    $rest = array_slice($seg, 1);
    $head = $rest[0] ?? '';

    if ($head === 'info' && $method === 'GET') {
        json_out(['info' => DbDriver::open($conn, $database)->serverInfo()]);
    }

    if ($head === 'databases' && $method === 'GET') {
        json_out(['databases' => DbDriver::open($conn, $database)->listDatabases()]);
    }

    if ($head === 'schemas' && $method === 'GET') {
        json_out(['schemas' => DbDriver::open($conn, $database)->listSchemas()]);
    }

    if ($head === 'tables' && count($rest) === 1 && $method === 'GET') {
        $drv = DbDriver::open($conn, $database);
        $schema = $drv->assertIdentifier((string)($_GET['schema'] ?? ''), 'スキーマ名');
        json_out(['tables' => $drv->listTables($schema),
                  'schema' => $schema, 'database' => $database]);
    }

    if ($head === 'query' && $method === 'POST') {
        $in = json_in();
        $limit = min((int)pick($in, 'limit', 200), 1000);
        json_out(DbDriver::open($conn, $database)
            ->runQuery((string)pick($in, 'sql', ''), $limit));
    }

    if ($head === 'audit' && $method === 'GET') {
        json_out(['entries' => audit_recent(min((int)($_GET['limit'] ?? 100), 1000))]);
    }

    if ($head === 'export' && ($rest[1] ?? '') === 'schema-info' && $method === 'GET') {
        $drv = DbDriver::open($conn, $database);
        $schema = $drv->assertIdentifier((string)($_GET['schema'] ?? ''), 'スキーマ名');
        json_out(csv_schema_info($drv, $schema));
    }

    // スキーマ全体を ZIP で書き出す
    if ($head === 'export' && ($rest[1] ?? '') === 'schema.zip' && $method === 'GET') {
        $drv = DbDriver::open($conn, $database);
        $schema = $drv->assertIdentifier((string)($_GET['schema'] ?? ''), 'スキーマ名');
        $enc = (string)($_GET['encoding'] ?? 'utf-8');
        $dl  = ($_GET['delimiter'] ?? '') === 'tab' ? "\t" : (string)($_GET['delimiter'] ?? ',');
        audit([
            'action' => 'export', 'user' => $user['username'],
            'connection' => $conn['name'], 'type' => $conn['type'],
            'database' => $database, 'target' => $schema,
            'sql' => "スキーマ一括書き出し (文字コード: {$enc})",
        ]);
        csv_export_schema($drv, $schema, $enc, $dl);
    }

    if ($head === 'csv' && ($rest[1] ?? '') === 'options' && $method === 'GET') {
        json_out(['encodings' => csv_encodings(),
                  'delimiters' => [
                      ['id' => ',',   'label' => 'カンマ (,)'],
                      ['id' => 'tab', 'label' => 'タブ'],
                      ['id' => ';',   'label' => 'セミコロン (;)'],
                  ]]);
    }

    /* ---- CSV 取り込み ---- */
    if ($head === 'import' && in_array($rest[1] ?? '', ['preview', 'execute'], true)
        && $method === 'POST') {
        if (!has_role($user, 'operator')) {
            json_out(['error' => 'この操作には「運用者」以上の権限が必要です。'], 403);
        }

        $drv = DbDriver::open($conn, $database);
        $schema = $drv->assertIdentifier((string)($_GET['schema'] ?? ''), 'スキーマ名');
        $table  = $drv->assertIdentifier((string)($_GET['table'] ?? ''), 'テーブル名');
        $opts = [
            'encoding'  => (string)($_GET['encoding'] ?? ''),
            'delimiter' => ($_GET['delimiter'] ?? '') === 'tab' ? "\t" : (string)($_GET['delimiter'] ?? ''),
            // 画面の「空欄は NULL として取り込む」。既定は NULL。
            'emptyAsNull' => ($_GET['emptyAsNull'] ?? 'true') !== 'false',
        ];
        $bytes = raw_in();
        if ($bytes === '') json_out(['error' => 'CSV が空です。'], 400);

        if ($rest[1] === 'preview') {
            // 下見は DB を変更しないので、読み取り専用の接続でも通す
            json_out(csv_preview($drv, $schema, $table, $bytes, $opts));
        }

        assert_writable($conn);
        $result = csv_import($drv, $schema, $table, $bytes, $opts);
        audit([
            'action' => 'import', 'user' => $user['username'],
            'connection' => $conn['name'], 'type' => $conn['type'],
            'database' => $database, 'target' => "{$schema}.{$table}",
            'affected' => $result['inserted'],
            'sql' => 'CSV 取り込み (' . implode(', ', $result['columns']) . ')',
        ]);
        json_out(['ok' => true] + $result);
    }

    /* ---- CSV からテーブル構成を読み取る（DB は変更しない）---- */
    if ($head === 'infer' && $method === 'POST') {
        $bytes = raw_in();
        if ($bytes === '') json_out(['error' => 'CSV が空です。'], 400);

        $plan = csv_infer_schema($bytes, [
            'encoding'  => (string)($_GET['encoding'] ?? ''),
            'delimiter' => ($_GET['delimiter'] ?? '') === 'tab' ? "\t" : (string)($_GET['delimiter'] ?? ''),
            'filename'  => (string)($_GET['filename'] ?? ''),
        ]);

        // 読み取った構成から、その DB での CREATE 文を組み立てて見せる。
        // 型名は DB ごとに違うので、ここで初めて確定する。
        $drv = DbDriver::open($conn, $database);
        $schema = (string)($_GET['schema'] ?? '');
        $plan['schema'] = $schema;
        if ($schema !== '' && $plan['tableName'] !== '') {
            $cols = $drv->assertColumnPlan($plan['columns']);
            $plan['sql'] = $drv->buildCreateTable(
                $schema, $plan['tableName'], $cols,
                $plan['addSurrogateKey'] ? $plan['surrogateKeyName'] : ''
            );
            $plan['exists'] = $drv->tableExists($schema, $plan['tableName']);
        }
        // 型名を画面にも出せるよう、区分ごとの表記を添える
        foreach ($plan['columns'] as $i => $c) {
            $plan['columns'][$i]['sqlType'] = $drv->sqlType($c);
        }
        json_out($plan);
    }

    /* ---- お試し取り込み ----
     *
     * 一時テーブルに入れて試すだけ。本番のテーブルには一切触れないので、
     * 読み取り専用の接続でも通す（一時テーブルは接続が切れれば消える）。
     *
     * mode=plan     … CSV から読み取った構成で、新しく作る想定を試す
     * mode=existing … 既にあるテーブルと同じ構造を写して試す
     */
    if ($head === 'trial-import' && $method === 'POST') {
        // 列の指定は数が多いと URL に載りきらないので、multipart でも受け取れるようにする。
        // multipart のときは plan（JSON）と file（CSV）の 2 つに分けて送る。
        $form = [];
        if (isset($_POST['plan'])) {
            $decoded = json_decode((string)$_POST['plan'], true);
            if (is_array($decoded)) $form = $decoded;
        }
        $param = function (string $key, $default = '') use ($form) {
            return array_key_exists($key, $form) ? $form[$key] : ($_GET[$key] ?? $default);
        };

        $drv = DbDriver::open($conn, $database);
        $schema = $drv->assertIdentifier((string)$param('schema'), 'スキーマ名');
        $mode = (string)$param('mode', 'plan');
        $delimiter = (string)$param('delimiter');
        $opts = [
            'encoding'    => (string)$param('encoding'),
            'delimiter'   => $delimiter === 'tab' ? "\t" : $delimiter,
            'emptyAsNull' => $param('emptyAsNull', 'true') !== 'false' && $param('emptyAsNull', 'true') !== false,
        ];

        $bytes = (isset($_FILES['file']) && is_uploaded_file((string)$_FILES['file']['tmp_name']))
            ? (string)file_get_contents((string)$_FILES['file']['tmp_name'])
            : raw_in();
        if ($bytes === '') json_out(['error' => 'CSV が空です。'], 400);

        $temp = csv_trial_table_name();

        if ($mode === 'existing') {
            $table = $drv->assertIdentifier((string)$param('table'), 'テーブル名');
            $detail = $drv->describeTable($schema, $table);
            if ($detail['type'] !== 'TABLE') json_out(['error' => 'ビューには取り込めません。'], 400);
            $createSql = $drv->createTrialTableLike($schema, $table, $temp);
            $columns = array_map(fn($c) => [
                'name' => $c['name'], 'nullable' => $c['nullable'], 'dataType' => $c['dataType'],
            ], $detail['columns']);
            $target = "{$schema}.{$table}";
        } else {
            $planned = $param('columns');
            if (is_string($planned)) $planned = json_decode($planned, true);
            if (!is_array($planned)) json_out(['error' => '列の指定がありません。'], 400);
            $cols = $drv->assertColumnPlan($planned);
            $sk = trim((string)$param('surrogateKey'));
            $createSql = $drv->createTrialTable($schema, $temp, $cols, $sk);
            $columns = array_map(fn($c) => [
                'name' => $c['name'], 'nullable' => $c['nullable'],
                'dataType' => $drv->sqlType($c),
            ], $cols);
            $target = (string)$param('table', '(新しいテーブル)');
        }

        $result = csv_trial_import($drv, $temp, $columns, $bytes, $opts);
        // 記録は残すが、本番は変えていないことが分かる書き方にする
        audit([
            'action' => 'trial-import', 'user' => $user['username'],
            'connection' => $conn['name'], 'type' => $conn['type'],
            'database' => $database, 'target' => $target,
            'affected' => $result['inserted'],
            'sql' => 'お試し取り込み（一時テーブル。本番は変更していません）',
        ]);
        json_out(['mode' => $mode, 'target' => $target, 'createSql' => $createSql] + $result);
    }

    /* ---- 作る前の下見。SQL を組み立てるだけで DB は変更しない ---- */
    if ($head === 'create-table' && ($rest[1] ?? '') === 'preview' && $method === 'POST') {
        $in = json_in();
        $drv = DbDriver::open($conn, $database);
        $schema = $drv->assertIdentifier((string)pick($in, 'schema', ''), 'スキーマ名');
        $table  = $drv->assertIdentifier((string)pick($in, 'table', ''), 'テーブル名');
        $cols   = $drv->assertColumnPlan((array)pick($in, 'columns', []));
        $sk     = trim((string)pick($in, 'surrogateKey', ''));

        json_out([
            'sql'    => $drv->buildCreateTable($schema, $table, $cols, $sk),
            'exists' => $drv->tableExists($schema, $table),
            'columns'=> count($cols),
        ]);
    }

    /* ---- 読み取った構成でテーブルを作る ---- */
    if ($head === 'create-table' && count($rest) === 1 && $method === 'POST') {
        if (!has_role($user, 'operator')) {
            json_out(['error' => 'この操作には「運用者」以上の権限が必要です。'], 403);
        }
        assert_writable($conn);

        $in = json_in();
        $drv = DbDriver::open($conn, $database);
        $schema = $drv->assertIdentifier((string)pick($in, 'schema', ''), 'スキーマ名');
        $table  = $drv->assertIdentifier((string)pick($in, 'table', ''), 'テーブル名');
        $cols   = $drv->assertColumnPlan((array)pick($in, 'columns', []));
        $sk     = trim((string)pick($in, 'surrogateKey', ''));

        $sql = $drv->createTable($schema, $table, $cols, $sk);
        audit([
            'action' => 'create-table', 'user' => $user['username'],
            'connection' => $conn['name'], 'type' => $conn['type'],
            'database' => $database, 'target' => "{$schema}.{$table}",
            'sql' => $sql,
        ]);
        json_out(['ok' => true, 'schema' => $schema, 'table' => $table,
                  'columns' => count($cols), 'sql' => $sql]);
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
        $drv = DbDriver::open($conn, $database);
        $schema = $drv->assertIdentifier(urldecode($rest[1]), 'スキーマ名');
        $table  = $drv->assertIdentifier(urldecode($rest[2]), 'テーブル名');
        $tail   = $rest[3] ?? '';

        if ($tail === '' && $method === 'GET') {
            // 画面は入れ子ではなく、直下に展開された形を読む
            json_out(array_merge(
                ['database' => $database],
                $drv->describeTable($schema, $table)
            ));
        }

        if ($tail === 'count' && $method === 'GET') {
            $where = $drv->combineWhere((string)($_GET['where'] ?? ''), request_filters());
            json_out(['schema' => $schema, 'table' => $table,
                      'count' => $drv->countRows($schema, $table, $where, true)]);
        }

        // CSV 書き出し
        if ($tail === 'export.csv' && $method === 'GET') {
            $enc = (string)($_GET['encoding'] ?? 'utf-8');
            $dl  = ($_GET['delimiter'] ?? '') === 'tab' ? "\t" : (string)($_GET['delimiter'] ?? ',');
            $where = $drv->combineWhere((string)($_GET['where'] ?? ''), request_filters());
            audit([
                'action' => 'export', 'user' => $user['username'],
                'connection' => $conn['name'], 'type' => $conn['type'],
                'database' => $database, 'target' => "{$schema}.{$table}",
                'sql' => "CSV 書き出し (文字コード: {$enc})",
            ]);
            csv_export($drv, $schema, $table, $where, $enc, $dl, true);
        }

        if ($tail === 'rows' && $method === 'GET') {
            $where = $drv->combineWhere((string)($_GET['where'] ?? ''), request_filters());
            json_out(array_merge(
                ['schema' => $schema, 'table' => $table, 'database' => $database],
                $drv->selectRows($schema, $table,
                    $where,
                    (string)($_GET['orderBy'] ?? ''),
                    (string)($_GET['orderDir'] ?? 'ASC'),
                    (int)($_GET['limit'] ?? 50),
                    (int)($_GET['offset'] ?? 0),
                    true)
            ));
        }

        /* ---- ここから更新系 ---- */

        if ($tail === 'rows' && in_array($method, ['POST', 'PATCH', 'DELETE'], true)) {
            // 0. 役割 → 1. 接続の読み取り専用、の順に確かめる
            if (!has_role($user, 'operator')) {
                json_out(['error' => 'この操作には「運用者」以上の権限が必要です。'], 403);
            }
            assert_writable($conn);

            $in = json_in();
            $detail = $drv->describeTable($schema, $table);

            if ($detail['type'] !== 'TABLE') {
                json_out(['error' => 'ビューは変更できません。'], 400);
            }

            if ($method === 'POST') {
                $result = insert_row($drv, $schema, $table, (array)pick($in, 'fields', []));
                $action = 'insert';
            } elseif ($method === 'PATCH') {
                $key = assert_row_key($detail, (array)pick($in, 'key', []));
                $result = update_row($drv, $schema, $table, $key, (array)pick($in, 'fields', []));
                $action = 'update';
            } else {
                $key = assert_row_key($detail, (array)pick($in, 'key', []));
                $result = delete_row($drv, $schema, $table, $key);
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
