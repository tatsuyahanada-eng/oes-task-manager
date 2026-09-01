<?php
/**
 * 共通の小道具。JSON の入出力とエラー処理。
 */

declare(strict_types=1);

/*
 * PHP 8.0 で入った関数を、7.4 でも使えるようにする。
 * レンタルサーバの PHP は 7.4 のことがあるため。
 */
if (!function_exists('str_starts_with')) {
    function str_starts_with(string $haystack, string $needle): bool
    {
        return $needle === '' || strncmp($haystack, $needle, strlen($needle)) === 0;
    }
}
if (!function_exists('str_contains')) {
    function str_contains(string $haystack, string $needle): bool
    {
        return $needle === '' || strpos($haystack, $needle) !== false;
    }
}
if (!function_exists('str_ends_with')) {
    function str_ends_with(string $haystack, string $needle): bool
    {
        return $needle === '' || substr($haystack, -strlen($needle)) === $needle;
    }
}

/** API のエラーを表す例外。HTTP のステータスを持つ。 */
class ApiError extends Exception
{
    public int $status;
    public function __construct(string $message, int $status = 400)
    {
        parent::__construct($message);
        $this->status = $status;
    }
}

function bad(string $message, int $status = 400): ApiError
{
    return new ApiError($message, $status);
}

/** JSON を返して終了する。 */
function json_out($data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=UTF-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/** リクエストの本文が JSON かどうか。CSV の取り込みでは JSON ではない。 */
function is_json_request(): bool
{
    $ct = strtolower((string)($_SERVER['CONTENT_TYPE'] ?? ''));
    return $ct === '' || str_contains($ct, 'json');
}

/** リクエストの JSON 本文を配列で受け取る。 */
function json_in(): array
{
    static $cached = null;
    if ($cached !== null) return $cached;

    $raw = raw_in();
    if ($raw === '') return $cached = [];

    $data = json_decode($raw, true);
    if (!is_array($data)) throw bad('リクエストの形式が正しくありません。');
    return $cached = $data;
}

/**
 * JSON 本文を、JSON でなければ空として受け取る。
 * CSV を本文に載せるエンドポイントと同じ経路を通るときに使う。
 */
function json_in_optional(): array
{
    if (!is_json_request()) return [];
    try { return json_in(); } catch (ApiError $e) { return []; }
}

/**
 * 本文の生データ（CSV の取り込みなどで使う）。
 * php://input は環境によって一度しか読めないため、読んだ内容を覚えておく。
 */
function raw_in(): string
{
    static $cached = null;
    if ($cached !== null) return $cached;
    $raw = file_get_contents('php://input');
    return $cached = ($raw === false ? '' : $raw);
}

/** 配列から値を取り出す。無ければ既定値。 */
function pick(array $a, string $key, $default = null)
{
    return array_key_exists($key, $a) ? $a[$key] : $default;
}

/**
 * 検索パネルの条件（JSON 文字列）を配列にする。
 * 壊れた JSON や配列でない値は「条件なし」として扱う。
 */
function request_filters(): array
{
    $raw = (string)($_GET['filters'] ?? '');
    if ($raw === '') return [];
    $v = json_decode($raw, true);
    return is_array($v) ? $v : [];
}

/** data/ ディレクトリの絶対パス。 */
function data_path(string $name = ''): string
{
    $dir = dirname(__DIR__) . '/data';
    if (!is_dir($dir)) {
        mkdir($dir, 0700, true);
    }
    return $name === '' ? $dir : $dir . '/' . $name;
}

/**
 * JSON ファイルを読む。壊れていたら null。
 */
function read_json(string $path): ?array
{
    if (!is_file($path)) return null;
    $raw = file_get_contents($path);
    if ($raw === false) return null;
    $data = json_decode($raw, true);
    return is_array($data) ? $data : null;
}

/**
 * JSON ファイルへ書く。
 * 途中で電源が落ちても壊れないよう、一時ファイルへ書いてから差し替える。
 */
function write_json(string $path, array $data): void
{
    $dir = dirname($path);
    if (!is_dir($dir)) mkdir($dir, 0700, true);

    $tmp = $path . '.tmp' . getmypid();
    $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($json === false) throw bad('保存する内容を JSON にできませんでした。', 500);

    if (file_put_contents($tmp, $json . "\n", LOCK_EX) === false) {
        throw bad('ファイルを保存できませんでした。書き込み権限を確認してください。', 500);
    }
    chmod($tmp, 0600);
    if (!rename($tmp, $path)) {
        @unlink($tmp);
        throw bad('ファイルを保存できませんでした。', 500);
    }
}

/** ランダムな ID。 */
function new_id(): string
{
    return bin2hex(random_bytes(16));
}

/** 現在時刻の ISO 8601 表記。 */
function now_iso(): string
{
    return gmdate('Y-m-d\TH:i:s\Z');
}

/** 接続元の IP。リバースプロキシ経由も考慮する。 */
function client_ip(): string
{
    foreach (['HTTP_X_FORWARDED_FOR', 'HTTP_X_REAL_IP'] as $h) {
        if (!empty($_SERVER[$h])) {
            $parts = explode(',', (string)$_SERVER[$h]);
            return trim($parts[0]);
        }
    }
    return (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown');
}

/** HTTPS 経由か。 */
function is_secure(): bool
{
    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') return true;
    $proto = (string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '');
    return strtolower(explode(',', $proto)[0]) === 'https';
}

/* ------------------------------------------------------------
 * アップロードの大きさ
 * ---------------------------------------------------------- */

/** php.ini の「8M」のような表記を、バイト数に直す。 */
function ini_bytes(string $key): int
{
    $v = trim((string)ini_get($key));
    if ($v === '' || $v === '-1') return 0;          // 0 は「上限なし」として扱う
    $unit = strtolower(substr($v, -1));
    $n = (int)$v;
    if ($unit === 'g') return $n * 1024 * 1024 * 1024;
    if ($unit === 'm') return $n * 1024 * 1024;
    if ($unit === 'k') return $n * 1024;
    return $n;
}

function bytes_label(int $bytes): string
{
    if ($bytes >= 1048576) return round($bytes / 1048576, 1) . ' MB';
    if ($bytes >= 1024) return round($bytes / 1024) . ' KB';
    return $bytes . ' B';
}

/**
 * 送られてきたファイルが、PHP の受け取り上限を超えていないか確かめる。
 *
 * 上限を超えると PHP は本文を丸ごと捨ててしまう。そのままでは
 * 「項目が空です」のような見当違いの案内になり、原因にたどり着けない。
 * ここで先に気づいて、どの設定をいくつにすればよいかまで伝える。
 */
function assert_upload_fits(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') return;

    $len  = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
    $post = ini_bytes('post_max_size');
    $up   = ini_bytes('upload_max_filesize');

    // 本文ごと捨てられた形（$_POST も $_FILES も空）
    if ($len > 0 && $post > 0 && $len > $post && !$_POST && !$_FILES) {
        throw bad(sprintf(
            'ファイルが大きすぎます（%s）。このサーバは一度に %s までしか受け取れません。' .
            "\n" . '.htaccess に次の 2 行を足すと増やせます（数字はお好みで）:' . "\n" .
            'php_value post_max_size 128M' . "\n" . 'php_value upload_max_filesize 128M',
            bytes_label($len), bytes_label($post)), 413);
    }

    // ファイル単位の上限に引っかかった形
    if (isset($_FILES['file']['error'])
        && (int)$_FILES['file']['error'] === UPLOAD_ERR_INI_SIZE) {
        throw bad(sprintf(
            'ファイルが大きすぎます。1 ファイルあたり %s までです。' .
            "\n" . '.htaccess に php_value upload_max_filesize 128M を足すと増やせます。',
            bytes_label($up)), 413);
    }
}

/**
 * CSV を PHP の配列に広げたとき、メモリが足りるかどうかを先に確かめる。
 *
 * 実測では、10 MB の CSV（10 万行 × 10 列）を配列にすると約 84 MB になる。
 * 目安として元の大きさの 9 倍を見ておく。
 *
 * 足りないまま進むと、PHP は途中で強制終了し、画面には何も出ない。
 * 先に気づいて、何 MB までなら扱えるかを伝える。
 */
function assert_csv_fits_memory(int $bytes): void
{
    $limit = ini_bytes('memory_limit');
    if ($limit <= 0) return;                 // 上限なし

    $needed = $bytes * 9;
    $free   = $limit - memory_get_usage(true);

    if ($needed > $free) {
        $canDo = max(0, (int)($free / 9));
        throw bad(sprintf(
            'このファイル（%s）を読み込むにはメモリが足りません。' .
            'いまの上限は %s で、扱えるのは %s ほどまでです。' . "\n" .
            'ファイルを分けて取り込むか、.htaccess に php_value memory_limit 512M を足してください。',
            bytes_label($bytes), bytes_label($limit), bytes_label($canDo)), 413);
    }
}
