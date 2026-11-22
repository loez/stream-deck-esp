#!/usr/bin/env python3
"""Serviços simulados para testar o MODO AUTÔNOMO da placa na bancada, sem mexer em aparelhos reais.

  python3 tools/mock_services.py            # HTTP em :8099 e MQTT em :1883 (porta do broker: --mqtt 1884)

Na página do app (botões de casa inteligente) aponte para o IP deste computador:
  - Webhook:         http://<IP do Mac>:8099/hook            (qualquer método; mostra método, corpo e cabeçalhos)
  - Home Assistant:  http://<IP do Mac>:8099  com token "teste-1234" (POST /api/services/<domínio>/<serviço>; token errado = 401)
  - MQTT:            broker <IP do Mac>, porta 1883, qualquer tópico
  - Clima (Open-Meteo falso): só se a placa for apontada para cá; o clima real já funciona pela internet.
Cada pedido recebido é impresso com a hora: é assim que se confere que a PLACA (e não o servidor do app) executou o botão com o app fechado.
"""
import argparse, json, socketserver, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

TOKEN = "teste-1234"
def log(*a): print(time.strftime("%H:%M:%S"), *a, flush=True)

class H(BaseHTTPRequestHandler):
    def _go(self):
        n = int(self.headers.get("Content-Length") or 0); body = self.rfile.read(n).decode("utf-8", "replace") if n else ""
        code, out = 200, {"ok": True}
        if self.path.startswith("/api/services/"):
            if self.headers.get("Authorization") != f"Bearer {TOKEN}": code, out = 401, {"message": "token invalido"}
            else: log("HOME ASSISTANT", self.path[len("/api/services/"):], body)
        elif self.path.startswith("/v1/forecast"):
            out = {"current": {"temperature_2m": 23.4, "weather_code": 2, "is_day": 1}}; log("CLIMA", self.path[:80])
        else:
            log("WEBHOOK", self.command, self.path, "corpo=" + body, {k: v for k, v in self.headers.items() if k.lower() in ("content-type", "x-chave", "authorization")})
        data = json.dumps(out).encode(); self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _go
    def log_message(self, *a): pass

class Mqtt(socketserver.BaseRequestHandler):
    def handle(self):
        buf = b""
        while True:
            d = self.request.recv(4096)
            if not d: return
            buf += d
            while len(buf) >= 2:
                t = buf[0] >> 4; mult, ln, i = 1, 0, 1
                while True:
                    if i >= len(buf): break
                    b = buf[i]; ln += (b & 127) * mult; mult *= 128; i += 1
                    if not b & 128: break
                if i + ln > len(buf): break
                body = buf[i:i + ln]; buf = buf[i + ln:]
                if t == 1: log("MQTT CONNECT"); self.request.sendall(bytes([0x20, 2, 0, 0]))
                elif t == 3:
                    tl = int.from_bytes(body[:2], "big"); log("MQTT PUBLISH", body[2:2 + tl].decode(), "=", body[2 + tl:].decode("utf-8", "replace"), "(retain)" if buf is not None and False else "")
                elif t == 14: return

class TS(socketserver.ThreadingMixIn, socketserver.TCPServer): allow_reuse_address = True; daemon_threads = True

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--http", type=int, default=8099); ap.add_argument("--mqtt", type=int, default=1883); a = ap.parse_args()
    threading.Thread(target=lambda: TS(("0.0.0.0", a.mqtt), Mqtt).serve_forever(), daemon=True).start()
    log(f"HTTP em :{a.http} (token do Home Assistant: {TOKEN}), MQTT em :{a.mqtt}. Ctrl+C para sair.")
    HTTPServer(("0.0.0.0", a.http), H).serve_forever()
