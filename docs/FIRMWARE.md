# Gravar o firmware pronto (sem compilar)

Cada Release traz o firmware da **ES3C28P** compilado pelo CI do GitHub (reproduzível: o mesmo código da tag):

| Arquivo | Para quê |
|---|---|
| `stream-deck-esp-firmware-es3c28p-<versão>-completo.bin` | Imagem **completa** (bootloader + partições + app). Grave em `0x0`. Use na primeira instalação ou para trocar o firmware de fábrica |
| `stream-deck-esp-firmware-es3c28p-<versão>-app.bin` | Só o **app**. Grave em `0x10000`. Use para **atualizar** uma placa que já roda o Stream Deck ESP, **preservando** o Wi-Fi e o pareamento |
| `SHA256SUMS-firmware.txt` | Somas para conferir os arquivos baixados |

> Só serve para a **ES3C28P** (ESP32-S3, 16 MB de flash). Para outra placa veja `ADAPTAR-PLACA.md` e compile com o PlatformIO.

## Antes de gravar
1. **Faça o backup do firmware de fábrica** (veja `hardware/ES3C28P.md`): `esptool.py --port <porta> read_flash 0 0x1000000 backup_fabrica.bin`. Guarde fora do repositório: contém a senha do Wi-Fi.
2. Instale o esptool: `python3 -m pip install --user esptool`.
3. Descubra a porta com a placa ligada por USB: macOS `ls /dev/cu.usbmodem*`; Linux `/dev/ttyACM0`; Windows `COMx` (Gerenciador de Dispositivos). O número muda ao replugar o cabo.
4. Se o app do Stream Deck estiver aberto com a conexão por cabo, desligue-a (Configurações) ou feche o app: a porta precisa estar livre.
5. Confira os arquivos: `sha256sum -c SHA256SUMS-firmware.txt` (Linux) / `shasum -a 256 -c SHA256SUMS-firmware.txt` (macOS).

## Gravar
Primeira instalação (apaga a configuração de Wi-Fi e o pareamento da placa):
```bash
esptool.py --chip esp32s3 --port <porta> --baud 921600 write_flash 0x0 stream-deck-esp-firmware-es3c28p-1.0.0-completo.bin
```
Atualizar mantendo Wi-Fi e pareamento:
```bash
esptool.py --chip esp32s3 --port <porta> --baud 921600 write_flash 0x10000 stream-deck-esp-firmware-es3c28p-1.0.0-app.bin
```
Depois da imagem completa a placa abre o **portal de Wi-Fi** próprio para você escolher a rede; em seguida clique em **Parear placa** no app.

## Problemas
- `No serial data received` / não acha a porta: **replugue o cabo** (a placa não está morta). Persistindo, segure o botão BOOT, ligue o cabo e solte.
- A tela fica apagada depois de gravar: aperte RESET ou replugue.
- Voltar ao original: `esptool.py --port <porta> write_flash 0 backup_fabrica.bin`.
