<?php
/**
 * 接続パスワードの暗号化。
 *
 * 保存するのは接続先 DB のパスワードで、これは「元に戻せる」必要がある
 * （実際に DB へ渡すため）。したがってハッシュ化ではなく暗号化を使う。
 * 利用者のログインパスワードとは扱いが違う（あちらは scrypt でハッシュ化）。
 *
 * 方式: AES-256-GCM。改ざんされていれば復号が失敗する。
 */

declare(strict_types=1);

const DBC_CIPHER = 'aes-256-gcm';

/**
 * 暗号鍵を用意する。
 * 環境変数 DBC_MASTER_KEY があればそれを、無ければ data/.masterkey を作る。
 */
function master_key(): string
{
    static $key = null;
    if ($key !== null) return $key;

    $env = getenv('DBC_MASTER_KEY');
    if (is_string($env) && $env !== '') {
        $bin = @hex2bin(trim($env));
        if ($bin === false || strlen($bin) !== 32) {
            throw bad('DBC_MASTER_KEY は 64 文字の 16 進数で指定してください。', 500);
        }
        return $key = $bin;
    }

    $file = data_path('.masterkey');
    if (is_file($file)) {
        $hex = trim((string)file_get_contents($file));
        $bin = @hex2bin($hex);
        if ($bin !== false && strlen($bin) === 32) return $key = $bin;
        throw bad('data/.masterkey が壊れています。', 500);
    }

    $bin = random_bytes(32);
    if (file_put_contents($file, bin2hex($bin) . "\n", LOCK_EX) === false) {
        throw bad('暗号鍵を保存できませんでした。data/ の書き込み権限を確認してください。', 500);
    }
    chmod($file, 0600);
    return $key = $bin;
}

/** 平文を暗号化して、保存できる 1 つの文字列にする。 */
function encrypt_secret(string $plain): string
{
    if ($plain === '') return '';
    $iv = random_bytes(12);
    $tag = '';
    $cipher = openssl_encrypt($plain, DBC_CIPHER, master_key(), OPENSSL_RAW_DATA, $iv, $tag);
    if ($cipher === false) throw bad('暗号化に失敗しました。', 500);

    // v1:IV:認証タグ:本体
    return 'v1:' . bin2hex($iv) . ':' . bin2hex($tag) . ':' . bin2hex($cipher);
}

/** encrypt_secret で作った文字列を元に戻す。 */
function decrypt_secret(string $stored): string
{
    if ($stored === '') return '';

    $parts = explode(':', $stored);
    if (count($parts) !== 4 || $parts[0] !== 'v1') {
        throw bad('保存されたパスワードの形式が不正です。接続を登録し直してください。', 500);
    }

    $iv = @hex2bin($parts[1]);
    $tag = @hex2bin($parts[2]);
    $body = @hex2bin($parts[3]);
    if ($iv === false || $tag === false || $body === false) {
        throw bad('保存されたパスワードが壊れています。接続を登録し直してください。', 500);
    }

    $plain = openssl_decrypt($body, DBC_CIPHER, master_key(), OPENSSL_RAW_DATA, $iv, $tag);
    if ($plain === false) {
        // 鍵が変わったか、内容が書き換えられたとき
        throw bad('パスワードを復号できませんでした。暗号鍵が変わっていないか確認してください。', 500);
    }
    return $plain;
}
