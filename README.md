# 🤖⌨️ Byte Flusher (BLE → USB HID)

ByteFlusher는 Web Bluetooth(BLE)로 텍스트/파일을 전송하면, nRF52840 보드가 USB HID 키보드 입력으로 Target PC에 **정확하게 끝까지** 타이핑/생성하는 도구입니다.

## 🔗 Links

- Web UI (GitHub Pages): https://aidanpark.github.io/byteflusher/
- Text Flush UI: [web/text.html](web/text.html)
- File Flush UI: [web/files.html](web/files.html)
- Build/Flash: [빠른 시작](#-빠른-시작-사용-방법)
- How it works: [개요](#-개요)
- Troubleshooting: [문제 해결](#-문제-해결)

Firmware version: **1.1.34**

## 🖥️ Web UI 미리보기

[Text Flush UI](web/text.html)

![Byte Flusher Text Flush UI preview (Web Bluetooth BLE to USB HID keyboard automatic typing)](docs/ui_text_preview.png)

[File Flush UI](web/files.html)

![Byte Flusher File Flush UI preview (Base64 over BLE, PowerShell decode, SHA-256 verify)](docs/ui_files_preview.png)

## 📚 문서(Q&A)

- Docs index (HTML): https://aidanpark.github.io/byteflusher/docs/
- 정확성(Accuracy) 우선 설계/제약: [HTML](https://aidanpark.github.io/byteflusher/docs/accuracy-design.html) / [MD](docs/accuracy-design.md)
- 텍스트 누락/깨짐 체크리스트: [HTML](https://aidanpark.github.io/byteflusher/docs/troubleshooting-missing-text.html) / [MD](docs/troubleshooting-missing-text.md)
- IME/레이아웃(한글/영문) 이슈: [HTML](https://aidanpark.github.io/byteflusher/docs/ime-layout-issues.html) / [MD](docs/ime-layout-issues.md)
- PlatformIO 빌드/업로드 문제 해결: [HTML](https://aidanpark.github.io/byteflusher/docs/platformio-build-upload.html) / [MD](docs/platformio-build-upload.md)
- Target PC에서 COM 포트 없이(HID-only) 사용하기: [HTML](https://aidanpark.github.io/byteflusher/docs/hid-only-target-build.html) / [MD](docs/hid-only-target-build.md)

## ⚠️ 사용 범위 / 법적 고지 (중요)

- 이 프로젝트는 **본인 소유/관리 시스템** 또는 **명시적으로 허가받은 환경**에서의 테스트/개발 자동화/데모 목적 사용을 전제로 합니다.
- 무단 접근, 보안 우회, 계정/권한 탈취, 타인 시스템에 대한 비인가 입력 등 **불법/비윤리적 목적**으로 사용하지 마세요.
- USB HID 키보드 입력은 “사람이 타이핑하는 것”처럼 동작하므로, 포커스 이동/팝업/UAC/알림 등에 의해 **의도치 않은 위치에 입력**될 수 있습니다. 반드시 안전한 테스트 환경에서 검증 후 사용하세요.
- 이 도구의 사용 및 사용 결과(데이터 손실/오입력/업무 영향 등)에 대한 책임은 사용자에게 있습니다.

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

- ✅ **Text Flusher(텍스트 Flush)**
	- 브라우저에서 입력한 텍스트를 Target PC로 정확하게 타이핑
	- 한글 음절(가~힣) + ASCII(영문/숫자/기호/개행/탭)

- ✅ **File Flusher(파일/폴더 Flush, Windows 전용)**
	- Control PC(브라우저)에서 파일/폴더를 선택하면, Target PC에 동일한 파일을 생성
	- 구현 방식: Base64(ASCII) 전송 → Target PC의 PowerShell에서 디코드하여 바이트 그대로 저장 → SHA-256 검증
	- 이미지/zip/exe 같은 바이너리 파일도 가능(종류 제한보다 “전송 시간/포커스 안정성”이 제한 요소)

- ✅ **정확성 우선 전송(공통)**
	- BLE `Write with response` + 재연결/재시도 + 중복 방지(sessionId/seq)
	- Flow Control: 디바이스 RX 버퍼 여유를 Status(READ+NOTIFY)로 받아 웹이 전송 속도 자동 조절
	- Pause/Resume: Pause 시 디바이스가 즉시 타이핑을 멈춤(큐는 유지)
	- Stop: 디바이스 RX 큐를 즉시 비우고 내부 상태를 리셋(남은 입력 폐기)

---

## 🎯 사용 사례

- 긴 코드/스크립트/설정값을 Target PC에 **"타이핑"으로 정확히 입력**해야 할 때
- 네트워크/클립보드/파일 전송이 제한된 환경에서, **텍스트를 안전하게 주입**해야 할 때
- 데모/교육/테스트에서 동일한 텍스트를 **반복 입력(재현성)** 해야 할 때
- (Windows) 파일을 직접 복사하기 어려운 상황에서, **PowerShell로 파일을 생성/검증**해야 할 때

사람들이 실제로 검색하는 문장 예시:
- "원격 PC에 텍스트를 정확히 입력하는 방법"
- "USB HID 키보드로 대량 텍스트 자동 타이핑"
- "Web Bluetooth BLE로 텍스트 전송해서 PC에 입력"

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

예시(실제 테스트 보드):

![Example device (Pro Micro NRF52840)](docs/device_board.webp)

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
	- `http://localhost:8080/`

### 2-1) 모바일에서 사용하기(Control PC를 폰으로)

이 프로젝트의 웹 UI는 기본적으로 **Web Bluetooth** 기반입니다.

#### Android (권장)

- Android Chrome/Edge는 Web Bluetooth를 지원하는 편이라, 폰을 Control PC로 쓰기 쉽습니다.
- 연결이 안 되면:
	- 블루투스 권한/근처 기기(스캔) 권한 허용
	- 페이지가 `https://` 인지 확인(GitHub Pages는 OK)
	- 다른 탭/기기에서 이미 같은 장치에 연결 중인지 확인

#### iPhone / iOS (Safari/Chrome는 기본적으로 불가)

- iOS의 Safari/Chrome는 같은 WebKit 엔진이라, 일반적으로 Web Bluetooth가 동작하지 않습니다.
- 대안: iOS에서 Web BLE 브릿지를 제공하는 서드파티 앱을 사용합니다.
	- 검증된 앱: **BLE Link - Web BLE Browser**
		- App Store: https://apps.apple.com/kr/app/ble-link-web-ble-browser/id6468414672

iOS에서 연결 절차(예시):
1. 위 앱 설치
2. iOS 설정에서 해당 앱의 Bluetooth 권한 허용
3. 앱 안에서 https://aidanpark.github.io/byteflusher/ 접속
4. [장치 연결] → `ByteFlusher-XXXX` 선택

주의(정확성/안정성):
- iOS는 백그라운드 전환/화면 꺼짐 시 BLE가 끊길 수 있어, **앱을 전면 유지 + 화면 켜둔 채**로 진행 권장
- File Flusher는 파일 선택/브라우저 메모리/권한 정책 영향이 커서, 모바일에서는 **Text Flusher 위주**로 먼저 검증 권장

### 3) 실제 사용 흐름

#### A) Text Flusher (텍스트 Flush)

페이지: [web/text.html](web/text.html)

1. Flusher를 Target PC에 USB로 연결(키보드로 인식되어야 함)
2. Control PC에서 페이지 접속 후 [장치 연결]
3. Target PC의 입력 위치(에디터/터미널 등)에 커서를 올려둠
4. Target PC 입력기를 **영문 상태**로 맞춤(초기 동기화는 환경마다 다를 수 있음)
5. 텍스트 입력 후 [Start]
6. 필요 시
	 - Pause: 즉시 멈춤(큐 유지)
	 - Resume: 이어서 진행
	 - Stop: 즉시폐기(남은 큐 삭제)

#### B) File Flusher (파일/폴더 Flush, Windows 전용)

페이지: [web/files.html](web/files.html)

1. (중요) Target PC는 **Windows + PowerShell**이 가능해야 함
2. Target Directory 입력
   - 현재 UI 제약(정확성 우선): **Windows 절대경로 + 공백 불가 + 영문(ASCII)만**
3. 파일 1개 또는 폴더 1개 선택
4. [Start]
   - 장치가 Win+R → PowerShell 실행까지 자동으로 수행
	- Run(Win+R)에는 PowerShell 실행만 입력하고, 런처/부트스트랩은 PowerShell 내부로 청크 전송해 조립/실행
	- PowerShell에서 Base64를 디코드해 파일을 생성하고, SHA-256 해시로 검증

참고
- 부트스트랩 청크 조립용 임시 파일은 `%TEMP%` 아래에 잠깐 생성되며, 부트스트랩 실행 직후 자동 삭제됩니다.
- 파일 경로는 Base64(UTF-16LE)로 전달되어 한글/유니코드 파일명도 안정성을 높였습니다.
- 진단 로그 옵션을 켜면, 실패 시 `targetDir\.tmp\bf_last_error.txt`가 생성될 수 있습니다.

주의(정확성/안정성)
- 실행 중에는 Target PC 포커스를 다른 앱으로 빼앗기지 않게 유지하세요(알림/IME 팝업/자동완성 등)
- 파일이 커질수록 Base64 길이가 늘어나 전송 시간이 길어집니다(대략 1.33배)

추가 팁
- 동일한 보드가 여러 대라면, 선택 목록에서 `ByteFlusher-XXXX` 형태의 이름으로 구분합니다(XXXX는 보드 고유값 기반).
- 연결 후 상태 표시줄은 `${deviceName} / ${SERVICE_UUID}` 형식으로 표시됩니다.

---

## ⚙️ 웹 설정(중요)

웹 UI는 [index.html](index.html) / [web/text.html](web/text.html) / [web/files.html](web/files.html)로 구성되어 있습니다.

- Text Flush 로직: [web/text.js](web/text.js)
- Files Flush 로직: [web/files.js](web/files.js)

### Text Flusher 설정

- 전송설정
	- Chunk(bytes) / Delay(ms): BLE 구간 전송 분할/대기
	- Retry Delay(ms): 연결 끊김 시 재시도 간격
- 입력설정
	- 한/영 전환키: Right Alt(Windows) / CapsLock(mac) 등
	- 라인 시작 공백/탭 무시: 각 줄 맨 앞의 공백/탭을 전송 전에 제거
	- 타이핑 딜레이(보드): Typing/Mode Switch/Key Press

> 정확성 최우선이면: Typing Delay / Mode Switch Delay를 충분히 크게 유지하는 것을 권장합니다.

### File Flusher 설정(Windows)

- keyDelay/lineDelay/chunk 옵션은 “PowerShell 명령/베이스64 조각”을 타이핑할 때의 안정성에 직접 영향을 줍니다.
- Overwrite Policy
	- `fail`: 대상 파일이 이미 있으면 즉시 실패
	- `overwrite`: 기존 파일을 삭제 후 새로 생성
	- `backup`: 기존 파일을 백업 후 새로 생성
		- 백업 규칙: `a.txt` → `a.txt.bak` (이미 있으면 `a.txt.bak.bak` 처럼 계속 `.bak`를 덧붙여 유니크하게 만듦)

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

### 4) Macro Characteristic (Windows 자동화)

- UUID: `f3641404-00b0-4240-ba50-05ca45bf8abc`
- 속성: Write (with response)
- 목적:
	- File Flusher에서 Win+R / Enter 같은 “특수키”를 안전하게 실행하기 위한 채널
	- 텍스트 전송 채널(Flush Text)과 분리해서, 기존 Text Flusher 안정성을 유지
- 포맷: `[cmd(u8)][len(u8)][payload(len bytes)]`
	- cmd 예시: Win+R, Enter, Esc, ASCII 타이핑, Sleep(ms), 영문 강제

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

### (File Flusher) PowerShell 명령이 깨짐 (`e-Host` 같은 오타)
- 증상 예: `Write-Host ...`가 `e-Host ...`처럼 **앞부분이 누락**되어 실행 오류
- 원인: PowerShell 창이 뜨는 타이밍/포커스/초기화 과정에서 **첫 몇 글자가 드랍**되는 케이스
- 대응: File Flusher 설정에서 아래 값을 올려 안정성을 확보하세요.
	- `psLaunchDelayMs` (예: 2200~3500)
	- `runDialogDelayMs` (예: 350~600)
	- `bootstrapDelayMs` (예: 600~1200)
	- `keyDelayMs` (최소 15 이상 권장)

### Pause/Stop이 즉시 반응하지 않음
- 펌웨어가 최신인지 확인하세요([src/main.cpp](src/main.cpp) 의 `kFirmwareVersion` 참고)
- Status(Flow Control) 특성이 정상 동작해야 합니다.

---

## 📄 라이선스

별도 명시가 없다면 저장소의 라이선스 정책을 따릅니다.
