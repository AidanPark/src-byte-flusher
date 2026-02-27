# 🤖⌨️ Byte Flusher (BLE → USB HID)

![nRF52840](https://img.shields.io/badge/nRF52840-required-blue)
![Web Bluetooth](https://img.shields.io/badge/Web_Bluetooth-Chrome%2FEdge-4285F4)
![PlatformIO](https://img.shields.io/badge/PlatformIO-Arduino-orange)
![Android](https://img.shields.io/badge/Android-supported-green)
![iOS](https://img.shields.io/badge/iOS-via_BLE_Link_app-yellow)
![GitHub stars](https://img.shields.io/github/stars/AidanPark/src-byte-flusher?style=social)

ByteFlusher is a tool that receives text/files via Web Bluetooth (BLE) and uses an nRF52840 board to **accurately type/create them to completion** on a Target PC as USB HID keyboard input.

## 🔗 Links

- Web UI (GitHub Pages): https://aidanpark.github.io/src-byte-flusher/
- Text Flush UI: [web/text.html](web/text.html)
- File Flush UI: [web/files.html](web/files.html)
- Build/Flash: [Quick Start](#-quick-start)
- How it works: [Overview](#-overview)
- Troubleshooting: [Troubleshooting](#-troubleshooting)

Firmware version: **1.1.34**

## 🖥️ Web UI Preview

[Text Flush UI](web/text.html)

![Byte Flusher Text Flush UI preview (Web Bluetooth BLE to USB HID keyboard automatic typing)](docs/ui_text_preview.png)

[File Flush UI](web/files.html)

![Byte Flusher File Flush UI preview (Base64 over BLE, PowerShell decode, SHA-256 verify)](docs/ui_files_preview.png)

## 📚 Documentation (Q&A)

- Docs index (HTML): https://aidanpark.github.io/src-byte-flusher/docs/
- Accuracy-first design/constraints: [HTML](https://aidanpark.github.io/src-byte-flusher/docs/accuracy-design.html) / [MD](docs/accuracy-design.md)
- Missing/corrupted text checklist: [HTML](https://aidanpark.github.io/src-byte-flusher/docs/troubleshooting-missing-text.html) / [MD](docs/troubleshooting-missing-text.md)
- IME/layout (Korean/English) issues: [HTML](https://aidanpark.github.io/src-byte-flusher/docs/ime-layout-issues.html) / [MD](docs/ime-layout-issues.md)
- PlatformIO build/upload troubleshooting: [HTML](https://aidanpark.github.io/src-byte-flusher/docs/platformio-build-upload.html) / [MD](docs/platformio-build-upload.md)
- Using HID-only (no COM port) on Target PC: [HTML](https://aidanpark.github.io/src-byte-flusher/docs/hid-only-target-build.html) / [MD](docs/hid-only-target-build.md)

## ⚠️ Scope of Use / Legal Disclaimer (Important)

- This project is intended for use in **testing, development automation, and demos** on **systems you own/manage** or in **explicitly authorized environments**.
- Do not use this tool for **illegal or unethical purposes** such as unauthorized access, security bypass, credential/privilege theft, or unauthorized input to others' systems.
- USB HID keyboard input behaves like "a person typing," so focus changes, popups, UAC prompts, or notifications may cause **input to go to unintended locations**. Always test in a safe environment before actual use.
- The user assumes all responsibility for the use of this tool and its outcomes (data loss, mistyped input, workflow impact, etc.).

---


## 📌 Overview

- Control PC: Controls the Flusher via BLE connection using a Chrome/Edge browser
- Flusher: An nRF52840-based board (USB Device + BLE). Buffers data received over BLE and outputs it as USB HID keyboard input
- Target PC: The machine where the Flusher performs keyboard input via USB

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

## ✅ Key Features

- ✅ **Text Flusher**
	- Accurately types text entered in the browser onto the Target PC
	- Supports Korean syllables (가~힣) + ASCII (letters/numbers/symbols/newlines/tabs)
	- IME toggle supports **Korean/English switching only** (other language pairs are not supported)

- ✅ **File Flusher (Windows only)**
	- Select files/folders from the Control PC (browser) to create identical files on the Target PC
	- How it works: Base64 (ASCII) transmission → PowerShell on Target PC decodes and saves the raw bytes → SHA-256 verification
	- Supports binary files like images/zip/exe (transfer time and focus stability are the limiting factors, not file type)

- ✅ **Accuracy-first transmission (common)**
	- BLE `Write with response` + reconnection/retry + deduplication (sessionId/seq)
	- Flow Control: Web UI automatically adjusts transmission speed based on device RX buffer availability reported via Status (READ+NOTIFY)
	- Pause/Resume: Device immediately stops typing on Pause (queue is preserved)
	- Stop: Immediately clears the device RX queue and resets internal state (remaining input is discarded)

---

## 🎯 Use Cases

- When you need to **accurately "type" long code/scripts/config** onto a Target PC
- When you need to **safely inject text** in environments where network/clipboard/file transfer is restricted
- When you need **repeatable input (reproducibility)** for demos, training, or testing
- (Windows) When you need to **create and verify files via PowerShell** in situations where direct file copying is difficult

Example search queries people actually use:
- "How to accurately type text on a remote PC"
- "Automated bulk text typing via USB HID keyboard"
- "Send text via Web Bluetooth BLE and type it on PC"

---

## 🧩 Supported Boards / Buying Guide (Important)

### Requirements

- **MCU must be nRF52840**.
	- Both BLE (2.4GHz) and **Native USB Device** are required simultaneously.
	- Chips without USB (e.g., nRF52832) are not supported.

### Recommended/Verified Compatible Boards

- Pro Micro form factor nRF52840 boards (commonly sold on AliExpress as "nRF52840 Pro Micro" / "SuperMini nRF52840")
- nice!nano v2 compatible boards
- Adafruit Feather nRF52840 series (easiest for development/testing)

Example (actual test board):

![Example device (Pro Micro NRF52840)](docs/device_board.webp)

### PlatformIO Environment and Board Configuration

This repository uses the PlatformIO `nordicnrf52` platform.

- The default build environment is `nice_nano_v2_compatible` in [platformio.ini](platformio.ini).
	- It is configured to build with `board = adafruit_feather_nrf52840`.
	- Some "nice!nano v2 compatible" boards don't have a PlatformIO board ID, so
		**when the bootloader/VID-PID is similar to the Feather series**, this workaround configuration has proven practical.

If using a different board:
1) VS Code PlatformIO extension → search for the board ID in Boards
2) Create a new env in [platformio.ini](platformio.ini) and change only `board = ...` to build/upload.

Example candidates (varies by board):
- `adafruit_feather_nrf52840`
- `adafruit_itsybitsy_nrf52840`
- `seeed_xiao_nrf52840`

### Upload Tips

- Most nRF52 boards enter bootloader mode via a **double-tap RESET**.
- The COM port often changes when entering bootloader mode.

### Verifying "Is This the Right Board?" on Windows (Checklist)

AliExpress/compatible board listings are often inaccurate, so we recommend **quickly identifying the chip/bootloader family** on Windows.

1) **Open Device Manager**
- Win+X → Device Manager

2) With the board connected via USB, check the following
- Whether a new COM port appears under "Ports (COM & LPT)"
- Whether a new device appears under "Universal Serial Bus devices"

3) (If possible) **Enter bootloader mode** and check again
- Double-tap the board RESET quickly
- In bootloader mode, **the COM port/device name often changes**.

4) Check VID/PID (Hardware ID)
- Right-click device → Properties → "Details" tab → "Hardware Ids"
- Note the `VID_xxxx` / `PID_yyyy` values.

Reference (typical examples):
- Adafruit nRF52 series (Feather, etc.) often appears with the manufacturer VID (e.g., `239A`).
- Some "nice!nano v2 compatible" boards show similar VID/PID and bootloader behavior to the Feather series,
  allowing successful build/upload using the `adafruit_feather_nrf52840` board definition in PlatformIO.

5) Check if a UF2 drive appears (optional)
- If the board uses a UF2 bootloader, a USB drive may appear in bootloader mode.
- Whether or not a drive appears is a clue for identifying the board/bootloader type.

#### Quickly Viewing VID/PID via PowerShell (Optional)

Instead of the Device Manager UI, you can also get hints via PowerShell.

- View only USB devices with VID/PID patterns
	- `Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_[0-9A-F]{4}&PID_[0-9A-F]{4}' } | Select-Object -First 50 -Property Status,Class,FriendlyName,InstanceId`

- Filter by a specific VID (e.g., 239A)
	- `Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_239A' } | Format-Table -AutoSize Status,Class,FriendlyName,InstanceId`

> FriendlyName/InstanceId display may vary by environment. Even so, if you see `VID_XXXX&PID_YYYY`, it's a strong clue.

> This checklist doesn't guarantee "exact identification," but
> it helps quickly filter whether a board is nRF52840 + USB Device + appropriate bootloader family.

---

## 🚀 Quick Start

### 1) Build/Upload Firmware

- Build:
	- `platformio run --environment nice_nano_v2_compatible`
- Upload:
	- `platformio run --target upload --environment nice_nano_v2_compatible`

### 2) Run the Web UI (Requires HTTPS or localhost)

Easiest method (recommended):

- Access the GitHub Pages control page
	- https://aidanpark.github.io/src-byte-flusher/
	- Connect to the Flusher and control Start/Pause/Resume/Stop from here.

Web Bluetooth requires a secure context, so opening via `file://` will not work.

Simple method (local):

- Run from the project root in PowerShell
	- `python -m http.server 8080`
- Access in browser
	- `http://localhost:8080/`

### 2-1) Using on Mobile (Phone as Control PC)

This project's Web UI is based on **Web Bluetooth**.

#### Android (Recommended)

- Android Chrome/Edge supports Web Bluetooth, making it easy to use your phone as the Control PC.
- If connection fails:
	- Grant Bluetooth and nearby device (scan) permissions
	- Ensure the page is served over `https://` (GitHub Pages is fine)
	- Check if another tab/device is already connected to the same device

#### iPhone / iOS (Safari/Chrome Not Supported by Default)

- Safari/Chrome on iOS use the same WebKit engine, so Web Bluetooth generally does not work.
- Alternative: Use a third-party app that provides a Web BLE bridge on iOS.
	- Verified app: **BLE Link - Web BLE Browser**
		- App Store: https://apps.apple.com/kr/app/ble-link-web-ble-browser/id6468414672

Connection steps on iOS (example):
1. Install the app above
2. Grant Bluetooth permission for the app in iOS Settings
3. Navigate to https://aidanpark.github.io/src-byte-flusher/ within the app
4. [Connect Device] → Select `ByteFlusher-XXXX`

Caution (accuracy/stability):
- On iOS, BLE may disconnect when switching to background or when the screen turns off. **Keep the app in the foreground with the screen on** during operation.
- File Flusher is heavily affected by file selection, browser memory, and permission policies, so on mobile, **verify with Text Flusher first**.

### 3) Usage Flow

#### A) Text Flusher

Page: [web/text.html](web/text.html)

1. Connect the Flusher to the Target PC via USB (it must be recognized as a keyboard)
2. Access the page on the Control PC and click [Connect Device]
3. Place the cursor at the input location on the Target PC (editor, terminal, etc.)
4. Set the Target PC input method to **English mode** (initial sync may vary by environment)
5. Enter text and click [Start]
6. As needed:
	 - Pause: Immediately stops (queue preserved)
	 - Resume: Continues from where it stopped
	 - Stop: Immediately discards (remaining queue deleted)

#### B) File Flusher (Windows Only)

Page: [web/files.html](web/files.html)

1. (Important) Target PC must have **Windows + PowerShell** available
2. Enter Target Directory
   - Current UI constraint (accuracy-first): **Windows absolute path + no spaces + ASCII only**
3. Select 1 file or 1 folder
4. Click [Start]
   - The device automatically performs Win+R → launches PowerShell
	- Only the PowerShell launch command is entered in Run (Win+R); the launcher/bootstrap is sent as chunks into PowerShell for assembly/execution
	- PowerShell decodes Base64 to create the file and verifies with SHA-256 hash

Notes
- Temporary files for bootstrap chunk assembly are briefly created under `%TEMP%` and automatically deleted right after bootstrap execution.
- File paths are transmitted as Base64 (UTF-16LE) to improve stability for Korean/Unicode filenames.
- If the diagnostic log option is enabled, `targetDir\.tmp\bf_last_error.txt` may be created on failure.

Caution (accuracy/stability)
- During execution, maintain focus on the Target PC — do not let other apps steal focus (notifications, IME popups, auto-complete, etc.)
- Larger files mean longer Base64 strings, increasing transfer time (approximately 1.33x)

Additional Tips
- If you have multiple identical boards, distinguish them by the `ByteFlusher-XXXX` name in the selection list (XXXX is based on a board-unique value).
- After connection, the status bar displays in the format `${deviceName} / ${SERVICE_UUID}`.

---

## ⚙️ Web Settings (Important)

The Web UI consists of [index.html](index.html) / [web/text.html](web/text.html) / [web/files.html](web/files.html).

- Text Flush logic: [web/text.js](web/text.js)
- Files Flush logic: [web/files.js](web/files.js)

### Text Flusher Settings

- Transmission settings
	- Chunk (bytes) / Delay (ms): BLE segment transmission split/wait
	- Retry Delay (ms): Retry interval on connection drop
- Input settings
	- Korean/English toggle key: Right Alt (Windows) / CapsLock (Mac), etc.
	- Ignore leading spaces/tabs: Strips spaces/tabs at the beginning of each line before transmission
	- Typing delays (board): Typing / Mode Switch / Key Press

> For maximum accuracy: Keep Typing Delay / Mode Switch Delay sufficiently high.

### File Flusher Settings (Windows)

- keyDelay/lineDelay/chunk options directly affect the stability of typing "PowerShell commands/Base64 chunks."
- Overwrite Policy
	- `fail`: Immediately fails if the target file already exists
	- `overwrite`: Deletes the existing file and creates a new one
	- `backup`: Backs up the existing file and creates a new one
		- Backup rule: `a.txt` → `a.txt.bak` (if already exists, keeps appending `.bak` like `a.txt.bak.bak` to make it unique)

---

## 📡 BLE UUID / Protocol

Service UUID (fixed):
- `f3641400-00b0-4240-ba50-05ca45bf8abc`

### 1) Flush Text Characteristic

- UUID: `f3641401-00b0-4240-ba50-05ca45bf8abc`
- Properties: Write (with response)
- Packet format (LE):
	- `[sessionId(u16)][seq(u16)][payload(bytes...)]`
- Purpose:
	- Transmit long text in chunks
	- **Prevent duplicate typing** even when retransmitting the same chunk after BT disconnection/retry

### 2) Config Characteristic

- UUID: `f3641402-00b0-4240-ba50-05ca45bf8abc`
- Properties: Write (with response)
- Format (LE): `[typingDelayMs(u16)][modeSwitchDelayMs(u16)][keyPressDelayMs(u16)][toggleKey(u8)][flags(u8)]`
- `flags`:
	- bit0: Pause (1=paused)
	- bit1: Abort (1=immediate discard: RX queue clear + internal decoder state reset)

### 3) Status Characteristic (Flow Control)

- UUID: `f3641403-00b0-4240-ba50-05ca45bf8abc`
- Properties: Read + Notify
- Format (LE): `[capacityBytes(u16)][freeBytes(u16)]`
- Purpose:
	- Limits the web to transmit only when the device buffer has capacity,
		ensuring **Pause/Stop truly operates "immediately"** and accuracy is maintained

### 4) Macro Characteristic (Windows Automation)

- UUID: `f3641404-00b0-4240-ba50-05ca45bf8abc`
- Properties: Write (with response)
- Purpose:
	- A channel for safely executing "special keys" like Win+R / Enter in the File Flusher
	- Separated from the text transmission channel (Flush Text) to maintain existing Text Flusher stability
- Format: `[cmd(u8)][len(u8)][payload(len bytes)]`
	- cmd examples: Win+R, Enter, Esc, ASCII typing, Sleep(ms), force English mode

---

## 🧪 Recommended Tests (Accuracy Verification)

- Start with long text → Pause: Does it stop immediately?
- Resume during Pause: Does it continue correctly (no missing/duplicate characters)?
- Stop during Start: Does it stop immediately with no additional typing afterward?
- Start again after Stop: Does it work normally without residual effects (intermediate state)?

---

## 🔧 Troubleshooting

### "Connect Device" Doesn't Work
- Verify you're using Chrome/Edge (other browsers have limited/no Web Bluetooth support)
- Ensure the page is served over `https://` or `http://localhost`
- Check OS Bluetooth permissions/drivers

### Typing is Dropped or Out of Order
- IDEs with strong auto-complete/auto-indent/auto-bracket features on the Target PC are likely to cause conflicts.
	- Test with Notepad or a simple text editor first
- Try increasing Typing Delay / Mode Switch Delay in the board settings.

### (File Flusher) PowerShell Commands Are Corrupted (e.g., `e-Host` Instead of `Write-Host`)
- Symptom: `Write-Host ...` becomes `e-Host ...` with **leading characters dropped**, causing execution errors
- Cause: During PowerShell window launch timing/focus/initialization, **the first few characters may be dropped**
- Solution: Increase the following values in File Flusher settings to improve stability:
	- `psLaunchDelayMs` (e.g., 2200~3500)
	- `runDialogDelayMs` (e.g., 350~600)
	- `bootstrapDelayMs` (e.g., 600~1200)
	- `keyDelayMs` (minimum 15 recommended)

### Pause/Stop Doesn't Respond Immediately
- Verify the firmware is up to date (see `kFirmwareVersion` in [src/main.cpp](src/main.cpp))
- The Status (Flow Control) characteristic must be functioning properly.

---

## 📄 License

Unless otherwise specified, this repository follows its own license policy.
