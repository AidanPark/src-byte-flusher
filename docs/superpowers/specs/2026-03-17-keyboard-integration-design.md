# Keyboard Integration Design
Date: 2026-03-17

## Overview

Filco TKL(FILCKTL12S) 키보드의 기존 컨트롤러를 nRF52840 보드로 교체하여,
물리 키보드 입력과 ByteFlusher(BLE → USB HID) 기능을 하나의 장치에서 동시에 동작시킨다.

---

## Goals

- Filco TKL 키보드를 정상 USB HID 키보드로 동작시킨다.
- 동시에 ByteFlusher BLE 서비스를 유지하여, 기존 웹 UI에서 텍스트/파일 플러시가 가능하다.
- 물리 키 입력과 ByteFlusher 타이핑이 서로 블로킹 없이 동작한다.

## Non-Goals

- ZMK/QMK 기반 키보드 지원 (이 설계는 Filco 직접 교체에 한정)
- 무선(BLE HID) 키보드 기능 (USB HID만 지원)
- 키 리매핑 / 레이어 / 매크로 등 고급 키보드 기능

---

## Hardware Plan

### 준비물

- Filco FILCKTL12S (TKL 87키)
- nRF52840 Pro Micro 폼팩터 보드 (nice!nano v2 호환)
- 멀티미터
- 납땜 도구

### 작업 순서

1. Filco 키보드 분해
   - 하단 케이스 나사 제거 → PCB 노출
   - 기존 컨트롤러 칩 식별 (Holtek 계열 등)

2. 키 매트릭스 핀맵 추적
   - 멀티미터 도통 테스트로 ROW/COL 핀 식별
   - TKL 기준 예상: ROW 6개, COL 14~16개
   - 각 키의 (ROW, COL) 위치를 표로 정리
   - **핀 번호 표기는 Arduino 핀 번호 기준** (PlatformIO/Adafruit nRF52 BSP 기준)
   - nRF52840 예약 핀 주의: USB D+/D- (P0.13/P0.15 등 BSP 정의 확인), SWD 핀, 32MHz 크리스탈 핀은 GPIO로 사용 불가

3. 기존 컨트롤러 분리
   - 컨트롤러 칩 제거 또는 매트릭스 연결 핀만 절단
   - USB 데이터 라인은 nRF52840 보드의 USB 커넥터를 직접 사용 (케이스 밖으로 인출)

4. nRF52840 배선
   - ROW 핀 → nRF52840 GPIO (OUTPUT, active-low 구동)
   - COL 핀 → nRF52840 GPIO (INPUT_PULLUP)

### 핀맵 (실측 후 확정)

```cpp
// 예시 — 실제 값은 매트릭스 추적 후 채울 것
static constexpr uint8_t kMatrixRows = 6;
static constexpr uint8_t kMatrixCols = 16;
static constexpr uint8_t kRowPins[kMatrixRows] = { A0, A1, A2, A3, 15, 14 };
static constexpr uint8_t kColPins[kMatrixCols] = { 2, 3, 4, 5, 6, 7, 8, 9, 10, 16, 17, 18, 19, 20, 21, 22 };
```

---

## Firmware Design

### Architecture

```
하드웨어 타이머 ISR (1ms 주기, TIMER1 사용)
  └── 매트릭스 스캔 + 디바운스 → key_event_queue에 push

loop()
  ├── apply_pending_controls_in_loop()   (기존)
  ├── enter_bootloader_if_requested()    (기존)
  ├── [NEW] flush_key_events()           ← 물리 키 HID 리포트 전송
  ├── try_jiggle_mouse()                 (기존, 물리 키 활동도 고려)
  └── ByteFlusher drain/macro 처리      (기존)
```

### nRF52840 타이머 선택 및 ISR 우선순위

- **TIMER0은 SoftDevice가 점유** → 사용 불가
- **TIMER1, TIMER2, TIMER3, TIMER4** 중 하나 사용 (TIMER1 권장)
- ISR 우선순위는 SoftDevice IRQ 레벨보다 낮게 설정해야 함
  (`APP_IRQ_PRIORITY_LOW` 또는 Adafruit BSP의 `HardwarePWM` 우선순위 참고)
- Adafruit nRF52 Arduino 코어에서 `HardwareTimer` 클래스 또는 nRF5 SDK `nrf_drv_timer` 사용

### 매트릭스 스캔 및 디바운스 (ISR)

- 1ms마다 ROW를 순서대로 LOW로 구동하며 COL 상태 읽기
- **디바운스**: 동일 상태가 3회 연속 읽혀야 이벤트로 확정 (3ms 안정화)
  - 키당 debounce counter 유지: `uint8_t debounce[ROW][COL]`
- press/release 이벤트를 `key_event_queue`에 push
- ISR에서는 USB HID 전송 하지 않음 (큐에만 넣음)

### key_event_queue 명세

```cpp
struct KeyEvent {
  uint8_t row;
  uint8_t col;
  bool    pressed;
};

constexpr size_t kKeyEventQueueSize = 32;  // 최대 32 이벤트 버퍼링
KeyEvent key_event_queue[kKeyEventQueueSize];
volatile size_t key_event_head = 0;
volatile size_t key_event_tail = 0;
```

- **인덱스 타입**: `size_t` (32비트 Cortex-M4에서 원자적 읽기/쓰기 보장)
- **오버플로 정책**: 큐가 가득 찼을 때 새 이벤트를 **드롭** (오래된 이벤트 유지)
  - 드롭 발생 시 별도 처리 없음 (최악의 경우 키 하나가 씹히는 수준)

### 물리 키 HID 상태 관리

```cpp
static uint8_t g_phys_modifier = 0;       // 현재 눌린 물리 모디파이어
static uint8_t g_phys_keycodes[6] = {0};  // 현재 눌린 물리 키 (최대 6키)
```

`flush_key_events()`에서 이벤트를 처리하며 위 상태를 갱신하고,
변화가 있을 때만 HID 리포트를 전송한다.

### ByteFlusher와의 HID 리포트 병합

ByteFlusher의 `hid_send_key()`는 내부적으로:
```
keyboardReport(modifier, keycode)  ← 키 누름
delay(key_press_ms)
keyboardRelease()                  ← 모든 키 해제
```
를 수행한다. `keyboardRelease()`는 **모든 키를 해제**하므로,
물리 키가 눌린 상태에서 ByteFlusher가 `keyboardRelease()`를 호출하면
물리 키의 "홀드 상태"가 끊긴다.

**해결 방법**: `keyboardRelease()` 대신 "물리 키 상태만 담은 리포트"를 전송한다.

`hid_send_key()`를 아래와 같이 수정:
```cpp
static void hid_send_key(uint8_t modifier, uint8_t keycode) {
  // 누름: 물리 키 상태 + ByteFlusher 키 병합
  uint8_t merged_modifier = modifier | g_phys_modifier;
  uint8_t keycodes[6] = {0};
  keycodes[0] = keycode;
  // g_phys_keycodes 병합 (빈 슬롯에 추가)
  merge_phys_keycodes(keycodes);
  usb_hid.keyboardReport(kReportIdKeyboard, merged_modifier, keycodes);
  delay(g_key_press_delay_ms);

  // 해제: ByteFlusher 키만 제거, 물리 키 상태 유지
  usb_hid.keyboardReport(kReportIdKeyboard, g_phys_modifier, g_phys_keycodes);
  delay(g_key_press_delay_ms);
}
```

이 방식으로 ByteFlusher 타이핑 중에도 물리 키 홀드 상태가 유지된다.

`hid_tap_modifier()`도 동일하게 수정해야 한다. 이 함수는 한/영 전환 시 호출되며
마찬가지로 `keyboardRelease()`를 호출하므로 물리 키 상태를 덮어쓴다:

```cpp
static void hid_tap_modifier(uint8_t modifier) {
  // 누름
  uint8_t keycodes[6] = {0};
  merge_phys_keycodes(keycodes);
  usb_hid.keyboardReport(kReportIdKeyboard, modifier | g_phys_modifier, keycodes);
  delay(g_key_press_delay_ms);

  // 해제: ByteFlusher modifier만 제거, 물리 키 상태 복원
  usb_hid.keyboardReport(kReportIdKeyboard, g_phys_modifier, g_phys_keycodes);
  delay(g_key_press_delay_ms);
}
```

### delay() 블로킹 중 물리 키 응답 지연

현재 ByteFlusher는 `delay()`를 빈번하게 사용한다:
- 키당: `key_press_delay_ms` × 2 (기본 10ms × 2 = 20ms)
- 글자당: `typing_delay_ms` (기본 30ms)
- 한/영 전환: `mode_switch_delay_ms` (기본 100ms)

`loop()`의 `flush_key_events()`는 `delay()` 블로킹 중에 실행되지 않는다.
따라서 **BLE 플러시 진행 중 물리 키 리포트 전송이 최대 수십~수백ms 지연될 수 있다.**

ISR은 계속 스캔하므로 이벤트는 큐에 쌓이고, `delay()` 종료 후 `loop()`이 돌아올 때 일괄 처리된다.
이는 알려진 제한사항이며, 허용 가능한 범위로 판단한다:
- BLE 플러시 중 물리 키보드로 별도 입력을 할 일은 드물다.
- 큐 크기(32) × 스캔주기(1ms) = 32ms 이내 이벤트는 유실 없이 버퍼링된다.

### 물리 키 차단 (ByteFlusher 진행 중)

ByteFlusher가 활성(RX 버퍼/스태시/매크로 큐에 데이터 있음)일 때,
물리 키 입력이 섞여 들어가는 것을 방지하기 위해 **완전 격리 모드**를 적용한다.

```cpp
static inline bool is_flushing() {
  return rb_used_bytes() > 0
      || stash_head != stash_tail
      || macro_used_bytes() > 0;
}
```

격리 정책:
- `flush_key_events()`: 이벤트를 처리해 `g_phys_modifier`/`g_phys_keycodes` 상태는 갱신하되,
  `is_flushing()` 동안에는 HID 리포트를 전송하지 않는다.
  (플러시 종료 후 현재 물리 키 상태가 즉시 반영됨)
- `hid_send_key()` / `hid_tap_modifier()`: `is_flushing()` 동안에는 물리 키 상태를 병합하지 않는다.
  ByteFlusher가 보내는 텍스트에 물리 키가 영향을 주지 않는다.

결과: ByteFlusher 진행 중에는 물리 키를 눌러도 Target PC에 아무 입력도 가지 않는다.
플러시가 끝나는 즉시 물리 키 상태가 정상 복원된다.

### 모디파이어 키 병합

ByteFlusher 타이핑 중에는 물리 키가 차단되므로 병합이 발생하지 않는다.
플러시 완료 후 `g_phys_modifier`/`g_phys_keycodes` 현재 상태가 그대로 전송된다.

### 마우스 지글러

`is_flush_idle()`에 물리 키 활동 조건 추가:
```cpp
static bool is_flush_idle() {
  return rb_used_bytes() == 0
      && stash_head == stash_tail
      && macro_used_bytes() == 0
      && g_phys_keycodes[0] == 0  // [NEW] 물리 키가 눌리지 않은 상태
      && g_phys_modifier == 0;    // [NEW]
}
```

### 키맵 테이블

```cpp
// Filco TKL US 배열 기준 HID keycode 테이블
// 실측 핀맵 확정 후 채울 것 — 개발/검증 중에는 dummy 값 사용 가능
static const uint8_t kKeymap[kMatrixRows][kMatrixCols] = {
  // ROW0: { col0, col1, ... col15 }
  { HID_KEY_ESCAPE, HID_KEY_F1, ... },
  ...
};
```

- 핀맵 확정 전 초기 검증용 dummy 키맵을 먼저 정의해도 매트릭스 스캔 로직 자체를 테스트할 수 있음

---

## File Changes

| 파일 | 변경 내용 |
|---|---|
| `src/main.cpp` | 매트릭스 스캔, 키 이벤트 큐, `flush_key_events()`, 키맵 테이블, `hid_send_key()` 수정, `is_flush_idle()` 수정 추가 |
| `src/matrix.h` (선택) | 코드 분량이 커지면 매트릭스/키맵 관련 코드를 별도 헤더로 분리 권장 |
| `platformio.ini` | 필요 시 핀 정의 관련 빌드 플래그 추가 |

> `main.cpp`는 현재 1389줄이다. 키맵(6×16), 스캔 코드, 큐 구현을 모두 합산하면
> 300~400줄이 추가될 것으로 예상. `src/matrix.h` 분리를 권장한다.

---

## Implementation Steps

1. **[Hardware]** Filco 분해 및 매트릭스 핀맵 실측
   - ROW/COL 핀 번호 확정 → `kRowPins[]`, `kColPins[]` 작성
2. **[Firmware]** `src/matrix.h` 생성: 핀 상수, keymap 테이블, KeyEvent 구조체, 큐
3. **[Firmware]** 하드웨어 타이머(TIMER1) ISR 설정 + 매트릭스 스캔 + 디바운스 구현
4. **[Firmware]** `flush_key_events()` 구현 및 `loop()`에 통합
5. **[Firmware]** `hid_send_key()` 수정: ByteFlusher 릴리즈 시 물리 키 상태 복원
6. **[Firmware]** `is_flush_idle()` 수정: 물리 키 활동 조건 추가
7. **[Test]** 물리 키 단독 동작 확인 (Notepad에서 모든 키 입력 테스트)
8. **[Test]** ByteFlusher 단독 동작 확인 (기존 기능 regression)
9. **[Test]** 동시 동작 확인
   - BLE 플러시 중 물리 Shift 홀드 → 대문자 출력 확인
   - BLE 플러시 중 물리 키 홀드 → 키 홀드 상태 유지 확인
   - BLE 플러시 중 물리 키 릴리즈 → 릴리즈 정상 전송 확인

---

## Risks

| 리스크 | 대응 |
|---|---|
| 매트릭스 핀맵 추적 실패 | GeekHack/Reddit에서 동일 모델 분해 사례 검색 후 참고 |
| nRF52840 GPIO 수 부족 | TKL ROW 6 + COL 16 = 22핀, nRF52840은 충분 (30+ GPIO) |
| SoftDevice 타이머 충돌 | TIMER0 사용 금지, TIMER1 사용. ISR 우선순위 APP_IRQ_PRIORITY_LOW 이하로 설정 |
| ByteFlusher 타이핑 중 물리 키 릴리즈 누락 | `hid_send_key()` 수정으로 릴리즈 시 물리 키 상태 복원 |
| 기존 Filco PCB USB 라인 재활용 불가 | nRF52840 보드의 USB 커넥터를 케이스 밖으로 인출 |
| 예약 핀 사용으로 부팅 실패 | BSP 문서에서 USB D+/D-, SWD, 크리스탈 핀 확인 후 배선 |
