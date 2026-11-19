# Version 1.2.0 verification

## Selftest

```text
selftest: 28 OK, 0 fallos
```

## Local doctor

```text
council-dev 0.12.0
OK  Tyranno / Claude Code  (session not checked)
OK  Mastodon / Codex  (session not checked)
OK  Triceratops / Kimi  (session not checked)
OK  Pterodactyl / Antigravity  (session not checked)
OK  Saberdiente / Z.AI  (session not checked)
OK  Dragonzord / OpenCode  (session not checked)
```

## Clean doctor

```text
council-dev 0.12.0
BAD Tyranno / Claude Code  (unavailable)
OK  Mastodon / Codex  (session not checked)
BAD Triceratops / Kimi  (unavailable)
BAD Pterodactyl / Gemini  (unavailable)
BAD Saberdiente / Z.AI  (unavailable)
OK  Dragonzord / OpenCode  (session not checked)
```

## Gitleaks

```text
○
    │╲
    │ ○
    ○ ░
    ░    gitleaks

6:10PM INF scanned ~129383 bytes (129.38 KB) in 87.9ms
6:10PM INF no leaks found
```

## Private identifiers (local path redacted)

```text
./.git:1:gitdir: [local worktree metadata path]
Exit 0. Repeating with --exclude=.git gives empty output and exit 1.
```

## git diff --stat main

```text
README.md               |  27 ++++-
 bin/council-dev.js      | 308 +++++++++++++++++++++++++++++++++++-------------
 docs/getting-started.md |  19 ++-
 package.json            |   4 +-
 scripts/megazord        |   7 +-
 5 files changed, 273 insertions(+), 92 deletions(-)
```

Git omits the untracked CHANGELOG.md and PORT-REPORT.md from this statistic. Doctor checked local configuration only. The clean PATH includes Codex and OpenCode in the Node binary directory. Chimerazord reviews the tracked diff for defensive findings and fixes.

## Revisión de Claude Code (2026-11-19)
Codex entregó el porte con el selftest verde, pero la revisión encontró y corrigió:
1. **Chimerazord recortado**: solo revisaba `git diff`, sin personas completas ni informe CISO. Restaurado el
   flujo del privado, bilingüe, con solo los Zords disponibles. Prueba real: 6 atacantes + informe; detectó la
   inyección SQL plantada y no imprimió la llave falsa.
2. **Antigravity sin `--dangerously-skip-permissions`** en modo plan: no respondía en modo sin pantalla. Añadido
   (sigue en `--mode plan --sandbox`, solo lectura).
3. **OpenCode 2** (la versión que instala hoy cualquiera): sin `run --dir`; usa servidor compartido; **ignora
   `OPENCODE_PERMISSION`** (en debate Dragonzord llegó a escribir fuera de su carpeta) y resuelve el proyecto por
   `PWD`. Ahora: `--standalone`, permisos dentro de `OPENCODE_CONFIG_CONTENT`, `OPENCODE_DISABLE_PROJECT_CONFIG=1`
   y `PWD` explícito. OpenCode 1 conserva el camino anterior. Prueba real: construye en su carpeta; en debate no
   escribe ni dentro ni fuera.
4. Restos de «tres/cuatro Zords» y ejemplos con rutas de proyectos de Manuel en `scripts/megazord-multi`.
Resultado: selftest 37 OK · propuesta real 6/6 voces · gitleaks sin hallazgos · doctor en HOME limpio OK.
