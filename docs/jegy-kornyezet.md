# Jegy-környezet: projekt-regisztráció és workspace-modul

> Egy projekt jegyei külön, elkülönített checkouton dolgozhatnak, anélkül hogy egymás fájljait zavarnák.
> **Állapot: alap (2. lépés).** A modulok megvannak és tesztelve vannak, de semmi nem hívja őket: a kanban-dispatch
> és az ágens-indító még nem használja. Az éles viselkedés változatlan.

---

## 🎯 Mit tud / miért érdekes

Ma egy projekten belül az ágensek **ugyanazt a checkoutot** használják, fájlszinten elosztva. Ha két jegy átfedő
fájlokat érint, ütköznek. A jegy-környezet jegyenként ad egy külön checkoutot és branch-et, amelyet a dashboard készít
és takarít. Az ágens csak a kész mappában dolgozik.

Két dologra épül:

1. **Projekt-regisztráció** (`store/projects.json`): melyik projekt melyik repó, milyen módban fut, és hogyan
   találja meg egy kártya a projektjét.
2. **Workspace-modul** (`src/web/workspace.ts`): létrehozza és törli a jegy checkoutját.

Alapból minden projekt `shared`, vagyis a mai viselkedés. Csak a `worktree` mód kapcsolja be az izolációt, és ahhoz
`workspaceRoot` is kell.

---

## 🛠 Hogyan működik

### A regisztráció

`store/projects.json` (minta: `config-examples/projects.example.json`). A fájl hiánya a normális, üres állapot.
Hibás vagy olvashatatlan fájl is üresnek számít, egy figyelmeztetéssel: egy elrontott regisztráció nem kapcsolhat be
izolációt véletlenül.

| Mező | Jelentés |
|---|---|
| kulcs (név) | Egyezik a kanban-kártya `project` szövegével, kis- és nagybetű mindegy |
| `repoPath` | A repó fő checkoutjának abszolút útja |
| `repoKind` | `plain` (alapérték) vagy `submodule` |
| `mode` | `shared` (alapérték) vagy `worktree` |
| `baseBranch` | Ebből indul a jegy ága (alapérték: `develop`) |
| `jiraKeys` | Jira-kulcs előtagok, pl. `["TVR"]`. Egy kulcs egy projekté. |
| `workspaceRoot` | Abszolút, a repón **kívül**. `worktree` módhoz kötelező. |
| `maxParallel` | Egyszerre legfeljebb ennyi jegy-környezet (1..32, alapérték 2) |
| `onOverlap` | Mi legyen, ha egy másik aktív jegy ugyanazokat a fájlokat érintheti: `wait` (alapérték, várakozik) vagy `stack` (a másik jegy ágára épül) |

Amit a rendszer elutasít vagy visszaminősít (és egy sor az `problems` listába kerül): relatív `repoPath`; olyan
`workspaceRoot`, amely a repóban van vagy a repót tartalmazza; `worktree` mód `workspaceRoot` nélkül (marad `shared`);
ismeretlen mód; kétszer szereplő név vagy Jira-kulcs.

**Szándékosan nincs benne `setup`/`teardown` parancs.** A dashboard futtatná, a `store/projects.json` viszont bármely,
ugyanazzal az OS-felhasználóval futó ágens által írható, tehát egy parancs-mező automatikus futtatási út lenne egy
feltört ágensnek. Előbb a fájlt a db-write-gate védett listájára kell tenni (a tulajdonos döntése), utána jöhet.

### Hogyan talál a kártya projektet

Rögzített sorrendben (`resolveProject`):

1. **A kártya `project` szövege.** Ha ki van töltve, végleges: egy nem regisztrált név nem találatot ad, nem esik át a
   Jira-kulcsra.
2. **A Jira-kulcs előtagja** az `external_ref`-ből (pl. `TVR-2658` → `TVR`).
3. **A könyvtár:** az a regisztrált repó, amelyben az ágens dolgozik (a leghosszabb `repoPath` nyer).

Nincs találat: marad a mai közös mód.

### A döntés: mi legyen egy új jeggyel (`src/workspace-decision.ts`)

Tiszta függvény (`decideWorkspace`): megkapja a projektet, a jegyet, a jegy által deklarált fájlkört (`scope`, repó-relatív
előtagok) és azokat a jegyeket, amelyek már tartanak workspace-t. Nem hoz létre és nem indít semmit, a hívó
tesz a válasz szerint. Szabályok, sorrendben:

1. Ha a projekt nem izolál (`shared`, vagy `worktree` `workspaceRoot` nélkül): `shared`, a mai út.
2. Ha a jegynek már van workspace-e: `existing`. Újraküldésnél soha nem lesz második.
3. Ha a projekt elérte a `maxParallel`-t: `queued` (`capacity`), a válasz megnevezi, ki foglalja a helyeket.
4. Ha nincs más aktív jegy: `new`, a `baseBranch`-ről.
5. Ha a jegy fájlköre **bizonyíthatóan** más, mint az összes aktív jegyé: `new` (párhuzamos).
6. Különben, vagyis átfedésnél **vagy ha nem ismert**: a projekt `onOverlap` szabálya szerint `queued` (`overlap`)
   vagy `stacked` a **legújabb** ütköző jegy ágán. Az épülés csak akkor megy, ha az az ág tényleg tartalmazza az összes
   többi ütköző jegy munkáját, vagyis ha azok egy láncot alkotnak (mindegyik az előzőből indult, a `baseBranch`-e az előző
   jegy ága). Két egymástól függetlenül indult ütköző jegy nem fér bele egy ágba, ilyenkor a jegy vár.

A "legújabb" a workspace `createdAt` ideje alapján dől el, sosem a hívó által megadott sorrend szerint (a
`listWorkspaces` is így, régebbitől újabbig rendez). A fájlkör előtagjai mindig `/` jelölésűek, az összehasonlítás
nem függ az operációs rendszer útvonal-elválasztójától.

A hiányzó fájlkör átfedésnek számít. A biztonságos oldal sosem a "párhuzamos". A fájlkört a vezető tölti ki a kártyán
(ez a mező a 4. lépésben jön); a döntés addig is helyesen működik, mert az ismeretlen fájlkört átfedésnek veszi.

### A jegy-példány (`src/web/agent-instance.ts`)

A jegyen dolgozó ágens egy **ideiglenes, valódi ágens**, amely a sablon ágensből készül: `agents/<sablon>-<jegy>/`. Azért valódi
ágens, mert az indító, a router, a dispatch, a státusz és a dashboard mind ágens-névre épül (az `agentSessionName()` kb. 34,
az `isAgentRunning()` kb. 42 helyen szerepel). Így egyik sem változik, és a kártya `assignee`-je egyszerűen a példány neve.

- **Név:** `<sablon>-<jegy>`, a `sanitizeAgentName`-nek is megfelelő alakban (kisbetű, egyetlen kötőjel, legfeljebb 50
  karakter). Ami levágódna, abban a (sablon, jegy) pár rövid hash-e is benne van, így két hosszú jegy nem ütközik.
- **Másolat:** `CLAUDE.md`, `SOUL.md`, `.mcp.json`, `.claude/settings.json`, `.claude/agents/*`. Az indító ezeket **minden
  indításnál helyben átírja**, ezért symlink a sablonba írna át.
- **Symlink:** a sablon saját `.claude/skills/*` bejegyzései. Egy skill egy forrásból él.
- **Üres:** a `memory/`. A példány nem ír a sablon memóriájába.
- **Config:** a sablonéból, gép-specifikus mezők nélkül (`remoteHost`, `remoteWorkdir`, `claudeConfigDir`, `oauthTokenFile`).
  `team`: tag, a sablon vezetője alatt, nem delegál. `instanceOf` jelöli (sablon, jegy, projekt, workspace).
- **`CLAUDE.md`:** egy jelölt blokk (`INSTANCE-BEGIN/END`) a jegyet és a workspace **literális abszolút útját** írja bele, és
  hogy a példány nem commitol.
- **Törlés:** csak példányt töröl (egy elírt név sosem törölhet valódi ágenst), és csak ha a session már nem fut.
  A symlinkeket linkként távolítja el, a sablon skilljei épek maradnak.

### A workspace

| Repó | Módszer | Miért |
|---|---|---|
| `plain` | `git worktree add --no-track -b <ág> <út> origin/<base>` | Olcsó, közös objektumtár |
| `submodule` | Önálló klón: `git clone --reference <repó> --dissociate -b <base>` | Az almodul worktree-je örökölné a `core.worktree`-t; a klónnak nincs közös ref-je vagy configja a fő checkouttal |

- Az útvonal: `<workspaceRoot>/<projekt>/<jegy>`. A jegy-azonosító és az ág neve szigorúan ellenőrzött
  (nincs `..`, `/` az azonosítóban, szóköz).
- A marker (`<workspaceRoot>/.marveen-workspaces/<projekt>/<jegy>.json`) a munkafán **kívül** van, így nem jelenik meg
  a `git status`-ban.
- **Idempotens:** a már létrehozott workspace ugyanazt adja vissza. Meglévő ágat vagy idegen mappát nem ír felül.
- **Hiba után takarít:** nem marad félkész mappa, ág vagy marker.
- **A módszer nem függ az ágens Bash-ének kapujától:** a dashboard-folyamat `git -C <literális út>` parancsokat futtat
  shell nélkül, és soha nem használ `GIT_DIR`/`GIT_WORK_TREE` változót (a környezetből ki is szűri). Az ágens a kész
  mappában sima `git -C <literális abszolút út>` parancsokat használ, amelyeket a kapu a telepítésen kívül átenged.
- **Nem dob el munkát:** a törlés megtagadja a nem commitolt változást vagy a még egy remote által sem látott
  commitot tartalmazó workspace-t, hacsak nincs `force`. Az ág megmarad.
- **Árva workspace-ek** (`orphanWorkspaces`) csak jelentve vannak, a törlés emberi döntés.

---

## Mi van még hátra

3. A kanban-dispatch és az ágens-indító használja. Ebből a döntési fa (`decideWorkspace`) már kész. Hátra van a bekötés: a
   dispatch a döntés szerint hoz létre workspace-t, és az ágens-indító példány-mappát ad (`--continue` nélkül, az
   indító-üzenet viszi az utat).
4. Az `external_ref` mező a kártyán.
5. Skill-könyvtár és hozzárendelések.
6. A `store/projects.json` védelme a gate-ben, utána a setup/teardown parancsok.

A teljes terv és a mért döntések a "Párhuzamos munkaterv" oldalon vannak.
