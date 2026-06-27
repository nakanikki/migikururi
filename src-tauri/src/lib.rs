mod config;
mod mouse_hook;

use config::Config;
use std::sync::Mutex;
use tauri::{Emitter, LogicalSize, Manager, PhysicalPosition};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// 現在登録中のホットキーを保持する（設定変更時に登録し直すため）。
struct HotkeyState(Mutex<Option<Shortcut>>);

/// 現在表示中のパイメニューの実体（発動時にスタックを引くため）。
/// ルートプロファイルでもサブメニュー（ノードのインライン）でも、解決済みの
/// Profile を値で持つ。サブメニューは id を持たないので id 参照はしない。
struct CurrentProfile(Mutex<Option<config::Profile>>);

/// 即時アクション(instant_action)を Rust 側だけで完結させるための幾何＋
/// アクション情報。これがあると、JS へ往復せずフックの mouse-move で直接
/// ヒット判定→キー送出できる（IPC 往復ぶんのラグ＝十数ms を消す）。
/// active=true の間だけ有効。1回発動したら active=false にして二重発火を防ぐ。
#[derive(Default)]
struct InstantPie {
    active: bool,
    anchor_x: f64,
    anchor_y: f64,
    outer_r: f64,
    inner_r: f64,
    n: usize,
    outer_active: bool,
    /// パイ全体の回転（度）。描画(main.js)と判定を一致させるため保持。
    rotation: f64,
    dpr: f64,
    /// 各セグメントの「単発キー」spec（None=未接続/キー以外/サブメニュー）。
    seg_keys: Vec<Option<String>>,
}
/// 即時アクションがこのジェスチャで発火済みか（右UP時の二重発火防止）。
static INSTANT_FIRED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

static INSTANT_PIE: Mutex<InstantPie> = Mutex::new(InstantPie {
    active: false,
    anchor_x: 0.0,
    anchor_y: 0.0,
    outer_r: 0.0,
    inner_r: 0.0,
    n: 0,
    outer_active: false,
    rotation: 0.0,
    dpr: 1.0,
    seg_keys: Vec::new(),
});

/// フックの mouse-move から呼ぶ: 即時アクションが有効なら、カーソル位置から
/// セグメントを判定し、当たっていればその場でキー送出して true を返す。
/// JS へ往復しないので最速。発動後は active=false（1回のみ）。
pub(crate) fn try_instant_fire(x: i32, y: i32) -> bool {
    let mut pie = INSTANT_PIE.lock().unwrap();
    if !pie.active || pie.n == 0 {
        return false;
    }
    // hitTest（JS版）と同じ計算。物理px差分→論理px。
    let dx = (x as f64 - pie.anchor_x) / pie.dpr;
    let dy = (y as f64 - pie.anchor_y) / pie.dpr;
    let r = (dx * dx + dy * dy).sqrt();
    if r <= pie.inner_r {
        return false; // 中央ハブ＝発動しない
    }
    if !pie.outer_active && r > pie.outer_r + 40.0 {
        return false; // 範囲外（外側無効時）
    }
    let mut deg = dy.atan2(dx).to_degrees() + 90.0;
    if deg < 0.0 {
        deg += 360.0;
    }
    let slice = 360.0 / pie.n as f64;
    let mut a = deg + slice / 2.0 - pie.rotation;
    a = ((a % 360.0) + 360.0) % 360.0;
    let idx = ((a / slice).floor() as usize) % pie.n;

    // そのセグメントに単発キーが繋がっていれば確定して送出。
    if let Some(Some(spec)) = pie.seg_keys.get(idx).cloned() {
        pie.active = false; // 1回のみ（このジェスチャでは以降発火しない）
        drop(pie); // ロック解放
        INSTANT_FIRED.store(true, std::sync::atomic::Ordering::Release); // 右UPで二重発火しない
        mouse_hook::suppress_move(true);
        // 別スレッドで即送出（フック外し方式は連続使用で再設置がばらつき遅延を
        // 溜めるため不採用。素直に SendInput する）。
        std::thread::spawn(move || {
            send_keys_blocking(&spec);
        });
        return true;
    }
    false
}

/// 右ボタンを離した位置の判定結果（Rust 側のリリース判定で使う）。
/// 右ボタン離し位置 (x,y 物理px) を、down 時に保持した幾何（INSTANT_PIE）で
/// 判定し、「単発キーのセグメント」ならその spec を返す。それ以外（中央ハブ・
/// 範囲外・複雑/未接続・幾何無し）は None＝JS 経路へフォールバック。
/// 描画や JS 往復に一切依存しないので、速いフリックでも確実。
fn judge_release_key(x: i32, y: i32) -> Option<String> {
    let pie = INSTANT_PIE.lock().unwrap();
    if pie.n == 0 {
        return None;
    }
    let dx = (x as f64 - pie.anchor_x) / pie.dpr;
    let dy = (y as f64 - pie.anchor_y) / pie.dpr;
    let r = (dx * dx + dy * dy).sqrt();
    if r <= pie.inner_r {
        return None; // 中央ハブ＝キャンセル（JS 経路へ）
    }
    if !pie.outer_active && r > pie.outer_r + 40.0 {
        return None; // 範囲外（JS 経路へ）
    }
    let mut deg = dy.atan2(dx).to_degrees() + 90.0;
    if deg < 0.0 {
        deg += 360.0;
    }
    let slice = 360.0 / pie.n as f64;
    let mut a = deg + slice / 2.0 - pie.rotation;
    a = ((a % 360.0) + 360.0) % 360.0;
    let idx = ((a / slice).floor() as usize) % pie.n;
    pie.seg_keys.get(idx).cloned().flatten()
}

/// キー名を global-shortcut の Code に変換する。未知なら None。
/// 現在はグローバルホットキー未使用（将来の再有効化用に残す）。
#[allow(dead_code)]
fn code_from_name(name: &str) -> Option<Code> {
    let n = name.to_ascii_lowercase();
    // 1文字の英字
    if n.len() == 1 {
        let c = n.chars().next().unwrap();
        return match c {
            'a' => Some(Code::KeyA),
            'b' => Some(Code::KeyB),
            'c' => Some(Code::KeyC),
            'd' => Some(Code::KeyD),
            'e' => Some(Code::KeyE),
            'f' => Some(Code::KeyF),
            'g' => Some(Code::KeyG),
            'h' => Some(Code::KeyH),
            'i' => Some(Code::KeyI),
            'j' => Some(Code::KeyJ),
            'k' => Some(Code::KeyK),
            'l' => Some(Code::KeyL),
            'm' => Some(Code::KeyM),
            'n' => Some(Code::KeyN),
            'o' => Some(Code::KeyO),
            'p' => Some(Code::KeyP),
            'q' => Some(Code::KeyQ),
            'r' => Some(Code::KeyR),
            's' => Some(Code::KeyS),
            't' => Some(Code::KeyT),
            'u' => Some(Code::KeyU),
            'v' => Some(Code::KeyV),
            'w' => Some(Code::KeyW),
            'x' => Some(Code::KeyX),
            'y' => Some(Code::KeyY),
            'z' => Some(Code::KeyZ),
            '0' => Some(Code::Digit0),
            '1' => Some(Code::Digit1),
            '2' => Some(Code::Digit2),
            '3' => Some(Code::Digit3),
            '4' => Some(Code::Digit4),
            '5' => Some(Code::Digit5),
            '6' => Some(Code::Digit6),
            '7' => Some(Code::Digit7),
            '8' => Some(Code::Digit8),
            '9' => Some(Code::Digit9),
            _ => None,
        };
    }
    // F1〜F12
    if let Some(num) = n.strip_prefix('f') {
        if let Ok(k) = num.parse::<u8>() {
            return match k {
                1 => Some(Code::F1),
                2 => Some(Code::F2),
                3 => Some(Code::F3),
                4 => Some(Code::F4),
                5 => Some(Code::F5),
                6 => Some(Code::F6),
                7 => Some(Code::F7),
                8 => Some(Code::F8),
                9 => Some(Code::F9),
                10 => Some(Code::F10),
                11 => Some(Code::F11),
                12 => Some(Code::F12),
                _ => None,
            };
        }
    }
    // 名前付きキー
    match n.as_str() {
        "space" => Some(Code::Space),
        "enter" | "return" => Some(Code::Enter),
        "tab" => Some(Code::Tab),
        "up" => Some(Code::ArrowUp),
        "down" => Some(Code::ArrowDown),
        "left" => Some(Code::ArrowLeft),
        "right" => Some(Code::ArrowRight),
        "home" => Some(Code::Home),
        "end" => Some(Code::End),
        "insert" => Some(Code::Insert),
        "delete" | "del" => Some(Code::Delete),
        "pageup" => Some(Code::PageUp),
        "pagedown" => Some(Code::PageDown),
        _ => None,
    }
}

/// "Ctrl+Alt+P" / "F8" 等のホットキー文字列を Shortcut に変換する。
#[allow(dead_code)]
fn parse_shortcut(spec: &str) -> Option<Shortcut> {
    let mut mods = Modifiers::empty();
    let mut code = None;

    for part in spec.split('+') {
        let token = part.trim();
        if token.is_empty() {
            continue;
        }
        match token.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "shift" => mods |= Modifiers::SHIFT,
            "alt" => mods |= Modifiers::ALT,
            "win" | "super" | "meta" => mods |= Modifiers::META,
            _ => code = code_from_name(token),
        }
    }

    code.map(|c| {
        let m = if mods.is_empty() { None } else { Some(mods) };
        Shortcut::new(m, c)
    })
}

/// デフォルトのトグルキー（F8）。設定が壊れている場合のフォールバック。
#[allow(dead_code)]
fn default_shortcut() -> Shortcut {
    Shortcut::new(None, Code::F8)
}

/// マウスフックスレッドから呼ばれる。UI 操作はメインスレッドで行う必要があるため
/// run_on_main_thread でディスパッチして表示する（右クリックは toggle でなく
/// 常に表示。閉じるのは選択/Esc/フォーカス外し）。
/// app_name は右クリックされた前面アプリの実行ファイル名（小文字）。
/// そのアプリが属するプロファイルの items を使う。
pub(crate) fn request_show_menu(app: &tauri::AppHandle, app_name: String) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        // 前面アプリのプロファイルを引く。見つからなければ（理屈上ここには
        // 来ないが念のため）何もしない。
        let cfg = config::load(&handle);
        let profile = match cfg.profile_for_app(&app_name) {
            Some(p) => p.clone(),
            None => return,
        };
        let anchor = show_menu(&handle, &profile);
        // 右クリック由来の表示はジェスチャモード（押しっぱなしで操作）。
        // F8 トグル表示と区別するため専用イベントを送る。アンカー（パイ中心の
        // スクリーン物理座標）を乗せ、フロントは move/up との差分で判定する。
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.emit("gesture-start", anchor);
        }
    });
}

/// 右ボタン押しっぱなしジェスチャ中、マウスが動いたときにフックから呼ばれる。
/// スクリーン物理座標をフロントへ送り、ホバー中セグメントをハイライトさせる。
/// 高頻度で呼ばれるので run_on_main_thread は使わず emit のみ（軽量）。
pub(crate) fn gesture_move(app: &tauri::AppHandle, x: i32, y: i32) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("gesture-move", (x, y));
    }
}

/// 即時アクションがフック側で発火したときの後始末。キーは既に送出済みなので、
/// ここでは見た目を閉じるだけ（フロントへ通知＋窓 hide）。フロントはこの
/// イベントで gestureMode を畳む（自前の即時アクション送出はしない）。
pub(crate) fn instant_fired(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("instant-fired", ());
    }
    let h = app.clone();
    std::thread::spawn(move || hide_menu(&h));
}

/// 右ボタンを離したときにフックから呼ばれる。
/// 速いフリックでも確実に効くよう、判定を **Rust 側の幾何計算で完結** する
/// （描画・JS 往復に依存しない）。複雑なケース（複数スタック/launch/submenu/
/// 未接続）は従来どおり JS の gesture-release にフォールバック。
/// quick_used: ジェスチャ中にクイックアクションが使われた → 何もせず閉じる。
pub(crate) fn gesture_release(app: &tauri::AppHandle, x: i32, y: i32, quick_used: bool) {
    // 即時アクションで既に発火済みなら、二重発火しない（見た目だけ閉じる）。
    if INSTANT_FIRED.swap(false, std::sync::atomic::Ordering::AcqRel) {
        let h = app.clone();
        std::thread::spawn(move || hide_menu(&h));
        return;
    }
    if quick_used {
        // クイック使用時は発動も右クリック送出もせず閉じるだけ。
        let h = app.clone();
        std::thread::spawn(move || hide_menu(&h));
        return;
    }
    // 単発キーのセグメントだけ Rust で直接送出（速いフリックでも確実・最速）。
    // それ以外（中央ハブ＝キャンセル / 範囲外 / 複雑 / 未接続）は実績のある
    // JS 経路（CurrentProfile 使用）にフォールバックして安全側に倒す。
    if let Some(spec) = judge_release_key(x, y) {
        std::thread::spawn(move || {
            send_keys_blocking(&spec);
        });
        let h = app.clone();
        std::thread::spawn(move || hide_menu(&h));
    } else if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("gesture-release", (x, y, quick_used));
    }
}

/// ジェスチャ中の追加マウス操作（左/中クリック・ホイール上下）でフックから
/// 呼ばれる。kind に対応するクイックスロットのアクションを発動する。
/// メニューは閉じない（右押しっぱなし継続）。
pub(crate) fn quick_action(app: &tauri::AppHandle, kind: String) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("quick-action", kind);
    }
}

/// Windows: ウィンドウの表示/非表示時の DWM トランジション（フェード等）を無効化する。
/// 透明オーバーレイは即出/即消しが望ましいため。
#[cfg(windows)]
fn disable_window_transitions(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::{HWND, TRUE};
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = HWND(hwnd.0);
    let disable: i32 = TRUE.0;
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED,
            &disable as *const _ as *const _,
            std::mem::size_of::<i32>() as u32,
        );
    }
}

#[cfg(not(windows))]
fn disable_window_transitions(_window: &tauri::WebviewWindow) {}

/// パイ窓を「フォーカスを奪わない窓」にする（WS_EX_NOACTIVATE）。
/// これで窓を表示しても対象アプリ（クリスタ等）が前面のまま＝キー送出が
/// 直接対象へ届く。従来は set_focus で前面を奪い、送出前に AttachThreadInput
/// で前面を奪い返していた（重い＝砂時計／即時だと間に合わず無視）。それを解消。
#[cfg(windows)]
fn make_window_noactivate(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = HWND(hwnd.0);
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let new_ex = ex | (WS_EX_NOACTIVATE.0 as isize);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex);
    }
}

#[cfg(not(windows))]
fn make_window_noactivate(_window: &tauri::WebviewWindow) {}

/// パイメニュー窓を「マウス位置に表示」か「非表示」にトグルする。
fn toggle_menu(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if window.is_visible().unwrap_or(false) {
        hide_menu(app);
    } else {
        // F8 トグル表示はクリックモード（ジェスチャ開始イベントは出さない）。
        // アプリ非紐付けなのでアクティブプロファイルのセグメントを使う。
        let cfg = config::load(app);
        let profile = match cfg.active() {
            Some(p) => p.clone(),
            None => return,
        };
        let _ = show_menu(app, &profile);
    }
}

/// menu-items イベント（パイ描画情報）をフロントへ送る共通処理。
/// プロファイル/サブメニュー（どちらも Profile 型）から描画情報を導出して送る。
/// submenus は「各セグメントがサブメニューを開くか」の真偽配列。
fn emit_pie(window: &tauri::WebviewWindow, p: &config::Profile) {
    #[derive(serde::Serialize, Clone)]
    struct MenuPayload {
        segments: Vec<config::Segment>,
        outer_r: f64,
        inner_r: f64,
        rotation: f64,
        opacity: f64,
        outer_active: bool,
        shake_dismiss: bool,
        instant_action: bool,
        quick: Vec<config::ResolvedQuick>,
        quick_hud_visible: bool,
        pie_visible: bool,
        submenus: Vec<bool>,
    }
    let _ = window.emit(
        "menu-items",
        MenuPayload {
            segments: p.resolved_segments(),
            outer_r: p.outer_r,
            inner_r: p.inner_r,
            rotation: p.rotation,
            opacity: p.opacity,
            outer_active: p.outer_active,
            shake_dismiss: p.shake_dismiss,
            instant_action: p.instant_action,
            quick: p.resolved_quick_slots(),
            quick_hud_visible: p.quick_hud_visible,
            pie_visible: p.pie_visible,
            submenus: p.segment_has_submenu(),
        },
    );
}

/// サブメニューを開く（フロントから「メニュー種別セグメントにホバー」で呼ぶ）。
/// 現在表示中のパイの index 番セグメントが持つインラインのサブメニューへ
/// 差し替える。サブメニューは独立データ（別プロファイル参照ではない）。窓は隠さない。
#[tauri::command]
fn open_submenu(app: tauri::AppHandle, index: usize) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // 現在表示中のパイ（ルート or サブメニュー）から、該当セグメントの
    // インライン submenu を取り出す。
    let sub = {
        let state = app.state::<CurrentProfile>();
        let guard = state.0.lock().unwrap();
        guard.as_ref().and_then(|p| p.segment_submenu(index))
    };
    let Some(sub) = sub else {
        return;
    };
    // 表示中パイをこのサブメニューへ切り替え（発動時のスタック解決先になる）。
    {
        let state = app.state::<CurrentProfile>();
        *state.0.lock().unwrap() = Some(sub.clone());
    }
    emit_pie(&window, &sub);

    // サブメニューも自身の outer_r に合わせて窓をリサイズ（パイのはみ出し防止）。
    let (win_w, win_h) = fit_main_window(&window, sub.outer_r);

    // サブメニューはカーソル位置を新しい中心にする（「→↑」と続けて選べる）。
    // 窓を現在のカーソル中心へ移動し、新しいアンカーをフロントへ通知する。
    let mut anchor = None;
    if let Ok(cursor) = window.cursor_position() {
        let x = cursor.x as i32 - win_w / 2;
        let y = cursor.y as i32 - win_h / 2;
        let _ = window.set_position(PhysicalPosition::new(x, y));
        let _ = window.emit("submenu-anchor", (cursor.x as i32, cursor.y as i32));
        anchor = Some((cursor.x as i32, cursor.y as i32));
    }

    // 重要: 即時アクション用の幾何＋キーを「このサブメニュー」に更新する。
    // これをしないと、フック側の即時発火が親パイの古いキーを送ってしまう
    // （サブメニュー下のセグメントが親の同位置セグメントとして発動するバグ）。
    set_instant_pie(&sub, anchor, window.scale_factor().unwrap_or(1.0));
}

/// パイ（外周半径 outer_r）が収まるよう main 窓をリサイズし、
/// リサイズ後の物理サイズ (width, height) を返す。フロントの SVG は
/// (outer_r + margin) * 2 の論理px なので、それに合わせる。窓中心＝パイ中心。
/// margin はフロント(SVG_MARGIN=30)より少し大きめに取り、影/縁の切れを防ぐ。
fn fit_main_window(window: &tauri::WebviewWindow, outer_r: f64) -> (i32, i32) {
    const MARGIN: f64 = 40.0;
    const MIN_SIDE: f64 = 600.0; // 従来サイズを下限に（小さいパイでも詰まらない）。
    let side = ((outer_r + MARGIN) * 2.0).max(MIN_SIDE);
    let _ = window.set_size(LogicalSize::new(side, side));
    // 物理サイズは論理サイズ×スケール係数（set_size 直後は outer_size が
    // 旧値を返すことがあるため、自前で算出して中心合わせに使う）。
    let scale = window.scale_factor().unwrap_or(1.0);
    let phys = (side * scale).round() as i32;
    (phys, phys)
}

/// メニューをマウス位置に表示し、Esc を有効化する。
/// items に「そのとき表示すべきプロファイルのパイ項目」を渡し、表示直前に
/// フロントへ送って描画させる（プロファイルごとにパイが変わるため）。
/// 戻り値は「パイ中心のスクリーン物理座標」(=カーソル位置)。
/// ジェスチャ判定のアンカーに使う。取得できなければ None。
fn show_menu(app: &tauri::AppHandle, profile: &config::Profile) -> Option<(i32, i32)> {
    let window = app.get_webview_window("main")?;

    // 発動時にスタックを引けるよう、表示中パイ（実体）を覚える。
    {
        let state = app.state::<CurrentProfile>();
        *state.0.lock().unwrap() = Some(profile.clone());
    }

    emit_pie(&window, profile);

    // パイがはみ出さないよう、外周半径に合わせて窓をリサイズしてから配置する。
    let (win_w, win_h) = fit_main_window(&window, profile.outer_r);

    // マウスのグローバル座標（物理ピクセル）を取得
    let mut anchor = None;
    if let Ok(cursor) = window.cursor_position() {
        // ウィンドウ中心がカーソルに来るようオフセット（リサイズ後の物理サイズ）。
        let x = cursor.x as i32 - win_w / 2;
        let y = cursor.y as i32 - win_h / 2;
        let _ = window.set_position(PhysicalPosition::new(x, y));
        anchor = Some((cursor.x as i32, cursor.y as i32));
    }

    // 即時アクションを Rust 側で完結させるための幾何＋アクションを準備する。
    // anchor（パイ中心物理座標）が取れたときだけ。instant_action オフなら無効化。
    set_instant_pie(profile, anchor, window.scale_factor().unwrap_or(1.0));

    // 前回 onSelect で visibility:hidden にしたオーバーレイを戻すよう通知。
    let _ = window.emit("menu-shown", ());
    let _ = window.show();
    // set_focus は呼ばない。WS_EX_NOACTIVATE で対象アプリが前面のまま＝
    // キー送出が直接届く（前面を奪い返す AttachThreadInput が不要になる）。
    anchor
}

/// INSTANT_PIE を現在のパイに合わせて設定する。instant_action オフ／anchor 無し
/// なら無効化（active=false）。各セグメントは「単発キー」のみ高速発火対象。
fn set_instant_pie(profile: &config::Profile, anchor: Option<(i32, i32)>, dpr: f64) {
    use std::sync::atomic::Ordering;
    // 新しいパイ表示＝新ジェスチャの起点なので、発火済みフラグをリセット。
    INSTANT_FIRED.store(false, Ordering::Release);

    let mut pie = INSTANT_PIE.lock().unwrap();
    let Some((ax, ay)) = anchor else {
        pie.active = false;
        pie.n = 0; // 幾何無効
        return;
    };
    let has_sub = profile.segment_has_submenu();
    let n = profile.segments.len();
    let mut seg_keys = Vec::with_capacity(n);
    for i in 0..n {
        // サブメニュー持ちは発火でなくホバー切替なので単発キー対象外（None）。
        if has_sub.get(i).copied().unwrap_or(false) {
            seg_keys.push(None);
            continue;
        }
        let stack = profile.stack_for_segment(i);
        // 「単発の key ノード」のみ Rust 直接送出対象（複数スタックや launch 等は
        // None＝JS 経由でフォールバック）。
        let spec = if stack.len() == 1 && stack[0].kind == "key" && !stack[0].value.is_empty()
        {
            Some(stack[0].value.clone())
        } else {
            None
        };
        seg_keys.push(spec);
    }
    // 幾何は instant_action のオン/オフに関わらず常に保持する（リリース判定で
    // 使うため）。active は「ホバーで即発火するか＝instant_action」だけを表す。
    pie.active = profile.instant_action;
    pie.anchor_x = ax as f64;
    pie.anchor_y = ay as f64;
    pie.outer_r = profile.outer_r;
    pie.inner_r = profile.inner_r;
    pie.n = n;
    pie.outer_active = profile.outer_active;
    pie.rotation = profile.rotation;
    pie.dpr = dpr;
    pie.seg_keys = seg_keys;
}

/// メニューを隠す。閉路は必ずここを通す。
fn hide_menu(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

/// 修飾キー名かどうか判定し、該当すれば enigo::Key を返す。
/// （enigo 経路は非 Windows フォールバック用。Windows は SendInput を使う。）
#[cfg(not(windows))]
fn modifier_key(token: &str) -> Option<enigo::Key> {
    use enigo::Key;
    match token.to_ascii_lowercase().as_str() {
        "ctrl" | "control" => Some(Key::Control),
        "shift" => Some(Key::Shift),
        "alt" => Some(Key::Alt),
        "win" | "super" | "meta" => Some(Key::Meta),
        _ => None,
    }
}

/// "Ctrl+Shift+S" のような文字列を (修飾キー群, 主キー) に分解する。
#[cfg(not(windows))]
fn parse_keys(spec: &str) -> (Vec<enigo::Key>, Option<enigo::Key>) {
    let mut mods = Vec::new();
    let mut main = None;

    // 区切りは "+"。ただし主キー自体が "+" の場合（"Ctrl++" と直接書かれた等）、
    // split で空トークンになる。空トークン＝リテラルの "+" 主キーとして扱う。
    let parts: Vec<&str> = spec.split('+').collect();
    for (i, part) in parts.iter().enumerate() {
        let token = part.trim();
        if token.is_empty() {
            // 末尾や連続 "+" 由来の空＝"+" キー。先頭の空は無視。
            if i > 0 {
                main = Some(enigo::Key::Unicode('+'));
            }
            continue;
        }
        if let Some(m) = modifier_key(token) {
            mods.push(m);
        } else {
            // 非修飾トークンが主キー（複数あれば最後を採用）
            main = Some(key_from_name(token));
        }
    }

    (mods, main)
}

/// キー名を enigo::Key に変換。1文字なら Unicode、特殊キーは名前で対応。
#[cfg(not(windows))]
fn key_from_name(name: &str) -> enigo::Key {
    use enigo::Key;
    let lower = name.to_ascii_lowercase();

    // ファンクションキー F1〜F24。
    if let Some(num) = lower.strip_prefix('f') {
        if let Ok(n) = num.parse::<u32>() {
            if let Some(k) = function_key(n) {
                return k;
            }
        }
    }

    match lower.as_str() {
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "esc" | "escape" => Key::Escape,
        "space" => Key::Space,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "insert" => Key::Insert,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        // 記号キー。フロントが「+」を含まない名前で渡すので、ここで実際の
        // 文字へ変換する（enigo が OS 経由で必要な Shift 等を補う）。
        "plus" => Key::Unicode('+'),
        "equal" => Key::Unicode('='),
        "minus" => Key::Unicode('-'),
        "multiply" => Key::Unicode('*'),
        "divide" => Key::Unicode('/'),
        "decimal" | "period" => Key::Unicode('.'),
        "comma" => Key::Unicode(','),
        "slash" => Key::Unicode('/'),
        "backslash" => Key::Unicode('\\'),
        "semicolon" => Key::Unicode(';'),
        "quote" => Key::Unicode('\''),
        "backquote" => Key::Unicode('`'),
        "bracketleft" => Key::Unicode('['),
        "bracketright" => Key::Unicode(']'),
        _ => {
            // 1文字 → その文字を入力。複数文字の未知キーも先頭文字で代用。
            let ch = name.chars().next().unwrap_or(' ').to_ascii_lowercase();
            Key::Unicode(ch)
        }
    }
}

/// F1〜F24 を enigo::Key に変換。範囲外は None。
#[cfg(not(windows))]
fn function_key(n: u32) -> Option<enigo::Key> {
    use enigo::Key;
    Some(match n {
        1 => Key::F1,
        2 => Key::F2,
        3 => Key::F3,
        4 => Key::F4,
        5 => Key::F5,
        6 => Key::F6,
        7 => Key::F7,
        8 => Key::F8,
        9 => Key::F9,
        10 => Key::F10,
        11 => Key::F11,
        12 => Key::F12,
        13 => Key::F13,
        14 => Key::F14,
        15 => Key::F15,
        16 => Key::F16,
        17 => Key::F17,
        18 => Key::F18,
        19 => Key::F19,
        20 => Key::F20,
        21 => Key::F21,
        22 => Key::F22,
        23 => Key::F23,
        24 => Key::F24,
        _ => return None,
    })
}

/// enigo インスタンス（非 Windows フォールバック用）。Windows は SendInput。
#[cfg(not(windows))]
static ENIGO: Mutex<Option<enigo::Enigo>> = Mutex::new(None);

/// キー送出を同期実行する（呼び出しスレッドをブロックする）。スタック実行で
/// 複数キーを順番に送るため、各送出の完了を待てる同期版にする。
fn send_keys_blocking(spec: &str) {
    #[cfg(windows)]
    {
        send_keys_native(spec);
    }
    #[cfg(not(windows))]
    {
        send_keys_enigo(spec);
    }
}

/// キー spec を Win32 の VK 群（修飾＋主キー）に変換する。主キーが VK で
/// 表せないとき（記号など）は Unicode 文字を Some(char) で返す。
#[cfg(windows)]
fn spec_to_vks(spec: &str) -> (Vec<u16>, Option<u16>, Option<char>) {
    use windows::Win32::UI::Input::KeyboardAndMouse as k;
    let mut mods: Vec<u16> = Vec::new();
    let mut main_vk: Option<u16> = None;
    let mut main_ch: Option<char> = None;

    let parts: Vec<&str> = spec.split('+').collect();
    for (i, part) in parts.iter().enumerate() {
        let token = part.trim();
        if token.is_empty() {
            if i > 0 {
                main_ch = Some('+');
            }
            continue;
        }
        let low = token.to_ascii_lowercase();
        match low.as_str() {
            "ctrl" | "control" => mods.push(k::VK_CONTROL.0),
            "shift" => mods.push(k::VK_SHIFT.0),
            "alt" => mods.push(k::VK_MENU.0),
            "win" | "super" | "meta" => mods.push(k::VK_LWIN.0),
            _ => {
                // ファンクションキー F1〜F24
                if let Some(num) = low.strip_prefix('f') {
                    if let Ok(n) = num.parse::<u32>() {
                        if (1..=24).contains(&n) {
                            main_vk = Some((k::VK_F1.0 as u32 + (n - 1)) as u16);
                            continue;
                        }
                    }
                }
                // 1文字（英数字）は VK に直接対応（A-Z / 0-9 は ASCII 大文字＝VK）。
                if low.len() == 1 {
                    let c = low.chars().next().unwrap();
                    if c.is_ascii_alphanumeric() {
                        main_vk = Some(c.to_ascii_uppercase() as u16);
                        continue;
                    }
                }
                // 名前付き特殊キー。
                let named: Option<u16> = match low.as_str() {
                    "enter" | "return" => Some(k::VK_RETURN.0),
                    "tab" => Some(k::VK_TAB.0),
                    "esc" | "escape" => Some(k::VK_ESCAPE.0),
                    "space" => Some(k::VK_SPACE.0),
                    "backspace" => Some(k::VK_BACK.0),
                    "delete" | "del" => Some(k::VK_DELETE.0),
                    "insert" => Some(k::VK_INSERT.0),
                    "up" => Some(k::VK_UP.0),
                    "down" => Some(k::VK_DOWN.0),
                    "left" => Some(k::VK_LEFT.0),
                    "right" => Some(k::VK_RIGHT.0),
                    "home" => Some(k::VK_HOME.0),
                    "end" => Some(k::VK_END.0),
                    "pageup" => Some(k::VK_PRIOR.0),
                    "pagedown" => Some(k::VK_NEXT.0),
                    _ => None,
                };
                if let Some(vk) = named {
                    main_vk = Some(vk);
                    continue;
                }
                // テンキー系は配列非依存の専用 VK（Shift 不要の独立キー）。
                let numpad: Option<u16> = match low.as_str() {
                    "plus" => Some(k::VK_ADD.0),
                    "multiply" => Some(k::VK_MULTIPLY.0),
                    "divide" => Some(k::VK_DIVIDE.0),
                    "decimal" => Some(k::VK_DECIMAL.0),
                    _ => None,
                };
                if let Some(vk) = numpad {
                    main_vk = Some(vk);
                    continue;
                }
                // それ以外の記号は「文字」に直し、VkKeyScanW で現在のキーボード
                // レイアウト（JIS/US 等）に従った VK＋必要な修飾を逆引きする。
                // これで US 前提のハードコードによる JIS での誤り（; が : 等）を防ぐ。
                let ch: char = match low.as_str() {
                    "minus" => '-',
                    "equal" => '=',
                    "semicolon" => ';',
                    "slash" => '/',
                    "backquote" => '`',
                    "bracketleft" => '[',
                    "backslash" => '\\',
                    "bracketright" => ']',
                    "quote" => '\'',
                    "comma" => ',',
                    "period" => '.',
                    _ => token.chars().next().unwrap_or(' '),
                };
                // VkKeyScanW: 下位8bit=VK、上位バイト bit0=Shift bit1=Ctrl bit2=Alt。
                let r = unsafe { k::VkKeyScanW(ch as u16) };
                if r == -1 {
                    // レイアウトで打てない文字は最後の手段として Unicode 送出。
                    main_ch = Some(ch);
                } else {
                    let vk = (r & 0xff) as u16;
                    let sh = (r >> 8) & 0xff;
                    if sh & 0x1 != 0 {
                        mods.push(k::VK_SHIFT.0);
                    }
                    if sh & 0x2 != 0 {
                        mods.push(k::VK_CONTROL.0);
                    }
                    if sh & 0x4 != 0 {
                        mods.push(k::VK_MENU.0);
                    }
                    main_vk = Some(vk);
                }
            }
        }
    }
    (mods, main_vk, main_ch)
}

/// 修飾＋主キーの「押す→離す」を **1回の SendInput で一括送出** する。
/// enigo は1イベントずつ SendInput を呼ぶため、対象アプリ（クリスタ等）が
/// 重いと各 SendInput が数ms待たされ合計10〜20msになる。配列で一括送出すると
/// 待ちが1回分で済み、<1ms になる。
#[cfg(windows)]
fn send_keys_native(spec: &str) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
        KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC,
        VIRTUAL_KEY,
    };

    let (mods, main_vk, main_ch) = spec_to_vks(spec);

    // VK → スキャンコード。
    let scan = |vk: u16| -> u16 { unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) as u16 } };

    // 押す/離すイベント。**VK と scancode を両方** 入れる（SCANCODE フラグは
    // 立てない）。これでメッセージ系(VK 読み)と RawInput/DirectInput 系
    // (scancode 読み)の双方が満たされ、アプリの採用率が最大になる（調査結果）。
    let mk_sc = |vk: u16, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: scan(vk),
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    // Unicode 文字用（記号など、scancode で表せないもの）。
    let mk_uni = |ch: u16, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: ch,
                dwFlags: if up {
                    KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
                } else {
                    KEYEVENTF_UNICODE
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };

    // 押す群と離す群を「別々の SendInput」で送る。同一バッチで down+up を
    // 一瞬に送るとアプリが取りこぼし/遅延処理することがあるため、ハードウェアの
    // 「押す→離す」に近づける（2回に分ける）。
    let mut down: Vec<INPUT> = Vec::new();
    let mut up: Vec<INPUT> = Vec::new();
    for &m in &mods {
        down.push(mk_sc(m, false));
    }
    if let Some(vk) = main_vk {
        down.push(mk_sc(vk, false));
        up.push(mk_sc(vk, true));
    } else if let Some(ch) = main_ch {
        let mut buf = [0u16; 2];
        for u in ch.encode_utf16(&mut buf).iter() {
            down.push(mk_uni(*u, false));
            up.push(mk_uni(*u, true));
        }
    }
    for &m in mods.iter().rev() {
        up.push(mk_sc(m, true));
    }

    if down.is_empty() {
        return;
    }
    let sz = std::mem::size_of::<INPUT>() as i32;
    unsafe {
        SendInput(&down, sz);
        SendInput(&up, sz);
    }
}
/// 非 Windows 用フォールバック（enigo）。
#[cfg(not(windows))]
fn send_keys_enigo(spec: &str) {
    use enigo::{Direction, Enigo, Keyboard, Settings};
    let mut guard = ENIGO.lock().unwrap();
    if guard.is_none() {
        match Enigo::new(&Settings::default()) {
            Ok(e) => *guard = Some(e),
            Err(_) => return,
        }
    }
    let enigo = guard.as_mut().unwrap();
    let (mods, main) = parse_keys(spec);
    for m in &mods {
        let _ = enigo.key(*m, Direction::Press);
    }
    if let Some(k) = main {
        let _ = enigo.key(k, Direction::Click);
    }
    for m in mods.iter().rev() {
        let _ = enigo.key(*m, Direction::Release);
    }
}

/// 1つのアクション（種別＋値）。スタック実行用の軽量表現。
#[derive(Clone)]
struct Act {
    kind: String,
    value: String,
}

/// フロントのセグメント選択時に呼ばれる。表示中プロファイルの segment[index]
/// に接続されたスタックを上から順に実行する（合体ノードを順次発動）。
#[tauri::command]
fn select_segment(app: tauri::AppHandle, index: usize) {
    // 表示中パイ（ルート or サブメニュー）のスタックを集める。
    let profile = {
        let state = app.state::<CurrentProfile>();
        let guard = state.0.lock().unwrap();
        guard.clone()
    };
    let Some(profile) = profile else {
        eprintln!("[piemenu] select_segment: no current pie");
        hide_menu(&app);
        return;
    };
    let stack: Vec<Act> = profile
        .stack_for_segment(index)
        .iter()
        .map(|n| Act {
            kind: n.kind.clone(),
            value: n.value.clone(),
        })
        .collect();

    if stack.is_empty() {
        hide_menu(&app);
        return; // 未接続セグメント＝何もしない
    }
    run_stack_fast(&app, stack);
    // 窓 hide は送出経路をブロックしないよう「送出後・別スレッド」で。
    // 見た目はフロントが既に visibility:hidden で消しているので遅延しても無害。
    let h = app.clone();
    std::thread::spawn(move || hide_menu(&h));
}

/// クイックスロット（左/中クリック・ホイール上下）の発動。表示中プロファイルの
/// 該当スロットのスタックを実行する。メニューは閉じない（窓も隠さない）。
#[tauri::command]
fn select_quick(app: tauri::AppHandle, kind: String) {
    let profile = {
        let state = app.state::<CurrentProfile>();
        let guard = state.0.lock().unwrap();
        guard.clone()
    };
    let Some(profile) = profile else { return };
    let stack: Vec<Act> = profile
        .stack_for_quick(&kind)
        .iter()
        .map(|n| Act {
            kind: n.kind.clone(),
            value: n.value.clone(),
        })
        .collect();
    if stack.is_empty() {
        return; // 未接続スロット＝何もしない
    }
    // NOACTIVATE で対象アプリが前面のまま＝refocus 不要。先頭は即同期送出。
    run_stack_fast(&app, stack);
}

/// 対象アプリのウィンドウへ確実にフォーカスを戻す。
/// 単純な SetForegroundWindow は Windows の前面化ロックで失敗しやすいので、
/// 現在の前面ウィンドウのスレッドへ AttachThreadInput してから前面化する。
#[cfg(windows)]
fn refocus_target() {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId,
        SetForegroundWindow,
    };

    let h = crate::mouse_hook::target_hwnd();
    if h == 0 {
        return;
    }
    let target = HWND(h as *mut std::ffi::c_void);
    unsafe {
        // まず素直に試す（既に前面ロックを持っていれば十分）。
        if SetForegroundWindow(target).as_bool() {
            return;
        }
        // ダメなら前面ウィンドウのスレッドへ入力を結合してから前面化する。
        let fg = GetForegroundWindow();
        let fg_thread = GetWindowThreadProcessId(fg, None);
        let target_thread = GetWindowThreadProcessId(target, None);
        let cur_thread = GetCurrentThreadId();
        // 我々(cur)・前面(fg)・対象(target) のスレッド入力を結合する。
        let _ = AttachThreadInput(cur_thread, fg_thread, true);
        let _ = AttachThreadInput(cur_thread, target_thread, true);
        let _ = BringWindowToTop(target);
        let _ = SetForegroundWindow(target);
        let _ = SetFocus(Some(target));
        let _ = AttachThreadInput(cur_thread, target_thread, false);
        let _ = AttachThreadInput(cur_thread, fg_thread, false);
    }
}
#[cfg(not(windows))]
fn refocus_target() {}

/// 1つのアクションを実行する（key=送出 / launch=起動 / settings=設定窓 / menu=無視）。
fn run_one(app: &tauri::AppHandle, act: &Act) {
    match act.kind.as_str() {
        "key" => send_keys_blocking(&act.value),
        "launch" => launch_target(app, act.value.clone()),
        "settings" => {
            let h = app.clone();
            let _ = app.run_on_main_thread(move || open_settings_window(&h));
        }
        "menu" => {}
        other => eprintln!("[piemenu] unknown action kind: {other}"),
    }
}

/// 体感ラグ低減版。先頭アクションだけ「この場で同期実行」し（最速で対象へ届く）、
/// 残り（合体スタック）があれば別スレッドで間隔を空けて続行する。
/// 単発キー（お絵かきの大半）はスレッド生成も待たず即送出される。
fn run_stack_fast(app: &tauri::AppHandle, stack: Vec<Act>) {
    let mut it = stack.into_iter();
    let Some(first) = it.next() else { return };
    run_one(app, &first); // 先頭＝最速で送る
    let rest: Vec<Act> = it.collect();
    if rest.is_empty() {
        return;
    }
    // 残りは取りこぼし防止の間隔を空けつつ別スレッドで。
    let app = app.clone();
    std::thread::spawn(move || {
        for act in rest {
            std::thread::sleep(std::time::Duration::from_millis(15));
            run_one(&app, &act);
        }
    });
}


/// launch アクション: アプリ/ファイル/フォルダ/URL を開く。
/// value は実行ファイルのパス・ファイルパス・URL など。OS の既定の方法で開く。
fn launch_target(app: &tauri::AppHandle, target: String) {
    use tauri_plugin_opener::OpenerExt;

    let t = target.trim().to_string();
    if t.is_empty() {
        eprintln!("[piemenu] launch: empty target");
        return;
    }
    // ブロックしないよう別スレッドで開く（重い起動でフックや UI を止めない）。
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = app.opener().open_path(t.clone(), None::<&str>) {
            eprintln!("[piemenu] launch failed for '{t}': {e}");
        }
    });
}


/// フォーカスを外したとき等にフロントから閉じる用。
#[tauri::command]
fn close_menu(app: tauri::AppHandle) {
    hide_menu(&app);
}

/// シェイク離脱したときにフロントから呼ばれる。次の右ボタン up を握り潰させて
/// 対象アプリにコンテキストメニューを出させないようフックへ通知する。
#[tauri::command]
fn shake_dismiss(_app: tauri::AppHandle) {
    #[cfg(windows)]
    mouse_hook::mark_shake_dismissed();
}

/// 中央ハブで離した（＝パイをキャンセル）ときにフロントから呼ばれる。
/// パイ窓を隠し、元アプリへ「本来の右クリックメニュー」を出すため
/// 合成右クリックを送る。フックを1回素通しさせて自分のフックに食われるのを防ぐ。
#[tauri::command]
fn cancel_to_context_menu(app: tauri::AppHandle) {
    hide_menu(&app);
    // 右クリックは対象ウィンドウ（カーソル下）へ。フォーカスを戻してから合成。
    refocus_target();
    synth_right_click();
}

/// 合成の右クリック（down+up）を現在のカーソル位置へ送る。元アプリの
/// コンテキストメニューを出す用。低レベルフックに食われないよう
/// down/up それぞれの直前に pass_through_next() を立てる。
#[cfg(windows)]
fn synth_right_click() {
    use enigo::{Button, Direction, Enigo, Mouse, Settings};

    std::thread::spawn(move || {
        // パイ窓が隠れて元アプリが前面に戻るのを待つ。
        std::thread::sleep(std::time::Duration::from_millis(30));

        let mut enigo = match Enigo::new(&Settings::default()) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[piemenu] enigo init failed: {e}");
                return;
            }
        };

        // down と up の2イベントを素通しさせる。
        mouse_hook::pass_through_next();
        let _ = enigo.button(Button::Right, Direction::Press);
        mouse_hook::pass_through_next();
        let _ = enigo.button(Button::Right, Direction::Release);
    });
}

#[cfg(not(windows))]
fn synth_right_click() {}


/// 設定エディタ窓を開く（パイメニューは閉じる）。
#[tauri::command]
fn open_settings(app: tauri::AppHandle) {
    open_settings_window(&app);
}

/// このアプリ（実行ファイル）が置かれているフォルダを OS のファイラで開く。
/// 本番＝インストール先フォルダ、開発中（tauri dev）＝target/debug 等。
/// 設定UIの「フォルダを開く」ボタンから呼ぶ。
#[tauri::command]
fn open_app_folder(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    // 実行中の自分自身の exe パス → その親フォルダ。
    let exe = std::env::current_exe().map_err(|e| format!("current_exe error: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "exe parent dir not found".to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("open folder failed: {e}"))
}

/// 設定 JSON（config.json）が置かれているフォルダ（AppData 内）を開く。
#[tauri::command]
fn open_config_folder(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = config::config_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("open folder failed: {e}"))
}

/// 現在の設定を返す（パイメニュー・設定エディタ双方が使用）。
#[tauri::command]
fn get_config(app: tauri::AppHandle) -> Config {
    config::load(&app)
}

/// 設定を保存し、ホットキーを再登録し、パイメニュー窓に再読込を通知する。
#[tauri::command]
fn save_config(app: tauri::AppHandle, config: Config) -> Result<(), String> {
    config::save(&app, &config)?;
    apply_hotkey(&app, &config.hotkey);
    // 全プロファイル（有効なもの）の所属アプリを乗っ取り対象にする。
    mouse_hook::set_target_apps(config.all_target_apps());
    // パイメニュー窓へ「設定が変わった」イベントを送り、再描画させる。
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("config-updated", ());
    }
    Ok(())
}

/// 設定のホットキー文字列を反映する。
/// 現在はグローバルホットキー（F8 等）を**登録しない**方針：
/// メニューの起動は「対象アプリ上での右クリック」のみとし、F8 などのキーを
/// 奪わない（OS/他アプリへ素通しさせる）。既存の登録があれば解除する。
fn apply_hotkey(app: &tauri::AppHandle, _spec: &str) {
    let state = app.state::<HotkeyState>();
    let mut current = state.0.lock().unwrap();
    if let Some(old) = current.take() {
        let _ = app.global_shortcut().unregister(old);
    }
}

/// 設定UIの「最前面アプリを取得」用。現在の前面アプリの実行ファイル名を返す。
/// piemenu 自身（設定窓）が前面のときは None（自分は対象にしない）。
#[tauri::command]
fn foreground_app() -> Option<String> {
    let name = mouse_hook::current_foreground_app()?;
    // 自分自身（設定窓など）は除外する。
    if name.contains("piemenu") {
        return None;
    }
    Some(name)
}

/// アプリを終了する（トレイメニューから使用）。
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 設定エディタ窓を開く内部ヘルパー（トレイ等から使用）。
fn open_settings_window(app: &tauri::AppHandle) {
    hide_menu(app);
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.unminimize();
    }
}

/// トレイアイコンとメニュー（設定 / 終了）を作成する。
/// 既定アイコンの上に大きな赤い「✕」を重ねた「無効中」アイコンを生成する。
/// 元アイコンの RGBA を読み、対角線を太く塗って新しい Image を作る。
fn disabled_icon(base: &tauri::image::Image) -> tauri::image::Image<'static> {
    let w = base.width();
    let h = base.height();
    let mut buf = base.rgba().to_vec();
    let wi = w as i32;
    let hi = h as i32;
    // ✕ の太さ（短辺に対する割合）。
    let thick = (w.min(h) as f32 * 0.14).max(2.0);
    let put = |buf: &mut Vec<u8>, x: i32, y: i32| {
        if x < 0 || y < 0 || x >= wi || y >= hi {
            return;
        }
        let idx = ((y * wi + x) * 4) as usize;
        // 赤・不透明で上書き（うっすら縁取りはせず視認性優先）。
        buf[idx] = 230;
        buf[idx + 1] = 50;
        buf[idx + 2] = 50;
        buf[idx + 3] = 255;
    };
    // 2本の対角線（\ と /）を太く描く。各ピクセルで2本の直線への距離を見る。
    let fw = w as f32;
    let fh = h as f32;
    for y in 0..hi {
        for x in 0..wi {
            let fx = x as f32;
            let fy = y as f32;
            // 直線 \: y/h == x/w  → |fx/fw - fy/fh| を画面距離に直す。
            let d1 = (fx / fw - fy / fh).abs() * fw;
            // 直線 /: y/h == 1 - x/w
            let d2 = (fx / fw - (1.0 - fy / fh)).abs() * fw;
            if d1 <= thick || d2 <= thick {
                put(&mut buf, x, y);
            }
        }
    }
    tauri::image::Image::new_owned(buf, w, h)
}

/// トレイアイコンとメニュー項目ラベルを、現在の有効/無効状態に合わせて更新する。
fn refresh_tray_state(app: &tauri::AppHandle) {
    let enabled = mouse_hook::is_master_enabled();
    // 状態に応じたアイコン（有効＝既定、無効＝✕入り）を1度だけ生成して使い回す。
    let icon = app.default_window_icon().map(|base| {
        if enabled {
            base.clone()
        } else {
            disabled_icon(base)
        }
    });
    if let Some(tray) = app.tray_by_id("main-tray") {
        if let Some(ic) = &icon {
            let _ = tray.set_icon(Some(ic.clone()));
        }
        let _ = tray.set_tooltip(Some(if enabled {
            "右くるり"
        } else {
            "右くるり（無効中）"
        }));
    }
    // 設定窓のアイコン（タイトルバー左上＋タスクバー）も同じく差し替える。
    if let (Some(win), Some(ic)) = (app.get_webview_window("settings"), &icon) {
        let _ = win.set_icon(ic.clone());
    }
    // メニュー項目のラベルも切り替える。
    if let Some(item) = app
        .state::<TrayToggleItem>()
        .0
        .lock()
        .unwrap()
        .as_ref()
    {
        let _ = item.set_text(if enabled {
            "無効にする"
        } else {
            "有効にする"
        });
    }
}

/// トレイの有効/無効トグル項目を保持（ラベル更新のため）。
struct TrayToggleItem(Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>);

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};

    let settings_item = MenuItemBuilder::with_id("settings", "設定を開く").build(app)?;
    // 有効/無効トグル。初期は有効なのでラベルは「無効にする」。
    let toggle_item = MenuItemBuilder::with_id("toggle-enabled", "無効にする").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "終了").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&settings_item)
        .item(&toggle_item)
        .separator()
        .item(&quit_item)
        .build()?;

    // トグル項目をラベル更新用に保持。
    app.manage(TrayToggleItem(Mutex::new(Some(toggle_item))));

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("右くるり")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "settings" => open_settings_window(app),
            "toggle-enabled" => {
                // 全体の有効/無効を反転し、アイコン/ラベルを更新。
                let now = mouse_hook::is_master_enabled();
                mouse_hook::set_master_enabled(!now);
                refresh_tray_state(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左クリックで設定を開く。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                open_settings_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ホットキー: F8（動作確認用。衝突しにくい単独キー。後で設定可能にする）
    // 注: Alt+Space は Windows 予約、Ctrl+Alt+Space は IME 等と衝突しうるので避ける。
    tauri::Builder::default()
        // 多重起動を防ぐ。2個目を起動したら、既存インスタンスの設定窓を前面に
        // 出して 2個目は即終了する（フック競合・トレイ重複を防ぐ）。
        // ※必ず最初に登録する（プラグインの作法）。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            open_settings_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    // 押下(Pressed)時のみ反応。離した時は無視。
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    // 現在登録中のホットキーと一致したらトグル。
                    let state = app.state::<HotkeyState>();
                    let is_toggle = state.0.lock().unwrap().as_ref() == Some(shortcut);
                    if is_toggle {
                        toggle_menu(app);
                    }
                })
                .build(),
        )
        .manage(HotkeyState(Mutex::new(None)))
        .manage(CurrentProfile(Mutex::new(None)))
        .setup(move |app| {
            let handle = app.handle();

            // 設定からホットキーを読み込んで登録。
            let cfg = config::load(handle);
            apply_hotkey(handle, &cfg.hotkey);

            // パイメニュー窓の表示/非表示フェードを無効化（即出/即消し）。
            // さらにフォーカスを奪わない窓にする（対象アプリが前面のまま＝
            // キー送出が直接届く。砂時計／即時無視の解消）。
            if let Some(main) = app.get_webview_window("main") {
                disable_window_transitions(&main);
                make_window_noactivate(&main);
            }

            // 設定窓は × で破棄せず隠す（再度開けるように使い回す）。
            if let Some(settings) = app.get_webview_window("settings") {
                let win = settings.clone();
                settings.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win.hide();
                    }
                });
            }

            // トレイアイコンを作成。
            setup_tray(handle)?;

            // 低レベルマウスフックを開始（対象アプリ上の右クリックでパイメニュー）。
            mouse_hook::start(handle.clone());
            mouse_hook::set_target_apps(cfg.all_target_apps());

            // exe を起動したら（トレイに居るだけだと気付けないので）設定窓を開く。
            // 既に起動中に2個目を起動した場合も single-instance 側で設定窓を出す。
            open_settings_window(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            select_segment,
            select_quick,
            close_menu,
            shake_dismiss,
            open_submenu,
            open_settings,
            open_app_folder,
            open_config_folder,
            get_config,
            save_config,
            foreground_app,
            cancel_to_context_menu,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
