# -*- coding: utf-8 -*-
"""Interception ドライバ経由で Ctrl+Z / Ctrl+Y を送る遅延計測ツール。

前提: Interception ドライバがインストール済み（install-interception.exe /install
      → 再起動）。未インストールだと interception_create_context が使えず、
      送信しても何も起きない。

原理: Interception はカーネルのキーボードフィルタ層からストロークを注入する
      ので、OS からは物理キーボードと区別できない（injected フラグが付かない）。
      SendInput 経路（VK/SCANCODE とも）が乗る遅い道を回避できる可能性がある。

使い方:
  py tools\\intercept_probe.py --list          ← デバイス一覧（keyboard を確認）
  py tools\\intercept_probe.py --device 1       ← device 1 から送出して計測
  py tools\\intercept_probe.py                  ← 既定 device を自動選択して計測
  オプション: --count 10 --interval 0.7 --no-flash

計測は key_probe.py と同じ「緑フラッシュ→キャンバス反映」の体感/録画比較。
"""

import argparse
import ctypes
import os
import sys
import threading
import time
import tkinter as tk

# ── DLL ロード（tools/interception/.../x64/interception.dll）───────────
HERE = os.path.dirname(os.path.abspath(__file__))
DLL = os.path.join(
    HERE, "interception", "Interception", "library", "x64", "interception.dll"
)


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


user32 = ctypes.windll.user32


class Flash:
    """送信の瞬間カーソル近くに出す小窓（既定は緑＝interception）。"""

    def __init__(self, color="#33dd55"):
        self.color = color
        self.root = tk.Tk()
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.configure(bg=color)
        self.root.geometry("22x22+-3000+-3000")
        self.root.update()

    def show(self):
        pt = POINT()
        user32.GetCursorPos(ctypes.byref(pt))
        self.root.geometry(f"22x22+{pt.x + 20}+{pt.y + 20}")
        self.root.update()

    def hide(self):
        self.root.geometry("22x22+-3000+-3000")
        self.root.update()


# ── Interception API 型 ───────────────────────────────────────────────
class KeyStroke(ctypes.Structure):
    _fields_ = [
        ("code", ctypes.c_ushort),
        ("state", ctypes.c_ushort),
        ("information", ctypes.c_uint),
    ]


# InterceptionStroke は MouseStroke サイズ＝**20バイト**
# （state2+flags2+rolling2+pad2+x4+y4+information4）。interception_send は
# この20バイト刻みでストロークを読むので、KeyStroke(8バイト)を 20バイト箱の
# 先頭に置いて送る。※最初 12バイトと誤っていて2打目以降がゴミになっていた。
class Stroke(ctypes.Structure):
    _fields_ = [("raw", ctypes.c_char * 20)]


KEY_DOWN = 0x00
KEY_UP = 0x01
INTERCEPTION_MAX_KEYBOARD = 10


def load_dll():
    if not os.path.exists(DLL):
        print(f"DLL が見つかりません: {DLL}")
        sys.exit(1)
    d = ctypes.WinDLL(DLL)
    d.interception_create_context.restype = ctypes.c_void_p
    d.interception_destroy_context.argtypes = [ctypes.c_void_p]
    d.interception_is_keyboard.argtypes = [ctypes.c_int]
    d.interception_is_keyboard.restype = ctypes.c_int
    d.interception_get_hardware_id.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_void_p,
        ctypes.c_uint,
    ]
    d.interception_get_hardware_id.restype = ctypes.c_uint
    d.interception_send.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_void_p,
        ctypes.c_uint,
    ]
    d.interception_send.restype = ctypes.c_int
    # set_filter: predicate(コールバック) と filter を受ける。predicate に
    # NULL は渡せない実装があるため「常に真」を返す関数を渡す。
    d.interception_set_filter.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_ushort,
    ]
    d.interception_wait_with_timeout.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    d.interception_wait_with_timeout.restype = ctypes.c_int
    d.interception_receive.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_void_p,
        ctypes.c_uint,
    ]
    d.interception_receive.restype = ctypes.c_int
    return d


# predicate: 全デバイスを対象にする（常に 1 を返す）。
PREDICATE = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int)(lambda dev: 1)


def hw_id(d, ctx, dev):
    buf = ctypes.create_unicode_buffer(256)
    n = d.interception_get_hardware_id(ctx, dev, buf, ctypes.sizeof(buf))
    return buf.value if n else ""


def list_devices(d, ctx):
    print("デバイス一覧（keyboard のみ、1〜10）:")
    found = []
    for dev in range(1, INTERCEPTION_MAX_KEYBOARD + 1):
        if d.interception_is_keyboard(dev):
            hid = hw_id(d, ctx, dev)
            mark = " ← ハードウェアID有り(実機)" if hid else " (無効/未接続の可能性)"
            print(f"  device {dev}: {hid or '(no hardware id)'}{mark}")
            if hid:
                found.append(dev)
    return found


def make_stroke(scan, up):
    ks = KeyStroke(code=scan, state=(KEY_UP if up else KEY_DOWN), information=0)
    s = Stroke()
    ctypes.memmove(s.raw, ctypes.byref(ks), ctypes.sizeof(ks))
    return s


# Ctrl / Z / Y のセット2スキャンコード（US配列基準・拡張なし）。
SC_LCTRL = 0x1D
SC_Z = 0x2C
SC_Y = 0x15


def send_combo(d, ctx, dev, main_scan, broadcast=False):
    seq = [
        make_stroke(SC_LCTRL, False),
        make_stroke(main_scan, False),
        make_stroke(main_scan, True),
        make_stroke(SC_LCTRL, True),
    ]
    arr = (Stroke * len(seq))(*seq)
    # broadcast=True のときは 1〜10 の全キーボード device へ撃つ（受信ポートと
    # 注入ポートの番号が違う HID レシーバー対策。当たり番号を探す）。
    targets = range(1, 11) if broadcast else [dev]
    for t in targets:
        d.interception_send(ctx, t, arr, len(seq))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="キーボードデバイス一覧だけ表示")
    ap.add_argument("--device", type=int, default=0, help="送出に使う device 番号（1〜10）")
    ap.add_argument(
        "--type-test",
        action="store_true",
        help="診断: 各デバイスから「デバイス番号の数字キー」を打ち込む。"
        "メモ帳に出た数字＝injection が効くデバイス",
    )
    ap.add_argument(
        "--recv-test",
        action="store_true",
        help="診断: 物理キーを押すと、その device 番号を表示する（20秒）。"
        "効く送信デバイスを特定するのに使う。押したキーはパススルーする",
    )
    ap.add_argument("--count", type=int, default=10)
    ap.add_argument("--interval", type=float, default=0.7)
    ap.add_argument("--no-flash", action="store_true")
    ap.add_argument(
        "--all",
        action="store_true",
        help="1〜10 の全キーボード device へ同時注入（当たり番号探し）",
    )
    ap.add_argument(
        "--abc-test",
        action="store_true",
        help="診断: 受信ポンプを回しつつ 'a' を連打注入。メモ帳に aaaa と"
        "出れば注入が効いている（フォーカス問題との切り分け）",
    )
    args = ap.parse_args()

    d = load_dll()
    ctx = d.interception_create_context()
    if not ctx:
        print("コンテキスト作成に失敗。ドライバ未インストール？")
        print("install-interception.exe /install を管理者で実行→再起動してください。")
        sys.exit(1)

    # 送信前にフィルタを設定してデバイスをコンテキストに"開かせる"。
    # これが無いと send は成功戻り値でも実際には注入されない（今回の症状）。
    # フィルタ値 0xFFFF(=KEY_ALL)。predicate は全デバイス真。
    d.interception_set_filter(ctx, PREDICATE, 0xFFFF)

    try:
        devices = list_devices(d, ctx)
        if args.list:
            return

        if args.recv_test:
            # 物理キーを押すと、それが来た device 番号を表示する。
            # 受信した stroke は必ず send で返す（=パススルー。返さないと
            # 物理キーボードが効かなくなる）。20秒で自動終了。
            print("\n物理キーボードで適当なキーを何回か押してください（20秒）。")
            print("そのキーが来た device 番号を表示します。Ctrl+Z 等を押すと分かりやすい。")
            print("※このモード中もキー入力は通常どおり効きます（パススルー）。\n")
            deadline = time.time() + 20.0
            seen = {}
            buf = (Stroke * 1)()
            while time.time() < deadline:
                dev = d.interception_wait_with_timeout(ctx, 500)
                if dev <= 0:
                    continue
                d.interception_receive(ctx, dev, buf, 1)
                # 先頭 8 バイトが KeyStroke。c_char*20 を bytes() 化すると
                # ヌル終端で切れることがあるので、生メモリから 20 バイト読む。
                raw = ctypes.string_at(ctypes.addressof(buf[0]), 20)
                ks = KeyStroke.from_buffer_copy(raw[:8])
                # まず必ずパススルー（物理キーを殺さない）。
                d.interception_send(ctx, dev, buf, 1)
                if d.interception_is_keyboard(dev):
                    seen[dev] = seen.get(dev, 0) + 1
                    if ks.state in (0, 2):  # down のみ表示（up は省く）
                        print(
                            f"  device {dev} から key: scan=0x{ks.code:02X} "
                            f"(押した回数計 {seen[dev]})",
                            flush=True,
                        )
            print("\n=== 結果 ===")
            if seen:
                for dev, cnt in sorted(seen.items()):
                    print(f"  device {dev}: {cnt} イベント ← このデバイスに send すれば効く")
                best = max(seen, key=seen.get)
                print(f"\n次はこれで計測: py tools\\intercept_probe.py --device {best}")
            else:
                print("  キーボードイベントを1つも受信できませんでした。")
                print("  → Interception がこのキーボードをフックできていない可能性大。")
            return

        if args.type_test:
            # 各デバイスから「デバイス番号の数字」を1文字ずつ打つ。
            # 例: メモ帳に "15" と出たら device 1 と 5 が効く。
            print("\nメモ帳などテキスト入力欄をフォーカスしてください。5秒後に送信…")
            time.sleep(5)
            for dev in devices:
                if dev > 9:
                    continue
                digit_scan = 0x01 + dev  # '1'=0x02 … '9'=0x0A
                seq = [make_stroke(digit_scan, False), make_stroke(digit_scan, True)]
                arr = (Stroke * 2)(*seq)
                n = d.interception_send(ctx, dev, arr, 2)
                print(f"  device {dev}: 数字 '{dev}' を送信 (send戻り値={n})", flush=True)
                time.sleep(0.3)
            print("→ 入力欄に表示された数字 ＝ injection が効くデバイス番号")
            return
        dev = args.device or (devices[0] if devices else 0)
        if not dev:
            print("送出に使えるキーボードが見つかりません。--device で明示してください。")
            return

        if args.abc_test:
            # 受信ポンプを回しつつ 'a' を10連打注入。メモ帳で確認する。
            SC_A = 0x1E
            print("\nメモ帳をフォーカスしてください。5秒後に 'a' を10回注入します。")
            print("→ aaaa… と出れば注入OK（フォーカスの問題ではない）")
            print("→ 出なければ注入が届いていない（デバイス相性の問題）")
            for s in (5, 4, 3, 2, 1):
                print(f"  {s}…", flush=True)
                time.sleep(1)
            d.interception_set_filter(ctx, PREDICATE, 0xFFFF)
            stop = threading.Event()

            def pump_abc():
                b = (Stroke * 1)()
                while not stop.is_set():
                    g = d.interception_wait_with_timeout(ctx, 200)
                    if g <= 0:
                        continue
                    d.interception_receive(ctx, g, b, 1)
                    d.interception_send(ctx, g, b, 1)

            th = threading.Thread(target=pump_abc, daemon=True)
            th.start()
            try:
                for i in range(10):
                    seq = [make_stroke(SC_A, False), make_stroke(SC_A, True)]
                    arr = (Stroke * 2)(*seq)
                    # 全 device へ撃つ（当たり番号不明でも1つ効けば出る）。
                    for t in range(1, 11):
                        d.interception_send(ctx, t, arr, 2)
                    print(f"  'a' 注入 {i + 1}/10", flush=True)
                    time.sleep(0.4)
            finally:
                stop.set()
                th.join(timeout=1.0)
            print("→ メモ帳に a が出たか確認してください")
            return
        print(f"\n送出デバイス: device {dev}")
        print("フラッシュの色: 緑 = interception 経路")
        print("※このドライバは『受信ループ稼働中のみ注入が届く』ため、物理キーを")
        print("  透過しながら並行して Ctrl+Z/Y を注入します（キー入力は通常どおり効く）。")
        print("3秒以内にクリスタをクリックしてフォーカスしてください…")
        for s in (3, 2, 1):
            print(f"  {s}…", flush=True)
            time.sleep(1)

        # 全キー捕捉のフィルタを立てて受信ポンプを動かす（これで注入が届く）。
        d.interception_set_filter(ctx, PREDICATE, 0xFFFF)

        stop = threading.Event()

        # 受信ポンプ: 物理キーを受け取ったら必ず send で透過（=キーを殺さない）。
        # これでコンテキストが能動状態になり、別スレッドの注入 send が届く。
        def pump():
            buf = (Stroke * 1)()
            while not stop.is_set():
                got = d.interception_wait_with_timeout(ctx, 200)
                if got <= 0:
                    continue
                d.interception_receive(ctx, got, buf, 1)
                d.interception_send(ctx, got, buf, 1)  # 透過

        th = threading.Thread(target=pump, daemon=True)
        th.start()

        flash = None if args.no_flash else Flash()
        try:
            for i in range(args.count):
                main_scan = SC_Z if i % 2 == 0 else SC_Y
                name = "Ctrl+Z" if main_scan == SC_Z else "Ctrl+Y"
                print(f"  [{i + 1}/{args.count}] {name}", flush=True)
                if flash:
                    flash.show()
                send_combo(d, ctx, dev, main_scan, broadcast=args.all)
                hold = min(0.15, args.interval / 2)
                time.sleep(hold)
                if flash:
                    flash.hide()
                time.sleep(max(0.0, args.interval - hold))
            print("完了")
        finally:
            stop.set()
            th.join(timeout=1.0)
    finally:
        d.interception_destroy_context(ctx)


if __name__ == "__main__":
    sys.exit(main())
