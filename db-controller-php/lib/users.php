<?php
/**
 * 利用者と役割。
 *
 * ログインパスワードは元に戻す必要が無いので、ハッシュ化して保存する。
 * PHP の password_hash は既定で bcrypt（環境によっては argon2）を使い、
 * 塩の付与と検証を任せられる。Node 版の scrypt と方式は違うが、
 * 「平文を保存しない・検証は定数時間」という性質は同じ。
 */

declare(strict_types=1);

const DBC_DEFAULT_USER = 'welsysadm';
const DBC_DEFAULT_PASS = 'Welsys@1234';

/** 役割。上にあるものほど強い。 */
function roles(): array
{
    return [
        'admin'    => ['label' => '管理者', 'rank' => 3,
                       'description' => '利用者の管理、接続先の登録・変更・削除、データの参照と変更'],
        'operator' => ['label' => '運用者', 'rank' => 2,
                       'description' => '接続先を使ったデータの参照と変更。接続先の登録内容は変更できない'],
        'viewer'   => ['label' => '閲覧者', 'rank' => 1,
                       'description' => '参照と CSV 書き出しのみ。データは変更できない'],
    ];
}

function is_role(string $role): bool { return isset(roles()[$role]); }
function rank_of(?string $role): int { return roles()[$role]['rank'] ?? 0; }

/** $user の役割が $required 以上か。 */
function has_role(?array $user, string $required): bool
{
    return $user !== null && rank_of($user['role'] ?? null) >= rank_of($required);
}

function users_file(): string { return data_path('auth.json'); }

/** 利用者一覧を読む。無ければ管理者を 1 人作る。 */
function users_load(): array
{
    $db = read_json(users_file());
    if ($db !== null && isset($db['users']) && is_array($db['users'])) return $db;

    $username = (string)(getenv('DBC_AUTH_USER') ?: DBC_DEFAULT_USER);
    $password = (string)(getenv('DBC_AUTH_PASS') ?: DBC_DEFAULT_PASS);

    $user = new_user($username, $password, 'admin');
    $user['isDefaultPassword'] = !getenv('DBC_AUTH_PASS') && $password === DBC_DEFAULT_PASS;

    $db = ['version' => 1, 'users' => [$user]];
    write_json(users_file(), $db);
    return $db;
}

function users_save(array $db): void { write_json(users_file(), $db); }

function new_user(string $username, string $password, string $role): array
{
    return [
        'username'          => $username,
        'hash'              => password_hash($password, PASSWORD_DEFAULT),
        'role'              => $role,
        'disabled'          => false,
        'isDefaultPassword' => $password === DBC_DEFAULT_PASS,
        'createdAt'         => now_iso(),
        'updatedAt'         => now_iso(),
        'lastLoginAt'       => null,
    ];
}

/** 名前で 1 人引く。大文字小文字は区別しない。 */
function users_find(string $username): ?array
{
    foreach (users_load()['users'] as $u) {
        if (strcasecmp($u['username'], $username) === 0) return $u;
    }
    return null;
}

/** 画面へ返してよい形。ハッシュは絶対に出さない。 */
function user_public(array $u): array
{
    return [
        'username'          => $u['username'],
        'role'              => $u['role'],
        'roleLabel'         => roles()[$u['role']]['label'] ?? $u['role'],
        'disabled'          => (bool)($u['disabled'] ?? false),
        'isDefaultPassword' => (bool)($u['isDefaultPassword'] ?? false),
        'createdAt'         => $u['createdAt'] ?? null,
        'updatedAt'         => $u['updatedAt'] ?? null,
        'lastLoginAt'       => $u['lastLoginAt'] ?? null,
    ];
}

function users_list(): array
{
    return array_map('user_public', users_load()['users']);
}

/** 初期パスワードのままの利用者がいるか。 */
function any_default_password(): bool
{
    foreach (users_load()['users'] as $u) {
        if (!empty($u['isDefaultPassword']) && empty($u['disabled'])) return true;
    }
    return false;
}

function admin_count(array $users): int
{
    $n = 0;
    foreach ($users as $u) {
        if (($u['role'] ?? '') === 'admin' && empty($u['disabled'])) $n++;
    }
    return $n;
}

/* ------------------------------------------------------------
 * 入力の検査
 * ---------------------------------------------------------- */

function check_password(string $password): array
{
    $problems = [];
    if (mb_strlen($password) < 10) $problems[] = 'パスワードは 10 文字以上にしてください。';
    if (!preg_match('/[a-z]/', $password) || !preg_match('/[A-Z]/', $password)) {
        $problems[] = '英大文字と小文字を両方含めてください。';
    }
    if (!preg_match('/[0-9]/', $password)) $problems[] = '数字を含めてください。';
    if ($password === DBC_DEFAULT_PASS) $problems[] = '初期パスワードは使えません。';
    return $problems;
}

function check_username(string $username): ?string
{
    $u = trim($username);
    if (mb_strlen($u) < 3 || mb_strlen($u) > 32) return 'ユーザー名は 3〜32 文字にしてください。';
    if (!preg_match('/^[A-Za-z0-9._-]+$/', $u)) return 'ユーザー名に使えるのは英数字と . _ - です。';
    return null;
}

/* ------------------------------------------------------------
 * 変更
 * ---------------------------------------------------------- */

function users_create(string $username, string $password, string $role): array
{
    if ($problem = check_username($username)) throw bad($problem);
    if (!is_role($role)) throw bad('役割の指定が正しくありません。');
    if ($problems = check_password($password)) throw bad(implode(' ', $problems));

    $db = users_load();
    $name = trim($username);
    foreach ($db['users'] as $u) {
        if (strcasecmp($u['username'], $name) === 0) throw bad('そのユーザー名は既に使われています。');
    }

    $user = new_user($name, $password, $role);
    $db['users'][] = $user;
    users_save($db);
    return user_public($user);
}

/** 役割の変更と、利用停止 / 再開。 */
function users_update(string $username, ?string $role, ?bool $disabled): array
{
    $db = users_load();
    $idx = null;
    foreach ($db['users'] as $i => $u) {
        if (strcasecmp($u['username'], $username) === 0) { $idx = $i; break; }
    }
    if ($idx === null) throw bad('その利用者は見つかりません。', 404);

    $next = $db['users'][$idx];
    if ($role !== null) {
        if (!is_role($role)) throw bad('役割の指定が正しくありません。');
        $next['role'] = $role;
    }
    if ($disabled !== null) $next['disabled'] = $disabled;

    $after = $db['users'];
    $after[$idx] = $next;
    if (admin_count($after) === 0) throw bad('管理者が 0 人になる変更はできません。');

    $next['updatedAt'] = now_iso();
    $after[$idx] = $next;
    $db['users'] = $after;
    users_save($db);
    return user_public($next);
}

function users_remove(string $username): void
{
    $db = users_load();
    $after = [];
    $found = false;
    foreach ($db['users'] as $u) {
        if (strcasecmp($u['username'], $username) === 0) { $found = true; continue; }
        $after[] = $u;
    }
    if (!$found) throw bad('その利用者は見つかりません。', 404);
    if (count($after) === 0) throw bad('最後の利用者は削除できません。');
    if (admin_count($after) === 0) throw bad('管理者が 0 人になる削除はできません。');

    $db['users'] = $after;
    users_save($db);
}

/** 本人によるパスワード変更。現在のパスワードの確認が要る。 */
function users_change_password(string $username, string $current, string $new): void
{
    $db = users_load();
    foreach ($db['users'] as $i => $u) {
        if (strcasecmp($u['username'], $username) !== 0) continue;

        if (!password_verify($current, $u['hash'])) throw bad('現在のパスワードが違います。');
        if ($problems = check_password($new)) throw bad(implode(' ', $problems));

        $db['users'][$i]['hash'] = password_hash($new, PASSWORD_DEFAULT);
        $db['users'][$i]['isDefaultPassword'] = false;
        $db['users'][$i]['updatedAt'] = now_iso();
        users_save($db);
        return;
    }
    throw bad('その利用者は見つかりません。', 404);
}

/** 管理者による再設定。本人のパスワードを知らなくてよい。 */
function users_reset_password(string $username, string $new): void
{
    $db = users_load();
    foreach ($db['users'] as $i => $u) {
        if (strcasecmp($u['username'], $username) !== 0) continue;

        if ($problems = check_password($new)) throw bad(implode(' ', $problems));
        $db['users'][$i]['hash'] = password_hash($new, PASSWORD_DEFAULT);
        $db['users'][$i]['isDefaultPassword'] = false;
        $db['users'][$i]['updatedAt'] = now_iso();
        users_save($db);
        return;
    }
    throw bad('その利用者は見つかりません。', 404);
}

/**
 * 初期パスワードでの復旧。
 *
 * $username のパスワードを、現在の値に関わらず初期パスワードへ強制的に戻す。
 * 「今のパスワードを忘れた／分からなくなった」ときに、初期パスワードさえ
 * 分かっていれば管理者アカウントへ入り直せるようにするための仕組み。
 * 呼び出し側で「対象は既定の管理者アカウントだけ」であることを確認してから使うこと。
 */
function users_recover_default(string $username): void
{
    $db = users_load();
    foreach ($db['users'] as $i => $u) {
        if (strcasecmp($u['username'], $username) !== 0) continue;

        $db['users'][$i]['hash']              = password_hash(DBC_DEFAULT_PASS, PASSWORD_DEFAULT);
        $db['users'][$i]['isDefaultPassword']  = true;
        $db['users'][$i]['updatedAt']          = now_iso();
        users_save($db);
        return;
    }
    throw bad('その利用者は見つかりません。', 404);
}

function users_mark_login(string $username): void
{
    $db = users_load();
    foreach ($db['users'] as $i => $u) {
        if (strcasecmp($u['username'], $username) !== 0) continue;
        $db['users'][$i]['lastLoginAt'] = now_iso();
        users_save($db);
        return;
    }
}
