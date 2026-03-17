# Keyboard Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Filco TKL(FILCKTL12S) 키보드의 컨트롤러를 nRF52840으로 교체하여, 물리 키보드 입력과 ByteFlusher BLE 기능이 동시에 동작하는 일체형 장치를 만든다.

**Architecture:** 하드웨어 타이머 ISR(TIMER1, 1ms)이 키 매트릭스를 스캔하여 이벤트 큐에 push한다. `loop()`에서 물리 키 HID 리포트와 ByteFlusher 타이핑을 독립적으로 처리한다. ByteFlusher 진행 중에는 물리 키 입력을 완전 차단하여 텍스트가 섞이지 않는다. 플러시 완료 후 물리 키 상태가 즉시 복원된다.

**Tech Stack:** C++, PlatformIO, Adafruit nRF52 Arduino core (nordicnrf52), TinyUSB (Adafruit_TinyUSB), Bluefruit (bluefruit.h), nRF52840 hardware timers

---

## Prerequisites (Hardware — 펌웨어 작업 전 필수)

> 아래 하드웨어 작업이 완료되어야 Task 1을 시작할 수 있다.

- [ ] Filco FILCKTL12S 분해 — 하단 케이스 나사 제거, PCB 노출
- [ ] 기존 컨트롤러 칩 식별 (Holtek HT32 계열 등)
- [ ] 멀티미터 도통 테스트로 ROW/COL 핀맵 실측
  - ROW: 예상 6개, COL: 예상 14~16개
  - 각 키의 (ROW, COL) 위치를 표로 정리
  - 결과를 `docs/filco-matrix-pinmap.md`에 기록
- [ ] nRF52840 예약 핀 확인 (BSP 문서 참조)
  - USB D+/D-, SWD 핀, 32MHz 크리스탈 핀은 GPIO로 사용 불가
  - Adafruit Feather nRF52840 기준: [BSP variant.h](https://github.com/adafruit/Adafruit_nRF52_Arduino/blob/master/variants/feather_nrf52840_express/variant.h) 확인
- [ ] 기존 컨트롤러 제거/분리
- [ ] nRF52840 보드 배선
  - ROW → GPIO OUTPUT (active-low)
  - COL → GPIO INPUT_PULLUP
- [ ] USB는 nRF52840 보드의 USB 커넥터를 케이스 밖으로 인출

---

## File Map

| 파일 | 역할 |
|---|---|
| `src/matrix.h` | **신규** — KeyEvent 구조체, 이벤트 큐, 핀맵 상수, 키맵 테이블, ISR 설정/스캔 함수, 물리 키 상태 변수 전부 포함 |
| `src/main.cpp` | **수정** — `#include "matrix.h"` 추가, `hid_send_key()` / `hid_tap_modifier()` / `is_flush_idle()` 수정, `loop()`에 `flush_key_events()` 추가 |

> `src/matrix.h`는 헤더-온리 스타일로 작성한다 (`static` / `inline` 함수). Arduino/PlatformIO 단일 컴파일 유닛 구조에서 별도 `.cpp` 없이 동작한다.

---

## Task 1: `src/matrix.h` 생성 — 핀맵, 키맵, KeyEvent 큐

**Files:**
- Create: `src/matrix.h`

**목표:** 핀맵 상수, 키맵 테이블, KeyEvent 구조체와 링 버퍼를 정의한다.
실측 전 dummy 값으로 작성하여 이후 Task에서 채울 수 있도록 한다.

- [ ] **Step 1: `src/matrix.h` 파일 생성**

```cpp
#pragma once
#include <stdint.h>
#include <stddef.h>

// -------------------------------------------------------
// 핀맵 — 실측 후 채울 것 (현재는 Feather nRF52840 예시값)
// Arduino 핀 번호 기준 (BSP variant.h 참고)
// USB D+/D-, SWD, 크리스탈 핀은 사용 금지
// -------------------------------------------------------
static constexpr uint8_t kMatrixRows = 6;
static constexpr uint8_t kMatrixCols = 16;

static constexpr uint8_t kRowPins[kMatrixRows] = {
  A0, A1, A2, A3, 15, 14  // PLACEHOLDER — 실측값으로 교체
};
static constexpr uint8_t kColPins[kMatrixCols] = {
  2, 3, 4, 5, 6, 7, 8, 9, 10, 16, 17, 18, 19, 20, 21, 22  // PLACEHOLDER
};

// -------------------------------------------------------
// 키맵 — Filco TKL US 배열 기준 HID keycode
// 실측 핀맵 확정 후 채울 것. 현재는 0으로 초기화 (dummy)
// -------------------------------------------------------
#include "Adafruit_TinyUSB.h"  // HID_KEY_* 상수

static const uint8_t kKeymap[kMatrixRows][kMatrixCols] = {
  // ROW0
  { HID_KEY_ESCAPE, HID_KEY_F1, HID_KEY_F2, HID_KEY_F3,
    HID_KEY_F4, HID_KEY_F5, HID_KEY_F6, HID_KEY_F7,
    HID_KEY_F8, HID_KEY_F9, HID_KEY_F10, HID_KEY_F11,
    HID_KEY_F12, HID_KEY_PRINT_SCREEN, HID_KEY_SCROLL_LOCK, HID_KEY_PAUSE },
  // ROW1 ~ ROW5: 실측 후 채울 것 (현재 모두 0)
  { 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0 },
  { 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0 },
  { 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0 },
  { 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0 },
  { 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0 },
};

// 키코드가 모디파이어인지 판별
static inline bool is_modifier_keycode(uint8_t kc) {
  return kc >= HID_KEY_CONTROL_LEFT && kc <= HID_KEY_GUI_RIGHT;
}

// HID keycode → modifier bitmask 변환
static inline uint8_t keycode_to_modifier_bit(uint8_t kc) {
  if (kc < HID_KEY_CONTROL_LEFT || kc > HID_KEY_GUI_RIGHT) return 0;
  return 1u << (kc - HID_KEY_CONTROL_LEFT);
}

// -------------------------------------------------------
// KeyEvent 링 버퍼
// -------------------------------------------------------
struct KeyEvent {
  uint8_t row;
  uint8_t col;
  bool    pressed;
};

static constexpr size_t kKeyEventQueueSize = 32;
static KeyEvent key_event_buf[kKeyEventQueueSize];
static volatile size_t key_event_head = 0;
static volatile size_t key_event_tail = 0;

static inline bool key_event_push(KeyEvent ev) {
  const size_t next = (key_event_head + 1) % kKeyEventQueueSize;
  if (next == key_event_tail) return false;  // 큐 풀: 드롭
  key_event_buf[key_event_head] = ev;
  __DMB();  // 페이로드 쓰기 완료 후 head 전진
  key_event_head = next;
  return true;
}

static inline bool key_event_pop(KeyEvent& out) {
  if (key_event_tail == key_event_head) return false;
  out = key_event_buf[key_event_tail];
  __DMB();
  key_event_tail = (key_event_tail + 1) % kKeyEventQueueSize;
  return true;
}

// -------------------------------------------------------
// 물리 키 HID 상태
// -------------------------------------------------------
static uint8_t g_phys_modifier = 0;
static uint8_t g_phys_keycodes[6] = {0};

// g_phys_keycodes를 dst 배열의 빈 슬롯에 병합 (최대 6키)
static inline void merge_phys_keycodes(uint8_t dst[6]) {
  for (int pi = 0; pi < 6; pi++) {
    if (g_phys_keycodes[pi] == 0) continue;
    for (int di = 0; di < 6; di++) {
      if (dst[di] == 0) { dst[di] = g_phys_keycodes[pi]; break; }
    }
  }
}
```

- [ ] **Step 2: 빌드 확인**

```bash
platformio run --environment nice_nano_v2_compatible 2>&1 | tail -20
```
Expected: `SUCCESS` (아직 main.cpp에서 include하지 않으므로 현재 빌드에 영향 없음)

- [ ] **Step 3: 커밋**

```bash
git add src/matrix.h
git commit -m "feat: add matrix.h with pinmap, keymap, KeyEvent queue, phys key state"
```

---

## Task 2: 하드웨어 타이머 ISR + 매트릭스 스캔 + 디바운스

**Files:**
- Modify: `src/matrix.h` (ISR 설정 함수, 스캔 로직 추가)

**목표:** TIMER1 기반 1ms ISR에서 매트릭스를 스캔하고 디바운스 후 이벤트를 큐에 push한다.

- [ ] **Step 1: `src/matrix.h` 하단에 ISR 스캔 코드 추가**

> **주의:** Adafruit nRF52 Arduino 코어에는 `HardwareTimer` 클래스가 없다.
> `nrfx_timer` 드라이버도 BSP 기본값에서 비활성화되어 있다.
> 따라서 **TIMER1 레지스터 직접 접근 + `TIMER1_IRQHandler` 정의** 방식을 사용한다.
>
> **ISR 실행 시간 예산:** 6 rows × (5µs delay + 16 × digitalRead) ≈ 45µs/회.
> 1ms 주기 대비 약 4.5% CPU 사용 — 허용 범위.
>
> **링 버퍼 동시성:** `key_event_push`(ISR에서 head 기록)와 `key_event_pop`(loop에서 tail 기록)은
> 단일 생산자/소비자 패턴이다. Cortex-M4에서 32비트 정렬 변수 읽기/쓰기는 원자적이므로
> 인터럽트 락 없이 `__DMB()` 배리어만으로 안전하다.

```cpp
// -------------------------------------------------------
// 매트릭스 스캔 + 디바운스 (TIMER1 IRQHandler에서 호출)
// -------------------------------------------------------

static bool matrix_state[kMatrixRows][kMatrixCols] = {};
static uint8_t debounce_cnt[kMatrixRows][kMatrixCols] = {};
static constexpr uint8_t kDebounceThreshold = 3;  // 3ms 연속 동일값

static void matrix_scan_isr() {
  // ISR 실행 시간: 6rows × (5µs + 16×digitalRead) ≈ 45µs
  for (uint8_t r = 0; r < kMatrixRows; r++) {
    digitalWrite(kRowPins[r], LOW);
    delayMicroseconds(5);  // GPIO 안정화 대기

    for (uint8_t c = 0; c < kMatrixCols; c++) {
      bool raw = (digitalRead(kColPins[c]) == LOW);  // active-low
      bool prev = matrix_state[r][c];

      if (raw == prev) {
        debounce_cnt[r][c] = 0;
        continue;
      }
      debounce_cnt[r][c]++;
      if (debounce_cnt[r][c] >= kDebounceThreshold) {
        debounce_cnt[r][c] = 0;
        matrix_state[r][c] = raw;
        KeyEvent ev = { r, c, raw };
        key_event_push(ev);  // 큐 풀이면 드롭
      }
    }

    digitalWrite(kRowPins[r], HIGH);
  }
}

// -------------------------------------------------------
// TIMER1 직접 레지스터 설정 (1ms 주기)
//
// TIMER0: SoftDevice 전용 — 절대 사용 금지
// TIMER1~4: 사용 가능
//
// 설정값:
//   PRESCALER = 4  → 16MHz / 2^4 = 1MHz 카운터 클럭
//   CC[0] = 1000   → 1000 ticks @ 1MHz = 1ms
//   SHORTS: COMPARE0_CLEAR → CC[0] 도달 시 자동 리셋
//
// ISR 우선순위: APP_IRQ_PRIORITY_LOW (= 6)
//   SoftDevice는 우선순위 0~1을 사용하므로 6은 안전
// -------------------------------------------------------
#include "nrf.h"  // NRF_TIMER1, TIMER1_IRQn 등

extern "C" void TIMER1_IRQHandler(void) {
  if (NRF_TIMER1->EVENTS_COMPARE[0]) {
    NRF_TIMER1->EVENTS_COMPARE[0] = 0;
    matrix_scan_isr();
  }
}

static void matrix_init() {
  // ROW: OUTPUT HIGH (비활성)
  for (uint8_t r = 0; r < kMatrixRows; r++) {
    pinMode(kRowPins[r], OUTPUT);
    digitalWrite(kRowPins[r], HIGH);
  }
  // COL: INPUT_PULLUP
  for (uint8_t c = 0; c < kMatrixCols; c++) {
    pinMode(kColPins[c], INPUT_PULLUP);
  }

  // TIMER1 설정
  NRF_TIMER1->TASKS_STOP  = 1;
  NRF_TIMER1->TASKS_CLEAR = 1;
  NRF_TIMER1->MODE        = TIMER_MODE_MODE_Timer;
  NRF_TIMER1->BITMODE     = TIMER_BITMODE_BITMODE_32Bit;
  NRF_TIMER1->PRESCALER   = 4;       // 1MHz 클럭
  NRF_TIMER1->CC[0]       = 1000;    // 1ms
  NRF_TIMER1->SHORTS      = TIMER_SHORTS_COMPARE0_CLEAR_Msk;
  NRF_TIMER1->INTENSET    = TIMER_INTENSET_COMPARE0_Msk;

  NVIC_SetPriority(TIMER1_IRQn, 6);  // APP_IRQ_PRIORITY_LOW
  NVIC_EnableIRQ(TIMER1_IRQn);

  NRF_TIMER1->TASKS_START = 1;
}
```

- [ ] **Step 2: 빌드 확인 (아직 main.cpp에서 호출 안 함)**

```bash
platformio run --environment nice_nano_v2_compatible 2>&1 | tail -20
```
Expected: `SUCCESS`

- [ ] **Step 3: 커밋**

```bash
git add src/matrix.h
git commit -m "feat: add matrix scan ISR with debounce (TIMER1, 1ms)"
```

---

## Task 3: `main.cpp` — `#include "matrix.h"` 및 `matrix_init()` 호출

**Files:**
- Modify: `src/main.cpp`

**목표:** matrix.h를 main.cpp에 연결하고 `setup()`에서 초기화한다.

- [ ] **Step 1: `src/main.cpp` 상단 include 추가**

`src/main.cpp` 6번째 줄 (`using namespace` 앞) 에 추가:
```cpp
#include "matrix.h"
```

- [ ] **Step 2: `setup()` 마지막에 `matrix_init()` 호출 추가**

`src/main.cpp`의 `setup()` 함수 끝, `start_advertising();` 바로 앞에 추가:
```cpp
  // 물리 키보드 매트릭스 초기화
  matrix_init();
```

- [ ] **Step 3: 빌드 확인**

```bash
platformio run --environment nice_nano_v2_compatible 2>&1 | tail -20
```
Expected: `SUCCESS`

- [ ] **Step 4: 커밋**

```bash
git add src/main.cpp
git commit -m "feat: include matrix.h and call matrix_init() in setup()"
```

---

## Task 4: `flush_key_events()` 구현 및 `loop()` 통합

**Files:**
- Modify: `src/main.cpp`

**목표:** 큐에서 KeyEvent를 꺼내 `g_phys_modifier`/`g_phys_keycodes` 상태를 갱신하고 HID 리포트를 전송하는 `flush_key_events()`를 구현한다.

- [ ] **Step 1: `is_flushing()` 와 `flush_key_events()` 를 `main.cpp`의 `loop()` 위에 추가**

```cpp
// ByteFlusher가 진행 중인지 판별
static inline bool is_flushing() {
  return rb_used_bytes() > 0
      || stash_head != stash_tail
      || macro_used_bytes() > 0;
}

static void flush_key_events() {
  if (!hid_ready()) return;

  bool changed = false;
  KeyEvent ev;

  // 이벤트를 처리해 물리 키 상태(g_phys_modifier/g_phys_keycodes)는 항상 갱신한다.
  // HID 리포트 전송은 ByteFlusher가 유휴 상태일 때만 수행한다 (완전 격리 모드).
  while (key_event_pop(ev)) {
    uint8_t kc = kKeymap[ev.row][ev.col];
    if (kc == 0) continue;  // 키맵 미정의 (dummy) 무시

    if (is_modifier_keycode(kc)) {
      uint8_t bit = keycode_to_modifier_bit(kc);
      if (ev.pressed) {
        g_phys_modifier |= bit;
      } else {
        g_phys_modifier &= ~bit;
      }
      changed = true;
    } else {
      if (ev.pressed) {
        // 빈 슬롯에 추가 (최대 6키)
        for (int i = 0; i < 6; i++) {
          if (g_phys_keycodes[i] == 0) {
            g_phys_keycodes[i] = kc;
            changed = true;
            break;
          }
        }
      } else {
        // 슬롯에서 제거 후 컴팩션
        for (int i = 0; i < 6; i++) {
          if (g_phys_keycodes[i] == kc) {
            g_phys_keycodes[i] = 0;
            for (int j = i; j < 5; j++) {
              g_phys_keycodes[j] = g_phys_keycodes[j + 1];
            }
            g_phys_keycodes[5] = 0;
            changed = true;
            break;
          }
        }
      }
    }
  }

  // ByteFlusher 진행 중에는 물리 키 HID 리포트를 전송하지 않는다.
  // 플러시 종료 후 changed 상태가 남아 있으면 다음 루프에서 전송된다.
  if (changed && !is_flushing()) {
    usb_hid.keyboardReport(kReportIdKeyboard, g_phys_modifier, g_phys_keycodes);
  }
}
```

- [ ] **Step 2: `loop()` 에 `flush_key_events()` 호출 추가**

`src/main.cpp`의 `loop()` 내부, `enter_bootloader_if_requested_in_loop();` 바로 다음에 추가:
```cpp
  // 물리 키 이벤트 처리
  // NOTE: hid_ready() 가드 전에 위치한다.
  // USB 미준비 시에는 flush_key_events() 내부 hid_ready() 체크로 조기 반환.
  // g_paused 상태에서도 물리 키 입력은 동작해야 하므로 pause 가드 밖에 위치시킨다.
  flush_key_events();
```

- [ ] **Step 3: 빌드 확인**

```bash
platformio run --environment nice_nano_v2_compatible 2>&1 | tail -20
```
Expected: `SUCCESS`

- [ ] **Step 4: 커밋**

```bash
git add src/main.cpp
git commit -m "feat: add flush_key_events() and integrate into loop()"
```

---

## Task 5: `hid_send_key()` / `hid_tap_modifier()` 수정 — 물리 키 상태 복원

**Files:**
- Modify: `src/main.cpp` (lines ~248–300)

**목표:** ByteFlusher가 `keyboardRelease()` 대신 물리 키 상태를 포함한 리포트를 전송하도록 두 함수를 수정한다.

- [ ] **Step 1: `hid_send_key()` 수정**

기존:
```cpp
static void hid_send_key(uint8_t modifier, uint8_t keycode) {
  if (!hid_ready()) { return; }
  uint8_t keycodes[6] = {0};
  keycodes[0] = keycode;
  usb_hid.keyboardReport(kReportIdKeyboard, modifier, keycodes);
  delay(g_key_press_delay_ms);
  usb_hid.keyboardRelease(kReportIdKeyboard);
  delay(g_key_press_delay_ms);
}
```

수정 후:
```cpp
static void hid_send_key(uint8_t modifier, uint8_t keycode) {
  if (!hid_ready()) { return; }

  // ByteFlusher 진행 중에는 물리 키 상태를 병합하지 않는다 (완전 격리).
  // 진행 중이 아닐 때는 물리 키 홀드 상태를 유지하며 병합한다.
  const bool flushing = is_flushing();

  uint8_t keycodes[6] = {0};
  keycodes[0] = keycode;
  if (!flushing) merge_phys_keycodes(keycodes);

  usb_hid.keyboardReport(kReportIdKeyboard,
                          modifier | (flushing ? 0 : g_phys_modifier),
                          keycodes);
  delay(g_key_press_delay_ms);

  // 해제: ByteFlusher 키 제거, 물리 키 상태 복원 (플러시 중이면 빈 상태)
  usb_hid.keyboardReport(kReportIdKeyboard,
                          flushing ? 0 : g_phys_modifier,
                          flushing ? (uint8_t[6]){0} : g_phys_keycodes);
  delay(g_key_press_delay_ms);
}
```

- [ ] **Step 2: `hid_tap_modifier()` 수정**

기존:
```cpp
static void hid_tap_modifier(uint8_t modifier) {
  if (!hid_ready()) { return; }
  uint8_t keycodes[6] = {0};
  usb_hid.keyboardReport(kReportIdKeyboard, modifier, keycodes);
  delay(g_key_press_delay_ms);
  usb_hid.keyboardRelease(kReportIdKeyboard);
  delay(g_key_press_delay_ms);
}
```

수정 후:
```cpp
static void hid_tap_modifier(uint8_t modifier) {
  if (!hid_ready()) { return; }

  const bool flushing = is_flushing();

  uint8_t keycodes[6] = {0};
  if (!flushing) merge_phys_keycodes(keycodes);

  usb_hid.keyboardReport(kReportIdKeyboard,
                          modifier | (flushing ? 0 : g_phys_modifier),
                          keycodes);
  delay(g_key_press_delay_ms);

  // 해제: 물리 키 상태 복원 (플러시 중이면 빈 상태)
  uint8_t release_keycodes[6] = {0};
  if (!flushing) memcpy(release_keycodes, g_phys_keycodes, 6);
  usb_hid.keyboardReport(kReportIdKeyboard,
                          flushing ? 0 : g_phys_modifier,
                          release_keycodes);
  delay(g_key_press_delay_ms);
}
```

- [ ] **Step 3: 빌드 확인**

```bash
platformio run --environment nice_nano_v2_compatible 2>&1 | tail -20
```
Expected: `SUCCESS`

> **참고:** `hid_tap_toggle_key()`의 `case 6` (CapsLock)은 `hid_send_key()`를 호출하므로
> 이 Task의 수정에 의해 자동으로 물리 키 상태 복원이 적용된다. 별도 수정 불필요.

- [ ] **Step 4: 커밋**

```bash
git add src/main.cpp
git commit -m "fix: restore physical key state after ByteFlusher keyboardRelease"
```

---

## Task 6: `is_flush_idle()` 수정 — 물리 키 활동 조건 추가

**Files:**
- Modify: `src/main.cpp` (lines ~1303–1307)

**목표:** 물리 키가 눌린 동안 마우스 지글러가 동작하지 않도록 수정한다.

- [ ] **Step 1: `is_flush_idle()` 수정**

기존:
```cpp
static bool is_flush_idle() {
  return rb_used_bytes() == 0
      && stash_head == stash_tail
      && macro_used_bytes() == 0;
}
```

수정 후:
```cpp
static bool is_flush_idle() {
  return rb_used_bytes() == 0
      && stash_head == stash_tail
      && macro_used_bytes() == 0
      && g_phys_keycodes[0] == 0   // 물리 키가 눌리지 않은 상태
      && g_phys_modifier == 0;
}
```

- [ ] **Step 2: 빌드 확인**

```bash
platformio run --environment nice_nano_v2_compatible 2>&1 | tail -20
```
Expected: `SUCCESS`

- [ ] **Step 3: 커밋**

```bash
git add src/main.cpp
git commit -m "fix: suppress mouse jiggler while physical keys are held"
```

---

## Task 7: 핀맵 / 키맵 확정 (하드웨어 완료 후)

**Files:**
- Modify: `src/matrix.h` (kRowPins, kColPins, kKeymap)
- Create/Update: `docs/filco-matrix-pinmap.md`

**목표:** 실측한 핀맵과 키맵을 코드에 반영한다.

> Prerequisites 하드웨어 작업이 완료되어야 진행 가능

- [ ] **Step 1: `docs/filco-matrix-pinmap.md` 작성**

실측 결과를 문서화:
```markdown
# Filco FILCKTL12S Matrix Pinmap

| 핀 역할 | nRF52840 Arduino 핀 |
|---|---|
| ROW0 | ... |
| ROW1 | ... |
| ...  | ... |
| COL0 | ... |
| ...  | ... |

## 키 위치 표
| 키 | ROW | COL |
|---|---|---|
| ESC | 0 | 0 |
| ...  | ... | ... |
```

- [ ] **Step 2: `src/matrix.h`의 `kRowPins`, `kColPins` 실측값으로 교체**

`PLACEHOLDER` 주석이 달린 두 배열을 실측값으로 업데이트.

- [ ] **Step 3: `kKeymap` 완성**

ROW0~ROW5 전부를 실측 키 배치에 맞는 HID keycode로 채운다.
`HID_KEY_*` 상수 목록: [TinyUSB hid.h](https://github.com/hathach/tinyusb/blob/master/src/class/hid/hid.h)

- [ ] **Step 4: 빌드 확인**

```bash
platformio run --environment nice_nano_v2_compatible 2>&1 | tail -20
```
Expected: `SUCCESS`

- [ ] **Step 5: 커밋**

```bash
git add src/matrix.h docs/filco-matrix-pinmap.md
git commit -m "feat: set confirmed pinmap and keymap for Filco FILCKTL12S"
```

---

## Task 8: 플래시 및 물리 키 단독 테스트

> 하드웨어 배선 및 Task 1~7 완료 후 진행

- [ ] **Step 1: 펌웨어 업로드**

nRF52840 보드 RESET을 빠르게 2번 눌러 부트로더 모드 진입 후:
```powershell
# PowerShell (Windows)
$env:PIO_UPLOAD_PORT = "COM7"   # 실제 포트로 교체
platformio run --target upload --environment nice_nano_v2_compatible
```
```bash
# bash (Linux/macOS)
export PIO_UPLOAD_PORT=/dev/ttyACM0   # 실제 포트로 교체
platformio run --target upload --environment nice_nano_v2_compatible
```

- [ ] **Step 2: 물리 키 단독 테스트**

Target PC의 Notepad(또는 메모장)에서:
- 알파벳 모든 키 입력 확인 (a~z)
- 숫자열 입력 확인 (0~9)
- Shift + 알파벳 → 대문자 출력 확인
- 특수키 (Enter, Backspace, Tab, Space) 확인
- F1~F12, 방향키, Insert/Delete 등 확인

Expected: 모든 키가 올바른 문자를 입력

- [ ] **Step 3: 모디파이어 홀드 테스트**

Shift를 누른 채 알파벳을 여러 개 입력 → 전부 대문자
Ctrl+A → 전체 선택 동작 확인

---

## Task 9: ByteFlusher 단독 + 동시 테스트

- [ ] **Step 1: ByteFlusher 단독 테스트 (regression)**

웹 UI(https://aidanpark.github.io/src-byte-flusher/)에서:
- BLE 연결
- 텍스트 입력 후 Start → 정상 타이핑 확인
- Pause / Resume / Stop 동작 확인
- 한글 텍스트 입력 확인

Expected: 기존 동작과 동일

- [ ] **Step 2: 동시 동작 테스트 — BLE 플러시 중 물리 키 차단 확인**

BLE로 긴 텍스트(50자 이상) flush를 시작한 뒤:
1. 물리 알파벳 키를 여러 번 눌러도 → Target PC에 **아무 입력도 들어가지 않음** 확인
2. 물리 Shift를 홀드해도 → ByteFlusher 출력이 소문자 그대로 유지됨 확인
3. BLE 플러시 완료 직후 → 물리 키 상태가 즉시 복원되어 정상 타이핑 가능 확인
4. 플러시 완료 후 Shift가 여전히 눌려 있으면 → 대문자 모드로 정상 복원 확인

- [ ] **Step 3: 릴리즈 정확성 테스트**

BLE 플러시 진행 중 임의 물리 키를 눌렀다 뗀 후,
플러시 완료 후 해당 키가 "stuck" 상태가 아닌지 확인 (키보드 테스터 도구 활용)

---

## 알려진 제한사항

- BLE 플러시 진행 중 물리 키 입력은 완전 차단된다 (의도된 동작).
  플러시 완료 직후 현재 물리 키 상태가 즉시 복원된다.
- 큐 오버플로(32이벤트 초과) 시 신규 이벤트 드롭. 플러시 중 장시간 빠른 키 입력 시 드물게 발생.
  (플러시 중 물리 키 입력 자체가 무효이므로 실질적 영향 없음)
