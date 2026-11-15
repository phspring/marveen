# A példány saját Claude-homeja

> Egy nestor-példány **csak a saját könyvtárait** használja. A host felhasználó `~/.claude` mappáját (és a
> `~/.claude.json`-t) semmi nem linkeli, olvassa vagy írja, amit a példány futtat. Ha egy példánynak nincs saját
> homeja, nem indul: nincs csendes visszaesés a hostra.
> **Állapot: 1. fázis** (config-gyökér, skillek, ütemezett feladatok, seedelés, átköltöztetés). A további fázisokat
> lent, a „Mi van még hátra” rész sorolja.

---

## 🎯 Miért

Egy gépen, egy felhasználó alatt több példány fut egymás mellett (pl. `/var/www/nestor` és `~/nestor-dev`), mellettük
pedig a gazda saját Claude Code-ja. Korábban a flotta a host `~/.claude`-ot használta közös gyökérnek:

- minden izolált config-könyvtár (a fő ágensé `.channels-config`, az ágenseké `agents/<n>/.claude-config`) minden
  bejegyzése oda mutató symlink volt: `skills`, `agents`, `CLAUDE.md`, `scheduled-tasks`, `channels`, `history.jsonl`,
  `sessions`, `mcp.json` ... (a dev példányon mérve 37 link);
- izoláció nélkül a fő ágens `CLAUDE_CONFIG_DIR` nélkül, tehát közvetlenül a host `~/.claude`-on futott;
- a skill-telepítők, a javaslat-API és a seedelés (telepítő, `update.sh`) a host `~/.claude/skills`-be írt.

A következmény: amit az egyik példány botja skillként felvett, az megjelent minden más példánynál és a gazda saját
Claude-jában is. A gazda személyes `CLAUDE.md`-je pedig a botoknál is betöltődött. (2026-11-14: a dev példány
Telegram-botja négy skillt másolt így a host `~/.claude/skills`-be.)

## 🛠 Hogyan működik

### Hol van a home (`src/claude-home.ts`, `scripts/lib/claude-home.sh`)

Hívásonként feloldva, ebben a sorrendben:

1. `NESTOR_CLAUDE_HOME` a környezetben (az indítók és a tesztek varrata);
2. `NESTOR_CLAUDE_HOME` a telepítés `.env`-jében;
3. `<telepítés>/.claude-home`.

**Soha nem lehet** a host `~/.claude`, bármi azon belül, maga a home könyvtár vagy relatív út. Az oda mutató symlinket
is elutasítja (realpath). A `<telepítés>/.claude` sem jelölt: az a projekt-scope, amit a Claude Code a cwd alapján
tölt be (a flotta hookjai). A home attól home, hogy létezik, és benne van a `.nestor-claude-home` jelölő (JSON:
melyik telepítésé). A TS és a shell feloldó ugyanazt adja: `scripts/__tests__/claude-home.test.sh` mindkettőt
ugyanazokon a bemeneteken futtatja.

### Mi használja

| Hely | Most |
|---|---|
| Izolált config-könyvtárak (`provisionIsolatedConfigDir`) | a home bejegyzéseit linkelik, a hostét soha. A régi, hostba mutató linkeket minden indításnál leszedik (csak a linket, amire mutat, azt nem). A `.claude.json` minden könyvtárban saját valódi fájl, a home-éból seedelve. |
| Saját config-könyvtár nélküli ágens | `CLAUDE_CONFIG_DIR=<home>`. Nincs home → az ágens **nem indul**. |
| Fő ágens (`channels.sh`, dashboard-respawn) | ha egyik mód sem ad könyvtárat: `CLAUDE_CONFIG_DIR=<home>`. Nincs home → nem indul, a `store/channels-failures.log` megmondja, mit kell futtatni. |
| Workerek | `<home>/workers/<id>[-fast]`, a régi `~/.<id>-worker` helyett. Két azonos nevű példány így nem osztozik rajta. |
| Skill-útvonalak (skill-API, javaslat, karantén, CLI, áttekintés, flotta-export) | `<home>/skills` |
| Ütemezett feladatok | `<home>/scheduled-tasks` |
| Seedelés (telepítő, `update.sh`, seed-refresh) | a home-ba. A telepítő az elején létrehozza a homeot, és `CLAUDE_CONFIG_DIR`-ként exportálja, így a `claude plugin install` és a login is a home-ba dolgozik. A csatorna tokenje egyenesen a telepítés saját `.claude/channels/<provider>` mappájába kerül. |
| Az ágensek utasításai (CLAUDE.md-blokk, seed-skillek, feladat-promptok) | `$CLAUDE_CONFIG_DIR/...` a `~/.claude/...` helyett. A régi PreCompact-prompt a `templates/retired-hook-prompts.json`-ba került, így a meglévő ágensek is az újat kapják. |

### Átköltöztetés: `nestor migrate-claude-home [--dry-run]`

Egy meglévő telepítésnek egyszer létrehozza a saját homeját (`src/claude-home-migrate.ts`). Az `update.sh` a build után
magától futtatja, ha még nincs jelölő. Ha nem sikerül, a frissítés megáll: az új kód home nélkül nem indít ágenst.

- **Átmásolja** (csak ami a hoston megvan, és a home-ban még nincs): `skills/`, `agents/`, `scheduled-tasks/`,
  `tools/`, `plugins/`, a `settings.json`-t hookok és `disableAllHooks` nélkül, a `.claude.json`-ból az onboarding-
  és theme-jelzőket, a user-scope MCP-szervereket és csak **ennek a telepítésnek** a projects-bejegyzéseit, valamint
  a telepítés saját átiratait és auto-memóriáját (`projects/<a telepítés kódolt útjai>`). A symlinkeket tartalomként
  másolja: a hostba mutató link nem jöhet át linkként.
- **Nem másolja**: `.credentials.json` (egy forgó login másolata kettéválasztaná a refresh-láncot, és az egyik oldal
  kijelentkezne), `CLAUDE.md` (a gazda személyes utasításai nem a botoké), előzmények, sessionök, cache-ek, naplók,
  más telepítések projektjei, `channels` (az már telepítés-szintű, #915).
- **Leszedi** a telepítés config-könyvtáraiból a hostba mutató linkeket. A következő indításkor a home-ba linkelnek újra.
- A host `~/.claude`-ot **csak olvassa**. Semmit nem töröl és nem módosít benne; a takarítás a gazda döntése.
- Ha nincs flotta setup-token (`store/.claude-oauth-token`) és a home-ban sincs login, kiírja a teendőt:
  `CLAUDE_CONFIG_DIR=<home> claude auth login`.
- Másodszorra már nem másol semmit, csak a linkeket ellenőrzi. A home-ban azóta átírt fájlhoz nem nyúl.

## ⚠️ Amit tudni kell frissítéskor

- **Login:** a flotta tokenje nélkül futó példány home-jának saját login kell (egyszer, lásd fent). Tokennel nem.
- **Workerek:** az új helyen új config-könyvtárat kapnak. A régi `~/.<id>-worker` mappa marad, kézzel törölhető.
- **Skillek:** a hostról átmásolt skillek a példányé lesznek. Amit a gazda nem akar a példánynál, azt a home-ból
  törölheti, a hostot ez nem érinti.

## Mi van még hátra

1. **Csatornák és pluginek (2. fázis):** a `channelStateDir` hostra eső visszalépése (`~/.claude/channels/<p>`, ha a
   telepítés-szintűben nincs `.env`), a `channel-coordinator`, `worksource-queue`, `voice-directive`, `fleet-transfer`
   csatorna-útjai, a gromzo és a plugin-patcher utak.
2. **Szkriptek és hookok (3. fázis):** a shell- és Python-szkriptek (`doctor.sh`, watchdogok, telegram-hookok,
   `usage-collect.py`, `boot-hook-prune.py` ...) a közös `claude-home.sh` / Python-megfelelő alapján. A kapuk
   (`db-write-gate`, `self-pace-gate`) védjék a home megfelelő fájljait is.
3. **Átirat- és használat-olvasók (4. fázis):** a `~/.claude/projects`-et olvasók ágensenként a saját config-könyvtárat
   kérdezzék.
4. **`nestor doctor` (5. fázis):** hiba, ha két példány ugyanazt a homeot használja, vagy bármelyik config-könyvtárban
   hostba mutató link maradt.
5. **macOS:** a worker hitelesítése még a host Keychainből olvas (`readClaudeCodeOauthJson`).
