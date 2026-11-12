# Skill-könyvtár: egy példány, öt hatókör, másolás nélkül

> Egy skill egyetlen példányban él egy könyvtárban. Hogy ki kapja meg, azt hozzárendelések döntik el, az ágens saját
> skill-mappája pedig symlinkekből áll össze. Ha a skillt a könyvtárban átírod, mindenki a frissítettet látja.
> **Állapot: bekötve, ágensenként kapcsolóval.** Az ágens-indító (`provisionIsolatedConfigDir`) az `agent-config.json`
> `skillsMode` értéke szerint építi az ágens `skills` bejegyzését. **Alapból (`shared`) semmi nem változik**: az egész
> `~/.claude/skills`-re mutató symlink marad. A mai skillek átvitele a könyvtárba még hátra van (lásd lent), ezért a
> `composed` módot egyelőre csak egy ágensen érdemes próbálni.

---

## 🎯 Mit tud / miért érdekes

Ma egy skill két helyen élhet: globálisan (`~/.claude/skills`, az egész flotta látja) vagy egy ágens saját mappájában. A
kettő között nincs semmi: nem mondhatod meg, hogy egy skillt csak egy projekt kapjon, vagy csak egy csapat, vagy egy ágens
csak egy adott projektben. Aki mégis ezt akarja, másolja a fájlokat, és az ugyanazon skill tíz példányát kézzel frissíti.

A skill-könyvtárban minden skill egyszer van, a hozzárendelés pedig megmondja, ki kapja meg:

| Hatókör | Ki kapja |
|---|---|
| `global` | mindenki |
| `project` | aki az adott projekten dolgozik (egy jegy-példánynál a jegy projektje) |
| `team` | a vezető alatti összes ágens (a `reportsTo` lánc) |
| `agent` | egy ágens (egy jegy-példány a **sablonját** jelenti) |
| `agent-project` | egy ágens, csak egy adott projektben |

---

## 🛠 Hogyan működik

### A feloldás (`src/skill-assignments.ts`)

Skillenként az érvényes hozzárendelések közül a **legspecifikusabb dönt**, és azonos hatókörön az `exclude` legyőzi az `include`-ot
(a biztonságos oldal). Így egy skillt oda lehet adni mindenkinek, és elvenni egy ágenstől, vagy egy ágensnek csak egy
projektben megadni.

```json
{
  "assignments": [
    { "skill": "store-decision", "scope": "global" },
    { "skill": "store-decision", "scope": "agent", "agent": "cpp-developer", "mode": "exclude" },
    { "skill": "store-decision", "scope": "agent-project", "agent": "cpp-developer", "project": "tover.tafel" }
  ]
}
```

A `cpp-developer` így a `store-decision`-t csak a `tover.tafel` projektben kapja meg, máshol nem. A többi ágens mindenhol.

- Egy skill, amely hozzá van rendelve, de nincs a könyvtárban, **nem lesz adva**, és a feloldás `missing` listája jelzi (nem csendes elnyelés).
- Egy skill, amelyet senki nem rendelt hozzá, senkié: a könyvtár készlet, nem jogosítás.
- A projekt kis- és nagybetű nélkül, a szóközöket levágva egyezik, mint a kártya `project` mezője.

### A hozzárendelés-fájl (`store/skill-assignments.json`)

Minta: `config-examples/skill-assignments.example.json`. Hiánya a normális üres állapot (semmi nincs hozzárendelve). Hibás vagy
olvashatatlan fájl is üresnek számít, egy figyelmeztetéssel: egy elrontott fájl nem oszthat ki skilleket véletlenül.

Amit a rendszer elutasít (és egy sor az `problems` listába kerül): hibás skill-név (a meglévő `sanitizeSkillName` szabálya:
kisbetű, szám, egyetlen kötőjel, legfeljebb 50 karakter); ismeretlen hatókör vagy mód; a hatókörhöz szükséges mező hiánya
(`project`, `team`, `agent`); a hatókör által nem használt mezőket figyelmen kívül hagyja, így egy `global` bejegyzést egy
odavetett `project` nem szűkíthet. Ugyanaz a hozzárendelés kétszer egy; ha a kettő ellentmond, az `exclude` marad, és jelezve van.

A fájlt egyszer értelmezi (a tartalom alapján), és a benne lévő hibát egyszer naplózza, nem minden ágens-indításnál.

### A könyvtár és az összeállítás (`src/skill-library.ts`)

A könyvtár (`store/skill-library/`) skill-könyvtárak halmaza, mindegyikben egy `SKILL.md`-vel. **Egy symlink a könyvtárban nem skill**:
bárhová mutathatna.

A `composeSkillsDir` az ágens saját skill-mappáját **valódi mappává** építi, benne egy symlinkkel skillenként. Garanciák:

- **Csak azt törli, amit maga csinált:** egy, a könyvtárba mutató symlinket. Valódi fájlt vagy mappát soha, és olyan symlinket sem,
  amely máshová mutat.
- **Idegen tartalmú mappát nem bánt:** ha a célmappa nem üres, és nincs benne valódi jelölőfájl (`.marveen-composed.json`: sima fájl, JSON-objektummal; a symlink nem számít), megtagadja, és semmit nem változtat. Jelölővel rendelkező mappában az idegen bejegyzések érintetlenek maradnak.
- **A symlinket cseréli, nem azt, amire mutat.** Ma az izolált config-könyvtár `skills` bejegyzése az egész megosztott skill-mappára mutató
  symlink. Az `replaceLink` opcióval ezt a **linket** váltja a valódi mappára, a megosztott mappa tartalma érintetlen marad.
- **Idempotens**, és követi a változást: új skillt linkel, a már nem kértet eltávolítja, az elirányított linket helyreállítja.
- A cél és a könyvtár nem tartalmazhatja egymást.

---

### Az indítóba kötés (`src/web/skill-composition.ts`)

Egy ágens `agent-config.json`-ja: `"skillsMode": "composed"`. Bármi más (hiány, elírás) `shared`.

- **Kontextus:** az ágens (egy jegy-példány a **sablonját** jelenti), a projekt (a jegy-példánynál a jegy projektje, másnál nincs), és a csapatok: **maga az ágens és a fölötte lévő vezetők** a `reportsTo` láncon (hurok és mélység-határ ellen védve). Egy `team: "ui-ux-architect"` hozzárendelést tehát az architect maga is megkap.
- **`composed`:** az izolált config `skills` bejegyzése valódi mappa lesz, benne symlinkekkel a feloldott skillekre. A régi, az egész megosztott mappára mutató **linket** cseréli, a megosztott mappa érintetlen. A hiányzó (hozzárendelt, de nincs a könyvtárban) skill a naplóban figyelmeztetés.
- **Nem tudja megcsinálni** (nincs könyvtár, idegen fájlokat tartalmazó valódi mappa van az útban): figyelmeztetés a naplóban, a `skills` bejegyzés úgy marad, ahogy volt. Egy valódi mappát az indító soha nem cserél le.
- **Vissza `shared`-re:** a saját összeállított mappát leszedi (csak a könyvtárba mutató linkeket és a jelölőt), és visszajön a megosztott link. Ha a mappában valódi fájl is van, a mappa **marad**, és a napló jelzi.
- **Figyelem:** egy `composed` ágens csak azt kapja, amit a hozzárendelések adnak. Üres hozzárendelés-fájllal nulla skillje van. Átváltás előtt a kívánt skilleknek a könyvtárban kell lenniük (lásd a 2. pontot lent).

## Mi van még hátra

1. ~~Bekötés az ágens-indítóba~~ (kész, lásd fent).
2. **A mai skillek átvitele** a könyvtárba, és mindegyikhez egy `global` hozzárendelés, hogy az eredmény mindenkinek ugyanaz legyen, mint ma.
3. **Karantén:** egy új skill jóváhagyás után kerüljön a könyvtárba (ma a `~/.claude/skills`-be vagy egy ágens mappájába).
4. **A bundle-export** a hozzárendeléseket vigye a skill-fájlok helyett.
5. **A `store/skill-assignments.json` védelme a gate-ben**, mint a `store/projects.json`-é: ma bármely ágens írhatja, és megadhatna magának
   egy skillt a (karanténon átment) könyvtárból. Ez kisebb kockázat, mint a futtatható parancs, de ugyanaz az ok.

## Még nem mért

Azt, hogy a Claude Code **skillenkénti symlinket** betölt-e egy projekt-szintű `.claude/skills/` alatt, megmértem (igen, 2.1.322). Azt, hogy
ugyanezt teszi-e a **felhasználói szintű** helyen (az ágens izolált config-könyvtárának `skills` mappájában), nem: ehhez bejelentkezett
config-könyvtár kell. Valószínűleg ugyanaz a betöltő, de a bekötés előtt egy token-alapú próbával meg kell erősíteni.
