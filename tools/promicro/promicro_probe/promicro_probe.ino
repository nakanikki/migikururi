/*
 * 右くるり Pro Micro キー送出ファーム（全キー対応・本番用）
 *
 * 対象: ATmega32u4 Pro Micro（Arduino Leonardo 互換）
 * 役割: PC からシリアルでコマンドを受け取り、物理 HID キーを送出する。
 *       SendInput（injected）を通らない本物の HID キー入力になるので、
 *       クリスタ等の注入遅延を回避できる（実測 2F、SendInput は 5-6F）。
 *
 * ── プロトコル（PC → Pro Micro）──────────────────────────────
 * コマンドは先頭バイトで判別:
 *
 *   0x01, mods, key   … modifiers 付きで key を1回 press→release（3バイト）
 *       mods: bit0=Ctrl bit1=Shift bit2=Alt bit3=Win（GUI）
 *       key : 送るキー。ASCII文字（'a'〜'z','0'〜'9', 記号）はそのまま、
 *             特殊キーは下記 0x80〜のコードで指定（Arduino 定数へ変換）。
 *
 *   0x02              … ping。'K' を返す（接続確認）。
 *
 * key の特殊コード（0x80〜。Keyboard.h の KEY_* に対応）:
 *   0x80 Enter  0x81 Esc   0x82 Backspace 0x83 Tab   0x84 Space
 *   0x85 Left   0x86 Right  0x87 Up        0x88 Down
 *   0x89 Home   0x8A End    0x8B PageUp    0x8C PageDown
 *   0x8D Delete 0x8E Insert
 *   0x90〜0xA7  F1〜F24（0x90 + (n-1)）
 * それ以外（0x20〜0x7E）はそのままの ASCII 文字として送る。
 */

#include <Keyboard.h>

static uint8_t specialKey(uint8_t code) {
  switch (code) {
    case 0x80: return KEY_RETURN;
    case 0x81: return KEY_ESC;
    case 0x82: return KEY_BACKSPACE;
    case 0x83: return KEY_TAB;
    case 0x84: return ' ';
    case 0x85: return KEY_LEFT_ARROW;
    case 0x86: return KEY_RIGHT_ARROW;
    case 0x87: return KEY_UP_ARROW;
    case 0x88: return KEY_DOWN_ARROW;
    case 0x89: return KEY_HOME;
    case 0x8A: return KEY_END;
    case 0x8B: return KEY_PAGE_UP;
    case 0x8C: return KEY_PAGE_DOWN;
    case 0x8D: return KEY_DELETE;
    case 0x8E: return KEY_INSERT;
    default: break;
  }
  // F1〜F24。Arduino の KEY_F1..KEY_F12 は連番、F13〜F24 も連番で続く。
  if (code >= 0x90 && code <= 0xA7) {
    return KEY_F1 + (code - 0x90);
  }
  return 0;
}

// 1バイトを timeout 付きでブロッキング読み（コマンドの続きを確実に受ける）。
static int readByteBlocking() {
  unsigned long start = millis();
  while (Serial.available() == 0) {
    if (millis() - start > 50) return -1; // 取りこぼし時は諦める
  }
  return Serial.read();
}

static void pressKey(uint8_t mods, uint8_t key) {
  if (mods & 0x01) Keyboard.press(KEY_LEFT_CTRL);
  if (mods & 0x02) Keyboard.press(KEY_LEFT_SHIFT);
  if (mods & 0x04) Keyboard.press(KEY_LEFT_ALT);
  if (mods & 0x08) Keyboard.press(KEY_LEFT_GUI);

  uint8_t k = (key >= 0x80) ? specialKey(key) : key;
  if (k != 0) {
    Keyboard.press(k);
    delay(5); // 確実に認識される最小限の保持
    Keyboard.release(k);
  }

  if (mods & 0x08) Keyboard.release(KEY_LEFT_GUI);
  if (mods & 0x04) Keyboard.release(KEY_LEFT_ALT);
  if (mods & 0x02) Keyboard.release(KEY_LEFT_SHIFT);
  if (mods & 0x01) Keyboard.release(KEY_LEFT_CTRL);
}

void setup() {
  Serial.begin(115200);
  Keyboard.begin();
}

void loop() {
  if (Serial.available() > 0) {
    int cmd = Serial.read();
    if (cmd == 0x01) {
      int mods = readByteBlocking();
      int key = readByteBlocking();
      if (mods >= 0 && key >= 0) {
        pressKey((uint8_t)mods, (uint8_t)key);
      }
    } else if (cmd == 0x02) {
      Serial.write('K'); // ping 応答
    }
    // それ以外は無視（旧 'z'/'y' テキストコマンドは廃止）。
  }
}
