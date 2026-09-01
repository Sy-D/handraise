# CI/CD & Repo-Hygiene — Report

## Erstellte / erweiterte Dateien

- `.github/workflows/ci.yml` — erweitert um einen Coverage-Schritt (bestehende
  Schritte unverändert).
- `.github/workflows/release.yml` — neu: publish-on-tag, guarded.
- `.github/dependabot.yml` — neu: npm + github-actions, wöchentlich.
- `SECURITY.md` — neu.

## Coverage

Real gemessen (`bun test --coverage src/ test-app/`, Bun 1.4.0):

- **Funcs: 91.27 %**
- **Lines: 93.02 %**
- 84 Tests, 0 Fehler.

CI-Schritt `coverage summary` läuft `bun test --coverage src/ test-app/` und
druckt die Bun-eigene Text-Summary ins Job-Log. Keine externe Dep, kein
Codecov/Badge (braucht Account/Token).

### Threshold — bewusst NICHT gesetzt

Bun hat **keinen CLI-Threshold-Flag** (`bun test --help` zeigt nur
`--coverage`, `--coverage-reporter`, `--coverage-dir`). Ein Threshold geht nur
über `bunfig.toml` `[test] coverageThreshold` — und `bunfig.toml` liegt
außerhalb meiner Dateimenge. Ich habe sie darum nicht angefasst.

**Empfehlung, falls du einen ehrlichen, nicht-brechenden Threshold willst**
(ein paar Punkte unter Ist-Wert), in `bunfig.toml`:

```toml
[test]
coverageThreshold = { line = 0.90, function = 0.88 }
```

(Ist 93.02 / 91.27 → Puffer nach unten, wird heute grün.) Bun-Thresholds sind
Bruchzahlen 0–1. Sag Bescheid, dann trägt es der Supervisor ein; ich fasse
`bunfig.toml` per Auftrag nicht an.

## release.yml — Skip-Logik im Detail

Trigger: `push: tags: ['v*']` + `workflow_dispatch`.
Permissions: `contents: read`, `id-token: write` (npm provenance).

Ablauf: checkout → setup-bun → `bun install --frozen-lockfile` →
`bunx playwright-core install --with-deps chromium` → typecheck → lint →
`bun test src/ test-app/ e2e/ui.spec.ts` → build → **guarded publish**.

Guard-Mechanik (secrets sind in Step-`if:` nicht referenzierbar → env-Bridge):

```yaml
jobs:
  release:
    env:
      HAS_NPM_TOKEN: ${{ secrets.NPM_TOKEN != '' }}   # job-level env darf secrets lesen
```

- `setup node for npm publish` + `publish to npm`: `if: env.HAS_NPM_TOKEN == 'true'`.
- `publish to npm`: `env: NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`, Command
  `npm publish --provenance --access public` (Node 20, registry-url gesetzt).
- Info-Schritt `no NPM_TOKEN → skipping publish`: `if: env.HAS_NPM_TOKEN != 'true'`.

### Verhalten

**(a) Tag-Push OHNE NPM_TOKEN (heute):** `HAS_NPM_TOKEN` = `'false'`. Alle Gates
laufen, publish-Schritte werden übersprungen, der Info-Schritt loggt „nothing
was published … add NPM_TOKEN". Job endet **grün** — kein Publish, kein
roter Job.

**(b) MIT NPM_TOKEN (User hinterlegt Repo-Secret):** `HAS_NPM_TOKEN` = `'true'`.
Nach den Gates: setup-node mit npm-Registry, dann
`npm publish --provenance --access public` mit `NODE_AUTH_TOKEN`. Info-Schritt
wird übersprungen. Derselbe Workflow publisht beim nächsten `v*`-Tag oder
`workflow_dispatch`.

Doppelt geprüft: `secrets` nur in job-level `env` (erlaubt) und im publish-Step
`env` (erlaubt) referenziert; alle `if:` prüfen ausschließlich `env.*` (erlaubt).

## package.json — Script-Bedarf (bitte du eintragen)

Optional, rein für Convenience — CI funktioniert auch ohne:

```json
"test:coverage": "bun test --coverage src/ test-app/"
```

`prepublishOnly` ist bereits vorhanden (lint/typecheck/test/build) — der
Release-Workflow spiegelt diese Gates zusätzlich CI-seitig, daher kein
weiterer Script-Bedarf für Release.

## YAML-Validierung

```
$ python3 -c "import yaml; [yaml.safe_load(open(f)) for f in [...ci, release, dependabot...]]; print('yaml ok')"
yaml ok
```

Nicht committet, nicht getaggt.
