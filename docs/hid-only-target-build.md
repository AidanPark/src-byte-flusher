# Target PC에서 COM 포트 없이(USB HID 키보드만) 사용하기 — HID-only 빌드/업로드 매뉴얼

이 문서는 ByteFlusher를 **Target PC에 연결했을 때 “USB 입력장치(키보드)”로만 인식**되게 하고,
**Windows에서 COM 포트(Ports: COM & LPT)가 생성되지 않게** 하는 운영 방법을 정리합니다.

핵심은 펌웨어를 2가지로 분리하는 것입니다.

- 개발/디버그용(Composite): USB HID + USB CDC(Serial) → 개발 PC에서 로그/업로드 편의
- 타겟용(HID-only): USB HID만 → Target PC에서 COM 포트가 생기지 않음

---

## 0) 결론 요약

- Target PC에서 COM이 보이는 원인은 대부분 **USB CDC(Serial) 인터페이스가 USB 디스크립터에 포함**되기 때문입니다.
- `nice_nano_v2_compatible_hid_only` 환경은 `CFG_TUD_CDC=0`로 빌드되어 **CDC를 디스크립터에서 제거**합니다.
- 따라서 **HID-only 펌웨어가 보드에 올라가서 정상 부팅된 상태**로 Target PC에 연결하면, COM 포트는 생성되지 않아야 합니다.

중요:
- 업로드(DFU) 순간에는 **부트로더 모드**로 들어가며, 이때는 **부트로더가 COM 포트를 제공**할 수 있습니다.
- 즉, **업로드를 위해 잠깐 COM이 보이는 것**과, **애플리케이션(일반 동작) 모드에서 COM이 보이는 것**은 다릅니다.

---

## 1) 준비: PlatformIO 환경(2개 env)

[platformio.ini](../platformio.ini)에 아래 env가 있어야 합니다.

- `nice_nano_v2_compatible` (기존, 개발용)
- `nice_nano_v2_compatible_hid_only` (신규, 타겟용)

`nice_nano_v2_compatible_hid_only` 특징:
- `-D CFG_TUD_CDC=0`
- `extra_scripts = pre:scripts/patch_tinyusb.py`

`patch_tinyusb.py`는 PlatformIO가 설치한 Adafruit nRF52/TinyUSB 프레임워크 소스를 **HID-only에서도 컴파일/링크 가능하도록 패치**합니다.
(패치는 `CFG_TUD_CDC` 조건부로 들어가므로, 기본(env) 빌드에는 영향을 거의 주지 않습니다.)

---

## 2) HID-only 빌드 명령

형님이 쓰는 실행 파일 기준(Windows):

- 빌드:
  - `C:\Users\j1445\.platformio\penv\Scripts\platformio.exe run --environment nice_nano_v2_compatible_hid_only`

참고:
- VS Code Task/터미널에서 `platformio.exe`를 쓰는 흐름 그대로 유지해도 됩니다.

---

## 3) HID-only 업로드(버튼 없는 보드 권장 흐름)

Target PC에서 COM을 영구적으로 없애려면, 업로드 자체는 보통 **부트로더 진입 후**에 수행합니다.

권장 절차:
1) Control PC(브라우저)에서 ByteFlusher에 BLE 연결
2) 웹 UI의 **“부트로더 진입”** 버튼 클릭
3) 보드가 Serial DFU(부트로더)로 재부팅됨
4) 업로드 실행

- 업로드:
  - `C:\Users\j1445\.platformio\penv\Scripts\platformio.exe run --target upload --environment nice_nano_v2_compatible_hid_only`

업로드 포트가 자동으로 안 잡히면, 기존과 동일하게 환경변수/설정으로 포트를 지정합니다.

- 예시(현재 PowerShell):
  - `$env:PIO_UPLOAD_PORT = "COM7"`
  - `C:\Users\j1445\.platformio\penv\Scripts\platformio.exe run --target upload --environment nice_nano_v2_compatible_hid_only`

주의:
- 이 단계(부트로더 모드)에서는 **COM 포트가 보이는 것이 정상**일 수 있습니다.
- 업로드 성공 후에는 보드가 애플리케이션으로 재부팅되며, HID-only 펌웨어라면 일반 동작 모드에서는 COM이 없어야 합니다.

---

## 4) 빠른 절차(간단)

1) (개발 PC) HID-only 빌드
   - `C:\Users\j1445\.platformio\penv\Scripts\platformio.exe run --environment nice_nano_v2_compatible_hid_only`

2) (개발 PC) DFU(부트로더) 진입
   - Web UI로 BLE 연결 → **부트로더 진입** 버튼

3) (개발 PC) 업로드(둘 중 하나)
   - HID-only 유지: `C:\Users\j1445\.platformio\penv\Scripts\platformio.exe run --target upload --environment nice_nano_v2_compatible_hid_only`
   - 개발용(Composite) 복귀: `C:\Users\j1445\.platformio\penv\Scripts\platformio.exe run --target upload --environment nice_nano_v2_compatible`

4) 포트 자동 탐색이 실패하면(DFU 모드 COM을 지정)
   - `$env:PIO_UPLOAD_PORT = "COM7"`

5) (Target PC) 검증
   - 장치 관리자 → “포트(COM 및 LPT)”에 새 COM이 **없어야 함**
   - HID 키보드로 잡히는 건 정상

---

## 5) 막히면(최소)

- BLE로 DFU 진입이 안 되면: 보드가 지원하는 경우 **RESET 더블탭**으로 DFU 진입
- 그래도 안 되면: **SWD(디버거)**로 플래시

참고:
- 업로드(DFU) 중 COM이 잠깐 보일 수 있습니다(정상). 확인은 **일반 동작 모드**에서 하세요.
