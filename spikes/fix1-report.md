# fix1 — Security-Blocker-Behebung

Datum: 2026-09-01. Alle verifizierten Blocker aus dem ersten Review plus die
sechs Ergänzungen aus dem zweiten (GPT-5.6 Sol) Review behoben. Gates alle grün,
voller e2e einmal am Ende grün.

Dateien geändert: `src/relay/guest/server.js` (+ regeneriertes
`src/relay/guest-source.ts`), `src/relay/deploy.ts`, `src/core/socket.ts`,
`src/core/input.ts`, `src/core/raise-hand.ts`, `src/core/screencast.ts` und die
zugehörigen `*.test.ts`. Keine der gesperrten Dateien angefasst.

Jeder neue Sicherheitspfad hat einen Test, der **einmal rot** gesehen wurde
(Fix per `false &&`/Perl mutiert, Zieltest gelaufen → rot, revertiert).

---

## Findings

### B3 (BLOCKER) — Rolle war selbst-behauptet
- **Fix:** `startRelay()` mintet `randomUUID()` als Agent-Secret
  (`deploy.ts:159`), gibt es dem Server als 3. argv mit
  (`deploy.ts` nohup-Zeile) und hängt es **nur** an `agentWsUrl`
  als `&k=` (`deploy.ts:209`). Der Server verlangt es für `role=agent`
  (`server.js:309-317`, 401 vor dem Upgrade); `role=human` braucht es nie.
  Zusätzlich Origin-Reject: gesetzter, fremder Origin → 403
  (`server.js:196-203` Helper, `server.js:318-326`). Non-Browser-Agent sendet
  keinen Origin → passt; Handy-Browser sendet den eigenen Origin → passt.
  Leeres Secret (kein argv) deaktiviert die Agent-Prüfung nur für lokale Tests;
  der echte Deploy setzt es immer.
- **Test:** `relay.test.ts` „role=agent is refused without the secret and
  accepted with it" + „a cross-origin upgrade is refused, a same-origin one is
  not". **Rot gesehen:** Agent-Check auf `false &&` → „role=agent is refused"
  FAIL (1 fail); Origin-Check auf `false &&` → „cross-origin" FAIL. Beide
  revertiert.

### B1 (BLOCKER) — Handback verloren bei Agent-Reconnect
- **Fix:** terminale Human-Nachricht (handback/abort) wird in `pendingForAgent`
  gepuffert (`server.js:241-245`) und einem neu verbundenen `role=agent` sofort
  zugestellt (`server.js:372-375`), symmetrisch zum lastFrame-Replay.
- **Test:** `relay.test.ts` „a handback reaches an agent that reconnects after
  the human sent it". **Rot gesehen:** Zustellung auf `false &&` → FAIL.
  Revertiert.

### B4 (BLOCKER) — unbegrenzte Fragment-Reassemblierung → OOM
- **Fix:** laufende Summe `fragmentBytes` über Continuation-Frames; > 8 MiB →
  `onClose()` (`server.js:140-160`). Reset bei neuem Message-Start und
  Message-Ende.
- **Test:** `relay.test.ts` „a fragmented message past the byte cap closes the
  socket" (rohe maskierte WS-Frames über net.Socket). **Rot gesehen:** Summen-
  Check auf `false &&` → FAIL. Revertiert.

### B5 (BLOCKER-nah) — Relay-Sandbox pausierte statt zu sterben
- **Fix:** `sandboxes.create({ template:"base", timeoutMs, lifecycle:{ onTimeout:
  "kill" } })` (`deploy.ts:104-108`). Feld-Signatur gegen
  `@solarisdk/core/dist/types.d.ts` `SandboxLifecycle` geprüft — exakt
  `{ onTimeout: "pause" | "kill"; autoResume?: boolean }`.
- **Test:** voller e2e assert „the relay sandbox is gone (404)".

### B6 (Buffer-Leak) — letzter Frame an späten Human nach Ende
- **Fix:** bei terminalem Zustand (agent `ended` ODER human handback/abort)
  werden `lastFrame`/`lastState` genullt (`server.js:236-239`, `:241-245`); der
  `ended`-Zustand wird als `lastEnded` gehalten und einem späten Human statt des
  alten Frames zugestellt (`server.js:360-368`).
- **Test:** `relay.test.ts` „a human who joins after the handoff ended sees the
  ending, not the frame". **Rot gesehen:** lastEnded-Replay auf `false &&` →
  FAIL. Revertiert.

### W2 — write() ignorierte Backpressure
- **Fix:** `write()` merkt sich `peer.backpressure = !socket.write(...)`
  (`server.js:165-171`), Reset per `drain`-Event (`server.js` upgrade-Handler).
  `route()` verwirft **Frames** an einen backpressured Empfänger
  (`server.js` route, Frame-Drop-Zeile), Control/terminale Nachrichten nie.
- **Test:** indirekt über screencast (W-Punkt 2) + kein Regress im e2e.

### W3 — Input-Payloads nicht validiert
- **Fix:** `input.ts` — Key-Whitelist `Object.hasOwn(KEY_TABLE, message.key)`
  (`:238`, Prototyp-sicher), char auf Länge 1 (`:231`), Queue-Tiefe-Cap
  `MAX_QUEUE_DEPTH=256` (`:206`, `:264`).
- **Test:** `input.test.ts` „a key outside the table is dropped", „a char that is
  not exactly one code unit is dropped", „the input queue drops messages past its
  depth cap". **Rot gesehen:** je Guard auf `false &&` → jeweils FAIL.
  Alle revertiert.

### W5 — storageState() vor clearTimeout/kill konnte hängen
- **Fix:** `withTimeout()`-Race, 5 s (`raise-hand.ts:52`, `:196-200`). Bei
  Timeout: kein storageState, trotzdem aufräumen.
- **Test:** e2e „storageState was captured" (Erfolgspfad); Timeout-Pfad durch
  Konstruktion.

### W6 — terminale `ended`-Nachricht bei nicht-offenem Socket verworfen
- **Fix:** `socket.ts` neue `sendFinal()` (`:98-119`) wartet bis
  `CLOSE_GRACE_MS` (2 s) auf einen Reconnect, bevor sie aufgibt;
  `raise-hand.ts:219` nutzt sie für die `ended`-Nachricht.
- **Test:** `socket.test.ts` „sendFinal waits for a reconnect before giving up on
  the ending". **Rot gesehen:** sendFinal auf sofortiges `resolve()` mutiert →
  FAIL. Revertiert.

### W7 — pt_token lebt 1 h, timeoutMs konnte länger sein
- **Fix:** `deploy.ts` cappt timeoutMs auf `MAX_TIMEOUT_MS=55 min` (`:34`,
  `:150-156`) mit `console.warn`. S1 nennt previewUrl-Refresh als sauberere
  Option; für v1 reicht die Begrenzung (hier vermerkt).
- **Test:** keine Live-Sandbox nötig; reine Konstante/Clamp, per tsc/lint
  abgedeckt.

---

## Zweiter Review (Sol) — sechs Ergänzungen

1. **route()-Ownership (`server.js`):** `closePeer` ist jetzt terminal — Reader
   abgehängt (`:183`), Socket nach Grace zerstört (`:192`); `route()` verlangt
   `peer.open && peers.get(peer.role) === peer` (`:221`). **Test:** „a replaced
   agent can no longer inject messages". **Rot gesehen:** alle drei Verteidigungen
   (Reader-Detach, route-Guard, Teardown) deaktiviert → FAIL (die Teardown-Kette
   `end()`→Client-Auto-Close ist deterministisch die tragende Schicht; Guard/
   Detach sind Defense-in-Depth). Revertiert.
2. **Backpressure + neuester Frame (`screencast.ts`):** Single-Slot-`pending`
   statt unbegrenzter Queue (`:163`, `:209-227`); ein verdrängter Frame wird
   geackt (Chromium fließt weiter), aber nie gesendet — nur der neueste erreicht
   das Handy. Ack-nach-Send-Pacing bleibt exakt erhalten. **Test:** „a superseded
   frame is acked but never sent". **Rot gesehen:** `pending = pending ?? frame`
   → FAIL. Revertiert.
3. **handback/Session-Tod-Race (`raise-hand.ts`):** handback ist „resolved-
   pending" — committed erst nach (a) `input.drain()` (`:190`), (b)
   storageState-Capture, (c) Liveness-Gate `browser.isConnected()` (`:207`);
   scheitert das → outcome `disconnected`, storageState verworfen.
4. **Mobile-Reconnect-Rennen (`server.js` PAGE):** ein Reconnect-Timer
   (`scheduleReconnect`, `:753`) + Socket-Generation (`:588`); stale Callbacks
   werden ignoriert; `connect()` verweigert bei laufendem/offenem Socket.
   (Browser-JS ohne In-Repo-Harness; per Review verifiziert, e2e-Human-Sim nutzt
   Node-`ws`, nicht die Browser-UI — Sol#9/W8 liegt außerhalb meines Scopes.)
5. **kill() bestätigt (`deploy.ts`):** `killed` erst nach bestätigter Löschung
   (`:166-183`); transiente Fehler mit Backoff `KILL_ATTEMPTS=4` retryed; 404 =
   „schon weg" = Erfolg; sonst expliziter Fehler geworfen und vom Caller
   geloggt.
6. **Human-Input-Barrier vor resolved:** `input.drain()` +
   `InputTarget.drain()` (`input.ts:198`, `:274`); zusätzlich stoppt
   `raise-hand.ts` nach einem terminalen Signal jede weitere Input-Anwendung
   (`terminal`-Flag, `:134`, `:148`). **Test:** `input.test.ts` „drain resolves
   only after queued input has been dispatched".

---

## Gates (echte Ausgaben)

```
tsc --noEmit        → TSC: 0
oxlint              → OXLINT: 0
biome check .       → BIOME: 0
embed-guest --check → guest-source.ts is in sync with guest/server.js
bun test src/ test-app/ → 84 pass, 0 fail, 229 expect() calls (7 files)
```

(Testzahl von 39 → 84; 45 neue Assertions/Tests für die Sicherheitspfade.)

## e2e (`bun run test:e2e`, einmal, EXIT 0)

Slots vorher via `spikes/s1/cleanup.ts` geprüft: 0 laufend. Voller Lauf grün:

```
{"evt":"e2e_passed","totalMs":27754, ...}
```

Bestätigt intakt: B3 (Agent verbindet mit `&k=`, Handy-Seite lädt+verbindet per
Cookie), B1 (handback → resolved, 4 Cookies, „Signed in as ada"), B5 (Relay-
Sandbox nach Handoff **404**), Timeout-Fall (kein storageState, Relay 404). Die
Origin-Prüfung bricht den echten Browser-Pfad nicht (Handy-Origin == Host).

## Offene/bewusste Punkte

- **Mobile-Reconnect (Sol#7):** reine Browser-JS-Logik, kein In-Repo-DOM-Harness;
  per Reasoning umgesetzt, nicht unit-getestet. e2e-Human-Sim fährt Node-`ws`,
  nicht die gerenderte UI (Sol#9/W8, außerhalb Scope — e2e unangetastet).
- **W7:** Begrenzung statt Token-Refresh gewählt (v1), wie in S1 vorgeschlagen.
- **kill()-Fehler-Sichtbarkeit:** wird geloggt, nicht im `HandoffResult`-Typ
  exponiert (types.ts nicht im Scope).
