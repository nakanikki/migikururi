const { getCurrentWindow } = window.__TAURI__.window;
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const appWindow = getCurrentWindow();

// メニュー項目は設定(config.json)から読み込む。get_config で取得。
let items = [];

// 各セグメントの DOM(g 要素)を index 順に保持（ホバーハイライト用）。
let segEls = [];
// 選択中アウトライン用の path（別レイヤ・index 順）。
let outlineEls = [];
// 現在ハイライト中のセグメント index（-1 = なし／中央ハブ）。
let hoverIndex = -1;

// パイの寸法（SVG ユーザー座標）。半径はプロファイル設定で可変なので、
// 描画領域(SVG_SIZE)と中心(CENTER)も外周半径に合わせて毎回計算する。
const SVG_MARGIN = 30; // 外周の外側マージン(px)
let SVG_SIZE = 360; // 描画領域(px)。recalcSize() で更新。
let CENTER = SVG_SIZE / 2;
// 半径はプロファイル設定で可変（menu-items イベントで上書きされる）。
let OUTER_R = 160; // 外周半径
let INNER_R = 56; // 中央の穴（ドーナツ内径）
const GAP_DEG = 0; // セグメント間の隙間（度）。0＝隙間なし
let LABEL_R = (OUTER_R + INNER_R) / 2; // ラベルを置く半径
// 外側有効: 外周より外でも、その方向のセグメントを選択扱いにする。
let OUTER_ACTIVE = false;
// 回転(度): パイ全体の角度オフセット。2項目を左右にする等。既定 0=最初のセグメント中心が真上。
let ROTATION = 0;
// シェイク離脱: マウスシェイクで表示中のメニューを消せるようにする。
let SHAKE_DISMISS = true;
// 即時アクション: 項目へカーソルを移動した瞬間に発動を確定する。
let INSTANT_ACTION = false;
// クイックスロット表示情報 [{ kind, label }]（左/中クリック・ホイール上下）。
let quickSlots = [];
// 本番メニュー表示中にクイックスロット HUD を表示するか（プロファイル設定）。
let QUICK_HUD_VISIBLE = true;
// 本番メニューでパイ本体（セグメント）を表示するか（プロファイル設定）。
let PIE_VISIBLE = true;
// 各セグメントのサブメニュー先プロファイル id（メニュー種別なら文字列）。
let segmentSubmenus = [];
// 直近にサブメニューを開いたセグメント index（同じ所で連発しない用）。
let lastSubmenuSeg = -1;
// サブメニューのネスト深さ（親=0）。上限を超えたら開かない。
let submenuDepth = 0;
const SUBMENU_MAX_DEPTH = 5;

// 外周半径に合わせて描画領域サイズと中心を再計算する。
function recalcSize() {
  SVG_SIZE = (OUTER_R + SVG_MARGIN) * 2;
  CENTER = SVG_SIZE / 2;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function hideMenu() {
  // OS のウィンドウ非表示フェードを待たず、見た目を即座に消す。
  hideOverlayInstant();
  // 実際の窓非表示は Rust 経由（Esc 解除等もまとめるため）。
  invoke("close_menu").catch((e) =>
    console.error("[piemenu] close_menu failed:", e),
  );
}

// オーバーレイを即座に非表示にする（CSS アニメなし）。
function hideOverlayInstant() {
  const overlay = document.getElementById("overlay");
  if (overlay) overlay.style.visibility = "hidden";
  const hud = document.getElementById("quick-hud");
  if (hud) hud.classList.remove("show");
}

// オーバーレイを再表示する（次に窓が出るとき用）。
function showOverlay() {
  const overlay = document.getElementById("overlay");
  if (overlay) overlay.style.visibility = "visible";
}

// 極座標 → 直交座標。角度は「真上を0、時計回り」を採用。
function polar(radius, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: CENTER + radius * Math.cos(rad), y: CENTER + radius * Math.sin(rad) };
}

// ドーナツ扇形(アニュラスセクター)の path d を作る。
function sectorPath(startDeg, endDeg) {
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  const oStart = polar(OUTER_R, startDeg);
  const oEnd = polar(OUTER_R, endDeg);
  const iEnd = polar(INNER_R, endDeg);
  const iStart = polar(INNER_R, startDeg);
  return [
    `M ${oStart.x} ${oStart.y}`,
    `A ${OUTER_R} ${OUTER_R} 0 ${largeArc} 1 ${oEnd.x} ${oEnd.y}`,
    `L ${iEnd.x} ${iEnd.y}`,
    `A ${INNER_R} ${INNER_R} 0 ${largeArc} 0 ${iStart.x} ${iStart.y}`,
    "Z",
  ].join(" ");
}

function buildPie() {
  const pie = document.getElementById("pie");
  pie.innerHTML = "";

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", SVG_SIZE);
  svg.setAttribute("height", SVG_SIZE);
  svg.setAttribute("viewBox", `0 0 ${SVG_SIZE} ${SVG_SIZE}`);

  // 選択中アウトライン専用レイヤ（#pie の opacity の影響を受けない）。
  const outline = document.getElementById("pie-outline");
  outline.innerHTML = "";
  const oSvg = document.createElementNS(SVG_NS, "svg");
  oSvg.setAttribute("width", SVG_SIZE);
  oSvg.setAttribute("height", SVG_SIZE);
  oSvg.setAttribute("viewBox", `0 0 ${SVG_SIZE} ${SVG_SIZE}`);

  const n = items.length;
  const slice = 360 / n;
  // 最初のセグメントの「中心」を真上(0°)に置く（-slice/2 オフセット）。
  // これにより 4 個＝上右下左、8 個＝8方位 と自然な配置になる。
  // ROTATION で全体を回せる（2項目を左右に等）。
  const off = -slice / 2 + ROTATION;
  segEls = [];
  outlineEls = [];
  const labelInfos = []; // ラベルの位置・文字（最前面レイヤ用）

  items.forEach((item, i) => {
    const start = i * slice + GAP_DEG / 2 + off;
    const end = (i + 1) * slice - GAP_DEG / 2 + off;
    const mid = (start + end) / 2;

    // 同じ扇形パスをアウトライン用にも作る（別レイヤ・常に不透明）。
    const oPath = document.createElementNS(SVG_NS, "path");
    oPath.setAttribute("d", sectorPath(start, end));
    oPath.setAttribute("class", "seg-outline");
    oSvg.appendChild(oPath);
    outlineEls.push(oPath);

    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "seg");

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", sectorPath(start, end));
    path.setAttribute("fill", item.color);
    g.appendChild(path);

    // ラベルはあとで最前面レイヤにまとめて描く（位置だけ覚えておく）。
    labelInfos.push({ x: polar(LABEL_R, mid).x, y: polar(LABEL_R, mid).y, label: item.label });

    // クリックモード（F8 トグル表示）のときは従来通り左クリックで選択。
    // ジェスチャモード（右押しっぱなし）のときは release 判定で発動するので無視。
    g.addEventListener("click", () => {
      if (!gestureMode) onSelect(i);
    });
    segEls.push(g);
    svg.appendChild(g);
  });

  // ラベル: 全セグメントの上に「薄い黒の背景帯＋最前面の文字」で描く。
  // 細いパイでラベルが隣の扇形や枠と重なっても読めるようにする。
  const bgLayer = document.createElementNS(SVG_NS, "g");
  const textLayer = document.createElementNS(SVG_NS, "g");
  const labelTexts = [];
  labelInfos.forEach((li) => {
    const bg = document.createElementNS(SVG_NS, "rect");
    bg.setAttribute("class", "seg-label-bg");
    bg.setAttribute("rx", "5");
    bg.setAttribute("ry", "5");
    bgLayer.appendChild(bg);

    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", li.x);
    text.setAttribute("y", li.y);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    text.setAttribute("class", "seg-label");
    setSvgMultilineText(text, li.label, li.x);
    text.style.pointerEvents = "none"; // クリックは下の seg(g) が拾う
    textLayer.appendChild(text);
    labelTexts.push({ bg, text });
  });

  // 中央のハブ。クリックモードでは設定を開く。ジェスチャモードでは
  // ハブで離す＝本来メニューなので click は無視。
  const hub = document.createElementNS(SVG_NS, "circle");
  hub.setAttribute("cx", CENTER);
  hub.setAttribute("cy", CENTER);
  hub.setAttribute("r", INNER_R - 8);
  hub.setAttribute("class", "hub");
  hub.addEventListener("click", () => {
    if (gestureMode) return;
    invoke("open_settings").catch((e) =>
      console.error("[piemenu] open_settings failed:", e),
    );
  });
  svg.appendChild(hub);

  // ラベル（背景帯＋文字）は #pie の opacity を継がない別レイヤ(oSvg)へ。
  // これで半透明メニューでもラベルだけは常に不透明で読める。背景帯→文字の順。
  oSvg.appendChild(bgLayer);
  oSvg.appendChild(textLayer);

  pie.appendChild(svg);
  outline.appendChild(oSvg);

  // DOM 追加後に文字実寸を測り、薄い黒の背景帯を文字サイズへ合わせる。
  const padX = 6;
  const padY = 2;
  for (const { bg, text } of labelTexts) {
    const bb = text.getBBox();
    bg.setAttribute("x", String(bb.x - padX));
    bg.setAttribute("y", String(bb.y - padY));
    bg.setAttribute("width", String(bb.width + padX * 2));
    bg.setAttribute("height", String(bb.height + padY * 2));
  }
}

// ラベルを改行("\n")対応で SVG <text> に流し込む。複数行は <tspan> を縦に
// 並べ、ブロック全体の中心が text の y に来るよう先頭行を半分持ち上げる
// （dominant-baseline:central 前提）。単一行は従来どおり textContent。
function setSvgMultilineText(text, label, x) {
  const lines = String(label ?? "").split("\n");
  if (lines.length <= 1) {
    text.textContent = lines[0] ?? "";
    return;
  }
  const LH = 1.15; // 行間(em)
  text.textContent = "";
  lines.forEach((line, i) => {
    const ts = document.createElementNS(SVG_NS, "tspan");
    ts.setAttribute("x", String(x));
    ts.setAttribute("dy", i === 0 ? `${(-(lines.length - 1) * LH) / 2}em` : `${LH}em`);
    ts.textContent = line || " "; // 空行でも行送りを保つ
    text.appendChild(ts);
  });
}

// クイックスロット HUD（マウス絵＋4ボタンの割当ラベル）を描く。
// モックアップ準拠: マウスの各ボタン位置から線が出て、右にラベル。
function buildQuickHud() {
  const hud = document.getElementById("quick-hud");
  if (!hud) return;
  const get = (k) => {
    const q = quickSlots.find((s) => s.kind === k);
    return q && q.label ? q.label : "未設定";
  };
  const row = (k, name) => {
    const label = get(k);
    const empty = label === "未設定" ? " empty" : "";
    return (
      `<div class="qh-row" data-kind="${k}">` +
      `<span class="qh-name">${name}</span>` +
      `<span class="qh-dot"></span>` +
      `<span class="qh-label${empty}">${label}</span>` +
      `</div>`
    );
  };
  // マウス絵（簡易SVG）＋4スロット。上からホイール上/左/中/ホイール下。
  hud.innerHTML =
    `<div class="qh-mouse">` +
    `<svg viewBox="0 0 60 90" width="60" height="90">` +
    `<rect x="8" y="4" width="44" height="82" rx="22" fill="none" stroke="#cfcfe0" stroke-width="3"/>` +
    `<line x1="30" y1="6" x2="30" y2="40" stroke="#cfcfe0" stroke-width="2"/>` +
    `<rect x="26" y="16" width="8" height="16" rx="4" fill="#cfcfe0"/>` +
    `</svg></div>` +
    `<div class="qh-rows">` +
    row("left", "左クリック") +
    row("middle", "中クリック") +
    row("wheel_up", "ホイール上") +
    row("wheel_down", "ホイール下") +
    `</div>`;
}

// クイックスロット発動時に一瞬光らせる演出。
function flashQuickSlot(kind) {
  const hud = document.getElementById("quick-hud");
  if (!hud) return;
  const row = hud.querySelector(`.qh-row[data-kind="${kind}"]`);
  if (!row) return;
  row.classList.remove("flash");
  // リフローを挟んでアニメを再始動。
  void row.offsetWidth;
  row.classList.add("flash");
}

function onSelect(index) {
  // 見た目を即座に消してから Rust に処理を委譲（窓非表示＋スタック実行）。
  // Rust 側が表示中プロファイルの segment[index] の接続スタックを順次実行する。
  hideOverlayInstant();
  invoke("select_segment", { index }).catch((e) =>
    console.error("[piemenu] select_segment failed:", e),
  );
}

// ── 右ボタン押しっぱなしジェスチャ ───────────────────────────────
// 右 down でこのモードになり、移動でホバー、up で「離した位置」を判定。
let gestureMode = false;
// パイ中心のスクリーン物理座標（gesture-start で Rust から受け取る）。
let anchorX = 0;
let anchorY = 0;

// ── シェイク・キャンセル（左右左右と振るとデフォルト離脱） ─────────
// 右クリック後に水平方向を素早く反転させると、パイも右クリックメニューも
// 出さずに閉じる。誤発動を避けるため「一定px以上の水平移動」「短時間内に
// 規定回数の方向反転」の両方を満たしたときだけ発動する。
const SHAKE_MIN_DX = 18; // この px 以上動いたら1ストロークと見なす（DPR後の物理px）
const SHAKE_NEEDED = 4; // 必要な方向反転回数（左右左右＝4反転）
const SHAKE_WINDOW_MS = 700; // 直近この時間内の反転だけ数える
const SHAKE_REVERSAL_GAP_MS = 300; // 反転がこれ以上空いたら数え直す（速い連続のみ本物）
let shakeDir = 0; // 直近で確定した水平方向（-1=左, +1=右, 0=未確定）
let shakeStrokeStartX = 0; // 現ストロークの始点X
let shakeReversals = []; // 反転が起きた時刻（ミリ秒）の配列

function resetShake(x) {
  shakeDir = 0;
  shakeStrokeStartX = x;
  shakeReversals = [];
}

// 水平移動から方向反転を検出する。規定回数に達したら true（＝キャンセル）。
function detectShake(x) {
  const dx = x - shakeStrokeStartX;
  if (Math.abs(dx) < SHAKE_MIN_DX) return false; // まだ1ストローク未満
  const dir = dx > 0 ? 1 : -1;
  if (shakeDir === 0) {
    // 最初のストローク方向を確定。
    shakeDir = dir;
    shakeStrokeStartX = x;
    return false;
  }
  if (dir !== shakeDir) {
    // 方向反転を1回カウント。始点を更新して次ストロークを測る。
    const now = Date.now();
    // 本物のシェイクは反転が「速く連続」する。前の反転から間が空いていたら
    // （＝ゆっくりした弧の動きや、イベント間引きで飛んだだけ）шリセットして
    // 数え直す。これで非フォーカス窓のスパースな move でも誤検出しない。
    const last = shakeReversals[shakeReversals.length - 1];
    if (last !== undefined && now - last > SHAKE_REVERSAL_GAP_MS) {
      shakeReversals = [];
    }
    shakeReversals.push(now);
    // 古い反転（ウィンドウ外）は捨てる。
    shakeReversals = shakeReversals.filter((t) => now - t <= SHAKE_WINDOW_MS);
    shakeDir = dir;
    shakeStrokeStartX = x;
    return shakeReversals.length >= SHAKE_NEEDED;
  }
  // 同方向に伸び続けている → 始点を進める（同方向の累積で誤検出しない）。
  shakeStrokeStartX = x;
  return false;
}

// スクリーン物理座標(px) を SVG 中心からの論理オフセットに変換し、
// 半径と「どのセグメントか」を返す。中心=パイ中心(=アンカー)。
// アンカーは表示時のカーソル位置(物理px)で、そこに窓中心=パイ中心がある。
// 返り値: { index: 番号 | -1(ハブ) | -2(範囲外), r: 中心からの距離(論理px) }
function hitTest(screenX, screenY) {
  const dpr = window.devicePixelRatio || 1;
  // アンカーからの差分(物理px) → 論理px へ。SVG は 1:1 で論理pxに対応。
  const dx = (screenX - anchorX) / dpr;
  const dy = (screenY - anchorY) / dpr;
  const r = Math.hypot(dx, dy);

  if (r <= INNER_R) return { index: -1, r }; // 中央ハブ＝キャンセル
  // 外側有効がオフのときだけ、外周から大きく外れたら範囲外にする。
  // オンなら距離に関係なく、下の角度判定でその方向のセグメントを選ぶ。
  if (!OUTER_ACTIVE && r > OUTER_R + 40) return { index: -2, r };

  // 角度（真上0・時計回り）。polar の逆変換。
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  if (deg < 0) deg += 360;
  const n = items.length;
  const slice = 360 / n;
  // セグメント中心が真上(-slice/2 オフセット)＋ROTATION なので、判定も同量ずらす。
  let a = deg + slice / 2 - ROTATION;
  a = ((a % 360) + 360) % 360;
  const idx = Math.floor(a / slice) % n;
  return { index: idx, r };
}

function setHover(index) {
  if (index === hoverIndex) return;
  hoverIndex = index;
  segEls.forEach((g, i) => {
    g.classList.toggle("seg-active", i === index);
  });
  // 選択中だけ不透明アウトラインを出す（別レイヤなので半透明の影響なし）。
  outlineEls.forEach((p, i) => {
    p.classList.toggle("active", i === index);
  });
}

function onGestureMove(screenX, screenY) {
  if (!gestureMode) return;
  // 左右左右と振ったらデフォルト離脱（パイも右クリックメニューも出さず閉じる）。
  // シェイク離脱が有効なときだけ判定する。
  if (SHAKE_DISMISS && detectShake(screenX)) {
    cancelGestureSilently();
    return;
  }
  const { index } = hitTest(screenX, screenY);
  setHover(index >= 0 ? index : -1);

  // サブメニュー: 「メニュー種別」セグメントにカーソルが乗ったら、その
  // ノードのインライン・サブメニューのパイへ切り替える（→↑ と続けて選べる）。
  // 乗った瞬間に1回だけ。segmentSubmenus[index] はそのセグメントがサブメニューを
  // 持つかの真偽。実体は Rust 側が「現在のパイの index 番」から解決する。
  if (index >= 0) {
    const hasSub = segmentSubmenus[index];
    // ネスト上限まで。超えたら開かない（暴走防止）。
    if (hasSub && index !== lastSubmenuSeg && submenuDepth < SUBMENU_MAX_DEPTH) {
      lastSubmenuSeg = index;
      submenuDepth += 1;
      invoke("open_submenu", { index }).catch((e) =>
        console.error("[piemenu] open_submenu failed:", e),
      );
      return; // 切替後はこのフレームの即時アクション等をスキップ
    }
    if (!hasSub) lastSubmenuSeg = -1; // メニュー以外に移ったらリセット
  } else {
    lastSubmenuSeg = -1;
  }

  // 即時アクション: 有効なセグメントへ乗った瞬間に、その場で発動して閉じる。
  // ただしメニュー種別セグメントは発動でなくサブメニュー切替で扱う。
  // ※ 以前はクリスタ対策でキー送出を右UP後へ遅延していたが、フォーカスを
  //   奪わない窓(WS_EX_NOACTIVATE)にした今は押下中でも対象アプリへ直接届く。
  if (INSTANT_ACTION && index >= 0 && !segmentSubmenus[index]) {
    gestureMode = false; // 以降のホバー移動は無視（この瞬間で確定）
    setHover(-1);
    hideOverlayInstant(); // 見た目は即閉じ（CSS・IPC不要）
    // 体感ラグ低減: キー送出(select_segment)を「最優先」で最初に invoke する。
    // 後続の窓hide・shake_dismiss を先に呼ぶと IPC キューでキー送出が後回しに
    // なって遅れる。select_segment 側で窓hideまで行うので順序はこれで良い。
    onSelect(index); // ← 最初に発動（キーが最速で届く）
    invoke("shake_dismiss").catch(() => {}); // 右UPの本来メニュー抑止（後でよい）
  }
}

// シェイク検出時の離脱。窓を即閉じ、右クリックメニューも送らない。
function cancelGestureSilently() {
  gestureMode = false;
  setHover(-1);
  hideOverlayInstant();
  appWindow.hide().catch(() => {});
  // 右ボタンを離したときの右クリック送出（コンテキストメニュー）を抑止する。
  invoke("shake_dismiss").catch(() => {});
  invoke("close_menu").catch(() => {});
}

function onGestureRelease(screenX, screenY, quickUsed) {
  if (!gestureMode) return;
  gestureMode = false;
  setHover(-1);

  // 見た目は即消す（CSS・IPC不要なので最速）。窓の実hideは各分岐の Rust 側で行う。
  hideOverlayInstant();

  // クイックアクションが1回でも使われていたら、離しても発動・右クリック送出は
  // せず、メニューを閉じるだけ（右クリックはアプリへ送らない）。
  if (quickUsed) {
    appWindow.hide().catch(() => {});
    invoke("close_menu").catch(() => {});
    return;
  }

  const { index } = hitTest(screenX, screenY);
  if (index === -1) {
    // 中央ハブで離した → キャンセルして本来の右クリックメニュー。
    appWindow.hide().catch(() => {});
    invoke("cancel_to_context_menu").catch((e) =>
      console.error("[piemenu] cancel_to_context_menu failed:", e),
    );
  } else if (index === -2) {
    // 範囲外で離した → 何もせず閉じる。
    appWindow.hide().catch(() => {});
    invoke("close_menu").catch(() => {});
  } else {
    // セグメント上で離した → そのセグメントを発動。体感ラグ低減のため
    // キー送出(select_segment)を最優先で最初に invoke する（窓hideは
    // select_segment の Rust 側で送出後に行う）。
    onSelect(index);
  }
}

// クイックスロット発動。パイメニュー本体は隠し、マウス絵 HUD は表示したまま。
// 押されたアクションの行を一瞬光らせる。ジェスチャは継続（右ボタン押下中）。
function onQuickAction(kind) {
  if (!gestureMode) return;
  invoke("select_quick", { kind }).catch((e) =>
    console.error("[piemenu] select_quick failed:", e),
  );
  // パイだけ隠す（オーバーレイ非表示）。HUD は表示設定が ON のときだけ残す。
  const overlay = document.getElementById("overlay");
  if (overlay) overlay.style.visibility = "hidden";
  const hud = document.getElementById("quick-hud");
  if (hud) hud.classList.toggle("show", QUICK_HUD_VISIBLE);
  setHover(-1);
  flashQuickSlot(kind);
}

// プロファイルから「初期表示用」の items を選ぶ。実際の表示時は Rust が
// menu-items イベントで「そのとき出すプロファイルの items」を送ってくるので、
// これは起動直後のプレースホルダ（active プロファイル）にすぎない。
function pickInitialItems(config) {
  const profiles = config.profiles || [];
  if (profiles.length === 0) return config.items || []; // 旧形式フォールバック
  const id = config.active_profile;
  const active = profiles.find((p) => p.id === id) || profiles[0];
  // 新モデルは segments（label/color）。パイ描画にはこれで十分。
  return active.segments || active.items || [];
}

async function loadConfig() {
  try {
    const config = await invoke("get_config");
    const profiles = config.profiles || [];
    const active =
      profiles.find((p) => p.id === config.active_profile) || profiles[0];
    if (active) {
      if (typeof active.outer_r === "number") OUTER_R = active.outer_r;
      if (typeof active.inner_r === "number") INNER_R = active.inner_r;
      OUTER_ACTIVE = active.outer_active === true;
      ROTATION = typeof active.rotation === "number" ? active.rotation : 0;
      SHAKE_DISMISS = active.shake_dismiss !== false; // 既定 ON
      INSTANT_ACTION = active.instant_action === true;
      LABEL_R = (OUTER_R + INNER_R) / 2;
    }
    recalcSize();
    items = pickInitialItems(config);
    buildPie();
  } catch (e) {
    console.error("[piemenu] get_config failed:", e);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  loadConfig();

  // WebView2 標準の右クリックメニュー（更新/印刷/開発者ツール…）を絶対に
  // 出さない。透明オーバーレイなので、対象アプリ上の右クリックでパイ窓の
  // コンテキストメニューが出ると邪魔。capture フェーズで確実に止める。
  window.addEventListener("contextmenu", (e) => e.preventDefault(), true);

  // 設定エディタで保存されたら再読込して反映。
  listen("config-updated", () => loadConfig());

  // Esc で閉じる。グローバル登録はせず WebView 内の keydown だけで拾う
  // （他アプリの Esc を奪わない安全策）。フォーカスが入らず効かなくても
  // F8 トグル / フォーカス外しで閉じられるので実害なし。
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      hideMenu();
    }
  });

  // フォーカスを外したら閉じる（他アプリをクリック等）。
  // ただし「フォーカスを得た直後の一瞬の blur」での誤クローズを防ぐため、
  // focus を得てから少し経つまでは blur-close を無視する。
  // Esc を拾えるよう body をフォーカス可能にしておく。
  document.body.tabIndex = -1;

  // 表示直前に「そのとき出すプロファイルの segments＋半径」が届く。
  // 差し替えて再描画。プロファイルごとにパイが変わるため毎回最新を受け取る。
  listen("menu-items", (e) => {
    const pl = e.payload;
    if (pl && Array.isArray(pl.segments)) {
      items = pl.segments;
      if (typeof pl.outer_r === "number") OUTER_R = pl.outer_r;
      if (typeof pl.inner_r === "number") INNER_R = pl.inner_r;
      OUTER_ACTIVE = pl.outer_active === true;
      ROTATION = typeof pl.rotation === "number" ? pl.rotation : 0;
      SHAKE_DISMISS = pl.shake_dismiss !== false; // 既定 ON
      INSTANT_ACTION = pl.instant_action === true;
      quickSlots = Array.isArray(pl.quick) ? pl.quick : [];
      QUICK_HUD_VISIBLE = pl.quick_hud_visible !== false; // 既定 ON
      PIE_VISIBLE = pl.pie_visible !== false; // 既定 ON
      segmentSubmenus = Array.isArray(pl.submenus) ? pl.submenus : [];
      lastSubmenuSeg = -1; // メニュー差し替えで履歴リセット
      LABEL_R = (OUTER_R + INNER_R) / 2;
      recalcSize(); // 半径に合わせて描画領域を広げる（はみ出し・四角化防止）
      // パイ全体の不透明度＋表示設定を適用。非表示なら opacity 0 で隠す。
      const pie = document.getElementById("pie");
      const outline = document.getElementById("pie-outline");
      const baseOp = typeof pl.opacity === "number" ? pl.opacity : 1;
      if (pie) pie.style.opacity = PIE_VISIBLE ? baseOp : 0;
      if (outline) outline.style.opacity = PIE_VISIBLE ? 1 : 0;
      buildPie();
      buildQuickHud();
    } else if (Array.isArray(pl)) {
      items = pl;
      buildPie();
    }
  });

  // 窓が表示されたら（Rust 側 show_menu から通知）オーバーレイを戻す。
  listen("menu-shown", () => showOverlay());

  // サブメニューを開いたとき、新しい中心（カーソル位置）をアンカーに更新。
  // これで子パイの方向判定が新しい中心基準になる（→↑ と続けて選べる）。
  listen("submenu-anchor", (e) => {
    if (Array.isArray(e.payload)) {
      anchorX = e.payload[0];
      anchorY = e.payload[1];
      resetShake(anchorX); // 中心が変わるのでシェイク検出もリセット
    }
  });

  // 右クリック由来の表示はジェスチャモード（押しっぱなしで操作）。
  // payload はパイ中心のスクリーン物理座標 [x, y]（アンカー）。
  listen("gesture-start", (e) => {
    gestureMode = true;
    hoverIndex = -1;
    setHover(-1);
    submenuDepth = 0; // 新しいジェスチャ＝親メニューから（ネスト深さリセット）
    if (Array.isArray(e.payload)) {
      anchorX = e.payload[0];
      anchorY = e.payload[1];
    }
    resetShake(anchorX); // シェイク検出をリセット（始点＝パイ中心）
    showOverlay();
    // ジェスチャ中だけクイックスロット HUD を出す（表示設定が ON のときのみ）。
    const hud = document.getElementById("quick-hud");
    if (hud) hud.classList.toggle("show", QUICK_HUD_VISIBLE);
  });

  // ジェスチャ中のマウス移動（スクリーン物理座標）→ ホバーハイライト。
  listen("gesture-move", (e) => {
    const [x, y] = e.payload;
    onGestureMove(x, y);
  });

  // 即時アクションが Rust 側（フック）で発火した → キーは送出済み。
  // ここでは見た目を閉じてジェスチャを畳むだけ（JS から再送出しない）。
  listen("instant-fired", () => {
    gestureMode = false;
    setHover(-1);
    hideOverlayInstant();
  });

  // 右ボタンを離した（スクリーン物理座標）→ 離した位置で判定。
  // payload[2] = quick_used（クイックアクションが1回でも使われたか）。
  listen("gesture-release", (e) => {
    const [x, y, quickUsed] = e.payload;
    onGestureRelease(x, y, quickUsed === true);
  });

  // ジェスチャ中の追加マウス操作 → クイックスロット発動（メニューは閉じない）。
  listen("quick-action", (e) => {
    onQuickAction(e.payload);
  });

  let focusedAt = 0;
  appWindow.onFocusChanged(({ payload: focused }) => {
    // ジェスチャ中はフォーカスが安定しない（右ボタン押下中）。
    // blur で閉じると release 判定前に消えるので、ジェスチャ中は無視。
    if (gestureMode) return;
    if (focused) {
      focusedAt = Date.now();
      // 念のためフォーカス取得時にも戻す。
      showOverlay();
      // WebView にキーボードフォーカスを入れて Esc を拾えるようにする。
      document.body.focus();
    } else if (Date.now() - focusedAt > 200) {
      hideMenu();
    }
  });
});
