const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

const settingsWindow = getCurrentWindow();

// 編集中の設定（メモリ上）。保存時に Rust へ渡す。
let config = { hotkey: "F8", profiles: [] };

// 未保存の編集があるか。true の間は窓フォーカス時の自動 load() を抑制する。
let dirty = false;
// 変更があったら自動保存する（デバウンス）。保存ボタンは廃止。
let autosaveTimer = null;
function markDirty() {
  dirty = true;
  pushHistory();
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => save(), 500);
}

// ── アンドゥ／リドゥ ──────────────────────────────────────────────
// config 全体のスナップショット（ディープコピー）を積んで戻す方式。
// present = いま画面に出ている状態のコピー。markDirty のたびに
// 直前の present を undoStack へ送り、present を最新へ更新する。
const HISTORY_LIMIT = 100;
let undoStack = [];
let redoStack = [];
let present = null;
let restoring = false; // undo/redo 中の markDirty 連鎖を防ぐ

function cloneConfig() {
  return JSON.parse(JSON.stringify(config));
}

// 履歴の基準を今の config にリセット（load 直後に呼ぶ）。
function resetHistory() {
  undoStack = [];
  redoStack = [];
  present = cloneConfig();
}

// 変更を1ステップとして記録する。markDirty から呼ばれる。
function pushHistory() {
  if (restoring) return; // undo/redo による変更は記録しない
  if (present !== null) {
    undoStack.push(present);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  }
  present = cloneConfig();
  redoStack = []; // 新しい編集で redo は無効化
}

// スナップショットを画面へ反映する共通処理。
function applySnapshot(snap) {
  restoring = true;
  config = JSON.parse(JSON.stringify(snap));
  if (rootCtx.profileIndex >= (config.profiles || []).length) {
    rootCtx.profileIndex = Math.max(0, config.profiles.length - 1);
  }
  // config 全体が入れ替わったので、子 ctx のキャッシュは捨てて root から描き直す。
  // 子/孫のカメラ(パン/ズーム)は退避→再構築後に書き戻す。
  const savedCams = {};
  snapshotChildCameras(rootCtx, "", savedCams);
  rootCtx._childCtx = {};
  currentCtx = rootCtx;
  render(rootCtx);
  restoreChildCameras(rootCtx, "", savedCams);
  reapplyChildTransforms(rootCtx);
  dirty = true;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => save(), 500);
  restoring = false;
}

function undo() {
  if (undoStack.length === 0) {
    showToast("これ以上アンドゥできません");
    return;
  }
  redoStack.push(present);
  present = undoStack.pop();
  applySnapshot(present);
  showToast(`アンドゥしました（あと${undoStack.length}回）`);
}

function redo() {
  if (redoStack.length === 0) {
    showToast("これ以上リドゥできません");
    return;
  }
  undoStack.push(present);
  present = redoStack.pop();
  applySnapshot(present);
  showToast(`リドゥしました（あと${redoStack.length}回）`);
}

const statusEl = document.getElementById("status");

const SVG_NS = "http://www.w3.org/2000/svg";

// ── EditorContext ────────────────────────────────────────────────
// エディタ1面ぶんの状態（カメラ・選択・ドラッグ・対象プロファイル・DOM参照）。
// 将来メニューブロック内に子エディタを内包するため、これらを ctx に集約する。
// 関数は引数 ctx を取り、省略時は currentCtx（＝今フォーカスしている面）を使う。
// 段0では面は1つ（rootCtx）のみで、挙動は従来と完全に同じ。
function makeEditorContext(opts = {}) {
  return {
    // 対象プロファイル（この面が編集しているプロファイルの index）。
    profileIndex: 0,
    // カメラ（パン/ズーム）。
    panX: 0,
    panY: 0,
    zoom: 1,
    // プレビュー（パイ）の world 左上位置。
    pvLeft: 20,
    pvTop: 20,
    // 選択状態。
    selNodes: new Set(),
    selApps: new Set(),
    // 各種ドラッグ/操作の一時状態。
    pan: null,
    marquee: null,
    knife: null,
    drag: null,
    nodeDragMoved: false,
    selectArm: null,
    groupDrag: null,
    nodeLink: null,
    link: null,
    radiusDrag: null,
    previewMove: null,
    segDrag: null,
    quickDrag: null,
    quickLink: null,
    appDrag: null,
    appDragMoved: false,
    // 直近マウス world 位置（＋アクション/＋アプリ配置に使う）。
    lastMouseWorld: null,
    // コネクタ幾何キャッシュ（ナイフ判定用）。
    connectorGeo: [],
    // ズーム%表示の自動消去タイマー。
    zoomHideTimer: null,
    // この面の DOM 参照（段0では既定の固定IDを指す）。
    el: {
      editor: opts.editor || document.getElementById("editor"),
      world: opts.world || document.getElementById("world"),
      preview: opts.preview || document.getElementById("preview"),
      nodes: opts.nodes || document.getElementById("nodes"),
      connectors: opts.connectors || document.getElementById("connectors"),
      zoomIndicator:
        opts.zoomIndicator || document.getElementById("zoom-indicator"),
    },
    // 内包の深さ（root=0）。再帰ガード用。
    depth: opts.depth || 0,
    // メニュー型ノードは常に大きな内包ボックスで表示する（開閉なし）。
    // 操作対象の面は「マウスカーソルが乗っている面（currentCtx）」で判別。
  };
}

// 内包の最大深さ（root=0）。これを超える深さの edit は開かせない。
const EMBED_MAX_DEPTH = 3;

// メニューブロック（子パネル）の初期サイズ。下部ツールバー（スライダー2本＋
// トグル3つ＝約530px）が1行に収まる広さ＋パイの余白を確保した既定値。
const EMBED_DEFAULT_W = 560;
const EMBED_DEFAULT_H = 420;
// メニュー（展開）ブロックの左端◯ポートの、ブロック上端からの縦位置(px)。
// ヘッダー行（種別/値の行）の中央あたり。配線終点もここに合わせる。
const MENU_PORT_TOP = 21;

// ── 面スコープのDOM検索 ───────────────────────────────────────────
// 内包面（子エディタ）は親の #nodes の子孫として描かれるため、単純な
// querySelector だと子面の .anode/.app-node まで拾ってしまう。各面の
// 要素（.anode/.app-node/.qpanel）は必ず ctx.el.nodes の「直接の子」なので、
// :scope > で絞ればその面だけを対象にできる（子面は更に深いので除外される）。
function ownAll(ctx, sel) {
  // sel は .anode / .app-node / .qpanel など直接子のセレクタ。
  return ctx.el.nodes.querySelectorAll(`:scope > ${sel}`);
}
function ownOne(ctx, sel) {
  return ctx.el.nodes.querySelector(`:scope > ${sel}`);
}
// qpanel 内の行（.qpanel-row）はこの面の qpanel（直接子）配下に限定する。
function ownQpanelRow(ctx, sel) {
  return ctx.el.nodes.querySelector(`:scope > .qpanel ${sel}`);
}
// 要素 el がこの面（ctx）の nodes/preview に属するか（子面のものを除外）。
// 「el の最も近い .nodes/.preview 祖先が ctx のそれと一致」で判定する。
function ownsInNodes(ctx, el) {
  return el && el.closest(".nodes") === ctx.el.nodes;
}
function ownsInPreview(ctx, el) {
  return el && el.closest(".preview") === ctx.el.preview;
}

// 内包子 ctx のキャッシュ。親 ctx ごと・ノード id ごとに1つ保持し、
// 再描画でも子のカメラ（パン/ズーム）や対象プロファイルを失わないようにする。
// parentCtx._childCtx = { [nodeId]: childCtx }
function childCtxFor(parentCtx, node, domEls) {
  if (!parentCtx._childCtx) parentCtx._childCtx = {};
  const nodeId = node.id;
  let child = parentCtx._childCtx[nodeId];
  if (!child) {
    child = makeEditorContext({
      ...domEls,
      depth: (parentCtx.depth || 0) + 1,
    });
    child.parentCtx = parentCtx;
    // 初期カメラ: 子・孫とも等倍(1.0)。親パネルと同じ実寸で表示する。
    // （子のズーム機能は廃止したので、初期値がそのまま表示倍率になる。）
    child.zoom = 1;
    child.panX = 10;
    child.panY = 10;
    parentCtx._childCtx[nodeId] = child;
  } else {
    // 既存 ctx の DOM 参照だけ差し替え（renderNodes が箱を作り直すため）。
    child.el = {
      editor: domEls.editor,
      world: domEls.world,
      preview: domEls.preview,
      nodes: domEls.nodes,
      connectors: domEls.connectors,
      zoomIndicator: domEls.zoomIndicator || null,
    };
  }
  // 編集対象は「このメニューノード自身が持つインラインのサブメニュー」。
  // 重要: node 参照を“閉じ込めない”。閉じ込めると load()/undo で config が
  // 作り直された後、古い（保存に乗らない）node を編集してしまう（＝消えるバグ）。
  // 代わりに毎回、親プロファイルから node.id で“今の実体”を引き直す。
  child.getData = () => {
    const pp = profile(parentCtx);
    const live = (pp.nodes || []).find((n) => n.id === nodeId);
    if (!live) return newSubmenuData(); // 念のため（通常は見つかる）
    return ensureSubmenu(live);
  };
  return child;
}

// 子/孫 ctx ツリーのカメラ（パン/ズーム）を node-id パスで退避する。
// load()/applySnapshot() が _childCtx を捨てる前に呼び、捨てた後に復元すれば
// 再構築後も子・孫のパン/ズームが保たれる（node 参照は閉じ込めないので安全）。
function snapshotChildCameras(parentCtx, prefix, out) {
  const cache = parentCtx._childCtx;
  if (!cache) return;
  for (const nodeId of Object.keys(cache)) {
    const c = cache[nodeId];
    if (!c) continue;
    const key = prefix + "/" + nodeId;
    out[key] = { panX: c.panX, panY: c.panY, zoom: c.zoom };
    snapshotChildCameras(c, key, out); // 孫以降も再帰
  }
}
// 退避したカメラを、再生成された子/孫 ctx ツリーへ書き戻す。
function restoreChildCameras(parentCtx, prefix, saved) {
  const cache = parentCtx._childCtx;
  if (!cache) return;
  for (const nodeId of Object.keys(cache)) {
    const c = cache[nodeId];
    if (!c) continue;
    const key = prefix + "/" + nodeId;
    const cam = saved[key];
    if (cam) {
      c.panX = cam.panX;
      c.panY = cam.panY;
      c.zoom = cam.zoom;
    }
    restoreChildCameras(c, key, saved);
  }
}
// 子/孫 ctx ツリーすべてに applyTransform を掛け直す（カメラ書き戻し後に呼ぶ）。
function reapplyChildTransforms(parentCtx) {
  const cache = parentCtx._childCtx;
  if (!cache) return;
  for (const nodeId of Object.keys(cache)) {
    const c = cache[nodeId];
    if (!c || !c.el || !c.el.editor || !c.el.editor.isConnected) continue;
    applyTransform(c);
    reapplyChildTransforms(c);
  }
}

// ルート（メインキャンバス）の編集面。DOM は load 後に bind する。
let rootCtx = null;
// いま操作対象になっている面。イベントハンドラはこれを基準に動く。
let currentCtx = null;

// 外周半径(outer_r)の上限。従来 250 → 150% に引き上げ。
const OUTER_R_MAX = 375;
// ── 円形プレビューの寸法 ──────────────────────────────────────────
// プレビューSVGの一辺。最大外周半径 OUTER_R_MAX の直径＋余白(60)を収める。
const PV_SIZE = OUTER_R_MAX * 2 + 60;
const PV_R = PV_SIZE / 2;
// 本番半径(px)とプレビュー表示の比率。1.0＝ズーム100%で実寸と一致。
const PV_SCALE = 1.0;
const PV_GAP = 0; // セグメント間の隙間（プレビュー）。0＝隙間なし
// 接続ハンドルを外周からどれだけ外に離すか（外周ドラッグと被らせない）。
const HANDLE_GAP = 30;
// 接続ハンドル/配線始点を外周からどれだけ離すか。0 に近いほど
// ラジアルメニューの縁から直接出ているように見える。
const HANDLE_EDGE = 6;

// プロファイルの outer_r/inner_r からプレビュー半径(px)を得る。
function pvOuter(ctx = currentCtx) {
  return (profile(ctx).outer_r ?? 160) * PV_SCALE;
}
function pvInner(ctx = currentCtx) {
  return (profile(ctx).inner_r ?? 56) * PV_SCALE;
}
function pvLabelR(ctx = currentCtx) {
  return (pvOuter(ctx) + pvInner(ctx)) / 2;
}

// editor キャンバス内でのプレビュー左上位置（world 座標・可変）。
// ctx.pvLeft / ctx.pvTop に保持する（makeEditorContext 参照）。中心は +PV_R。
// プレビュー中心（world 座標）。ctx.pvLeft/pvTop から算出。
function pvCenter(ctx = currentCtx) {
  return { cx: ctx.pvLeft + PV_R, cy: ctx.pvTop + PV_R };
}

// 鮮やかでまとまりのあるパレット（パイがカラフルに映える）。順序は色相環で
// 隣り合わないように並べ、円周（最後↔最初も隣）でも同系色が続かないようにする。
// セグメント既定色＋カラーピッカーのプリセットの両方で使う。
const DEFAULT_COLORS = [
  "#4f8cff", // ブルー
  "#28c76f", // グリーン
  "#ff9f43", // オレンジ
  "#ea5455", // レッド
  "#a66cff", // パープル
  "#00cfe8", // シアン
  "#ff6fb5", // ピンク
  "#f6c324", // イエロー
];

// n 分割の i 番目の既定色。固定パレットを順に使い、項目数が色数を
// 超えたら循環する。
function defaultColorFor(i, n) {
  return DEFAULT_COLORS[i % DEFAULT_COLORS.length];
}

// プレビュー内ローカル座標（中心 PV_R 基準）。
function pvPolarLocal(r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: PV_R + r * Math.cos(rad), y: PV_R + r * Math.sin(rad) };
}
// editor キャンバス座標での極座標（プレビュー中心基準）。
function pvPolarCanvas(r, deg, ctx = currentCtx) {
  const rad = ((deg - 90) * Math.PI) / 180;
  const { cx, cy } = pvCenter(ctx);
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function pvSector(startDeg, endDeg, ctx = currentCtx) {
  const large = endDeg - startDeg > 180 ? 1 : 0;
  const ro = pvOuter(ctx);
  const ri = pvInner(ctx);
  const oS = pvPolarLocal(ro, startDeg);
  const oE = pvPolarLocal(ro, endDeg);
  const iE = pvPolarLocal(ri, endDeg);
  const iS = pvPolarLocal(ri, startDeg);
  return [
    `M ${oS.x} ${oS.y}`,
    `A ${ro} ${ro} 0 ${large} 1 ${oE.x} ${oE.y}`,
    `L ${iE.x} ${iE.y}`,
    `A ${ri} ${ri} 0 ${large} 0 ${iS.x} ${iS.y}`,
    "Z",
  ].join(" ");
}

// ── プロファイル（編集対象データ）参照 ───────────────────────────
// 各 ctx は編集対象の「プロファイル状データ」を返す。
//  - ルート/通常面: config.profiles[ctx.profileIndex]（タブで切替）
//  - 内包面(子): ctx.getData() が返すインラインのサブメニューデータ
//    （メニューノードが node.submenu として自前で持つ。別プロファイル参照はしない）
function profile(ctx = currentCtx) {
  let p;
  if (ctx && typeof ctx.getData === "function") {
    p = ctx.getData();
  } else {
    if (!Array.isArray(config.profiles) || config.profiles.length === 0) {
      config.profiles = [makeProfile("デフォルト")];
    }
    if (ctx.profileIndex >= config.profiles.length) ctx.profileIndex = 0;
    p = config.profiles[ctx.profileIndex];
  }
  return normalizeProfileData(p);
}

// プロファイル状データの配列フィールドを正規化（空なら作る）。
function normalizeProfileData(p) {
  if (!p || typeof p !== "object") p = {};
  if (!Array.isArray(p.segments)) p.segments = [];
  if (!Array.isArray(p.nodes)) p.nodes = [];
  if (!Array.isArray(p.app_nodes)) p.app_nodes = [];
  if (!Array.isArray(p.quick_slots) || p.quick_slots.length === 0) {
    p.quick_slots = defaultQuickSlots();
  }
  return p;
}

// メニューノードのインライン・サブメニューデータを取得（無ければ新規作成）。
function ensureSubmenu(node) {
  if (!node.submenu || typeof node.submenu !== "object") {
    node.submenu = newSubmenuData();
  }
  return normalizeProfileData(node.submenu);
}

// 新規サブメニューの初期データ（4分割の空メニュー）。プロファイルと同形だが
// タブには出さない独立データ。id/name/対象アプリ等のタブ向け項目は持たない。
function newSubmenuData() {
  const segments = [];
  for (let i = 0; i < 4; i++) {
    segments.push({ label: "", color: defaultColorFor(i, 4), head: null });
  }
  return {
    segments,
    nodes: [],
    app_nodes: [],
    quick_slots: defaultQuickSlots(),
    outer_r: 160,
    inner_r: 56,
    rotation: 0,
    opacity: 0.5, // 新規プロファイルと同じ（不透明度 50%）
    outer_active: true, // 外側有効 ON
    shake_dismiss: false, // シェイク離脱 OFF
    instant_action: true, // 即時アクション ON
  };
}

// 既定の4クイックスロット（左/中クリック・ホイール上下）。
function defaultQuickSlots() {
  // パイメニュー（中心 ~300,300・半径 ~160）に被らないよう、左下に配置。
  // パネルは left スロットの x/y を基準に1ブロックとして描く。
  return [
    { kind: "left", head: null, x: -20, y: 500, label: "" },
    { kind: "middle", head: null, x: -20, y: 500, label: "" },
    { kind: "wheel_up", head: null, x: -20, y: 500, label: "" },
    { kind: "wheel_down", head: null, x: -20, y: 500, label: "" },
  ];
}

// プロファイルの表示名。手動で名前を付けていれば（name 非空）それを使い、
// 未設定なら登録アプリ名（一番上のブロック＝y が最小のアプリ）を表示する。
// プロファイル単体の「素の表示名」（連番なし）。手動名 or 先頭アプリ名。
function profileBaseName(p) {
  const manual = (p.name || "").trim();
  if (manual) return manual;
  const apps = (p.app_nodes || []).filter((a) => (a.name || "").trim());
  if (apps.length === 0) return "(未設定)";
  // 一番上にあるアプリ（y が最小）を採用。
  const top = apps.reduce((a, b) => ((a.y ?? 0) <= (b.y ?? 0) ? a : b));
  // "zed.exe" → "zed"。拡張子を落とす。
  return top.name.trim().replace(/\.[^.]+$/, "");
}

// タブに出す表示名。同じ素の表示名が複数あるとき、2つ目以降に連番を付けて
// 区別する（例: notepad / notepad2 / notepad3）。「(未設定)」は連番を付けない。
function profileDisplayName(p) {
  const base = profileBaseName(p);
  if (base === "(未設定)") return base;
  const profiles = config.profiles || [];
  // 同じ素の表示名を持つプロファイルを順に集め、自分が何番目かで連番を決める。
  let n = 0;
  for (const q of profiles) {
    if (profileBaseName(q) !== base) continue;
    n += 1;
    if (q === p) return n === 1 ? base : `${base}${n}`;
  }
  return base; // 念のため（通常はループ内で返る）
}

// ── ドラッグ中の「移動先を示す矢印」オーバーレイ ──────────────────
// fromEl の中心 → toEl の中心へ、画面座標で湾曲した矢印を描く。
function showDragArrow(fromEl, toEl) {
  const svg = document.getElementById("drag-arrow");
  if (!svg || !fromEl || !toEl || fromEl === toEl) {
    clearDragArrow();
    return;
  }
  const a = fromEl.getBoundingClientRect();
  const b = toEl.getBoundingClientRect();
  const x1 = a.left + a.width / 2;
  const y1 = a.top + a.height / 2;
  const x2 = b.left + b.width / 2;
  const y2 = b.top + b.height / 2;

  // 制御点は中点から法線方向に少し膨らませて弧にする。
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const bow = Math.min(40, len * 0.2); // 弧の膨らみ
  const cx = mx - (dy / len) * bow;
  const cy = my + (dx / len) * bow;

  // 矢じりは終点で、終点へ向かう接線（制御点→終点）方向。
  const tx = x2 - cx;
  const ty = y2 - cy;
  const tl = Math.hypot(tx, ty) || 1;
  const ux = tx / tl;
  const uy = ty / tl;
  const size = 11;
  const bx = x2 - ux * size;
  const by = y2 - uy * size;
  const nx = -uy;
  const ny = ux;
  const h = size * 0.7;
  const headPts = `${x2},${y2} ${bx + nx * h},${by + ny * h} ${bx - nx * h},${by - ny * h}`;

  svg.setAttribute("width", window.innerWidth);
  svg.setAttribute("height", window.innerHeight);
  svg.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);
  svg.innerHTML =
    `<path class="da-line" d="M ${x1} ${y1} Q ${cx} ${cy} ${bx} ${by}" />` +
    `<polygon class="da-head" points="${headPts}" />`;
  svg.classList.add("show");
}
function clearDragArrow() {
  const svg = document.getElementById("drag-arrow");
  if (svg) {
    svg.classList.remove("show");
    svg.innerHTML = "";
  }
}

// ── タブ（プロファイル）の並べ替え ────────────────────────────────
let tabReorder = null;
let tabReorderDidMove = false; // 直前のドラッグで動いたか（click 抑止用）
function startTabReorder(e, index) {
  tabReorder = {
    from: index,
    sx: e.clientX,
    sy: e.clientY,
    moved: false,
    over: index,
  };
  window.addEventListener("pointermove", onTabReorderMove);
  window.addEventListener("pointerup", onTabReorderUp);
}
function onTabReorderMove(e) {
  if (!tabReorder) return;
  if (!tabReorder.moved) {
    if (Math.hypot(e.clientX - tabReorder.sx, e.clientY - tabReorder.sy) <= 4) {
      return; // まだクリックの範囲（並べ替え開始しない）
    }
    tabReorder.moved = true;
    tabReorderDidMove = true;
    document.body.classList.add("tab-dragging");
  }
  // カーソル下のタブ index をドロップ先候補に。
  const over = tabAtPoint(e.clientX, e.clientY);
  if (over !== null) tabReorder.over = over;
  // ドロップ先ハイライト。
  document.querySelectorAll(".tab.drop-target").forEach((el) => {
    if (Number(el.dataset.index) !== tabReorder.over) {
      el.classList.remove("drop-target");
    }
  });
  const fromEl = document.querySelector(`.tab[data-index="${tabReorder.from}"]`);
  if (tabReorder.over !== tabReorder.from) {
    const el = document.querySelector(`.tab[data-index="${tabReorder.over}"]`);
    if (el) el.classList.add("drop-target");
    showDragArrow(fromEl, el); // 移動先へ矢印
  } else {
    clearDragArrow();
  }
}
function onTabReorderUp() {
  window.removeEventListener("pointermove", onTabReorderMove);
  window.removeEventListener("pointerup", onTabReorderUp);
  document.body.classList.remove("tab-dragging");
  clearDragArrow();
  const r = tabReorder;
  tabReorder = null;
  // click は pointerup の後に来るので、次tickでフラグを戻す。
  setTimeout(() => {
    tabReorderDidMove = false;
  }, 0);
  if (!r || !r.moved) return; // 動かしていない＝クリック（切替）に任せる
  const { from, over } = r;
  if (over === from || over == null) {
    render();
    return;
  }
  // アクティブプロファイルの id を覚えてから並べ替え、index を取り直す。
  const activeId = (config.profiles[rootCtx.profileIndex] || {}).id;
  const [moved] = config.profiles.splice(from, 1);
  config.profiles.splice(over, 0, moved);
  const newActive = config.profiles.findIndex((p) => p.id === activeId);
  if (newActive >= 0) rootCtx.profileIndex = newActive;
  markDirty();
  render();
}

// プロファイル index のアプリのうち、他プロファイルにも登録されている
// アプリ名（小文字・trim 済み）の一覧を返す（重複検出）。
// ホバーした警告マーク(srcWarn)と、同じアプリ名で衝突している全プロファイルの
// 警告マーク（自分含む）を一瞬ピカっと光らせる。タブ全体ではなく ! マークだけ。
function flashConflictWarnMarks(srcWarn) {
  const srcApps = (srcWarn.dataset.dupApps || "").split("|").filter(Boolean);
  if (srcApps.length === 0) return;
  document.querySelectorAll(".tab-dup-warn").forEach((warn) => {
    const apps = (warn.dataset.dupApps || "").split("|").filter(Boolean);
    // 共有アプリが1つでもあれば仲間（自分自身も apps が一致するので光る）。
    const shares = apps.some((a) => srcApps.includes(a));
    if (!shares) return;
    warn.classList.remove("warn-flash");
    void warn.offsetWidth; // リフロー強制でアニメ再起動
    warn.classList.add("warn-flash");
    warn.addEventListener(
      "animationend",
      () => warn.classList.remove("warn-flash"),
      { once: true },
    );
  });
}

function duplicateAppsFor(index) {
  const profiles = config.profiles || [];
  const mine = profiles[index];
  if (!mine) return [];
  // 有効なアプリだけ対象（オフのアプリは競合しないのでセーフ判定）。
  const isOn = (a) => a.enabled !== false;
  // 他プロファイルで「有効」に登録されている名前を集める。
  const others = new Set();
  profiles.forEach((p, i) => {
    if (i === index) return;
    (p.app_nodes || []).forEach((a) => {
      if (!isOn(a)) return;
      const n = (a.name || "").trim().toLowerCase();
      if (n) others.add(n);
    });
  });
  // 自分の「有効」アプリのうち、他でも有効登録されているもの。
  const dup = [];
  (mine.app_nodes || []).forEach((a) => {
    if (!isOn(a)) return;
    const raw = (a.name || "").trim();
    if (raw && others.has(raw.toLowerCase()) && !dup.includes(raw)) {
      dup.push(raw);
    }
  });
  return dup;
}

// プロファイルの「大事」（保護）フラグをトグルする。保護中は削除✕を隠す。
function toggleProtected(index) {
  const p = config.profiles[index];
  if (!p) return;
  p.protected = !p.protected;
  markDirty();
  render();
}

// プロファイルの有効/無効を切り替える。無効(enabled=false)のプロファイルは
// 右クリック乗っ取り判定で無視される（Rust: profile_for_app/all_target_apps）。
function toggleEnabled(index) {
  const p = config.profiles[index];
  if (!p) return;
  p.enabled = p.enabled === false ? true : false;
  markDirty();
  render();
}

// 新しいプロファイルを作る（一意 id）。デフォルトは項目数4（上下左右）。
// テンプレートは「右セグメントに1配線・左クリックに1配線・対象アプリ1つ・
// 不透明度50%・外側有効/即時アクションON・シェイク離脱/大事OFF・有効」。
function makeProfile(name) {
  const id = `p${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const node = (suffix, x, y) => ({
    id: `${id}_${suffix}`,
    type: "key",
    value: "",
    x,
    y,
    next: null,
  });
  // パイ中心 ~ (300,300)・外周 ~160。
  // ① 右セグメント用ノード（パイの右）② 左クリック用ノード（クイックパネルの
  //    下＝左下に離してパネルと被らない位置）。
  const nodes = [
    node("s1", 660, 300), // 右セグメント用
    node("ql", 160, 660), // 左クリック用（クイックパネルの下に離す）
  ];
  const segments = [];
  for (let i = 0; i < 4; i++) {
    segments.push({
      label: "", // 空＝未設定（接続内容から自動命名）
      color: defaultColorFor(i, 4),
      // 右セグメント(index 1)のみ配線。他3つは未接続（未設定）。
      head: i === 1 ? `${id}_s1` : null,
    });
  }
  const quick = defaultQuickSlots();
  quick.forEach((q) => {
    if (q.kind === "left") q.head = `${id}_ql`; // 左クリックに1配線
  });
  return {
    id,
    name,
    enabled: true,
    segments,
    nodes,
    app_nodes: [{ name: "", x: 720, y: 560, enabled: true, exclude_titles: [] }],
    quick_slots: quick,
    quick_hud_visible: true,
    pie_visible: true,
    outer_r: 160,
    inner_r: 56,
    rotation: 0,
    opacity: 0.5, // 不透明度 50%
    outer_active: true, // 外側有効 ON
    shake_dismiss: false, // シェイク離脱 OFF
    protected: false, // 大事 OFF
    instant_action: true, // 即時アクション ON
  };
}

// プロファイルタブバーを描く。
// タブ列の横スクロール位置。renderTabs は毎回 innerHTML を作り直すので、
// タブ切替などの再描画でスクロールが先頭に戻らないよう保存・復元する。
let tabStripScrollLeft = 0;

function renderTabs() {
  const bar = document.getElementById("tabbar");
  if (!bar) return;
  // 作り直す前に現在のスクロール位置を覚えておく（あれば）。
  const prevStrip = document.getElementById("tab-strip");
  if (prevStrip) tabStripScrollLeft = prevStrip.scrollLeft;
  bar.innerHTML = "";
  const profiles = config.profiles || [];

  // レイアウト: [◀] [スクロールするタブ列] [▶] [＋]。
  // タブは固定幅のまま、入りきらなければ横スクロール（縮小はしない）。
  // 既定は hidden（はみ出していなければ出さない）。下で判定して必要時のみ表示。
  const left = document.createElement("button");
  left.className = "tab-scroll tab-scroll-left hidden";
  left.type = "button";
  left.textContent = "◀";
  left.dataset.tip = "タブを左へスクロール";

  const strip = document.createElement("div");
  strip.className = "tab-strip";
  strip.id = "tab-strip";

  const right = document.createElement("button");
  right.className = "tab-scroll tab-scroll-right hidden";
  right.type = "button";
  right.textContent = "▶";
  right.dataset.tip = "タブを右へスクロール";

  // スクロールボタン: 押すたび1タブぶん強めにスクロール。
  const SCROLL_STEP = 160;
  left.addEventListener("click", () => {
    strip.scrollBy({ left: -SCROLL_STEP, behavior: "smooth" });
  });
  right.addEventListener("click", () => {
    strip.scrollBy({ left: SCROLL_STEP, behavior: "smooth" });
  });

  // タブ列の上でホイール → 横スクロール（縦ホイールを横に変換）。
  strip.addEventListener(
    "wheel",
    (e) => {
      // はみ出していない（スクロール不要）ときは何もしない。
      if (strip.scrollWidth <= strip.clientWidth) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
    },
    { passive: false },
  );

  profiles.forEach((p, i) => {
    const tab = document.createElement("div");
    tab.className = "tab" + (i === rootCtx.profileIndex ? " active" : "");
    tab.dataset.index = i; // ノードのドラッグ＆ドロップでタブを判定するため。

    if (p.protected) tab.classList.add("protected");
    // 「有効」をオフにしたプロファイルは赤系で目立たせ、「無効」バッジを出す。
    if (p.enabled === false) tab.classList.add("is-disabled");

    // タブ全体で操作を受ける（クリック範囲を広く）。
    //  左ドラッグ→並べ替え / 中クリック→「大事」トグル（ボタン・入力欄は除く）。
    tab.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, input")) return;
      if (e.button === 1) {
        e.preventDefault();
        toggleProtected(i);
        return;
      }
      if (e.button === 0) startTabReorder(e, i);
    });
    // タブのどこをクリックしても切替（並べ替えドラッグ後は切替しない）。
    tab.addEventListener("click", (e) => {
      if (e.target.closest("button, input")) return;
      if (tabReorderDidMove) return; // 直前が並べ替えドラッグ
      if (i === rootCtx.profileIndex) return;
      switchToTab(i);
    });
    // タブ右クリック → コンテキストメニュー（プロファイルを複製）。
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTabContextMenu(e.clientX, e.clientY, i);
    });

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = profileDisplayName(p);
    // 未設定（自動でアプリ名表示）のときは少し控えめに見せる。
    if (!(p.name || "").trim()) title.classList.add("auto");
    title.addEventListener("dblclick", () => editTabName(i, title));
    tab.appendChild(title);

    // 「無効」バッジ（enabled=false のみ）。一目でこのプロファイルが
    // 右クリックで使われないと分かるようにする。下部の有効ボタンで切替。
    if (p.enabled === false) {
      const dis = document.createElement("span");
      dis.className = "tab-disabled-tag";
      dis.textContent = "無効";
      dis.dataset.tip =
        "このプロファイルは無効です（右クリックで無視されます）。" +
        "下部の「有効」ボタンで切り替えられます";
      tab.appendChild(dis);
    }

    // 「大事」タグ（保護中のみ）。左クリックでそのタブを表示、中クリックで解除。
    if (p.protected) {
      const tag = document.createElement("span");
      tag.className = "tab-protected-tag";
      tag.textContent = "大事";
      tag.dataset.tip =
        "大事なプロファイル（削除ボタンを隠して誤削除を防止）。" +
        "クリックでこのタブを表示。" +
        "解除はこのタグかタブを中クリック";
      tag.addEventListener("pointerdown", (e) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          toggleProtected(i);
        }
      });
      tag.addEventListener("click", () => {
        switchToTab(i);
      });
      tab.appendChild(tag);
    }

    // 閉じる（プロファイル削除）。最後の1つ・保護中は消せない（✕を出さない）。
    if (profiles.length > 1 && !p.protected) {
      const close = document.createElement("button");
      close.className = "tab-close";
      close.type = "button";
      close.textContent = "✕";
      close.dataset.tip = "削除（中クリックで「大事」に）";
      // 中クリックで「大事」を付けて保護（誤削除防止）。
      close.addEventListener("pointerdown", (e) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          toggleProtected(i);
        }
      });
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        const removed = config.profiles[i];
        const name = removed ? profileDisplayName(removed) : "プロファイル";
        config.profiles.splice(i, 1);
        if (rootCtx.profileIndex >= config.profiles.length) {
          rootCtx.profileIndex = config.profiles.length - 1;
        }
        markDirty();
        resetView();
        render();
        showDeleteToast(`「${name}」を削除しました`);
      });
      tab.appendChild(close);
    }

    // 警告（！）を出す条件を集める：対象アプリ未指定／他プロファイルと重複。
    const warnMsgs = [];
    const hasApp = (p.app_nodes || []).some((a) => (a.name || "").trim());
    if (!hasApp) {
      warnMsgs.push(
        "対象アプリが指定されていません\n右クリック→対象アプリを追加 で追加してください",
      );
    }
    const dups = duplicateAppsFor(i);
    if (dups.length > 0) {
      warnMsgs.push(`${dups.join("、")} が他のプロファイルでも登録されています`);
    }
    if (warnMsgs.length > 0) {
      const warn = document.createElement("span");
      warn.className = "tab-dup-warn";
      warn.textContent = "！";
      warn.dataset.tip = warnMsgs.join("。");
      // アプリ被りの警告なら、被っているアプリ名を記録しておく。ホバー時に
      // 同じアプリで衝突している全プロファイルの警告マーク（自分含む）を光らせる。
      if (dups.length > 0) {
        warn.dataset.dupApps = dups.map((d) => d.toLowerCase()).join("|");
        warn.addEventListener("pointerenter", () => {
          flashConflictWarnMarks(warn);
        });
      }
      tab.appendChild(warn);
    }

    strip.appendChild(tab);
  });

  // ＋追加 新規プロファイル。最後のタブの右隣（タブ列の末尾）に置く。
  const add = document.createElement("button");
  add.className = "tab-add";
  add.type = "button";
  add.textContent = "＋追加";
  add.dataset.tip = "プロファイルを追加";
  add.addEventListener("click", () => {
    // 名前は未設定（空）で作成。登録アプリ名が自動で表示される。
    config.profiles.push(makeProfile(""));
    rootCtx.profileIndex = config.profiles.length - 1;
    markDirty();
    resetView();
    render();
  });
  // 「最後のタブの右側」＝タブ列(strip)の末尾に入れる（タブと一緒にスクロール）。
  strip.appendChild(add);

  // 右端のフォルダリンク（2行・下線付きリンク風）。タブバー右上に固定。
  const links = document.createElement("div");
  links.className = "tab-folder-links";
  const mkLink = (label, cmd, tip) => {
    const a = document.createElement("button");
    a.type = "button";
    a.className = "folder-link";
    a.textContent = label;
    a.dataset.tip = tip;
    a.addEventListener("click", () => {
      invoke(cmd).catch((e) => {
        console.error(`[settings] ${cmd} failed:`, e);
        showToast("フォルダを開けませんでした: " + e);
      });
    });
    return a;
  };
  links.append(
    mkLink(
      "インストールフォルダ",
      "open_app_folder",
      "このアプリ（実行ファイル）があるフォルダを開きます",
    ),
    mkLink(
      "設定JSONフォルダ",
      "open_config_folder",
      "設定ファイル（config.json）があるフォルダを開きます",
    ),
  );

  // 組み立て: [◀][タブ列(…タブ, ＋追加)][▶] …… [フォルダリンク2行]（右端固定）。
  bar.append(left, strip, right, links);

  // 再描画前のスクロール位置を復元（タブ切替でリセットされないように）。
  // 範囲外にならないようクランプ。
  strip.scrollLeft = Math.min(
    tabStripScrollLeft,
    Math.max(0, strip.scrollWidth - strip.clientWidth),
  );

  // スクロールボタンの表示/有効状態を更新（はみ出していなければ隠す）。
  // レイアウト確定後にも一度判定する（初回は幅が未確定なことがあるため）。
  updateTabScrollButtons(strip, left, right);
  requestAnimationFrame(() => updateTabScrollButtons(strip, left, right));
  strip.addEventListener("scroll", () => {
    tabStripScrollLeft = strip.scrollLeft; // 手動スクロールも追従して保存
    updateTabScrollButtons(strip, left, right);
  });
  // 窓リサイズで「はみ出し」状態が変わるので、その都度判定し直す。
  if (tabResizeObserver) tabResizeObserver.disconnect();
  tabResizeObserver = new ResizeObserver(() =>
    updateTabScrollButtons(strip, left, right),
  );
  tabResizeObserver.observe(strip);
}

// タブ列の幅変化を監視して ◀▶ の要否を再判定する（renderTabs ごとに貼り直す）。
let tabResizeObserver = null;

// タブ列がはみ出しているときだけスクロールボタンを表示し、
// 端まで来たら対応するボタンを無効化（薄く）する。
function updateTabScrollButtons(strip, left, right) {
  const overflow = strip.scrollWidth > strip.clientWidth + 1;
  left.classList.toggle("hidden", !overflow);
  right.classList.toggle("hidden", !overflow);
  if (overflow) {
    const atStart = strip.scrollLeft <= 0;
    const atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
    left.classList.toggle("disabled", atStart);
    right.classList.toggle("disabled", atEnd);
  }
}

// タブ名をインライン編集する。
function editTabName(index, titleEl) {
  const p = config.profiles[index];
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tab-name-edit";
  // 手動名のみ表示（未設定なら空欄＝アプリ名自動表示に戻せる）。
  input.value = p.name || "";
  input.placeholder = "未設定（登録アプリ名）";
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    window.removeEventListener("pointerdown", onOutside, true);
    // 空にすると未設定（自動でアプリ名表示）に戻る。
    p.name = input.value.trim();
    markDirty();
    renderTabs();
  };
  const cancel = () => {
    if (done) return;
    done = true;
    window.removeEventListener("pointerdown", onOutside, true);
    renderTabs();
  };
  // 入力欄以外をクリック/操作したら編集確定（canvas の preventDefault で
  // blur が来ないケースがあるため、pointerdown を直接拾って確定する）。
  const onOutside = (e) => {
    if (e.target !== input) commit();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  });
  input.addEventListener("blur", commit);
  // 自分自身の pointerdown で即発火しないよう次tickで登録。
  setTimeout(() => {
    window.addEventListener("pointerdown", onOutside, true);
  }, 0);
}

// タブ切替時にパン/ズーム/プレビュー位置をリセット。
function resetView(ctx = currentCtx) {
  ctx.panX = 0;
  ctx.panY = 0;
  ctx.zoom = 1;
  ctx.pvLeft = 20;
  ctx.pvTop = 20;
  applyTransform(ctx);
}

// プロファイルごとのカメラ（パン/ズーム/プレビュー位置）を覚えておく置き場。
// タブを切り替えて戻ってきたとき、そのタブで見ていた状態を復元する。
// キーはプロファイル id（無ければ index）。
const cameraStore = new Map();
function cameraKeyFor(index) {
  const p = (config && config.profiles && config.profiles[index]) || null;
  return (p && p.id) || `idx:${index}`;
}
function saveCamera(ctx, index) {
  cameraStore.set(cameraKeyFor(index), {
    panX: ctx.panX,
    panY: ctx.panY,
    zoom: ctx.zoom,
    pvLeft: ctx.pvLeft,
    pvTop: ctx.pvTop,
  });
}
// 保存済みカメラがあれば復元、無ければリセット。
function restoreOrResetView(ctx, index) {
  const cam = cameraStore.get(cameraKeyFor(index));
  if (cam) {
    ctx.panX = cam.panX;
    ctx.panY = cam.panY;
    ctx.zoom = cam.zoom;
    ctx.pvLeft = cam.pvLeft;
    ctx.pvTop = cam.pvTop;
    applyTransform(ctx);
  } else {
    resetView(ctx);
  }
}

function nodeById(id, ctx = currentCtx) {
  return profile(ctx).nodes.find((n) => n.id === id) || null;
}

// 1ノードを簡潔な文言にする。例: キー→"Ctrl+C"、起動→"notepad起動"。
function nodeShortName(node) {
  if (!node) return "";
  const kind = node.type || "key";
  const val = (node.value || "").trim();
  if (kind === "settings") return "設定を開く";
  if (kind === "menu") {
    // インラインのサブメニュー。項目数があれば添えて表す。
    const sub = node.submenu;
    const n = sub && Array.isArray(sub.segments) ? sub.segments.length : 0;
    return n > 0 ? `▷サブメニュー(${n})` : "▷サブメニュー";
  }
  if (kind === "launch") {
    if (!val) return "";
    // パス/URL から末尾の名前を取り、拡張子を落として「○○起動」。
    let name = val.split(/[\\/]/).pop() || val;
    name = name.replace(/\.[^.]+$/, ""); // 拡張子除去
    return `${name}起動`;
  }
  if (kind === "special") {
    const parts = [];
    (node.mods || []).forEach((m) => parts.push(SPECIAL_MOD_LABELS[m] || m));
    (node.clicks || []).forEach((c) => parts.push(SPECIAL_CLICK_LABELS[c] || c));
    const body = parts.join("+");
    if (!body) return "特殊キー";
    return node.release ? `${body}離す` : body;
  }
  // key。記号キー名は表示用に記号へ（"Ctrl+equal"→"Ctrl+="）。
  return val ? prettyCombo(val) : ""; // "Ctrl+C" 等。未入力なら ""。
}

// セグメントの接続内容から自動の名前を作る。何も繋がっていない／中身が
// 空なら「未設定」。複数ノードが繋がっていれば先頭の中身を簡潔に表す。
function autoSegName(seg, ctx = currentCtx) {
  if (!seg || !seg.head) return "未設定";
  const chain = collectChain(seg.head, ctx);
  const names = chain
    .map((id) => nodeShortName(nodeById(id, ctx)))
    .filter((s) => s);
  if (names.length === 0) return "未設定";
  // 1個ならそのまま、複数なら "→" で繋ぐ（長すぎないよう先頭2個まで）。
  const shown = names.slice(0, 2).join("→");
  return names.length > 2 ? `${shown}…` : shown;
}

// プレビューに出すセグメント名。手動ラベルがあればそれを優先、無ければ自動。
function segDisplayName(seg, ctx = currentCtx) {
  const manual = (seg.label || "").trim();
  return manual || autoSegName(seg, ctx);
}

// ── キャンバスのパン/ズーム ──────────────────────────────────────
// panX/panY/zoom は ctx（編集面）ごとに保持する（makeEditorContext 参照）。
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;
// ズーム段（100%・200% などの整数倍を必ず含む）。1段ずつ移動する。
const ZOOM_STOPS = [0.4, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5];

// 現在のズームから dir(+1拡大/-1縮小)方向の隣の段を返す。
function nextZoomStop(z, dir) {
  const eps = 1e-3;
  if (dir > 0) {
    for (const s of ZOOM_STOPS) if (s > z + eps) return s;
    return ZOOM_STOPS[ZOOM_STOPS.length - 1];
  }
  for (let i = ZOOM_STOPS.length - 1; i >= 0; i--) {
    if (ZOOM_STOPS[i] < z - eps) return ZOOM_STOPS[i];
  }
  return ZOOM_STOPS[0];
}

// パン/ズーム中（pointermove ごと）に重い処理を毎フレーム同期で走らせると
// レイアウトスラッシュ（getBoundingClientRect）＋ミニマップ再描画が積もって
// カクつく。次の描画フレームに1回だけまとめて走らせる（rAF コアレス）。
let _postTransformScheduled = false;
let _postTransformNeedsMinimap = false;
function schedulePostTransform(needsMinimap) {
  if (needsMinimap) _postTransformNeedsMinimap = true;
  if (_postTransformScheduled) return;
  _postTransformScheduled = true;
  requestAnimationFrame(() => {
    _postTransformScheduled = false;
    // 埋め込みツールバー／リサイズハンドルの実効スケールを一定に保つ。
    if (typeof rescaleEmbedToolbars === "function") rescaleEmbedToolbars();
    if (typeof rescaleResizeHandles === "function") rescaleResizeHandles();
    if (_postTransformNeedsMinimap) {
      _postTransformNeedsMinimap = false;
      if (typeof updateMinimap === "function") updateMinimap();
    }
  });
}

function applyTransform(ctx = currentCtx) {
  const world = ctx.el.world;
  if (world) {
    world.style.transform = `translate(${ctx.panX}px, ${ctx.panY}px) scale(${ctx.zoom})`;
  }
  // 重い後処理（逆スケール掛け直し・ミニマップ）は次フレームへまとめる。
  // ルート面のパン/ズームが変わったときだけミニマップ（赤枠）も更新。
  schedulePostTransform(ctx === rootCtx);
}

// editor 要素が画面上で実際に何倍に拡大表示されているか（祖先の transform の
// 累積スケール）。ルート面は 1。内包面（子/孫）は親 world の scale が掛かるため
// getBoundingClientRect().width / offsetWidth で実効スケールを得る。
function editorScreenScale(ctx) {
  const ed = ctx.el.editor;
  const ow = ed.offsetWidth;
  if (!ow) return 1;
  return ed.getBoundingClientRect().width / ow;
}

// 画面px と world px の比率（world px = 画面px / worldPerScreen）。
// = ctx.zoom（world→editor）× 祖先スケール（editor→画面）。
// 画面上の差分や getBoundingClientRect の実寸を world 単位へ直すのに使う。
function worldPerScreen(ctx) {
  return ctx.zoom * editorScreenScale(ctx);
}

// 画面座標(client) → world 座標（pan/zoom を打ち消した、ノードの x/y と同じ系）。
// 内包面では editor 自体が祖先 transform で拡大されているので、まず実効スケールで
// 画面px→editor px に直してから pan/zoom を打ち消す。
function clientToWorld(clientX, clientY, ctx = currentCtx) {
  const eb = ctx.el.editor.getBoundingClientRect();
  const s = editorScreenScale(ctx); // 祖先の累積スケール
  const ex = (clientX - eb.left) / s; // editor 内 px（未 pan/zoom）
  const ey = (clientY - eb.top) / s;
  return {
    x: (ex - ctx.panX) / ctx.zoom,
    y: (ey - ctx.panY) / ctx.zoom,
  };
}

// 中ボタンドラッグでパン。pan 状態は ctx.pan に持つ。
// 操作対象の面は「マウスが乗っている面（currentCtx）」で判別する。
// 各面のイベントは stopPropagation して、入れ子の親面が二重に反応しないようにする。
function setupCanvasPanZoom(ctx = currentCtx) {
  const editor = ctx.el.editor;
  // この面の DOM 要素から ctx を引けるようにする（hover 判定用）。
  editor._ctx = ctx;

  // マウスがこの面に乗ったら操作対象にする＋world 位置を記録。
  // キャプチャ phase で設定するので、入れ子では「親→子」の順に走り、
  // 最も内側（カーソル直下）の面が最後に書き込んで勝つ。stopPropagation は
  // しない（window のドラッグ移動リスナを止めてしまうため）。
  editor.addEventListener(
    "pointermove",
    (e) => {
      currentCtx = ctx;
      ctx.lastMouseWorld = clientToWorld(e.clientX, e.clientY, ctx);
    },
    true, // capture
  );

  // 中ボタンのパンは、子要素（セグメント等）の pointerdown より先に拾う。
  // capture フェーズで処理し、stopPropagation して配線などを始めさせない。
  // 【仕様】中ドラッグは常にルート面をパンする（子パネル上でも親をパン）。
  // 子パネル内部のパンは、子パネル右上のパンアイコン（startEmbedPan）で行う。
  editor.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 1) return; // 中ボタンのみ
      // 子面のハンドラでは何もしない。ルート面だけが反応し、必ずルートをパン。
      if (ctx !== rootCtx) return;
      currentCtx = ctx;
      e.preventDefault();
      e.stopPropagation();
      rootCtx.pan = {
        sx: e.clientX,
        sy: e.clientY,
        ox: rootCtx.panX,
        oy: rootCtx.panY,
      };
      const move = (ev) => onPanMove(ev, rootCtx);
      const up = () => {
        onPanUp(rootCtx);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    true, // capture
  );

  editor.addEventListener("pointerdown", (e) => {
    // 入れ子の親面に伝播させない（この面だけが反応する）。
    e.stopPropagation();
    currentCtx = ctx;
    // 右ボタンドラッグ＝ナイフカット（線・ブロックを横切ると削除）。
    if (e.button === 2) {
      startKnife(e, ctx);
      return;
    }
    if (e.button === 0) {
      // 左ボタン: 何もない所（ブロック/ハンドル/操作子以外）なら矩形選択。
      // 注意: closest はこの面を内包する外側の .anode（メニューブロック）まで
      // 拾ってしまうので、「マッチ要素がこの面（editor）に属するか」も確認する。
      // そうしないと内包面では常に外側 .anode に当たって矩形選択が始まらない。
      const hit = e.target.closest(
        ".anode, .app-node, .qpanel, .initial-panel, .pv-seg, .pv-label, .pv-label-bg, " +
          ".pv-hub, .pv-move-handle, .pv-outer-handle, .pv-handle-hit, .pv-rotate-handle, " +
          ".connector-hit, input, select, button",
      );
      const hitInThisEditor =
        hit && hit.closest(".embed-editor, .editor") === editor;
      if (hitInThisEditor) {
        return;
      }
      startMarquee(e, ctx);
      return;
    }
    // 中ボタン(1)は上の capture フェーズで処理済み。
  });

  // ホイールでズーム（カーソル位置を中心に）。100%・200% などの整数倍を
  // 必ず通るよう、決まったズーム段（ZOOM_STOPS）を1段ずつ移動する。
  // ズーム機能は「親（root）面のみ」が持つ。子/孫パネルにはホイールリスナを
  // 一切付けない＝子の上でホイールしてもイベントは root の editor まで bubble し、
  // この root のハンドラが（カーソル位置を中心に）親をズームする。
  if (ctx === rootCtx) {
    editor.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        currentCtx = ctx;
        // 右ボタンを押しながらホイール → タブ（プロファイル）移動。
        if (e.buttons & 2) {
          switchTabByWheel(e.deltaY < 0 ? -1 : 1);
          return;
        }
        const eb = editor.getBoundingClientRect();
        const mx = e.clientX - eb.left;
        const my = e.clientY - eb.top;
        const newZoom = nextZoomStop(ctx.zoom, e.deltaY < 0 ? 1 : -1);
        if (newZoom === ctx.zoom) return;
        // カーソル下の world 点が動かないよう pan を補正。
        const wx = (mx - ctx.panX) / ctx.zoom;
        const wy = (my - ctx.panY) / ctx.zoom;
        ctx.panX = mx - wx * newZoom;
        ctx.panY = my - wy * newZoom;
        ctx.zoom = newZoom;
        applyTransform(ctx);
        showZoomIndicator(ctx);
      },
      { passive: false },
    );
  }

  // 中ボタンのオートスクロール（丸いやつ）を抑制。
  editor.addEventListener("auxclick", (e) => {
    if (e.button === 1) e.preventDefault();
  });
}

// タブ（プロファイル）切替の共通処理。タブ操作は常にルート面が対象なので、
// currentCtx を rootCtx に戻してから root を明示的に再描画する。これをしないと
// 直前に子パネルへ hover していると currentCtx が子のままで、クリック切替時の
// render() が子面を描いてしまい「データは切替わったのにプレビューが変わらない」
// 状態になる（起動直後にこの不整合が起きやすかった）。
function switchToTab(i) {
  const profiles = config.profiles || [];
  if (i < 0 || i >= profiles.length) return;
  if (i === rootCtx.profileIndex) return;
  saveCamera(rootCtx, rootCtx.profileIndex);
  rootCtx.profileIndex = i;
  restoreOrResetView(rootCtx, i);
  currentCtx = rootCtx; // 操作対象をルートへ確実に戻す
  render(rootCtx); // ルート面を明示的に描く
}

// 右ボタン＋ホイールでタブ（プロファイル）を切り替える。
let tabWheelGuard = false;
function switchTabByWheel(dir) {
  const profiles = config.profiles || [];
  if (profiles.length < 2) return;
  // 連続ホイールの過剰切替を軽く抑制（短時間に1段だけ）。
  if (tabWheelGuard) return;
  tabWheelGuard = true;
  setTimeout(() => (tabWheelGuard = false), 120);

  let i = rootCtx.profileIndex + dir;
  if (i < 0) i = profiles.length - 1;
  if (i >= profiles.length) i = 0;
  switchToTab(i);
}

function onPanMove(e, ctx = currentCtx) {
  if (!ctx.pan) return;
  // panX/panY はこの面(editor)のローカル座標。子/孫面は親の #world が
  // scale されているぶん画面上で拡縮表示されるので、画面px の移動量を
  // 祖先の累積スケールで割って editor ローカル px に直す（root では s=1）。
  const s = editorScreenScale(ctx) || 1;
  ctx.panX = ctx.pan.ox + (e.clientX - ctx.pan.sx) / s;
  ctx.panY = ctx.pan.oy + (e.clientY - ctx.pan.sy) / s;
  applyTransform(ctx);
}

// ズーム%を一時表示して 1 秒後にすっと消す。
function showZoomIndicator(ctx = currentCtx) {
  const el = ctx.el.zoomIndicator;
  if (!el) return;
  el.textContent = `${Math.round(ctx.zoom * 100)}%`;
  el.classList.add("show");
  clearTimeout(ctx.zoomHideTimer);
  ctx.zoomHideTimer = setTimeout(() => el.classList.remove("show"), 1000);
}

function onPanUp(ctx = currentCtx) {
  ctx.pan = null;
}

// ── 矩形選択（何もない所を左ドラッグでブロックを複数選択） ──────────
// marquee 状態は ctx.marquee に持つ。
function startMarquee(e, ctx = currentCtx) {
  e.preventDefault();
  const editor = ctx.el.editor;
  const eb = editor.getBoundingClientRect();
  // 追加選択（Shift/Ctrl）でなければ既存選択をクリア。
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  if (!additive) clearSelection(ctx);
  const box = document.createElement("div");
  box.className = "marquee";
  box.id = "marquee-box";
  editor.appendChild(box);
  ctx.marquee = {
    eb,
    sx: e.clientX,
    sy: e.clientY,
    box,
    moved: false,
    additive,
    base: { nodes: new Set(ctx.selNodes), apps: new Set(ctx.selApps) },
  };
  const move = (ev) => onMarqueeMove(ev, ctx);
  const up = () => {
    onMarqueeUp(ctx);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    window.removeEventListener("blur", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  // Win+Shift+S 等でフォーカスを奪われると pointerup が来ず矩形が残るため、
  // 入力中断・フォーカス喪失でも終了させる。
  window.addEventListener("pointercancel", up);
  window.addEventListener("blur", up);
}
function onMarqueeMove(e, ctx = currentCtx) {
  const marquee = ctx.marquee;
  if (!marquee) return;
  const { eb, sx, sy, box } = marquee;
  if (Math.hypot(e.clientX - sx, e.clientY - sy) > 3) marquee.moved = true;
  // ドラッグ中はカーソル近くに解説ラベルを追従表示（右ドラッグのナイフと同様）。
  if (marquee.moved) showMarqueeHint(e.clientX, e.clientY);
  const left = Math.min(sx, e.clientX);
  const top = Math.min(sy, e.clientY);
  const w = Math.abs(e.clientX - sx);
  const h = Math.abs(e.clientY - sy);
  // 矩形は editor の中（祖先 transform で拡縮される空間）に置くので、画面 px の
  // 距離を祖先スケールで割って editor ローカル座標へ直す。これをしないと
  // 子/孫面（親がズーム/パン）でカーソルと枠がズレる。
  const s = editorScreenScale(ctx) || 1;
  box.style.left = `${(left - eb.left) / s}px`;
  box.style.top = `${(top - eb.top) / s}px`;
  box.style.width = `${w / s}px`;
  box.style.height = `${h / s}px`;

  // 交差判定（画面 client 矩形どうし）。base＋今回の交差で選択を作る。
  const rect = { left, top, right: left + w, bottom: top + h };
  ctx.selNodes = new Set(marquee.base.nodes);
  ctx.selApps = new Set(marquee.base.apps);
  const apps = profile(ctx).app_nodes;
  ownAll(ctx, ".anode").forEach((el) => {
    if (rectsOverlap(rect, el.getBoundingClientRect())) {
      ctx.selNodes.add(el.dataset.id);
    }
  });
  ownAll(ctx, ".app-node").forEach((el, i) => {
    if (rectsOverlap(rect, el.getBoundingClientRect())) {
      ctx.selApps.add(apps[i]);
    }
  });
  applySelectionClasses(ctx);
}
function onMarqueeUp(ctx = currentCtx) {
  const marquee = ctx.marquee;
  hideMarqueeHint();
  if (marquee && marquee.box) marquee.box.remove();
  // ドラッグせず単にクリック（＝何もない所をクリック）なら選択を解除。
  // 追加選択(Shift/Ctrl)のクリックでは解除しない。
  if (marquee && !marquee.moved && !marquee.additive) {
    clearSelection(ctx);
    applySelectionClasses(ctx);
  }
  ctx.marquee = null;
}
function rectsOverlap(a, b) {
  return !(
    a.right < b.left ||
    a.left > b.right ||
    a.bottom < b.top ||
    a.top > b.bottom
  );
}

// ナイフ操作中にカーソル近くへ出す解説ラベル（黒半透明）。
let knifeHintEl = null;
function showKnifeHint(clientX, clientY) {
  if (!knifeHintEl) {
    knifeHintEl = document.createElement("div");
    knifeHintEl.className = "knife-hint";
    knifeHintEl.textContent = "右ドラッグは触れるものを削除します";
    document.body.appendChild(knifeHintEl);
  }
  // カーソル位置をラベルの左上の基準にし、少し下に出す（見切れてもOK）。
  knifeHintEl.style.left = `${clientX}px`;
  knifeHintEl.style.top = `${clientY + 30}px`;
}
function hideKnifeHint() {
  if (knifeHintEl) {
    knifeHintEl.remove();
    knifeHintEl = null;
  }
}

// 矩形選択（左ドラッグ）中にカーソル近くへ出す解説ラベル（ナイフと同じ作り）。
let marqueeHintEl = null;
function showMarqueeHint(clientX, clientY) {
  if (!marqueeHintEl) {
    marqueeHintEl = document.createElement("div");
    marqueeHintEl.className = "select-hint"; // 青系・中立（削除のナイフと区別）
    marqueeHintEl.textContent =
      "複数選択して移動・コピー・削除ができます";
    document.body.appendChild(marqueeHintEl);
  }
  marqueeHintEl.style.left = `${clientX}px`;
  marqueeHintEl.style.top = `${clientY + 34}px`;
}
function hideMarqueeHint() {
  if (marqueeHintEl) {
    marqueeHintEl.remove();
    marqueeHintEl = null;
  }
}

// ── ナイフカット（右ボタンドラッグで配線を横切って削除） ──────────
// knife 状態は ctx.knife に持つ。
function startKnife(e, ctx = currentCtx) {
  e.preventDefault();
  const w = clientToWorld(e.clientX, e.clientY, ctx);
  // 単発右クリックでメニューを出すかの判定。すでに右クリックに別の意味が
  // ある所（配線・◯ポート）と、フォーム操作子（入力/選択/ボタン）の上では
  // 出さない。ブロック本体・クイックパネル・パイの上では出す（追加できる）。
  const onSomething = e.target.closest(
    ".anode-port, .qslot-port, .connector-hit, input, select, button",
  );
  // sx/sy（client）と moved を持つ。動かさず離したらコンテキストメニューを出す。
  ctx.knife = {
    last: w,
    trail: [w],
    cut: false,
    moved: false,
    sx: e.clientX,
    sy: e.clientY,
    startWorld: w,
    onEmpty: !onSomething,
  };
  const move = (ev) => onKnifeMove(ev, ctx);
  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", cancel);
  };
  const up = () => {
    onKnifeUp(ctx);
    cleanup();
  };
  // フォーカス喪失・入力中断ではメニューを開かず静かに破棄する
  // （up 扱いにすると「動かさず離した」判定でメニューが開いてしまう）。
  const cancel = () => {
    ctx.knife = null;
    clearKnifeTrail(ctx);
    hideKnifeHint();
    cleanup();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", cancel);
}

function onKnifeMove(e, ctx = currentCtx) {
  const knife = ctx.knife;
  if (!knife) return;
  // 一定px動いたら「ナイフ操作」とみなす（単発右クリックと区別）。
  if (Math.hypot(e.clientX - knife.sx, e.clientY - knife.sy) > 4) {
    knife.moved = true;
  }
  // ナイフ操作中はカーソル近くに解説ラベルを追従表示。
  if (knife.moved) showKnifeHint(e.clientX, e.clientY);
  const w = clientToWorld(e.clientX, e.clientY, ctx);
  const a = knife.last;
  const b = w;

  // この移動区間 a→b が、いずれかの配線（折れ線）と交差したら切る。
  const toCut = new Set(); // セグメント index
  const toCutQuick = new Set(); // クイックスロット参照
  let cutInitial = false; // 初期アクション配線を切ったか
  for (const conn of ctx.connectorGeo) {
    const pts = conn.pts;
    for (let i = 0; i + 1 < pts.length; i++) {
      if (segIntersect(a, b, pts[i], pts[i + 1])) {
        if (conn.initial) cutInitial = true;
        else if (conn.quickSlot) toCutQuick.add(conn.quickSlot);
        else toCut.add(conn.segIndex);
        break;
      }
    }
  }

  // a→b がブロック（ノード/アプリ）の矩形を横切ったら、そのブロックも削除。
  const cutNodeIds = [];
  ownAll(ctx, ".anode").forEach((el) => {
    if (strokeHitsElement(a, b, el, ctx)) cutNodeIds.push(el.dataset.id);
  });
  const apps = profile(ctx).app_nodes;
  const cutApps = [];
  ownAll(ctx, ".app-node").forEach((el, i) => {
    if (strokeHitsElement(a, b, el, ctx)) cutApps.push(apps[i]);
  });

  knife.last = b;
  knife.trail.push(b);
  if (knife.trail.length > 16) knife.trail.shift(); // 軌跡は直近だけ

  const cutBlocks = cutNodeIds.length > 0 || cutApps.length > 0;
  if (toCut.size > 0 || toCutQuick.size > 0 || cutInitial || cutBlocks) {
    knife.cut = true;
    if (cutBlocks) knife.cutBlocks = true;
    const p = profile(ctx);
    // 配線を切る（セグメント＋クイックスロット＋初期アクション）。
    toCut.forEach((si) => {
      if (p.segments[si]) p.segments[si].head = null;
    });
    toCutQuick.forEach((slot) => {
      slot.head = null;
    });
    if (cutInitial) p.initial_head = null;
    // ブロックを削除（ノードはチェーン込み）。
    if (cutNodeIds.length > 0) {
      const ids = new Set();
      cutNodeIds.forEach((id) => collectChain(id).forEach((c) => ids.add(c)));
      p.segments.forEach((s) => {
        if (s.head && ids.has(s.head)) s.head = null;
      });
      (p.quick_slots || []).forEach((q) => {
        if (q.head && ids.has(q.head)) q.head = null;
      });
      if (p.initial_head && ids.has(p.initial_head)) p.initial_head = null;
      p.nodes.forEach((n) => {
        if (n.next && ids.has(n.next)) n.next = null;
      });
      p.nodes = p.nodes.filter((n) => !ids.has(n.id));
    }
    if (cutApps.length > 0) {
      const cutSet = new Set(cutApps);
      p.app_nodes = p.app_nodes.filter((x) => !cutSet.has(x));
    }
    markDirty();
    render(ctx); // 配線・ブロック・connectorGeo を作り直す
  }
  drawKnifeTrail(ctx);
}

// 線分 a→b（world）が要素 el の矩形（world 換算）と交差/内包するか。
function strokeHitsElement(a, b, el, ctx = currentCtx) {
  const r = el.getBoundingClientRect();
  const tl = clientToWorld(r.left, r.top, ctx);
  const br = clientToWorld(r.right, r.bottom, ctx);
  const rect = { left: tl.x, top: tl.y, right: br.x, bottom: br.y };
  // どちらかの端点が矩形内なら命中。
  const inside = (p) =>
    p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;
  if (inside(a) || inside(b)) return true;
  // 4辺のいずれかと交差すれば命中。
  const c1 = { x: rect.left, y: rect.top };
  const c2 = { x: rect.right, y: rect.top };
  const c3 = { x: rect.right, y: rect.bottom };
  const c4 = { x: rect.left, y: rect.bottom };
  return (
    segIntersect(a, b, c1, c2) ||
    segIntersect(a, b, c2, c3) ||
    segIntersect(a, b, c3, c4) ||
    segIntersect(a, b, c4, c1)
  );
}

function onKnifeUp(ctx = currentCtx) {
  const knife = ctx.knife;
  if (knife && knife.cutBlocks) {
    showDeleteToast();
  } else if (knife && knife.cut) {
    showToast("配線を切りました");
  } else if (knife && !knife.moved && knife.onEmpty) {
    // 何もない所で動かさず離した＝単発右クリック → コンテキストメニュー。
    openCanvasContextMenu(knife.sx, knife.sy, knife.startWorld, ctx);
  }
  ctx.knife = null;
  clearKnifeTrail(ctx);
  hideKnifeHint();
}

// ── キャンバスの右クリックメニュー（何もない所で単発右クリック） ────
// 右クリックした world 位置 (world) にブロックを作る。clientX/Y はメニュー
// 表示位置。ctx はその面（親/子）。
let canvasMenuEl = null;
function closeCanvasContextMenu() {
  if (canvasMenuEl) {
    canvasMenuEl.remove();
    canvasMenuEl = null;
  }
  window.removeEventListener("pointerdown", onCanvasMenuOutside, true);
  window.removeEventListener("keydown", onCanvasMenuKey, true);
}
function onCanvasMenuOutside(e) {
  if (canvasMenuEl && !canvasMenuEl.contains(e.target)) closeCanvasContextMenu();
}
function onCanvasMenuKey(e) {
  if (e.key === "Escape") closeCanvasContextMenu();
}

function openCanvasContextMenu(clientX, clientY, world, ctx = currentCtx) {
  closeCanvasContextMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";

  const addItem = (label, fn, opts = {}) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "ctx-menu-item" + (opts.danger ? " danger" : "");
    item.textContent = label;
    item.addEventListener("click", () => {
      closeCanvasContextMenu();
      fn();
    });
    menu.appendChild(item);
  };
  const addSep = () => {
    const sep = document.createElement("div");
    sep.className = "ctx-menu-sep";
    menu.appendChild(sep);
  };

  // 作成位置（world）。ブロックの左上がだいたいカーソルに来るよう少し左上へ。
  const px = world.x - 16;
  const py = world.y - 14;

  addItem("アクションを追加", () => {
    const p = profile(ctx);
    const id = newNodeId(ctx);
    p.nodes.push({ id, type: "key", value: "", x: px, y: py, next: null });
    markDirty();
    render(ctx);
  });
  // 対象アプリはサブメニュー（子）では指定不可（親プロファイルに準じる）。
  // ルート面のみ「対象アプリを追加」を出す。
  if (!ctx.parentCtx) {
    addItem("対象アプリを追加", () => {
      const p = profile(ctx);
      p.app_nodes.push({
        name: "",
        x: px,
        y: py,
        enabled: true,
        exclude_titles: [],
      });
      markDirty();
      render(ctx);
    });
  }

  // クリップボードに内容があれば「貼り付け」。
  if (clipboard && (clipboard.nodes.length || clipboard.apps.length)) {
    addSep();
    addItem("貼り付け", () => pasteClipboard(ctx));
  }

  // 選択物があれば「コピー」「削除」。
  if (hasSelection(ctx)) {
    addSep();
    addItem("コピー", () => copySelection(ctx));
    addItem("削除", () => deleteSelection(ctx), { danger: true });
  }

  document.body.appendChild(menu);
  // 画面内に収まるよう配置（右下が見切れるなら左上へ寄せる）。
  const r = menu.getBoundingClientRect();
  let x = clientX;
  let y = clientY;
  if (x + r.width > window.innerWidth - 6) x = window.innerWidth - 6 - r.width;
  if (y + r.height > window.innerHeight - 6)
    y = window.innerHeight - 6 - r.height;
  menu.style.left = `${Math.max(6, x)}px`;
  menu.style.top = `${Math.max(6, y)}px`;
  canvasMenuEl = menu;
  // 次フレームから外側クリック/Escで閉じる（この pointerup 連鎖では閉じない）。
  setTimeout(() => {
    window.addEventListener("pointerdown", onCanvasMenuOutside, true);
    window.addEventListener("keydown", onCanvasMenuKey, true);
  }, 0);
}

// タブ右クリックのコンテキストメニュー（プロファイルを複製）。
function openTabContextMenu(clientX, clientY, index) {
  closeCanvasContextMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  const addItem = (label, fn, opts = {}) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "ctx-menu-item" + (opts.danger ? " danger" : "");
    item.textContent = label;
    item.addEventListener("click", () => {
      closeCanvasContextMenu();
      fn();
    });
    menu.appendChild(item);
  };

  addItem("プロファイルを複製", () => duplicateProfile(index));

  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  let x = clientX;
  let y = clientY;
  if (x + r.width > window.innerWidth - 6) x = window.innerWidth - 6 - r.width;
  if (y + r.height > window.innerHeight - 6)
    y = window.innerHeight - 6 - r.height;
  menu.style.left = `${Math.max(6, x)}px`;
  menu.style.top = `${Math.max(6, y)}px`;
  canvasMenuEl = menu; // 同じ閉じ機構を流用
  setTimeout(() => {
    window.addEventListener("pointerdown", onCanvasMenuOutside, true);
    window.addEventListener("keydown", onCanvasMenuKey, true);
  }, 0);
}

// プロファイルを複製する。中身を丸ごとディープコピーし、新 id を振って
// 元の隣に挿入、複製先へ切り替える。サブメニューの node id はプロファイル内で
// 完結するのでそのままで衝突しない。
function duplicateProfile(index) {
  const src = config.profiles[index];
  if (!src) return;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = `p${Date.now()}${Math.floor(Math.random() * 1000)}`;
  copy.protected = false; // 複製は保護を引き継がない（誤削除防止は個別に設定）
  // 名前: 元の表示名 + 「のコピー」。未設定（空名）なら空のままにして
  // 自動表示（アプリ名）に任せる。
  const baseName = (src.name || "").trim();
  if (baseName) copy.name = `${baseName} のコピー`;
  config.profiles.splice(index + 1, 0, copy);
  markDirty();
  // 複製先タブへ切り替え。
  saveCamera(rootCtx, rootCtx.profileIndex);
  rootCtx.profileIndex = index + 1;
  restoreOrResetView(rootCtx, index + 1);
  render();
  showToast("プロファイルを複製しました");
}

// ナイフの軌跡を connectors SVG に重ねて描く（赤い細線）。
function drawKnifeTrail(ctx = currentCtx) {
  const svg = ctx.el.connectors;
  const knife = ctx.knife;
  if (!svg || !knife) return;
  clearKnifeTrail(ctx);
  if (knife.trail.length < 2) return;
  const d = knife.trail
    .map((pt, i) => `${i === 0 ? "M" : "L"} ${pt.x} ${pt.y}`)
    .join(" ");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("class", "knife-trail");
  path.setAttribute("id", "knife-trail");
  svg.appendChild(path);
}
function clearKnifeTrail(ctx = currentCtx) {
  const old = (ctx.el.connectors || document).querySelector("#knife-trail, .knife-trail");
  if (old) old.remove();
}

// 線分 p1-p2 と p3-p4 が交差するか（端点接触含む）。
function segIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) {
    return true;
  }
  return false;
}

// 新しいノード id を作る。nodeSeq は全面で共有（id 衝突を避ける）。
let nodeSeq = 1;
function newNodeId(ctx = currentCtx) {
  const p = profile(ctx);
  let id;
  do {
    id = `node${nodeSeq++}`;
  } while (p.nodes.some((n) => n.id === id));
  return id;
}

// あるノードを next に持つノード（＝直上のノード）を返す。
function parentOf(id, ctx = currentCtx) {
  return profile(ctx).nodes.find((n) => n.next === id) || null;
}
// あるノードを head に持つセグメントの index 群。
function segmentsHeading(id, ctx = currentCtx) {
  const out = [];
  profile(ctx).segments.forEach((s, i) => {
    if (s.head === id) out.push(i);
  });
  return out;
}

// ノードが属するスタックの先頭ノード id を返す（parent を上へ辿る）。
function stackHeadOf(id, ctx = currentCtx) {
  let cur = id;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const par = parentOf(cur, ctx);
    if (!par) return cur;
    cur = par.id;
  }
  return cur;
}

// ノードに繋がっている接続元セグメントの色を返す（未接続なら null）。
// 合体スタックの途中ノードも、先頭を辿ってその接続元の色を継ぐ。
function connectedSegColor(id, ctx = currentCtx) {
  const head = stackHeadOf(id, ctx);
  const seg = profile(ctx).segments.find((s) => s.head === head);
  return seg ? seg.color || "#888" : null;
}

// ── 全体描画 ──────────────────────────────────────────────────────
function render(ctx = currentCtx) {
  const p = profile(ctx);

  // タブバーはルート面専用。
  if (ctx === rootCtx) renderTabs();
  // 画面最下部の下部ツールバーは「今操作している面(currentCtx)」を反映。
  syncBottomToolbar();

  renderPreview(ctx);
  renderNodes(ctx);
  scheduleConnectors(ctx);
  renderApps(ctx);
  renderQuickSlots(ctx);
  renderInitialPanel(ctx);
  applySelectionClasses(ctx);

  // 右上ミニマップ（ルート面のみ）。中身が変わったので描き直す。
  if (ctx === rootCtx) requestAnimationFrame(() => updateMinimap());
}

// ── ミニマップ（ナビゲーター・ルート面のみ） ──────────────────────
// ルートキャンバスの全コンテンツを縮小表示し、現在の表示範囲を赤枠で示す。
// クリック/ドラッグでその位置を中心にパンする（クリスタのナビゲーター準拠）。

// ノードの world 上の占有サイズ（左上 x/y ＋ 幅 w/高 h）。メニュー型は
// 内包ボックス（embedW/embedH）の実サイズ、通常ノードはおおよそ 220×56。
function nodeFootprint(n) {
  const isMenu = (n.type || "key") === "menu";
  return {
    x: n.x ?? 0,
    y: n.y ?? 0,
    w: isMenu ? n.embedW || EMBED_DEFAULT_W : 220,
    h: isMenu ? n.embedH || EMBED_DEFAULT_H : 56,
  };
}

// ルート面の全コンテンツの world バウンディングボックス（余白付き）。
function rootContentBBox() {
  const p = profile(rootCtx);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const add = (x, y, w = 0, h = 0) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  // パイ（中心±外周）。
  const c = pvCenter(rootCtx);
  const ro = pvOuter(rootCtx);
  add(c.cx - ro, c.cy - ro, ro * 2, ro * 2);
  // ノード（メニュー型は内包ボックスの実サイズで囲む）。
  (p.nodes || []).forEach((n) => {
    const f = nodeFootprint(n);
    add(f.x, f.y, f.w, f.h);
  });
  // アプリ（おおよそ 180×34）。
  (p.app_nodes || []).forEach((a) => add(a.x ?? 0, a.y ?? 0, 180, 34));
  // クイックパネル（左クリック行の x/y 基準・おおよそ 200×120）。
  const ql = (p.quick_slots || []).find((s) => s.kind === "left");
  if (ql) add(ql.x ?? 40, ql.y ?? 300, 200, 120);
  if (!isFinite(minX)) {
    // 何も無ければパイ周辺を既定にする。
    minX = c.cx - 300;
    minY = c.cy - 300;
    maxX = c.cx + 300;
    maxY = c.cy + 300;
  }
  const pad = 80;
  return {
    x: minX - pad,
    y: minY - pad,
    w: maxX - minX + pad * 2,
    h: maxY - minY + pad * 2,
  };
}

// ミニマップ→world のスケール等を計算（描画・操作で共用）。
function minimapGeom() {
  const map = document.getElementById("minimap");
  const cv = document.getElementById("minimap-canvas");
  if (!map || !cv) return null;
  const CW = map.clientWidth || 200;
  const CH = map.clientHeight || 150;
  const bb = rootContentBBox();
  // bbox 全体がミニマップに収まる縮小率（アスペクト維持）。
  const s = Math.min(CW / bb.w, CH / bb.h);
  // 中央寄せのためのオフセット（ミニマップ内 px）。
  const offX = (CW - bb.w * s) / 2;
  const offY = (CH - bb.h * s) / 2;
  return { map, cv, CW, CH, bb, s, offX, offY };
}

// world 座標 → ミニマップ内 px。
function worldToMinimap(g, wx, wy) {
  return {
    x: g.offX + (wx - g.bb.x) * g.s,
    y: g.offY + (wy - g.bb.y) * g.s,
  };
}
// ミニマップ内 px → world 座標。
function minimapToWorld(g, mx, my) {
  return {
    x: g.bb.x + (mx - g.offX) / g.s,
    y: g.bb.y + (my - g.offY) / g.s,
  };
}

function updateMinimap() {
  const g = minimapGeom();
  if (!g) return;
  const { cv, CW, CH, s } = g;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(CW * dpr);
  cv.height = Math.round(CH * dpr);
  cv.style.width = `${CW}px`;
  cv.style.height = `${CH}px`;
  const ctx2 = cv.getContext("2d");
  ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2.clearRect(0, 0, CW, CH);

  const p = profile(rootCtx);

  // ルート面のパイ・ノード・アプリを描く。メニュー型ノードは内包ボックスの
  // 実サイズで描き、その「中」に子（孫…）のパイ/ノードも縮小して描き込む。
  drawMiniProfile(
    ctx2,
    g,
    p,
    (wx, wy) => worldToMinimap(g, wx, wy),
    g.s,
    0,
    rootCtx,
  );

  // 現在の表示範囲（赤枠）。editor の可視領域を world に直す。
  const ed = rootCtx.el.editor;
  const ew = ed.clientWidth;
  const eh = ed.clientHeight;
  // editor 左上(0,0)と右下(ew,eh) の world 座標。
  const tl = {
    x: (0 - rootCtx.panX) / rootCtx.zoom,
    y: (0 - rootCtx.panY) / rootCtx.zoom,
  };
  const br = {
    x: (ew - rootCtx.panX) / rootCtx.zoom,
    y: (eh - rootCtx.panY) / rootCtx.zoom,
  };
  const v1 = worldToMinimap(g, tl.x, tl.y);
  const v2 = worldToMinimap(g, br.x, br.y);
  const view = document.getElementById("minimap-view");
  if (view) {
    const vx = Math.max(0, Math.min(CW, v1.x));
    const vy = Math.max(0, Math.min(CH, v1.y));
    const vw = Math.min(CW, v2.x) - vx;
    const vh = Math.min(CH, v2.y) - vy;
    view.style.left = `${vx}px`;
    view.style.top = `${vy}px`;
    view.style.width = `${Math.max(0, vw)}px`;
    view.style.height = `${Math.max(0, vh)}px`;
  }
}

// プロファイル状データ（パイ＋ノード＋アプリ）をミニマップへ描く。
//  - map(wx,wy) … この面の world 座標 → ミニマップ内 px へ変換する関数
//  - sc        … この面の world→px スケール（半径・サイズ用）
//  - depth     … 再帰の深さ（root=0）。EMBED_MAX_DEPTH を超えたら子は描かない
// メニュー型ノードは内包ボックスの実サイズで矩形を描き、その内側へ
// 子（孫…）のサブメニューを「内容に合わせて縮小（カメラ非依存）」で描き込む。
function drawMiniProfile(ctx2, g, p, map, sc, depth, pvHint) {
  // パイ（円）。pvLeft/pvTop は ctx 側に持つため、root では rootCtx を
  // ヒントに使う。子は ctx を持たない（既定 20）ので submenu の値→既定の順。
  const pvL = (pvHint?.pvLeft ?? p.pvLeft ?? 20) + PV_R;
  const pvT = (pvHint?.pvTop ?? p.pvTop ?? 20) + PV_R;
  const ro = (p.outer_r ?? 160) * PV_SCALE;
  const cc = map(pvL, pvT);
  ctx2.fillStyle = "rgba(120,130,160,0.55)";
  ctx2.beginPath();
  ctx2.arc(cc.x, cc.y, Math.max(1.5, ro * sc), 0, Math.PI * 2);
  ctx2.fill();

  // アプリ（緑系）。
  (p.app_nodes || []).forEach((a) => {
    const m = map(a.x ?? 0, a.y ?? 0);
    ctx2.fillStyle = "#3fae6a";
    ctx2.fillRect(m.x, m.y, Math.max(1.5, 180 * sc), Math.max(1.5, 24 * sc));
  });

  // ノード。メニュー型は実サイズの枠＋中身（子）を描く。
  (p.nodes || []).forEach((n) => {
    const f = nodeFootprint(n);
    const tl = map(f.x, f.y);
    const w = Math.max(2, f.w * sc);
    const h = Math.max(2, f.h * sc);
    const isMenu = (n.type || "key") === "menu";

    if (isMenu) {
      // メニューブロックの枠（薄紫の塗り＋枠線）。
      ctx2.fillStyle = "rgba(150,130,210,0.22)";
      ctx2.fillRect(tl.x, tl.y, w, h);
      ctx2.strokeStyle = "rgba(180,160,230,0.7)";
      ctx2.lineWidth = 1;
      ctx2.strokeRect(tl.x + 0.5, tl.y + 0.5, w - 1, h - 1);

      // 中身（子サブメニュー）を内側へ縮小描画。深さ上限まで再帰。
      const sub = n.submenu;
      const childOk =
        sub && typeof sub === "object" && depth + 1 <= EMBED_MAX_DEPTH;
      if (childOk) {
        // ブロック内側の描画領域（上段の操作行ぶん上を空ける／余白）。
        const HEADER = Math.min(h * 0.32, Math.max(4, 26 * sc));
        const PAD = Math.max(1, 3 * sc);
        const rx = tl.x + PAD;
        const ry = tl.y + HEADER;
        const rw = Math.max(2, w - PAD * 2);
        const rh = Math.max(2, h - HEADER - PAD);
        if (rw > 3 && rh > 3) {
          const cmap = childMinimapMapper(sub, rx, ry, rw, rh);
          ctx2.save();
          ctx2.beginPath();
          ctx2.rect(rx, ry, rw, rh); // 枠外へはみ出さないようクリップ
          ctx2.clip();
          drawMiniProfile(ctx2, g, sub, cmap.map, cmap.sc, depth + 1);
          ctx2.restore();
        }
      }
    } else {
      // 通常ノード（接続色の小さな四角）。接続色はルート面のみ解決できる
      // （子の ctx を持たないため）。子では既定色の小四角にする。
      const col =
        depth === 0 ? connectedSegColor(n.id, rootCtx) || "#9aa3b8" : "#9aa3b8";
      ctx2.fillStyle = col;
      ctx2.fillRect(tl.x, tl.y, w, Math.max(2, 30 * sc));
    }
  });
}

// サブメニュー sub の中身を、ミニマップ内の矩形 (rx,ry,rw,rh) に
// アスペクト維持で収めるための map(wx,wy)/sc を返す（子のカメラに依存せず、
// データそのものの広がりに合わせて縮小＝俯瞰表示にする）。
function childMinimapMapper(sub, rx, ry, rw, rh) {
  // sub の world バウンディングボックス（パイ＋ノード＋アプリ）。
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const add = (x, y, w = 0, h = 0) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  const pvL = (sub.pvLeft ?? 20) + PV_R;
  const pvT = (sub.pvTop ?? 20) + PV_R;
  const ro = (sub.outer_r ?? 160) * PV_SCALE;
  add(pvL - ro, pvT - ro, ro * 2, ro * 2);
  (sub.nodes || []).forEach((n) => {
    const f = nodeFootprint(n);
    add(f.x, f.y, f.w, f.h);
  });
  (sub.app_nodes || []).forEach((a) => add(a.x ?? 0, a.y ?? 0, 180, 34));
  if (!isFinite(minX)) {
    minX = pvL - 300;
    minY = pvT - 300;
    maxX = pvL + 300;
    maxY = pvT + 300;
  }
  const pad = 40;
  const bw = maxX - minX + pad * 2;
  const bh = maxY - minY + pad * 2;
  const sc = Math.min(rw / bw, rh / bh);
  // 矩形内で中央寄せ。
  const offX = rx + (rw - bw * sc) / 2;
  const offY = ry + (rh - bh * sc) / 2;
  const bx = minX - pad;
  const by = minY - pad;
  return {
    sc,
    map: (wx, wy) => ({ x: offX + (wx - bx) * sc, y: offY + (wy - by) * sc }),
  };
}

// ミニマップのクリック/ドラッグで、その world 位置を editor 中央へパンする。
function setupMinimap() {
  const map = document.getElementById("minimap");
  if (!map) return;
  const panToMinimap = (clientX, clientY) => {
    const g = minimapGeom();
    if (!g) return;
    const r = map.getBoundingClientRect();
    const mx = clientX - r.left;
    const my = clientY - r.top;
    const w = minimapToWorld(g, mx, my);
    // world 点(w)が editor 中央に来るよう pan を設定。
    const ed = rootCtx.el.editor;
    const cx = ed.clientWidth / 2;
    const cy = ed.clientHeight / 2;
    rootCtx.panX = cx - w.x * rootCtx.zoom;
    rootCtx.panY = cy - w.y * rootCtx.zoom;
    applyTransform(rootCtx);
  };
  let dragging = false;
  map.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    map.setPointerCapture(e.pointerId);
    panToMinimap(e.clientX, e.clientY);
  });
  map.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    panToMinimap(e.clientX, e.clientY);
  });
  map.addEventListener("pointerup", (e) => {
    dragging = false;
    try {
      map.releasePointerCapture(e.pointerId);
    } catch {}
  });
}

// 画面最下部の下部ツールバー（HTML固定・ルート専用）を rootCtx の値で更新。
// 子/孫は各パネル内に自前のツールバー（buildEmbedToolbar）を持つ。
function syncBottomToolbar() {
  const p = profile(rootCtx);

  const countValue = document.getElementById("count-value");
  const countRange = document.getElementById("count-range");
  if (countValue) countValue.textContent = String(p.segments.length);
  if (countRange) countRange.value = String(p.segments.length);

  const op = Math.round((p.opacity ?? 1) * 100);
  const opRange = document.getElementById("opacity-range");
  const opValue = document.getElementById("opacity-value");
  if (opRange) opRange.value = String(op);
  if (opValue) opValue.textContent = `${op}%`;

  const outerBtn = document.getElementById("outer-active");
  if (outerBtn) outerBtn.classList.toggle("on", p.outer_active === true);

  const shakeBtn = document.getElementById("shake-dismiss");
  if (shakeBtn) shakeBtn.classList.toggle("on", p.shake_dismiss !== false);

  const instantBtn = document.getElementById("instant-action");
  if (instantBtn) instantBtn.classList.toggle("on", p.instant_action === true);

  const protectBtn = document.getElementById("protect-toggle");
  if (protectBtn) protectBtn.classList.toggle("on", p.protected === true);

  // 有効/無効。enabled 未定義(旧データ)は有効扱い。オフ時はラベルも「無効」に。
  const enableBtn = document.getElementById("enable-toggle");
  if (enableBtn) {
    const on = p.enabled !== false;
    enableBtn.classList.toggle("on", on);
    enableBtn.textContent = on ? "有効" : "無効";
  }
}

// 円形パイプレビュー（セグメント）を描く。各セグメントに接続ハンドルを付ける。
function renderPreview(ctx = currentCtx) {
  const host = ctx.el.preview;
  host.innerHTML = "";
  const p = profile(ctx);
  // プレビューにも不透明度を反映（ハンドル等は別なので svg だけに掛ける）。

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", PV_SIZE);
  svg.setAttribute("height", PV_SIZE);
  svg.setAttribute("viewBox", `0 0 ${PV_SIZE} ${PV_SIZE}`);

  // ラベル背景帯は文字実寸に合わせるが、getBBox は DOM 追加後でないと
  // 取れない。ここに溜めて、svg を host へ追加した後でまとめてサイズ決め。
  const pendingLabelBgs = [];
  // ラベルのレイヤ（背景帯・文字）。ハンドル類より後＝最前面に追加する。
  let labelLayers = null;

  // 不透明度はパイ本体（扇形＋ラベル）だけに掛ける。接続◯やハンドル類は
  // 半透明設定でも常に不透明にしたいので、このグループの外に置く。
  const pieGroup = document.createElementNS(SVG_NS, "g");
  pieGroup.style.opacity = String(p.opacity ?? 1);
  svg.appendChild(pieGroup);

  const n = p.segments.length;
  if (n > 0) {
    const slice = 360 / n;
    // 最初のセグメント中心を真上に（4=上右下左, 8=8方位）＋プロファイル回転。
    const off = -slice / 2 + (p.rotation || 0);

    // セグメント本体（扇形）を先に全部描く。
    p.segments.forEach((seg, i) => {
      const start = i * slice + PV_GAP / 2 + off;
      const end = (i + 1) * slice - PV_GAP / 2 + off;
      const mid = (start + end) / 2;

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", pvSector(start, end, ctx));
      path.setAttribute("fill", seg.color || "#888");
      path.dataset.index = String(i);
      path.dataset.mid = String(mid);
      path.setAttribute("class", "pv-seg");
      // カーソルを合わせたときの操作ヒント（即表示の data-tip ツールチップ）。
      path.dataset.tip = "外に向けてドラッグすることでアクションを設定";
      // pointerdown→動かさず離せば色変更、ドラッグして別セグメントに
      // ドロップすれば位置交換（接続ノードも head ごと一緒に移動）。
      path.addEventListener("pointerdown", (e) => startSegDrag(e, i, {}, ctx));
      pieGroup.appendChild(path);
    });

    // ラベルは全セグメントの上＋pieGroup の外（不透明度の影響を受けない）に
    // まとめて描く。背景帯（薄い黒）を全部下、文字を全部その上に置くことで
    // 「文字が常に最前面」になり、隣の背景帯に文字が隠れない。
    const bgLayer = document.createElementNS(SVG_NS, "g");
    const textLayer = document.createElementNS(SVG_NS, "g");
    p.segments.forEach((seg, i) => {
      const start = i * slice + PV_GAP / 2 + off;
      const end = (i + 1) * slice - PV_GAP / 2 + off;
      const mid = (start + end) / 2;
      const pos = pvPolarLocal(pvLabelR(ctx), mid);
      const shown = segDisplayName(seg, ctx);
      const isAuto = !(seg.label || "").trim();

      // ラベル（帯・文字）の上もセグメント本体と同じ操作ヒントを出す。
      const segTip = "外に向けてドラッグすることでアクションを設定";

      const bg = document.createElementNS(SVG_NS, "rect");
      bg.setAttribute("class", "pv-label-bg");
      bg.setAttribute("rx", "4");
      bg.setAttribute("ry", "4");
      bg.dataset.tip = segTip;
      bgLayer.appendChild(bg);

      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", pos.x);
      text.setAttribute("y", pos.y);
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "central");
      text.setAttribute("class", "pv-label" + (isAuto ? " auto" : ""));
      setSvgMultilineText(text, shown, pos.x);
      text.dataset.tip = segTip;
      text.dataset.index = String(i);
      textLayer.appendChild(text);

      // ラベル（背景帯＋文字どちらも）からセグメントドラッグ／編集できる。
      const onDown = (e) =>
        startSegDrag(e, i, { fromLabel: true, lx: pos.x, ly: pos.y }, ctx);
      bg.addEventListener("pointerdown", onDown);
      text.addEventListener("pointerdown", onDown);

      // 背景帯のサイズは文字実寸に合わせる。getBBox は DOM 追加後でないと
      // 取れないので、描画後にまとめてサイズ決めする。
      pendingLabelBgs.push({ bg, text });
    });
    // ハンドル類より後（最前面）に置きたいので、関数末尾でまとめて append。
    labelLayers = { bgLayer, textLayer };

    // 見える◯・専用ハンドルは廃止。配線はセグメント本体のドラッグで行う
    // （ラジアルメニュー本体から線が出ているように見せる）。
  }

  // 中央ハブ（内径＝右クリックデフォルト領域）。縁をドラッグで内径変更。
  const hub = document.createElementNS(SVG_NS, "circle");
  hub.setAttribute("cx", PV_R);
  hub.setAttribute("cy", PV_R);
  hub.setAttribute("r", pvInner(ctx));
  hub.setAttribute("class", "pv-hub pv-inner-handle");
  hub.addEventListener("pointerdown", (e) => startRadiusDrag(e, "inner", ctx));
  svg.appendChild(hub);

  // 中心の移動ハンドル（角丸四角のドラッグアイコン）。ここを掴むと
  // ラジアルメニュー全体をキャンバス上で移動できる。内径より小さく置く。
  const mvSize = Math.max(16, Math.min(pvInner(ctx) * 1.1, 28));
  const mv = document.createElementNS(SVG_NS, "rect");
  mv.setAttribute("x", PV_R - mvSize / 2);
  mv.setAttribute("y", PV_R - mvSize / 2);
  mv.setAttribute("width", mvSize);
  mv.setAttribute("height", mvSize);
  mv.setAttribute("rx", mvSize * 0.32);
  mv.setAttribute("class", "pv-move-handle");
  mv.addEventListener("pointerdown", (e) => startPreviewMove(e, ctx));
  svg.appendChild(mv);
  // 移動を示す十字グリップ風の点線（装飾）。
  const grip = document.createElementNS(SVG_NS, "text");
  grip.setAttribute("x", PV_R);
  grip.setAttribute("y", PV_R);
  grip.setAttribute("text-anchor", "middle");
  grip.setAttribute("dominant-baseline", "central");
  grip.setAttribute("class", "pv-move-grip");
  grip.textContent = "✠";
  grip.style.pointerEvents = "none";
  svg.appendChild(grip);

  // 外周リサイズリング（外周の少し外にドラッグ用の透明リング）。
  const outerRing = document.createElementNS(SVG_NS, "circle");
  outerRing.setAttribute("cx", PV_R);
  outerRing.setAttribute("cy", PV_R);
  outerRing.setAttribute("r", pvOuter(ctx));
  outerRing.setAttribute("class", "pv-outer-handle");
  outerRing.addEventListener("pointerdown", (e) =>
    startRadiusDrag(e, "outer", ctx),
  );
  svg.appendChild(outerRing);

  // 回転ハンドルは drawConnectors 側（connectors レイヤ z3）に描く。
  // 配線の当たり判定(connector-hit, z3)より後ろに append され前面に来るので、
  // 配線がハンドルに重なってもドラッグを奪われない。

  // ラベルは全要素の最前面（ハンドル類より後）に。背景帯→文字の順。
  if (labelLayers) {
    svg.appendChild(labelLayers.bgLayer);
    svg.appendChild(labelLayers.textLayer);
  }

  host.style.left = `${ctx.pvLeft}px`;
  host.style.top = `${ctx.pvTop}px`;
  host.appendChild(svg);

  // パイ中心の移動ハンドル(✠)の上に「表示」トグル（本番でパイを出すか）。
  const pieVisOn = p.pie_visible !== false; // 既定 ON
  const pieToggle = document.createElement("button");
  pieToggle.type = "button";
  pieToggle.className = "pie-vis-toggle" + (pieVisOn ? " on" : "");
  pieToggle.textContent = "表示";
  pieToggle.dataset.tip = "メニュー表示時にパイ本体を表示するかどうか";
  pieToggle.dataset.tipAnchor = "element";
  // 中心ハンドルの少し上に配置（プレビュー座標→host内 px）。
  pieToggle.style.left = `${PV_R}px`;
  pieToggle.style.top = `${PV_R - mvSize / 2 - 14}px`;
  pieToggle.addEventListener("pointerdown", (e) => e.stopPropagation());
  pieToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    p.pie_visible = !pieVisOn;
    markDirty();
    render(ctx);
  });
  host.appendChild(pieToggle);

  // DOM 追加後に文字実寸を測り、薄い黒の背景帯を文字サイズに合わせる。
  // getBBox は要素がレイアウト済みでないと 0 を返すことがある（内包エディタの
  // 初回描画など）。その場合は背景帯が潰れるので、次フレームで測り直す。
  const padX = 5;
  const padY = 2;
  const sizeLabelBgs = () => {
    let ok = true;
    for (const { bg, text } of pendingLabelBgs) {
      const bb = text.getBBox();
      if (bb.width === 0 && (text.textContent || "").length > 0) ok = false;
      bg.setAttribute("x", String(bb.x - padX));
      bg.setAttribute("y", String(bb.y - padY));
      bg.setAttribute("width", String(bb.width + padX * 2));
      bg.setAttribute("height", String(bb.height + padY * 2));
    }
    return ok;
  };
  if (!sizeLabelBgs() && pendingLabelBgs.length) {
    // 測れなかった（レイアウト未確定）→ 次フレームでもう一度合わせる。
    requestAnimationFrame(sizeLabelBgs);
  }
}

// 特殊キー: 修飾キー・クリックのトークンと表示名。
const SPECIAL_MODS = [
  ["Shift", "⇧ Shift"],
  ["Ctrl", "✳ Control"],
  ["Alt", "⌥ Alt"],
  ["Space", "␣ スペース"],
];
const SPECIAL_CLICKS = [
  ["left", "左"],
  ["middle", "中ボタン"],
  ["right", "右"],
  ["wheel", "マウスホイール"],
];
const SPECIAL_MOD_LABELS = Object.fromEntries(
  SPECIAL_MODS.map(([v, t]) => [v, t.replace(/^[^ ]+ /, "")]),
);
const SPECIAL_CLICK_LABELS = Object.fromEntries(SPECIAL_CLICKS);

// 特殊キー編集ポップオーバー（ワコム風・チェックボックス＋押す/離すトグル）。
let specialPopEl = null;
function closeSpecialEditor() {
  if (specialPopEl) {
    specialPopEl.remove();
    specialPopEl = null;
  }
  window.removeEventListener("pointerdown", onSpecialOutside, true);
}
function onSpecialOutside(e) {
  if (specialPopEl && !specialPopEl.contains(e.target)) closeSpecialEditor();
}
function openSpecialEditor(node, btn, onChange, ctx = currentCtx) {
  closeSpecialEditor();
  if (!Array.isArray(node.mods)) node.mods = [];
  if (!Array.isArray(node.clicks)) node.clicks = [];

  const pop = document.createElement("div");
  pop.className = "special-pop";
  pop.innerHTML = `<div class="special-title">特殊キー</div>
    <div class="special-desc">押す修飾キー／クリックを選びます。<br>
    修飾キーについては「離す」アクションまで押しっぱなしになります。</div>`;

  const cols = document.createElement("div");
  cols.className = "special-cols";
  const makeCol = (heading, list, arrName) => {
    const col = document.createElement("div");
    col.className = "special-col";
    const h = document.createElement("div");
    h.className = "special-col-h";
    h.textContent = heading;
    col.appendChild(h);
    list.forEach(([val, txt]) => {
      const lab = document.createElement("label");
      lab.className = "special-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = node[arrName].includes(val);
      cb.addEventListener("change", () => {
        const arr = node[arrName];
        const i = arr.indexOf(val);
        if (cb.checked && i < 0) arr.push(val);
        else if (!cb.checked && i >= 0) arr.splice(i, 1);
        markDirty();
        onChange();
      });
      lab.append(cb, document.createTextNode(" " + txt));
      col.appendChild(lab);
    });
    return col;
  };
  cols.append(
    makeCol("キー", SPECIAL_MODS, "mods"),
    makeCol("クリック", SPECIAL_CLICKS, "clicks"),
  );
  pop.appendChild(cols);

  // 押す/離すトグル（セグメント型スイッチ＝どちらか一方が点灯する見た目）。
  const modeWrap = document.createElement("div");
  modeWrap.className = "special-mode";
  const modeLabel = document.createElement("span");
  modeLabel.className = "special-mode-label";
  modeLabel.textContent = "動作";
  const seg = document.createElement("div");
  seg.className = "special-seg";
  const syncSeg = () => seg.classList.toggle("is-release", !!node.release);
  const mkMode = (rel, txt) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = txt;
    b.className = "special-seg-btn" + (rel ? " seg-release" : " seg-press");
    b.addEventListener("click", () => {
      node.release = rel;
      markDirty();
      onChange();
      syncSeg();
    });
    return b;
  };
  seg.append(mkMode(false, "押す（保持）"), mkMode(true, "離す"));
  syncSeg();
  modeWrap.append(modeLabel, seg);
  pop.appendChild(modeWrap);

  // 位置: ボタンの下に絶対配置（body 直下、画面座標）。
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  pop.style.left = `${Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)}px`;
  pop.style.top = `${r.bottom + 4}px`;
  specialPopEl = pop;
  setTimeout(() => {
    window.addEventListener("pointerdown", onSpecialOutside, true);
  }, 0);
}

// ノードの値要素を種別に応じて作る。
//   key      → キーキャプチャボタン（クリックして押したキーを取得・手打ち無し）
//   special  → 特殊キー（修飾キー＋クリック、押す/離す）
//   launch   → テキスト入力（パス/URL）
//   settings → 値なし（表示のみ）
function buildValueEl(node, ctx = currentCtx) {
  const kind = node.type || "key";

  if (kind === "launch") {
    // 起動: すでに起動中の前面アプリをクリックで取得（アプリ指定と同じ方式）。
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "f-key f-capture";
    btn.textContent = node.value || "起動アプリ指定";
    if (!node.value) btn.classList.add("empty");
    btn.addEventListener("click", () => {
      if (ctx.nodeDragMoved) return; // ドラッグ移動直後はクリック扱いにしない
      captureLaunchTarget(node, btn, ctx);
    });
    return btn;
  }

  if (kind === "settings") {
    const span = document.createElement("span");
    span.className = "f-key f-static";
    span.textContent = "設定を開く";
    return span;
  }

  if (kind === "special") {
    // 特殊キー: 修飾キー(複数)＋クリック(複数)＋押す/離すモード。
    // ボタンに要約を表示、クリックでワコム風ポップオーバーを開く。
    if (!Array.isArray(node.mods)) node.mods = [];
    if (!Array.isArray(node.clicks)) node.clicks = [];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "f-key f-capture";
    const summarize = () => {
      const parts = [];
      node.mods.forEach((m) => parts.push(SPECIAL_MOD_LABELS[m] || m));
      node.clicks.forEach((c) => parts.push(SPECIAL_CLICK_LABELS[c] || c));
      const body = parts.join("+") || "特殊キー設定";
      btn.textContent = node.release ? `${body}（離す）` : body;
      btn.classList.toggle("empty", parts.length === 0);
    };
    summarize();
    btn.addEventListener("click", () => {
      if (ctx.nodeDragMoved) return;
      openSpecialEditor(node, btn, summarize, ctx);
    });
    return btn;
  }

  if (kind === "menu") {
    // メニュー: このノード自身がインラインのサブメニュー（新規・独立）を持つ。
    // 「メニュー▼」の横のテキストは、このノードを指すセグメントのラベルと連動し、
    // ここで編集するとそのセグメント名が変わる（セグメント側の編集とも同期）。
    const sub = node.submenu;
    const segCount =
      sub && Array.isArray(sub.segments) ? sub.segments.length : 0;
    const fallback = segCount > 0 ? `サブメニュー(${segCount})` : "サブメニュー";

    // メニューがスタックの途中/末尾でも連動できるよう、スタック先頭で引く
    // （例: 特殊キー(Ctrl離す)→メニュー のとき、セグメントの head は特殊キー）。
    const segIdx = segIndexForHead(stackHeadOf(node.id, ctx), ctx);
    const seg = segIdx >= 0 ? profile(ctx).segments[segIdx] : null;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "f-key f-menu-name";
    // セグメント未接続なら編集不可（連動先が無い）。接続済みなら手動ラベルを表示。
    if (seg) {
      input.value = seg.label || "";
      input.placeholder = fallback; // 未設定時は自動名をプレースホルダ表示
      input.title = "サブメニュー名（接続セグメントと連動）";
    } else {
      input.value = "";
      input.placeholder = fallback;
      input.disabled = true;
      input.title = "セグメントに接続するとサブメニュー名を編集できます";
    }
    // クリック＝テキスト編集、ドラッグ＝ブロック移動（カーソルは変えない）。
    // armSelectDrag が「5px 動いたらノードドラッグへ切替・動かなければ素の編集」
    // を両立してくれる（種別ドロップダウンと同じ仕組み）。
    input.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return; // 左のみ
      armSelectDrag(e, node.id, input, ctx);
    });
    if (seg) {
      const commit = () => {
        seg.label = input.value.trim(); // 空＝自動名（未設定）へ戻す
        markDirty();
        renderPreview(ctx); // プレビューのセグメント名も更新
        scheduleConnectors(ctx);
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          input.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          input.value = seg.label || "";
          input.blur();
        }
      });
      input.addEventListener("blur", commit);
    }
    return input;
  }

  // key: キャプチャボタン。
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "f-key f-capture";
  btn.textContent = node.value ? prettyCombo(node.value) : "キー設定";
  if (!node.value) btn.classList.add("empty");
  btn.addEventListener("click", () => {
    if (ctx.nodeDragMoved) return; // ドラッグ移動直後はクリック扱いにしない
    startKeyCapture(btn, node, ctx);
  });
  return btn;
}

// 起動アクションの対象を「今前面にある起動中アプリ」から取得する。
// アプリ指定（captureAppForNode）と同じく 2 秒カウント後に前面アプリ名を取る。
let launchPicking = false;
async function captureLaunchTarget(node, btn, ctx = currentCtx) {
  if (launchPicking) return;
  launchPicking = true;
  btn.disabled = true;
  for (let s = 2; s >= 1; s--) {
    btn.textContent = `${s}秒以内に対象アプリをクリック…`;
    await new Promise((r) => setTimeout(r, 1000));
  }
  try {
    const name = await invoke("foreground_app");
    if (!name) {
      statusEl.textContent = "取得できませんでした（自分の窓のまま？）";
    } else {
      node.value = name;
      markDirty();
    }
  } catch (e) {
    console.error("[settings] foreground_app failed:", e);
    statusEl.textContent = "取得失敗: " + e;
  } finally {
    btn.disabled = false;
    launchPicking = false;
    render(ctx);
    setTimeout(() => (statusEl.textContent = ""), 3000);
  }
}

// ノードのキーキャプチャ。ボタンを押すと次に押したキー組合せを node.value に。
let keyCapture = null;
function startKeyCapture(btn, node, ctx = currentCtx) {
  // 進行中のキャプチャがあれば終了。
  stopKeyCapture();
  keyCapture = { btn, node, ctx };
  btn.classList.add("capturing");
  btn.textContent = "キーを押してください…";
  window.addEventListener("keydown", onKeyCaptureKeydown, true);
  // 別の場所をクリックしたらキャンセル。
  setTimeout(() => {
    window.addEventListener("pointerdown", onKeyCaptureOutside, true);
  }, 0);
}
function onKeyCaptureKeydown(e) {
  if (!keyCapture) return;
  e.preventDefault();
  e.stopPropagation();
  // Escape も登録対象にする（取り消しはマウスクリックで行う）。
  if (["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
       "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(e.code)) {
    return; // 修飾単独は待つ
  }
  const main = normalizeCode(e.code);
  if (!main) return;
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Win");
  parts.push(main);
  finishKeyCapture(parts.join("+"));
}
function onKeyCaptureOutside(e) {
  if (keyCapture && e.target !== keyCapture.btn) finishKeyCapture(null);
}
// 保存値（"Ctrl+equal" 等）を表示用に整える。記号キー名を記号に置換。
// 保存値そのものは変えない（Rust の解釈名のまま）＝表示専用。
function prettyCombo(combo) {
  const sym = {
    plus: "+",
    equal: "=",
    minus: "-",
    multiply: "*",
    divide: "/",
    decimal: ".",
    comma: ",",
    slash: "/",
    backslash: "\\",
    semicolon: ";",
    quote: "'",
    backquote: "`",
    bracketleft: "[",
    bracketright: "]",
    period: ".",
  };
  return combo
    .split("+")
    .map((t) => sym[t] ?? t)
    .join("+");
}

function finishKeyCapture(combo) {
  if (!keyCapture) return;
  const { btn, node, ctx } = keyCapture;
  if (combo) {
    node.value = combo;
    markDirty();
    // 値が変わるとセグメントの自動ラベル（autoSegName）も変わるので、
    // この面のプレビュー（パイ＋ラベル）を描き直す。
    renderPreview(ctx || currentCtx);
  }
  btn.classList.remove("capturing");
  btn.textContent = node.value ? prettyCombo(node.value) : "キー設定";
  btn.classList.toggle("empty", !node.value);
  stopKeyCapture();
}
function stopKeyCapture() {
  window.removeEventListener("keydown", onKeyCaptureKeydown, true);
  window.removeEventListener("pointerdown", onKeyCaptureOutside, true);
  keyCapture = null;
}

// ── ブロックの重なり順（最後に触ったものを最前面に） ────────────────
// 初期はDOM順（並列）。ユーザーが操作(pointerdown)したブロックを最前面へ。
// z は「触った順のカウンタ」。node.id ごとに覚え、再描画(renderNodes)でも
// 維持する。config には保存しない（見た目だけの一時状態）。
let blockTopZ = 0;
const blockZOrder = new Map(); // key: node.id（やキー文字列） → z 値
// その面のブロックに重なり順の z を適用する（覚えていれば）。
function applyBlockZ(el, key) {
  const z = blockZOrder.get(key);
  if (z != null) el.style.zIndex = String(z);
}
// 操作したブロックを最前面に持ち上げる。
function bringBlockToFront(el, key) {
  blockTopZ += 1;
  blockZOrder.set(key, blockTopZ);
  el.style.zIndex = String(blockTopZ);
}

// アクションノードをキャンバスに自由配置で描く。
function renderNodes(ctx = currentCtx) {
  const host = ctx.el.nodes;
  host.innerHTML = "";
  const p = profile(ctx);

  p.nodes.forEach((node) => {
    const el = document.createElement("div");
    el.className = "anode";
    el.dataset.id = node.id;
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    // 触った順の重なり（再描画でも維持）。
    applyBlockZ(el, node.id);

    // 合体スタック内の位置で角丸を変える（先頭=上だけ丸、末尾=下だけ丸、
    // 中間=角なし、単独=全部丸）。
    const hasParent = !!parentOf(node.id, ctx);
    const hasNext = !!node.next;
    if (hasParent && hasNext) el.classList.add("stack-mid");
    else if (hasParent) el.classList.add("stack-bottom");
    else if (hasNext) el.classList.add("stack-top");
    else el.classList.add("stack-single");

    // 触ったら最前面へ（左でも右でも、このブロックに触れた時点で持ち上げる）。
    // capture で早めに拾い、操作の種類に関わらず重なり順だけ更新する。
    el.addEventListener(
      "pointerdown",
      () => bringBlockToFront(el, node.id),
      true,
    );

    // ノード全体をドラッグ可能に（入力・select・ボタン以外を掴んだら移動）。
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return; // 左のみ。右はキャンバスへ（ナイフ/右クリメニュー）
      if (e.target.closest("input, select, button")) return;
      startNodeDrag(e, node.id, ctx);
    });

    // 配線済みなら接続元セグメント色を「スタック全体の外周アウトライン」に。
    // 色は CSS 変数で渡し、辺の出し分け（中間ノードは上下の枠を消す）は
    // stack-top/mid/bottom クラスに応じて CSS 側で行う。
    const segColor = connectedSegColor(node.id, ctx);
    if (segColor) {
      el.style.setProperty("--link-color", segColor);
      el.classList.add("linked");
    }

    const typeSel = document.createElement("select");
    typeSel.className = "f-type";
    for (const [val, txt] of [
      ["key", "キー"],
      ["special", "特殊キー"],
      ["launch", "起動"],
      ["settings", "設定"],
      ["menu", "メニュー"],
    ]) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = txt;
      if ((node.type || "key") === val) opt.selected = true;
      typeSel.appendChild(opt);
    }

    // 値要素は種別で変わる: key=キーキャプチャボタン / launch=テキスト入力 /
    // settings=値なし表示。種別変更時に r2 の中身を作り直す。
    const r2 = document.createElement("div");
    r2.className = "anode-r2";

    const rebuildValue = () => {
      r2.innerHTML = "";
      r2.append(buildValueEl(node, ctx));
    };

    typeSel.addEventListener("change", () => {
      const prev = node.type || "key";
      node.type = typeSel.value;
      // 種別を跨ぐと value の意味が変わるのでクリア（settings/menu 切替含む）。
      if (typeSel.value === "settings") node.value = "";
      if (typeSel.value === "menu" || prev === "menu") node.value = "";
      // メニュー（サブメニュー）ブロックも上下に連結できる:
      // 上＝サブメニューを開く前に実行、下＝サブメニュー内で発動後の「続き」。
      // 種別変更での強制切り離しはしない。
      markDirty();
      // メニューへ/から切り替わると edit ボタンの有無が変わる（edit は値要素
      // ではなくノード行に出る別要素）。値だけでなくノード全体を描き直す。
      if (typeSel.value === "menu" || prev === "menu") {
        render(ctx);
      } else {
        rebuildValue();
        // 種別変更で value の意味（＝セグメントの自動ラベル）が変わるので、
        // この面のプレビュー（パイ＋ラベル）も描き直す。
        renderPreview(ctx);
      }
    });

    // 1行レイアウト（アイコン廃止）: 種別 → 値。
    // 削除/複製ボタンは廃止（Del キー・コピペで代替）。
    // 値の部分をドラッグで掴んで移動（クリックは値操作。nodeDragMoved で両立）。
    rebuildValue();
    r2.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return; // 左のみ
      // メニュー名の入力欄は自前で armSelectDrag（クリック編集/ドラッグ移動）を
      // 持つので、ここでは即ドラッグを始めない（始めると編集できなくなる）。
      if (e.target.closest(".f-menu-name")) return;
      startNodeDrag(e, node.id, ctx);
    });
    // 種別ドロップダウンも掴んでドラッグ移動できる。preventDefault せずに
    // 様子を見て、一定px動いたら初めてノードドラッグへ切り替える。動かさなければ
    // 何もしない＝素のドロップダウンが普通に開閉する（従来どおりの選択操作）。
    typeSel.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return; // 左のみ
      armSelectDrag(e, node.id, typeSel, ctx);
    });
    el.append(typeSel, r2);

    // メニュー型は「常に」大きな内包ボックスで表示する（新規・独立の
    // サブメニューは必ず編集が要るので、edit ボタンでの開閉はしない）。
    const isMenu = (node.type || "key") === "menu";
    if (isMenu) {
      {
        el.classList.add("expanded");

        // メニューブロック（この .anode 全体）を掴んでサイズ変更できる。
        // サイズは「ノード自身」に保持する（node.embedW/embedH）。これなら
        // 子/孫 ctx が再生成されてもサイズが飛ばず、保存にも乗る（孫でもリセット
        // されない）。
        el.style.width = `${node.embedW || EMBED_DEFAULT_W}px`;
        el.style.height = `${node.embedH || EMBED_DEFAULT_H}px`;

        // 展開時はブロックを縦並び（上段＝操作行 / 下段＝内包ボックス）にする。
        // 既に el へ追加済みの上段要素（種別/値/edit）を .anode-top にまとめる。
        const top = document.createElement("div");
        top.className = "anode-top";
        while (el.firstChild) top.appendChild(el.firstChild);
        el.appendChild(top);

        // 内包ボックス。中にこのノードのサブメニュー（新規・独立）の実エディタ
        // （パイ・ノード・配線）を子 ctx で描く。
        const embed = document.createElement("div");
        embed.className = "menu-embed";

        // 子エディタ用の DOM（settings.html の #editor>#world>(svg,preview,nodes)
        // と同じ構成）。ID は使わず、子 ctx.el に直接渡す。
        const cEditor = document.createElement("div");
        cEditor.className = "embed-editor";
        const cWorld = document.createElement("div");
        cWorld.className = "world embed-world";
        const cConnectors = document.createElementNS(SVG_NS, "svg");
        cConnectors.setAttribute("class", "connectors");
        const cPreview = document.createElement("div");
        cPreview.className = "preview";
        const cNodes = document.createElement("div");
        cNodes.className = "nodes";
        cWorld.append(cConnectors, cPreview, cNodes);
        cEditor.appendChild(cWorld);
        embed.appendChild(cEditor);

        // 内包ボックスの pointerdown は親キャンバスへ伝播させない
        // （親のナイフ/矩形選択を誤発動させない）。
        embed.addEventListener("pointerdown", (e) => e.stopPropagation());

        el.appendChild(embed);

        // メニューブロック全体のリサイズハンドル（下/左/右/左下角/右下角）。
        addEmbedResizeHandles(el, ctx, node.id);

        // 深すぎる入れ子だけ抑止（サブメニューは独立データなので循環は無い）。
        const tooDeep = (ctx.depth || 0) + 1 > EMBED_MAX_DEPTH;
        if (tooDeep) {
          const warn = document.createElement("div");
          warn.className = "menu-embed-label";
          warn.textContent = "これ以上は深く内包できません";
          cEditor.appendChild(warn);
        } else {
          // 子 ctx を取得（または生成）し、DOM 参照を今作った要素に向ける。
          const child = childCtxFor(ctx, node, {
            editor: cEditor,
            world: cWorld,
            preview: cPreview,
            nodes: cNodes,
            connectors: cConnectors,
          });
          // 子エディタのパン/ズーム/各操作を有効化（毎回 DOM を作り直すので
          // リスナも貼り直す）。
          setupCanvasPanZoom(child);
          applyTransform(child);
          // 子の中身を描く。currentCtx を一時的に子へ切り替え（render 内の
          // 既定 ctx 解決のため）、終わったら元へ戻す。
          const prev = currentCtx;
          currentCtx = child;
          render(child);
          currentCtx = prev;
          // この子/孫パネル自身の下部ツールバー（親パネルと同じ画面サイズ）。
          cEditor.appendChild(buildEmbedToolbar(child));
          // 右上の Blender 風ナビ（ズーム+ / パン / ズーム-）。中ドラッグは
          // 常に親パンになったので、子内部のパン/ズームはここで行う。
          cEditor.appendChild(buildEmbedNav(child));
        }
      }
    }

    // スタック先頭ノードには左端に接続ポート（◯）を出す。ここから
    // ドラッグしてセグメントに繋ぐ／引き剥がして繋ぎ替えできる。
    if (!hasParent) {
      const port = document.createElement("span");
      port.className = "anode-port";
      // 接続済みは接続元セグメント色、未接続もリング付きの塗り○で見た目統一。
      if (segColor) {
        port.style.background = segColor;
      } else {
        port.classList.add("unlinked");
      }
      port.addEventListener("pointerdown", (e) =>
        startNodeLinkDrag(e, node.id, ctx),
      );
      // ◯を右クリックで配線削除。
      port.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const si = segIndexForHead(node.id, ctx);
        if (si >= 0) unlinkSegment(si, ctx);
      });
      el.appendChild(port);
    }

    host.appendChild(el);
  });
}


// ── 子/孫パネルの左下ツールバー ──────────────────────────────────
// 親（ルート）の下部ツールバーと同じ項目を、その面(ctx)用に作る。大きさは
// 「親パネルと同じ画面サイズ」になるよう、累積ズームの逆数で打ち消す
// （rescaleEmbedToolbars がズーム時に再計算する）。大事＝保護は出さない。
function buildEmbedToolbar(ctx) {
  const p = profile(ctx);
  const bar = document.createElement("div");
  bar.className = "embed-toolbar";
  bar.addEventListener("pointerdown", (e) => e.stopPropagation());

  // 項目数スライダー。
  const countWrap = document.createElement("div");
  countWrap.className = "slider-wrap";
  const countRange = document.createElement("input");
  countRange.type = "range";
  countRange.min = "1";
  countRange.max = "8";
  countRange.step = "1";
  countRange.value = String(p.segments.length);
  const countText = document.createElement("span");
  countText.className = "slider-text";
  countText.innerHTML =
    `<span class="slider-label">項目数</span>` +
    `<span class="slider-value">${p.segments.length}</span>`;
  countRange.addEventListener("input", () => {
    countText.querySelector(".slider-value").textContent = countRange.value;
    setSegmentCount(Number(countRange.value), ctx);
  });
  countWrap.append(countRange, countText);

  // 不透明度スライダー。
  const op = Math.round((p.opacity ?? 1) * 100);
  const opWrap = document.createElement("div");
  opWrap.className = "slider-wrap";
  const opRange = document.createElement("input");
  opRange.type = "range";
  opRange.min = "0";
  opRange.max = "100";
  opRange.step = "1";
  opRange.value = String(op);
  const opText = document.createElement("span");
  opText.className = "slider-text";
  opText.innerHTML =
    `<span class="slider-label">不透明度</span>` +
    `<span class="slider-value">${op}%</span>`;
  opRange.addEventListener("input", () => {
    const v = Number(opRange.value);
    opText.querySelector(".slider-value").textContent = `${v}%`;
    p.opacity = v / 100;
    markDirty();
    renderPreview(ctx);
    scheduleConnectors(ctx);
  });
  opWrap.append(opRange, opText);

  // トグル（外側有効 / シェイク離脱 / 即時アクション）。
  const mkToggle = (label, isOn, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toggle-btn" + (isOn ? " on" : "");
    b.textContent = label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  };
  const outerBtn = mkToggle("外側有効", p.outer_active === true, () => {
    p.outer_active = !p.outer_active;
    markDirty();
    outerBtn.classList.toggle("on", p.outer_active === true);
  });
  const shakeBtn = mkToggle("シェイク離脱", p.shake_dismiss !== false, () => {
    p.shake_dismiss = !(p.shake_dismiss !== false);
    markDirty();
    shakeBtn.classList.toggle("on", p.shake_dismiss !== false);
  });
  const instantBtn = mkToggle(
    "即時アクション",
    p.instant_action === true,
    () => {
      p.instant_action = !p.instant_action;
      markDirty();
      instantBtn.classList.toggle("on", p.instant_action === true);
    },
  );

  bar.append(countWrap, opWrap, outerBtn, shakeBtn, instantBtn);
  // ctx と DOM を紐付け、ズーム時に逆スケールを再計算できるようにする。
  bar._scaleCtx = ctx;
  requestAnimationFrame(() => rescaleEmbedToolbars());
  return bar;
}

// 【仕様】下部UI（埋め込みツールバー・ナビ）は、親パネルのズーム/パンの影響を
// そのまま受ける（等倍固定をやめた＝逆スケール打ち消しをしない）。ツールバーは
// cEditor 配下にあり祖先 transform をそのまま継承するので、ここでは何もしない。
// （関数は呼び出し箇所が多いので残し、念のため逆スケール指定があれば解除する。）
function rescaleEmbedToolbars() {
  document.querySelectorAll(".embed-toolbar, .embed-nav").forEach((bar) => {
    if (bar.style.zoom) bar.style.zoom = "";
  });
}

// 子/孫パネル右上の Blender 風ナビ（ズーム+ / パン / ズーム-）。
// 中ドラッグは常に親パンになったため、子内部のパン/ズームはここで操作する。
function buildEmbedNav(ctx) {
  const nav = document.createElement("div");
  nav.className = "embed-nav";
  nav._scaleCtx = ctx; // rescaleEmbedToolbars で親と同じ画面サイズに保つ
  nav.addEventListener("pointerdown", (e) => e.stopPropagation());

  const mkBtn = (label, tip, cls) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "embed-nav-btn" + (cls ? " " + cls : "");
    b.textContent = label;
    b.dataset.tip = tip;
    b.dataset.tipAnchor = "element";
    nav.appendChild(b);
    return b;
  };

  // ズーム（上ドラッグでイン・下ドラッグでアウト。Blender 準拠）。
  const zoom = mkBtn("🔍", "上下ドラッグでズーム", "embed-nav-zoom");
  zoom.addEventListener("pointerdown", (e) => startEmbedZoom(e, ctx));
  // パン（このアイコンをドラッグでこの面の内部をパン）。
  const pan = mkBtn("✋", "ドラッグでこのパネル内をパン", "embed-nav-pan");
  pan.addEventListener("pointerdown", (e) => startEmbedPan(e, ctx));

  // 下部UI（ナビ）は親パネルのズーム/パンの影響をそのまま受ける（逆スケール無し）。
  return nav;
}

// パネル中央を基点に1段ズーム。
// パネル中央を基点に、ズーム倍率を target にする（クランプ付き）。
function setEmbedZoom(ctx, target) {
  const editor = ctx.el.editor;
  if (!editor) return;
  const newZoom = Math.min(8, Math.max(0.2, target));
  if (Math.abs(newZoom - ctx.zoom) < 1e-4) return;
  const eb = editor.getBoundingClientRect();
  const mx = eb.width / 2;
  const my = eb.height / 2;
  const wx = (mx - ctx.panX) / ctx.zoom;
  const wy = (my - ctx.panY) / ctx.zoom;
  ctx.panX = mx - wx * newZoom;
  ctx.panY = my - wy * newZoom;
  ctx.zoom = newZoom;
  applyTransform(ctx);
  showZoomIndicator(ctx);
}

// ズームアイコンの上下ドラッグでズーム（上=イン / 下=アウト。Blender 準拠）。
function startEmbedZoom(e, ctx) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const startY = e.clientY;
  const baseZoom = ctx.zoom;
  // 縦ドラッグ量→倍率。上(マイナス方向)でズームイン。140px で約2倍。
  const move = (ev) => {
    const dy = startY - ev.clientY; // 上ドラッグで正
    const factor = Math.pow(2, dy / 140);
    setEmbedZoom(ctx, baseZoom * factor);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// パンアイコンのドラッグで、その面(ctx)の内部をパンする。
function startEmbedPan(e, ctx) {
  if (e.button !== 0) return; // 左ドラッグ
  e.preventDefault();
  e.stopPropagation();
  ctx.pan = { sx: e.clientX, sy: e.clientY, ox: ctx.panX, oy: ctx.panY };
  const move = (ev) => onPanMove(ev, ctx);
  const up = () => {
    onPanUp(ctx);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ── 内包ボックスのリサイズハンドル（下/左/右/左下角/右下角） ────────
function addEmbedResizeHandles(blockEl, ctx, nodeId) {
  // メニューブロック（.anode.expanded）全体のサイズを変える。
  const MIN_W = 300;
  const MIN_H = 220;
  const MAX_W = 4000;
  const MAX_H = 3000;
  const edges = [
    ["s", "bottom"], // 下辺
    ["n", "top"], // 上辺
    ["w", "left"], // 左辺
    ["e", "right"], // 右辺
    ["sw", "corner-sw"], // 左下角
    ["se", "corner-se"], // 右下角
    ["nw", "corner-nw"], // 左上角
    ["ne", "corner-ne"], // 右上角
  ];
  for (const [dir, cls] of edges) {
    const h = document.createElement("div");
    h.className = `embed-resize ${cls}`;
    h.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const r = blockEl.getBoundingClientRect();
      // ブロックは world 上の要素。画面px→world px へは worldPerScreen で割る
      // （ズーム＋祖先スケールの両方を打ち消す。孫面でもズレない）。
      const z = worldPerScreen(ctx) || 1;
      const node = nodeById(nodeId, ctx);
      const start = {
        x: e.clientX,
        y: e.clientY,
        w: r.width / z,
        h: r.height / z,
        nx: node ? node.x : 0, // 左辺リサイズ時の left 起点（world）
        ny: node ? node.y : 0, // 上辺リサイズ時の top 起点（world）
      };
      const move = (ev) => {
        let w = start.w;
        let ht = start.h;
        if (dir.includes("e")) w = start.w + (ev.clientX - start.x) / z;
        if (dir.includes("w")) w = start.w - (ev.clientX - start.x) / z;
        if (dir.includes("s")) ht = start.h + (ev.clientY - start.y) / z;
        if (dir.includes("n")) ht = start.h - (ev.clientY - start.y) / z;
        w = Math.max(MIN_W, Math.min(MAX_W, w));
        ht = Math.max(MIN_H, Math.min(MAX_H, ht));
        blockEl.style.width = `${w}px`;
        blockEl.style.height = `${ht}px`;
        // 左辺/左角は広げた分だけ左へ（left=node.x を左へずらす）。
        // 上辺/上角は広げた分だけ上へ（top=node.y を上へずらす）。
        // クランプ後の実際の増分を使って一貫させる。
        if (dir.includes("w") && node) {
          node.x = start.nx - (w - start.w);
          blockEl.style.left = `${node.x}px`;
        }
        if (dir.includes("n") && node) {
          node.y = start.ny - (ht - start.h);
          blockEl.style.top = `${node.y}px`;
        }
        // サイズはノード自身に保持（ctx 再生成でも飛ばない・保存に乗る）。
        if (node) {
          node.embedW = Math.round(w);
          node.embedH = Math.round(ht);
        }
        // ブロックの位置・高さが変わると配線の終点も動くので追従させる
        // （この面の配線を引き直す）。
        scheduleConnectors(ctx);
      };
      const up = () => {
        // サイズ・位置どちらが変わっても保存する（以前は左/上方向だけ保存していて
        // 右/下/右下角のサイズ変更が保存されず、最小化復帰でリセットされていた）。
        if (node) markDirty();
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    // 当たり判定（太さ）を「親パネルと同じ画面サイズ」に保つための情報。
    h._scaleCtx = ctx;
    h._dir = dir;
    blockEl.appendChild(h);
  }
  requestAnimationFrame(() => rescaleResizeHandles());
}

// リサイズハンドルの当たり判定（太さ）を、所属面の累積スクリーンスケールに
// 応じて太くし、ズームに依らず画面上で一定の掴みやすさを保つ。辺は片軸、角は
// 両軸を太くする。ズーム/再描画時に呼ぶ。
function rescaleResizeHandles() {
  const BAR = 8; // 辺ハンドルの基準太さ(画面px)
  const COR = 16; // 角ハンドルの基準サイズ(画面px)
  document.querySelectorAll(".embed-resize").forEach((h) => {
    const ctx = h._scaleCtx;
    const dir = h._dir;
    if (!ctx || !ctx.el || !ctx.el.editor || !ctx.el.editor.isConnected) return;
    const inv = 1 / (editorScreenScale(ctx) || 1); // world px / 画面px
    const isCorner = dir.length === 2;
    if (isCorner) {
      h.style.width = `${COR * inv}px`;
      h.style.height = `${COR * inv}px`;
    } else if (dir === "n" || dir === "s") {
      h.style.height = `${BAR * inv}px`;
      h.style.width = "";
    } else {
      h.style.width = `${BAR * inv}px`;
      h.style.height = "";
    }
  });
}

// セグメント head → ノード、ノード.next → 次ノード を線で描く。
// 座標は world 系（#world 内の SVG なので transform で一緒に変形される）。
const WORLD_SIZE = 4000; // コネクタSVGの論理サイズ（world 座標をそのまま使う）
// 各配線をサンプリングした折れ線（world 座標）。ナイフカット判定用。
// ctx.connectorGeo に貯める（[{ segIndex, pts: [{x,y}, ...] }]）。
// 配線の再描画は SVG 全消し＋再生成＋ノードの getBoundingClientRect を伴い
// やや重い。ドラッグ中に毎 pointermove で rAF を積むと1フレームに何度も
// 走るので、面ごとに「次フレーム1回だけ」へまとめる。
function scheduleConnectors(ctx = currentCtx) {
  if (!ctx) return;
  if (ctx._connScheduled) return;
  ctx._connScheduled = true;
  requestAnimationFrame(() => {
    ctx._connScheduled = false;
    drawConnectors(ctx);
  });
}

function drawConnectors(ctx = currentCtx) {
  const svg = ctx.el.connectors;
  if (!svg) return;
  svg.setAttribute("width", WORLD_SIZE);
  svg.setAttribute("height", WORLD_SIZE);
  svg.setAttribute("viewBox", `0 0 ${WORLD_SIZE} ${WORLD_SIZE}`);
  svg.innerHTML = "";

  const p = profile(ctx);

  // ノードの world サイズ（getBoundingClientRect は zoom 後なので /zoom）。
  const nodeSize = (id) => {
    const el = ownOne(ctx, `.anode[data-id="${id}"]`);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const wps = worldPerScreen(ctx);
    return { w: b.width / wps, h: b.height / wps };
  };
  // セグメントからの接続用。◯ポート（CSS: left:-26px / width:18px）の
  // 中心 = ノード左辺から -17px。線をそこまで届かせる。
  const PORT_CX = -17;
  const nodeLeft = (id) => {
    const n = nodeById(id, ctx);
    const s = nodeSize(id);
    if (!n || !s) return null;
    // 通常ノードは縦中央。メニュー（展開）ブロックは巨大なので中央でなく
    // 上段（ヘッダー行＝種別/値の行）の高さに合わせる。これで配線が
    // ブロック左上の◯ポートに正しく届く（中央だと遠くてちぎれて見える）。
    const isMenu = (n.type || "key") === "menu";
    const portY = isMenu ? n.y + MENU_PORT_TOP : n.y + s.h / 2;
    return { x: n.x + PORT_CX, y: portY };
  };

  ctx.connectorGeo = []; // ナイフカットの当たり判定用に折れ線を貯める

  // 始点 (x1,y1) から外側向き(angle=mid)に出てノード (x2,y2) へ入る配線。
  // 第1制御点を放射方向に押し出すことで、線の出だしが外向きになる。
  const addLine = (x1, y1, x2, y2, color, segIndex, mid) => {
    // 外向き単位ベクトル（真上0・時計回り）。
    const rad = ((mid - 90) * Math.PI) / 180;
    const ox = Math.cos(rad);
    const oy = Math.sin(rad);
    const dist = Math.hypot(x2 - x1, y2 - y1);
    // 始点(パイ外周)からの突き出し量。短すぎると外向きに見えないので一定量確保。
    const lead = Math.max(30, dist * 0.35);
    const c1x = x1 + ox * lead;
    const c1y = y1 + oy * lead;
    // ノード側は「左ポート◯」に必ず左から水平に入れる。第2制御点を
    // ポートの左側へ離して置くことで、線がポート手前で左→右に向きを整えて
    // 入り、右から回り込む不自然さを無くす。
    const approach = Math.max(28, dist * 0.3);
    const c2x = x2 - approach; // ポートより左
    const c2y = y2; // 同じ高さ＝水平に入る
    const d = `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`;
    // 見える線＋当たり判定用の透明な太線（右クリックで配線削除）。
    const hit = document.createElementNS(SVG_NS, "path");
    hit.setAttribute("d", d);
    hit.setAttribute("class", "connector-hit");
    hit.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      unlinkSegment(segIndex, ctx);
    });
    svg.appendChild(hit);
    const line = document.createElementNS(SVG_NS, "path");
    line.setAttribute("d", d);
    line.setAttribute("class", "connector");
    line.setAttribute("stroke", color);
    svg.appendChild(line);

    // ベジェを数点でサンプリングして折れ線にし、ナイフ判定に使う。
    const pts = [];
    const N = 12;
    for (let t = 0; t <= N; t++) {
      const u = t / N;
      const mt = 1 - u;
      // 3次ベジェ: P0=(x1,y1) C1=(c1x,c1y) C2=(c2x,c2y) P3=(x2,y2)
      const bx =
        mt * mt * mt * x1 +
        3 * mt * mt * u * c1x +
        3 * mt * u * u * c2x +
        u * u * u * x2;
      const by =
        mt * mt * mt * y1 +
        3 * mt * mt * u * c1y +
        3 * mt * u * u * c2y +
        u * u * u * y2;
      pts.push({ x: bx, y: by });
    }
    ctx.connectorGeo.push({ segIndex, pts });
  };

  // セグメント → head ノード（mid は renderPreview と同じオフセットで揃える）
  p.segments.forEach((seg, i) => {
    if (!seg.head) return;
    const slice = 360 / p.segments.length;
    // 中心が真上起点（i*slice）＋プロファイル回転。回転に配線始点を追従させる。
    const mid = i * slice + (p.rotation || 0);
    // 始点はラジアルメニューの外周そのもの（本体から線が出ているように）。
    const sp = pvPolarCanvas(pvOuter(ctx), mid, ctx);
    const np = nodeLeft(seg.head);
    if (np) addLine(sp.x, sp.y, np.x, np.y, seg.color || "#888", i, mid);
  });

  // クイックスロット → head ノードへの配線（◯ポートから node 左端へ）。
  (p.quick_slots || []).forEach((slot, idx) => {
    if (!slot.head) return;
    const sp = quickPortPos(idx, ctx);
    const np = nodeLeft(slot.head);
    if (!sp || !np) return;
    // 出だしは必ず右（パネルの外）へ突き出してから曲げる。これで線が
    // パネルの背面に回り込んで「ちぎれて」見えるのを防ぐ。
    const dist = Math.hypot(np.x - sp.x, np.y - sp.y);
    const lead = Math.max(40, dist * 0.3);
    const c1x = sp.x + lead;
    const c1y = sp.y;
    // ノード側は「左ポート◯」に必ず左から水平に入れる（右からの回り込み防止）。
    const approach = Math.max(28, dist * 0.3);
    const c2x = np.x - approach; // ポートより左
    const c2y = np.y; // 同じ高さ＝水平に入る
    const d = `M ${sp.x} ${sp.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${np.x} ${np.y}`;
    // 当たり判定用の透明太線（右クリックで配線削除）。
    const hit = document.createElementNS(SVG_NS, "path");
    hit.setAttribute("d", d);
    hit.setAttribute("class", "connector-hit");
    hit.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      slot.head = null;
      markDirty();
      render(ctx);
    });
    svg.appendChild(hit);
    const line = document.createElementNS(SVG_NS, "path");
    line.setAttribute("d", d);
    line.setAttribute("class", "connector");
    line.setAttribute("stroke", "#6fdc9a");
    svg.appendChild(line);

    // ナイフカット用に折れ線をサンプリングして登録（quickSlot 参照付き）。
    const pts = [];
    const N = 12;
    for (let t = 0; t <= N; t++) {
      const u = t / N;
      const mt = 1 - u;
      const bx =
        mt * mt * mt * sp.x +
        3 * mt * mt * u * c1x +
        3 * mt * u * u * c2x +
        u * u * u * np.x;
      const by =
        mt * mt * mt * sp.y +
        3 * mt * mt * u * c1y +
        3 * mt * u * u * c2y +
        u * u * u * np.y;
      pts.push({ x: bx, y: by });
    }
    ctx.connectorGeo.push({ quickSlot: slot, pts });
  });

  // 初期アクションパネル → head ノードへの配線（ルート面のみ）。
  if (!ctx.parentCtx && p.initial_head) {
    const sp = initialPortPos(ctx);
    const np = nodeLeft(p.initial_head);
    if (sp && np) {
      const dist = Math.hypot(np.x - sp.x, np.y - sp.y);
      const lead = Math.max(40, dist * 0.3);
      const c1x = sp.x + lead;
      const c1y = sp.y;
      const approach = Math.max(28, dist * 0.3);
      const c2x = np.x - approach;
      const c2y = np.y;
      const d = `M ${sp.x} ${sp.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${np.x} ${np.y}`;
      const hit = document.createElementNS(SVG_NS, "path");
      hit.setAttribute("d", d);
      hit.setAttribute("class", "connector-hit");
      hit.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        p.initial_head = null;
        markDirty();
        render(ctx);
      });
      svg.appendChild(hit);
      const line = document.createElementNS(SVG_NS, "path");
      line.setAttribute("d", d);
      line.setAttribute("class", "connector");
      line.setAttribute("stroke", "#c9a2ff"); // 初期アクションは紫系
      svg.appendChild(line);
      const pts = [];
      const N = 12;
      for (let t = 0; t <= N; t++) {
        const u = t / N;
        const mt = 1 - u;
        pts.push({
          x:
            mt * mt * mt * sp.x +
            3 * mt * mt * u * c1x +
            3 * mt * u * u * c2x +
            u * u * u * np.x,
          y:
            mt * mt * mt * sp.y +
            3 * mt * mt * u * c1y +
            3 * mt * u * u * c2y +
            u * u * u * np.y,
        });
      }
      ctx.connectorGeo.push({ initial: true, pts });
    }
  }

  // 合体スタック（next）はノードを隙間なく積んで一体のブロックに見せるので、
  // ノード間に線は引かない（縦線は冗長）。

  // 回転ハンドル（↻）を最後に描く＝配線(connector-hit)より前面。これで配線が
  // ハンドルに重なってもドラッグ判定を奪われない。connectors は world 座標。
  if (p.segments && p.segments.length) {
    const rotR = pvOuter(ctx) + 18;
    // pvPolarCanvas(r,deg) は deg=真上0・時計回り。回転ハンドルは「真上＋回転」に
    // 置くので deg = 0 + rotation。
    const hp = pvPolarCanvas(rotR, p.rotation || 0, ctx);
    const rot = document.createElementNS(SVG_NS, "circle");
    rot.setAttribute("cx", hp.x);
    rot.setAttribute("cy", hp.y);
    rot.setAttribute("r", 9);
    rot.setAttribute("class", "pv-rotate-handle");
    rot.dataset.tip = "ドラッグでパイ全体を回転\n（Shiftで項目刻みにスナップ）";
    rot.dataset.tipAnchor = "element";
    rot.style.pointerEvents = "auto"; // connectors は none なので個別に有効化
    rot.addEventListener("pointerdown", (e) => startRotateDrag(e, ctx));
    svg.appendChild(rot);
    const rico = document.createElementNS(SVG_NS, "text");
    rico.setAttribute("x", hp.x);
    rico.setAttribute("y", hp.y);
    rico.setAttribute("text-anchor", "middle");
    rico.setAttribute("dominant-baseline", "central");
    rico.setAttribute("class", "pv-rotate-icon");
    rico.textContent = "↻";
    rico.style.pointerEvents = "none";
    svg.appendChild(rico);
  }
}

// ── 複数選択（矩形選択・一括移動/削除/コピペ） ──────────────────────
// ノードは id、アプリは app オブジェクト参照で選択を保持する。
// selNodes/selApps は ctx ごと（ctx.selNodes / ctx.selApps）。
let clipboard = null; // { nodes:[...], apps:[...] }（コピー内容・面をまたいで共有）

function clearSelection(ctx = currentCtx) {
  ctx.selNodes.clear();
  ctx.selApps.clear();
}
function hasSelection(ctx = currentCtx) {
  return ctx.selNodes.size > 0 || ctx.selApps.size > 0;
}
function selectionCount(ctx = currentCtx) {
  return ctx.selNodes.size + ctx.selApps.size;
}
function selectAll(ctx = currentCtx) {
  const p = profile(ctx);
  clearSelection(ctx);
  p.nodes.forEach((n) => ctx.selNodes.add(n.id));
  p.app_nodes.forEach((a) => ctx.selApps.add(a));
  applySelectionClasses(ctx);
}
// 選択ハイライトを DOM に反映（render 後にも呼ぶ）。
function applySelectionClasses(ctx = currentCtx) {
  ownAll(ctx, ".anode").forEach((el) => {
    el.classList.toggle("selected", ctx.selNodes.has(el.dataset.id));
  });
  const apps = profile(ctx).app_nodes;
  ownAll(ctx, ".app-node").forEach((el, i) => {
    el.classList.toggle("selected", ctx.selApps.has(apps[i]));
  });
}

// ── ノードのドラッグ（自由配置＋上下合体） ────────────────────────
// drag / nodeDragMoved / selectArm は ctx ごとに持つ。

// 種別ドロップダウン用：preventDefault せずに様子見し、一定px動いたら
// ノードドラッグへ昇格する。動かなければネイティブの開閉に任せる。
function armSelectDrag(e, id, selectEl, ctx = currentCtx) {
  // 既存の様子見があれば破棄。
  disarmSelectDrag(ctx);
  ctx.selectArm = { id, selectEl, sx: e.clientX, sy: e.clientY };
  ctx._onSelectArmMove = (ev) => onSelectArmMove(ev, ctx);
  ctx._disarmSelectDrag = () => disarmSelectDrag(ctx);
  window.addEventListener("pointermove", ctx._onSelectArmMove, true);
  window.addEventListener("pointerup", ctx._disarmSelectDrag, true);
}
function onSelectArmMove(e, ctx = currentCtx) {
  if (!ctx.selectArm) return;
  if (
    Math.hypot(e.clientX - ctx.selectArm.sx, e.clientY - ctx.selectArm.sy) <= 5
  ) {
    return; // まだクリックの範囲内
  }
  // ドラッグと判定 → 開きかけたドロップダウンを閉じてノードドラッグへ。
  const { id, selectEl, sx, sy } = ctx.selectArm;
  disarmSelectDrag(ctx);
  if (selectEl) selectEl.blur();
  // ドラッグ開始は押し始めの位置を起点にする（途中から動いた分を反映）。
  startNodeDrag({ clientX: sx, clientY: sy, preventDefault() {} }, id, ctx);
  // 押し始め基準にしたので、今フレームの移動も反映させる。
  if (ctx.drag) onNodeDragMove(e, ctx);
}
function disarmSelectDrag(ctx = currentCtx) {
  if (ctx._onSelectArmMove)
    window.removeEventListener("pointermove", ctx._onSelectArmMove, true);
  if (ctx._disarmSelectDrag)
    window.removeEventListener("pointerup", ctx._disarmSelectDrag, true);
  ctx._onSelectArmMove = null;
  ctx._disarmSelectDrag = null;
  ctx.selectArm = null;
}

function startNodeDrag(e, id, ctx = currentCtx) {
  e.preventDefault();
  const node = nodeById(id, ctx);
  if (!node) return;
  ctx.nodeDragMoved = false;

  // 選択中ブロックを掴み、かつ複数選択中なら一括ドラッグ。
  if (ctx.selNodes.has(id) && selectionCount(ctx) > 1) {
    startGroupDrag(e, ctx);
    return;
  }
  // 非選択ブロックを単独で掴んだら選択を解除する。
  if (!ctx.selNodes.has(id)) {
    clearSelection(ctx);
    applySelectionClasses(ctx);
  }
  const editor = ctx.el.editor;
  const eb = editor.getBoundingClientRect();
  ctx.drag = {
    id,
    // ノード群（このノードと、その下に繋がる全ノード）を一緒に動かす。
    chain: collectChain(id, ctx),
    startX: e.clientX,
    startY: e.clientY,
    origX: node.x,
    origY: node.y,
    eb,
    // どのプロファイル発のドラッグか。別タブへ運ぶ判定に使う。
    fromProfile: ctx.profileIndex,
  };
  // ドラッグ開始時、上の親から切り離す（合体解除）。
  const parent = parentOf(id, ctx);
  if (parent) {
    parent.next = null;
    markDirty();
  }
  // セグメントが直接このノードを指していれば維持（切り離さない）。
  ctx._onNodeDragMove = (ev) => onNodeDragMove(ev, ctx);
  ctx._onNodeDragUp = () => onNodeDragUp(ctx);
  window.addEventListener("pointermove", ctx._onNodeDragMove);
  window.addEventListener("pointerup", ctx._onNodeDragUp);
}

// id から next を辿って繋がる全ノード id を返す。
function collectChain(id, ctx = currentCtx) {
  const out = [];
  let cur = id;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    const n = nodeById(cur, ctx);
    cur = n ? n.next : null;
  }
  return out;
}

// 先頭ノードの座標(headX,headY)を起点に、チェーンを縦に積み直して DOM へ反映。
// 高さは world 単位（getBoundingClientRect は zoom 後の実寸なので /zoom する）。
function layoutChain(headX, headY, ctx = currentCtx) {
  let y = headY;
  ctx.drag.chain.forEach((cid) => {
    const n = nodeById(cid, ctx);
    const el = ownOne(ctx, `.anode[data-id="${cid}"]`);
    if (!n || !el) return;
    n.x = headX;
    n.y = y;
    el.style.left = `${headX}px`;
    el.style.top = `${y}px`;
    y += el.getBoundingClientRect().height / worldPerScreen(ctx) - 2;
  });
}

function onNodeDragMove(e, ctx = currentCtx) {
  const drag = ctx.drag;
  if (!drag) return;
  // 数px以上動いたら「移動」とみなす（値ボタンのクリックと区別）。
  if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 3) {
    ctx.nodeDragMoved = true;
  }

  // ドラッグ中に別タブの上へ来たら、そのプロファイルへ切り替えて
  // ブロック（ノードチェーン）を運ぶ（別プロファイルへ移動）。
  // タブ移動はルート面のみ（内包面は別プロファイルを運ばない）。
  if (ctx === rootCtx) {
    const tabIdx = tabAtPoint(e.clientX, e.clientY);
    if (tabIdx !== null && tabIdx !== ctx.profileIndex) {
      moveDragChainToProfile(tabIdx, e, ctx);
      return; // 切替直後はこのフレームの配置をスキップ（次の move で追従）。
    }
  }

  // 移動量は world 単位へ（zoom＋祖先スケールを打ち消す）。
  const wps = worldPerScreen(ctx);
  const dx = (e.clientX - drag.startX) / wps;
  const dy = (e.clientY - drag.startY) / wps;

  // まずカーソル追従で配置。
  let headX = drag.origX + dx;
  let headY = drag.origY + dy;
  layoutChain(headX, headY, ctx);

  // スナップ候補があれば、その相手の真下にカチッと吸着整列する。
  const target = snapCandidate(ctx);
  if (target) {
    const t = nodeById(target, ctx);
    const tEl = ownOne(ctx, `.anode[data-id="${target}"]`);
    if (t && tEl) {
      // 相手の左端に揃え、下端の少し上に重ねて置く（すべて world 単位）。
      const th = tEl.getBoundingClientRect().height / worldPerScreen(ctx);
      headX = t.x;
      headY = t.y + th - 2;
      layoutChain(headX, headY, ctx);
    }
  }

  highlightSnapTargetWith(target, ctx);
  scheduleConnectors(ctx);
}

// ドラッグ中の先頭ノードが、他ノードの下端付近にあればスナップ候補を返す。
// 横は広め(±幅の半分強)・縦は下端付近で判定し、近いものを採用。
function snapCandidate(ctx = currentCtx) {
  const drag = ctx.drag;
  if (!drag) return null;
  const p = profile(ctx);
  // メニュー（サブメニュー）ブロックも普通に連結できる:
  // 上に積んだ分＝サブメニューを開く前に実行（例: Ctrl離す→メニュー）、
  // 下に積んだ分＝サブメニュー内で発動した後の「続き」として実行。
  const inChain = new Set(drag.chain);
  const myEl = ownOne(ctx, `.anode[data-id="${drag.id}"]`);
  if (!myEl) return null;
  const mb = myEl.getBoundingClientRect();

  let best = null;
  let bestScore = Infinity;
  p.nodes.forEach((n) => {
    if (inChain.has(n.id)) return;
    if (n.next) return; // 既に下に何か繋がってるノードには積めない
    const el = ownOne(ctx, `.anode[data-id="${n.id}"]`);
    if (!el) return;
    const nb = el.getBoundingClientRect();
    // 判定は**左端揃え**基準（スナップ後の整列も左端揃えなので一致させる）。
    // 中心基準だと、巨大なメニューブロックを左端を揃えて重ねても中心が
    // 大きくズレて判定に入らず「くっつかない」ことがあった。
    const dx = Math.abs(mb.left - nb.left);
    const dy = mb.top - nb.bottom; // 自分の上端 − 相手の下端
    // ほぼ重ねたときだけ吸着する（近くに置くだけでは合体しない）。
    // 横は相手幅の5割以内、縦は相手の下端 -10〜+14px のみ。
    if (dx > nb.width * 0.5) return;
    if (dy < -10 || dy > 14) return;
    const score = dx + Math.abs(dy); // 近いほど小さい
    if (score < bestScore) {
      bestScore = score;
      best = n.id;
    }
  });
  return best;
}

function highlightSnapTargetWith(target, ctx = currentCtx) {
  ownAll(ctx, ".anode.snap").forEach((el) => {
    if (el.dataset.id !== target) el.classList.remove("snap");
  });
  if (target) {
    const el = ownOne(ctx, `.anode[data-id="${target}"]`);
    if (el) el.classList.add("snap");
  }
}

function onNodeDragUp(ctx = currentCtx) {
  const drag = ctx.drag;
  if (!drag) return;
  if (ctx._onNodeDragMove)
    window.removeEventListener("pointermove", ctx._onNodeDragMove);
  if (ctx._onNodeDragUp)
    window.removeEventListener("pointerup", ctx._onNodeDragUp);
  ctx._onNodeDragMove = null;
  ctx._onNodeDragUp = null;

  // 動かしていない＝クリック扱い。再描画すると DOM が作り直されて
  // 値ボタンの click が発火しないので、ここでは何もしない（drag を畳むだけ）。
  if (!ctx.nodeDragMoved) {
    ctx.drag = null;
    ownAll(ctx, ".anode.snap").forEach((el) => el.classList.remove("snap"));
    return;
  }

  const target = snapCandidate(ctx);
  if (target) {
    const t = nodeById(target, ctx);
    if (t) {
      const p = profile(ctx);
      const newHead = stackHeadOf(target, ctx);
      // 合体先スタックの先頭に既に配線があるか。
      const headHasLink = p.segments.some((s) => s.head === newHead);
      p.segments.forEach((s) => {
        if (s.head === drag.id) {
          // ドラッグしたノードは合体後スタックの途中になる＝先頭でなくなる。
          // 先頭にまだ配線が無ければ先頭へ移し、既にあれば二重配線になるので外す。
          s.head = headHasLink ? null : newHead;
        }
      });
      // 合体: target の next を先頭ノードにする。
      t.next = drag.id;
    }
  }
  ctx.drag = null;
  ownAll(ctx, ".anode.snap").forEach((el) => el.classList.remove("snap"));
  markDirty();
  render(ctx);
  ctx.nodeDragMoved = false;
}

// ── 複数選択の一括ドラッグ移動 ──────────────────────────────────
// groupDrag は ctx ごと（ctx.groupDrag）。
function startGroupDrag(e, ctx = currentCtx) {
  e.preventDefault();
  const p = profile(ctx);
  // 移動対象ノード = 選択ノード＋その下に繋がるチェーン全部。
  const ids = new Set();
  ctx.selNodes.forEach((id) =>
    collectChain(id, ctx).forEach((c) => ids.add(c)),
  );
  const nodes = [];
  ids.forEach((id) => {
    const n = nodeById(id, ctx);
    if (n) nodes.push({ n, ox: n.x ?? 0, oy: n.y ?? 0 });
  });
  const apps = [];
  p.app_nodes.forEach((a) => {
    if (ctx.selApps.has(a)) apps.push({ a, ox: a.x ?? 0, oy: a.y ?? 0 });
  });
  ctx.groupDrag = { sx: e.clientX, sy: e.clientY, nodes, apps };
  ctx._onGroupDragMove = (ev) => onGroupDragMove(ev, ctx);
  ctx._onGroupDragUp = () => onGroupDragUp(ctx);
  window.addEventListener("pointermove", ctx._onGroupDragMove);
  window.addEventListener("pointerup", ctx._onGroupDragUp);
}
function onGroupDragMove(e, ctx = currentCtx) {
  const groupDrag = ctx.groupDrag;
  if (!groupDrag) return;
  const wps = worldPerScreen(ctx);
  const dx = (e.clientX - groupDrag.sx) / wps;
  const dy = (e.clientY - groupDrag.sy) / wps;
  groupDrag.nodes.forEach(({ n, ox, oy }) => {
    n.x = ox + dx;
    n.y = oy + dy;
    const el = ownOne(ctx, `.anode[data-id="${n.id}"]`);
    if (el) {
      el.style.left = `${n.x}px`;
      el.style.top = `${n.y}px`;
    }
  });
  groupDrag.apps.forEach(({ a, ox, oy }, i) => {
    a.x = ox + dx;
    a.y = oy + dy;
  });
  // アプリは index 依存で DOM 反映が面倒なので、まとめて再配置。
  const apps = profile(ctx).app_nodes;
  ownAll(ctx, ".app-node").forEach((el, i) => {
    const a = apps[i];
    if (ctx.selApps.has(a)) {
      el.style.left = `${a.x}px`;
      el.style.top = `${a.y}px`;
    }
  });
  scheduleConnectors(ctx);
}
function onGroupDragUp(ctx = currentCtx) {
  if (ctx._onGroupDragMove)
    window.removeEventListener("pointermove", ctx._onGroupDragMove);
  if (ctx._onGroupDragUp)
    window.removeEventListener("pointerup", ctx._onGroupDragUp);
  ctx._onGroupDragMove = null;
  ctx._onGroupDragUp = null;
  ctx.groupDrag = null;
  markDirty();
  render(ctx);
}

// 画面座標にあるプロファイルタブの index を返す（無ければ null）。
function tabAtPoint(clientX, clientY) {
  const els = document.elementsFromPoint(clientX, clientY);
  for (const el of els) {
    const tab = el.closest && el.closest(".tab");
    if (tab && tab.dataset.index !== undefined) {
      return Number(tab.dataset.index);
    }
  }
  return null;
}

// ドラッグ中のブロック（ノードチェーン）を別プロファイルへ移動する。
// 元プロファイルからは取り除き、配線（セグメント接続）は外して移す。
function moveDragChainToProfile(toIndex, e, ctx = currentCtx) {
  const drag = ctx.drag;
  if (!drag) return;
  const from = config.profiles[ctx.profileIndex];
  const to = config.profiles[toIndex];
  if (!from || !to || from === to) return;

  // 移動するノード実体を集める（チェーン順）。
  const moving = drag.chain
    .map((cid) => from.nodes.find((n) => n.id === cid))
    .filter(Boolean);
  if (moving.length === 0) return;

  const movingIds = new Set(moving.map((n) => n.id));
  // 元プロファイル側の参照を掃除（このチェーンを指す next / head を外す）。
  from.nodes.forEach((n) => {
    if (n.next && movingIds.has(n.next)) n.next = null;
  });
  from.segments.forEach((s) => {
    if (s.head && movingIds.has(s.head)) s.head = null; // 配線は外す
  });
  (from.quick_slots || []).forEach((q) => {
    if (q.head && movingIds.has(q.head)) q.head = null; // クイック配線も外す
  });
  // 元プロファイルからノードを除去。
  from.nodes = from.nodes.filter((n) => !movingIds.has(n.id));

  // 移動先へ追加（チェーン内の next 連結はそのまま保持）。
  to.nodes.push(...moving);

  // タブ切替（移動先を表示）。drag は維持したまま再描画する。
  ctx.profileIndex = toIndex;
  if (!Array.isArray(to.app_nodes)) to.app_nodes = [];
  markDirty();
  render(ctx);

  // 以降はこのプロファイル基準でカーソル追従させる。先頭ノードの現在 world 位置を
  // 原点に取り直し、ドラッグの基準を今のカーソル位置へリセットする。
  const head = nodeById(drag.id, ctx);
  if (head) {
    drag.origX = head.x;
    drag.origY = head.y;
    drag.startX = e.clientX;
    drag.startY = e.clientY;
  }
  scheduleConnectors(ctx);
}

// ── ノードポート → セグメントの線ドラッグ（ノード起点で繋ぎ替え） ──
// nodeLink 状態は ctx.nodeLink。
function startNodeLinkDrag(e, nodeId, ctx = currentCtx) {
  if (e.button !== 0) return; // 左のみ。右クリックは配線削除（contextmenu）に任せる。
  e.preventDefault();
  e.stopPropagation();
  ctx.nodeLink = { nodeId };
  ctx._onNodeLinkMove = (ev) => onNodeLinkMove(ev, ctx);
  ctx._onNodeLinkUp = (ev) => onNodeLinkUp(ev, ctx);
  window.addEventListener("pointermove", ctx._onNodeLinkMove);
  window.addEventListener("pointerup", ctx._onNodeLinkUp);
}

function onNodeLinkMove(e, ctx = currentCtx) {
  const nodeLink = ctx.nodeLink;
  if (!nodeLink) return;
  const node = nodeById(nodeLink.nodeId, ctx);
  if (!node) return;
  // ノード左辺中央（world）を始点に、カーソルへ仮線。
  const s = ownOne(ctx, `.anode[data-id="${nodeLink.nodeId}"]`);
  const sb = s ? s.getBoundingClientRect().height / worldPerScreen(ctx) : 28;
  const x1 = node.x;
  const y1 = node.y + sb / 2;
  const w = clientToWorld(e.clientX, e.clientY, ctx);

  drawConnectors(ctx);
  const svg = ctx.el.connectors;
  const cx = (x1 + w.x) / 2;
  const line = document.createElementNS(SVG_NS, "path");
  line.setAttribute(
    "d",
    `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${w.y}, ${w.x} ${w.y}`,
  );
  line.setAttribute("class", "connector linking");
  svg.appendChild(line);

  // セグメントハンドル上ハイライト。
  const segI = segHandleAtPoint(e.clientX, e.clientY, ctx);
  ctx.el.preview.querySelectorAll(".pv-seg.seg-drop").forEach((el) => {
    if (Number(el.dataset.index) !== segI) el.classList.remove("seg-drop");
  });
  if (segI !== null) {
    const el = ctx.el.preview.querySelector(`.pv-seg[data-index="${segI}"]`);
    if (el) el.classList.add("seg-drop");
  }

  // クイックスロット行上ハイライト。
  const qKind = quickSlotKindAtPoint(e.clientX, e.clientY, ctx);
  ctx.el.nodes
    .querySelectorAll(":scope > .qpanel .qpanel-row.drop")
    .forEach((el) => {
      if (el.dataset.qkind !== qKind) el.classList.remove("drop");
    });
  if (qKind) {
    const row = ownQpanelRow(ctx, `.qpanel-row[data-qkind="${qKind}"]`);
    if (row) row.classList.add("drop");
  }

  // 別ノード上ハイライト（配線をそのノードへ繋ぎ替える）。自分自身は除く。
  const dropped = nodeAtPoint(e.clientX, e.clientY, ctx);
  const overId =
    dropped && stackHeadOf(dropped, ctx) !== nodeLink.nodeId
      ? stackHeadOf(dropped, ctx)
      : null;
  ownAll(ctx, ".anode.link-target").forEach((el) => {
    if (el.dataset.id !== overId) el.classList.remove("link-target");
  });
  if (overId) {
    const el = ownOne(ctx, `.anode[data-id="${overId}"]`);
    if (el) el.classList.add("link-target");
  }
}

function onNodeLinkUp(e, ctx = currentCtx) {
  const nodeLink = ctx.nodeLink;
  if (!nodeLink) return;
  if (ctx._onNodeLinkMove)
    window.removeEventListener("pointermove", ctx._onNodeLinkMove);
  if (ctx._onNodeLinkUp)
    window.removeEventListener("pointerup", ctx._onNodeLinkUp);
  ctx._onNodeLinkMove = null;
  ctx._onNodeLinkUp = null;
  const segI = segHandleAtPoint(e.clientX, e.clientY, ctx);
  const qKind = quickSlotKindAtPoint(e.clientX, e.clientY, ctx);
  const p = profile(ctx);
  const nodeId = nodeLink.nodeId;
  if (qKind !== null) {
    // クイックスロットに落とした → そのスロットへ繋ぎ替え。
    // このノードを指していた既存の接続元（セグメント／他スロット）を外す。
    clearLinksTo(nodeId, ctx);
    const slot = (p.quick_slots || []).find((s) => s.kind === qKind);
    if (slot) {
      slot.head = nodeId;
      markDirty();
    }
  } else if (segI !== null) {
    // セグメントに落とした → そのセグメントへ繋ぎ替え。既存接続元を外す。
    clearLinksTo(nodeId, ctx);
    p.segments[segI].head = nodeId;
    markDirty();
  } else {
    // 別ノードに落とした: このノードに繋がっていた接続元（セグメント or
    // クイックスロット）を、そのノードへ移す（繋ぎ替え）。
    const dropped = nodeAtPoint(e.clientX, e.clientY, ctx);
    const overId = dropped ? stackHeadOf(dropped, ctx) : null;
    if (overId && overId !== nodeId) {
      const seg = p.segments.find((s) => s.head === nodeId);
      const slot = (p.quick_slots || []).find((s) => s.head === nodeId);
      // 移動先に既にあった接続元は外す（1ノード1接続元）。
      clearLinksTo(overId, ctx);
      if (seg) seg.head = overId;
      else if (slot) slot.head = overId;
      markDirty();
    }
  }
  ctx.nodeLink = null;
  ctx.el.preview
    .querySelectorAll(".pv-seg.seg-drop")
    .forEach((el) => el.classList.remove("seg-drop"));
  ownAll(ctx, ".anode.link-target").forEach((el) =>
    el.classList.remove("link-target"),
  );
  ctx.el.nodes
    .querySelectorAll(":scope > .qpanel .qpanel-row.drop")
    .forEach((el) => el.classList.remove("drop"));
  render(ctx);
}

// 指定ノードを指している接続元（セグメント／クイックスロット）をすべて外す。
// 「1ノードにつき接続元は1つ」を保つための共通処理。
function clearLinksTo(nodeId, ctx = currentCtx) {
  const p = profile(ctx);
  p.segments.forEach((s) => {
    if (s.head === nodeId) s.head = null;
  });
  (p.quick_slots || []).forEach((q) => {
    if (q.head === nodeId) q.head = null;
  });
}

// 画面座標にあるセグメント接続ハンドル(.pv-handle-hit)の index を返す。
function segHandleAtPoint(clientX, clientY, ctx = currentCtx) {
  const els = document.elementsFromPoint(clientX, clientY);
  for (const el of els) {
    // 専用ハンドルは廃止。セグメント本体に落としたら繋げる。
    // 別面（内包）の pv-seg を拾わないよう、この面の preview 内に限定。
    if (
      el.classList &&
      el.classList.contains("pv-seg") &&
      ownsInPreview(ctx, el)
    ) {
      return Number(el.dataset.index);
    }
  }
  return null;
}

// 画面座標にあるクイックスロット行の kind を返す（無ければ null）。
// ◯ポートまたは行本体に落としたら、そのスロットへ繋ぐ。
function quickSlotKindAtPoint(clientX, clientY, ctx = currentCtx) {
  const els = document.elementsFromPoint(clientX, clientY);
  for (const el of els) {
    const row = el.closest && el.closest(".qpanel-row");
    if (row && row.dataset.qkind && ownsInNodes(ctx, row))
      return row.dataset.qkind;
  }
  return null;
}

// ── セグメント → ノードの線ドラッグ（繋ぎ替え） ──────────────────
// link 状態は ctx.link。
function startLinkDrag(e, segIndex, mid, ctx = currentCtx) {
  e.preventDefault();
  e.stopPropagation();
  const editor = ctx.el.editor;
  const eb = editor.getBoundingClientRect();
  const sp = pvPolarCanvas(pvOuter(ctx) + HANDLE_EDGE, mid, ctx);
  ctx.link = { segIndex, eb, sp, mid };
  ctx._onLinkDragMove = (ev) => onLinkDragMove(ev, ctx);
  ctx._onLinkDragUp = (ev) => onLinkDragUp(ev, ctx);
  window.addEventListener("pointermove", ctx._onLinkDragMove);
  window.addEventListener("pointerup", ctx._onLinkDragUp);
}

function onLinkDragMove(e, ctx = currentCtx) {
  const link = ctx.link;
  if (!link) return;
  // カーソル位置を world 座標へ（仮線も world で描く）。
  const w = clientToWorld(e.clientX, e.clientY, ctx);
  const x = w.x;
  const y = w.y;
  // 仮の線を描く。出だしは外向き（mid 方向）にしてから繋ぐ。
  drawConnectors(ctx);
  const svg = ctx.el.connectors;
  const rad = ((link.mid - 90) * Math.PI) / 180;
  const lead = Math.max(30, Math.hypot(x - link.sp.x, y - link.sp.y) * 0.35);
  const c1x = link.sp.x + Math.cos(rad) * lead;
  const c1y = link.sp.y + Math.sin(rad) * lead;
  const c2x = (c1x + x) / 2;
  const line = document.createElementNS(SVG_NS, "path");
  line.setAttribute(
    "d",
    `M ${link.sp.x} ${link.sp.y} C ${c1x} ${c1y}, ${c2x} ${y}, ${x} ${y}`,
  );
  line.setAttribute("class", "connector linking");
  svg.appendChild(line);
  // ノード上ハイライト（スタック先頭を強調）。
  const dropped = nodeAtPoint(e.clientX, e.clientY, ctx);
  const overId = dropped ? stackHeadOf(dropped, ctx) : null;
  ownAll(ctx, ".anode.link-target").forEach((el) => {
    if (el.dataset.id !== overId) el.classList.remove("link-target");
  });
  if (overId) {
    const el = ownOne(ctx, `.anode[data-id="${overId}"]`);
    if (el) el.classList.add("link-target");
  }
}

function onLinkDragUp(e, ctx = currentCtx) {
  const link = ctx.link;
  if (!link) return;
  const dropped = nodeAtPoint(e.clientX, e.clientY, ctx);
  // 合体スタックの途中に落としても、必ずスタック先頭に繋ぐ。
  const overId = dropped ? stackHeadOf(dropped, ctx) : null;
  const p = profile(ctx);
  const seg = p.segments[link.segIndex];
  if (seg) {
    if (overId) {
      // 1ノード（スタック）につき接続元セグメントは1つ。新しく繋いだ方を
      // 優先し、同じ先頭を指していた他のセグメントの接続を外す。
      p.segments.forEach((s, i) => {
        if (i !== link.segIndex && s.head === overId) s.head = null;
      });
      seg.head = overId;
    } else {
      seg.head = null; // ノード外で離したら切断
    }
    markDirty();
  }
  if (ctx._onLinkDragMove)
    window.removeEventListener("pointermove", ctx._onLinkDragMove);
  if (ctx._onLinkDragUp)
    window.removeEventListener("pointerup", ctx._onLinkDragUp);
  ctx._onLinkDragMove = null;
  ctx._onLinkDragUp = null;
  ctx.link = null;
  ownAll(ctx, ".anode.link-target").forEach((el) => el.classList.remove("link-target"));
  render(ctx);
}

// 画面座標にあるノードの id を返す（なければ null）。
// 別面（内包）の .anode を拾わないよう、この面の nodes 内に限定。
function nodeAtPoint(clientX, clientY, ctx = currentCtx) {
  const els = document.elementsFromPoint(clientX, clientY);
  for (const el of els) {
    const a = el.closest(".anode");
    if (a && ownsInNodes(ctx, a)) return a.dataset.id;
  }
  return null;
}

// ── ノード追加・削除 ──────────────────────────────────────────────
// ブロックの追加は右クリックメニュー（openCanvasContextMenu）で行う。

function deleteNode(id, ctx = currentCtx) {
  const p = profile(ctx);
  // 参照を外す: このノードを head に持つセグメント／クイックスロット、next。
  p.segments.forEach((s) => {
    if (s.head === id) s.head = null;
  });
  (p.quick_slots || []).forEach((q) => {
    if (q.head === id) q.head = null;
  });
  p.nodes.forEach((n) => {
    if (n.next === id) n.next = null;
  });
  p.nodes = p.nodes.filter((n) => n.id !== id);
  markDirty();
  render(ctx);
  showDeleteToast();
}

// 選択中のブロック（ノード＋アプリ）をまとめて削除する。
function deleteSelection(ctx = currentCtx) {
  if (!hasSelection(ctx)) return;
  const p = profile(ctx);
  // ノード: 選択ノードのチェーン全体を消す。
  const removeIds = new Set();
  ctx.selNodes.forEach((id) =>
    collectChain(id, ctx).forEach((c) => removeIds.add(c)),
  );
  if (removeIds.size > 0) {
    p.segments.forEach((s) => {
      if (s.head && removeIds.has(s.head)) s.head = null;
    });
    (p.quick_slots || []).forEach((q) => {
      if (q.head && removeIds.has(q.head)) q.head = null;
    });
    p.nodes.forEach((n) => {
      if (n.next && removeIds.has(n.next)) n.next = null;
    });
    p.nodes = p.nodes.filter((n) => !removeIds.has(n.id));
  }
  // アプリ: 選択アプリを消す。
  if (ctx.selApps.size > 0) {
    p.app_nodes = p.app_nodes.filter((a) => !ctx.selApps.has(a));
  }
  clearSelection(ctx);
  markDirty();
  render(ctx);
  showDeleteToast();
}

// 選択中のブロックをクリップボードにコピーする。
function copySelection(ctx = currentCtx) {
  if (!hasSelection(ctx)) return;
  const p = profile(ctx);
  // ノードはチェーン込みでディープコピー（id は貼付時に振り直す）。
  const ids = new Set();
  ctx.selNodes.forEach((id) =>
    collectChain(id, ctx).forEach((c) => ids.add(c)),
  );
  const nodes = p.nodes
    .filter((n) => ids.has(n.id))
    .map((n) => JSON.parse(JSON.stringify(n)));
  const apps = p.app_nodes
    .filter((a) => ctx.selApps.has(a))
    .map((a) => JSON.parse(JSON.stringify(a)));
  clipboard = { nodes, apps };
  showToast(`${nodes.length + apps.length}件をコピーしました`);
}

// クリップボードの内容を貼り付ける（少しずらして配置・新規 id）。
function pasteClipboard(ctx = currentCtx) {
  if (!clipboard) return;
  const p = profile(ctx);
  clearSelection(ctx);

  // サブメニュー（子）にはアプリを置けない。貼り付け対象に含めるか判定。
  const pasteApps = !ctx.parentCtx;
  if (!pasteApps && clipboard.apps.length > 0) {
    showToast("サブメニューは対象アプリ指定できません。\n親のパネルに準じます。");
  }

  // 貼り付ける要素の元座標の左上（最小 x/y）を基準点にする。
  const items = [...clipboard.nodes];
  if (pasteApps) items.push(...clipboard.apps);
  if (items.length === 0) return;
  const minX = Math.min(...items.map((it) => it.x ?? 0));
  const minY = Math.min(...items.map((it) => it.y ?? 0));

  // ペースト先の左上をカーソル近く（少し左上）に。カーソル world が無ければ
  // 従来どおり元位置＋少しずらし。
  const cur = ctx.lastMouseWorld;
  let baseX = cur ? cur.x - 16 - minX : 28;
  let baseY = cur ? cur.y - 14 - minY : 28;

  // 既存ブロックと「ほぼ完全に重なる」位置になりそうなら少しずらす。
  // 先頭要素の着地点で判定し、近接していたら +24,+24 を数回まで足す。
  const existing = [
    ...p.nodes.map((n) => ({ x: n.x ?? 0, y: n.y ?? 0 })),
    ...(p.app_nodes || []).map((a) => ({ x: a.x ?? 0, y: a.y ?? 0 })),
  ];
  const NUDGE = 24;
  const near = (ax, ay, bx, by) =>
    Math.abs(ax - bx) < 6 && Math.abs(ay - by) < 6;
  for (let guard = 0; guard < 20; guard++) {
    const landX = (items[0].x ?? 0) + baseX;
    const landY = (items[0].y ?? 0) + baseY;
    if (existing.some((e) => near(e.x, e.y, landX, landY))) {
      baseX += NUDGE;
      baseY += NUDGE;
    } else break;
  }

  // ノード: 旧 id → 新 id の対応を作り、next も付け替える。
  const idMap = new Map();
  clipboard.nodes.forEach((n) => idMap.set(n.id, newNodeId(ctx)));
  clipboard.nodes.forEach((n) => {
    const copy = JSON.parse(JSON.stringify(n));
    copy.id = idMap.get(n.id);
    copy.next = n.next && idMap.has(n.next) ? idMap.get(n.next) : null;
    copy.x = (copy.x ?? 0) + baseX;
    copy.y = (copy.y ?? 0) + baseY;
    p.nodes.push(copy);
    ctx.selNodes.add(copy.id);
  });
  // アプリ（ルート面のみ）。
  if (pasteApps) {
    clipboard.apps.forEach((a) => {
      const copy = JSON.parse(JSON.stringify(a));
      copy.x = (copy.x ?? 0) + baseX;
      copy.y = (copy.y ?? 0) + baseY;
      p.app_nodes.push(copy);
      ctx.selApps.add(copy);
    });
  }
  markDirty();
  render(ctx);
}

// セグメントの配線を外す（線・◯の右クリックから呼ぶ）。head を消すだけ。
function unlinkSegment(segIndex, ctx = currentCtx) {
  const seg = profile(ctx).segments[segIndex];
  if (!seg || !seg.head) return;
  seg.head = null;
  markDirty();
  render(ctx);
}

// ノード id を head に持つセグメントの index を返す（無ければ -1）。
function segIndexForHead(id, ctx = currentCtx) {
  return profile(ctx).segments.findIndex((s) => s.head === id);
}

// ノードを複製する。種別・値だけコピーした独立ノード（接続・合体なし）を
// 元の少し右下に置く。
function duplicateNode(id, ctx = currentCtx) {
  const p = profile(ctx);
  const src = nodeById(id, ctx);
  if (!src) return;
  p.nodes.push({
    id: newNodeId(ctx),
    type: src.type || "key",
    value: src.value || "",
    x: (src.x ?? 0) + 24,
    y: (src.y ?? 0) + 24,
    next: null,
  });
  markDirty();
  render(ctx);
}

// ── 外周/内径ドラッグで半径を変更 ────────────────────────────────
// radiusDrag は ctx.radiusDrag。
function startRadiusDrag(e, which, ctx = currentCtx) {
  if (e.button !== 0) return; // 左のみ
  e.preventDefault();
  e.stopPropagation();
  ctx.radiusDrag = { which };
  ctx._onRadiusDragMove = (ev) => onRadiusDragMove(ev, ctx);
  ctx._onRadiusDragUp = () => onRadiusDragUp(ctx);
  window.addEventListener("pointermove", ctx._onRadiusDragMove);
  window.addEventListener("pointerup", ctx._onRadiusDragUp);
}

// 回転ハンドルでパイ全体を回す。ctx.rotateDrag。
function startRotateDrag(e, ctx = currentCtx) {
  if (e.button !== 0) return; // 左のみ
  e.preventDefault();
  e.stopPropagation();
  ctx.rotateDrag = true;
  ctx._onRotateDragMove = (ev) => onRotateDragMove(ev, ctx);
  ctx._onRotateDragUp = () => onRotateDragUp(ctx);
  window.addEventListener("pointermove", ctx._onRotateDragMove);
  window.addEventListener("pointerup", ctx._onRotateDragUp);
}
function onRotateDragMove(e, ctx = currentCtx) {
  if (!ctx.rotateDrag) return;
  const w = clientToWorld(e.clientX, e.clientY, ctx);
  const { cx, cy } = pvCenter(ctx);
  // カーソルの中心からの角度(度, +x=0)。ハンドルは真上(-90)+rotation の位置に
  // 出しているので、rotation = カーソル角 + 90。
  let rot = (Math.atan2(w.y - cy, w.x - cx) * 180) / Math.PI + 90;
  // Shift 押下中はセグメント1個分(slice)の刻みにスナップ。
  if (e.shiftKey) {
    const segs = profile(ctx).segments;
    const slice = segs.length ? 360 / segs.length : 90;
    rot = Math.round(rot / slice) * slice;
  }
  // -180〜180 に正規化（見やすさ・保存値の安定）。
  rot = ((((rot + 180) % 360) + 360) % 360) - 180;
  profile(ctx).rotation = rot;
  markDirty();
  renderPreview(ctx);
  scheduleConnectors(ctx);
}
function onRotateDragUp(ctx = currentCtx) {
  ctx.rotateDrag = false;
  if (ctx._onRotateDragMove)
    window.removeEventListener("pointermove", ctx._onRotateDragMove);
  if (ctx._onRotateDragUp)
    window.removeEventListener("pointerup", ctx._onRotateDragUp);
  ctx._onRotateDragMove = null;
  ctx._onRotateDragUp = null;
}

// 中心ハンドルでラジアルメニュー全体を移動する。previewMove は ctx.previewMove。
function startPreviewMove(e, ctx = currentCtx) {
  if (e.button !== 0) return; // 左のみ
  e.preventDefault();
  e.stopPropagation();
  const w = clientToWorld(e.clientX, e.clientY, ctx);
  ctx.previewMove = { ox: ctx.pvLeft, oy: ctx.pvTop, sx: w.x, sy: w.y };
  ctx._onPreviewMoveMove = (ev) => onPreviewMoveMove(ev, ctx);
  ctx._onPreviewMoveUp = () => onPreviewMoveUp(ctx);
  window.addEventListener("pointermove", ctx._onPreviewMoveMove);
  window.addEventListener("pointerup", ctx._onPreviewMoveUp);
}
function onPreviewMoveMove(e, ctx = currentCtx) {
  const previewMove = ctx.previewMove;
  if (!previewMove) return;
  const w = clientToWorld(e.clientX, e.clientY, ctx);
  ctx.pvLeft = previewMove.ox + (w.x - previewMove.sx);
  ctx.pvTop = previewMove.oy + (w.y - previewMove.sy);
  const host = ctx.el.preview;
  host.style.left = `${ctx.pvLeft}px`;
  host.style.top = `${ctx.pvTop}px`;
  scheduleConnectors(ctx);
}
function onPreviewMoveUp(ctx = currentCtx) {
  ctx.previewMove = null;
  if (ctx._onPreviewMoveMove)
    window.removeEventListener("pointermove", ctx._onPreviewMoveMove);
  if (ctx._onPreviewMoveUp)
    window.removeEventListener("pointerup", ctx._onPreviewMoveUp);
  ctx._onPreviewMoveMove = null;
  ctx._onPreviewMoveUp = null;
}

function onRadiusDragMove(e, ctx = currentCtx) {
  if (!ctx.radiusDrag) return;
  // カーソルの world 座標 → プレビュー中心からの距離 → 本番半径。
  const w = clientToWorld(e.clientX, e.clientY, ctx);
  const { cx, cy } = pvCenter(ctx);
  const dist = Math.hypot(w.x - cx, w.y - cy);
  const realR = dist / PV_SCALE; // 本番 px
  const p = profile(ctx);
  if (ctx.radiusDrag.which === "outer") {
    // 外周は内径+20 〜 OUTER_R_MAX の範囲。
    p.outer_r = Math.max((p.inner_r ?? 56) + 20, Math.min(OUTER_R_MAX, realR));
  } else {
    // 内径は 10 〜 外周-20 の範囲。
    p.inner_r = Math.max(10, Math.min((p.outer_r ?? 160) - 20, realR));
  }
  markDirty();
  renderPreview(ctx);
  scheduleConnectors(ctx);
}

function onRadiusDragUp(ctx = currentCtx) {
  ctx.radiusDrag = null;
  if (ctx._onRadiusDragMove)
    window.removeEventListener("pointermove", ctx._onRadiusDragMove);
  if (ctx._onRadiusDragUp)
    window.removeEventListener("pointerup", ctx._onRadiusDragUp);
  ctx._onRadiusDragMove = null;
  ctx._onRadiusDragUp = null;
}

// ── セグメントのドラッグ（色変更 or 別セグメントへドロップで位置交換） ──
// segDrag は ctx.segDrag。
function startSegDrag(e, index, opts = {}, ctx = currentCtx) {
  // 左ボタンのみ（色/配線/入替）。右はキャンバスへ通して右クリメニューに。
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  // セグメント中心角（mid）を覚えておく。配線演出の始点に使う。
  const segs = profile(ctx).segments;
  const slice = segs.length ? 360 / segs.length : 0;
  // 中心が真上起点（renderPreview と同じ）＋プロファイル回転。
  const mid = index * slice + (profile(ctx).rotation || 0);
  ctx.segDrag = {
    index,
    mid,
    sx: e.clientX,
    sy: e.clientY,
    moved: false,
    // ラベル始動なら、動かさず離したときはラベル編集にする。
    fromLabel: !!opts.fromLabel,
    lx: opts.lx,
    ly: opts.ly,
  };
  ctx._onSegDragMove = (ev) => onSegDragMove(ev, ctx);
  ctx._onSegDragUp = (ev) => onSegDragUp(ev, ctx);
  window.addEventListener("pointermove", ctx._onSegDragMove);
  window.addEventListener("pointerup", ctx._onSegDragUp);
}

function onSegDragMove(e, ctx = currentCtx) {
  const segDrag = ctx.segDrag;
  if (!segDrag) return;
  const dist = Math.hypot(e.clientX - segDrag.sx, e.clientY - segDrag.sy);
  if (dist > 5) segDrag.moved = true;
  if (segDrag.moved) {
    // ドロップ先候補のセグメントをハイライト（位置交換）。
    const over = segAtPoint(e.clientX, e.clientY, ctx);
    ctx.el.preview.querySelectorAll(".pv-seg.seg-drop").forEach((el) => {
      if (Number(el.dataset.index) !== over) el.classList.remove("seg-drop");
    });
    if (over !== null && over !== segDrag.index) {
      const el = ctx.el.preview.querySelector(`.pv-seg[data-index="${over}"]`);
      if (el) el.classList.add("seg-drop");
      // 交換元 → 交換先へ矢印。
      const fromEl = ctx.el.preview.querySelector(
        `.pv-seg[data-index="${segDrag.index}"]`,
      );
      showDragArrow(fromEl, el);
    } else {
      clearDragArrow();
    }

    // ノード（ブロック）上のハイライト（落とすと配線）。
    const dropped = nodeAtPoint(e.clientX, e.clientY, ctx);
    const overNode = dropped ? stackHeadOf(dropped, ctx) : null;
    ownAll(ctx, ".anode.link-target").forEach((el) => {
      if (el.dataset.id !== overNode) el.classList.remove("link-target");
    });
    if (overNode) {
      const el = ownOne(ctx, `.anode[data-id="${overNode}"]`);
      if (el) el.classList.add("link-target");
    }

    // ブロックへ向けてドラッグ中は、◯ドラッグと同じ仮配線を描く。
    // セグメント同士の入れ替え中（別セグメント上）は線を出さない。
    if (overNode || over === null || over === segDrag.index) {
      drawSegLinkWire(e, ctx);
    } else {
      clearSegLinkWire(ctx);
    }
  }
}

// セグメントのハンドル点 → カーソルへ、破線の仮配線を描く（配線演出）。
function drawSegLinkWire(e, ctx = currentCtx) {
  const svg = ctx.el.connectors;
  const segDrag = ctx.segDrag;
  if (!svg || !segDrag) return;
  clearSegLinkWire(ctx);
  // 始点はラジアルメニュー外周（本体）、出だしは外向き（mid 方向）。
  const sp = pvPolarCanvas(pvOuter(ctx), segDrag.mid, ctx);
  const w = clientToWorld(e.clientX, e.clientY, ctx);
  const rad = ((segDrag.mid - 90) * Math.PI) / 180;
  const lead = Math.max(30, Math.hypot(w.x - sp.x, w.y - sp.y) * 0.35);
  const c1x = sp.x + Math.cos(rad) * lead;
  const c1y = sp.y + Math.sin(rad) * lead;
  const c2x = (c1x + w.x) / 2;
  const line = document.createElementNS(SVG_NS, "path");
  line.setAttribute(
    "d",
    `M ${sp.x} ${sp.y} C ${c1x} ${c1y}, ${c2x} ${w.y}, ${w.x} ${w.y}`,
  );
  line.setAttribute("class", "connector linking");
  line.setAttribute("id", "seg-link-wire");
  svg.appendChild(line);
}
function clearSegLinkWire(ctx = currentCtx) {
  const old = (ctx.el.connectors || document).querySelector("#seg-link-wire");
  if (old) old.remove();
}

function onSegDragUp(e, ctx = currentCtx) {
  const segDrag = ctx.segDrag;
  if (!segDrag) return;
  if (ctx._onSegDragMove)
    window.removeEventListener("pointermove", ctx._onSegDragMove);
  if (ctx._onSegDragUp)
    window.removeEventListener("pointerup", ctx._onSegDragUp);
  ctx._onSegDragMove = null;
  ctx._onSegDragUp = null;
  const { index, moved, fromLabel, lx, ly } = segDrag;
  ctx.segDrag = null;
  clearSegLinkWire(ctx);
  clearDragArrow();
  ctx.el.preview
    .querySelectorAll(".pv-seg.seg-drop")
    .forEach((el) => el.classList.remove("seg-drop"));
  ownAll(ctx, ".anode.link-target").forEach((el) => el.classList.remove("link-target"));

  if (!moved) {
    // 動かしていない＝クリック扱い。ラベル始動ならラベル編集、
    // セグメント本体始動なら色変更（ピッカーはカーソル近くに出す）。
    if (fromLabel) editLabelInline(index, lx, ly, ctx);
    else openColorPicker(index, ctx, e.clientX, e.clientY);
    return;
  }

  // ① ノード（ブロック）の上で離したら配線する。
  const dropped = nodeAtPoint(e.clientX, e.clientY, ctx);
  const overNode = dropped ? stackHeadOf(dropped, ctx) : null;
  if (overNode) {
    const p = profile(ctx);
    // 1ノード1接続元。そのノードを指す既存の接続元（他セグメント/スロット）を外す。
    clearLinksTo(overNode, ctx);
    p.segments[index].head = overNode;
    markDirty();
    render(ctx);
    return;
  }

  // ② 別セグメントの上で離したら位置交換（head 接続も一緒に移動）。
  const target = segAtPoint(e.clientX, e.clientY, ctx);
  if (target !== null && target !== index) {
    const segs = profile(ctx).segments;
    [segs[index], segs[target]] = [segs[target], segs[index]];
    markDirty();
    render(ctx);
    return;
  }

  // ③ 何もない所で離したら、そこに新規ノードを作ってこのセグメントに配線。
  //    プレビュー本体（パイ・ハブ・ハンドル類）の上なら作らない。
  const onPreview = e.target.closest(
    ".pv-seg, .pv-label, .pv-label-bg, .pv-hub, " +
      ".pv-move-handle, .pv-outer-handle, .pv-handle-hit, .pv-rotate-handle",
  );
  if (target === null && !onPreview) {
    const p = profile(ctx);
    const id = newNodeId(ctx);
    const w = clientToWorld(e.clientX, e.clientY, ctx);
    p.nodes.push({
      id,
      type: "key",
      value: "",
      x: w.x - 16, // カーソル位置がノードの左端◯あたりに来るよう少し左へ
      y: w.y - 14,
      next: null,
    });
    // 1ノード1セグメント。既存の同 head を外してから繋ぐ。
    p.segments.forEach((s, i) => {
      if (i !== index && s.head === id) s.head = null;
    });
    p.segments[index].head = id;
    markDirty();
    render(ctx);
    return;
  }

  render(ctx);
}

// 画面座標にあるセグメント(path.pv-seg)の index を返す（なければ null）。
// 別面（内包）の pv-seg を拾わないよう、この面の preview 内に限定。
function segAtPoint(clientX, clientY, ctx = currentCtx) {
  const els = document.elementsFromPoint(clientX, clientY);
  for (const el of els) {
    if (
      el.classList &&
      el.classList.contains("pv-seg") &&
      ownsInPreview(ctx, el)
    ) {
      return Number(el.dataset.index);
    }
  }
  return null;
}

// ── プレビュー直接編集（色・ラベル） ──────────────────────────────
// セグメント色を編集する。ネイティブの <input type=color> ダイアログは
// 表示位置が OS 任せ（左上等）で制御できないため、カーソル近くに出す自前の
// ポップアップ（プリセット色＋詳細用ネイティブ入力）を使う。
let colorPopupEl = null;
function closeColorPopup() {
  if (colorPopupEl) {
    colorPopupEl.remove();
    colorPopupEl = null;
  }
  window.removeEventListener("pointerdown", onColorPopupOutside, true);
  window.removeEventListener("keydown", onColorPopupKey, true);
}
function onColorPopupOutside(e) {
  if (colorPopupEl && !colorPopupEl.contains(e.target)) closeColorPopup();
}
function onColorPopupKey(e) {
  if (e.key === "Escape") closeColorPopup();
}

function openColorPicker(index, ctx = currentCtx, clientX, clientY) {
  const seg = profile(ctx).segments[index];
  if (!seg) return;
  closeColorPopup();

  const apply = (hex) => {
    seg.color = hex;
    seg.customColor = true; // 手動色は項目数変更でも振り直さない
    markDirty();
    render(ctx);
  };

  const pop = document.createElement("div");
  pop.className = "color-popup";
  // クリックが親キャンバスへ伝播してパン/選択を始めないように。
  pop.addEventListener("pointerdown", (e) => e.stopPropagation());

  // プリセット色（ムーテッドパレット）をグリッドで。クリックで即適用。
  const grid = document.createElement("div");
  grid.className = "color-grid";
  DEFAULT_COLORS.forEach((c) => {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "color-sw";
    sw.style.background = c;
    sw.addEventListener("click", () => {
      apply(c);
      closeColorPopup();
    });
    grid.appendChild(sw);
  });
  pop.appendChild(grid);

  // 詳細（任意の色）。ネイティブ入力。ダイアログ位置は OS 任せだが、
  // ここを押したときだけ開く（普段はプリセットで済む）。
  const more = document.createElement("label");
  more.className = "color-more";
  more.textContent = "詳細…";
  const input = document.createElement("input");
  input.type = "color";
  input.value = /^#[0-9a-f]{6}/i.test(seg.color || "")
    ? seg.color.slice(0, 7)
    : "#888888";
  input.addEventListener("input", () => apply(input.value));
  more.appendChild(input);
  pop.appendChild(more);

  document.body.appendChild(pop);
  // カーソル近くに配置（画面端で見切れないようクランプ）。
  const r = pop.getBoundingClientRect();
  let x = Number.isFinite(clientX) ? clientX + 6 : window.innerWidth / 2;
  let y = Number.isFinite(clientY) ? clientY + 6 : window.innerHeight / 2;
  if (x + r.width > window.innerWidth - 6) x = window.innerWidth - 6 - r.width;
  if (y + r.height > window.innerHeight - 6)
    y = window.innerHeight - 6 - r.height;
  pop.style.left = `${Math.max(6, x)}px`;
  pop.style.top = `${Math.max(6, y)}px`;
  colorPopupEl = pop;
  setTimeout(() => {
    window.addEventListener("pointerdown", onColorPopupOutside, true);
    window.addEventListener("keydown", onColorPopupKey, true);
  }, 0);
}

// ラベルを改行("\n")対応で SVG <text> に流し込む（main.js と同じ作り）。
// 複数行は <tspan> を縦に並べ、ブロック中心が text の y に来るよう先頭行を
// 半分持ち上げる（dominant-baseline:central 前提）。
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
    ts.textContent = line || " "; // 空行でも行送りを保つ
    text.appendChild(ts);
  });
}

function editLabelInline(index, svgX, svgY, ctx = currentCtx) {
  const preview = ctx.el.preview;
  const seg = profile(ctx).segments[index];
  if (!seg) return;
  const pvSvg = preview.querySelector("svg");
  if (!pvSvg) return;
  // 入力欄は preview に position:absolute で置く。preview は world の中にあり
  // scale(zoom) が掛かっているため、座標は「スケール前の preview ローカル px」で
  // 指定する必要がある。SVG は width=PV_SIZE / viewBox 一致なので、SVG ローカル
  // 座標(svgX,svgY)はそのまま preview ローカル px と一致する（換算不要）。
  // getBoundingClientRect は画面 px を返し二重スケールでズレるので使わない。
  const left = svgX;
  const top = svgY;

  // 改行できるよう textarea（Shift+Enter=改行 / Enter=確定 / Esc=取消）。
  const input = document.createElement("textarea");
  input.className = "pv-label-edit";
  input.rows = 1;
  // 手動ラベルのみ表示（空なら自動命名中＝未設定として空欄で出す）。
  input.value = seg.label || "";
  input.placeholder = "未設定（接続内容から自動）";
  input.title = "Shift+Enter で改行";
  input.style.left = `${left}px`;
  input.style.top = `${top}px`;
  preview.appendChild(input);
  // 行数に合わせて高さを追従（1行なら従来の見た目のまま）。
  const autoRows = () => {
    input.rows = Math.max(1, input.value.split("\n").length);
  };
  autoRows();
  input.addEventListener("input", autoRows);
  input.focus();
  input.select();

  const commit = () => {
    // 空にすると「未設定」＝自動命名モードへ戻る（label を空に）。
    // trim は前後のみ＝途中の改行は保持される。
    seg.label = input.value.trim();
    markDirty();
    input.remove();
    renderPreview(ctx);
    // メニューブロック（▼横の名前）もセグメント名と連動するので更新する。
    renderNodes(ctx);
    scheduleConnectors(ctx);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.remove();
    }
    // Shift+Enter は既定動作＝改行挿入。
  });
  input.addEventListener("blur", commit);
}

// ── 項目数（セグメント数）スライダー ──────────────────────────────
// 項目数を減らして消えたセグメント（色・配線・ラベル）をプロファイル別に
// 覚えておく置き場。再び増やしたとき良い塩梅で復元する（セッション内）。
const segStash = new Map(); // profile id → セグメント snapshot 配列（index 別）

function stashSegments(p) {
  // キーは p.id ではなくデータオブジェクト自身（サブメニューは id を持たず、
  // p.id=undefined で衝突するため）。Map はオブジェクトキー可。
  let arr = segStash.get(p);
  if (!arr) {
    arr = [];
    segStash.set(p, arr);
  }
  // 現在のセグメントを index 位置に記録（最新を正とする）。
  p.segments.forEach((s, i) => {
    arr[i] = JSON.parse(JSON.stringify(s));
  });
}

// 既定色（ユーザーが変更していない）のセグメントを、現在の項目数に合わせて
// 色相を均等に振り直す。手動で色を付けたもの（customColor）は触らない。
function respaceDefaultColors(p) {
  const n = p.segments.length;
  p.segments.forEach((s, i) => {
    if (!s.customColor) s.color = defaultColorFor(i, n);
  });
}

function setSegmentCount(n, ctx = currentCtx) {
  n = Math.max(1, Math.min(8, n));
  const p = profile(ctx);
  const cur = p.segments.length;
  if (n === cur) return;

  // 変更前に今の状態を覚える（減らす前の色・配線・ラベルを保持）。
  stashSegments(p);
  const stash = segStash.get(p) || [];

  if (n > cur) {
    for (let i = cur; i < n; i++) {
      // 以前その位置にあったセグメントがあれば良い塩梅で復元、無ければ既定。
      const remembered = stash[i];
      if (remembered) {
        p.segments.push(JSON.parse(JSON.stringify(remembered)));
      } else {
        p.segments.push({
          label: "",
          color: defaultColorFor(i, n),
          head: null,
        });
      }
    }
  } else {
    p.segments.length = n; // 末尾セグメントを削る（ノード・stash は残す）
  }
  // ユーザーが色変更していないセグメントは、新しい項目数に合わせて色相を
  // 振り直す（円周で隣が同系色にならないように）。
  respaceDefaultColors(p);
  markDirty();
  render(ctx);
}

// ── クイックスロット（左/中クリック・ホイール上下） ───────────────
const QUICK_LABELS = {
  left: "左クリック",
  middle: "中クリック",
  wheel_up: "ホイール上",
  wheel_down: "ホイール下",
};
// マウス絵＋4行（本番 HUD と同じ見た目）の1パネルとして描く。
// 行の並び（上から）: 左クリック / 中クリック / ホイール上 / ホイール下。
const QUICK_ORDER = ["left", "middle", "wheel_up", "wheel_down"];
function renderQuickSlots(ctx = currentCtx) {
  const host = ctx.el.nodes;
  // この面の qpanel のみ削除（子面のは消さない＝直接子に限定）。
  host.querySelectorAll(":scope > .qpanel").forEach((el) => el.remove());
  const p = profile(ctx);
  const slots = p.quick_slots || [];
  if (slots.length === 0) return;
  const byKind = (k) => slots.find((s) => s.kind === k);
  // パネル基準位置は先頭行（左クリック、無ければ配列先頭）の x/y。
  const base = byKind("left") || slots[0];

  const panel = document.createElement("div");
  panel.className = "qpanel";
  panel.style.left = `${base.x ?? 40}px`;
  panel.style.top = `${base.y ?? 300}px`;
  panel.dataset.tip = "右クリックを押しながら\nこれらの操作をした時の挙動";
  panel.dataset.tipAnchor = "element"; // パネルの上（or下）に固定表示
  // 触った順の重なり（ノード/アプリと同じ扱い）。これが無いと z-index 未設定
  // のままになり、一度でも触った大きなメニューブロック等に完全に隠れて
  // 「パネルが見えない」状態になる。
  applyBlockZ(panel, "qpanel");
  panel.addEventListener(
    "pointerdown",
    () => bringBlockToFront(panel, "qpanel"),
    true,
  );
  // 枠（マウス絵・ラベル）を掴んでパネルごとドラッグ。◯・ボタンは除外。
  // 左ボタンのみ。右ボタンはキャンバスへ通してナイフ/右クリメニューに。
  panel.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".qslot-port, .qpanel-toggle, .qslot-label, input"))
      return;
    startQuickPanelDrag(e, ctx);
  });

  // 本番メニューでこのパネルを表示するかのトグル（左上）。
  const visOn = p.quick_hud_visible !== false; // 既定 ON
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "qpanel-toggle" + (visOn ? " on" : "");
  toggle.textContent = "表示";
  toggle.dataset.tip = "メニュー表示時にこのパネルも表示するかどうか";
  toggle.dataset.tipAnchor = "element";
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    p.quick_hud_visible = !visOn;
    markDirty();
    render(ctx);
  });
  panel.appendChild(toggle);

  // 本体（マウス絵＋4行を横並び）。
  const body = document.createElement("div");
  body.className = "qpanel-body";

  // 左：マウス絵。
  const mouse = document.createElement("div");
  mouse.className = "qpanel-mouse";
  mouse.innerHTML =
    `<svg viewBox="0 0 50 76" width="44" height="66">` +
    `<rect x="6" y="3" width="38" height="70" rx="19" fill="none" stroke="currentColor" stroke-width="2.5"/>` +
    `<line x1="25" y1="5" x2="25" y2="34" stroke="currentColor" stroke-width="1.6"/>` +
    `<rect x="21" y="13" width="8" height="15" rx="4" fill="currentColor"/>` +
    `</svg>`;
  body.appendChild(mouse);

  // 右：4行。
  const rows = document.createElement("div");
  rows.className = "qpanel-rows";
  QUICK_ORDER.forEach((kind) => {
    const slot = byKind(kind);
    if (!slot) return;
    const idx = slots.indexOf(slot);
    const row = document.createElement("div");
    row.className = "qpanel-row";
    row.dataset.qkind = kind;

    const name = document.createElement("span");
    name.className = "qslot-name";
    name.textContent = QUICK_LABELS[kind] || kind;
    row.appendChild(name);

    // 手動ラベル（本番 HUD に表示する名前）。クリックでインライン編集。
    // 空なら接続内容から自動命名（セグメントと同じ流儀）、未接続は「未設定」。
    // autoSegName は head を辿るだけなのでスロットをそのまま渡せる。
    const manual = (slot.label || "").trim();
    const lab = document.createElement("span");
    lab.className = "qslot-label" + (manual ? "" : " auto");
    lab.textContent = manual || autoSegName(slot, ctx);
    lab.dataset.tip = "本番メニューでこの操作に出す名前\nクリックで変更";
    lab.dataset.tipAnchor = "element";
    lab.addEventListener("pointerdown", (e) => e.stopPropagation());
    lab.addEventListener("click", (e) => {
      e.stopPropagation();
      editQuickLabelInline(idx, lab, ctx);
    });
    row.appendChild(lab);

    // 配線用◯ポート（行の右端）。
    const port = document.createElement("span");
    port.className = "qslot-port";
    if (slot.head) port.classList.add("linked");
    port.addEventListener("pointerdown", (e) =>
      startQuickLinkDrag(e, idx, ctx),
    );
    port.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (slot.head) {
        slot.head = null;
        markDirty();
        render(ctx);
      }
    });
    row.appendChild(port);
    rows.appendChild(row);
  });
  body.appendChild(rows);
  panel.appendChild(body);

  host.appendChild(panel);
}

// クイックスロットのラベルをその場で編集する（span を input に差し替え）。
// Enter/フォーカス外れ=確定、Esc=取消。空にすると自動命名（未接続は「未設定」）
// に戻る。
function editQuickLabelInline(slotIndex, labEl, ctx = currentCtx) {
  const slot = (profile(ctx).quick_slots || [])[slotIndex];
  if (!slot) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "qslot-label-edit";
  input.value = slot.label || "";
  input.placeholder = "未設定";
  input.addEventListener("pointerdown", (e) => e.stopPropagation());
  labEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    slot.label = input.value.trim();
    markDirty();
    render(ctx);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      done = true;
      render(ctx); // 描き直しで span に戻す
    }
  });
  input.addEventListener("blur", commit);
}

// クイックパネル全体のドラッグ移動（4スロットの x/y を同じ量だけ動かす）。
// quickDrag は ctx.quickDrag。
function startQuickPanelDrag(e, ctx = currentCtx) {
  e.preventDefault();
  const slots = profile(ctx).quick_slots || [];
  const w = clientToWorld(e.clientX, e.clientY, ctx);
  ctx.quickDrag = {
    sx: w.x,
    sy: w.y,
    orig: slots.map((s) => ({ s, ox: s.x ?? 0, oy: s.y ?? 0 })),
  };
  ctx._onQuickDragMove = (ev) => onQuickDragMove(ev, ctx);
  ctx._onQuickDragUp = () => onQuickDragUp(ctx);
  window.addEventListener("pointermove", ctx._onQuickDragMove);
  window.addEventListener("pointerup", ctx._onQuickDragUp);
}
function onQuickDragMove(e, ctx = currentCtx) {
  const quickDrag = ctx.quickDrag;
  if (!quickDrag) return;
  const w = clientToWorld(e.clientX, e.clientY, ctx);
  const dx = w.x - quickDrag.sx;
  const dy = w.y - quickDrag.sy;
  quickDrag.orig.forEach(({ s, ox, oy }) => {
    s.x = ox + dx;
    s.y = oy + dy;
  });
  const base =
    (profile(ctx).quick_slots || []).find((s) => s.kind === "left") ||
    (profile(ctx).quick_slots || [])[0];
  const panel = ownOne(ctx, ".qpanel");
  if (panel && base) {
    panel.style.left = `${base.x}px`;
    panel.style.top = `${base.y}px`;
  }
  scheduleConnectors(ctx);
}
function onQuickDragUp(ctx = currentCtx) {
  ctx.quickDrag = null;
  if (ctx._onQuickDragMove)
    window.removeEventListener("pointermove", ctx._onQuickDragMove);
  if (ctx._onQuickDragUp)
    window.removeEventListener("pointerup", ctx._onQuickDragUp);
  ctx._onQuickDragMove = null;
  ctx._onQuickDragUp = null;
  markDirty();
}

// クイックスロットの◯ → ノードへ配線するドラッグ。quickLink は ctx.quickLink。
function startQuickLinkDrag(e, idx, ctx = currentCtx) {
  if (e.button !== 0) return; // 左のみ。右クリックは配線削除（contextmenu）に任せる。
  e.preventDefault();
  e.stopPropagation();
  ctx.quickLink = { idx };
  ctx._onQuickLinkMove = (ev) => onQuickLinkMove(ev, ctx);
  ctx._onQuickLinkUp = (ev) => onQuickLinkUp(ev, ctx);
  window.addEventListener("pointermove", ctx._onQuickLinkMove);
  window.addEventListener("pointerup", ctx._onQuickLinkUp);
}
function onQuickLinkMove(e, ctx = currentCtx) {
  const quickLink = ctx.quickLink;
  if (!quickLink) return;
  drawConnectors(ctx);
  const svg = ctx.el.connectors;
  const sp = quickPortPos(quickLink.idx, ctx);
  if (!sp) return;
  const w = clientToWorld(e.clientX, e.clientY, ctx);
  const cx = (sp.x + w.x) / 2;
  const line = document.createElementNS(SVG_NS, "path");
  line.setAttribute(
    "d",
    `M ${sp.x} ${sp.y} C ${cx} ${sp.y}, ${cx} ${w.y}, ${w.x} ${w.y}`,
  );
  line.setAttribute("class", "connector linking");
  svg.appendChild(line);

  // 別のクイックポートの上なら、そのポートを強調（つけかえ先）。
  const overPortIdx = quickPortAtPoint(e.clientX, e.clientY, ctx);
  ownAll(ctx, ".qslot-port.link-target").forEach((el) =>
    el.classList.remove("link-target"),
  );
  if (overPortIdx != null && overPortIdx !== quickLink.idx) {
    const tslot = (profile(ctx).quick_slots || [])[overPortIdx];
    const pel = tslot
      ? ownQpanelRow(ctx, `.qpanel-row[data-qkind="${tslot.kind}"] .qslot-port`)
      : null;
    if (pel) pel.classList.add("link-target");
    ownAll(ctx, ".anode.link-target").forEach((el) =>
      el.classList.remove("link-target"),
    );
    return;
  }

  const dropped = nodeAtPoint(e.clientX, e.clientY, ctx);
  const overId = dropped ? stackHeadOf(dropped, ctx) : null;
  ownAll(ctx, ".anode.link-target").forEach((el) => {
    if (el.dataset.id !== overId) el.classList.remove("link-target");
  });
  if (overId) {
    const el = ownOne(ctx, `.anode[data-id="${overId}"]`);
    if (el) el.classList.add("link-target");
  }
}
function onQuickLinkUp(e, ctx = currentCtx) {
  const quickLink = ctx.quickLink;
  if (!quickLink) return;
  if (ctx._onQuickLinkMove)
    window.removeEventListener("pointermove", ctx._onQuickLinkMove);
  if (ctx._onQuickLinkUp)
    window.removeEventListener("pointerup", ctx._onQuickLinkUp);
  ctx._onQuickLinkMove = null;
  ctx._onQuickLinkUp = null;
  const p = profile(ctx);
  const slot = p.quick_slots[quickLink.idx];

  // 別のクイックポート◯の上で離した → 配線をそのポートへ「つけかえ」。
  // （左クリック◯ → 中クリック◯ にドラッグ、など）。元ポートに接続が
  // あるときだけ移す（空ポートからのドラッグでは何もしない）。
  const overPortIdx = quickPortAtPoint(e.clientX, e.clientY, ctx);
  if (
    slot &&
    slot.head &&
    overPortIdx != null &&
    overPortIdx !== quickLink.idx
  ) {
    const target = p.quick_slots[overPortIdx];
    if (target) {
      // 元ポートの接続先を相手ポートへ移し、元は切断（つけかえ）。
      target.head = slot.head;
      slot.head = null;
      markDirty();
    }
    ctx.quickLink = null;
    ownAll(ctx, ".anode.link-target, .qslot-port.link-target").forEach((el) =>
      el.classList.remove("link-target"),
    );
    render(ctx);
    return;
  }

  const dropped = nodeAtPoint(e.clientX, e.clientY, ctx);
  const overId = dropped ? stackHeadOf(dropped, ctx) : null;
  ctx.quickLink = null;
  if (slot && overId) {
    // 既存ノードに落とした → 配線。1ノード1接続元なので既存の接続元を外す。
    clearLinksTo(overId, ctx);
    slot.head = overId;
    markDirty();
  } else if (slot && !overId) {
    // 何もない所に落とした → 新規ノードを作って配線（セグメントと同じ挙動）。
    // 自分のパネル・プレビュー上は除く。
    const onSelf = e.target.closest(
      ".qpanel, .pv-seg, .pv-label, .pv-label-bg, .pv-hub, " +
        ".pv-move-handle, .pv-outer-handle, .pv-handle-hit, .pv-rotate-handle",
    );
    if (!onSelf) {
      const id = newNodeId(ctx);
      const w = clientToWorld(e.clientX, e.clientY, ctx);
      p.nodes.push({
        id,
        type: "key",
        value: "",
        x: w.x - 16,
        y: w.y - 14,
        next: null,
      });
      slot.head = id;
      markDirty();
    }
  }
  ownAll(ctx, ".anode.link-target").forEach((el) => el.classList.remove("link-target"));
  render(ctx);
}
// 画面座標 (clientX/Y) の下にあるクイックポート◯の quick_slots index を返す。
// この面（ctx）のポートに限定（子面のは拾わない）。無ければ null。
function quickPortAtPoint(clientX, clientY, ctx = currentCtx) {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return null;
  const port = el.closest && el.closest(".qslot-port");
  if (!port) return null;
  // この面の qpanel 配下のポートか確認（子面のポートを誤検出しない）。
  const row = port.closest(".qpanel-row");
  if (!row || row.closest(".qpanel") !== ownOne(ctx, ".qpanel")) return null;
  const kind = row.dataset.qkind;
  const slots = profile(ctx).quick_slots || [];
  const idx = slots.findIndex((s) => s.kind === kind);
  return idx >= 0 ? idx : null;
}

// クイックスロットの◯ポート中心（world 座標）。idx は quick_slots の index。
function quickPortPos(idx, ctx = currentCtx) {
  const slot = (profile(ctx).quick_slots || [])[idx];
  if (!slot) return null;
  const row = ownQpanelRow(
    ctx,
    `.qpanel-row[data-qkind="${slot.kind}"] .qslot-port`,
  );
  if (!row) return null;
  const r = row.getBoundingClientRect();
  return clientToWorld(r.left + r.width / 2, r.top + r.height / 2, ctx);
}

// ── 初期アクションパネル（ルート面のみ） ──────────────────────────
// パイ表示の瞬間に実行するアクションの配線口。マウスパネル風の1行パネル。
// ここに「特殊キー(Ctrl押す)」を繋ぐと、開いた瞬間に Ctrl 押しっぱなしになり、
// 離してキー送出する頃には修飾キー処理が済んで 1F で反映される。
function renderInitialPanel(ctx = currentCtx) {
  const host = ctx.el.nodes;
  host.querySelectorAll(":scope > .initial-panel").forEach((el) => el.remove());
  // ルート面のみ（子/孫サブメニューには出さない）。
  if (ctx.parentCtx) return;
  const p = profile(ctx);
  // 既定位置（未設定=0,0 のとき）はパイの右上あたり。
  if (!p.initial_x && !p.initial_y) {
    p.initial_x = -320;
    p.initial_y = 120;
  }

  const panel = document.createElement("div");
  panel.className = "initial-panel";
  panel.dataset.tip = "パイを開いた瞬間に実行するアクションを繋ぎます";
  panel.dataset.tipAnchor = "element";
  panel.style.left = `${p.initial_x}px`;
  panel.style.top = `${p.initial_y}px`;
  applyBlockZ(panel, "initial");
  panel.addEventListener(
    "pointerdown",
    () => bringBlockToFront(panel, "initial"),
    true,
  );
  // 枠を掴んでパネル移動（◯は除外）。左ボタンのみ。
  panel.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".qslot-port")) return;
    startInitialPanelDrag(e, ctx);
  });

  const label = document.createElement("span");
  label.className = "initial-label";
  label.textContent = "最初に実行";

  const port = document.createElement("span");
  port.className = "qslot-port initial-port";
  if (p.initial_head) port.classList.add("linked");
  port.addEventListener("pointerdown", (e) => startInitialLinkDrag(e, ctx));
  port.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (p.initial_head) {
      p.initial_head = null;
      markDirty();
      render(ctx);
    }
  });

  panel.append(label, port);
  host.appendChild(panel);
}

// 初期パネルの◯ポート中心（world 座標）。
function initialPortPos(ctx = currentCtx) {
  const port = ctx.el.nodes.querySelector(":scope > .initial-panel .initial-port");
  if (!port) return null;
  const r = port.getBoundingClientRect();
  return clientToWorld(r.left + r.width / 2, r.top + r.height / 2, ctx);
}

// 初期パネルのドラッグ移動。
function startInitialPanelDrag(e, ctx = currentCtx) {
  e.preventDefault();
  const p = profile(ctx);
  const w = clientToWorld(e.clientX, e.clientY, ctx);
  const drag = { ox: p.initial_x || 0, oy: p.initial_y || 0, sx: w.x, sy: w.y };
  const move = (ev) => {
    const nw = clientToWorld(ev.clientX, ev.clientY, ctx);
    p.initial_x = drag.ox + (nw.x - drag.sx);
    p.initial_y = drag.oy + (nw.y - drag.sy);
    const el = ctx.el.nodes.querySelector(":scope > .initial-panel");
    if (el) {
      el.style.left = `${p.initial_x}px`;
      el.style.top = `${p.initial_y}px`;
    }
    scheduleConnectors(ctx);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    markDirty();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// 初期パネルの◯からノードへ配線（クイックスロットの簡易版）。
function startInitialLinkDrag(e, ctx = currentCtx) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  ctx.initialLink = true;
  const move = (ev) => {
    drawConnectors(ctx);
    const svg = ctx.el.connectors;
    const sp = initialPortPos(ctx);
    if (!sp) return;
    const w = clientToWorld(ev.clientX, ev.clientY, ctx);
    const cx = (sp.x + w.x) / 2;
    const line = document.createElementNS(SVG_NS, "path");
    line.setAttribute(
      "d",
      `M ${sp.x} ${sp.y} C ${cx} ${sp.y}, ${cx} ${w.y}, ${w.x} ${w.y}`,
    );
    line.setAttribute("class", "connector linking");
    svg.appendChild(line);
    const dropped = nodeAtPoint(ev.clientX, ev.clientY, ctx);
    const overId = dropped ? stackHeadOf(dropped, ctx) : null;
    ownAll(ctx, ".anode.link-target").forEach((el) => {
      if (el.dataset.id !== overId) el.classList.remove("link-target");
    });
    if (overId) {
      const el = ownOne(ctx, `.anode[data-id="${overId}"]`);
      if (el) el.classList.add("link-target");
    }
  };
  const up = (ev) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    ctx.initialLink = false;
    const p = profile(ctx);
    const dropped = nodeAtPoint(ev.clientX, ev.clientY, ctx);
    const overId = dropped ? stackHeadOf(dropped, ctx) : null;
    if (overId) {
      clearLinksTo(overId, ctx);
      p.initial_head = overId;
      markDirty();
    } else {
      // 何もない所 → 新規ノードを作って配線（特殊キーの雛形にしておく）。
      const onSelf = e.target.closest(".initial-panel");
      const onPie = ev.target.closest(
        ".pv-seg, .pv-label, .pv-label-bg, .pv-hub, .pv-move-handle, " +
          ".pv-outer-handle, .pv-handle-hit, .pv-rotate-handle, .qpanel",
      );
      if (!onSelf && !onPie) {
        const id = newNodeId(ctx);
        const w = clientToWorld(ev.clientX, ev.clientY, ctx);
        p.nodes.push({
          id,
          type: "special",
          value: "",
          mods: [],
          clicks: [],
          release: false,
          x: w.x - 16,
          y: w.y - 14,
          next: null,
        });
        p.initial_head = id;
        markDirty();
      }
    }
    ownAll(ctx, ".anode.link-target").forEach((el) =>
      el.classList.remove("link-target"),
    );
    render(ctx);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ── 右クリック対象アプリ ──────────────────────────────────────────
// 対象アプリをキャンバス上のパネルとして描く（ノードと同じく自由配置）。
function renderApps(ctx = currentCtx) {
  const host = ctx.el.nodes;
  // ノードは renderNodes が描く。app パネルは末尾に追加する。
  const p = profile(ctx);
  // 既存の app パネルを消す（renderNodes は .anode のみ追加するので、
  // .app-node を別途クリア）。この面の直接子のみ（子面のは消さない）。
  host.querySelectorAll(":scope > .app-node").forEach((el) => el.remove());

  p.app_nodes.forEach((app, index) => {
    const el = document.createElement("div");
    el.className = "app-node";
    el.dataset.tip =
      "対象アプリを指定\nこのブロックがあるだけで設定OK\n複数のブロックOK";
    el.dataset.tipAnchor = "element";
    // enabled 未定義（旧データ）は有効扱い。無効なら薄く表示。
    const enabled = app.enabled !== false;
    if (!enabled) el.classList.add("is-disabled");
    el.style.left = `${app.x ?? 360}px`;
    el.style.top = `${app.y ?? 360}px`;
    // 触った順の重なり（アプリブロックも同様）。キーは index ベース。
    const appKey = `app:${index}`;
    applyBlockZ(el, appKey);
    el.addEventListener(
      "pointerdown",
      () => bringBlockToFront(el, appKey),
      true,
    );

    // ドラッグ移動（入力欄・ボタン以外を掴む）。左のみ（右はキャンバスへ）。
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("input, button")) return;
      startAppDrag(e, index, ctx);
    });

    // アプリ名部分。ドラッグで移動、ドラッグせずクリックで対象アプリ取得。
    const capBtn = document.createElement("button");
    capBtn.type = "button";
    capBtn.className = "app-capture";
    capBtn.textContent = app.name || "対象アプリ指定";
    if (!app.name) capBtn.classList.add("empty");
    // pointerdown で移動ドラッグを開始（動かさず離せば click で取得）。
    capBtn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      startAppDrag(e, index, ctx);
    });
    capBtn.addEventListener("click", () => {
      if (ctx.appDragMoved) return; // ドラッグ移動した直後はクリック扱いにしない
      captureAppForNode(index, capBtn, ctx);
    });

    // 有効/無効トグル。無効にすると右クリック対象から外れる。
    const toggle = document.createElement("button");
    toggle.className = "app-toggle";
    toggle.type = "button";
    toggle.textContent = enabled ? "オン" : "オフ";
    if (!enabled) toggle.classList.add("off");
    toggle.addEventListener("click", () => {
      app.enabled = !enabled;
      markDirty();
      render(ctx);
    });

    // 除外タブ追加。クリック→カウントダウン→前面窓のタイトルを取得して追加。
    const exAdd = document.createElement("button");
    exAdd.className = "app-exclude-add";
    exAdd.type = "button";
    exAdd.textContent = "除外＋";
    exAdd.dataset.tip =
      "タイトルにこの文字列を含むタブ/窓では\nメニューを出さない";
    exAdd.dataset.tipAnchor = "element";
    exAdd.addEventListener("click", () => {
      captureExcludeTitle(index, exAdd, ctx);
    });

    // 1行目: アプリ名 → トグル → 除外追加（削除ボタンは廃止＝Del/コピペで代替）。
    const mainRow = document.createElement("div");
    mainRow.className = "app-row";
    mainRow.append(capBtn, toggle, exAdd);
    el.appendChild(mainRow);

    // 除外タブ（タイトル一部一致）の一覧。手編集も可。
    if (!Array.isArray(app.exclude_titles)) app.exclude_titles = [];
    app.exclude_titles.forEach((t, ti) => {
      const row = document.createElement("div");
      row.className = "app-exclude-row";
      const mark = document.createElement("span");
      mark.className = "app-exclude-mark";
      mark.textContent = "🚫";
      const input = document.createElement("input");
      input.type = "text";
      input.value = t;
      input.placeholder = "タイトルの一部";
      input.addEventListener("input", () => {
        app.exclude_titles[ti] = input.value;
        markDirty();
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "app-exclude-del";
      del.textContent = "✕";
      del.addEventListener("click", () => {
        app.exclude_titles.splice(ti, 1);
        markDirty();
        render(ctx);
      });
      row.append(mark, input, del);
      el.appendChild(row);
    });

    host.appendChild(el);
  });
}

// アプリパネルのドラッグ移動。appDrag / appDragMoved は ctx ごと。
function startAppDrag(e, index, ctx = currentCtx) {
  e.preventDefault();
  const app = profile(ctx).app_nodes[index];
  if (!app) return;
  ctx.appDragMoved = false;

  // 選択中アプリを掴み、かつ複数選択中なら一括ドラッグ。
  if (ctx.selApps.has(app) && selectionCount(ctx) > 1) {
    startGroupDrag(e, ctx);
    return;
  }
  // 非選択を単独で掴んだら選択を解除。
  if (!ctx.selApps.has(app)) {
    clearSelection(ctx);
    applySelectionClasses(ctx);
  }
  const w = clientToWorld(e.clientX, e.clientY, ctx);
  ctx.appDrag = {
    index,
    ox: app.x ?? 0,
    oy: app.y ?? 0,
    sx: w.x,
    sy: w.y,
    cx: e.clientX,
    cy: e.clientY,
  };
  ctx._onAppDragMove = (ev) => onAppDragMove(ev, ctx);
  ctx._onAppDragUp = () => onAppDragUp(ctx);
  window.addEventListener("pointermove", ctx._onAppDragMove);
  window.addEventListener("pointerup", ctx._onAppDragUp);
}
function onAppDragMove(e, ctx = currentCtx) {
  const appDrag = ctx.appDrag;
  if (!appDrag) return;
  // 数px以上動いたら「移動」とみなす（クリック取得と区別）。
  if (Math.hypot(e.clientX - appDrag.cx, e.clientY - appDrag.cy) > 3) {
    ctx.appDragMoved = true;
  }

  // ドラッグ中に別タブの上へ来たら、そのプロファイルへアプリを移動。
  // タブ移動はルート面のみ。
  if (ctx === rootCtx) {
    const tabIdx = tabAtPoint(e.clientX, e.clientY);
    if (tabIdx !== null && tabIdx !== ctx.profileIndex) {
      moveAppToProfile(tabIdx, e, ctx);
      return;
    }
  }

  const w = clientToWorld(e.clientX, e.clientY, ctx);
  const app = profile(ctx).app_nodes[appDrag.index];
  if (!app) return;
  app.x = appDrag.ox + (w.x - appDrag.sx);
  app.y = appDrag.oy + (w.y - appDrag.sy);
  const el = ownAll(ctx, ".app-node")[appDrag.index];
  if (el) {
    el.style.left = `${app.x}px`;
    el.style.top = `${app.y}px`;
  }
}

// ドラッグ中のアプリブロックを別プロファイルへ移動する。
function moveAppToProfile(toIndex, e, ctx = currentCtx) {
  const appDrag = ctx.appDrag;
  if (!appDrag) return;
  const from = config.profiles[ctx.profileIndex];
  const to = config.profiles[toIndex];
  if (!from || !to || from === to) return;
  const app = from.app_nodes[appDrag.index];
  if (!app) return;

  // 元から取り除き、移動先へ追加。
  from.app_nodes.splice(appDrag.index, 1);
  if (!Array.isArray(to.app_nodes)) to.app_nodes = [];
  to.app_nodes.push(app);

  // タブ切替して移動先を表示。drag は維持して追従を続ける。
  ctx.profileIndex = toIndex;
  appDrag.index = to.app_nodes.length - 1; // 末尾＝今移したアプリ
  markDirty();
  render(ctx);

  // 追従基準を今のアプリ位置・カーソル位置にリセット。
  appDrag.ox = app.x ?? 0;
  appDrag.oy = app.y ?? 0;
  const w = clientToWorld(e.clientX, e.clientY, ctx);
  appDrag.sx = w.x;
  appDrag.sy = w.y;
}
function onAppDragUp(ctx = currentCtx) {
  ctx.appDrag = null;
  if (ctx._onAppDragMove)
    window.removeEventListener("pointermove", ctx._onAppDragMove);
  if (ctx._onAppDragUp)
    window.removeEventListener("pointerup", ctx._onAppDragUp);
  ctx._onAppDragMove = null;
  ctx._onAppDragUp = null;
  if (ctx.appDragMoved) markDirty(); // 実際に動いたときだけ保存対象に
  // この直後に発火する click ハンドラが appDragMoved を読むので、
  // 次のタイミングでフラグを戻す。
  setTimeout(() => {
    ctx.appDragMoved = false;
  }, 0);
}

// アプリパネルのボタンから、2秒後の前面アプリ名を取得して設定する。
let picking = false;
async function captureAppForNode(index, btn, ctx = currentCtx) {
  if (picking) return;
  picking = true;
  btn.disabled = true;
  for (let s = 2; s >= 1; s--) {
    btn.textContent = `${s}秒以内に対象をクリック…`;
    await new Promise((r) => setTimeout(r, 1000));
  }
  try {
    const name = await invoke("foreground_app");
    const app = profile(ctx).app_nodes[index];
    if (!app) return;
    if (!name) {
      statusEl.textContent = "取得できませんでした（自分の窓のまま？）";
    } else {
      app.name = name;
      markDirty();
      statusEl.textContent = `取得: ${name}（保存を押してください）`;
    }
  } catch (e) {
    console.error("[settings] foreground_app failed:", e);
    statusEl.textContent = "取得失敗: " + e;
  } finally {
    btn.disabled = false;
    picking = false;
    render(ctx);
    setTimeout(() => (statusEl.textContent = ""), 3000);
  }
}

// 除外タブの追加。2秒後の前面ウィンドウのタイトルを取得してリストへ足す。
// Chrome 等はタブ名がタイトルになるので「特定タブだけオフ」に使える。
async function captureExcludeTitle(index, btn, ctx = currentCtx) {
  if (picking) return;
  picking = true;
  btn.disabled = true;
  const orig = btn.textContent;
  for (let s = 2; s >= 1; s--) {
    btn.textContent = `${s}秒以内に対象タブへ…`;
    await new Promise((r) => setTimeout(r, 1000));
  }
  try {
    const title = await invoke("foreground_window_title");
    const app = profile(ctx).app_nodes[index];
    if (!app) return;
    if (!title) {
      statusEl.textContent = "取得できませんでした（自分の窓のまま？）";
    } else {
      // "ページ名 - Google Chrome" のブラウザ名サフィックスは除いて保存する
      // （残すと意味がない上、タブ名の一部だけ残して手編集する手間が増える）。
      const trimmed = title
        .replace(
          /\s[-–—]\s(google chrome|microsoft\s?edge|mozilla firefox|firefox|brave|vivaldi|opera|chromium)\s*$/i,
          "",
        )
        .trim();
      if (!Array.isArray(app.exclude_titles)) app.exclude_titles = [];
      app.exclude_titles.push(trimmed || title);
      markDirty();
      statusEl.textContent = `除外タブ取得: ${trimmed || title}`;
    }
  } catch (e) {
    console.error("[settings] foreground_window_title failed:", e);
    statusEl.textContent = "取得失敗: " + e;
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
    picking = false;
    render(ctx);
    setTimeout(() => (statusEl.textContent = ""), 3000);
  }
}

// ── 読み込み・保存 ────────────────────────────────────────────────
async function load() {
  try {
    const fresh = await invoke("get_config");
    // フォーカス復帰(最小化→戻る等)で load しても、設定が外部で変わっていなければ
    // フル再構築しない。再構築は子/孫パネルのカメラ・サイズの再適用を伴い、
    // 復帰のたびに表示がずれる原因になるため、内容が同じならそのまま返す。
    try {
      if (config && JSON.stringify(fresh) === JSON.stringify(config)) {
        return; // 変化なし＝何もしない（現在の表示・カメラ・サイズを維持）
      }
    } catch (_) {
      /* 比較失敗時は通常どおり再読込にフォールバック */
    }
    config = fresh;
    // config を作り直したので、古いノードを閉じ込めた子 ctx キャッシュは破棄。
    // （残すとサブメニュー編集が古い node に書かれて保存に反映されない）
    // ただし子/孫のカメラ(パン/ズーム)は退避しておき、再構築後に書き戻す
    // （最小化→復帰の load で子のパン/ズームが飛ぶのを防ぐ）。
    const savedCams = {};
    if (rootCtx) {
      snapshotChildCameras(rootCtx, "", savedCams);
      rootCtx._childCtx = {};
    }
    profile(rootCtx); // 構造を正規化
    normalizeColors(); // 旧 #RRGGBBAA を #RRGGBB に戻す（透明度は opacity に一本化）
    bumpNodeSeq();
    dirty = false;
    resetHistory(); // 読み込んだ状態を履歴の基準にする
    render();
    // 再構築された子/孫 ctx へカメラを書き戻して再描画（パン/ズーム復元）。
    if (rootCtx) {
      restoreChildCameras(rootCtx, "", savedCams);
      reapplyChildTransforms(rootCtx);
    }
  } catch (e) {
    console.error("[settings] get_config failed:", e);
    statusEl.textContent = "読み込み失敗";
  }
}

// セグメント色が8桁HEX(#RRGGBBAA)なら6桁(#RRGGBB)に丸める。
// 個別透明度は廃止しプロファイル全体の opacity に一本化したため。
function normalizeColors() {
  let changed = false;
  (config.profiles || []).forEach((p) => {
    (p.segments || []).forEach((s) => {
      if (typeof s.color === "string" && /^#[0-9a-f]{8}$/i.test(s.color)) {
        s.color = s.color.slice(0, 7);
        changed = true;
      }
    });
  });
  if (changed) markDirty(); // 自動保存でファイルも6桁に直る
}

function bumpNodeSeq() {
  let max = 0;
  for (const n of profile(rootCtx).nodes) {
    const m = /^node(\d+)$/.exec(n.id);
    if (m) max = Math.max(max, Number(m[1]));
    const m2 = /^n(\d+)$/.exec(n.id);
    if (m2) max = Math.max(max, Number(m2[1]));
  }
  nodeSeq = max + 1;
}

async function save() {
  if (!config.hotkey) config.hotkey = "F8";
  try {
    // 旧フィールドが残っていれば落とす。
    const p = profile(rootCtx);
    delete p.items;
    delete p.apps;
    await invoke("save_config", { config });
    dirty = false;
    // 自動保存は頻繁に走るので成功トーストは出さない（失敗時のみ通知）。
  } catch (e) {
    console.error("[settings] save_config failed:", e);
    showToast("保存失敗: " + e);
  }
}

// 上部に数秒表示して消えるトースト通知。
// 通知トースト。新しいものは上書きせず、スタックに積んで縦にずらす。
function showToast(msg) {
  const stack = document.getElementById("toast-stack");
  if (!stack) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  stack.appendChild(el);
  // 出現アニメ（次フレームで show を付ける）。
  requestAnimationFrame(() => el.classList.add("show"));
  // 数秒後にフェードアウト→DOM から除去（その分スタックが詰まる）。
  setTimeout(() => {
    el.classList.remove("show");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
    // transitionend が来ない場合の保険。
    setTimeout(() => el.remove(), 400);
  }, 2500);
}

// 削除時の専用トースト。3秒だけ「アンドゥ」ボタンを出す。
function showDeleteToast(message = "ブロックを削除しました") {
  const stack = document.getElementById("toast-stack");
  if (!stack) return;
  const el = document.createElement("div");
  el.className = "toast toast-delete";

  const msg = document.createElement("span");
  msg.className = "toast-msg";
  msg.textContent = message;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "toast-undo";
  btn.textContent = "アンドゥ";
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    el.classList.remove("show");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };
  btn.addEventListener("click", () => {
    undo();
    dismiss();
  });

  el.append(msg, btn);
  el.style.pointerEvents = "auto"; // ボタンを押せるように
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  // 3秒で自動的に消える（その間だけアンドゥボタンを出す）。
  setTimeout(dismiss, 3000);
}

// ── カスタムツールチップ（data-tip 要素にホバーで即表示） ──────────
// ブラウザ標準 title の表示遅延を避け、ホバー即表示にする。委任なので
// 後から追加された data-tip 要素にも効く。
// 何らかのドラッグ操作が進行中か（ツールチップ抑止などに使う）。
function anyDragActive() {
  // 何らかの編集面でドラッグ/リンク/選択操作が進行中か。
  const ctxDragging = (c) =>
    !!(
      c &&
      (c.quickDrag ||
        c.quickLink ||
        c.drag ||
        c.groupDrag ||
        c.appDrag ||
        c.segDrag ||
        c.nodeLink ||
        c.link ||
        c.radiusDrag ||
        c.previewMove ||
        c.marquee ||
        c.knife)
    );
  return !!(tabReorder || ctxDragging(currentCtx) || ctxDragging(rootCtx));
}

function setupTooltips() {
  const tip = document.getElementById("tooltip");
  if (!tip) return;
  let current = null;

  // カーソル追従の配置（既定）。
  const placeAtCursor = (e) => {
    const pad = 14;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    const r = tip.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 6) x = e.clientX - pad - r.width;
    if (y + r.height > window.innerHeight - 6) y = e.clientY - pad - r.height;
    tip.style.left = `${Math.max(6, x)}px`;
    tip.style.top = `${Math.max(6, y)}px`;
  };
  // 対象要素の上（見切れるなら下）に中央寄せで配置。
  const placeAtElement = (el) => {
    const b = el.getBoundingClientRect();
    const r = tip.getBoundingClientRect();
    const gap = 8;
    let x = b.left + b.width / 2 - r.width / 2;
    x = Math.max(6, Math.min(x, window.innerWidth - 6 - r.width));
    let y = b.top - gap - r.height; // 上に出す
    if (y < 6) y = b.bottom + gap; // 上が見切れるなら下に
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };
  const place = (e) => {
    if (current && current.hasAttribute("data-tip-anchor")) {
      placeAtElement(current);
    } else {
      placeAtCursor(e);
    }
  };

  document.addEventListener("pointerover", (e) => {
    // 何かをドラッグ中はツールチップを出さない（パネル移動中など）。
    if (anyDragActive()) return;
    const el = e.target.closest("[data-tip]");
    if (!el || el === current) return;
    current = el;
    // 「。」で文を区切って改行表示する（末尾の余分な改行は出さない）。
    tip.textContent = el
      .getAttribute("data-tip")
      .replace(/。(?=.)/g, "。\n");
    tip.classList.add("show");
    // サイズ確定後に配置（要素アンカーは寸法依存のため次フレーム）。
    place(e);
    requestAnimationFrame(() => {
      if (current === el) place(e);
    });
  });
  document.addEventListener("pointermove", (e) => {
    // 要素アンカーのツールチップはカーソルで動かさない。
    if (current && !current.hasAttribute("data-tip-anchor")) place(e);
  });
  document.addEventListener("pointerout", (e) => {
    if (!current) return;
    // 同じ要素内の移動では消さない。要素から出たときだけ隠す。
    if (e.relatedTarget && current.contains(e.relatedTarget)) return;
    current = null;
    tip.classList.remove("show");
  });
  // ドラッグやクリックで押した瞬間は邪魔なので隠す。
  document.addEventListener("pointerdown", () => {
    current = null;
    tip.classList.remove("show");
  });
}

// ── ホットキーキャプチャ ──────────────────────────────────────────
function normalizeCode(code) {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  // テンキーの数字（Numpad0〜9）も数字として扱う。
  const npDigit = /^Numpad(\d)$/.exec(code);
  if (npDigit) return npDigit[1];
  if (/^F\d{1,2}$/.test(code)) return code;
  const named = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    Space: "space",
    Enter: "enter",
    Escape: "esc",
    Tab: "tab",
    Home: "home",
    End: "end",
    Insert: "insert",
    Delete: "delete",
    PageUp: "pageup",
    PageDown: "pagedown",
    // 記号キー。値は「+」を含まない名前にする（保存値は + 区切りで分解
    // されるため、リテラルの "+" を入れると壊れる）。Rust 側 key_from_name で
    // これらを実際の文字へ変換する。
    Equal: "equal", // =/+ キー（Shift で +）
    Minus: "minus", // -/_ キー
    NumpadAdd: "plus", // テンキー +
    NumpadSubtract: "minus", // テンキー -
    NumpadMultiply: "multiply", // テンキー *
    NumpadDivide: "divide", // テンキー /
    NumpadDecimal: "decimal", // テンキー .
    BracketLeft: "bracketleft", // [
    BracketRight: "bracketright", // ]
    Semicolon: "semicolon", // ;
    Quote: "quote", // '
    Backquote: "backquote", // `
    Backslash: "backslash", // \
    Comma: "comma", // ,
    Period: "period", // .
    Slash: "slash", // /
  };
  return named[code] || null;
}

window.addEventListener("DOMContentLoaded", () => {
  // ルート編集面（メインキャンバス）を作る。以降すべての描画/操作はこの
  // ctx を基準に動く（省略時 currentCtx＝rootCtx）。
  rootCtx = makeEditorContext();
  currentCtx = rootCtx;

  // ブラウザ標準の右クリックメニュー（戻る/更新/印刷…）を出さない。
  // 配線削除などの独自右クリック操作は各要素側で処理する。
  // capture フェーズで必ず止める（子要素が stopPropagation しても確実に抑制）。
  window.addEventListener("contextmenu", (e) => e.preventDefault(), true);

  // ショートカット。入力欄での編集中やホットキー取得中は横取りしない。
  window.addEventListener("keydown", (e) => {
    if (keyCapture) return; // ホットキー取得中
    const t = e.target;
    const inField =
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.isContentEditable);
    if (inField) return; // 入力欄ではブラウザ既定の挙動に任せる

    // Del/Backspace: 選択ブロックを一括削除。
    if (e.key === "Delete" || e.key === "Backspace") {
      if (hasSelection()) {
        e.preventDefault();
        deleteSelection();
      }
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        redo();
      } else if (key === "c") {
        if (hasSelection()) {
          e.preventDefault();
          copySelection();
        }
      } else if (key === "v") {
        if (clipboard) {
          e.preventDefault();
          pasteClipboard();
        }
      } else if (key === "a") {
        // 全選択（ノード＋アプリ）。
        e.preventDefault();
        selectAll();
      }
    }
  });

  setupTooltips();

  // ブロックの追加は「何もない所で右クリック → メニュー」で行う
  // （＋ツールバーボタンは廃止）。

  // 外側有効トグル: 外周より外でもその方向のセグメントを選択扱いにする。
  // ルートの下部ツールバーは rootCtx を操作（子/孫は各パネル内のツールバー）。
  document.getElementById("outer-active").addEventListener("click", () => {
    const p = profile(rootCtx);
    p.outer_active = !p.outer_active;
    markDirty();
    document
      .getElementById("outer-active")
      .classList.toggle("on", p.outer_active === true);
  });

  // シェイク離脱トグル: マウスシェイクで表示中のメニューを消せるようにする。
  document.getElementById("shake-dismiss").addEventListener("click", () => {
    const p = profile(rootCtx);
    p.shake_dismiss = !(p.shake_dismiss !== false);
    markDirty();
    document
      .getElementById("shake-dismiss")
      .classList.toggle("on", p.shake_dismiss !== false);
  });

  // 大事トグル: アクティブプロファイルの保護を切替（タブの中クリックと同じ）。
  document.getElementById("protect-toggle").addEventListener("click", () => {
    toggleProtected(rootCtx.profileIndex);
  });

  // 有効トグル: アクティブプロファイルの有効/無効を切替。無効なら右クリックで
  // 無視される（Rust 側 profile_for_app/all_target_apps が enabled を見る）。
  document.getElementById("enable-toggle").addEventListener("click", () => {
    toggleEnabled(rootCtx.profileIndex);
  });

  // 即時アクショントグル: カーソルを乗せただけで発動を確定する。
  document.getElementById("instant-action").addEventListener("click", () => {
    const p = profile(rootCtx);
    p.instant_action = !p.instant_action;
    markDirty();
    document
      .getElementById("instant-action")
      .classList.toggle("on", p.instant_action === true);
  });

  const countRange = document.getElementById("count-range");
  countRange.addEventListener("input", () => {
    document.getElementById("count-value").textContent = countRange.value;
    setSegmentCount(Number(countRange.value), rootCtx);
  });

  // 不透明度スライダー（プロファイル全体の不透明度・リアルタイム反映）。
  const opacityRange = document.getElementById("opacity-range");
  opacityRange.addEventListener("input", () => {
    const v = Number(opacityRange.value);
    document.getElementById("opacity-value").textContent = `${v}%`;
    profile(rootCtx).opacity = v / 100;
    markDirty();
    renderPreview(rootCtx);
    scheduleConnectors(rootCtx);
  });

  setupCanvasPanZoom(rootCtx);
  setupMinimap();
  applyTransform(rootCtx);
  load();

  window.addEventListener("resize", () => scheduleConnectors(rootCtx));

  settingsWindow.onFocusChanged(({ payload: focused }) => {
    // 窓フォーカス復帰時に最新設定を読み直す。ただし未保存(dirty)・取得中(picking)、
    // およびサブメニュー(子面)を編集中(currentCtx≠root)は再読込しない。
    // （再読込すると config が作り直され、開いている子の編集状態が飛ぶため）
    if (focused && !picking && !dirty && currentCtx === rootCtx) load();
  });
});
