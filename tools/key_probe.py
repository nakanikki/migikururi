# -*- coding: utf-8 -*-
"""クリスタ遅延の体感比較用: Ctrl+Z / Ctrl+Y をリズム自動打鍵する。

使い方:
  py tools\\key_probe.py vk      ← 現在の右くるり相当（VKベース SendInput）
  py tools\\key_probe.py scan    ← スキャンコード方式（KEYEVENTF_SCANCODE）
  py tools\\key_probe.py ab      ← vk と scan を1打ずつ交互（体感比較の本命。
                                    方式間に速度差があるとリズムが不均等になる）
  オプション: --count 10 --interval 0.7

手順:
  1. クリスタで太い線を1本描いておく（アンドゥ/リドゥで見えたり消えたりする状態）
  2. まず物理キーボードで Ctrl+Z / Ctrl+Y を同じリズムで押して「基準の体感」を作る
  3. このスクリプトを実行 → 3秒以内にクリスタをクリックしてフォーカス
  4. 自動で Ctrl+Z ↔ Ctrl+Y が交互にリズム打鍵されるので、線の消え/戻りの
     「音（打鍵タイミング）とのズレ」を物理と比べる
"""

import argparse
import ctypes
import sys
import time
import tkinter as tk
from ctypes import wintypes

user32 = ctypes.windll.user32


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class Flash:
    """送信の瞬間カーソル近くに出す赤い小窓（体感の基準アンカー）。
    表示/非表示は「画面外⇔カーソル近く」への移動で行う（deiconify だと
    フォーカスを奪ってクリスタからキーが外れる事故になるため）。
    フラッシュ自体の描画にも約1F掛かるが、全方式に等しく掛かるので
    相対比較には影響しない。"""

    def __init__(self):
        self.root = tk.Tk()
        self.root.overrideredirect(True)  # 枠なし
        self.root.attributes("-topmost", True)
        self.root.configure(bg="#ff3333")
        self.root.geometry("22x22+-3000+-3000")  # 画面外で待機
        self.root.update()

    def show(self, color="#ff3333"):
        # 色は方式の目印（vk=赤 / scan=青）。
        self.root.configure(bg=color)
        pt = POINT()
        user32.GetCursorPos(ctypes.byref(pt))
        self.root.geometry(f"22x22+{pt.x + 20}+{pt.y + 20}")
        self.root.update()

    def hide(self):
        self.root.geometry("22x22+-3000+-3000")
        self.root.update()

# ── SendInput 構造体 ──────────────────────────────────────────────
ULONG_PTR = ctypes.c_size_t

class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]

class MOUSEINPUT(ctypes.Structure):
    # 実際には使わないが、INPUT 共用体のサイズを正しくするために必要
    # （これが無いと sizeof(INPUT) が 40 でなく 32 になり SendInput が失敗する）。
    _fields_ = [
        ("dx", ctypes.c_long),
        ("dy", ctypes.c_long),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class _INPUTunion(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]

class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTunion)]

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008
KEYEVENTF_EXTENDEDKEY = 0x0001
MAPVK_VK_TO_VSC = 0

VK_CONTROL = 0x11
VK_Z = 0x5A
VK_Y = 0x59


def scan_of(vk):
    return user32.MapVirtualKeyW(vk, MAPVK_VK_TO_VSC)


def key_event(vk, up, mode):
    """1キーぶんの INPUT を作る。mode: 'vk'（VK主体・現行の右くるり相当）
    / 'scan'（スキャンコード主体・物理キーボードに近い形）。"""
    ki = KEYBDINPUT()
    ki.time = 0
    ki.dwExtraInfo = 0
    ki.dwFlags = KEYEVENTF_KEYUP if up else 0
    if mode == "scan":
        ki.wVk = 0
        ki.wScan = scan_of(vk)
        ki.dwFlags |= KEYEVENTF_SCANCODE
    else:
        ki.wVk = vk
        ki.wScan = scan_of(vk)
    inp = INPUT()
    inp.type = INPUT_KEYBOARD
    inp.u.ki = ki
    return inp


def send_events(events):
    """INPUT のリストを1回の SendInput で送る。"""
    arr = (INPUT * len(events))(*events)
    n = user32.SendInput(len(events), arr, ctypes.sizeof(INPUT))
    if n != len(events):
        print(f"  ! SendInput が {n}/{len(events)} しか送れませんでした", flush=True)


def send_combo(vk, mode):
    """Ctrl+<vk> を down/up まとめて1回の SendInput で送る。"""
    send_events([
        key_event(VK_CONTROL, False, mode),
        key_event(vk, False, mode),
        key_event(vk, True, mode),
        key_event(VK_CONTROL, True, mode),
    ])


def send_combo_gapped(vk, gap_ms):
    """Ctrl を先に押し、gap_ms 待ってから本キーを押す（scancode 方式）。
    クリスタの「修飾キー処理が落ち着くまで待つと速い」V字特性の検証用。
    Pro Micro 実測: バースト3F / 17ms=5F / 150ms=2F。SendInput でも同じなら
    マイコン不要で配布版にも効く。"""
    send_events([key_event(VK_CONTROL, False, "scan")])
    time.sleep(gap_ms / 1000.0)
    send_events([
        key_event(vk, False, "scan"),
        key_event(vk, True, "scan"),
        key_event(VK_CONTROL, True, "scan"),
    ])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "mode",
        choices=["vk", "scan", "ab", "gap"],
        help="vk=現行方式 / scan=スキャンコード方式 / ab=1打ずつ交互（リズム比較）"
        " / gap=Ctrl先行→間隔→本キー（クリスタV字特性の検証）",
    )
    ap.add_argument(
        "--gap-ms",
        type=int,
        default=150,
        help="gap モードの Ctrl→本キー間隔（ミリ秒、既定150）",
    )
    ap.add_argument("--count", type=int, default=10, help="打鍵回数（既定10）")
    ap.add_argument("--interval", type=float, default=0.7, help="打鍵間隔 秒（既定0.7）")
    ap.add_argument(
        "--swap",
        action="store_true",
        help="ab モードで方式の割り当てを入れ替える（Z=scan/Y=vk）。"
        "リズムのズレ方が --swap で逆転すれば方式差が本物、"
        "変わらなければアンドゥ/リドゥ自体の速度差",
    )
    ap.add_argument(
        "--no-flash",
        action="store_true",
        help="送信瞬間の赤フラッシュ（カーソル近く）を出さない",
    )
    args = ap.parse_args()

    flash = None if args.no_flash else Flash()

    print(f"モード: {args.mode}  {args.count}回  間隔{args.interval}s")
    if not args.no_flash:
        print("フラッシュの色: 赤=vk（現行方式） / 青=scan（スキャンコード方式）")
    print("3秒以内にクリスタ（対象アプリ）をクリックしてフォーカスしてください…")
    for s in (3, 2, 1):
        print(f"  {s}…", flush=True)
        time.sleep(1)

    # Ctrl+Z と Ctrl+Y を交互に打つ（アンドゥ↔リドゥで見た目が往復する）。
    # ab モードは方式も1打ずつ交互にする。速度差があれば「等間隔で送っている
    # のに反映のリズムが不均等」に見える（一定遅延は感知できないがズレは分かる）。
    for i in range(args.count):
        vk = VK_Z if i % 2 == 0 else VK_Y
        name = "Ctrl+Z" if vk == VK_Z else "Ctrl+Y"
        if args.mode == "gap":
            # Ctrl 先行 → gap_ms → 本キー。緑フラッシュは本キー送出の瞬間。
            print(f"  [{i + 1}/{args.count}] Ctrl→{args.gap_ms}ms→{name[-1]}", flush=True)
            send_events([key_event(VK_CONTROL, False, "scan")])
            time.sleep(args.gap_ms / 1000.0)
            if flash:
                flash.show("#33dd55")
            send_events([
                key_event(vk, False, "scan"),
                key_event(vk, True, "scan"),
                key_event(VK_CONTROL, True, "scan"),
            ])
            hold = min(0.15, args.interval / 2)
            time.sleep(hold)
            if flash:
                flash.hide()
            time.sleep(max(0.0, args.interval - hold))
            continue
        if args.mode == "ab":
            first, second = ("scan", "vk") if args.swap else ("vk", "scan")
            mode = first if i % 2 == 0 else second
        else:
            mode = args.mode
        print(f"  [{i + 1}/{args.count}] {name} ({mode})", flush=True)
        if flash:
            # 方式の目印: vk=赤 / scan=青（ab 以外でも色で分かるように統一）。
            flash.show("#ff3333" if mode == "vk" else "#3377ff")
        send_combo(vk, mode)
        # フラッシュは少し見せてから画面外へ（この待ちも打鍵間隔に含める）。
        hold = min(0.15, args.interval / 2)
        time.sleep(hold)
        if flash:
            flash.hide()
        time.sleep(max(0.0, args.interval - hold))

    print("完了")


if __name__ == "__main__":
    sys.exit(main())
