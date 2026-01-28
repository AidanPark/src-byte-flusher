# BLE ↔ USB HID 입력 장치

버전: 1.0.7

## 목차

- 용어 정리
- 프로젝트 개요
- 시스템 구조
- 하드웨어 구성
- 통신 구조
- USB HID 동작
- 제어 PC 웹 페이지
- 브라우저 동작 흐름
- 전원 정책
- 개발 환경
- 완료 기준 (Acceptance Criteria)
- 향후 확장

## 🧾 용어 정리

- Flusher(= Byte Flusher): nRF52840 기반 장치. 브라우저(BLE) 명령을 받아 Target PC로 USB HID 키보드 입력을 출력하는 것이 주 목적이다.
- Control PC: 웹브라우저로 Flusher를 BLE로 제어하는 PC
- Target PC: Flusher가 USB로 연결되어 HID 입력을 받는 PC

## 📌 프로젝트 개요

본 프로젝트는 **nRF52840 기반 Pro Micro 호환 보드**를 이용하여 다음 기능을 수행하는 장치를 제작한다.

- 웹브라우저에서 BLE(Bluetooth Low Energy)로 장치를 제어
- Control PC의 브라우저에서 텍스트를 입력하고 [시작(Flush)]을 누르면, Flusher가 Target PC의 포커싱된 커서 위치에 해당 텍스트를 키보드 입력으로 전송(Flush)
- 외부 인터넷 연결 없이 동작
- 제어용 PC(Control PC)와 Target PC는 서로 다른 장치임.

---

## 🧠 시스템 구조

[ 제어 PC ]
Chrome / Edge 브라우저
Web Bluetooth API
|
| BLE
v
[ Flusher(Byte Flusher) ]
| |
USB HID
|
v
[ 타겟 PC ]


---

## 🔩 하드웨어 구성

### Flusher (Device)

- nRF52840 Pro Micro 호환 보드  
  (SuperMini NRF52840, Nice!Nano 계열)
- Bluetooth 5.0 BLE
- USB Device 지원
- HID 키보드 구현 가능

### 외부 부품

- USB 케이블 (타겟 PC 연결용)

---

## 📡 통신 구조

### BLE 역할

- Flusher(Device): BLE Peripheral (GATT Server)
- 브라우저: BLE Central

---

### BLE 서비스 구조(GATT)

#### ▶ Flusher Control Service (Custom UUID)

##### Characteristic: Flush Text
- 속성: Write
- 값:
  - UTF-8 문자열 바이트
  - 브라우저에서 이 Characteristic에 문자열을 Write 하면 Flusher는 Target PC로 해당 문자열을 키보드 입력으로 출력한다.

---

## ⌨ USB HID 동작

- Flusher는 Target PC에 USB로 연결되면 HID 키보드로 인식되며, BLE로 수신한 문자열을 Target PC의 포커싱된 커서 위치에 키보드 입력으로 출력한다.


---

## 🌐 제어 PC 웹 페이지

### 제공 방식

- 로컬 Spring Boot 서버에서 정적 페이지 제공

- http://localhost:8080/index.html


---

### 웹 UI 구성

- [장치 연결] 버튼
- 텍스트 입력창(멀티라인 가능)
- [시작(Flush)] 버튼

---

## 🔄 브라우저 동작 흐름

1. 사용자가 [장치 연결] 클릭
2. BLE 장치 선택 팝업 표시
3. 장치 선택
4. 서비스 연결
5. 사용자가 텍스트 입력 후 [시작(Flush)] 클릭
6. Flush Text characteristic Write

---

## ⚡ 전원 정책

- 기본: Target PC USB 전원 사용 (USB 연결이 곧 전원 공급)

---

## 🛠 개발 환경

### 펌웨어

- (현재 repo 기준) PlatformIO + Arduino framework
  - `platformio.ini`: `nordicnrf52` / `adafruit_clue_nrf52840`
  - `src/main.cpp`: BLE GATT Write 수신 → USB HID 키보드 타이핑(기본 스캐폴딩)
- Arduino IDE
- Adafruit nRF52 Core 또는 Nice!Nano 호환 패키지
- BLE 라이브러리: ArduinoBLE / Adafruit Bluefruit
- USB HID: TinyUSB / Keyboard 라이브러리

### 브라우저

- Chrome / Edge
- Web Bluetooth API 사용

---

## ✅ 완료 기준 (Acceptance Criteria)

- [ ] (전제) Flusher가 Target PC에 USB로 연결되어 전원이 공급된다.
- [ ] 브라우저에서 BLE 연결 성공
- [ ] 브라우저에서 텍스트 입력 후 [시작(Flush)] 실행 가능
- [ ] Target PC의 포커싱된 입력 커서 위치에 텍스트가 키보드 입력으로 입력된다.
- [ ] 인터넷 없이 동작
- [ ] 제어 PC / 타겟 PC 분리 사용이 전제임

---

## 🚀 향후 확장

- BLE 페어링 보안 강화
- HID 키맵 확장

---

## 🧩 TODO

- BLE GATT Service/Characteristic UUID 확정
- Flush Text Write 방식 확정 (Write / Write Without Response)
- Flush Text 전송 한계 및 정책 확정 (1회 최대 길이, 긴 텍스트 처리)
- 개행/탭 등 제어문자 처리 규칙 확정 (예: `\n` → Enter, `\t` → Tab)
- 지원 문자 범위 및 키보드 레이아웃 가정 확정 (예: US 키보드 기준 여부)
- USB HID 출력 타이밍 확정 (키 입력 간 딜레이 등)
- 최소 보안/운영 정책 확정 (예: 페어링/재연결 정책)