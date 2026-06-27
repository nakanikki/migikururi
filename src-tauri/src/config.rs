use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

/// メニュー項目が実行するアクション。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Action {
    /// 種別。今は "key" のみ対応（将来 "launch" 等を追加）。
    #[serde(rename = "type")]
    pub kind: String,
    /// "Ctrl+C" のようなキー指定（kind=="key" のとき）。
    pub value: String,
}

/// パイメニューの1項目（旧形式）。新形式では Segment + ActionNode に分離する。
/// 旧 config.json 読み込みと migrate のためだけに残す。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MenuItem {
    pub label: String,
    pub color: String,
    pub action: Action,
}

/// パイのスロット（見た目）。発動時は head が指すアクションノードから
/// next を辿って順に実行する。head が None なら未接続＝何もしない。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub label: String,
    pub color: String,
    /// 接続スタックの先頭ノード id（未接続なら None）。
    #[serde(default)]
    pub head: Option<String>,
    /// ユーザーが手動で色を設定したか（項目数変更時の自動再配色から除外）。
    #[serde(default)]
    pub custom_color: bool,
}

/// クイックスロット。右クリック押しっぱなし中に、追加マウス操作
/// （左/中クリック・ホイール上/下）で発動する位置非依存アクション。
/// セグメントと同じく head でノードスタックへ配線する。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickSlot {
    /// 種別 "left" | "middle" | "wheel_up" | "wheel_down"。
    pub kind: String,
    /// 接続スタックの先頭ノード id（未接続なら None）。
    #[serde(default)]
    pub head: Option<String>,
    /// キャンバス上の位置。
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

/// アクションノード。キャンバスに自由配置でき、未接続でも置いておける。
/// next で下に合体したノード（連結リスト）を指す。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionNode {
    /// 一意 id（接続・合体の参照用）。
    pub id: String,
    /// 種別 "key" / "launch"。
    #[serde(rename = "type")]
    pub kind: String,
    /// 値（"Ctrl+C" やパス/URL）。
    pub value: String,
    /// キャンバス上の位置。
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    /// 下に合体した次ノードの id（無ければ None＝スタックの末尾）。
    #[serde(default)]
    pub next: Option<String>,
    /// kind=="menu" のとき、このノード自身が持つインラインのサブメニュー
    /// （新規・独立。別プロファイル参照はしない）。Profile と同形だが
    /// id/name/enabled は省略可（serde default）。
    #[serde(default)]
    pub submenu: Option<Box<Profile>>,
    /// 設定エディタでの内包ボックス（メニューブロック）のサイズ。表示専用で
    /// 本番動作には影響しない。保存して再起動後も維持する。
    #[serde(rename = "embedW", default, skip_serializing_if = "Option::is_none")]
    pub embed_w: Option<f64>,
    #[serde(rename = "embedH", default, skip_serializing_if = "Option::is_none")]
    pub embed_h: Option<f64>,
}

/// 対象アプリ（キャンバスに自由配置できるパネル）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppNode {
    /// 実行ファイル名（例 "blender.exe"）。
    pub name: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    /// 有効/無効。無効なら右クリック対象から外す。
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// 1つのプロファイル。所属アプリで右クリックするとこのパイが出る。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    /// 一意 ID（カードの自由配置・参照用）。サブメニュー（インライン）では
    /// 持たないので default 可。
    #[serde(default)]
    pub id: String,
    /// 表示名（"プロファイルA" 等）。サブメニューでは持たないので default 可。
    #[serde(default)]
    pub name: String,
    /// 無効プロファイル。所属アプリで右クリックしても乗っ取らない（通常の右クリック）。
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// パイのスロット群（見た目＋接続先）。
    #[serde(default)]
    pub segments: Vec<Segment>,
    /// アクションノード群（キャンバス自由配置）。
    #[serde(default)]
    pub nodes: Vec<ActionNode>,
    /// このプロファイルに属するアプリ（キャンバス自由配置パネル）。
    #[serde(default)]
    pub app_nodes: Vec<AppNode>,
    /// クイックスロット（左/中クリック・ホイール上下）。既定で4つ。
    #[serde(default = "default_quick_slots")]
    pub quick_slots: Vec<QuickSlot>,
    /// 本番メニュー表示中にクイックスロット HUD（マウス絵）を表示するか。
    #[serde(default = "default_true")]
    pub quick_hud_visible: bool,
    /// 本番メニューでパイ本体（セグメント）を表示するか。
    #[serde(default = "default_true")]
    pub pie_visible: bool,
    /// パイの外周半径（本番表示 px）。
    #[serde(default = "default_outer_r")]
    pub outer_r: f64,
    /// パイの内径（中央ブランク半径 px。右クリックデフォルト領域）。
    #[serde(default = "default_inner_r")]
    pub inner_r: f64,
    /// パイ全体の回転（度）。2項目を左右にする等。既定 0。
    #[serde(default)]
    pub rotation: f64,
    /// パイ全体の不透明度（0.0〜1.0）。
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    /// 外周より外でも、その方向のセグメントを選択扱いにする（外側有効）。
    #[serde(default)]
    pub outer_active: bool,
    /// マウスシェイクで表示中のメニューを消せるようにする（シェイク離脱）。
    #[serde(default = "default_true")]
    pub shake_dismiss: bool,
    /// 大事フラグ。設定画面でタブの削除ボタンを隠して誤削除を防ぐ。
    #[serde(default)]
    pub protected: bool,
    /// 即時アクション。項目へカーソルを移動しただけで発動を確定する。
    #[serde(default)]
    pub instant_action: bool,

    // ── 旧形式（読み込み互換のためだけ。保存しない） ──
    /// 旧: items。migrate で segments+nodes へ変換。
    #[serde(default, skip_serializing)]
    items: Vec<MenuItem>,
    /// 旧: apps（文字列配列）。migrate で app_nodes へ変換。
    #[serde(default, skip_serializing)]
    apps: Vec<String>,
}

fn default_true() -> bool {
    true
}
fn default_outer_r() -> f64 {
    160.0
}
fn default_inner_r() -> f64 {
    56.0
}
fn default_opacity() -> f64 {
    1.0
}
/// 既定の4クイックスロット（左/中クリック・ホイール上下）。マウス絵の
/// 各ボタン位置に対応する初期配置。配線は未接続で開始。
fn default_quick_slots() -> Vec<QuickSlot> {
    // パイ（中心 ~300,300・半径 ~160）に被らないよう左下へ。パネルは left の
    // x/y を基準に1ブロックで描くので 4 つとも同じ座標で良い。
    vec![
        QuickSlot { kind: "left".into(), head: None, x: 40.0, y: 500.0 },
        QuickSlot { kind: "middle".into(), head: None, x: 40.0, y: 500.0 },
        QuickSlot { kind: "wheel_up".into(), head: None, x: 40.0, y: 500.0 },
        QuickSlot { kind: "wheel_down".into(), head: None, x: 40.0, y: 500.0 },
    ]
}

impl Profile {
    /// head から next を辿り、スタックの全ノードを上から順に返す。
    /// 循環参照しても無限ループしないよう訪問済みで打ち切る。
    pub fn stack_from<'a>(&'a self, head: &str) -> Vec<&'a ActionNode> {
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut cur = Some(head.to_string());
        while let Some(id) = cur {
            if !seen.insert(id.clone()) {
                break; // 循環防止
            }
            match self.nodes.iter().find(|n| n.id == id) {
                Some(node) => {
                    out.push(node);
                    cur = node.next.clone();
                }
                None => break,
            }
        }
        out
    }

    /// segment index のスタック（先頭から末尾まで）を返す。未接続なら空。
    pub fn stack_for_segment(&self, seg_index: usize) -> Vec<&ActionNode> {
        match self.segments.get(seg_index).and_then(|s| s.head.as_ref()) {
            Some(head) => self.stack_from(head),
            None => Vec::new(),
        }
    }

    /// クイックスロット（kind）のスタックを返す。未接続/未定義なら空。
    pub fn stack_for_quick(&self, kind: &str) -> Vec<&ActionNode> {
        match self
            .quick_slots
            .iter()
            .find(|q| q.kind == kind)
            .and_then(|q| q.head.as_ref())
        {
            Some(head) => self.stack_from(head),
            None => Vec::new(),
        }
    }

    /// 表示用にラベルを解決したセグメント群を返す。
    /// 手動ラベルが空なら接続内容から自動命名（未接続は「未設定」）。
    /// 本番メニューへ送る前に呼ぶ（フロントは nodes を持たないため）。
    pub fn resolved_segments(&self) -> Vec<Segment> {
        self.segments
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let mut s = s.clone();
                if s.label.trim().is_empty() {
                    s.label = self.auto_seg_name(i);
                }
                s
            })
            .collect()
    }

    /// 各セグメントがサブメニューを持つか（接続スタックの先頭が kind=="menu"
    /// かつ submenu を持つ）。フロントはこれを見てホバーでサブメニューを開く。
    pub fn segment_has_submenu(&self) -> Vec<bool> {
        (0..self.segments.len())
            .map(|i| self.segment_submenu(i).is_some())
            .collect()
    }

    /// 指定セグメントのサブメニュー実体（接続スタック先頭ノードのインライン
    /// submenu）を複製して返す。無ければ None。
    pub fn segment_submenu(&self, seg_index: usize) -> Option<Profile> {
        let stack = self.stack_for_segment(seg_index);
        let head = stack.first()?;
        if head.kind != "menu" {
            return None;
        }
        head.submenu.as_ref().map(|b| (**b).clone())
    }

    /// セグメントの接続内容から自動の名前を作る（JS 側 autoSegName と同じ規則）。
    fn auto_seg_name(&self, seg_index: usize) -> String {
        let stack = self.stack_for_segment(seg_index);
        let names: Vec<String> = stack
            .iter()
            .map(|n| node_short_name(n))
            .filter(|s| !s.is_empty())
            .collect();
        if names.is_empty() {
            return "未設定".to_string();
        }
        let shown = names.iter().take(2).cloned().collect::<Vec<_>>().join("→");
        if names.len() > 2 {
            format!("{shown}…")
        } else {
            shown
        }
    }

    /// 表示用にラベルを解決したクイックスロット群を返す（本番メニュー用）。
    pub fn resolved_quick_slots(&self) -> Vec<ResolvedQuick> {
        self.quick_slots
            .iter()
            .map(|q| {
                let names: Vec<String> = self
                    .stack_for_quick(&q.kind)
                    .iter()
                    .map(|n| node_short_name(n))
                    .filter(|s| !s.is_empty())
                    .collect();
                let label = if names.is_empty() {
                    String::new()
                } else {
                    let shown = names.iter().take(2).cloned().collect::<Vec<_>>().join("→");
                    if names.len() > 2 {
                        format!("{shown}…")
                    } else {
                        shown
                    }
                };
                ResolvedQuick {
                    kind: q.kind.clone(),
                    label,
                }
            })
            .collect()
    }
}

/// 本番メニューへ送るクイックスロットの表示情報。
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedQuick {
    pub kind: String,
    pub label: String,
}

/// 1ノードを簡潔な文言にする。例: キー→"Ctrl+C"、起動→"notepad起動"。
fn node_short_name(node: &ActionNode) -> String {
    let val = node.value.trim();
    match node.kind.as_str() {
        "settings" => "設定を開く".to_string(),
        "menu" => "サブメニュー".to_string(),
        "launch" => {
            if val.is_empty() {
                return String::new();
            }
            // パス/URL から末尾の名前を取り、拡張子を落として「○○起動」。
            let tail = val.rsplit(['\\', '/']).next().unwrap_or(val);
            let base = tail.rsplit_once('.').map(|(a, _)| a).unwrap_or(tail);
            format!("{base}起動")
        }
        // key（既定）
        _ => val.to_string(),
    }
}

/// アプリ全体の設定。
///
/// 旧形式（hotkey + items + right_click_apps の単一構成）から、複数プロファイル
/// 構成へ移行した。旧 config.json は migrate() で profiles 1個に変換して読み込む。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// メニュー開閉ホットキー（全体共通）。
    pub hotkey: String,
    /// プロファイル群。
    #[serde(default)]
    pub profiles: Vec<Profile>,
    /// F8 トグルなどアプリ非紐付け時に表示するプロファイルの id。
    /// 未設定/無効 id のときは先頭プロファイルを使う。
    #[serde(default)]
    pub active_profile: Option<String>,

    // ── 旧形式フィールド（読み込み互換のためだけに受ける。保存はしない） ──
    /// 旧: 単一の items。新形式では使わない。migrate でプロファイルへ移す。
    #[serde(default, skip_serializing)]
    items: Vec<MenuItem>,
    /// 旧: 単一の対象アプリ。migrate でプロファイルへ移す。
    #[serde(default, skip_serializing)]
    right_click_apps: Vec<String>,
}

/// 旧 apps（文字列配列）を AppNode へ。初期配置はパイの下に縦に並べる。
fn apps_to_app_nodes(apps: &[String]) -> Vec<AppNode> {
    apps.iter()
        .enumerate()
        .map(|(i, name)| AppNode {
            name: name.clone(),
            x: 360.0,
            y: 360.0 + i as f64 * 44.0,
            enabled: true,
        })
        .collect()
}

/// 旧形式のデフォルト項目（migrate のフォールバック用）。
fn default_items() -> Vec<MenuItem> {
    let item = |label: &str, color: &str, key: &str| MenuItem {
        label: label.into(),
        color: color.into(),
        action: Action {
            kind: "key".into(),
            value: key.into(),
        },
    };
    vec![
        item("Copy", "#4f8cff", "Ctrl+C"),
        item("Paste", "#28c76f", "Ctrl+V"),
        item("Cut", "#ff9f43", "Ctrl+X"),
        item("Undo", "#ea5455", "Ctrl+Z"),
        item("Save", "#a66bff", "Ctrl+S"),
        item("Find", "#00cfe8", "Ctrl+F"),
    ]
}

/// MenuItem 群を Segment+ActionNode へ変換する（1項目＝1セグメント＋1ノード）。
/// ノードはパイの右側に縦に並べる初期配置にする。
fn items_to_segments_nodes(items: &[MenuItem]) -> (Vec<Segment>, Vec<ActionNode>) {
    let mut segments = Vec::new();
    let mut nodes = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let id = format!("n{i}");
        segments.push(Segment {
            label: item.label.clone(),
            color: item.color.clone(),
            head: Some(id.clone()),
            custom_color: false,
        });
        nodes.push(ActionNode {
            id,
            kind: item.action.kind.clone(),
            value: item.action.value.clone(),
            x: 360.0,
            y: 20.0 + i as f64 * 70.0,
            next: None,
            submenu: None,
            embed_w: None,
            embed_h: None,
        });
    }
    (segments, nodes)
}

/// デフォルトプロファイルを生成する。
fn default_profile() -> Profile {
    let (segments, nodes) = items_to_segments_nodes(&default_items());
    Profile {
        id: "default".into(),
        name: "デフォルト".into(),
        enabled: true,
        segments,
        nodes,
        app_nodes: Vec::new(),
        quick_slots: default_quick_slots(),
        quick_hud_visible: true,
        pie_visible: true,
        outer_r: default_outer_r(),
        inner_r: default_inner_r(),
            rotation: 0.0,
        opacity: default_opacity(),
        outer_active: false,
        shake_dismiss: true,
        protected: false,
        instant_action: false,
        items: Vec::new(),
        apps: Vec::new(),
    }
}

impl Default for Config {
    fn default() -> Self {
        Config {
            hotkey: "F8".into(),
            profiles: vec![default_profile()],
            active_profile: Some("default".into()),
            items: Vec::new(),
            right_click_apps: Vec::new(),
        }
    }
}

impl Config {
    /// 旧形式を新形式（segments+nodes）へ移行する。読み込み直後に呼ぶ。
    /// ①最旧形式（Config.items 直下）→ プロファイル1個へ。
    /// ②旧プロファイル形式（Profile.items あり segments 空）→ segments+nodes へ。
    fn migrate(&mut self) {
        // ① 最旧形式: profiles が空で Config.items を持つ。
        if self.profiles.is_empty() {
            let items = if self.items.is_empty() {
                default_items()
            } else {
                std::mem::take(&mut self.items)
            };
            let apps = std::mem::take(&mut self.right_click_apps);
            let (segments, nodes) = items_to_segments_nodes(&items);
            self.profiles = vec![Profile {
                id: "default".into(),
                name: "デフォルト".into(),
                enabled: true,
                segments,
                nodes,
                app_nodes: apps_to_app_nodes(&apps),
                quick_slots: default_quick_slots(),
                quick_hud_visible: true,
                pie_visible: true,
                outer_r: default_outer_r(),
                inner_r: default_inner_r(),
            rotation: 0.0,
                opacity: default_opacity(),
                outer_active: false,
                shake_dismiss: true,
                protected: false,
                instant_action: false,
                items: Vec::new(),
                apps: Vec::new(),
            }];
        }

        // ② 各プロファイル: 旧 items / 旧 apps を新形式へ変換。
        for p in &mut self.profiles {
            if p.segments.is_empty() && !p.items.is_empty() {
                let items = std::mem::take(&mut p.items);
                let (segments, nodes) = items_to_segments_nodes(&items);
                p.segments = segments;
                p.nodes = nodes;
            }
            if p.app_nodes.is_empty() && !p.apps.is_empty() {
                let apps = std::mem::take(&mut p.apps);
                p.app_nodes = apps_to_app_nodes(&apps);
            }
        }

        if self.active_profile.is_none() {
            self.active_profile = self.profiles.first().map(|p| p.id.clone());
        }
    }

    /// 前面アプリ名（小文字）に対応する有効プロファイルを返す。
    /// どのプロファイルの apps にも無い、または無効なら None（乗っ取らない）。
    pub fn profile_for_app(&self, app_lower: &str) -> Option<&Profile> {
        self.profiles.iter().find(|p| {
            p.enabled
                && p.app_nodes.iter().any(|a| {
                    a.enabled && a.name.trim().to_ascii_lowercase() == app_lower
                })
        })
    }

    /// F8 トグル等で使う「アクティブプロファイル」を返す。
    /// active_profile の id があればそれ、無ければ先頭。空なら None。
    pub fn active(&self) -> Option<&Profile> {
        if let Some(id) = &self.active_profile {
            if let Some(p) = self.profiles.iter().find(|p| &p.id == id) {
                return Some(p);
            }
        }
        self.profiles.first()
    }

    /// 全プロファイルの所属アプリ（有効なもののみ）を小文字で集めて返す。
    /// マウスフックの「乗っ取り対象」判定に渡す。
    pub fn all_target_apps(&self) -> Vec<String> {
        let mut out = Vec::new();
        for p in &self.profiles {
            if !p.enabled {
                continue;
            }
            for a in &p.app_nodes {
                if !a.enabled {
                    continue;
                }
                let a = a.name.trim().to_ascii_lowercase();
                if !a.is_empty() && !out.contains(&a) {
                    out.push(a);
                }
            }
        }
        out
    }
}

/// アプリ設定ディレクトリ（config.json が入る親フォルダ）のパス。
/// 「設定JSONフォルダを開く」リンクで使う。無ければ作成する。
pub fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("config dir error: {e}"))?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("create config dir error: {e}"))?;
    }
    Ok(dir)
}

/// 設定ファイルのパス（アプリ設定ディレクトリ内 config.json）。
fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("config dir error: {e}"))?;
    Ok(dir.join("config.json"))
}

/// 設定ファイル(config.json)が既に存在するか。初回起動の判定に使う。
#[allow(dead_code)]
pub fn config_exists(app: &tauri::AppHandle) -> bool {
    match config_path(app) {
        Ok(p) => p.exists(),
        Err(_) => false,
    }
}

/// 設定を読み込む。ファイルが無ければデフォルトを作って保存する。
pub fn load(app: &tauri::AppHandle) -> Config {
    let path = match config_path(app) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[piemenu] {e}");
            return Config::default();
        }
    };

    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Config>(&text) {
            Ok(mut cfg) => {
                // 旧形式（profiles 空 + 旧 items）なら新形式へ移行する。
                cfg.migrate();
                cfg
            }
            Err(e) => {
                eprintln!("[piemenu] config parse error ({}): {e}", path.display());
                Config::default()
            }
        },
        Err(_) => {
            // 未作成 → デフォルトを保存して返す
            let cfg = Config::default();
            if let Err(e) = save(app, &cfg) {
                eprintln!("[piemenu] failed to write default config: {e}");
            }
            cfg
        }
    }
}

/// 設定を保存する。
pub fn save(app: &tauri::AppHandle, cfg: &Config) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir error: {e}"))?;
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| format!("serialize error: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("write error: {e}"))?;
    Ok(())
}
