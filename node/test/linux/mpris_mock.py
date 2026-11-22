#!/usr/bin/env python3
# Player MPRIS falso para validar os botões de mídia no Linux (playerctl <-> D-Bus de sessão). Uso: python3 mpris_mock.py (precisa de `pip install dbus-next` e de um barramento de sessão).
import asyncio
from dbus_next.aio import MessageBus
from dbus_next.service import ServiceInterface, method, dbus_property, signal
from dbus_next import Variant, PropertyAccess

TRACKS = [('Mock Song', 'Mock Artist'), ('Mock Song 2', 'Mock Artist 2')]
state = {'status': 'Playing', 'i': 0}

class Root(ServiceInterface):
    def __init__(self): super().__init__('org.mpris.MediaPlayer2')
    @method()
    def Raise(self): pass
    @method()
    def Quit(self): pass
    @dbus_property(access=PropertyAccess.READ)
    def CanQuit(self) -> 'b': return True
    @dbus_property(access=PropertyAccess.READ)
    def Identity(self) -> 's': return 'MockPlayer'

class Player(ServiceInterface):
    def __init__(self): super().__init__('org.mpris.MediaPlayer2.Player')
    @method()
    def PlayPause(self): state['status'] = 'Paused' if state['status'] == 'Playing' else 'Playing'
    @method()
    def Play(self): state['status'] = 'Playing'
    @method()
    def Pause(self): state['status'] = 'Paused'
    @method()
    def Next(self): state['i'] = (state['i'] + 1) % len(TRACKS)
    @method()
    def Previous(self): state['i'] = (state['i'] - 1) % len(TRACKS)
    @dbus_property(access=PropertyAccess.READ)
    def PlaybackStatus(self) -> 's': return state['status']
    @dbus_property(access=PropertyAccess.READ)
    def Metadata(self) -> 'a{sv}':
        t, a = TRACKS[state['i']]
        return {'mpris:trackid': Variant('o', '/mock/track/%d' % state['i']), 'xesam:title': Variant('s', t), 'xesam:artist': Variant('as', [a]), 'mpris:artUrl': Variant('s', 'http://127.0.0.1:9/capa.png')}
    @dbus_property(access=PropertyAccess.READ)
    def CanControl(self) -> 'b': return True
    @dbus_property(access=PropertyAccess.READ)
    def CanGoNext(self) -> 'b': return True
    @dbus_property(access=PropertyAccess.READ)
    def CanGoPrevious(self) -> 'b': return True
    @dbus_property(access=PropertyAccess.READ)
    def CanPlay(self) -> 'b': return True
    @dbus_property(access=PropertyAccess.READ)
    def CanPause(self) -> 'b': return True

async def main():
    bus = await MessageBus().connect()
    bus.export('/org/mpris/MediaPlayer2', Root()); bus.export('/org/mpris/MediaPlayer2', Player())
    await bus.request_name('org.mpris.MediaPlayer2.mock')
    print('mock pronto', flush=True)
    await asyncio.get_event_loop().create_future()
asyncio.run(main())
