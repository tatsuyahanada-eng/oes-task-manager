<?php
/**
 * DB Controller — レンタルサーバ側の下見スクリプト
 *
 * ロリポップなど、PHP は動くが Node.js は動かないサーバで、
 * 「何ができて、何ができないか」を 1 回のアップロードで確かめるためのもの。
 *
 * このスクリプトは【参照しかしません】。
 * CREATE / INSERT / UPDATE / DELETE は一切実行しません。
 *
 * ------------------------------------------------------------------
 * 使い方
 *   1. 下の CONFIG を書き換える（パスワードは必ず変える）
 *   2. public_html/ の中の、推測されにくい名前のフォルダに置く
 *   3. ブラウザで開く  例: https://example.com/xxxx/dbc-check.php?key=（合言葉）
 *   4. 結果を確認したら【必ずサーバから削除する】
 * ------------------------------------------------------------------
 */

// ===================== CONFIG（ここだけ書き換える）=====================

$CONFIG = [
    // このページを開くための合言葉。長くて推測されないものにしてください。
    // URL の ?key= に付けます。
    'access_key' => 'CHANGE-ME-to-a-long-random-string',

    // ロリポップ管理画面「サーバーの管理・設定 → データベース」の値
    'host'     => 'mysqlXXX.phy.lolipop.lan',
    'port'     => 3306,
    'database' => 'LAAxxxxxxx-yourdb',
    'username' => 'LAAxxxxxxx',
    'password' => '',
];

// =====================================================================

header('Content-Type: text/html; charset=UTF-8');
header('X-Robots-Tag: noindex, nofollow');
header('X-Content-Type-Options: nosniff');

// --- 合言葉の確認 -----------------------------------------------------
$given = isset($_GET['key']) ? (string)$_GET['key'] : '';
if ($CONFIG['access_key'] === 'CHANGE-ME-to-a-long-random-string') {
    http_response_code(500);
    exit('先に $CONFIG[\'access_key\'] を書き換えてください。');
}
// 文字列比較の時間差から合言葉を推測されないようにする
if (!hash_equals($CONFIG['access_key'], $given)) {
    http_response_code(404);
    exit('Not Found');
}

$results = [];
function add($section, $label, $status, $detail = '') {
    global $results;
    $results[$section][] = ['label' => $label, 'status' => $status, 'detail' => $detail];
}

/* ==================================================================
 * 1. PHP 側の環境
 * ================================================================== */

add('環境', 'PHP のバージョン', version_compare(PHP_VERSION, '7.4', '>=') ? 'ok' : 'warn', PHP_VERSION);
add('環境', 'mysqli 拡張', extension_loaded('mysqli') ? 'ok' : 'ng',
    extension_loaded('mysqli') ? '利用できます' : 'ありません。PDO を使う必要があります');
add('環境', 'pdo_mysql 拡張', extension_loaded('pdo_mysql') ? 'ok' : 'warn',
    extension_loaded('pdo_mysql') ? '利用できます' : 'ありません');
add('環境', 'OpenSSL 拡張', extension_loaded('openssl') ? 'ok' : 'warn',
    extension_loaded('openssl') ? 'HTTPS 通信・署名に使えます' : 'ありません');
add('環境', 'サーバ software', 'info', $_SERVER['SERVER_SOFTWARE'] ?? '不明');
add('環境', 'このファイルの場所', 'info', __FILE__);
add('環境', 'メモリ上限', 'info', ini_get('memory_limit'));
add('環境', '実行時間の上限', 'info', ini_get('max_execution_time') . ' 秒');

// Node.js が動くか（動けば話が早いので、いちおう見る）
$node = @shell_exec('node -v 2>/dev/null');
add('環境', 'Node.js', $node ? 'ok' : 'ng',
    $node ? ('あります: ' . trim($node) . '（ただし常駐できるかは別問題）') : 'コマンドが見つかりません');

/* ==================================================================
 * 2. データベースへの接続
 * ================================================================== */

$conn = null;
if (!extension_loaded('mysqli')) {
    add('接続', 'MySQL へ接続', 'ng', 'mysqli 拡張が無いため試せません');
} else {
    mysqli_report(MYSQLI_REPORT_OFF);
    $t0 = microtime(true);
    $conn = @new mysqli($CONFIG['host'], $CONFIG['username'], $CONFIG['password'],
                        $CONFIG['database'], (int)$CONFIG['port']);
    $ms = round((microtime(true) - $t0) * 1000);

    if ($conn->connect_errno) {
        add('接続', 'MySQL へ接続', 'ng',
            'エラー ' . $conn->connect_errno . ': ' . htmlspecialchars($conn->connect_error));
        $conn = null;
    } else {
        add('接続', 'MySQL へ接続', 'ok', "成功（{$ms}ms）");
        $conn->set_charset('utf8mb4');

        $r = $conn->query('SELECT VERSION() v, DATABASE() d, CURRENT_USER() u');
        if ($r && ($row = $r->fetch_assoc())) {
            add('接続', 'サーバのバージョン', 'info', $row['v']);
            add('接続', '接続中のデータベース', 'info', $row['d']);
            add('接続', '接続ユーザー', 'info', $row['u']);
        }
    }
}

/* ==================================================================
 * 3. 外から直接つなげるかの手がかり
 * ================================================================== */

$host = $CONFIG['host'];
$isLan = (substr($host, -4) === '.lan');
add('外部接続', 'ホスト名の形', $isLan ? 'ng' : 'ok',
    $isLan
        ? "「{$host}」は .lan で終わっています。これはサーバ内部だけで通じる名前で、"
          . "インターネットからは名前を引けません。手元の PC やほかのサーバからは直接つなげません。"
        : "「{$host}」は外部からも引ける形かもしれません。手元の PC で "
          . "<code>nc -zv {$host} {$CONFIG['port']}</code> を試してください。");

// ホスト名が既に IP なら引く必要がない
$isLiteralIp = (bool)filter_var($host, FILTER_VALIDATE_IP);
$ip = $isLiteralIp ? $host : @gethostbyname($host);
$resolved = $isLiteralIp || ($ip !== $host);

add('外部接続', 'このサーバから見た IP', $resolved ? 'info' : 'warn',
    $resolved ? $ip : '名前を引けませんでした（このサーバからも届いていません）');

if ($resolved) {
    // FILTER_FLAG_NO_PRIV_RANGE / NO_RES_RANGE を外すと、
    // プライベート IP と予約 IP のときだけ false になる
    $isGlobal = (bool)filter_var(
        $ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE);
    add('外部接続', 'IP の種類', $isGlobal ? 'ok' : 'ng',
        $isGlobal
            ? "{$ip} はグローバル IP です。経路としては外から届く形です（ファイアウォールは別途）。"
            : "{$ip} はプライベート／予約 IP です。インターネット越しには到達できません。");
}

// SSH が使えるかの手がかり（あればトンネルという手が使える）
$sshd = @file_exists('/usr/sbin/sshd') || @file_exists('/usr/bin/ssh');
add('外部接続', 'SSH の痕跡', $sshd ? 'ok' : 'info',
    $sshd ? 'このサーバに SSH がありそうです。契約プランで SSH が使えるか管理画面で確認してください。'
          : '判定できません。管理画面で「SSH」の項目を確認してください。');

/* ==================================================================
 * 4. データの中身（参照のみ）
 * ================================================================== */

if ($conn) {
    $tables = [];
    $r = $conn->query('SHOW TABLE STATUS');
    if ($r) {
        while ($row = $r->fetch_assoc()) $tables[] = $row;
    }
    add('データ', 'テーブル数', count($tables) ? 'ok' : 'warn', count($tables) . ' 件');

    foreach (array_slice($tables, 0, 20) as $t) {
        add('データ', '　' . $t['Name'], 'info',
            'およそ ' . (int)$t['Rows'] . ' 行 / ' . $t['Engine'] . ' / ' . $t['Collation']
            . ($t['Comment'] !== '' ? ' / ' . htmlspecialchars($t['Comment']) : ''));
    }
    if (count($tables) > 20) {
        add('データ', '　…', 'info', '残り ' . (count($tables) - 20) . ' 件は省略しました');
    }

    // 文字コードの状態。二重エンコードを見つけるのが目的。
    $r = $conn->query("SHOW VARIABLES WHERE Variable_name IN
        ('character_set_database','character_set_server','collation_database')");
    if ($r) {
        while ($row = $r->fetch_assoc()) {
            $okCharset = strpos($row['Value'], 'utf8') === 0;
            add('文字コード', $row['Variable_name'], $okCharset ? 'ok' : 'warn', $row['Value']);
        }
    }

    // 日本語が入っている列を探し、バイト列を見て二重エンコードを判定する
    $found = false;
    foreach (array_slice($tables, 0, 10) as $t) {
        if ($found) break;
        $tn = $t['Name'];
        $cr = $conn->query("SHOW COLUMNS FROM `" . str_replace('`', '``', $tn) . "`");
        if (!$cr) continue;
        while ($col = $cr->fetch_assoc()) {
            if (!preg_match('/char|text/i', $col['Type'])) continue;
            $cn = str_replace('`', '``', $col['Field']);
            $q = $conn->query("SELECT `$cn` v, HEX(`$cn`) h FROM `" . str_replace('`', '``', $tn)
                . "` WHERE `$cn` REGEXP '[^ -~]' LIMIT 1");
            if ($q && ($row = $q->fetch_assoc())) {
                $hex = $row['h'];
                // UTF-8 を二重に通すと C3xx C2xx が並ぶ
                $doubled = (bool)preg_match('/^(C3|C2)/', $hex) && preg_match('/C[23]/', substr($hex, 2, 8));
                add('文字コード', "{$tn}.{$col['Field']} の実データ", $doubled ? 'ng' : 'ok',
                    '表示: ' . htmlspecialchars(mb_substr($row['v'], 0, 20))
                    . ' / バイト列: ' . substr($hex, 0, 24) . '…'
                    . ($doubled ? '　→ <strong>二重エンコードされています</strong>' : '　→ 正常な UTF-8 です'));
                $found = true;
                break;
            }
        }
    }
    if (!$found) {
        add('文字コード', '日本語データの確認', 'info', '日本語を含む列が見つかりませんでした');
    }

    $conn->close();
}

/* ==================================================================
 * 5. 結論
 * ================================================================== */

$canReachFromOutside = !$isLan && (!$resolved || !empty($isGlobal));
$hasNode = (bool)$node;

if ($hasNode) {
    $verdict = ['ok', 'このサーバに Node.js があります',
        'DB Controller をこのサーバ上で動かせる可能性があります。ただし「常駐プロセスを動かしてよいか」は'
        . '契約の規約次第です。管理画面かサポートで確認してください。'];
} elseif ($canReachFromOutside) {
    $verdict = ['ok', '外部から DB へ直接つなげそうです',
        'DB Controller は手元の PC か VPS で動かし、この DB へ直接接続する形になります。'
        . '手元の PC で <code>nc -zv ' . htmlspecialchars($host) . ' ' . (int)$CONFIG['port'] . '</code> が'
        . '通れば確定です。'];
} else {
    $verdict = ['warn', 'このままでは外部から DB へ届きません',
        'ホスト名が .lan のため、DB Controller を別の場所で動かしても接続できません。'
        . '<strong>SSH ポートフォワード</strong>（SSH が使えるプランの場合）か、'
        . '<strong>この PHP と同じ場所に中継役を置く</strong>かの、どちらかが必要です。'];
}

?><!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DB Controller — サーバ下見</title>
<style>
  body { font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", sans-serif;
         background:#0d0f14; color:#e6e6e6; margin:0; padding:24px 16px; line-height:1.7; }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color:#8a92a6; font-size:13px; margin-bottom:24px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:#8a92a6;
       margin:28px 0 10px; border-bottom:1px solid #232734; padding-bottom:6px; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  td { padding:7px 8px; border-bottom:1px solid #1a1e28; vertical-align:top; }
  td.l { width:230px; color:#c8cede; }
  td.s { width:56px; text-align:center; font-weight:700; font-size:11px; white-space:nowrap; }
  .ok { color:#5fe3c0; } .ng { color:#ff6b5e; } .warn { color:#e3b341; } .info { color:#4ea1ff; }
  code { font-family: ui-monospace, monospace; background:#171b24; padding:1px 5px; border-radius:3px; }
  .verdict { border:1px solid #232734; border-left:3px solid #4ea1ff; border-radius:7px;
             padding:14px 16px; margin:24px 0; background:#12151d; }
  .verdict.warn { border-left-color:#e3b341; } .verdict.ok { border-left-color:#5fe3c0; }
  .verdict h3 { margin:0 0 6px; font-size:15px; }
  .danger { border:1px solid #ff6b5e; border-radius:7px; padding:12px 16px; margin-top:28px;
            background:#1d1315; color:#ffb3ac; font-size:13.5px; }
</style></head><body><div class="wrap">
<h1>DB Controller — サーバ下見</h1>
<div class="sub">このページは参照しか行いません。データは変更していません。</div>

<div class="verdict <?= $verdict[0] ?>">
  <h3><?= $verdict[1] ?></h3>
  <div><?= $verdict[2] ?></div>
</div>

<?php foreach ($results as $section => $rows): ?>
  <h2><?= htmlspecialchars($section) ?></h2>
  <table><?php foreach ($rows as $r): ?>
    <tr><td class="s <?= $r['status'] ?>"><?= ['ok'=>'OK','ng'=>'NG','warn'=>'注意','info'=>'—'][$r['status']] ?></td>
        <td class="l"><?= $r['label'] ?></td>
        <td><?= $r['detail'] ?></td></tr>
  <?php endforeach; ?></table>
<?php endforeach; ?>

<div class="danger">
  <strong>確認が終わったら、このファイルをサーバから削除してください。</strong><br>
  DB のユーザー名とパスワードが書かれています。合言葉を知らなければ開けませんが、
  置きっぱなしにする理由はありません。
</div>
</div></body></html>
