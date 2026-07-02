# -*- coding: utf-8 -*-
"""Pro Micro（ATmega32u4・本物HID）経由で Ctrl+Z/Y を送る遅延計測ツール。

前提: tools/promicro/promicro_probe/promicro_probe.ino を書き込み済み。
      Pro Micro がシリアルポート（例 COM11）で 'z'/'y' を受けて物理 HID
      キーを送出する。SendInput（injected）を通らない本物のキー入力なので、
      クリスタの注入遅延を回避できるかを計測する。

使い方:
  py tools\\promicro_probe.py --port COM11 --ping    ← 接続確認（K が返れば OK）
  py tools\\promicro_probe.py --port COM11           ← 緑フラッシュ計測
  オプション: --count 10 --interval 0.7 --no-flash

pyserial が必要（無ければ: py -m pip install pyserial）。
"""

import argparse
import ctypes
import sys
import time
import tkinter as tk

try:
    import serial  # pyserial
except ImportError:
    print("pyserial が必要です。インストール:  py -m pip install pyserial")
    sys.exit(1)

user32 = ctypes.windll.user32


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class Flash:
    """送信の瞬間カーソル近くに出す小窓（緑＝Pro Micro 経路）。"""

    def __init__(self, color="#33dd55"):
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", required=True, help="Pro Micro のシリアルポート（例 COM11）")
    ap.add_argument("--ping", action="store_true", help="接続確認だけ（K が返れば OK）")
    ap.add_argument("--count", type=int, default=10)
    ap.add_argument("--interval", type=float, default=0.7)
    ap.add_argument("--no-flash", action="store_true")
    args = ap.parse_args()

    try:
        # Leonardo は USB CDC なので baud は実質無視。開くだけ。
        ser = serial.Serial(args.port, 115200, timeout=1)
    except Exception as e:
        print(f"ポート {args.port} を開けません: {e}")
        print("board list でポート番号を確認してください（書き込み後は番号が変わる）。")
        sys.exit(1)

    # ポートを開いた直後は Leonardo がリセットされることがあるので少し待つ。
    time.sleep(1.5)

    try:
        if args.ping:
            ser.reset_input_buffer()
            ser.write(bytes([0x02]))  # 新プロトコルの ping
            ser.flush()
            resp = ser.read(1)
            if resp == b"K":
                print("ping OK（Pro Micro 応答あり）")
            else:
                print(f"応答なし/不正（受信: {resp!r}）。ポート番号は合っている？")
            return

        print(f"ポート: {args.port}  {args.count}回  間隔{args.interval}s")
        print("フラッシュの色: 緑 = Pro Micro（本物HID）経路")
        print("3秒以内にクリスタをクリックしてフォーカスしてください…")
        for s in (3, 2, 1):
            print(f"  {s}…", flush=True)
            time.sleep(1)

        # 新ファームのプロトコル: [0x01, mods, key]。mods bit0=Ctrl。
        # Ctrl+Z = 0x01,0x01,'z' / Ctrl+Y = 0x01,0x01,'y'
        flash = None if args.no_flash else Flash()
        for i in range(args.count):
            keych = ord("z") if i % 2 == 0 else ord("y")
            name = "Ctrl+Z" if keych == ord("z") else "Ctrl+Y"
            cmd = bytes([0x01, 0x01, keych])
            print(f"  [{i + 1}/{args.count}] {name}", flush=True)
            if flash:
                flash.show()
            ser.write(cmd)
            ser.flush()
            hold = min(0.15, args.interval / 2)
            time.sleep(hold)
            if flash:
                flash.hide()
            time.sleep(max(0.0, args.interval - hold))
        print("完了")
    finally:
        ser.close()


if __name__ == "__main__":
    sys.exit(main())
