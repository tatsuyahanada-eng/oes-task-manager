<?php
/**
 * DB Controller (PHP 版) — 入口。
 *
 * このファイルだけは、古い PHP でも「読める」ように書いてあります。
 * 本体 (app.php) は PHP 7.4 以上の書き方を使っているため、
 * 古い PHP では読み込んだ瞬間に画面が真っ白（HTTP 500）になります。
 * そうならないよう、先にバージョンを確かめて、原因を日本語で表示します。
 *
 * ※ このファイルに新しい書き方（match / アロー関数 / 型付きプロパティなど）を
 *    足さないでください。足すと、この案内自体が表示できなくなります。
 */

require __DIR__ . '/lib/version.php';

$need = DBC_MIN_PHP;

if (version_compare(PHP_VERSION, $need, '<')) {
    header('Content-Type: text/html; charset=UTF-8');
    http_response_code(500);
    echo '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">'
       . '<meta name="viewport" content="width=device-width,initial-scale=1">'
       . '<title>DB Controller — PHP のバージョン</title>'
       . '<style>body{font-family:system-ui,sans-serif;background:#0d1117;color:#e9eef5;'
       . 'margin:0;padding:40px 20px;line-height:1.8}.w{max-width:680px;margin:0 auto}'
       . 'h1{font-size:20px;margin:0 0 20px}code{background:#1a212b;padding:2px 6px;'
       . 'border-radius:4px;font-family:ui-monospace,monospace;color:#5fe3c0}'
       . '.b{border:1px solid #262e3a;border-left:3px solid #e3b341;border-radius:7px;'
       . 'padding:14px 16px;margin:18px 0;background:#12151d}ol{padding-left:22px}</style>'
       . '</head><body><div class="w">'
       . '<h1>PHP のバージョンが古いため動作できません</h1>'
       . '<div class="b">いま動いている PHP: <code>' . htmlspecialchars(PHP_VERSION, ENT_QUOTES)
       . '</code><br>必要なバージョン: <code>' . htmlspecialchars($need, ENT_QUOTES) . '</code> 以上</div>'
       . '<p><strong>ロリポップでの直し方</strong></p><ol>'
       . '<li>ユーザー専用ページにログイン</li>'
       . '<li>「サーバーの管理・設定」→「PHP設定」</li>'
       . '<li>このツールを置いたフォルダを選ぶ</li>'
       . '<li>PHP のバージョンを <code>8.1</code> 以上（推奨は最新）に変更して保存</li>'
       . '<li>数分待ってから、このページを再読み込み</li></ol>'
       . '<p>他社のサーバでも、管理画面に同じような「PHP バージョン切替」があります。</p>'
       . '</div></body></html>';
    exit;
}

$missing = array();
foreach (array('pdo', 'mbstring', 'json', 'openssl') as $ext) {
    if (!extension_loaded($ext)) { $missing[] = $ext; }
}
if (count($missing) > 0) {
    header('Content-Type: text/plain; charset=UTF-8');
    http_response_code(500);
    echo "DB Controller を動かすのに必要な PHP 拡張がありません:\n\n";
    foreach ($missing as $m) { echo "  - " . $m . "\n"; }
    echo "\nサーバの PHP 設定を確認してください。\n";
    echo "（pdo_mysql か pdo_pgsql のどちらかも必要です）\n";
    exit;
}

require __DIR__ . '/app.php';
