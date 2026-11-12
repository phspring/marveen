# Jegy-környezet: projekt-regisztráció és workspace-modul

> Egy projekt jegyei külön, elkülönített checkouton dolgozhatnak, anélkül hogy egymás fájljait zavarnák.
> **Állapot: bekötve, kapcsoló mögött.** A `TICKET_ENVIRONMENTS` beállítás alapból **ki** van kapcsolva, és addig a kanban
> pontosan úgy működik, mint eddig. Bekapcsolva csak azok a kártyák érintettek, amelyek a `store/projects.json`-ban
> `worktree` módú projekthez tartoznak. Lásd lent: "Bekapcsolás".

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
| `repoPath` | A repó fő checkoutjának abszolút útja. A repónak kell egy `origin` remote-ja, amelyen a `baseBranch` megvan: a workspace `origin/<baseBranch>`-ből készül, és enélkül a jegy nem indul (`origin/<ág> does not exist in the repo`). |
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
  commitot tartalmazó workspace-t, hacsak nincs `force`. A megtartott workspace-ről a kártya **egyszer** kap kommentet
  (nem a percenkénti menetek mindegyikében), és a következő menetek nem jelentik újra. Amint a munka pusholva van
  (vagy a változás el van mentve), a következő menet eltávolítja a workspace-t.
- **Az ág sorsa:** az ág megmarad, ha van rajta saját commit (pusholt is). Az az ág, amely semmit nem tartalmaz
  (minden commitja már az indulópontjában van), a workspace törlésekor törlődik, és ha egy korábbi kísérletből
  maradt ilyen, a következő létrehozás is eltakarítja. Így egy üres ág sosem akadályozza ugyanannak a jegynek az
  újrapróbálását, egy saját munkát tartalmazó ágat viszont soha nem érint.
- **Épülő (stacked) workspace:** a `worktree` projektben egy jegy egy másik jegy **helyi ágára** is épülhet
  (`planWorkspace(..., { stackOn })`), így viszi annak push-olatlan munkáját. Klón (almodul) projektben ez nem lehet,
  mert a klón nem éri el egy másik klón push-olatlan ágát: ott a jegy vár.
- **Árva workspace-ek** (`orphanWorkspaces`) csak jelentve vannak, a törlés emberi döntés.

### A teljes folyamat (`src/web/ticket-environment.ts`)

Két függvény köti össze a darabokat. Minden, ami a futó rendszerhez nyúl (session indítása és leállítása, kártya-komment,
a többi kártya fájlköre), függőségként érkezik, így a teljes folyamat session nélkül tesztelhető.

**`prepareTicketEnvironment(kártya, sablon)`** (amikor egy izoláló projekt kártyája `in_progress` lesz):

1. Projekt-feloldás, majd a döntési fa. `shared` (nincs projekt, nem izoláló projekt, vagy olyan sablon, amelyből nem lehet
   példány, pl. a főágens): a mai út, semmi mellékhatás.
2. `queued`: semmi nem jön létre, a válasz megmondja, miért (`capacity`, `overlap`, vagy `stacking-unsupported` klón
   projektben) és kire vár.
3. Különben: workspace, majd példány-ágens, majd indítás. **Ha egy lépés elbukik, az előzőek visszavonódnak**, így egy
   kártyának sosem marad félkész környezete (egy korábbról már meglévő környezetet nem bont le).
4. Idempotens: a már kész környezetet adja vissza, és csak az újraindítást végzi el, ha a session leállt.

**`releaseTicketEnvironment(kártya)`** (amikor a jegy lezárul):

1. A példány leáll. Ha a leállítás nem sikerül, **semmi nem törlődik**.
2. A példány memóriája a sablonhoz kerül (`memory/tickets/<jegy>/`). Ha ezt nem lehet megcsinálni, a példány megmarad:
   az egyetlen másolattal együtt semmi nem törlődik.
3. A példány és a workspace törlődik. Ha a workspace nem mentett munkát tartalmaz, **megmarad**, és egy komment szól
   róla a kártyán.

A kártya jegy-azonosítója az `external_ref`, ennek hiányában a kártya azonosítója.

### A dispatch oldala (`src/web/ticket-environment-flow.ts`)

Ez köti a fenti folyamatot a kanbanhoz. Minden hatás (session, adatbázis, az indító-üzenet) a `FlowIO`-n át érkezik.

**`dispatchViaEnvironment(kártya, sablon)`**, amikor egy kártya `in_progress` lett egy izoláló projektben. A válasz:

| Válasz | Jelentés |
|---|---|
| `shared` | Nem ennek a funkciónak a kártyája (nem izoláló projekt, vagy a címzett maga is példány): a mai út |
| `busy` | Ugyanezt a kártyát épp előkészíti egy másik hívás (egy kártyára egyszerre egy előkészítés fut) |
| `queued` | Várnia kell: a kártyán egy komment megmondja, miért és kire, **egyszer** (nem ismétli minden próbánál) |
| `failed` | Jelentve (a meglévő "nem kapott üzenetet" riasztás), és egyre hosszabb szünettel újrapróbálva (1, 2, 4 … legfeljebb 30 perc) |
| `dispatched` | A **példány** kapta a kártyát, a kétszeri küldést védő jelzés (`dispatched_at`) csak most áll be |

A hibát az első és az ötödik próbánál jelenti, köztük nem: percenként ismételve elnyomná azt az egy esetet, amelyik számít.
Ha a példány már kész, de az üzenet küldése hibázik, az újrapróbálás a meglévő környezetet használja, nem csinál újat.

**`reconcileTicketEnvironments()`**, a biztonsági háló. Ez az egyetlen hely, amely kezeli, ahogy egy kártya elhagyhatja az
aktív oszlopokat (route-ok, az archiváló söprés, a táblát közvetlenül író szkript), ezért egyiknek sem kell saját horog:

1. Minden környezet, amelynek a kártyája nem `in_progress`, `waiting` vagy `testing` (kész, visszatett, archivált vagy
   törölt), felszabadul. Soha nem `force`-szal: a nem mentett munkát tartalmazó workspace megmarad.
2. Minden `in_progress` kártya, amelyet még nem küldtek ki (várt, vagy hibázott), újra próbálkozik. A felszabadítás az újrapróbálás
   **előtt** fut, ezért a lezárt jegy helyére a sorban álló jegy ugyanabban a körben bekerül.

A `waiting` és a `testing` oszlopban a környezet megmarad, mert a munka még nem ért véget (teszt, review, várakozás).

A menet naplósora (`Ticket environments reconciled`) csak akkor jelenik meg, ha történt valami. A `released` azokat a jegyeket
sorolja fel, amelyeknél ebben a menetben tényleg lebontott valamit (egy példányt vagy a workspace-t). A `kept` azokat, amelyeknél
a workspace most derült ki először, hogy nem mentett munka miatt megmarad. Ugyanaz a jegy lehet mindkettőn: a példánya
megszűnt, a workspace-e marad.

---

## Bekapcsolás

A funkció **három feltétel együttes teljesülésekor** hat egy kártyára, és bármelyik hiánya a mai viselkedést adja:

1. A `TICKET_ENVIRONMENTS` beállítás `1` (Beállítások oldal vagy `.env`; alapból `0`, újraindítás nélkül kapcsolható).
2. A kártya egy olyan projekthez tartozik a `store/projects.json`-ban, amelynek `mode: "worktree"` és van `workspaceRoot`-ja.
   A projektet a kártya `project` mezője, az `external_ref` Jira-kulcs előtagja, vagy a könyvtár adja (lásd fent).
3. A kártya megbízottja egy valódi ügynök (nem a főágens, nem a tulajdonos, nem egy példány).

**Mit csinál a rendszer**, ha a kártya `in_progress` lesz:

- A `/move` válasza **nem vár** a környezetre: a workspace és a példány létrehozása másodpercekig tart, ezért a
  dispatch aszinkron fut. A mozgatás sikeres marad akkor is, ha a környezet nem készül el (ezt a kártya komment és a
  főágensnek küldött riasztás jelzi, mint a mai "nem kapott üzenetet" eset).
- A megbízott ügynök **nem indul el**: a kártyát annak az ideiglenes példánya kapja, a kiosztó üzenet a workspace
  literális útját és az ág nevét is tartalmazza.
- Ha a példány maga húzza `in_progress`-be a saját kártyáját, ez nem indít újabb üzenetet (az átvétel nem hív új kiosztást).

**Mit csinál, ha a kártya elhagyja az aktív oszlopokat.** Egy időzítő percenként (és a `/move`, a PUT, az archiválás
és a törlés után két másodperccel) lefuttatja a `reconcileTicketEnvironments`-et. Az `in_progress`, `waiting` és
`testing` kártya környezete megmarad. Minden más (kész, visszatett, archivált, törölt) kártya környezete megszűnik, a
nem mentett munkát tartalmazó workspace kivételével, amely megmarad, és a kártyán egy komment szól róla.
Az időzítő olyan útvonalat is lefed, amelyhez nincs horog (egy szkript, amely közvetlenül a táblát írja).

**Biztonságos bevezetés:**

1. Vegyél fel egy projektet `store/projects.json`-ba (`config-examples/projects.example.json`), először `"mode": "shared"`-del.
2. Kapcsold be a `TICKET_ENVIRONMENTS`-et: ekkor még semmi nem változik, mert a projekt `shared`.
3. Állítsd át **egy** projektet `"mode": "worktree"`-re, `workspaceRoot`-tal a telepítésen **kívül**, és `maxParallel: 1`-gyel.
4. Húzz egy kártyát `in_progress`-be, és nézd meg a kommentet (a példány, a workspace, az ág neve).
5. Ha jó, emeld a `maxParallel`-t. A kártyák `scope` mezőjét a vezető töltse ki: a hiányzó `scope` átfedésnek számít,
   ezért addig a jegyek egymásra várnak (ez a biztonságos oldal).

**Visszaállás:** a `TICKET_ENVIRONMENTS=0` azonnal a mai viselkedést adja vissza az új kártyákra. A már létrehozott
környezetek nem tűnnek el magukról: a lezárt kártyákét a következő bekapcsolt időzítő-menet takarítja el, a futókét
a kártya lezárása. Ha kapcsolás nélkül kell takarítani, a példányok az `agents/` alatt a `instanceOf` jelölésről
ismerhetők fel, a workspace-ek pedig a `workspaceRoot` alatt vannak.

**Ismert korlátok:**

- A példányok az ágensek listáján látszanak (a `instanceOf` jelöli őket), a dashboard még nem csoportosítja őket.
- Épülő (stacked) jegy csak `worktree` típusú repóban lehet; almodul (klón) projektben a jegy vár.
- A példány memóriája a jegy végén a sablonhoz kerül (`memory/tickets/<jegy>/`). Azt, hogy a sablon (vagy egy későbbi
  példány) ezt a mappát automatikusan beolvassa-e, nem ellenőriztem: a fájlok megvannak, de lehet, hogy kézzel kell rájuk
  mutatni.

---

## Mi van még hátra

4. Skill-könyvtár és hozzárendelések.
5. A `store/projects.json` védelme a gate-ben, utána a setup/teardown parancsok.
6. A dashboard csoportosítsa a példányokat a sablonjuk alatt.

A teljes terv és a mért döntések a "Párhuzamos munkaterv" oldalon vannak.
