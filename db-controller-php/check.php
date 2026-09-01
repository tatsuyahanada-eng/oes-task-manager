<?php
/**
 * DB Controller — 設置の自己診断
 *
 * HTTP 500 など、本体が動かないときに原因を切り分けるためのファイルです。
 * 本体のコードを一切読み込まないので、本体が壊れていても動きます。
 *
 * ※ このファイルは古い PHP でも読める書き方だけで書いてあります。
 *    新しい書き方を足さないでください。
 *
 * 使い方:
 *   1. 本体と同じフォルダに置く
 *   2. ブラウザで  .../check.php  を開く
 *   3. 確認が終わったら削除する
 */

header('Content-Type: text/html; charset=UTF-8');
header('X-Robots-Tag: noindex, nofollow');

// 版の情報。読めなければ古いファイルのまま。
$verFile = __DIR__ . '/lib/version.php';
if (file_exists($verFile)) { include_once $verFile; }

$rows = array();
function add($section, $label, $status, $detail) {
    global $rows;
    $rows[$section][] = array('label' => $label, 'status' => $status, 'detail' => $detail);
}

/* ---------------- 版の確認 ---------------- */

if (defined('DBC_VERSION')) {
    add('版', 'DB Controller', 'ok', DBC_VERSION . ' — 新しいファイルに入れ替わっています');
} else {
    add('版', 'DB Controller', 'ng',
        '<strong>古いファイルのままです。</strong>lib/version.php がありません。'
        . 'tar を展開して、フォルダ全体を上書きしてください。');
}

/* ---------------- PHP 本体 ---------------- */

$need = '7.4.0';
$verOk = version_compare(PHP_VERSION, $need, '>=');
add('PHP', 'バージョン', $verOk ? 'ok' : 'ng',
    PHP_VERSION . ($verOk ? '' : ' ← <strong>' . $need . ' 以上が必要です</strong>'));

if (!$verOk) {
    add('PHP', '直し方', 'ng',
        'ロリポップ: ユーザー専用ページ →「サーバーの管理・設定」→「PHP設定」→ '
        . 'このフォルダを選び、PHP 8.1 以上に変更して保存');
}

$exts = array(
    'pdo'       => '必須。DB への接続に使います',
    'pdo_mysql' => 'MySQL / MariaDB に接続する場合に必要',
    'pdo_pgsql' => 'PostgreSQL / Supabase に接続する場合に必要',
    'mbstring'  => '必須。日本語の文字コード変換に使います',
    'json'      => '必須',
    'openssl'   => '必須。接続パスワードの暗号化に使います',
    'zip'       => '一括バックアップ（ZIP）に使います',
);
foreach ($exts as $ext => $why) {
    $has = extension_loaded($ext);
    $required = in_array($ext, array('pdo', 'mbstring', 'json', 'openssl'));
    add('PHP 拡張', $ext, $has ? 'ok' : ($required ? 'ng' : 'warn'),
        ($has ? '利用できます' : 'ありません') . ' — ' . $why);
}

/* ---------------- アップロードの上限 ---------------- */
/*
 * CSV や DUMP はここを超えると受け取れません。
 * PHP は上限を超えた本文を丸ごと捨てるため、気づきにくい失敗になります。
 */
function dbc_ini_bytes($key) {
    $v = trim((string)ini_get($key));
    if ($v === '' || $v === '-1') return 0;
    $unit = strtolower(substr($v, -1));
    $n = (int)$v;
    if ($unit === 'g') return $n * 1024 * 1024 * 1024;
    if ($unit === 'm') return $n * 1024 * 1024;
    if ($unit === 'k') return $n * 1024;
    return $n;
}
$wanted = 32 * 1024 * 1024;   // これくらいは欲しい
foreach (array('post_max_size', 'upload_max_filesize') as $key) {
    $b = dbc_ini_bytes($key);
    $okSize = ($b === 0 || $b >= $wanted);
    add('アップロード', $key, $okSize ? 'ok' : 'warn',
        'いまの値: ' . ini_get($key) .
        ($okSize ? '' : ' — 大きな CSV / DUMP を扱うなら 128M 程度に増やしてください。' .
                        '.htaccess の php_value、または .user.ini で設定できます'));
}

/* ---------------- ファイルの配置 ---------------- */

$files = array(
    'index.php'        => '入口（3KB 程度。25KB なら古い版です）',
    'app.php'          => '本体',
    'lib/version.php'  => '版の情報',
    'lib/util.php'     => '共通処理',
    'lib/driver.php'   => 'DB ドライバ',
    'lib/dump_parse.php' => 'DUMP ファイルの読み取り',
    'public/index.html'=> '画面',
    'public/app.js'    => '画面の動作',
    'public/style.css' => '見た目',
    'public/theme.css' => '配色',
);
foreach ($files as $f => $why) {
    $p = __DIR__ . '/' . $f;
    add('ファイル', $f, file_exists($p) ? 'ok' : 'ng',
        (file_exists($p) ? number_format(filesize($p)) . ' バイト' : '<strong>ありません</strong>')
        . ' — ' . $why);
}

/* ---------------- 書き込み権限 ---------------- */

$dataDir = __DIR__ . '/data';
if (!is_dir($dataDir)) {
    $made = @mkdir($dataDir, 0700, true);
    add('data フォルダ', '存在', $made ? 'ok' : 'ng',
        $made ? '自動で作成しました' : '<strong>作れませんでした。FTP で data フォルダを作ってください</strong>');
} else {
    add('data フォルダ', '存在', 'ok', $dataDir);
}
if (is_dir($dataDir)) {
    $w = is_writable($dataDir);
    add('data フォルダ', '書き込み', $w ? 'ok' : 'ng',
        $w ? '書き込めます' : '<strong>書き込めません。FTP で権限を 700 か 705 にしてください</strong>');
    $perm = @substr(sprintf('%o', fileperms($dataDir)), -4);
    add('data フォルダ', '権限', 'info', $perm);
}

/* ---------------- サーバの状態 ---------------- */

add('サーバ', 'ソフトウェア', 'info', isset($_SERVER['SERVER_SOFTWARE']) ? $_SERVER['SERVER_SOFTWARE'] : '不明');
add('サーバ', 'このファイルの場所', 'info', __FILE__);
add('サーバ', 'ブラウザから見た場所', 'info', isset($_SERVER['SCRIPT_NAME']) ? $_SERVER['SCRIPT_NAME'] : '不明');

$rw = function_exists('apache_get_modules') ? in_array('mod_rewrite', apache_get_modules()) : null;
add('サーバ', 'mod_rewrite', $rw === null ? 'info' : ($rw ? 'ok' : 'warn'),
    $rw === null ? '判定できません（PHP が CGI/FastCGI で動いているため）'
                 : ($rw ? '有効です' : '<strong>無効です。.htaccess の書き換えが効きません</strong>'));

add('サーバ', 'HTTPS', (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'ok' : 'warn',
    (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        ? 'HTTPS で接続しています'
        : '<strong>HTTP で接続しています。パスワードが平文で流れます</strong>');

/* ---------------- 外部の DB サーバへ届くか ----------------
 *
 * このレンタルサーバから、別のサーバ（社内のデータサーバなど）の
 * DB へ TCP で届くかどうかだけを調べる。
 * 「ユーザー名やパスワードが違う」のか「そもそも届いていない」のかを
 * 切り分けるための欄。DB へはログインしないので、認証情報は要らない。
 */

$probeHost = isset($_GET['host']) ? trim($_GET['host']) : '';
$probePort = isset($_GET['port']) ? (int)$_GET['port'] : 0;

if ($probeHost !== '') {
    if (!preg_match('/^[A-Za-z0-9._\-]+$/', $probeHost)) {
        add('外部サーバへの到達', '入力', 'ng', 'ホスト名の形式が正しくありません。');
    } elseif ($probePort < 1 || $probePort > 65535) {
        add('外部サーバへの到達', '入力', 'ng', 'ポートは 1〜65535 で指定してください。');
    } else {
        $shown = htmlspecialchars($probeHost . ':' . $probePort, ENT_QUOTES, 'UTF-8');

        // 1. 名前が引けるか
        $ip = @gethostbyname($probeHost);
        if ($ip === $probeHost && !filter_var($probeHost, FILTER_VALIDATE_IP)) {
            add('外部サーバへの到達', '名前の解決', 'ng',
                '<strong>ホスト名を IP アドレスに変換できませんでした。</strong>'
                . '綴りを確認してください。社内だけの名前は、ここからは引けないことがあります。');
        } else {
            add('外部サーバへの到達', '名前の解決', 'ok',
                $shown . ' → ' . htmlspecialchars($ip, ENT_QUOTES, 'UTF-8'));

            // 2. その IP のポートまで届くか
            $t0 = microtime(true);
            $errno = 0; $errstr = '';
            $fp = @fsockopen($ip, $probePort, $errno, $errstr, 8);
            $ms = (int)round((microtime(true) - $t0) * 1000);

            if ($fp) {
                fclose($fp);
                add('外部サーバへの到達', 'ポートへの接続', 'ok',
                    '<strong>届きました</strong>（' . $ms . 'ms）。'
                    . 'あとは DB 側の利用者・パスワード・接続元の許可を確認してください。');
            } else {
                add('外部サーバへの到達', 'ポートへの接続', 'ng',
                    '<strong>届きませんでした</strong>（' . $ms . 'ms）。'
                    . htmlspecialchars($errstr . ' [' . $errno . ']', ENT_QUOTES, 'UTF-8')
                    . '<br>考えられる原因: このレンタルサーバが外への接続を塞いでいる / '
                    . '相手側のファイアウォールで止まっている / '
                    . 'DB が外部からの接続を受け付ける設定になっていない');
            }
        }
    }
}

/* ---------------- 結論 ---------------- */

$fatal = array();
foreach ($rows as $sec => $list) {
    foreach ($list as $r) { if ($r['status'] === 'ng') { $fatal[] = $sec . ' / ' . $r['label']; } }
}

if (count($fatal) === 0) {
    $verdict = array('ok', '設置に問題は見つかりませんでした',
        '本体を開いてください: <code>' . htmlspecialchars(rtrim(dirname($_SERVER['SCRIPT_NAME']), '/') . '/', ENT_QUOTES)
        . '</code><br>それでも 500 が出る場合は、<code>.htaccess</code> の名前を '
        . '<code>.htaccess-off</code> に変えて、もう一度試してください。');
} else {
    $verdict = array('ng', '次の項目を直す必要があります', implode('<br>', $fatal));
}
?><!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DB Controller — 設置の自己診断</title>
<style>
 body{font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;
      background:#0d0f14;color:#e6e6e6;margin:0;padding:24px 16px;line-height:1.7}
 .w{max-width:860px;margin:0 auto}
 h1{font-size:20px;margin:0 0 4px}
 .sub{color:#8a92a6;font-size:13px;margin-bottom:24px}
 h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#8a92a6;
    margin:26px 0 8px;border-bottom:1px solid #232734;padding-bottom:6px}
 table{width:100%;border-collapse:collapse;font-size:13.5px}
 td{padding:6px 8px;border-bottom:1px solid #1a1e28;vertical-align:top}
 td.l{width:210px;color:#c8cede}
 td.s{width:52px;text-align:center;font-weight:700;font-size:11px}
 .ok{color:#5fe3c0}.ng{color:#ff6b5e}.warn{color:#e3b341}.info{color:#4ea1ff}
 code{font-family:ui-monospace,monospace;background:#171b24;padding:1px 5px;border-radius:3px}
 .v{border:1px solid #232734;border-left:3px solid #4ea1ff;border-radius:7px;
    padding:14px 16px;margin:20px 0;background:#12151d}
 .v.ng{border-left-color:#ff6b5e}.v.ok{border-left-color:#5fe3c0}
 .v h3{margin:0 0 6px;font-size:15px}
 .d{border:1px solid #ff6b5e;border-radius:7px;padding:12px 16px;margin-top:26px;
    background:#1d1315;color:#ffb3ac;font-size:13.5px}
 .probe{border:1px solid #232734;border-radius:7px;padding:14px 16px;background:#12151d}
 .probe p{margin:0 0 12px;font-size:13.5px;color:#c3c9d8}
 .probe label{display:inline-block;margin:0 14px 8px 0;font-size:12.5px;color:#8a92a6}
 .probe input{display:block;margin-top:4px;padding:7px 9px;font-size:14px;
    background:#0d1117;color:#e9eef5;border:1px solid #38424f;border-radius:5px;min-width:230px}
 .probe input[type=number]{min-width:110px}
 .probe button{padding:8px 18px;font-size:14px;border-radius:5px;cursor:pointer;
    background:#1d4a7a;color:#fff;border:1px solid #2f6ea8}
 .probe .hint{margin:10px 0 0;font-size:12px;color:#8a92a6}
</style></head><body><div class="w">
<h1>DB Controller — 設置の自己診断</h1>
<div class="sub">本体のコードは読み込んでいません。本体が壊れていてもこのページは出ます。</div>

<div class="v <?php echo $verdict[0]; ?>">
  <h3><?php echo $verdict[1]; ?></h3>
  <div><?php echo $verdict[2]; ?></div>
</div>

<?php foreach ($rows as $section => $list): ?>
  <h2><?php echo htmlspecialchars($section, ENT_QUOTES); ?></h2>
  <table><?php foreach ($list as $r):
    $mark = array('ok'=>'OK','ng'=>'NG','warn'=>'注意','info'=>'—'); ?>
    <tr><td class="s <?php echo $r['status']; ?>"><?php echo $mark[$r['status']]; ?></td>
        <td class="l"><?php echo htmlspecialchars($r['label'], ENT_QUOTES); ?></td>
        <td><?php echo $r['detail']; ?></td></tr>
  <?php endforeach; ?></table>
<?php endforeach; ?>

<h2>外部の DB サーバへ届くか調べる</h2>
<form method="get" class="probe">
  <p>
    このサーバから、別の DB サーバ（社内のデータサーバなど）へ
    <strong>届くかどうかだけ</strong>を調べます。DB へはログインしないので、
    ユーザー名やパスワードは要りません。
  </p>
  <label>ホスト
    <input type="text" name="host" placeholder="db.example.local または 192.168.1.20"
           value="<?php echo htmlspecialchars($probeHost, ENT_QUOTES, 'UTF-8'); ?>">
  </label>
  <label>ポート
    <input type="number" name="port" min="1" max="65535" placeholder="3306"
           value="<?php echo $probePort > 0 ? (int)$probePort : ''; ?>">
  </label>
  <button type="submit">調べる</button>
  <p class="hint">MySQL は 3306、PostgreSQL は 5432 が既定です。</p>
</form>

<div class="d"><strong>確認が終わったら、このファイルを削除してください。</strong><br>
サーバの構成が外から見える状態になります。</div>
</div></body></html>
