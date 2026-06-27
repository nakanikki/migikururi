//! 低レベルマウスフック（Windows 専用）。
//! 右クリックを「対象アプリでのみ」乗っ取る。対象アプリ上では WM_RBUTTONDOWN/UP
//! を握り潰して通常の右クリックメニューを抑制し、パイメニューを表示する。
//! 対象外アプリでは何もしない（通常の右クリックのまま）。
//!
//! 安全策:
//! - コールバックでは重い処理をしない（フックが固まると全マウスが固まる）。
//! - 握り潰すのは対象アプリ上の右ボタン down/up のみ。他は必ず流す。

#[cfg(windows)]
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicUsize, Ordering};
#[cfg(windows)]
use std::sync::Mutex;

/// 右クリック乗っ取りの対象アプリ（実行ファイル名・小文字）。空なら乗っ取り無効。
#[cfg(windows)]
static TARGET_APPS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// 自分が合成した右クリックを素通しする残り回数（無限ループ防止）。
/// down/up の2イベントを素通しさせるため単一フラグでなくカウンタにする。
/// 単一フラグだと down と up の間に実イベントが割り込むとズレる。
#[cfg(windows)]
static PASS_THROUGH_COUNT: AtomicUsize = AtomicUsize::new(0);

/// アプリ全体の有効/無効（マスタースイッチ）。false の間はどのアプリでも
/// 右クリックを乗っ取らない（＝完全に通常の右クリックに戻す）。トレイの
/// 「無効にする」で切替。default は有効(true)。
#[cfg(windows)]
static MASTER_ENABLED: AtomicBool = AtomicBool::new(true);

/// アプリ全体の有効/無効を切り替える（トレイから呼ぶ）。
#[cfg(windows)]
pub fn set_master_enabled(on: bool) {
    MASTER_ENABLED.store(on, Ordering::Relaxed);
}
#[cfg(not(windows))]
pub fn set_master_enabled(_on: bool) {}

/// 現在アプリ全体が有効か。
#[cfg(windows)]
pub fn is_master_enabled() -> bool {
    MASTER_ENABLED.load(Ordering::Relaxed)
}
#[cfg(not(windows))]
pub fn is_master_enabled() -> bool {
    true
}

/// 直近の右ボタン down で乗っ取り対象と判定したか（up でも同じ扱いにする）。
/// プロセス名取得の重い呼び出しを右クリック1回につき1度に抑えるため。
#[cfg(windows)]
static CAPTURING_RIGHT: AtomicBool = AtomicBool::new(false);

/// 右ボタン押しっぱなしジェスチャが進行中か（down で立て、up で下ろす）。
/// 進行中のみ WM_MOUSEMOVE 座標をフロントへ送る。
#[cfg(windows)]
static GESTURE_ACTIVE: AtomicBool = AtomicBool::new(false);

/// ジェスチャ中の WM_MOUSEMOVE 処理を一時停止する（即時アクション発火後など）。
/// true の間はフックの move 処理をスキップしてフックを静かにし、キー送出
/// （SendInput）と競合させない。右UPでリセットされる。
#[cfg(windows)]
static MOVE_SUPPRESSED: AtomicBool = AtomicBool::new(false);

/// move 処理を一時停止/再開する（即時アクション発火時に停止する）。
#[cfg(windows)]
pub fn suppress_move(on: bool) {
    MOVE_SUPPRESSED.store(on, Ordering::Relaxed);
}
#[cfg(not(windows))]
pub fn suppress_move(_on: bool) {}

/// ジェスチャ中にクイックアクション（左/中クリック・ホイール）が1回でも
/// 使われたか。true なら右ボタンを離しても発動/右クリック送出をしない。
#[cfg(windows)]
static QUICK_USED: AtomicBool = AtomicBool::new(false);

/// シェイク離脱した（フロントから通知）。true なら右ボタン up を握り潰して
/// コンテキストメニューを出さない。up 時に消費する。
#[cfg(windows)]
static SHAKE_DISMISSED: AtomicBool = AtomicBool::new(false);

/// シェイク離脱したことをフックへ通知する（フロントから呼ぶ）。
#[cfg(windows)]
pub fn mark_shake_dismissed() {
    SHAKE_DISMISSED.store(true, Ordering::Relaxed);
}
#[cfg(not(windows))]
pub fn mark_shake_dismissed() {}

/// 乗っ取り対象の前面ウィンドウ HWND（右ボタン down 時に保存）。
/// クイックアクションのキー送出前に、このウィンドウへフォーカスを戻す。
#[cfg(windows)]
static TARGET_HWND: AtomicIsize = AtomicIsize::new(0);

/// 直近に保存した対象ウィンドウ HWND を返す（0 なら無し）。
#[cfg(windows)]
pub fn target_hwnd() -> isize {
    TARGET_HWND.load(Ordering::Relaxed)
}
#[cfg(not(windows))]
pub fn target_hwnd() -> isize {
    0
}

/// 乗っ取り対象アプリのリストを更新する（設定変更時に呼ぶ）。
#[cfg(windows)]
pub fn set_target_apps(apps: Vec<String>) {
    let lowered: Vec<String> = apps
        .iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    eprintln!("[piemenu][hook] set_target_apps -> {lowered:?}");
    *TARGET_APPS.lock().unwrap() = lowered;
}

/// 次の1イベント分、右クリックを素通しする（合成送出する直前に呼ぶ）。
/// down と up で2回呼べば2イベント分素通しされる。
#[cfg(windows)]
pub fn pass_through_next() {
    PASS_THROUGH_COUNT.fetch_add(1, Ordering::Relaxed);
}

/// 指定 HWND の実行ファイル名（小文字）を取得する。
#[cfg(windows)]
fn process_name_of_hwnd(
    hwnd: windows::Win32::Foundation::HWND,
) -> Option<String> {
    use windows::Win32::Foundation::{CloseHandle, MAX_PATH};
    use windows::Win32::System::ProcessStatus::GetModuleBaseNameW;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    unsafe {
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let handle =
            OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid).ok()?;
        let mut buf = [0u16; MAX_PATH as usize];
        let len = GetModuleBaseNameW(handle, None, &mut buf);
        let _ = CloseHandle(handle);
        if len == 0 {
            return None;
        }
        let name = String::from_utf16_lossy(&buf[..len as usize]);
        Some(name.to_ascii_lowercase())
    }
}

/// 現在の前面ウィンドウの実行ファイル名（小文字）を取得する。
#[cfg(windows)]
fn foreground_process_name() -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe { process_name_of_hwnd(GetForegroundWindow()) }
}

/// スクリーン座標 (x, y) の下にあるトップレベルウィンドウの HWND を返す。
#[cfg(windows)]
fn toplevel_hwnd_at(x: i32, y: i32) -> windows::Win32::Foundation::HWND {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT};
    unsafe {
        let h = WindowFromPoint(POINT { x, y });
        if h.0.is_null() {
            h
        } else {
            // 子コントロールではなくトップレベルのルートウィンドウを得る。
            GetAncestor(h, GA_ROOT)
        }
    }
}

/// 現在前面のアプリの実行ファイル名（小文字）を返す。設定UIの
/// 「最前面アプリを取得」用。取得できなければ None。
#[cfg(windows)]
pub fn current_foreground_app() -> Option<String> {
    foreground_process_name()
}

#[cfg(not(windows))]
pub fn current_foreground_app() -> Option<String> {
    None
}

/// 右クリック位置(x,y)で乗っ取り対象を判定する。判定は「カーソルの直下にある
/// ウィンドウのアプリ」だけで行う（フォーカス＝前面アプリは見ない）。
/// 例: 対象アプリにフォーカスがあっても、カーソルが別アプリの上なら奪わない。
/// 対象なら実行ファイル名（小文字）を返し、対象 HWND を覚える（クイック
/// アクションのキー送出・フォーカス復帰先）。
#[cfg(windows)]
fn target_at_point(x: i32, y: i32) -> Option<String> {
    // フックコールバックから呼ばれる。重い I/O は厳禁。
    // アプリ全体が無効なら、どのアプリでも乗っ取らない（通常の右クリックに戻す）。
    if !MASTER_ENABLED.load(Ordering::Relaxed) {
        return None;
    }
    let targets = TARGET_APPS.lock().unwrap();
    if targets.is_empty() {
        return None;
    }

    // カーソルの直下にあるトップレベルウィンドウのアプリで判定する。
    // ここが対象でなければ奪わない（前面アプリへはフォールバックしない）。
    let under = toplevel_hwnd_at(x, y);
    if let Some(name) = process_name_of_hwnd(under) {
        if targets.iter().any(|t| t == &name) {
            TARGET_HWND.store(under.0 as isize, Ordering::Relaxed);
            return Some(name);
        }
    }
    None
}

#[cfg(windows)]
pub fn start(app: tauri::AppHandle) {
    use std::cell::RefCell;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, HHOOK, MSG, MSLLHOOKSTRUCT,
        WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP,
        WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP,
    };

    thread_local! {
        static APP: RefCell<Option<tauri::AppHandle>> = const { RefCell::new(None) };
        static HOOK: RefCell<HHOOK> = const { RefCell::new(HHOOK(std::ptr::null_mut())) };
    }

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let msg = wparam.0 as u32;

            // ジェスチャ中のマウス移動: ホバー強調用に座標をフロントへ送る。
            // 移動自体は対象アプリへ常に流す（握り潰さない＝サブメニュー等の
            // マウス操作を妨げない）。即時アクション発火後（MOVE_SUPPRESSED）は
            // 我々の処理だけスキップしてフックを軽くする（流す動作は維持）。
            if msg == WM_MOUSEMOVE
                && GESTURE_ACTIVE.load(Ordering::Relaxed)
                && !MOVE_SUPPRESSED.load(Ordering::Relaxed)
            {
                let pt = (*(lparam.0 as *const MSLLHOOKSTRUCT)).pt;
                if crate::try_instant_fire(pt.x, pt.y) {
                    QUICK_USED.store(true, Ordering::Relaxed); // 右UPで本来メニューを出さない
                    MOVE_SUPPRESSED.store(true, Ordering::Relaxed); // 以降の move 処理を止める
                    APP.with(|a| {
                        if let Some(app) = a.borrow().as_ref() {
                            crate::instant_fired(app);
                        }
                    });
                } else {
                    // 通常はホバー強調用に座標をフロントへ送る。
                    APP.with(|a| {
                        if let Some(app) = a.borrow().as_ref() {
                            crate::gesture_move(app, pt.x, pt.y);
                        }
                    });
                }
            }

            // ジェスチャ中（右押しっぱなし）の追加マウス操作 → クイックアクション。
            // 左/中クリック・ホイール上下を「クイックスロット」として発動し、
            // OS には流さない（握り潰す）。down のみ拾い、対応する up も握り潰す。
            if GESTURE_ACTIVE.load(Ordering::Relaxed) {
                let kind: Option<&str> = match msg {
                    WM_LBUTTONDOWN => Some("left"),
                    WM_MBUTTONDOWN => Some("middle"),
                    WM_MOUSEWHEEL => {
                        // ホイール量は mouseData の上位ワード（符号付き）。
                        let data = (*(lparam.0 as *const MSLLHOOKSTRUCT)).mouseData;
                        let delta = ((data >> 16) & 0xffff) as i16;
                        if delta > 0 {
                            Some("wheel_up")
                        } else if delta < 0 {
                            Some("wheel_down")
                        } else {
                            None
                        }
                    }
                    _ => None,
                };
                if let Some(k) = kind {
                    QUICK_USED.store(true, Ordering::Relaxed);
                    APP.with(|a| {
                        if let Some(app) = a.borrow().as_ref() {
                            crate::quick_action(app, k.to_string());
                        }
                    });
                    return LRESULT(1); // 握り潰す（アプリへ送らない）
                }
                // 対応する up も握り潰す（down を消したので up だけ届くと誤動作する）。
                if msg == WM_LBUTTONUP || msg == WM_MBUTTONUP {
                    return LRESULT(1);
                }
            }

            let is_right = msg == WM_RBUTTONDOWN || msg == WM_RBUTTONUP;

            if is_right {
                // 自分が合成した右クリックは素通し（無限ループ防止）。
                // カウンタが残っていれば1消費して下流に流す。
                if PASS_THROUGH_COUNT.load(Ordering::Relaxed) > 0 {
                    PASS_THROUGH_COUNT.fetch_sub(1, Ordering::Relaxed);
                    let hook = HOOK.with(|h| *h.borrow());
                    return CallNextHookEx(Some(hook), code, wparam, lparam);
                }

                // 対象アプリ上でのみ乗っ取る。判定（プロセス名取得）は重いので
                // down の時だけ行い、結果を覚えて up でも同じ扱いにする。
                let capture = if msg == WM_RBUTTONDOWN {
                    // カーソル位置（スクリーン物理座標）で判定。フォーカスが別アプリ
                    // でも、対象アプリのウィンドウ上なら乗っ取る。
                    let pt = (*(lparam.0 as *const MSLLHOOKSTRUCT)).pt;
                    let target = target_at_point(pt.x, pt.y);
                    let hit = target.is_some();
                    CAPTURING_RIGHT.store(hit, Ordering::Relaxed);
                    if let Some(name) = target {
                        GESTURE_ACTIVE.store(true, Ordering::Relaxed);
                        QUICK_USED.store(false, Ordering::Relaxed); // 新ジェスチャ開始
                        MOVE_SUPPRESSED.store(false, Ordering::Relaxed); // move 処理再開
                        SHAKE_DISMISSED.store(false, Ordering::Relaxed);
                        APP.with(|a| {
                            if let Some(app) = a.borrow().as_ref() {
                                crate::request_show_menu(app, name);
                            }
                        });
                    }
                    hit
                } else {
                    // WM_RBUTTONUP。通常は down を握り潰しているので up は流す
                    // （down なしの up は無害）。ただしクイックアクションを使った
                    // ときは refocus で対象アプリが前面に戻っているため、up を流すと
                    // コンテキストメニューが出てしまう。その場合は up も握り潰す。
                    let cap = CAPTURING_RIGHT.load(Ordering::Relaxed);
                    let mut swallow_up = false;
                    if cap {
                        CAPTURING_RIGHT.store(false, Ordering::Relaxed);
                        GESTURE_ACTIVE.store(false, Ordering::Relaxed);
                        MOVE_SUPPRESSED.store(false, Ordering::Relaxed);
                        let quick_used = QUICK_USED.swap(false, Ordering::Relaxed);
                        let shaken = SHAKE_DISMISSED.swap(false, Ordering::Relaxed);
                        // クイック使用時・シェイク離脱時は up を握り潰す
                        // （対象アプリにコンテキストメニューを出さない）。
                        swallow_up = quick_used || shaken;
                        let pt = (*(lparam.0 as *const MSLLHOOKSTRUCT)).pt;
                        APP.with(|a| {
                            if let Some(app) = a.borrow().as_ref() {
                                crate::gesture_release(app, pt.x, pt.y, quick_used);
                            }
                        });
                    }
                    swallow_up
                };

                if capture {
                    // down は常に握り潰す。up はクイック使用時のみ握り潰す
                    // （コンテキストメニュー抑制）。
                    return LRESULT(1);
                }
            }
        }
        let hook = HOOK.with(|h| *h.borrow());
        CallNextHookEx(Some(hook), code, wparam, lparam)
    }

    std::thread::spawn(move || unsafe {
        APP.with(|a| *a.borrow_mut() = Some(app));

        let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), None, 0) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[piemenu] SetWindowsHookExW failed: {e}");
                return;
            }
        };
        HOOK.with(|h| *h.borrow_mut() = hook);
        println!("[piemenu] mouse hook installed (per-app capture)");

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
    });
}

#[cfg(not(windows))]
pub fn start(_app: tauri::AppHandle) {}

#[cfg(not(windows))]
pub fn set_target_apps(_apps: Vec<String>) {}

#[cfg(not(windows))]
pub fn pass_through_next() {}
