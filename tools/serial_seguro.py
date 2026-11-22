# Abre a serial SEM acionar DTR/RTS (senão a placa pode entrar em modo de gravação no próximo reset).
import serial,time,re
def abrir():
    s=serial.Serial(); s.port='/dev/cu.usbmodem1101'; s.baudrate=115200; s.timeout=0.3; s.write_timeout=2
    s.dtr=False; s.rts=False; s.open(); return s
def grab(s,sec):
    end=time.time()+sec; b=b''
    while time.time()<end: b+=s.read(4096)
    return b.decode(errors='replace')
