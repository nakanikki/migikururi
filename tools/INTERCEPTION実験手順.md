# Interception ドライバでキー遅延を潰せるか実験する手順

目的: SendInput（VK / SCANCODE とも 5〜6F）を回避し、カーネルの
キーボードフィルタ層から注入して物理キーボード並み（1〜2F）を狙う。

⚠ これは**カーネルドライバのインストール**（実マシンへの変更）を伴う。
不要になったらアンインストールできる（末尾参照）。

---

## 1. ドライバをインストール（1回だけ・再起動あり）

1. **管理者権限**の PowerShell を開く（スタート → PowerShell を右クリック →
   管理者として実行）
2. インストーラのフォルダへ移動して実行:
   ```
   cd "D:\Game\ゲーム制作\アプリ開発\右クリックメニュー\piemenu\tools\interception\Interception\command line installer"
   .\install-interception.exe /install
   ```
3. 「成功」と出たら **PC を再起動**（ドライバは再起動後に有効）

---

## 2. デバイス確認

再起動後、普通のターミナルで:
```
cd "D:\Game\ゲーム制作\アプリ開発\右クリックメニュー\piemenu"
py tools\intercept_probe.py --list
```
- `device N: HID\... ← ハードウェアID有り(実機)` という行が出れば OK
- 出た device 番号を覚える（複数あれば普段使うキーボードのぶん）

---

## 3. 計測（緑フラッシュ）

```
py tools\intercept_probe.py --device 1
```
（1 は --list で確認した番号に置き換え）

- 3秒以内にクリスタをクリックしてフォーカス、カーソルは線の近くに
- 緑フラッシュ → 線が消える/戻る までのフレーム数を録画で数える
- これまでの比較対象: 赤(vk)=6F / 青(scan)=5F。**緑が 1〜2F なら大当たり**

---

## 4. 結果次第

- **緑が速い（1〜2F）** → 右くるり本体に「作者専用フラグで Interception 送出」を
  実装する（配布版は SendInput のままクリーン維持）。実装は Claude 側で進める。
- **緑も 5F 前後** → 注入経路の問題ではなくクリスタ側の描画パイプ라인が
  原因。Interception では解決不可 → Pro Micro（HID 実機）待ちに戻る。

---

## アンインストール（元に戻す）

管理者 PowerShell で:
```
cd "D:\Game\ゲーム制作\アプリ開発\右クリックメニュー\piemenu\tools\interception\Interception\command line installer"
.\install-interception.exe /uninstall
```
→ 再起動。これでカーネルドライバは完全に消える。
