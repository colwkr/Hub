# POS TV link: lets POS work the LG TV like its remote.
#
# It runs quietly on this PC (no window). It only makes outgoing connections: one to POS (Supabase), and one to the TV
# on the home network. Nothing on this PC is opened up, and the only things it will pass to the TV are remote presses:
# the buttons, volume, mute, power, opening an app that's on the TV, and typing into the TV's search box.
#
# Files next to it:
#   pos_tv.json     how to reach POS (written by Claude; no passwords)
#   pos_tv_tv.json  the TV's address and the pairing key the TV hands out when you press Accept (stays on this PC)
#   pos_tv.log      what happened, newest at the bottom
#
# To stop it starting with Windows: Settings > Apps > Startup, turn off "POS TV", or delete POS TV from the Startup folder.
import asyncio, base64, hashlib, json, os, re, socket, ssl, struct, subprocess, sys, threading, time, urllib.parse

VERSION = '2026.10.12'
HERE = os.path.dirname(os.path.abspath(__file__))
ME = os.path.abspath(__file__)
CONF = os.path.join(HERE, 'pos_tv.json')
TVF = os.path.join(HERE, 'pos_tv_tv.json')
LOG = os.path.join(HERE, 'pos_tv.log')
LOCK = os.path.join(HERE, 'pos_tv.lock')
WIN = os.name == 'nt'
NOWIN = 0x08000000 if WIN else 0  # CREATE_NO_WINDOW

# the presses POS may send; anything else is dropped
BUTTONS = {'UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK', 'HOME', 'EXIT', 'PLAY', 'PAUSE', 'STOP', 'REWIND',
           'FASTFORWARD', 'VOLUMEUP', 'VOLUMEDOWN', 'MUTE', 'MENU', 'QMENU', 'INFO', 'CHANNELUP', 'CHANNELDOWN', 'CC',
           'RED', 'GREEN', 'YELLOW', 'BLUE', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'}
OFF_STATES = {'Active Standby', 'Suspend', 'Power Off'}


# ---------------------------------------------------------------- small things
def log(*a):
    line = time.strftime('%Y-%m-%d %H:%M:%S ') + ' '.join(str(x) for x in a)
    try:
        if os.path.exists(LOG) and os.path.getsize(LOG) > 1_000_000:
            with open(LOG, 'rb') as f:
                f.seek(-200_000, 2)
                tail = f.read()
            with open(LOG, 'wb') as f:
                f.write(tail)
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass
    try:
        if sys.stdout:
            print(line, flush=True)
    except Exception:
        pass


def read_json(path, empty=None):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {} if empty is None else empty


def write_json(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def now_ms():
    return int(time.time() * 1000)


def my_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))  # picks the network the PC is on; nothing is sent
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def is_lan(host):
    return bool(re.match(r'^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)', host or ''))


def tv_tls():
    # the TV signs its own certificate, so there's nothing to check it against; this connection never leaves the house
    c = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    c.check_hostname = False
    c.verify_mode = ssl.CERT_NONE
    try:
        c.set_ciphers('DEFAULT:@SECLEVEL=0')
    except ssl.SSLError:
        pass
    return c


def say(text):
    """A small note on this PC's screen (only for things you need to act on)."""
    if not WIN:
        return
    def show():
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, text, 'POS TV', 0x40 | 0x40000)
        except Exception:
            pass
    threading.Thread(target=show, daemon=True).start()


# ---------------------------------------------------------------- websocket (just enough of it)
GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


class WS:
    def __init__(self, r, w):
        self.r, self.w, self.closed, self.last = r, w, False, time.monotonic()

    @classmethod
    async def open(cls, url, ctx=None, timeout=4.0):
        u = urllib.parse.urlsplit(url)
        sec = u.scheme == 'wss'
        host, port = u.hostname, u.port or (443 if sec else 80)
        path = (u.path or '/') + (('?' + u.query) if u.query else '')
        proxy = os.environ.get('POS_TV_PROXY')  # only used when testing somewhere that needs one
        if proxy and not is_lan(host):
            pu = urllib.parse.urlsplit(proxy)
            r, w = await asyncio.wait_for(asyncio.open_connection(pu.hostname, pu.port), timeout)
            w.write(f'CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n'.encode())
            await w.drain()
            head = await asyncio.wait_for(r.readuntil(b'\r\n\r\n'), timeout)
            if b' 200' not in head.split(b'\r\n', 1)[0]:
                w.close()
                raise ConnectionError('proxy: ' + head[:80].decode('latin1'))
            if sec:
                await w.start_tls(ctx, server_hostname=host)
        else:
            r, w = await asyncio.wait_for(asyncio.open_connection(
                host, port, ssl=ctx if sec else None, server_hostname=host if sec else None), timeout)
        sock = w.get_extra_info('socket')
        if sock is not None:
            try:
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)  # send each press the moment it's written
            except OSError:
                pass
        key = base64.b64encode(os.urandom(16)).decode()
        w.write((f'GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                 f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: POS-TV/{VERSION}\r\n\r\n').encode())
        await w.drain()
        head = await asyncio.wait_for(r.readuntil(b'\r\n\r\n'), timeout)
        first = head.split(b'\r\n', 1)[0]
        if b' 101' not in first:
            w.close()
            raise ConnectionError(first.decode('latin1', 'replace'))
        want = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest())
        if want not in head:
            w.close()
            raise ConnectionError('bad websocket answer')
        return cls(r, w)

    def send(self, data, op=1):
        if self.closed:
            raise ConnectionError('closed')
        b = data.encode() if isinstance(data, str) else bytes(data)
        n = len(b)
        h = bytearray([0x80 | op])
        if n < 126:
            h.append(0x80 | n)
        elif n < 65536:
            h.append(0x80 | 126)
            h += struct.pack('!H', n)
        else:
            h.append(0x80 | 127)
            h += struct.pack('!Q', n)
        m = os.urandom(4)
        h += m
        if n:
            mm = (m * (n // 4 + 1))[:n]
            b = (int.from_bytes(b, 'big') ^ int.from_bytes(mm, 'big')).to_bytes(n, 'big')
        self.w.write(bytes(h) + b)

    async def recv(self):
        buf, kind = b'', 1
        while True:
            h = await self.r.readexactly(2)
            fin, op, n = h[0] & 0x80, h[0] & 0x0F, h[1] & 0x7F
            if n == 126:
                n = struct.unpack('!H', await self.r.readexactly(2))[0]
            elif n == 127:
                n = struct.unpack('!Q', await self.r.readexactly(8))[0]
            mk = await self.r.readexactly(4) if h[1] & 0x80 else None
            p = await self.r.readexactly(n) if n else b''
            if mk and p:
                mm = (mk * (len(p) // 4 + 1))[:len(p)]
                p = (int.from_bytes(p, 'big') ^ int.from_bytes(mm, 'big')).to_bytes(len(p), 'big')
            self.last = time.monotonic()
            if op == 8:
                self.closed = True
                raise ConnectionError('closed by the other side')
            if op == 9:
                try:
                    self.send(p, 10)
                except ConnectionError:
                    pass
                continue
            if op == 10:
                continue
            if op in (1, 2):
                kind, buf = op, p
            else:
                buf += p
            if fin:
                return buf.decode('utf-8', 'replace') if kind == 1 else buf

    def ping(self):
        self.send(b'', 9)

    def close(self):
        if not self.closed:
            try:
                self.send(b'\x03\xe8', 8)
            except Exception:
                pass
            self.closed = True
        try:
            self.w.close()
        except Exception:
            pass


# ---------------------------------------------------------------- finding the TV
def ssdp_search(wait=2.5):
    msg = ('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\n'
           'ST: urn:lge-com:service:webos-second-screen:1\r\n\r\n').encode()
    found = []
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
        s.settimeout(0.4)
        end = time.time() + wait
        sent = 0
        while time.time() < end:
            if sent < 3:
                s.sendto(msg, ('239.255.255.250', 1900))
                sent += 1
            try:
                data, (ip, _) = s.recvfrom(4096)
            except socket.timeout:
                continue
            t = data.decode('latin1', 'replace').lower()
            if ('webos' in t or 'lge' in t) and ip not in found:
                found.append(ip)
    except OSError as e:
        log('ssdp:', e)
    finally:
        s.close()
    return found


async def tv_model(ip, port, sec):
    """Which LG TV is at this address (its model), without asking it for anything else. None if it isn't one."""
    try:
        ws = await WS.open(f'{"wss" if sec else "ws"}://{ip}:{port}', tv_tls() if sec else None, 2.5)
    except Exception:
        return None
    try:
        ws.send(json.dumps({'id': 'hello', 'type': 'hello', 'payload': {}}))
        m = json.loads(await asyncio.wait_for(ws.recv(), 3))
        if m.get('type') != 'hello':
            return None
        ws.send(json.dumps({'id': 'sys0', 'type': 'request', 'uri': 'ssap://system/getSystemInfo', 'payload': {}}))
        try:
            m = json.loads(await asyncio.wait_for(ws.recv(), 3))
            return (m.get('payload') or {}).get('modelName') or '?'
        except Exception:
            return '?'
    except Exception:
        return None
    finally:
        ws.close()


def is_mine(model, want):
    if not want:
        return True
    if not model or model == '?':
        return False
    a, b = re.sub(r'[^A-Z0-9]', '', model.upper()), re.sub(r'[^A-Z0-9]', '', want.upper())
    return a.startswith(b) or b.startswith(a)


async def pick(ips, ports, want):
    for ip in ips:
        for port, sec in ports:
            model = await tv_model(ip, port, sec)
            if model is None:
                continue
            if is_mine(model, want):
                log(f'found your TV ({model}) at {ip}')
                return ip
            log(f'skipping another TV on the network: {model} at {ip}')
            break
    return None


async def discover(ports, scan=True, want=None):
    loop = asyncio.get_running_loop()
    hits = await loop.run_in_executor(None, ssdp_search)
    ip = await pick(hits, ports, want)
    if ip or not scan:
        return ip
    mine = my_ip()
    if not mine:
        return None
    prefix = mine.rsplit('.', 1)[0]
    sem = asyncio.Semaphore(96)
    port0 = ports[0][0]

    async def knock(ip):
        async with sem:
            try:
                _, w = await asyncio.wait_for(asyncio.open_connection(ip, port0), 0.7)
                w.close()
                return ip
            except Exception:
                return None
    open_ = [ip for ip in await asyncio.gather(*[knock(f'{prefix}.{i}') for i in range(1, 255)]) if ip and ip != mine and ip not in hits]
    return await pick(open_, ports, want)


def wake(macs, ip=None):
    """Wake-on-LAN: the TV listens for this while it's off (Turn on via Wi-Fi)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        targets = ['255.255.255.255']
        if ip:
            targets.append(ip)
        for mac in macs:
            hx = re.sub(r'[^0-9a-fA-F]', '', mac or '')
            if len(hx) != 12:
                continue
            pkt = b'\xff' * 6 + bytes.fromhex(hx) * 16
            for t in targets:
                for port in (9, 7):
                    try:
                        s.sendto(pkt, (t, port))
                    except OSError:
                        pass
    finally:
        s.close()


def arp_mac(ip):
    if not WIN or not ip:
        return None
    try:
        out = subprocess.run(['arp', '-a', ip], capture_output=True, text=True, timeout=5, creationflags=NOWIN).stdout
        m = re.search(r'([0-9a-f]{2}(?:-[0-9a-f]{2}){5})', out, re.I)
        return m.group(1).replace('-', ':').lower() if m else None
    except Exception:
        return None


# ---------------------------------------------------------------- the TV
REGISTER = {
    'forcePairing': False, 'pairingType': 'PROMPT',
    'manifest': {'appVersion': '1.1', 'manifestVersion': 1, 'permissions': [
        'APP_TO_APP', 'CLOSE', 'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK', 'CONTROL_INPUT_MEDIA_PLAYBACK',
        'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_TEXT', 'CONTROL_INPUT_TV', 'CONTROL_MOUSE_AND_KEYBOARD',
        'CONTROL_POWER', 'CONTROL_TV_SCREEN', 'LAUNCH', 'LAUNCH_WEBAPP', 'READ_APP_STATUS', 'READ_COUNTRY_INFO',
        'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST', 'READ_INSTALLED_APPS', 'READ_LGE_SDX',
        'READ_LGE_TV_INPUT_EVENTS', 'READ_NETWORK_STATE', 'READ_NOTIFICATIONS', 'READ_POWER_STATE',
        'READ_RUNNING_APPS', 'READ_SETTINGS', 'READ_TV_CHANNEL_LIST', 'READ_TV_CURRENT_TIME', 'READ_UPDATE_INFO',
        'SEARCH', 'TEST_OPEN', 'TEST_PROTECTED', 'TEST_SECURE', 'UPDATE_FROM_REMOTE_APP', 'WRITE_NOTIFICATION_ALERT',
        'WRITE_NOTIFICATION_TOAST', 'WRITE_SETTINGS']},
}


class NotPaired(Exception):
    pass


class WrongTV(Exception):
    pass


class TV:
    def __init__(self):
        self.link = None
        self.info = read_json(TVF)
        self.ws = self.pin = None
        self.n = 0
        self.wait, self.subs = {}, {}
        self.kick = asyncio.Event()
        self.hold = False  # after a declined/missed pairing, wait for POS to ask again
        self.want = None
        self.home_until = 0
        self.waking_until = 0
        self.apps, self.apps_rev = [], 0
        self.st = {'tv': 'searching', 'vol': None, 'muted': False, 'out': None, 'app': None, 'play': None, 'kb': False,
                   'power': None}
        p = os.environ.get('POS_TV_PORTS')  # only for testing, like "wss:13001,ws:13000"
        self.ports = [(int(x.split(':')[1]), x.startswith('wss')) for x in p.split(',')] if p else [(3001, True), (3000, False)]
        if self.info.get('port'):
            self.ports.sort(key=lambda x: x[0] != self.info['port'])
        self._push_t = None

    # ---- state out to POS
    def snapshot(self, with_apps=False):
        s = {k: v for k, v in self.st.items() if k != 'power'}
        s.update(v=1, at=now_ms(), name=self.info.get('name') or 'LG TV', model=self.info.get('model'),
                 appName=self.app_name(self.st.get('app')), appsRev=self.apps_rev, bridge=VERSION)
        if with_apps:
            s['apps'] = self.apps
        return s

    def push(self, with_apps=False, soon=True):
        if not self.link:
            return
        if not soon or with_apps:
            if self._push_t:
                self._push_t.cancel()
                self._push_t = None
            self.link.send('state', self.snapshot(with_apps))
            return
        if self._push_t:
            return
        loop = asyncio.get_running_loop()

        def go():
            self._push_t = None
            self.link.send('state', self.snapshot())
        self._push_t = loop.call_later(0.03, go)  # gather a burst of changes into one message

    def set(self, **kw):
        changed = False
        for k, v in kw.items():
            if self.st.get(k) != v:
                self.st[k] = v
                changed = True
        if changed:
            self.push()

    def app_name(self, app_id):
        if not app_id:
            return None
        for a in self.apps:
            if a['id'] == app_id:
                return a['title']
        known = {'com.webos.app.home': 'Home', 'com.webos.app.livetv': 'Live TV', 'com.webos.app.hdmi1': 'HDMI 1',
                 'com.webos.app.hdmi2': 'HDMI 2', 'com.webos.app.hdmi3': 'HDMI 3', 'com.webos.app.hdmi4': 'HDMI 4'}
        return known.get(app_id)

    def connected(self):
        return self.ws is not None and not self.ws.closed

    # ---- talking to the TV
    def send(self, uri, payload=None, kind='request', cb=None):
        if not self.connected():
            return None
        self.n += 1
        i = f'p{self.n}'
        if cb:
            self.subs[i] = cb
        self.ws.send(json.dumps({'id': i, 'type': kind, 'uri': uri, 'payload': payload or {}}))
        return i

    async def ask(self, uri, payload=None, timeout=5.0):
        if not self.connected():
            raise ConnectionError('TV not connected')
        self.n += 1
        i = f'p{self.n}'
        fut = asyncio.get_running_loop().create_future()
        self.wait[i] = fut
        self.ws.send(json.dumps({'id': i, 'type': 'request', 'uri': uri, 'payload': payload or {}}))
        try:
            m = await asyncio.wait_for(fut, timeout)
        finally:
            self.wait.pop(i, None)
        if m.get('type') == 'error':
            raise RuntimeError(m.get('error') or 'TV said no')
        return m.get('payload') or {}

    def press(self, name):
        if not self.connected():
            return
        if self.pin and not self.pin.closed:
            try:
                self.pin.send(f'type:button\nname:{name}\n\n')
                return
            except Exception:
                pass
        asyncio.ensure_future(self.press_later(name))

    async def press_later(self, name):
        try:
            await self.open_pointer()
            self.pin.send(f'type:button\nname:{name}\n\n')
        except Exception as e:
            log('button did not go through:', e)

    async def open_pointer(self):
        r = await self.ask('ssap://com.webos.service.networkinput/getPointerInputSocket')
        path = r.get('socketPath')
        if not path:
            raise RuntimeError('no pointer socket')
        if self.pin:
            self.pin.close()
        self.pin = await WS.open(path, tv_tls() if path.startswith('wss') else None, 3)
        asyncio.ensure_future(self.drain(self.pin))

    async def drain(self, ws):
        try:
            while True:
                await ws.recv()
        except Exception:
            ws.closed = True

    async def open_main(self, ip):
        last = None
        quick = time.time() < self.waking_until  # while it's waking, knock often and briefly
        for port, sec in (self.ports[:1] if quick else self.ports):
            try:
                ws = await WS.open(f'{"wss" if sec else "ws"}://{ip}:{port}', tv_tls() if sec else None, 1.5 if quick else 3)
                if self.info.get('port') != port:
                    self.info['port'] = port
                    self.save()
                return ws
            except Exception as e:
                last = e
        raise last or ConnectionError('no answer')

    async def recv_json(self, ws, timeout):
        return json.loads(await asyncio.wait_for(ws.recv(), timeout))

    async def session(self, ip):
        ws = await self.open_main(ip)
        try:
            ws.send(json.dumps({'id': 'hello', 'type': 'hello', 'payload': {}}))
            m = await self.recv_json(ws, 6)
            if m.get('type') != 'hello':
                raise ConnectionError('not a webOS TV')
            # newer TVs want this asked before pairing
            ws.send(json.dumps({'id': 'sys0', 'type': 'request', 'uri': 'ssap://system/getSystemInfo', 'payload': {}}))
            model = None
            try:
                m = await self.recv_json(ws, 6)
                model = (m.get('payload') or {}).get('modelName')
            except asyncio.TimeoutError:
                pass
            if model and model != '?' and not is_mine(model, self.want):
                raise WrongTV(f'{model} at {ip} is not yours')
            if (not model or model == '?') and not (self.info.get('key') and self.info.get('ip') == ip):
                raise ConnectionError('the TV is still starting up')  # wait for it to say which TV it is
            if model and self.info.get('model') != model:
                self.info['model'] = model
                self.save()
            reg = dict(REGISTER)
            if self.info.get('key'):
                reg['client-key'] = self.info['key']
            ws.send(json.dumps({'id': 'register_0', 'type': 'register', 'payload': reg}))
            first = not self.info.get('key')
            deadline = time.monotonic() + 95
            while True:
                m = await self.recv_json(ws, max(1, deadline - time.monotonic()))
                if m.get('id') != 'register_0':
                    continue
                t = m.get('type')
                if t == 'registered':
                    key = (m.get('payload') or {}).get('client-key')
                    if key and key != self.info.get('key'):
                        self.info['key'] = key
                        self.save()
                    break
                if t == 'error':
                    raise NotPaired(m.get('error') or 'declined')
                if t == 'response' and (m.get('payload') or {}).get('pairingType') == 'PROMPT':
                    log('asking the TV for permission (press Accept on the TV)')
                    self.set(tv='pairing')
                    self.push(soon=False)
        except WrongTV:
            ws.close()
            raise
        except asyncio.TimeoutError:
            ws.close()
            if self.st['tv'] == 'pairing':
                raise NotPaired('nobody answered the TV')
            raise
        except Exception:
            ws.close()
            raise

        self.ws, self.wait, self.subs = ws, {}, {}
        reader = asyncio.ensure_future(self.read(ws))
        log('connected to the TV at', ip)
        try:
            await self.open_pointer()
        except Exception as e:
            log('pointer socket:', e)
        self.set(tv='on')
        self.subscribe()
        asyncio.ensure_future(self.learn_mac(ip))
        if first:
            self.send('ssap://system.notifications/createToast', {'message': 'POS remote is connected'})
            say('Paired with the TV. POS can work it now.')
        self.push(with_apps=True)
        try:
            while not reader.done():
                await asyncio.sleep(4)
                if reader.done():
                    break
                if time.monotonic() - ws.last > 11:
                    log('the TV stopped answering')
                    break
                try:
                    ws.ping()
                    if self.pin and not self.pin.closed:
                        self.pin.ping()
                except Exception:
                    break
        finally:
            reader.cancel()
            ws.close()
            if self.pin:
                self.pin.close()
            self.ws = self.pin = None

    async def read(self, ws):
        try:
            while True:
                raw = await ws.recv()
                try:
                    m = json.loads(raw)
                except ValueError:
                    continue
                i = m.get('id')
                if i in self.wait:
                    f = self.wait.pop(i)
                    if not f.done():
                        f.set_result(m)
                elif i in self.subs:
                    try:
                        self.subs[i](m.get('payload') or {}, m)
                    except Exception as e:
                        log('reading', i, e)
        except Exception:
            ws.closed = True

    def subscribe(self):
        def power(p, m):
            s = p.get('state')
            if not s:
                return
            proc = p.get('processing') or ''
            off = s in OFF_STATES or 'Power Off' in proc
            self.st['power'] = s
            if off:
                self.set(tv='waking' if time.time() < self.waking_until else 'off', play=None)
            else:
                self.waking_until = 0
                self.set(tv='screenoff' if s == 'Screen Off' else 'on')

        def app(p, m):
            a = p.get('appId')
            if a is not None:
                self.set(app=a or None)
                if a and time.time() < self.home_until:
                    self.home_until = 0
                    asyncio.ensure_future(self.home_if_blank(a))

        def volume(p, m):
            v = p.get('volumeStatus') or p
            if 'volume' in v:
                self.set(vol=v.get('volume'))
            mu = v.get('muteStatus', v.get('muted', v.get('mute')))
            if mu is not None:
                self.set(muted=bool(mu))
            if v.get('soundOutput'):
                self.set(out=v.get('soundOutput'))

        def status(p, m):
            if 'mute' in p:
                self.set(muted=bool(p['mute']))
            if 'volume' in p and p['volume'] is not None and p['volume'] >= 0:
                self.set(vol=p['volume'])

        def apps(p, m):
            lp = p.get('launchPoints')
            if lp is not None:
                self.apps = [{'id': a.get('id'), 'title': a.get('title') or a.get('id')} for a in lp if a.get('id')]
            elif p.get('change') and p.get('id'):
                self.apps = [a for a in self.apps if a['id'] != p['id']]
                if p['change'] != 'removed':
                    self.apps.append({'id': p['id'], 'title': p.get('title') or p['id']})
            else:
                return
            self.apps_rev += 1
            self.push(with_apps=True)

        def media(p, m):
            info = p.get('foregroundAppInfo')
            if info is None:
                return
            cur = [x for x in info if x.get('appId') == self.st.get('app')] or info
            ps = cur[-1].get('playState') if cur else None
            self.set(play=ps if ps in ('playing', 'paused') else None)

        def output(p, m):
            if p.get('soundOutput'):
                self.set(out=p['soundOutput'])

        def keyboard(p, m):
            w = p.get('currentWidget')
            if isinstance(w, dict):
                self.set(kb=bool(w.get('focus')))

        S = 'subscribe'
        self.send('ssap://com.webos.service.tvpower/power/getPowerState', kind=S, cb=power)
        self.send('ssap://com.webos.applicationManager/getForegroundAppInfo', kind=S, cb=app)
        self.send('ssap://audio/getVolume', kind=S, cb=volume)
        self.send('ssap://audio/getStatus', kind=S, cb=status)
        self.send('ssap://com.webos.applicationManager/listLaunchPoints', kind=S, cb=apps)
        self.send('ssap://com.webos.media/getForegroundAppInfo', kind=S, cb=media)
        self.send('ssap://com.webos.service.apiadapter/audio/getSoundOutput', kind=S, cb=output)
        self.send('ssap://com.webos.service.ime/registerRemoteKeyboard', kind=S, cb=keyboard)

    async def learn_mac(self, ip):
        macs = []
        try:
            r = await self.ask('ssap://com.webos.service.connectionmanager/getinfo')
            for k in ('wifiInfo', 'wiredInfo'):
                mac = (r.get(k) or {}).get('macAddress')
                if mac:
                    macs.append(mac.lower())
        except Exception:
            pass
        a = await asyncio.get_running_loop().run_in_executor(None, arp_mac, ip)
        if a and a not in macs:
            macs.append(a)
        if macs and set(macs) != set(self.info.get('macs') or []):
            self.info['macs'] = macs
            self.save()

    def save(self):
        try:
            write_json(TVF, self.info)
        except Exception as e:
            log('could not save TV details:', e)

    # ---- the loop that keeps a connection to the TV
    async def run(self):
        fails = looks = 0
        while True:
            ip = self.info.get('ip')
            if (not ip or (fails and fails % 15 == 0)) and not self.hold:
                if not ip:
                    self.set(tv='searching')
                # asking the network is cheap; knocking on every address is saved for when there's no address yet,
                # and then only now and then (a TV that's off answers neither)
                looks += 1
                found = await discover(self.ports, scan=not ip and (looks <= 3 or looks % 12 == 0), want=self.want)
                if found and found != ip:
                    self.info['ip'] = ip = found
                    self.save()
            if ip and not self.hold:
                try:
                    await self.session(ip)
                    fails = 0
                except WrongTV as e:
                    # another TV now has your TV's address; keep your TV's pairing and look for it again
                    log('not your TV:', e)
                    for k in ('ip', 'port'):
                        self.info.pop(k, None)
                    self.save()
                    ip = None
                    fails = 0
                    self.set(tv='searching')
                    continue
                except NotPaired as e:
                    log('not paired:', e)
                    self.hold = True
                    self.set(tv='unpaired')
                    self.push(soon=False)
                except Exception as e:
                    fails += 1
                    if fails in (1, 10) or fails % 60 == 0:
                        log('TV not reachable:', repr(e)[:160])
            if not self.hold and self.st['tv'] not in ('searching',):
                self.set(tv='waking' if time.time() < self.waking_until else ('off' if ip else 'searching'), play=None,
                         kb=False)
            waking = time.time() < self.waking_until
            try:
                await asyncio.wait_for(self.kick.wait(), 0.8 if waking else (4 if fails < 20 else 8))
            except asyncio.TimeoutError:
                pass
            self.kick.clear()

    # ---- what POS asks for
    def handle(self, c):
        k = c.get('c')
        if k == 'btn':
            name = str(c.get('k', '')).upper()
            if name in BUTTONS:
                self.press(name)
        elif k == 'vol':
            try:
                v = max(0, min(100, int(c.get('v'))))
            except (TypeError, ValueError):
                return
            self.st['vol'] = v
            self.send('ssap://audio/setVolume', {'volume': v})
        elif k == 'volstep':
            self.send('ssap://audio/volumeUp' if (c.get('d') or 0) > 0 else 'ssap://audio/volumeDown')
        elif k == 'mute':
            self.send('ssap://audio/setMute', {'mute': bool(c.get('on'))})
        elif k == 'launch':
            app = str(c.get('id', ''))
            if any(a['id'] == app for a in self.apps):
                self.send('ssap://system.launcher/launch', {'id': app})
        elif k == 'text':
            t = str(c.get('t', ''))[:200]
            if t:
                self.send('ssap://com.webos.service.ime/insertText', {'text': t, 'replace': 0})
        elif k == 'del':
            try:
                n = max(1, min(60, int(c.get('n', 1))))
            except (TypeError, ValueError):
                n = 1
            self.send('ssap://com.webos.service.ime/deleteCharacters', {'count': n})
        elif k == 'enter':
            self.send('ssap://com.webos.service.ime/sendEnterKey')
        elif k == 'power':
            if c.get('on'):
                self.power_on()
            else:
                self.power_off()
        elif k == 'hello':
            self.push(with_apps=True)
        elif k == 'pair':
            if self.hold or self.st['tv'] in ('unpaired', 'searching', 'off'):
                log('POS asked to pair again')
                self.hold = False
                self.kick.set()

    async def home_if_blank(self, app):
        """Turned on from POS and it came up on an input with nothing on it ("No signal"): go to Home instead."""
        log('after turning on, the TV opened', app)
        blank = False
        try:
            await asyncio.sleep(1.2)
            if app.startswith('com.webos.app.hdmi') or app.startswith('com.webos.app.externalinput'):
                r = await self.ask('ssap://tv/getExternalInputList')
                dev = [d for d in (r.get('devices') or []) if d.get('appId') == app]
                blank = not dev or not dev[0].get('connected')
            elif app == 'com.webos.app.livetv':
                try:
                    r = await self.ask('ssap://tv/getChannelList')
                    blank = not (r.get('channelList') or [])
                except Exception:
                    blank = True
        except Exception as e:
            log('checking the input:', e)
        if blank and self.st.get('app') == app:
            log('nothing on that input; going Home')
            self.press('HOME')

    def power_on(self):
        self.waking_until = time.time() + 35
        self.home_until = time.time() + 60
        if self.connected() and self.st.get('power') == 'Screen Off':
            self.send('ssap://com.webos.service.tvpower/power/turnOnScreen', {'standbyMode': 'active'})
            return
        wake(self.info.get('macs') or [], self.info.get('ip'))
        if self.connected():
            self.send('ssap://system/turnOn')
        self.set(tv='waking')
        self.push(soon=False)
        self.kick.set()

        async def again():
            for d in (1.5, 3, 5):
                await asyncio.sleep(d)
                if self.st['tv'] in ('on', 'screenoff') or time.time() > self.waking_until:
                    return
                wake(self.info.get('macs') or [], self.info.get('ip'))
        asyncio.ensure_future(again())

    def power_off(self):
        self.waking_until = 0
        if self.connected():
            self.send('ssap://system/turnOff')
            self.set(tv='off', play=None)
            self.push(soon=False)


# ---------------------------------------------------------------- POS (Supabase Realtime)
class Link:
    def __init__(self, conf, tv):
        self.url = conf['url'].rstrip('/').replace('https://', 'wss://')
        self.key = conf['key']
        self.topic = 'realtime:' + conf['topic']
        self.tv = tv
        self.ws = None
        self.up = False
        self.ref = 0
        self.lines = {}

    def send(self, event, payload):
        if not self.up or not self.ws or self.ws.closed:
            return
        self.ref += 1
        try:
            self.ws.send(json.dumps({'topic': self.topic, 'event': 'broadcast', 'ref': str(self.ref), 'join_ref': '1',
                                     'payload': {'type': 'broadcast', 'event': event, 'payload': payload}}))
        except Exception:
            pass

    # Presses can arrive a hair out of order; each one carries its place in line from the device that sent it,
    # so they're done in the order you pressed them (waiting at most 80 ms for one that's running late).
    def deliver(self, c):
        cid, s = c.get('cid'), c.get('s')
        if not isinstance(cid, str) or not isinstance(s, int):
            return self.do(c)
        q = self.lines.get(cid)
        if q is None:
            if len(self.lines) > 50:
                self.lines.clear()
            q = self.lines[cid] = {'last': s - 1, 'buf': {}, 't': None}
        if s <= q['last']:
            return self.do(c)  # a straggler that was already given up on: do it now rather than lose it
        q['buf'][s] = c
        self.flush(cid)

    def flush(self, cid):
        q = self.lines[cid]
        while q['last'] + 1 in q['buf']:
            q['last'] += 1
            self.do(q['buf'].pop(q['last']))
        if q['buf'] and not q['t']:
            q['t'] = asyncio.get_running_loop().call_later(0.08, self.skip, cid)
        elif not q['buf'] and q['t']:
            q['t'].cancel()
            q['t'] = None

    def skip(self, cid):
        q = self.lines.get(cid)
        if not q:
            return
        q['t'] = None
        if q['buf']:
            q['last'] = min(q['buf']) - 1
            self.flush(cid)

    def do(self, c):
        try:
            self.tv.handle(c)
        except Exception as e:
            log('could not do', c.get('c'), e)

    async def run(self):
        wait = 1
        while True:
            hb = None
            try:
                ws = await WS.open(f'{self.url}/realtime/v1/websocket?apikey={urllib.parse.quote(self.key)}&vsn=1.0.0',
                                   ssl.create_default_context(), 10)
                self.ws, self.ref = ws, 1
                ws.send(json.dumps({'topic': self.topic, 'event': 'phx_join', 'ref': '1', 'join_ref': '1', 'payload': {
                    'config': {'broadcast': {'ack': False, 'self': False}, 'presence': {'key': ''},
                               'postgres_changes': [], 'private': False}}}))
                end = time.monotonic() + 10
                while True:
                    m = json.loads(await asyncio.wait_for(ws.recv(), max(0.5, end - time.monotonic())))
                    if m.get('event') == 'phx_reply' and m.get('ref') == '1':
                        if (m.get('payload') or {}).get('status') != 'ok':
                            raise ConnectionError('POS would not let the link in: ' + json.dumps(m.get('payload'))[:200])
                        break
                self.up = True
                wait = 1
                log('linked to POS')
                self.tv.push(with_apps=True)
                hb = asyncio.ensure_future(self.beat(ws))
                while True:
                    m = json.loads(await ws.recv())
                    ev = m.get('event')
                    if ev == 'broadcast':
                        p = m.get('payload') or {}
                        if p.get('event') == 'cmd' and isinstance(p.get('payload'), dict):
                            c = p['payload']
                            if c.get('c') == 'ping':
                                self.send('pong', {'t': c.get('t'), 'cid': c.get('cid')})
                            else:
                                self.deliver(c)
                    elif ev in ('phx_error', 'phx_close') and m.get('topic') == self.topic:
                        raise ConnectionError('POS closed the link')
            except Exception as e:
                log('POS link:', repr(e)[:200])
            finally:
                self.up = False
                if hb:
                    hb.cancel()
                if self.ws:
                    self.ws.close()
            await asyncio.sleep(wait)
            wait = min(30, wait * 2)

    async def beat(self, ws):
        n = 0
        while not ws.closed:
            await asyncio.sleep(20)
            n += 1
            try:
                ws.send(json.dumps({'topic': 'phoenix', 'event': 'heartbeat', 'payload': {}, 'ref': f'hb{n}'}))
            except Exception:
                return
            self.tv.push(soon=False)  # lets POS know the link is still here
            if time.monotonic() - ws.last > 70:
                log('POS stopped answering')
                ws.close()
                return


# ---------------------------------------------------------------- running
def take_lock():
    f = open(LOCK, 'a+')
    for _ in range(40):
        try:
            if WIN:
                import msvcrt
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return f
        except OSError:
            time.sleep(0.25)
    return None


def autostart():
    """Start with Windows (a shortcut in this user's Startup folder)."""
    if not WIN or os.environ.get('POS_TV_NO_AUTOSTART'):
        return
    folder = os.path.join(os.environ.get('APPDATA', ''), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    lnk = os.path.join(folder, 'POS TV.lnk')
    if not os.path.isdir(folder) or os.path.exists(lnk):
        return
    exe = sys.executable
    w = os.path.join(os.path.dirname(exe), 'pythonw.exe')
    if os.path.exists(w):
        exe = w
    q = lambda s: s.replace("'", "''")
    ps = (f"$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{q(lnk)}');$s.TargetPath='{q(exe)}';"
          f"$s.Arguments='\"{q(ME)}\"';$s.WorkingDirectory='{q(HERE)}';$s.WindowStyle=7;"
          f"$s.Description='POS TV remote link';$s.Save()")
    try:
        subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', ps], timeout=30, creationflags=NOWIN,
                       capture_output=True)
        log('set to start with Windows' if os.path.exists(lnk) else 'could not add to Startup')
    except Exception as e:
        log('could not add to Startup:', e)


async def watch_self(lock):
    """When Claude drops in a newer copy of this file (or new settings), start the new one."""
    def stamp():
        try:
            return (os.path.getmtime(ME), os.path.getmtime(CONF))
        except OSError:
            return None
    s0 = stamp()
    while True:
        await asyncio.sleep(5)
        s = stamp()
        if s and s != s0:
            await asyncio.sleep(1.5)  # let the copy finish
            log('new version found; restarting')
            try:
                lock.close()
            except Exception:
                pass
            subprocess.Popen([sys.executable, ME], cwd=HERE, close_fds=True, creationflags=NOWIN)
            os._exit(0)


async def main(lock):
    conf = read_json(CONF)
    if not all(conf.get(k) for k in ('url', 'key', 'topic')):
        log('pos_tv.json is missing or incomplete')
        say('POS TV is missing its settings file (pos_tv.json). Ask Claude to put it back.')
        while True:
            await asyncio.sleep(3600)
    tv = TV()
    tv.want = conf.get('model')  # only this TV; any other LG TV on the network is left alone
    if tv.info.get('model') and not is_mine(tv.info['model'], tv.want):
        log('forgetting', tv.info['model'], 'at', tv.info.get('ip'), '(not yours)')
        tv.info = {}
        tv.save()
    link = Link(conf, tv)
    tv.link = link
    log(f'POS TV link {VERSION} starting')
    if not tv.info.get('key'):
        say('POS TV is running.\n\nIf the TV is on, it will ask to allow a connection. Press Accept on the TV remote.')
    await asyncio.gather(link.run(), tv.run(), watch_self(lock))


if __name__ == '__main__':
    lock = take_lock()
    if not lock:
        sys.exit(0)  # already running
    autostart()
    try:
        asyncio.run(main(lock))
    except KeyboardInterrupt:
        pass
    except Exception as e:
        log('stopped:', repr(e))
        raise
