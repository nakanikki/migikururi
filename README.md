# 右くるり (Win専用右クリックパイメニューソフト)
<img width="709" height="474" alt="Animation2" src="https://github.com/user-attachments/assets/214ca3e5-2c37-448c-9a26-1a012858e8ae" />  <br>
 
<img width="330" height="309" alt="image" src="https://github.com/user-attachments/assets/b415ddbd-20e8-42f0-b325-0519defb8641" />
<img width="266" height="235" alt="image" src="https://github.com/user-attachments/assets/2fbafa9b-d547-4aab-bd3e-9bb85ee44b91" />
<img width="284" height="238" alt="image" src="https://github.com/user-attachments/assets/be044478-b066-4536-a4ed-96b293612a94" />






## 特徴
軽快動作！直感的かつ一望できる散らかし放題の設定UI！マジで一瞬でパイメニュー作れます
<img width="1128" height="817" alt="image" src="https://github.com/user-attachments/assets/f9892069-8fbc-4a64-a436-9f8e511ff5c6" />


## 設定の仕方
<img width="510" height="270" alt="Animation2" src="https://github.com/user-attachments/assets/b5303436-9fe2-4ecb-8f14-c98323bf8055" />

## メニュー形状カスタマイズ
<img width="274" height="277" alt="Animation2" src="https://github.com/user-attachments/assets/03c2de12-ec74-4bdf-be43-8f1c54180a0a" />

## 上下にくっつけて連続発動可
<img width="256" height="85" alt="image" src="https://github.com/user-attachments/assets/dc5bc47f-65ed-4d81-b615-4c8e8c7e9a63" />

## 子･孫サブメニュー(右クリックジェスチャーみたいにもできる)
<img width="865" height="750" alt="image" src="https://github.com/user-attachments/assets/f8e676f7-242f-4a81-8d2b-28a963dff03b" />

## 右クリック+ホイールとかも設定可
<img width="424" height="193" alt="image" src="https://github.com/user-attachments/assets/cd846e55-e01b-41f8-9aca-59e6210de589" /><br>
右クリホイールでタブ移動めっちゃ便利だよ



## ダウンロード・インストール
･ [Releases](https://github.com/nakanikki/migikururi/releases) から最新の `MigiKururi.exe` をダウンロード。起動。

･ ポータブル仕様です。設定ファイルは同列フォルダに作られます。作れない場合はAppDataに作ります。

･ アンインストールはファイル削除

## 開発

[Tauri](https://tauri.app/) 製のネイティブアプリです。
- **バックエンド**: Rust（低レベルマウスフック / キー送出 / タスクトレイ / 設定の読み書き）
- **フロントエンド**: Vanilla JS + HTML + CSS（パイメニュー描画・設定エディタ）
- コーディング Claude Opus4.8(全量)

## クリスタで使用する時の遅延
このソフトは数ミリ秒で即キーを送れますが、クリスタはそれが反映されるまで4-6Fかかるようです。
おそらくクリスタの方の仕様だと思われます。他の競合ソフトでも同様です。悔しいです。
クロームやBlenderは超速で反応してくれます。
