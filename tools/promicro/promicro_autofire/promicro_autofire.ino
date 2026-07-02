/*
 * Pro Micro チップ実力計測ファーム（直打ち・シリアル介さず）
 *
 * 目的: Pro Micro（ATmega32U4）が「自分で物理 HID キーを打つ」ときの
 *       クリスタ反映フレーム数を測る。シリアル受信を一切挟まないので、
 *       チップの USB HID スタックそのものの最速値が分かる。
 *       これが速ければ（1-2F）遅延源はシリアル経路、遅ければ（5-6F）
 *       チップ自体が遅い（＝過去の RP2040 と同じ壁）。
 *
 * 動作: 電源が入ると 2 秒ごとに Ctrl+Z を1回、物理送出し続ける。
 *       書き込んだら Pro Micro を挿したままクリスタをフォーカスして待つだけ。
 *       （ボタン・配線・マトリクス不要）
 *
 * ⚠ このファームは勝手に Ctrl+Z を打ち続けるので、計測が済んだら
 *    promicro_probe（シリアル版）に書き戻すこと。
 */

#include <Keyboard.h>

void setup() {
  Keyboard.begin();
  // 起動直後の暴発防止に少し待つ（フォーカス合わせの猶予）。
  delay(3000);
}

bool undo = true;

void loop() {
  // 実験③: Ctrl を押してから 150ms（人間の打鍵間隔相当）待って Z/Y。
  // 実測: バースト=3F / 17ms間隔=5F(悪化) / 人間+ロジ=1F。
  // 「Ctrl単独押下でクリスタが一時ツール切替処理を始め、その最中に届いた
  //  キーは待たされる。処理が落ち着いた後(100ms+)なら1F」というV字仮説の検証。
  // 計測: 「Ctrl+Z」表示(=Z到着)→線の変化 のフレーム数。1Fなら仮説確定。
  // 150ms=2F だった。300ms でロジ並み(1F)まで落ちるか確認。
  Keyboard.press(KEY_LEFT_CTRL);
  delay(300);
  char k = undo ? 'z' : 'y';
  Keyboard.press(k);
  delay(5);
  Keyboard.release(k);
  Keyboard.release(KEY_LEFT_CTRL);
  undo = !undo;  // アンドゥ⇔リドゥ交互（毎回キャンバスが変化して見える）

  delay(7000);
}
