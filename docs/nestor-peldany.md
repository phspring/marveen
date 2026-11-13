# Nestor-példány: egy telepítés, egy önálló példány, saját `nestor` paranccsal

> Cél: több Nestor fusson egymás mellett egy gépen, egymástól függetlenül, mindegyik a saját portján, saját service-ekkel,
> saját tokennel, és a szétválasztást a **szoftver** végezze, ne a fegyelem.
> **Állapot: első szelet.** Az azonosítás, a `doctor`, a `nestor init` és az indítófájl megvan. A tmux-szerver és a Claude-config
> tényleges szétválasztása, a hookok/szkriptek portjának egységesítése még hátra van (lásd lent). Semmi nem változik egy
> meglévő telepítésen, amíg nem használod a `nestor` parancsot.

---

## A név: `nestor`, de példányonként állítható

Egy új példány alapneve **`nestor`**, és ezt a `nestor init` az új telepítés `.env`-jébe **kiírja**, így sosem fallback:

| Mit nevez | Kulcs a `.env`-ben | Alapérték (`nestor init`) |
|---|---|---|
| a **fő ügynök** (a tmux-munkamenet `<név>-channels`) | `MAIN_AGENT_ID` | `nestor` |
| a **rendszer** (a service-unitok `<név>-dashboard`, `<név>-channels`) | `SERVICE_ID` | a fő ügynök neve |
| a dashboard portja | `WEB_PORT` | az első szabad port 3420-tól, a regisztrált példányokat figyelembe véve |

```
nestor init                                       # mind nestor, szabad port
nestor init --agent ada --system studio --port 4000   # a fő ügynök ada, a rendszer studio
```

A `nestor init` **soha nem ír át egy már beállított kulcsot**, és a `.env` többi sorát (tokeneket) érintetlenül hagyja.

**Egy már futott telepítésen** (van `store/claudeclaw.db` vagy `.channels-config`) a `nestor init` **azt rögzíti, amit az alkalmazás most használ**:
a `.env`-ben már megadott nevet, különben az alapnevet (`nestor`), és a `WEB_PORT`-ot, különben a 3420-at. Ha egy kapcsoló (`--agent`, `--system`, `--port`)
ettől eltérő nevet vagy portot ír be, a parancs figyelmeztetéssel kimondja, hogy ez átnevezés vagy költöztetés (új tmux-munkamenet, új unit-nevek).

### A kódbeli alapnév: `marveen` helyett `nestor` (két lépésben, kész)

1. **Rögzítés:** minden meglévő telepítés a `.env`-jében kimondja a nevét (`nestor init`), így az alapérték nem számít neki.
2. **Átírás:** az alapnév az `src/config.ts`-ben, a szkriptekben (`${MAIN_AGENT_ID:-nestor}`), a Python-hookokban és a tesztekben egyszerre lett `nestor`.

**Ami szándékosan `marveen` maradt:** a régi adat-azonosító (az adatbázis-oszlopok `DEFAULT 'marveen'`-je, a `migrate-main-agent-id.sh`, amely
a `marveen` sorokról migrál), a `~/.marveen-worker` útvonal egy `marveen` nevű telepítésnek, és a `MARVEEN_*` környezeti változók neve.

**Egy `.env`-ben névvel nem rendelkező régi telepítés frissítéskor átneveződik** `nestor`-ra (új tmux-munkamenet, új unit-nevek). Előtte futtasd rajta a
`nestor init`-et, vagy írd be a `.env`-be a régi nevét (`MAIN_AGENT_ID=marveen`). Egy átnevezett telepítés adatbázis-sorai (emlékek, kártyák) a régi
azonosítón maradnak: ezeket a `migrate-main-agent-id.sh` írja át.

---

## A `nestor` indítófájl (`bin/nestor`)

Minden telepítés a saját példányát hordozza, és **csak abban a telepítésben dolgozik, amelyikben van** (a saját útvonalából, symlinken át is, oldja fel a gyökeret).
Két telepítés egymás mellett: mindkettőnek saját `nestor`-ja van, és egyik sem nyúlhat a másikhoz.

| Parancs | Mit csinál |
|---|---|
| `nestor init [--agent N] [--system N] [--port P]` | elnevezi az új telepítést (lásd fent) |
| `nestor info` | amit a példány birtokol: port, unitok, tmux, Claude-config, token- és adatbázis-útvonal |
| `nestor register` / `unregister` | felveszi / leveszi a gép példány-listájáról (`~/.config/nestor/instances/`) |
| `nestor doctor` | összeveti a többi regisztrált példánnyal; **1-es kilépési kód**, ha kettő nem futhat egymás mellett |
| `nestor start\|stop\|restart [dashboard\|channels]` | a telepítés **saját** service-unitjai; ha nincs unit, pid-fájlos mód |
| `nestor status` | unitok, pid, és hogy a dashboard a **saját** portján válaszol-e |
| `nestor logs [-f] [dashboard\|channels]` | napló (journal vagy `store/*.log`) |
| `nestor attach` | a fő ügynök tmux-munkamenete, ennek a példánynak a tmux-szerverén |
| `nestor install-service [--force]` | megírja a dashboard user-unitját (`<SERVICE_ID>-dashboard.service`), nem engedélyezi bootra |
| `nestor node ...` | a példány Node-ját futtatja |

**Node:** `NESTOR_NODE` a környezetből vagy a `.env`-ből, különben a PATH-beli; 22-nél régebbit visszautasít (a Node 18 ezen a buildon szegfaultol).

### Amit a `nestor` szándékosan visszautasít

- **Más telepítés unitját.** Egy unit csak akkor a miénk, ha a `WorkingDirectory`-ja ez a telepítés. Egy `.env` nélküli telepítés alapneve `nestor`,
  vagyis ugyanaz, mint egy másiké: a `nestor start` ilyenkor **nem indítja a másik unitját**, hanem megmondja, kié, és hogy mit kell tenni (`SERVICE_ID` a saját `.env`-ben).
- **Más telepítés unit-fájlját** felülírni: az `install-service --force` sem írja át, ha a fájl `WorkingDirectory`-ja más.
- **Egy pid-fájlban szereplő idegen folyamatot** leállítani: csak az a folyamat a miénk, amelynek a munkakönyvtára ez a telepítés **és** `dist/index.js`-t futtat.
- A `status` nem mondja a más folyamat válaszát a sajátunknak: ha a port válaszol, de nem tőlünk, kiírja.

---

## A `nestor doctor`: hol keveredhet két példány

Minden regisztrált példány leírása a **saját** `.env`-jéből készül minden futáskor (a jegyzék csak azt tárolja, hol van a telepítés), így nem avul el.
Csak rögzített kulcsokat olvas (`MAIN_AGENT_ID`, `SERVICE_ID`, `WEB_PORT`, `WEB_HOST`, `MAIN_AGENT_ISOLATED_CONFIG`, `TMUX_TMPDIR`, `NESTOR_NODE`): a `.env` titkait nem.

| Szint | Mikor |
|---|---|
| **ERROR** | azonos telepítési könyvtár; azonos port ugyanazon a hoston; azonos service-unit név |
| **WARN** | azonos tmux-szerver **és** azonos fő munkamenet-név; azonos tmux-szerver egyáltalán (az ügynök-munkamenetek az ügynök nevét viselik, tehát két azonos nevű ügynök ütközik); azonos Claude-config könyvtár (a `~/.claude`: közös settings, skillek, plugin-állapot) |
| **NOTE** | a példány valamit alapértékre bíz (nincs `MAIN_AGENT_ID`, `SERVICE_ID` vagy `WEB_PORT` a `.env`-ben) |

Ma egy dev telepítés külön porttal és `SERVICE_ID`-vel is **ugyanazt a tmux-szervert** használja, mint a prod, és ha a fő ügynök neve megegyezik,
a `<név>-channels` munkamenet is ugyanaz. Ezt a `doctor` pontosan megmutatja.

---

## Mi van még hátra

1. **Saját tmux-szerver példányonként** (`TMUX_TMPDIR=<telepítés>/store/tmux`, a környezetből öröklődik, a ~100 hívási helyet nem kell átírni): a `doctor` WARN-ja megszűnik.
   A `nestor` és az unit már továbbadja, ha a `.env`-ben szerepel, de a dashboard indításkor nem állítja be maga.
2. **Egységes port a szkriptekben és hookokban:** kb. 20 szkript és hook (`agent-msg.sh`, `agent-inbox.sh`, a Python hookok, `watchdog.sh`…) fixen `localhost:3420`-at hív. Egy második példány szkriptjei így a **másik példányt** érik el.
3. **Teljesen saját Claude-config** minden ágensnek, a `~/.claude`-hoz symlink nélkül.
4. **A `channels` unit** generálása (`install-service`) a `channels.sh` mintájára.
