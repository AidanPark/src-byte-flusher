# 🤖⌨️ Byte Flusher (BLE → USB HID)

브라우저(Web Bluetooth)에서 Flusher 보드(nRF52840)에 BLE로 텍스트를 전송하면,
보드가 Target PC에 USB HID 키보드 입력으로 **정확하게 끝까지** 타이핑하는 프로젝트입니다.

> 이 프로젝트의 최우선 목표는 **정확성**입니다. 속도는 부차적인 목표입니다.

---

## 📌 개요

- Control PC: Chrome/Edge 브라우저로 Flusher에 BLE 연결하여 제어
- Flusher: nRF52840 기반 보드(USB Device + BLE). BLE로 받은 데이터를 버퍼링하고 USB HID 키보드로 출력
- Target PC: Flusher가 USB 키보드로 입력을 수행하는 대상

```
[ Control PC (Chrome/Edge) ]
				|  BLE (Web Bluetooth)
				v
[ Flusher (nRF52840) ]
				|  USB HID Keyboard
				v
[ Target PC ]
```

---

## ✅ 주요 기능

- ✅ **긴 텍스트 타이핑**: 브라우저에서 입력한 텍스트를 Target PC로 자동 타이핑
- ✅ **한글 지원**: 한글 음절(가~힣) + ASCII(영문/숫자/기호/개행/탭)
- ✅ **정확성 우선 전송**: BLE `Write with response` + 재연결/재시도 + 중복 방지(sessionId/seq)
- ✅ **Flow Control**: 디바이스 RX 버퍼 여유를 Status(READ+NOTIFY)로 받아서 웹이 전송 속도를 자동 조절
- ✅ **진짜 Pause/Resume**: Pause 시 디바이스가 즉시 타이핑을 멈춤(큐는 유지)
- ✅ **Stop 즉시폐기**: Stop 시 디바이스 RX 큐를 즉시 비우고 내부 상태를 리셋(남은 입력 폐기)
- ✅ **전송 전처리 옵션**: 줄 시작 공백/탭 무시(웹에서 전송 전에 제거)

---

## 🎯 사용 사례

- 긴 코드/스크립트/설정값을 Target PC에 "타이핑"으로 입력해야 할 때
- 네트워크가 제한된 환경에서, 파일 복사 없이 텍스트를 정확히 주입해야 할 때
- 데모/교육에서 동일한 텍스트를 반복 입력해야 할 때

---

## 🧩 지원 보드 / 구매 가이드 (중요)

### 필수 조건

- **MCU가 nRF52840** 이어야 합니다.
	- BLE(2.4GHz) + **Native USB Device**가 동시에 필요합니다.
	- nRF52832 등(USB 없는 칩)은 대상이 아닙니다.

### 추천/확인된 호환 계열

- Pro Micro 폼팩터의 nRF52840 보드 (알리에서 흔히 "nRF52840 Pro Micro" / "SuperMini nRF52840" 등으로 판매)
- nice!nano v2 호환 계열
- Adafruit Feather nRF52840 계열(개발/검증이 쉬움)

### PlatformIO 환경과 보드 설정

이 저장소는 PlatformIO `nordicnrf52` 플랫폼을 사용합니다.

- 기본 빌드 환경은 [platformio.ini](platformio.ini) 의 `nice_nano_v2_compatible` 입니다.
	- `board = adafruit_feather_nrf52840` 로 빌드하도록 되어 있습니다.
	- 일부 "nice!nano v2 호환" 보드는 PlatformIO에 보드 ID가 없어서,
		**부트로더/VID-PID가 Feather 계열과 유사한 경우** 이렇게 우회하는 구성이 실사용에 유리했습니다.

다른 보드를 쓴다면,
1) VS Code PlatformIO 확장 → Boards에서 보드 ID 검색
2) [platformio.ini](platformio.ini) 에 새 env를 만들고 `board = ...`만 바꿔서 빌드/업로드하세요.

예시 후보(보드에 따라 다름):
- `adafruit_feather_nrf52840`
- `adafruit_itsybitsy_nrf52840`
- `seeed_xiao_nrf52840`

### 업로드 팁

- 다수의 nRF52 보드는 **RESET 더블탭**으로 부트로더 모드 진입합니다.
- 부트로더 진입 시 COM 포트가 바뀌는 경우가 많습니다.

### Windows에서 "이 보드가 맞는지" 확인(체크리스트)

알리/호환 보드는 판매 페이지 설명이 부정확한 경우가 많아서,
Windows에서 **칩/부트로더 계열을 빠르게 판별**하는 방법을 권장합니다.

1) **장치 관리자** 열기
- Win+X → 장치 관리자

2) 보드를 USB로 연결한 상태에서 아래 항목을 확인
- "포트(COM 및 LPT)"에 새 COM 포트가 생기는지
- "범용 직렬 버스 장치"에 새 장치가 잡히는지

3) (가능하면) **부트로더 모드**로 진입해서 한 번 더 확인
- 보드 RESET을 빠르게 2번(더블탭)
- 부트로더 모드에서는 **COM 포트/장치명이 바뀌는 경우**가 흔합니다.

4) VID/PID(하드웨어 ID) 확인
- 장치 우클릭 → 속성 → "자세히" 탭 → "하드웨어 ID"
- `VID_xxxx` / `PID_yyyy` 값을 확인합니다.

참고(대표 예시):
- Adafruit nRF52 계열(Feather 등)은 제조사 VID(예: `239A`)로 잡히는 경우가 많습니다.
- "nice!nano v2 호환" 보드 중 일부는 Feather 계열과 비슷한 VID/PID 및 부트로더 동작을 보여,
  PlatformIO에서 `adafruit_feather_nrf52840` 보드 정의로 빌드/업로드가 잘 되는 케이스가 있었습니다.

5) UF2 드라이브가 뜨는지 확인(선택)
- 보드가 UF2 부트로더를 사용하면, 부트로더 모드에서 USB 드라이브가 나타나는 경우가 있습니다.
- 드라이브가 뜨는지 여부는 보드/부트로더 종류를 추정하는 단서가 됩니다.

#### PowerShell로 VID/PID 빠르게 보기(옵션)

장치 관리자 UI 대신, PowerShell로도 힌트를 얻을 수 있습니다.

- 연결된 USB 장치 중에서 VID/PID 패턴이 있는 항목만 보기
	- `Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_[0-9A-F]{4}&PID_[0-9A-F]{4}' } | Select-Object -First 50 -Property Status,Class,FriendlyName,InstanceId`

- 특정 VID(예: 239A)로 필터링하기
	- `Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_239A' } | Format-Table -AutoSize Status,Class,FriendlyName,InstanceId`

> 환경에 따라 FriendlyName/InstanceId 표시가 다를 수 있습니다. 그래도 `VID_XXXX&PID_YYYY`가 보이면 큰 단서가 됩니다.

> 위 체크리스트는 "정확한 식별"을 보장하진 않지만,
> 최소한 nRF52840 + USB Device + 적절한 부트로더 계열인지 빠르게 거르는 데 도움됩니다.

---

## 🚀 빠른 시작 (사용 방법)

### 1) 펌웨어 빌드/업로드

- 빌드:
	- `platformio run --environment nice_nano_v2_compatible`
- 업로드:
	- `platformio run --target upload --environment nice_nano_v2_compatible`

### 2) 웹 UI 실행(필수: HTTPS 또는 localhost)

가장 간단한 방법(권장):

- GitHub Pages 컨트롤 페이지로 접속
	- https://aidanpark.github.io/byteflusher/
	- 여기에서 Flusher에 연결하고 Start/Pause/Resume/Stop을 제어합니다.

Web Bluetooth는 보안 컨텍스트가 필요하므로 `file://` 로 열면 정상 동작하지 않습니다.

간단한 방법(로컬):

- PowerShell에서 프로젝트 루트에서 실행
	- `python -m http.server 8080`
- 브라우저에서 접속
	- `http://localhost:8080/web/`

### 3) 실제 사용 흐름

1. Flusher를 Target PC에 USB로 연결(키보드로 인식되어야 함)
2. Control PC에서 웹 페이지 접속 후 [장치 연결]
   - 동일한 보드가 여러 대라면, 선택 목록에서 `ByteFlusher-XXXX` 형태의 이름으로 구분합니다(XXXX는 보드 고유값 기반).
   - 연결 후 상태 표시줄에 `id=...`가 함께 표시되어, 같은 이름이어도 구분에 도움이 됩니다.
3. Target PC의 입력 위치에 커서를 올려둠
4. Target PC 입력기를 **영문 상태**로 맞춤(초기 동기화는 환경마다 다를 수 있음)
5. 텍스트 입력 후 [Start]
6. 필요 시
	 - Pause: 즉시 멈춤(큐 유지)
	 - Resume: 이어서 진행
	 - Stop: 즉시폐기(남은 큐 삭제)

---

## ⚙️ 웹 설정(중요)

웹 UI는 [web/index.html](web/index.html) / [web/app.js](web/app.js) 로 구성되어 있습니다.

- 전송설정
	- Chunk(bytes) / Delay(ms): BLE 구간 전송 분할/대기
	- Retry Delay(ms): 연결 끊김 시 재시도 간격
- 입력설정
	- 한/영 전환키: Right Alt(Windows) / CapsLock(mac) 등
	- 라인 시작 공백/탭 무시: 각 줄 맨 앞의 공백/탭을 전송 전에 제거
	- 타이핑 딜레이(보드): Typing/Mode Switch/Key Press

> 정확성 최우선이면: Typing Delay / Mode Switch Delay를 충분히 크게 유지하는 것을 권장합니다.

---

## 📡 BLE UUID / 프로토콜

서비스 UUID(고정):
- `f3641400-00b0-4240-ba50-05ca45bf8abc`

### 1) Flush Text Characteristic

- UUID: `f3641401-00b0-4240-ba50-05ca45bf8abc`
- 속성: Write (with response)
- 패킷 포맷(LE):
	- `[sessionId(u16)][seq(u16)][payload(bytes...)]`
- 목적:
	- 긴 텍스트를 청크로 나눠 전송
	- BT 끊김/재시도 시 같은 청크를 재전송하더라도 **중복 타이핑을 방지**

### 2) Config Characteristic

- UUID: `f3641402-00b0-4240-ba50-05ca45bf8abc`
- 속성: Write (with response)
- 포맷(LE): `[typingDelayMs(u16)][modeSwitchDelayMs(u16)][keyPressDelayMs(u16)][toggleKey(u8)][flags(u8)]`
- `flags`:
	- bit0: Pause (1=paused)
	- bit1: Abort (1=즉시폐기: RX 큐 clear + 내부 디코더 상태 리셋)

### 3) Status Characteristic (Flow Control)

- UUID: `f3641403-00b0-4240-ba50-05ca45bf8abc`
- 속성: Read + Notify
- 포맷(LE): `[capacityBytes(u16)][freeBytes(u16)]`
- 목적:
	- 웹이 디바이스 버퍼에 여유가 있을 때만 전송하도록 제한하여,
		**Pause/Stop이 "진짜 즉시" 동작**하고 정확성이 유지되게 함

---

## 🧪 권장 테스트(정확성 확인)

- 긴 텍스트로 Start → Pause: 즉시 멈추는지
- Pause 중 Resume: 이어서 정상 진행되는지(누락/중복 없는지)
- Start 중 Stop: 즉시 멈추고 이후 추가 타이핑이 더 나오지 않는지
- Stop 후 다시 Start: 이전 잔여 영향(중간 상태) 없이 정상인지

---

## 🔧 문제 해결

### "장치 연결"이 안 됨
- Chrome/Edge 사용 확인 (다른 브라우저는 Web Bluetooth 미지원/제한)
- 페이지가 `https://` 또는 `http://localhost` 인지 확인
- OS Bluetooth 권한/드라이버 확인

### 타이핑이 씹히거나 순서가 꼬임
- Target PC에서 자동완성/자동 들여쓰기/자동 괄호닫기 기능이 강한 IDE는 충돌 가능성이 큽니다.
	- 메모장/간단한 텍스트 에디터에서 먼저 검증 권장
- 보드 설정에서 Typing Delay / Mode Switch Delay를 늘려보세요.

### Pause/Stop이 즉시 반응하지 않음
- 펌웨어가 최신인지 확인하세요(이 README 기준 펌웨어 버전: 1.0.3)
- Status(Flow Control) 특성이 정상 동작해야 합니다.

---

## 📄 라이선스

별도 명시가 없다면 저장소의 라이선스 정책을 따릅니다.
