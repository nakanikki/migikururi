//! 【作者専用・隠し機能】Pro Micro（ATmega32u4・本物 HID キーボード）経由の
//! キー送出。config の hid_port（例 "COM11"）が設定されているときだけ使う。
//!
//! なぜ必要か: クリスタ等は SendInput（injected）のキーを 5-6F 遅れて反映する
//! （OS/アプリ側の注入経路の遅延で、送り方を変えても縮まらない。実測で確認）。
//! Pro Micro を本物の USB HID キーボードとして挟むと物理キー入力そのものに
//! なり、実測 2F まで縮む。ハードが要るので配布版では使わず、作者環境専用。
//!
//! 仕組み: Pro Micro に書き込んだファーム（tools/promicro/…）へシリアルで
//! 3バイト [0x01, modifiers, key] を送る。ファームが物理 HID キーを送出する。
//! Windows では COM ポートは "\\.\COM11" というファイルとして開いて書ける
//! ので、追加クレート無し（std のみ）で実装できる。

#[cfg(windows)]
use std::io::Write;
#[cfg(windows)]
use std::sync::Mutex;

/// 開いた COM ポート（作者環境で1つ）。設定ポート名とハンドルを保持し、
/// 名前が変わったら開き直す。
#[cfg(windows)]
struct PortState {
    name: String,
    file: Option<std::fs::File>,
}

#[cfg(windows)]
static PORT: Mutex<PortState> = Mutex::new(PortState {
    name: String::new(),
    file: None,
});

/// 設定された hid_port 名（config から反映）。空なら HID 送出を使わない。
#[cfg(windows)]
static CONFIGURED_PORT: Mutex<String> = Mutex::new(String::new());

/// config の hid_port を反映する（起動時・save_config 時に呼ぶ）。
/// **ここでポートを開いておく**のが重要: Pro Micro（Leonardo）は COM を
/// 開くと DTR トグルで1度リセット（起動に ~1秒）する。初回キー押下時に
/// 遅延で開くと、その最初の数打がリセット中の Pro Micro に当たって
/// 大きく遅れる。起動時に開いてリセットを済ませておけば、実使用時には
/// 落ち着いていて最速（2F）で届く。
#[cfg(windows)]
pub fn set_port(name: &str) {
    let name = name.trim().to_string();
    *CONFIGURED_PORT.lock().unwrap() = name.clone();
    if name.is_empty() {
        return;
    }
    eprintln!("[piemenu][hid] Pro Micro 送出を有効化: {name}");
    // 事前オープン（リセットを起動時に済ませる）。
    let mut guard = PORT.lock().unwrap();
    if guard.name != name || guard.file.is_none() {
        match open_port(&name) {
            Ok(f) => {
                guard.name = name.clone();
                guard.file = Some(f);
                eprintln!("[piemenu][hid] {name} を事前オープン（ウォームアップ）");
            }
            Err(e) => {
                eprintln!("[piemenu][hid] {name} 事前オープン失敗（初回送出時に再試行）: {e}");
            }
        }
    }
}
#[cfg(not(windows))]
pub fn set_port(_name: &str) {}

/// HID 送出が有効か（hid_port が設定されているか）。
#[cfg(windows)]
#[allow(dead_code)] // 将来トレイ表示等で使う用に残す
pub fn is_enabled() -> bool {
    !CONFIGURED_PORT.lock().unwrap().is_empty()
}
#[cfg(not(windows))]
pub fn is_enabled() -> bool {
    false
}

/// 設定ポート経由で送出を試みる。未設定・失敗なら false（SendInput へ）。
#[cfg(windows)]
pub fn try_send_configured(spec: &str) -> bool {
    let port = CONFIGURED_PORT.lock().unwrap().clone();
    if port.is_empty() {
        return false;
    }
    try_send(&port, spec)
}
#[cfg(not(windows))]
pub fn try_send_configured(_spec: &str) -> bool {
    false
}

/// modifier ビット。ファームの mods と一致させる。
#[cfg(windows)]
mod mods {
    pub const CTRL: u8 = 0x01;
    pub const SHIFT: u8 = 0x02;
    pub const ALT: u8 = 0x04;
    pub const WIN: u8 = 0x08;
}

/// spec（"Ctrl+Shift+S" 等）を (modifiers, key バイト) に変換する。
/// key はファーム側の規約: ASCII 文字はそのまま、特殊キーは 0x80〜。
/// 変換できない spec は None（呼び出し側が SendInput にフォールバック）。
#[cfg(windows)]
fn spec_to_hid(spec: &str) -> Option<(u8, u8)> {
    let mut m: u8 = 0;
    let mut key: Option<u8> = None;

    for (i, part) in spec.split('+').enumerate() {
        let token = part.trim();
        if token.is_empty() {
            // 末尾/連続 "+" 由来＝"+" キー本体。
            if i > 0 {
                key = Some(b'+');
            }
            continue;
        }
        let low = token.to_ascii_lowercase();
        match low.as_str() {
            "ctrl" | "control" => m |= mods::CTRL,
            "shift" => m |= mods::SHIFT,
            "alt" => m |= mods::ALT,
            "win" | "super" | "meta" => m |= mods::WIN,
            _ => {
                key = Some(key_byte(&low)?);
            }
        }
    }
    key.map(|k| (m, k))
}

/// キー名 → ファーム規約のキーバイト。
#[cfg(windows)]
fn key_byte(low: &str) -> Option<u8> {
    // F1〜F24 → 0x90 + (n-1)
    if let Some(num) = low.strip_prefix('f') {
        if let Ok(n) = num.parse::<u32>() {
            if (1..=24).contains(&n) {
                return Some(0x90 + (n as u8 - 1));
            }
        }
    }
    // 特殊キー。
    let special = match low {
        "enter" | "return" => 0x80,
        "esc" | "escape" => 0x81,
        "backspace" => 0x82,
        "tab" => 0x83,
        "space" => 0x84,
        "left" => 0x85,
        "right" => 0x86,
        "up" => 0x87,
        "down" => 0x88,
        "home" => 0x89,
        "end" => 0x8A,
        "pageup" => 0x8B,
        "pagedown" => 0x8C,
        "delete" | "del" => 0x8D,
        "insert" => 0x8E,
        // 記号キー（フロントは名前で渡す）。ASCII 文字へ。
        "plus" => b'+',
        "equal" => b'=',
        "minus" => b'-',
        "multiply" => b'*',
        "divide" => b'/',
        "decimal" | "period" => b'.',
        "comma" => b',',
        "slash" => b'/',
        "backslash" => b'\\',
        "semicolon" => b';',
        "quote" => b'\'',
        "backquote" => b'`',
        "bracketleft" => b'[',
        "bracketright" => b']',
        _ => 0,
    };
    if special != 0 {
        return Some(special);
    }
    // 1文字（英数字・記号）はそのまま ASCII で送る。
    if low.chars().count() == 1 {
        let c = low.chars().next().unwrap();
        if c.is_ascii() {
            return Some(c as u8);
        }
    }
    None
}

/// Windows で COM ポートをファイルとして開く。"COM11" → "\\.\COM11"。
/// 開いた後、シリアルのタイムアウトを「即時返す」設定にする。これをしないと
/// Windows シリアルドライバが書き込みをバッファ/遅延して、キー反映が数フレーム
/// 遅れる（std の File 既定は COMMTIMEOUTS 未設定で pyserial より遅い）。
#[cfg(windows)]
fn open_port(name: &str) -> std::io::Result<std::fs::File> {
    let path = format!(r"\\.\{name}");
    let file = std::fs::OpenOptions::new().read(true).write(true).open(path)?;
    configure_serial(&file);
    Ok(file)
}

/// COM ポートのタイムアウトを非ブロッキング（即時）に設定する。
/// これで WriteFile/flush が待たされず、最速でデータが Pro Micro へ渡る。
#[cfg(windows)]
fn configure_serial(file: &std::fs::File) {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Devices::Communication::{SetCommTimeouts, COMMTIMEOUTS};
    use windows::Win32::Foundation::HANDLE;

    let handle = HANDLE(file.as_raw_handle());
    // 全て0＝「即時に返す（待たない）」。読み取りは使わないので特に書き込みが重要。
    let timeouts = COMMTIMEOUTS {
        ReadIntervalTimeout: u32::MAX,
        ReadTotalTimeoutMultiplier: 0,
        ReadTotalTimeoutConstant: 0,
        WriteTotalTimeoutMultiplier: 0,
        WriteTotalTimeoutConstant: 0,
    };
    unsafe {
        if let Err(e) = SetCommTimeouts(handle, &timeouts) {
            eprintln!("[piemenu][hid] SetCommTimeouts 失敗（続行）: {e}");
        }
    }
}

/// hid_port が設定されていれば Pro Micro 経由でキー送出し true を返す。
/// 未設定・変換不能・書き込み失敗なら false（呼び出し側が SendInput へ）。
#[cfg(windows)]
pub fn try_send(port_name: &str, spec: &str) -> bool {
    if port_name.trim().is_empty() {
        return false;
    }
    let Some((m, key)) = spec_to_hid(spec) else {
        return false;
    };

    let mut guard = PORT.lock().unwrap();
    // ポート名が変わった/未オープンなら開き直す。
    if guard.name != port_name || guard.file.is_none() {
        match open_port(port_name) {
            Ok(f) => {
                guard.name = port_name.to_string();
                guard.file = Some(f);
            }
            Err(e) => {
                eprintln!("[piemenu][hid] open {port_name} failed: {e}");
                guard.file = None;
                return false;
            }
        }
    }

    let file = guard.file.as_mut().unwrap();
    match file.write_all(&[0x01, m, key]).and_then(|_| file.flush()) {
        Ok(_) => true,
        Err(e) => {
            eprintln!("[piemenu][hid] write failed: {e}");
            guard.file = None; // 次回開き直す
            false
        }
    }
}

#[cfg(not(windows))]
pub fn try_send(_port_name: &str, _spec: &str) -> bool {
    false
}
