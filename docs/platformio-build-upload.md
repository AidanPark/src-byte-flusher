# PlatformIO 빌드/업로드 문제 해결

이 프로젝트는 PlatformIO 기반이며, 기본적으로 `platformio.ini`에 정의된 환경(env)로 빌드/업로드합니다.

## 1) 개발용/배포용 빌드 구분(중요)

이 프로젝트는 env에 따라 USB 디스크립터 구성이 달라질 수 있습니다.

### 개발용(Composite: HID + CDC Serial)
- 용도: 개발 PC에서 로그/업로드 편의
- 증상: Target PC에 꽂으면 **키보드(HID) + COM(Ports)** 로 보일 수 있음
- 빌드:
  - `platformio run --environment nice_nano_v2_compatible`
- 업로드:
  - `platformio run --target upload --environment nice_nano_v2_compatible`

### 배포용(Target: HID-only)
- 용도: Target PC에서 **COM 포트 없이 키보드(HID)만** 보이게 운영
- 빌드:
  - `platformio run --environment nice_nano_v2_compatible_hid_only`
- 업로드:
  - `platformio run --target upload --environment nice_nano_v2_compatible_hid_only`

참고(중요):
- 업로드(DFU) 순간에는 **부트로더 모드**로 들어가며, 이때는 **부트로더가 COM 포트를 제공**할 수 있습니다.
  - 확인은 “업로드 완료 후 일반 동작 모드”에서 하세요.
- 배포용(HID-only) 상세 절차/주의사항: [HID-only 매뉴얼](hid-only-target-build.md)

## 2) 보드가 맞는지(가장 중요)
이 프로젝트는 **BLE + Native USB Device**가 동시에 필요해서, 일반적으로 **nRF52840** 계열을 전제로 합니다.

- 증상: 빌드는 되는데 USB HID가 안 뜸 / BLE가 안 잡힘
  - 보드 칩/부트로더가 요구사항과 다를 수 있습니다.

## 3) 업로드가 안 될 때(Windows)

### Q. 업로드가 계속 실패한다(포트 에러)
- 원인 후보: 부트로더 모드에서 COM 포트가 바뀜
- 체크:
  - RESET 더블탭으로 부트로더 모드 진입
  - 부트로더 진입 후 장치 관리자에서 새 COM 포트가 생기는지 확인

### Q. 보드가 “부트로더 모드”로 안 들어간다
- 케이블이 충전 전용일 수 있습니다 → 데이터 케이블로 교체
- USB 허브/포트 문제일 수 있습니다 → 다른 포트로 변경

### Q. 권한/드라이버 문제로 인식이 불안정하다
- USB 드라이버/칩셋 드라이버 업데이트
- 가능하면 메인보드 후면 포트 사용(전원/신호 안정)

## 4) 빌드가 안 될 때

### Q. 라이브러리/툴체인이 설치가 안 됐다
- PlatformIO 확장 설치 확인(VS Code)
- 터미널에서 `pio --version` 확인

### Q. env/board 설정이 보드와 다르다
- `platformio.ini`에서 사용하는 env를 확인하고, 보드에 맞는 `board = ...`로 맞춥니다.
- 일부 호환 보드는 PlatformIO 보드 ID가 없어서, 유사한 보드 정의로 빌드/업로드하는 우회 구성이 필요할 수 있습니다.

## 5) 빠른 체크리스트
- [ ] VS Code PlatformIO 확장 설치
- [ ] 올바른 env로 빌드/업로드 실행
- [ ] 부트로더 모드 진입(필요 시)
- [ ] 업로드 시점의 COM 포트 확인
- [ ] 데이터 USB 케이블 사용

문제가 계속되면, 아래 정보가 있으면 원인 파악이 빨라집니다.
- 사용 보드/칩(nRF52840 여부)
- 업로드 시의 에러 로그 전체
- 부트로더 진입 여부 및 COM 포트 변화
