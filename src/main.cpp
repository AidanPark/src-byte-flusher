#include <Arduino.h>

#include <Adafruit_TinyUSB.h>
#include <bluefruit.h>

// 펌웨어 버전 (메이저.마이너.패치)
static const char* kFirmwareVersion = "1.0.2";

static const char* build_ble_device_name() {
  // 동일 기기가 여러 대일 때, 광고 이름만으로도 구분 가능하게 한다.
  // nRF52840은 FICR에 고유 DEVICEID가 있다.
  const uint32_t id0 = NRF_FICR->DEVICEID[0];
  const uint32_t id1 = NRF_FICR->DEVICEID[1];
  const uint16_t suffix = static_cast<uint16_t>((id0 ^ id1) & 0xFFFFu);

  static char name[24];
  snprintf(name, sizeof(name), "ByteFlusher-%04X", suffix);
  return name;
}

// -----------------------------
// BLE UUID (현재 사용값)
// -----------------------------
static const char* kFlusherServiceUuid = "f3641400-00b0-4240-ba50-05ca45bf8abc";
static const char* kFlushTextCharUuid = "f3641401-00b0-4240-ba50-05ca45bf8abc";
static const char* kConfigCharUuid = "f3641402-00b0-4240-ba50-05ca45bf8abc";
static const char* kStatusCharUuid = "f3641403-00b0-4240-ba50-05ca45bf8abc";

// Flush Text 패킷 포맷(LE)
// - [sessionId(2)][seq(2)][payload...]
// - BT 끊김/재시도 시 동일 패킷을 재전송해도 중복 타이핑이 발생하지 않게 한다.
static constexpr uint16_t kFlushHeaderSize = 4;

// -----------------------------
// 타이핑/전환 타이밍 (ms)
// -----------------------------
// 속도보다 안정성(키 씹힘 방지)을 우선한다.
static constexpr uint16_t kDefaultTypingDelayMs = 30;       // 각 키 입력 후 대기
static constexpr uint16_t kDefaultModeSwitchDelayMs = 100;  // 한/영 전환 후 대기
static constexpr uint16_t kDefaultKeyPressDelayMs = 10;     // 키 눌림 유지 시간

// 웹에서 BLE로 설정 가능(런타임)
static volatile uint16_t g_typing_delay_ms = kDefaultTypingDelayMs;
static volatile uint16_t g_mode_switch_delay_ms = kDefaultModeSwitchDelayMs;
static volatile uint16_t g_key_press_delay_ms = kDefaultKeyPressDelayMs;

// Pause/Resume (런타임)
// - true면 RX 버퍼를 소비(타이핑)하지 않는다.
// - 정확성 우선: 버퍼가 full일 때는 write(with response)가 블로킹되며 웹 전송도 멈춘다.
static volatile bool g_paused = false;

// 한/영 전환키 선택(웹 설정)
// 0=RightAlt(기본), 1=LeftAlt, 2=RightCtrl, 3=LeftCtrl, 4=RightGUI, 5=LeftGUI, 6=CapsLock
static volatile uint8_t g_toggle_key = 0;

// -----------------------------
// 디버그(USB CDC Serial)
// -----------------------------
static void log_line(const char* msg) {
  if (Serial) {
    Serial.println(msg);
  }
}

static void log_kv(const char* key, const char* value) {
  if (Serial) {
    Serial.print(key);
    Serial.print(": ");
    Serial.println(value);
  }
}

// -----------------------------
// USB HID 키보드
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
  delay(g_key_press_delay_ms);
  usb_hid.keyboardRelease(0);
  delay(g_key_press_delay_ms);
}

static void hid_tap_modifier(uint8_t modifier) {
  // modifier만 눌렀다 떼는 용도(예: 한/영 전환 Right Alt)
  if (!hid_ready()) {
    return;
  }

  uint8_t keycodes[6] = {0};
  usb_hid.keyboardReport(0, modifier, keycodes);
  delay(g_key_press_delay_ms);
  usb_hid.keyboardRelease(0);
  delay(g_key_press_delay_ms);
}

static void hid_tap_toggle_key() {
  switch (g_toggle_key) {
    case 6:
      hid_send_key(0, HID_KEY_CAPS_LOCK);
      return;
    case 1:
      hid_tap_modifier(KEYBOARD_MODIFIER_LEFTALT);
      return;
    case 2:
      hid_tap_modifier(KEYBOARD_MODIFIER_RIGHTCTRL);
      return;
    case 3:
      hid_tap_modifier(KEYBOARD_MODIFIER_LEFTCTRL);
      return;
    case 4:
      hid_tap_modifier(KEYBOARD_MODIFIER_RIGHTGUI);
      return;
    case 5:
      hid_tap_modifier(KEYBOARD_MODIFIER_LEFTGUI);
      return;
    case 0:
    default:
      hid_tap_modifier(KEYBOARD_MODIFIER_RIGHTALT);
      return;
  }
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

// -----------------------------
// 한/영 전환 + 한글(두벌식) 타이핑
// -----------------------------
static bool g_is_korean_mode = false;
static bool g_prev_was_cr = false;

// 두벌식 매핑(SD Flusher 테이블 기반)
static const char* const kChoData[19] = {
  "r", "R", "s", "e", "E", "f", "a", "q", "Q", "t", "T", "d", "w", "W", "c", "z", "x", "v", "g"};

static const char* const kJungData[21] = {
  "k", "o", "i", "O", "j", "p", "u", "P", "h", "hk", "ho", "hl", "y", "n", "nj", "np", "nl", "b", "m", "ml", "l"};

static const char* const kJongData[28] = {"",  "r", "R", "rt", "s", "sw", "sg", "e", "f", "fr", "fa", "fq", "ft", "fx", "fv", "fg",
                                         "a", "q", "qt", "t",  "T", "d",  "w", "c", "z",  "x",  "v",  "g"};

static void switch_to_korean() {
  if (g_is_korean_mode) {
    return;
  }
  // Target PC에서 선택된 전환키가 한/영 전환으로 설정되어 있다는 전제
  hid_tap_toggle_key();
  delay(g_mode_switch_delay_ms);
  g_is_korean_mode = true;
}

static void switch_to_english() {
  if (!g_is_korean_mode) {
    return;
  }
  hid_tap_toggle_key();
  delay(g_mode_switch_delay_ms);
  g_is_korean_mode = false;
}

static void type_ascii_char(char c) {
  uint8_t modifier = 0;
  uint8_t keycode = 0;
  if (!ascii_to_hid(c, modifier, keycode)) {
    // 매핑이 없는 ASCII는 '?'로 대체
    ascii_to_hid('?', modifier, keycode);
  }
  hid_send_key(modifier, keycode);
  delay(g_typing_delay_ms);
}

static void type_keys(const char* keys) {
  for (int i = 0; keys[i] != '\0'; i++) {
    // 매핑 문자열은 ASCII 키 시퀀스이므로 영어 모드에서 타이핑한다.
    // (한글 모드에서 알파벳을 누르면 자모가 입력되어야 한다.)
    // 단, 이 함수는 '이미 한국어 모드' 상태에서 호출된다.
    // 따라서 여기서는 모드 전환을 하지 않는다.
    type_ascii_char(keys[i]);
  }
}

static void type_korean_syllable(uint16_t unicode) {
  // 한글 음절(가~힣)만 처리
  const uint16_t kKoreanStart = 0xAC00;
  const uint16_t kKoreanEnd = 0xD7A3;
  if (unicode < kKoreanStart || unicode > kKoreanEnd) {
    return;
  }

  const uint16_t code = static_cast<uint16_t>(unicode - kKoreanStart);
  const int cho = code / (21 * 28);
  const int jung = (code % (21 * 28)) / 28;
  const int jong = code % 28;

  if (cho >= 0 && cho < 19) {
    type_keys(kChoData[cho]);
  }
  if (jung >= 0 && jung < 21) {
    type_keys(kJungData[jung]);
  }
  if (jong > 0 && jong < 28) {
    type_keys(kJongData[jong]);
  }
}

static void type_codepoint(uint32_t cp) {
  // ASCII 제어문자/기본 문자
  if (cp <= 0x7F) {
    const char c = static_cast<char>(cp);

    // ASCII는 영어 모드에서 처리
    if (c == '\r') {
      // CR 단독도 줄바꿈으로 취급한다.
      // 단, 바로 뒤에 LF가 오면 CRLF로 보고 LF는 무시(엔터 중복 방지).
      g_prev_was_cr = true;
      switch_to_english();
      type_ascii_char('\n');
      return;
    }
    if (c == '\n') {
      if (g_prev_was_cr) {
        // CRLF: 이미 CR에서 엔터를 쳤으므로 LF는 무시
        g_prev_was_cr = false;
        return;
      }
      // 한글 모드에서 엔터가 어색한 케이스가 있어서 영어로 돌려 엔터
      switch_to_english();
      type_ascii_char('\n');
      return;
    }
    if (c == '\t') {
      g_prev_was_cr = false;
      switch_to_english();
      type_ascii_char('\t');
      return;
    }

    g_prev_was_cr = false;
    switch_to_english();
    type_ascii_char(c);
    return;
  }

  g_prev_was_cr = false;

  // 한글 음절(가~힣)
  if (cp >= 0xAC00 && cp <= 0xD7A3) {
    switch_to_korean();
    type_korean_syllable(static_cast<uint16_t>(cp));
    return;
  }

  // 그 외 유니코드는 현재 입력 정책이 애매하므로 '?'로 대체
  // (현재 입력 텍스트는 ASCII + 한글 음절로 제한하는 것을 권장)
  switch_to_english();
  type_ascii_char('?');
}

// UTF-8 스트림 디코더 상태
static uint32_t g_utf8_cp = 0;
static uint8_t g_utf8_need = 0;

static void reset_input_state_no_keystroke() {
  // Stop(즉시 폐기) 시 정확성 우선:
  // - 기존 버퍼 내용을 버린다.
  // - UTF-8/CRLF/한글모드 내부 상태만 초기화한다(추가 키 입력은 하지 않는다).
  g_utf8_cp = 0;
  g_utf8_need = 0;
  g_prev_was_cr = false;
  g_is_korean_mode = false;
}

static void process_input_byte(uint8_t b) {
  if (g_utf8_need == 0) {
    if (b < 0x80) {
      type_codepoint(b);
      return;
    }
    if ((b & 0xE0) == 0xC0) {
      g_utf8_cp = (b & 0x1F);
      g_utf8_need = 1;
      return;
    }
    if ((b & 0xF0) == 0xE0) {
      g_utf8_cp = (b & 0x0F);
      g_utf8_need = 2;
      return;
    }
    if ((b & 0xF8) == 0xF0) {
      g_utf8_cp = (b & 0x07);
      g_utf8_need = 3;
      return;
    }

    // 잘못된 시작 바이트는 무시
    return;
  }

  if ((b & 0xC0) != 0x80) {
    // 깨진 UTF-8: 상태 리셋
    g_utf8_cp = 0;
    g_utf8_need = 0;
    // 현재 바이트는 새 시작으로 재해석
    process_input_byte(b);
    return;
  }

  g_utf8_cp = (g_utf8_cp << 6) | (b & 0x3F);
  g_utf8_need--;
  if (g_utf8_need == 0) {
    type_codepoint(g_utf8_cp);
    g_utf8_cp = 0;
  }
}

static inline uint16_t le16(const uint8_t* p) {
  return static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8);
}

static inline uint16_t clamp_u16(uint16_t v, uint16_t min_v, uint16_t max_v) {
  if (v < min_v) return min_v;
  if (v > max_v) return max_v;
  return v;
}

static void rb_clear();
static void notify_status_if_needed(bool force);

static void config_write_cb(uint16_t /*conn_hdl*/, BLECharacteristic* /*chr*/, uint8_t* data, uint16_t len) {
  // 포맷(호환):
  // - LE u16 * 3 => [typingDelayMs][modeSwitchDelayMs][keyPressDelayMs]
  // - + u8(선택) => [toggleKey]
  // - + u8(선택) => [flags]
  //   - flags bit0: paused
  //   - flags bit1: abort(즉시 폐기)
  if (len < 6) {
    return;
  }

  const uint16_t typing_ms = le16(&data[0]);
  const uint16_t mode_ms = le16(&data[2]);
  const uint16_t press_ms = le16(&data[4]);

  g_typing_delay_ms = clamp_u16(typing_ms, 0, 1000);
  g_mode_switch_delay_ms = clamp_u16(mode_ms, 0, 3000);
  g_key_press_delay_ms = clamp_u16(press_ms, 0, 300);

  if (len >= 7) {
    const uint8_t toggle = data[6];
    g_toggle_key = static_cast<uint8_t>(toggle <= 6 ? toggle : 0);
  }

  if (len >= 8) {
    const uint8_t flags = data[7];
    g_paused = (flags & 0x01) != 0;

    if ((flags & 0x02) != 0) {
      // 즉시 폐기: 버퍼/상태를 리셋하고 정상 모드로 복귀한다.
      g_paused = false;
      rb_clear();
      reset_input_state_no_keystroke();
      notify_status_if_needed(true);
    }
  }
}

// -----------------------------
// RX 버퍼 (BLE write -> loop)
// -----------------------------
// 기본값은 작게 시작하고, 유실이 보이면 웹에서 Delay를 올리는 방식으로 안정화한다.
constexpr size_t kRxBufferSize = 512;
static uint8_t rx_buf[kRxBufferSize];
static volatile size_t rx_head = 0;
static volatile size_t rx_tail = 0;

static inline uint16_t rb_capacity_bytes() {
  // 링버퍼는 (head+1==tail)로 full을 판정하므로, 실사용 용량은 size-1이다.
  return static_cast<uint16_t>(kRxBufferSize - 1);
}

static inline uint16_t rb_used_bytes() {
  const size_t head = rx_head;
  const size_t tail = rx_tail;
  if (head >= tail) {
    return static_cast<uint16_t>(head - tail);
  }
  return static_cast<uint16_t>(kRxBufferSize - (tail - head));
}

static inline uint16_t rb_free_bytes() {
  const uint16_t used = rb_used_bytes();
  const uint16_t cap = rb_capacity_bytes();
  return static_cast<uint16_t>(cap - (used <= cap ? used : cap));
}

static inline size_t rb_next(size_t v) {
  return (v + 1) % kRxBufferSize;
}

static bool rb_push(uint8_t b) {
  size_t next = rb_next(rx_head);
  if (next == rx_tail) {
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

static void rb_clear() {
  noInterrupts();
  rx_tail = rx_head;
  interrupts();
}

// -----------------------------
// BLE GATT
// -----------------------------
BLEService flusher_service(kFlusherServiceUuid);
BLECharacteristic flush_text_char(kFlushTextCharUuid);
BLECharacteristic config_char(kConfigCharUuid);
BLECharacteristic status_char(kStatusCharUuid);

static uint32_t g_last_status_notify_ms = 0;
static uint16_t g_last_status_free = 0;

static void notify_status_if_needed(bool force) {
  const uint16_t free_bytes = rb_free_bytes();
  const uint32_t now_ms = millis();

  // 너무 자주 notify하면 오히려 BLE에 부담이 되므로 throttle한다.
  const bool time_ok = (now_ms - g_last_status_notify_ms) >= 120;
  const bool delta_ok = (free_bytes != g_last_status_free);
  if (!force && !(time_ok && delta_ok)) {
    return;
  }

  uint8_t payload[4];
  const uint16_t cap = rb_capacity_bytes();
  payload[0] = cap & 0xff;
  payload[1] = (cap >> 8) & 0xff;
  payload[2] = free_bytes & 0xff;
  payload[3] = (free_bytes >> 8) & 0xff;

  // 구독자가 없으면 notify는 내부적으로 실패(또는 무시)한다.
  status_char.notify(payload, sizeof(payload));
  g_last_status_notify_ms = now_ms;
  g_last_status_free = free_bytes;
}

static volatile uint16_t g_session_id = 0;
static volatile uint16_t g_expected_seq = 0;

static void reset_session(uint16_t session_id) {
  g_session_id = session_id;
  g_expected_seq = 0;
}

static bool drain_one_byte() {
  if (!hid_ready()) {
    return false;
  }
  if (g_paused) {
    return false;
  }
  uint8_t out = 0;
  if (!rb_pop(out)) {
    return false;
  }
  process_input_byte(out);
  return true;
}

static void flush_text_write_cb(uint16_t /*conn_hdl*/, BLECharacteristic* /*chr*/, uint8_t* data, uint16_t len) {
  // 최소 헤더가 없으면 무시
  if (len < kFlushHeaderSize) {
    return;
  }

  const uint16_t session_id = le16(&data[0]);
  const uint16_t seq = le16(&data[2]);
  const uint16_t payload_len = static_cast<uint16_t>(len - kFlushHeaderSize);
  uint8_t* payload = &data[kFlushHeaderSize];

  // 다른 sessionId가 들어오면 seq==0일 때만 새 작업으로 인정한다.
  if (g_session_id != session_id) {
    if (seq != 0) {
      return;
    }
    reset_session(session_id);
  }

  // 재시도/중복 청크는 무시
  if (seq < g_expected_seq) {
    return;
  }

  // 순서가 앞선 청크만 처리한다(브라우저는 순차 전송)
  if (seq > g_expected_seq) {
    return;
  }

  // payload를 RX 버퍼에 안전하게 적재한다.
  // 버퍼가 꽉 찼으면 여기서 1바이트씩 타이핑해서 공간을 만든다.
  // => write(with response) 기반으로 자연스러운 백프레셔가 걸린다.
  for (uint16_t i = 0; i < payload_len; i++) {
    while (!rb_push(payload[i])) {
      // Pause 상태에서는 타이핑으로 공간을 만들지 않는다.
      // 정확성 우선: 응답이 돌아가지 않게 하여 웹이 더 보내지 못하게 만든다.
      if (g_paused) {
        delay(5);
        continue;
      }

      // (이론상 버퍼가 full이면 empty일 수 없다)
      if (!drain_one_byte()) {
        delay(1);
      }
    }
  }

  g_expected_seq++;
}

static void ble_connect_cb(uint16_t /*conn_handle*/) {
  log_line("BLE 연결됨");
  notify_status_if_needed(true);
}

static void ble_disconnect_cb(uint16_t /*conn_handle*/, uint8_t /*reason*/) {
  log_line("BLE 연결 해제됨");
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

  log_line("BLE 광고 시작");
}

void setup() {
  // 디버그 로그(필요 시 시리얼 모니터로 확인)
  Serial.begin(115200);
  delay(50);
  log_line("ByteFlusher 부팅");
  log_kv("FW", kFirmwareVersion);
  log_kv("Service UUID", kFlusherServiceUuid);
  log_kv("Char UUID", kFlushTextCharUuid);
  log_kv("Config UUID", kConfigCharUuid);
  log_kv("Status UUID", kStatusCharUuid);

  // Target PC에 HID 키보드로 인식되도록 USB 초기화
  hid_begin();

  // Control PC(브라우저)와 통신하기 위한 BLE 초기화
  Bluefruit.begin();
  Bluefruit.setTxPower(4);
  const char* const ble_name = build_ble_device_name();
  Bluefruit.setName(ble_name);
  log_kv("BLE Name", ble_name);

  Bluefruit.Periph.setConnectCallback(ble_connect_cb);
  Bluefruit.Periph.setDisconnectCallback(ble_disconnect_cb);

  flusher_service.begin();

  // 정확도 우선: write(with response)만 허용한다.
  // (브라우저가 ack를 받으며 재시도할 수 있어야 단 1글자도 유실되지 않는다.)
  flush_text_char.setProperties(CHR_PROPS_WRITE);
  flush_text_char.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  flush_text_char.setWriteCallback(flush_text_write_cb);
  flush_text_char.begin();

  // 런타임 입력 타이밍 설정
  config_char.setProperties(CHR_PROPS_WRITE);
  config_char.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  config_char.setWriteCallback(config_write_cb);
  config_char.begin();

  // 장치 상태(Flow Control)
  // payload: [capacityBytes(u16 LE)][freeBytes(u16 LE)]
  status_char.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY);
  status_char.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  status_char.setFixedLen(4);
  status_char.begin();

  // 부팅 직후 상태 1회 전송(구독자는 연결 후 설정될 수 있으므로 실패해도 무방)
  notify_status_if_needed(true);

  start_advertising();
}

void loop() {
  // USB HID가 준비되지 않은 상태에서 입력을 소비하면(버퍼 pop) 타이핑이 누락될 수 있다.
  // 따라서 HID가 준비될 때까지는 RX 버퍼를 유지하며 대기한다.
  if (!hid_ready()) {
    delay(5);
    return;
  }

  // Pause: 장치 내부 큐를 소비(타이핑)하지 않는다.
  if (g_paused) {
    delay(5);
    return;
  }

  uint8_t b = 0;
  if (rb_pop(b)) {
    process_input_byte(b);
    notify_status_if_needed(false);
  } else {
    notify_status_if_needed(false);
    delay(1);
  }
}