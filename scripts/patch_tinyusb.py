# pre:patch_tinyusb.py
#
# Goal:
# - Allow building a HID-only firmware by setting CFG_TUD_CDC=0.
# - The upstream Adafruit TinyUSB Arduino integration assumes CDC exists in a few places.
# - When CDC is disabled, those references must become no-ops to avoid build failures.
#
# This script patches the *installed* framework package sources in-place, but only for the
# specific functions that fail to compile when CFG_TUD_CDC=0.
# It is idempotent (safe to run multiple times).

from __future__ import annotations

from pathlib import Path
import re

Import("env")


def _find_framework_dir() -> Path | None:
    packages_dir = Path(env.subst("$PROJECT_PACKAGES_DIR"))
    candidate = packages_dir / "framework-arduinoadafruitnrf52"
    if candidate.exists():
        return candidate

    # Fallback to default global location
    home = Path.home()
    candidate2 = home / ".platformio" / "packages" / "framework-arduinoadafruitnrf52"
    if candidate2.exists():
        return candidate2

    return None


def _patch_file_exact(path: Path, old: str, new: str, *, required: bool = True) -> bool:
    text = path.read_text(encoding="utf-8", errors="ignore")

    # Idempotency: treat either LF or CRLF as already-patched.
    if new in text or new.replace("\n", "\r\n") in text:
        return False

    # Support both LF and CRLF when matching old text.
    candidates = [
        (old, new),
        (old.replace("\n", "\r\n"), new.replace("\n", "\r\n")),
    ]
    for old_cand, new_cand in candidates:
        if old_cand in text:
            path.write_text(text.replace(old_cand, new_cand), encoding="utf-8")
            return True

    if required:
        raise RuntimeError(f"Patch target not found in {path}")
    return False


def _patch_between_markers(path: Path, start_marker: str, end_marker: str, replace_with: str) -> bool:
    text = path.read_text(encoding="utf-8", errors="ignore")
    if replace_with in text:
        return False

    start = text.find(start_marker)
    if start < 0:
        raise RuntimeError(f"Start marker not found in {path}: {start_marker}")
    end = text.find(end_marker, start + len(start_marker))
    if end < 0:
        raise RuntimeError(f"End marker not found in {path}: {end_marker}")

    new_text = text[:start] + replace_with + text[end + len(end_marker) :]
    path.write_text(new_text, encoding="utf-8")
    return True


def _patch_regex(path: Path, pattern: str, repl: str) -> bool:
    text = path.read_text(encoding="utf-8", errors="ignore")
    new_text, n = re.subn(pattern, repl, text, flags=re.MULTILINE)
    if n == 0:
        return False
    path.write_text(new_text, encoding="utf-8")
    return True


def _wrap_function_with_if_macro(path: Path, signature: str, macro_expr: str) -> bool:
    """Wrap a function definition in #if/#else to omit it when macro_expr is false.

    This is used to prevent compiling Serial(USB CDC) references when CFG_TUD_CDC=0.
    """

    text = path.read_text(encoding="utf-8", errors="ignore")
    idx = text.find(signature)
    if idx < 0:
        return False

    # If already wrapped, do nothing.
    pre = text[max(0, idx - 80) : idx]
    if "#if" in pre and macro_expr in pre:
        return False

    brace_start = text.find("{", idx)
    if brace_start < 0:
        raise RuntimeError(f"Function brace not found in {path}: {signature}")

    depth = 0
    end = -1
    for i in range(brace_start, len(text)):
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break

    if end < 0:
        raise RuntimeError(f"Function end not found in {path}: {signature}")

    fn = text[idx:end]
    stub = signature + "\n{\n}\n"

    wrapped = (
        f"#if {macro_expr}\n"
        f"{fn}\n"
        "#else\n"
        f"{stub}\n"
        "#endif\n"
    )

    new_text = text[:idx] + wrapped + text[end:]
    path.write_text(new_text, encoding="utf-8")
    return True


def main() -> None:
    # Patch unconditionally (idempotent). The patched code is guarded by CFG_TUD_CDC
    # so it is safe even when CDC is enabled.
    fw = _find_framework_dir()
    if fw is None:
        print("[patch_tinyusb] framework-arduinoadafruitnrf52 not found; skipping")
        return

    api_cpp = (
        fw
        / "libraries"
        / "Adafruit_TinyUSB_Arduino"
        / "src"
        / "arduino"
        / "Adafruit_TinyUSB_API.cpp"
    )

    nrf_port_cpp = (
        fw
        / "libraries"
        / "Adafruit_TinyUSB_Arduino"
        / "src"
        / "arduino"
        / "ports"
        / "nrf"
        / "Adafruit_TinyUSB_nrf.cpp"
    )

    usbd_device_cpp = (
        fw
        / "libraries"
        / "Adafruit_TinyUSB_Arduino"
        / "src"
        / "arduino"
        / "Adafruit_USBD_Device.cpp"
    )

    tinyusb_h = (
        fw
        / "libraries"
        / "Adafruit_TinyUSB_Arduino"
        / "src"
        / "Adafruit_TinyUSB.h"
    )

    changed = False

    # 0) Core Arduino.h always includes Adafruit_USBD_CDC.h when USE_TINYUSB is set.
    #    This declares Serial even when CFG_TUD_CDC=0, and also causes a C/C++ linkage
    #    conflict for TinyUSB_Device_Init.
    core_arduino_h = fw / "cores" / "nRF5" / "Arduino.h"
    if core_arduino_h.exists():
        old_include = (
            "#ifdef USE_TINYUSB\n"
            "// Needed for declaring Serial\n"
            "#include \"Adafruit_USBD_CDC.h\"\n"
            "#endif\n"
        )
        new_include = (
            "#ifdef USE_TINYUSB\n"
            "// Needed for declaring Serial\n"
            "#if defined(CFG_TUD_CDC) && CFG_TUD_CDC\n"
            "#include \"Adafruit_USBD_CDC.h\"\n"
            "#endif\n"
            "#endif\n"
        )
        try:
            changed |= _patch_file_exact(core_arduino_h, old_include, new_include)
        except RuntimeError:
            # If upstream already guards this include, nothing to do.
            pass

    # 0.5) Fix linkage mismatch: Adafruit_TinyUSB.h declares TinyUSB_Device_Init with C++ linkage
    #      but its definition in Adafruit_TinyUSB_API.cpp is inside extern "C".
    #      Wrap the declaration with extern "C" so both match.
    if tinyusb_h.exists():
        old_decl = "void TinyUSB_Device_Init(uint8_t rhport);\n"
        new_decl = (
            "#ifdef __cplusplus\n"
            "extern \"C\" {\n"
            "#endif\n"
            "void TinyUSB_Device_Init(uint8_t rhport);\n"
            "#ifdef __cplusplus\n"
            "}\n"
            "#endif\n"
        )
        try:
            changed |= _patch_file_exact(tinyusb_h, old_decl, new_decl)
        except RuntimeError:
            # If upstream already fixed it, nothing to do.
            pass

    # 1) Guard TinyUSB_Device_FlushCDC() implementation when CFG_TUD_CDC=0.
    old_flush = (
        "void TinyUSB_Device_FlushCDC(void) {\n"
        "  uint8_t const cdc_instance = Adafruit_USBD_CDC::getInstanceCount();\n"
        "  for (uint8_t instance = 0; instance < cdc_instance; instance++) {\n"
        "    tud_cdc_n_write_flush(instance);\n"
        "  }\n"
        "}\n"
    )
    new_flush = (
        "void TinyUSB_Device_FlushCDC(void) {\n"
        "#if CFG_TUD_CDC\n"
        "  uint8_t const cdc_instance = Adafruit_USBD_CDC::getInstanceCount();\n"
        "  for (uint8_t instance = 0; instance < cdc_instance; instance++) {\n"
        "    tud_cdc_n_write_flush(instance);\n"
        "  }\n"
        "#else\n"
        "  // CDC disabled: no-op.\n"
        "#endif\n"
        "}\n"
    )
    if api_cpp.exists():
        try:
            changed |= _patch_file_exact(api_cpp, old_flush, new_flush)
        except RuntimeError:
            # Fallback: patch using markers (more robust to formatting changes).
            # Replace the entire function with a guarded version.
            start_marker = "void TinyUSB_Device_FlushCDC(void) {"
            end_marker = "}\n"
            guarded = (
                "void TinyUSB_Device_FlushCDC(void) {\n"
                "#if CFG_TUD_CDC\n"
                "  uint8_t const cdc_instance = Adafruit_USBD_CDC::getInstanceCount();\n"
                "  for (uint8_t instance = 0; instance < cdc_instance; instance++) {\n"
                "    tud_cdc_n_write_flush(instance);\n"
                "  }\n"
                "#else\n"
                "  // CDC disabled: no-op.\n"
                "#endif\n"
                "}\n"
            )
            # Try to locate the function by a more specific slice to avoid replacing a wrong brace.
            # We use a coarse marker range from function start to the next standalone closing brace.
            text = api_cpp.read_text(encoding="utf-8", errors="ignore")
            start = text.find(start_marker)
            if start < 0:
                raise
            # Find end of function: the first "}\n" after start that is followed by "#endif" or another preprocessor/blank.
            end = text.find("}\n", start)
            if end < 0:
                raise
            new_text = text[:start] + guarded + text[end + 2 :]
            api_cpp.write_text(new_text, encoding="utf-8")
            changed = True

    # 2) Guard the nRF device task's FlushCDC call.
    old_call = "    TinyUSB_Device_FlushCDC();\n"
    new_call = "#if CFG_TUD_CDC\n    TinyUSB_Device_FlushCDC();\n#endif\n"
    if nrf_port_cpp.exists():
        try:
            changed |= _patch_file_exact(nrf_port_cpp, old_call, new_call)
        except RuntimeError:
            # Some versions may already guard it; ignore if not found.
            pass

    if changed:
        print("[patch_tinyusb] Patched Adafruit TinyUSB for CFG_TUD_CDC=0")

    # 2.5) Adafruit_USBD_Device::begin() assumes CDC is always present and starts SerialTinyUSB.
    #      In CFG_TUD_CDC=0 builds, that causes undefined references at link time.
    if usbd_device_cpp.exists():
        usbd_changed = False

        old_iad = (
            "  // Serial is always added by default\n"
            "  // Use Interface Association Descriptor (IAD) for CDC\n"
            "  // As required by USB Specs IAD's subclass must be common class (2) and\n"
            "  // protocol must be IAD (1)\n"
            "  _desc_device.bDeviceClass = TUSB_CLASS_MISC;\n"
            "  _desc_device.bDeviceSubClass = MISC_SUBCLASS_COMMON;\n"
            "  _desc_device.bDeviceProtocol = MISC_PROTOCOL_IAD;\n"
        )
        new_iad = "#if CFG_TUD_CDC\n" + old_iad + "#endif\n"
        usbd_changed |= _patch_file_exact(usbd_device_cpp, old_iad, new_iad, required=False)

        usbd_changed |= _patch_file_exact(
            usbd_device_cpp,
            "  SerialTinyUSB.begin(115200);\n\n  // Init device hardware and call tusb_init()\n",
            "#if CFG_TUD_CDC\n  SerialTinyUSB.begin(115200);\n#endif\n\n  // Init device hardware and call tusb_init()\n",
            required=False,
        )

        if usbd_changed:
            print("[patch_tinyusb] Patched Adafruit_USBD_Device.cpp for CFG_TUD_CDC=0")

    # 3) Bluefruit52Lib references Serial in printInfo helpers.
    #    In HID-only builds (CFG_TUD_CDC=0), Serial(USB CDC) is not declared.
    #    Wrap the whole functions so they compile out when CDC is disabled.
    bf_bleperiph = fw / "libraries" / "Bluefruit52Lib" / "src" / "BLEPeriph.cpp"
    bf_bluefruit = fw / "libraries" / "Bluefruit52Lib" / "src" / "bluefruit.cpp"

    bf_changed = False
    if bf_bleperiph.exists():
        bf_changed |= _wrap_function_with_if_macro(
            bf_bleperiph, "void BLEPeriph::printInfo(void)", "CFG_TUD_CDC"
        )
    if bf_bluefruit.exists():
        bf_changed |= _wrap_function_with_if_macro(
            bf_bluefruit, "void AdafruitBluefruit::printInfo(void)", "CFG_TUD_CDC"
        )

    if bf_changed:
        print("[patch_tinyusb] Wrapped Bluefruit52Lib printInfo for CFG_TUD_CDC=0")

    # 4) Arduino core still references Serial (USB CDC) in a few places.
    #    Patch them to be conditional so CFG_TUD_CDC=0 builds clean.
    core_uart = fw / "cores" / "nRF5" / "Uart.cpp"
    core_delay = fw / "cores" / "nRF5" / "delay.c"
    core_rtos = fw / "cores" / "nRF5" / "rtos.cpp"

    core_changed = False

    if core_uart.exists():
        core_changed |= _patch_regex(
            core_uart,
            r"^(\s*)if\s*\(\s*serialEvent\s*&&\s*Serial\.available\(\)\s*\)\s*serialEvent\(\)\s*;\s*$",
            r"\1#if CFG_TUD_CDC\n\1if (serialEvent && Serial.available() ) serialEvent();\n\1#endif",
        )

    if core_delay.exists():
        core_changed |= _patch_regex(
            core_delay,
            r"^(\s*)TinyUSB_Device_FlushCDC\(\)\s*;\s*$",
            r"\1#if CFG_TUD_CDC\n\1TinyUSB_Device_FlushCDC();\n\1#endif",
        )

    if core_rtos.exists():
        core_changed |= _patch_regex(
            core_rtos,
            r"^(\s*)TinyUSB_Device_FlushCDC\(\)\s*;\s*$",
            r"\1#if CFG_TUD_CDC\n\1TinyUSB_Device_FlushCDC();\n\1#endif",
        )

    if core_changed:
        print("[patch_tinyusb] Patched core Serial/CDC callsites for CFG_TUD_CDC=0")

    # 5) Core main.cpp: ensure TinyUSB prototypes are visible and Serial isn't referenced
    #    when CDC is disabled.
    core_main = fw / "cores" / "nRF5" / "main.cpp"
    main_changed = False
    if core_main.exists():
        # Ensure TinyUSB_Device_Init() is declared (core compilation doesn't see library headers).
        # Try both insertion paths (plain Arduino.h include) and replacing an incorrect include.
        main_changed |= _patch_file_exact(
            core_main,
            '#define ARDUINO_MAIN\n#include "Arduino.h"\n\n#if CFG_SYSVIEW\n',
            '#define ARDUINO_MAIN\n#include "Arduino.h"\n\n#ifdef USE_TINYUSB\nextern "C" void TinyUSB_Device_Init(uint8_t rhport);\n#endif\n\n#if CFG_SYSVIEW\n',
            required=False,
        )

        main_changed |= _patch_file_exact(
            core_main,
            '#define ARDUINO_MAIN\n#include "Arduino.h"\n\n#ifdef USE_TINYUSB\n#include "Adafruit_TinyUSB.h"\n#endif\n\n#if CFG_SYSVIEW\n',
            '#define ARDUINO_MAIN\n#include "Arduino.h"\n\n#ifdef USE_TINYUSB\nextern "C" void TinyUSB_Device_Init(uint8_t rhport);\n#endif\n\n#if CFG_SYSVIEW\n',
            required=False,
        )

        # If neither patch applied and the declaration is still missing, insert it after Arduino.h.
        current_main = core_main.read_text(encoding="utf-8", errors="ignore")
        if "TinyUSB_Device_Init" not in current_main:
            main_changed |= _patch_regex(
                core_main,
                r'^(#include\s+"Arduino\.h"\s*\r?\n)\s*\r?\n',
                r'\1\n#ifdef USE_TINYUSB\nextern "C" void TinyUSB_Device_Init(uint8_t rhport);\n#endif\n\n',
            )

        # Avoid referencing Serial in debug mode when CFG_TUD_CDC=0.
        main_changed |= _patch_file_exact(
            core_main,
            '#if CFG_DEBUG\n  // If Serial is not begin(), call it to avoid hard fault\n  if(!Serial) Serial.begin(115200);\n#endif\n',
            '#if CFG_DEBUG\n#if CFG_TUD_CDC\n  // If Serial is not begin(), call it to avoid hard fault\n  if(!Serial) Serial.begin(115200);\n#endif\n#endif\n',
            required=False,
        )

        # Guard stdout->Serial forwarding when CDC is disabled.
        main_changed |= _patch_file_exact(
            core_main,
            '#else\n  if ( Serial )\n  {\n    ret = Serial.write((const uint8_t *) buf, count);\n  }\n#endif\n',
            '#else\n#if CFG_TUD_CDC\n  if ( Serial )\n  {\n    ret = Serial.write((const uint8_t *) buf, count);\n  }\n#endif\n#endif\n',
            required=False,
        )

    if main_changed:
        print("[patch_tinyusb] Patched core main.cpp for CFG_TUD_CDC=0")


main()
