<?php
/**
 * ログインとセッション。
 *
 * Node 版と違い、PHP はリクエストごとにプロセスが終わるため、
 * セッションはファイルに保存される（PHP 標準のセッション機構を使う）。
 *
 * 方針:
 *   - Cookie は httpOnly / SameSite=Strict。HTTPS なら Secure も付ける
 *   - 無操作が続いたセッションと、発行から時間が経ったセッションは無効にする
 *   - ログイン失敗が続く相手は一定時間受け付けない（総当たり対策）
 *   - 役割の変更・利用停止は、保存内容を毎回引き直すことで即座に効かせる
 */

declare(strict_types=1);

const DBC_COOKIE = 'dbc_session';

function idle_ms(): int   { return (int)(getenv('DBC_SESSION_IDLE_MS') ?: 30 * 60 * 1000); }
function absolute_ms(): int { return (int)(getenv('DBC_SESSION_MAX_MS') ?: 12 * 60 * 60 * 1000); }
function max_attempts(): int { return (int)(getenv('DBC_LOGIN_MAX_ATTEMPTS') ?: 5); }
function lock_ms(): int      { return (int)(getenv('DBC_LOGIN_LOCK_MS') ?: 15 * 60 * 1000); }

/** セッションを開始する。まだ開いていなければ。 */
function session_begin(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) return;

    // セッションファイルを data/ の下に置き、他の利用者と混ざらないようにする
    $dir = data_path('sessions');
    if (!is_dir($dir)) mkdir($dir, 0700, true);
    session_save_path($dir);

    session_name(DBC_COOKIE);
    session_set_cookie_params([
        'lifetime' => (int)(absolute_ms() / 1000),
        'path'     => '/',
        'httponly' => true,
        'samesite' => 'Strict',
        'secure'   => is_secure(),
    ]);
    session_start();
}

/**
 * ログイン中の利用者を返す。ログインしていなければ null。
 *
 * 保存された利用者情報を毎回引き直すので、
 * 管理者が役割を変えたり利用停止にしたりすると、その場で効く。
 */
/**
 * いまのセッションが作られた時刻（ミリ秒）。
 *
 * current_user() はセッションの鍵を早めに返すため、そのあと $_SESSION は空になる。
 * ログイン時刻を後から使いたい箇所のために、閉じる前にここへ控えておく。
 */
function session_created_at(?int $set = null): int
{
    static $v = 0;
    if ($set !== null) $v = $set;
    return $v;
}

function current_user(): ?array
{
    session_begin();

    if (empty($_SESSION['username']) || empty($_SESSION['createdAt'])) {
        session_write_close();
        return null;
    }

    $now = (int)(microtime(true) * 1000);
    $idle = $now - (int)($_SESSION['lastSeen'] ?? 0);
    $age  = $now - (int)$_SESSION['createdAt'];

    if ($idle > idle_ms() || $age > absolute_ms()) {
        session_destroy_now();
        return null;
    }

    $_SESSION['lastSeen'] = $now;
    $username = (string)$_SESSION['username'];
    session_created_at((int)$_SESSION['createdAt']);

    // ここから先は $_SESSION を触らないので、書き戻して鍵を返す。
    //
    // PHP はセッションを開いている間、そのファイルを排他ロックし続ける。
    // 返さないと、同じ利用者からの 2 本目以降のリクエストが 1 本目の
    // 終了を待つことになり、画面の起動が要求の本数だけ遅くなる。
    session_write_close();

    $user = users_find($username);
    if ($user === null || !empty($user['disabled'])) {
        session_destroy_now();
        return null;
    }

    return $user;
}

function session_destroy_now(): void
{
    session_begin();
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', [
            'expires'  => time() - 42000,
            'path'     => $p['path'],
            'httponly' => true,
            'samesite' => 'Strict',
            'secure'   => is_secure(),
        ]);
    }
    @session_destroy();
}

/* ------------------------------------------------------------
 * 総当たり対策
 * ---------------------------------------------------------- */

function attempts_file(): string { return data_path('attempts.json'); }

/** 待たされている残り秒数。待たされていなければ null。 */
function check_lock(string $ip): ?int
{
    $all = read_json(attempts_file()) ?? [];
    $a = $all[$ip] ?? null;
    if ($a === null) return null;

    $now = (int)(microtime(true) * 1000);
    if (!empty($a['lockedUntil']) && $now < $a['lockedUntil']) {
        return (int)ceil(($a['lockedUntil'] - $now) / 1000);
    }
    return null;
}

/** 失敗を 1 回数える。あと何回試せるかを返す。 */
function record_failure(string $ip): int
{
    $all = read_json(attempts_file()) ?? [];
    $now = (int)(microtime(true) * 1000);
    $a = $all[$ip] ?? ['count' => 0, 'firstAt' => $now];

    // 一定時間が空いたら数え直す
    if ($now - $a['firstAt'] > lock_ms()) { $a['count'] = 0; $a['firstAt'] = $now; }
    $a['count']++;
    if ($a['count'] >= max_attempts()) $a['lockedUntil'] = $now + lock_ms();

    $all[$ip] = $a;
    $all = prune_attempts($all, $now);
    write_json(attempts_file(), $all);

    return max(max_attempts() - $a['count'], 0);
}

function clear_failures(string $ip): void
{
    $all = read_json(attempts_file()) ?? [];
    unset($all[$ip]);
    write_json(attempts_file(), $all);
}

/** 古い記録を捨てる。放っておくとファイルが太り続けるため。 */
function prune_attempts(array $all, int $now): array
{
    $out = [];
    foreach ($all as $ip => $a) {
        $fresh = ($now - ($a['firstAt'] ?? 0)) < lock_ms() * 4;
        $locked = !empty($a['lockedUntil']) && $now < $a['lockedUntil'];
        if ($fresh || $locked) $out[$ip] = $a;
    }
    return $out;
}

/* ------------------------------------------------------------
 * ログイン
 * ---------------------------------------------------------- */

function do_login(string $username, string $password): array
{
    $ip = client_ip();

    if (($wait = check_lock($ip)) !== null) {
        throw bad(sprintf(
            'ログインの試行が続いたため、しばらく受け付けません。あと %d 分お待ちください。',
            (int)ceil($wait / 60)
        ), 429);
    }

    $user = (strlen($username) < 200) ? users_find($username) : null;

    // 初期パスワードでの復旧。
    // 既定の管理者アカウント宛てに、初期パスワードそのものが送られてきたときは、
    // 今のパスワードが何であれ初期パスワードへ強制的に戻してから通す。
    // 「パスワードを忘れた」ときの唯一の入り直し口のため、対象は既定アカウント名に限る。
    if ($user !== null
        && strcasecmp($user['username'], DBC_DEFAULT_USER) === 0
        && empty($user['disabled'])
        && $password === DBC_DEFAULT_PASS) {
        users_recover_default($user['username']);
        audit(['action' => 'password-recover', 'user' => $user['username'], 'connection' => '-',
               'target' => $user['username'],
               'sql' => '初期パスワードでの復旧（今のパスワードを初期値へ強制的に戻しました） / ' . $ip]);
        $user = users_find($user['username']);
        $verified = true;
    } elseif ($user === null) {
        // 利用者が居なくても同じだけ計算し、応答時間から存在を推測されないようにする
        password_verify($password, '$2y$10$usesomesillystringforsalting.ForTimingOnly000000000000');
        $verified = false;
    } else {
        $verified = strlen($password) < 500 && password_verify($password, $user['hash']);
    }

    // ユーザー名とパスワードのどちらが違うかは伝えない
    if ($user === null || !empty($user['disabled']) || !$verified) {
        $remaining = record_failure($ip);
        throw bad($remaining > 0
            ? "ユーザー名またはパスワードが違います。（あと {$remaining} 回）"
            : 'ログインの試行が続いたため、しばらく受け付けません。', 401);
    }

    clear_failures($ip);
    users_mark_login($user['username']);

    session_begin();
    // セッション固定攻撃を防ぐため、ログインのたびに ID を作り直す
    session_regenerate_id(true);
    $now = (int)(microtime(true) * 1000);
    $_SESSION['username']  = $user['username'];
    $_SESSION['createdAt'] = $now;
    $_SESSION['lastSeen']  = $now;
    $_SESSION['ip']        = $ip;

    return [
        'username'          => $user['username'],
        'role'              => $user['role'],
        'isDefaultPassword' => (bool)($user['isDefaultPassword'] ?? false),
    ];
}

/* ------------------------------------------------------------
 * 権限の確認
 * ---------------------------------------------------------- */

/** ログインしていなければ 401 で止める。 */
function require_login(): array
{
    $user = current_user();
    if ($user === null) {
        json_out(['error' => 'ログインが必要です。', 'needLogin' => true], 401);
    }
    return $user;
}

/** 役割が足りなければ 403 で止める。 */
function require_role(string $required): array
{
    $user = require_login();
    if (!has_role($user, $required)) {
        $label = roles()[$required]['label'] ?? $required;
        json_out(['error' => "この操作には「{$label}」以上の権限が必要です。"], 403);
    }
    return $user;
}
