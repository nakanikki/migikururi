# 更新履歴


## 2026/07/02

### 追加
  - **特殊キー**<br>
    <img width="431" height="329" alt="image" src="https://github.com/user-attachments/assets/1200a32a-9942-4837-bbb8-6d300a9a5c82" />

  - **初期アクションパネル**<br>
    <img width="257" height="99" alt="image" src="https://github.com/user-attachments/assets/3d49acde-2fc3-48f4-b2d6-72b245f25eaf" />

  - **サブメニューの前段・後段アクション** <br>
    <img width="285" height="161" alt="image" src="https://github.com/user-attachments/assets/6d986ae6-dfe2-477b-851b-159d732e7789" />

  
- **除外タブ機能** <br>
    <img width="350" height="140" alt="image" src="https://github.com/user-attachments/assets/476eb13e-af14-4543-9fe7-4ba5463a7753" />



- **クイックスロットのラベル**  <br>
   <img width="488" height="189" alt="image" src="https://github.com/user-attachments/assets/b1fe20f0-e534-4d92-85f1-a31a071ecd60" />





### 変更
- キー送出を**スキャンコード方式**（KEYEVENTF_SCANCODE）に変更。
  クリスタで実測して従来の VK 方式より約1F速かった（フラッシュ基準:
  VK ~6F / SCANCODE ~5F）。

### 修正
- クイックスロットパネル（マウス絵）が、大きなブロック（サブメニュー内包など）の
  下に隠れて見えなくなることがある問題（パネルも他ブロックと同じ
  「触ったら最前面」の重なり順管理に含めた）。(2026-07-02)
- 除外タブで出した本来の右クリックメニューの上でもう一度右クリックすると、
  パイが出てしまう問題（ポップアップにタイトルが無いため除外判定をすり抜けていた。
  所有者チェーン→同アプリ前面窓の順でタイトルを辿って判定するように）。(2026-07-02)
- 範囲選択の矩形・ナイフのヒントラベルが、ドラッグ中に Win+Shift+S などで
  フォーカスを失うと画面に残り続ける問題（pointercancel/blur でも終了するように）。(2026-07-02)
- Chrome を2窓開いているとき、フォーカスのない側の窓で右クリック＋ホイール等を
  すると、フォーカスのある側の窓にキーが飛んでしまう問題
  （キー送出前に「右クリックしたカーソル下の窓」を前面化するように統一）。(2026-07-02)
