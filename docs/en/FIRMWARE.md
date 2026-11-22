# Flashing the prebuilt firmware (no compiling)

*[Português](../FIRMWARE.md)*

Every Release includes the **ES3C28P** firmware, built by GitHub CI (reproducible: the same code as the tag):

| File | Purpose |
|---|---|
| `stream-deck-esp-firmware-es3c28p-<version>-completo.bin` | **Complete** image (bootloader + partitions + app). Write at `0x0`. Use for the first install or to replace the factory firmware |
| `stream-deck-esp-firmware-es3c28p-<version>-app.bin` | **App only**. Write at `0x10000`. Use to **update** a board that already runs Stream Deck ESP, **keeping** its Wi-Fi and pairing |
| `SHA256SUMS-firmware.txt` | Checksums to verify the downloaded files |

> Only for the **ES3C28P** (ESP32-S3, 16 MB flash). For another board see [ADAPT-BOARD.md](ADAPT-BOARD.md) and build with PlatformIO.

## Before flashing
1. **Back up the factory firmware** (see [hardware/ES3C28P.md](../hardware/ES3C28P.md), Portuguese): `esptool.py --port <port> read_flash 0 0x1000000 backup_factory.bin`. Keep it **outside the repository**: it contains your Wi-Fi password.
2. Install esptool: `python3 -m pip install --user esptool`.
3. Find the port with the board plugged in over USB: macOS `ls /dev/cu.usbmodem*`; Linux `/dev/ttyACM0`; Windows `COMx` (Device Manager). The number changes when you replug the cable.
4. If the Stream Deck app is open with the cable connection enabled, turn that off (Settings) or close the app: the port must be free.
5. Verify the files: `sha256sum -c SHA256SUMS-firmware.txt` (Linux) / `shasum -a 256 -c SHA256SUMS-firmware.txt` (macOS).

## Flashing
First install (erases the board's Wi-Fi settings and pairing):
```bash
esptool.py --chip esp32s3 --port <port> --baud 921600 write_flash 0x0 stream-deck-esp-firmware-es3c28p-1.0.0-completo.bin
```
Update, keeping Wi-Fi and pairing:
```bash
esptool.py --chip esp32s3 --port <port> --baud 921600 write_flash 0x10000 stream-deck-esp-firmware-es3c28p-1.0.0-app.bin
```
After the complete image the board opens its own **Wi-Fi portal** so you can pick your network; then click **Parear placa** (pair board) in the app.

## Troubleshooting
- `No serial data received` / port not found: **replug the cable** (the board is not dead). If it persists, hold the BOOT button, plug the cable in and release it.
- Screen stays dark after flashing: press RESET or replug.
- Going back to stock: `esptool.py --port <port> write_flash 0 backup_factory.bin`.
