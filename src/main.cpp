#include <Arduino.h>

#include <Adafruit_TinyUSB.h>
#include <bluefruit.h>

// -----------------------------
// BLE UUIDs (temporary)
// -----------------------------
// NOTE: PLAN.md has a TODO to finalize UUIDs.
static const char* kFlusherServiceUuid = "f3641400-00b0-4240-ba50-05ca45bf8abc";
static const char* kFlushTextCharUuid = "f3641401-00b0-4240-ba50-05ca45bf8abc";

// -----------------------------
// USB HID Keyboard
// -----------------------------
Adafruit_USBD_HID usb_hid;

static uint8_t const kHidReportDescriptor[] = {TUD_HID_REPORT_DESC_KEYBOARD()};

static void hid_begin() {
  usb_hid.setPollInterval(2);
  usb_hid.setReportDescriptor(kHidReportDescriptor, sizeof(kHidReportDescriptor));
  usb_hid.begin();
}

static inline bool hid_ready() {
  return TinyUSBDevice.mounted() && usb_hid.ready();
}

static void hid_send_key(uint8_t modifier, uint8_t keycode) {
  if (!hid_ready()) {
    return;
  }

  uint8_t keycodes[6] = {0};
  keycodes[0] = keycode;

  usb_hid.keyboardReport(0, modifier, keycodes);
  delay(5);
  usb_hid.keyboardRelease(0);
  delay(5);
}

static bool ascii_to_hid(char c, uint8_t& modifier, uint8_t& keycode) {
  modifier = 0;
  keycode = 0;

  if (c >= 'a' && c <= 'z') {
    keycode = HID_KEY_A + (c - 'a');
    return true;
  }
  if (c >= 'A' && c <= 'Z') {
    modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
    keycode = HID_KEY_A + (c - 'A');
    return true;
  }

  if (c >= '1' && c <= '9') {
    keycode = HID_KEY_1 + (c - '1');
    return true;
  }
  if (c == '0') {
    keycode = HID_KEY_0;
    return true;
  }

  switch (c) {
    case '\n':
      keycode = HID_KEY_ENTER;
      return true;
    case '\r':
      keycode = HID_KEY_ENTER;
      return true;
    case '\t':
      keycode = HID_KEY_TAB;
      return true;
    case ' ':
      keycode = HID_KEY_SPACE;
      return true;

    case '-':
      keycode = HID_KEY_MINUS;
      return true;
    case '_':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_MINUS;
      return true;
    case '=':
      keycode = HID_KEY_EQUAL;
      return true;
    case '+':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_EQUAL;
      return true;

    case '[':
      keycode = HID_KEY_BRACKET_LEFT;
      return true;
    case '{':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_BRACKET_LEFT;
      return true;
    case ']':
      keycode = HID_KEY_BRACKET_RIGHT;
      return true;
    case '}':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_BRACKET_RIGHT;
      return true;
    case '\\':
      keycode = HID_KEY_BACKSLASH;
      return true;
    case '|':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_BACKSLASH;
      return true;

    case ';':
      keycode = HID_KEY_SEMICOLON;
      return true;
    case ':':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_SEMICOLON;
      return true;
    case '\'':
      keycode = HID_KEY_APOSTROPHE;
      return true;
    case '"':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_APOSTROPHE;
      return true;

    case ',':
      keycode = HID_KEY_COMMA;
      return true;
    case '<':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_COMMA;
      return true;
    case '.':
      keycode = HID_KEY_PERIOD;
      return true;
    case '>':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_PERIOD;
      return true;
    case '/':
      keycode = HID_KEY_SLASH;
      return true;
    case '?':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_SLASH;
      return true;

    case '`':
      keycode = HID_KEY_GRAVE;
      return true;
    case '~':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_GRAVE;
      return true;

    case '!':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_1;
      return true;
    case '@':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_2;
      return true;
    case '#':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_3;
      return true;
    case '$':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_4;
      return true;
    case '%':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_5;
      return true;
    case '^':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_6;
      return true;
    case '&':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_7;
      return true;
    case '*':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_8;
      return true;
    case '(':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_9;
      return true;
    case ')':
      modifier = KEYBOARD_MODIFIER_LEFTSHIFT;
      keycode = HID_KEY_0;
      return true;
    default:
      return false;
  }
}

static void hid_type_byte(uint8_t byte) {
  uint8_t modifier = 0;
  uint8_t keycode = 0;
  if (!ascii_to_hid(static_cast<char>(byte), modifier, keycode)) {
    // Unknown character (e.g., non-ASCII): ignore for now.
    // PLAN.md has a TODO to finalize character support/IME policy.
    return;
  }

  hid_send_key(modifier, keycode);
}

// -----------------------------
// RX buffer (BLE write -> loop)
// -----------------------------
constexpr size_t kRxBufferSize = 512;
static uint8_t rx_buf[kRxBufferSize];
static volatile size_t rx_head = 0;
static volatile size_t rx_tail = 0;
static volatile bool rx_overflow = false;

static inline size_t rb_next(size_t v) {
  return (v + 1) % kRxBufferSize;
}

static bool rb_push(uint8_t b) {
  size_t next = rb_next(rx_head);
  if (next == rx_tail) {
    rx_overflow = true;
    return false;
  }
  rx_buf[rx_head] = b;
  rx_head = next;
  return true;
}

static bool rb_pop(uint8_t& out) {
  if (rx_tail == rx_head) {
    return false;
  }
  out = rx_buf[rx_tail];
  rx_tail = rb_next(rx_tail);
  return true;
}

// -----------------------------
// BLE GATT
// -----------------------------
BLEService flusher_service(kFlusherServiceUuid);
BLECharacteristic flush_text_char(kFlushTextCharUuid);

static void flush_text_write_cb(uint16_t /*conn_hdl*/, BLECharacteristic* /*chr*/, uint8_t* data, uint16_t len) {
  for (uint16_t i = 0; i < len; i++) {
    rb_push(data[i]);
  }
}

static void start_advertising() {
  Bluefruit.Advertising.stop();

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(flusher_service);
  Bluefruit.Advertising.addName();

  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);
  Bluefruit.Advertising.setFastTimeout(30);

  Bluefruit.Advertising.start(0);
}

void setup() {
  // USB HID must be ready for the Target PC.
  hid_begin();

  // BLE for the Control PC.
  Bluefruit.begin();
  Bluefruit.setTxPower(4);
  Bluefruit.setName("ByteFlusher");

  flusher_service.begin();

  flush_text_char.setProperties(CHR_PROPS_WRITE | CHR_PROPS_WRITE_WO_RESP);
  flush_text_char.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  flush_text_char.setWriteCallback(flush_text_write_cb);
  flush_text_char.begin();

  start_advertising();
}

void loop() {
  uint8_t b = 0;
  if (rb_pop(b)) {
    hid_type_byte(b);
  } else {
    delay(1);
  }

  if (rx_overflow) {
    // Simple recovery: drop state; the exact policy can be decided later.
    rx_overflow = false;
  }
}