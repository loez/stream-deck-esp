# Connecting the board over a USB cable

*[Português](../PROTOCOLO-USB.md)*

Besides Wi-Fi, the board talks to the server over the USB cable (the ESP32-S3's USB-Serial/JTAG port). It is an **HTTP tunnel**: the board makes the same requests as always
(`GET /api/deck`, `GET /api/img/N.raw`, `GET /api/anim/N.bin`, `POST /api/press/N`), only as binary frames over serial. The server repeats each request on `127.0.0.1`
with its own token and returns the response; all the logic (grid, images, actions, plugins) is the same. **No Wi-Fi, no mDNS and no pairing: the cable is the proof of identity.**
Code: `node/src/usb.ts` (frames, session), `node/src/usb-port.ts` (port detection), `src/usblink.cpp` (firmware). Test: `node/test/usb.ts`.

## Frame
`A5 5A | type (1) | id (u16 LE) | size (u32 LE) | xor of the previous 9 bytes | payload`

| Type | Direction | Payload |
|---|---|---|
| 1 REQ | board → server | method (1 = GET, 2 = POST) + path (`/api/...`, up to 300 bytes) |
| 2 RES | server → board | HTTP status (u16 LE) + body |
| 3 HELLO | server → board, every 1 s | protocol version (1 byte) |
| 7 PROBE | server → board | empty ("who are you?") |
| 4 BEACON | board → server | board name (`streamdeck-esp`), only in reply to PROBE |

The board's **text logs** leave through the same port; the server ignores everything that is not a valid frame (the header xor prevents false positives). A board with no HELLO for 5 s goes back to Wi-Fi.

## How it works
1. The server looks for ports with VID `303A` (Espressif) every 3 s, opens the port (`hupcl: false`, so it does not reset the board), sends **PROBE** and waits for the **BEACON** (2.5 s). Anything that does not answer (another ESP32 board) is ignored for 60 s.
2. With the board confirmed, it sends HELLO every second. The board starts using the cable (`usbActive()`), polls `/api/deck` every 0.6 s (on Wi-Fi: 1.5 s) and shows "Mac connected (USB)".
3. REQ/RES are sequential (one request at a time); image/animation RES frames are sent in 1 KB pieces with 1 ms between them, because the board's USB RX queue (16 KB) drops bytes if it fills up.
4. `board_ip` in `/api/status` becomes `USB` (header `X-Deck-Via: usb` on the repeated request).

## Firmware
- **A single task (Core 0, `usbrx`) reads the serial** (`Serial.setRxBufferSize(16384)`): it separates text from frames; debug commands (`T x,y`, `P`, `S`, `H`, `K`, `W`) reach `loop()` through `usbCmd()`.
- `usbRequest()` sends the REQ with **one** `Serial.write` (HWCDC holds a mutex: it must not mix with logs from other tasks) and waits for the RES; the timeout applies to the *absence of bytes*.
- Images go straight into the destination buffer (no copy); `/api/deck` goes into a 24 KB buffer in PSRAM.

## Operation
- `GET /api/status` and `GET /api/usb`: `{enabled, state: off|searching|connected|unavailable, port, board, requests, error}`.
- `POST /api/usb {"enabled": false}`: **releases the port** (and stores the preference in `usb.json`). **Do this before flashing the firmware with esptool** and turn it back on afterwards (`{"enabled": true}`).
- Test instances (`DECK_NOMDNS` without `DECK_USB`, `DECK_DRYRUN` or `DECK_NOUSB`) **do not open the USB port**: otherwise they would grab the real board. The Mac app starts the server with `DECK_NOMDNS=1` and therefore passes `DECK_USB=1`.
- Without the `serialport` module (or without permission), the app carries on normally over Wi-Fi (`state: unavailable`).
- Windows: the Windows 10/11 USB-Serial/JTAG driver usually works on its own; not validated on a real machine.
