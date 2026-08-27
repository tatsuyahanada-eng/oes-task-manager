<?php
/**
 * 配色と文言の設定。
 *
 * 既定値は public/theme.css に書いてある。
 * 画面から変えた分だけを data/theme.json に持ち、CSS より優先して当てる。
 *
 * 保存するのは「変えた項目だけ」。
 * theme.css を後から直したとき、触っていない項目はその変更が効く。
 */

declare(strict_types=1);

/** 画面から変えられる色。ここに無いものは受け付けない。 */
function theme_tokens(): array
{
    return [
        'bg'           => ['label' => '背景',           'group' => '背景'],
        'bg-panel'     => ['label' => 'パネル',         'group' => '背景'],
        'bg-raise'     => ['label' => '見出し行',       'group' => '背景'],
        'bg-hover'     => ['label' => 'マウス乗せ',     'group' => '背景'],
        'border'       => ['label' => '区切り線',       'group' => '線'],
        'border-strong'=> ['label' => '強い線',         'group' => '線'],
        'text'         => ['label' => '本文',           'group' => '文字'],
        'text-mute'    => ['label' => '補足',           'group' => '文字'],
        'text-dim'     => ['label' => '控えめ',         'group' => '文字'],
        'accent'       => ['label' => '選択中',         'group' => '状態'],
        'accent-dim'   => ['label' => '選択中の背景',   'group' => '状態'],
        'ok'           => ['label' => '成功',           'group' => '状態'],
        'warn'         => ['label' => '注意',           'group' => '状態'],
        'danger'       => ['label' => '削除・危険',     'group' => '状態'],
        'write'        => ['label' => '書き込み可',     'group' => '状態'],
    ];
}

/** 画面から変えられる文字の大きさ。 */
function theme_sizes(): array
{
    return [
        'ws-font-size'   => ['label' => '文字の大きさ',   'min' => 11, 'max' => 20, 'unit' => 'px'],
        'ws-grid-size'   => ['label' => '表の文字',       'min' => 10, 'max' => 18, 'unit' => 'px'],
        'ws-line-height' => ['label' => '行の高さ',       'min' => 1.2, 'max' => 2.2, 'unit' => ''],
    ];
}

/** 画面から変えられる文言。 */
function theme_labels(): array
{
    return [
        'appTitle'    => ['label' => 'タイトル',       'default' => 'DB Controller'],
        'tabTree'     => ['label' => 'タブ: ツリー',   'default' => 'ツリー'],
        'tabData'     => ['label' => 'タブ: データ',   'default' => 'データ'],
        'tabCui'      => ['label' => 'タブ: CUI',      'default' => 'CUI'],
        'tabSettings' => ['label' => 'タブ: 設定',     'default' => '設定'],
        'readOnly'    => ['label' => '読取専用の表示', 'default' => '読取専用'],
        'writable'    => ['label' => '書込可の表示',   'default' => '書込可'],
    ];
}

function theme_file(): string { return data_path('theme.json'); }

function theme_load(): array
{
    $t = read_json(theme_file());
    return [
        'tokens' => (array)($t['tokens'] ?? []),
        'sizes'  => (array)($t['sizes'] ?? []),
        'labels' => (array)($t['labels'] ?? []),
    ];
}

/** 画面へ返す形。何が変えられるかの一覧も一緒に返す。 */
function theme_public(): array
{
    $saved = theme_load();

    $tokens = [];
    foreach (theme_tokens() as $id => $meta) {
        $tokens[] = ['id' => $id, 'label' => $meta['label'], 'group' => $meta['group'],
                     'value' => $saved['tokens'][$id] ?? null];
    }
    $sizes = [];
    foreach (theme_sizes() as $id => $meta) {
        $sizes[] = ['id' => $id, 'label' => $meta['label'],
                    'min' => $meta['min'], 'max' => $meta['max'], 'unit' => $meta['unit'],
                    'value' => $saved['sizes'][$id] ?? null];
    }
    $labels = [];
    foreach (theme_labels() as $id => $meta) {
        $labels[] = ['id' => $id, 'label' => $meta['label'],
                     'default' => $meta['default'],
                     'value' => $saved['labels'][$id] ?? null];
    }

    return ['tokens' => $tokens, 'sizes' => $sizes, 'labels' => $labels,
            'applied' => $saved];
}

/** CSS の色として妥当か。画面から来た文字列を style へ入れる前に確かめる。 */
function is_css_color(string $v): bool
{
    $v = trim($v);
    if ($v === '' || strlen($v) > 64) return false;
    if (preg_match('/^#[0-9a-fA-F]{3,8}$/', $v)) return true;
    if (preg_match('/^(rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s\/deg]+\)$/i', $v)) return true;
    // 色名（transparent なども含む）。記号を許さないので式は入れられない。
    if (preg_match('/^[a-zA-Z]{3,24}$/', $v)) return true;
    return false;
}

/** 保存する。渡された項目だけを残し、空にした項目は既定へ戻す。 */
function theme_save(array $input): array
{
    $out = ['tokens' => [], 'sizes' => [], 'labels' => []];

    $allowedTokens = theme_tokens();
    foreach ((array)($input['tokens'] ?? []) as $id => $v) {
        if (!isset($allowedTokens[$id])) continue;
        $v = trim((string)$v);
        if ($v === '') continue;                       // 空 = 既定に戻す
        if (!is_css_color($v)) throw bad("「{$allowedTokens[$id]['label']}」の色の書き方が正しくありません: {$v}");
        $out['tokens'][$id] = $v;
    }

    $allowedSizes = theme_sizes();
    foreach ((array)($input['sizes'] ?? []) as $id => $v) {
        if (!isset($allowedSizes[$id])) continue;
        $v = trim((string)$v);
        if ($v === '') continue;
        $n = (float)$v;
        $meta = $allowedSizes[$id];
        if ($n < $meta['min'] || $n > $meta['max']) {
            throw bad("「{$meta['label']}」は {$meta['min']}〜{$meta['max']} の範囲で指定してください。");
        }
        $out['sizes'][$id] = $n . $meta['unit'];
    }

    $allowedLabels = theme_labels();
    foreach ((array)($input['labels'] ?? []) as $id => $v) {
        if (!isset($allowedLabels[$id])) continue;
        $v = trim((string)$v);
        if ($v === '') continue;
        if (mb_strlen($v) > 40) throw bad("「{$allowedLabels[$id]['label']}」は 40 文字までにしてください。");
        $out['labels'][$id] = $v;
    }

    write_json(theme_file(), $out);
    return $out;
}

function theme_reset(): void
{
    if (is_file(theme_file())) @unlink(theme_file());
}
