#!/usr/bin/env node
// council-dev — Consejo local de CLIs (Claude, Codex, Kimi).
//
// Gobernanza (segun CLAUDE.md / BRIEFING-KIMI-ARQUITECTO.md de Manuel):
//   Manuel -> Arquitecto (Claude) -> Codex/Kimi (trabajadores).
//   - El ARBITRO que sintetiza la directriz es CLAUDE (ultima palabra tecnica).
//   - La EJECUCION va por REPARTO DE FORTALEZAS: Claude el core/critico,
//     Codex implementacion acotada y tests, Kimi volumen/drafts/procesamiento.
//   - El debate es SOLO LECTURA. Ejecutar requiere --approve.
//   - Todo el output va en espanol neutro latinoamericano.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, createWriteStream, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const VERSION = "0.11.0";

// Output language of the council. Default English (public repo); set
// MEGAZORD_LANG=es (or COUNCIL_LANG=es) for Spanish.
const LANG = /^es/i.test(process.env.MEGAZORD_LANG || process.env.COUNCIL_LANG || "en") ? "es" : "en";
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_PARALLEL = 3; // cap de obreros simultaneos en fan-out
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

// Perfiles de capacidad por Zord (CLI). El arbitro asigna por fortaleza y el
// motor reasigna cuando un Zord no esta disponible o no sabe editar.
const CLI_PROFILES = {
  claude: { zord: "Tyranno",      canEdit: true,  reliableEdit: true,  role: "arquitectura/decisiones criticas/integracion final — NO acaparar: solo pasos que exigen juicio de produccion" },
  codex:  { zord: "Mastodon",     canEdit: true,  reliableEdit: true,  role: "el MEJOR editor quirurgico: refactors precisos, tests, fixes acotados de 1 archivo" },
  kimi:   { zord: "Triceratops",  canEdit: true,  reliableEdit: false, role: "caballo de batalla: volumen, scaffolding, archivos nuevos, migraciones, Python" },
  gemini: { zord: "Pterodactyl",  canEdit: true,  reliableEdit: false, role: "research/QA/documentacion/tests E2E/analisis multimodal" },
};

// Verificacion obligatoria: solo se permiten comandos cuyo PRIMER token este en
// la whitelist, y sin metacaracteres de shell (anti-inyeccion/encadenamiento).
const VERIFY_WHITELIST = [
  "node", "npm", "npx", "pnpm", "yarn", "tsc", "eslint", "jest", "vitest",
  "php", "composer", "phpunit", "artisan", "python", "python3", "pytest",
  "ruff", "mypy", "go", "cargo", "make", "bash", "sh", "ruby", "rake",
];
const VERIFY_BANNED = /[;&|`$><\n(){}]|\.\.|rm\s|sudo\s/;

function isVerifyAllowed(cmd) {
  if (!cmd || typeof cmd !== "string") return false;
  const trimmed = cmd.trim();
  if (!trimmed || VERIFY_BANNED.test(trimmed)) return false;
  const first = trimmed.split(/\s+/)[0].replace(/^\.\//, "");
  // permite rutas tipo vendor/bin/phpunit o ./node_modules/.bin/jest
  const base = first.split("/").pop();
  return VERIFY_WHITELIST.includes(first) || VERIFY_WHITELIST.includes(base);
}

function usage() {
  return `council-dev ${VERSION}

Uso:
  council-dev doctor [--json]
  council-dev propose "<tarea>" [--repo DIR] [--timeout-ms N]
  council-dev consensus "<tarea>" [--repo DIR] [--timeout-ms N]
  council-dev execute "<tarea>" --repo DIR --approve [--fanout] [--no-verify] [--timeout-ms N]
  council-dev review --repo DIR [--timeout-ms N]

Reglas:
  - El debate (propose/consensus/review) es SOLO LECTURA.
  - El ARBITRO que sintetiza la directriz es Claude (Arquitecto).
  - execute reparte cada paso por fortalezas (Claude/Codex/Kimi/Gemini) y solo
    corre con --approve. Cada paso corre su verificacion (test/lint) salvo --no-verify.
  - --fanout: corre en paralelo los pasos con archivos DISJUNTOS (olas, cap ${MAX_PARALLEL}),
    con gate entre olas. Sin --fanout es secuencial.
  - Transcripciones en <repo>/.council-dev/runs/.

Variables de entorno (utiles en VPS/contenedores):
  COUNCIL_NO_EDIT=codex,gemini   Reasigna los pasos de esos owners a quien SI edita
                                 (Claude/Kimi). Util donde su escritura no es fiable.
  COUNCIL_CODEX_SANDBOX=...       Sandbox de 'codex exec' (default workspace-write;
                                 si bwrap falla se reintenta solo en danger-full-access).
  COUNCIL_ALLOW_NOOP=1           Permite que un paso que declaro archivos no toque
                                 ninguno (por defecto eso marca el paso como FALLO).
`;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    if (["json", "approve", "fanout", "no-verify", "telegram", "full", "list"].includes(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Falta el valor para --${key}`);
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Power Chamber: si hay logFile, volcamos la salida EN VIVO al log del Zord.
    let logStream = null;
    if (options.logFile) {
      try {
        mkdirSync(dirname(options.logFile), { recursive: true });
        logStream = createWriteStream(options.logFile, { flags: "a" });
      } catch { logStream = null; }
    }
    const closeLog = () => { if (logStream) { try { logStream.end(); } catch { /* */ } logStream = null; } };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (logStream) logStream.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (logStream) logStream.write(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      closeLog();
      resolvePromise({
        command, args, ok: false, code: null, stdout,
        stderr: stderr || error.message, timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      closeLog();
      resolvePromise({
        command, args, ok: code === 0 && !timedOut, code, stdout, stderr,
        timedOut, durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function commandExists(command) {
  const result = await runProcess("sh", ["-lc", `command -v ${shellQuote(command)}`], {
    timeoutMs: 10_000,
  });
  return result.ok && result.stdout.trim().length > 0;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// Kimi queda "listo" solo si `kimi login` (device-code flow) persistio el token
// OAuth. config.toml NO sirve como senal: trae default_model desde la instalacion
// aunque no haya login. El token se guarda en credentials/kimi-code.json
// (access_token + expires_at). Verificamos existencia y que no este expirado.
function kimiConfigured() {
  for (const p of [
    join(homedir(), ".kimi-code", "credentials", "kimi-code.json"),
    join(homedir(), ".kimi", "credentials", "kimi-code.json"),
  ]) {
    if (!existsSync(p)) continue;
    try {
      const c = JSON.parse(readFileSync(p, "utf8"));
      if (!c.access_token) continue;
      // El access_token caduca rapido pero el CLI lo refresca solo con el
      // refresh_token. Solo lo damos por invalido si esta expirado Y NO hay
      // refresh_token (entonces si requiere re-login).
      if (!c.refresh_token) {
        const exp = c.expires_at;
        let ms = null;
        if (typeof exp === "number") ms = exp < 1e12 ? exp * 1000 : exp;
        else if (typeof exp === "string") ms = Date.parse(exp);
        if (ms && Number.isFinite(ms) && ms < Date.now()) continue;
      }
      return true;
    } catch {
      return true; // existe pero no parseable: asumimos presente
    }
  }
  return false;
}

// Gemini queda "listo" si hay un metodo de auth: login GCA (Google Code Assist,
// usa tu plan, no API key) que persiste oauth_creds.json y selectedAuthType en
// settings.json; o variables de entorno (API key / Vertex / GCA).
// Lee la GEMINI_API_KEY del entorno o de ~/.gemini/.env (el CLI no siempre la
// carga si se corre desde otra carpeta; por eso se la pasamos explícita).
function geminiApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const env = readFileSync(join(homedir(), ".gemini", ".env"), "utf8");
    const m = env.match(/^\s*GEMINI_API_KEY\s*=\s*"?([^"\n]+)"?/m);
    if (m) return m[1].trim();
  } catch { /* */ }
  return null;
}

// Env extra para los subprocesos de Gemini. SOLO inyectamos la API key si ese es
// el metodo de auth elegido; si esta en login con Google (oauth-personal / Pro),
// NO la inyectamos para no anular la suscripcion.
function geminiEnv() {
  let authType = null;
  try {
    const m = readFileSync(join(homedir(), ".gemini", "settings.json"), "utf8")
      .match(/"selectedType"\s*:\s*"([^"]+)"/);
    if (m) authType = m[1];
  } catch { /* */ }
  if (authType && authType !== "gemini-api-key") return {}; // usa el login Pro
  const k = geminiApiKey();
  return k ? { GEMINI_API_KEY: k } : {};
}

function geminiConfigured() {
  // Método de auth elegido en settings.json
  let authType = null;
  try {
    const m = readFileSync(join(homedir(), ".gemini", "settings.json"), "utf8")
      .match(/"selectedType"\s*:\s*"([^"]+)"/);
    if (m) authType = m[1];
  } catch { /* */ }
  // Modo API key: requiere la key de verdad (env o ~/.gemini/.env)
  if (authType === "gemini-api-key") return !!geminiApiKey();
  // Otros modos: Vertex/GCA por env, o login con Google (oauth_creds), o key suelta
  if (process.env.GOOGLE_GENAI_USE_VERTEXAI || process.env.GOOGLE_GENAI_USE_GCA) return true;
  if (geminiApiKey()) return true;
  return existsSync(join(homedir(), ".gemini", "oauth_creds.json"));
}

function repoDir(args) {
  return resolve(args.repo ?? process.cwd());
}

function timeoutMs(args) {
  return args["timeout-ms"] ? Number(args["timeout-ms"]) : DEFAULT_TIMEOUT_MS;
}

function requireTask(args) {
  const task = args._.slice(1).join(" ").trim();
  if (!task) {
    throw new Error('Falta la tarea. Ej: council-dev consensus "Refactorizar el flujo de auth"');
  }
  return task;
}

function runDir(repo) {
  const dir = join(repo, ".council-dev", "runs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRun(repo, kind, data) {
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const file = join(runDir(repo), `${stamp}-${kind}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

function trimOutput(value, max = 80_000) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncado ${text.length - max} chars]`;
}

// Cap por pieza al ENSAMBLAR prompts de critica/arbitraje: el prompt viaja como
// UN solo argv y Linux lo limita a ~128KB (spawn E2BIG). 8 piezas x 10KB + tarea
// deja margen seguro. El texto completo queda igual en la transcripcion.
// Smart cap: trims the MIDDLE, never the end. In a technical proposal the closing
// (conclusions, risks, verification criteria) is the densest part; a blind slice threw
// it away. Keeps 60% head + 40% tail. Full text stays in the transcript.
function capForPrompt(value, max = 10_000) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n[...trimmed ${text.length - max} chars from the middle; full text in the transcript...]\n${text.slice(-tail)}`;
}

function extractCodexLastMessage(stdout) {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const messages = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const item = event.item;
      if (event.type === "agent_message" && (event.message || event.text)) {
        messages.push(event.message || event.text);
      }
      if (event.type === "final_answer" && (event.message || event.text)) {
        messages.push(event.message || event.text);
      }
      if (item?.type === "agent_message" && (item.message || item.text)) {
        messages.push(item.message || item.text);
      }
    } catch {
      // Algunas versiones de Codex emiten texto plano alrededor del JSONL.
    }
  }
  return messages.at(-1) ?? stdout.trim();
}

// Señales de que el sandbox de Codex (bubblewrap) falló en este entorno (típico
// en contenedores de VPS sin user-namespaces). Codex suele devolver exit 0 igual,
// así que esto NO se puede inferir del código de salida: hay que mirar la salida.
function codexSandboxFailed(result) {
  const txt = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  return /bwrap:|setting up uid map|user namespace|landlock|seccomp|apply_patch verification failed|failed to (?:create|set ?up) sandbox/i.test(txt);
}

// --------------------------------------------------------------------------- //
//  Adaptadores                                                                 //
// --------------------------------------------------------------------------- //
const adapters = {
  // Claude para debate y sintesis del Arquitecto. Sin --permission-mode plan:
  // ese modo sesga la salida headless a un resumen meta en vez del contenido.
  // En -p no interactivo las ediciones se deniegan solas => sigue siendo lectura.
  async claudePlan(prompt, repo, options) {
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--add-dir", repo];
    const result = await runProcess("claude", args, { cwd: repo, timeoutMs: options.timeoutMs, logFile: options.logFile });
    return { agent: "claude", ...result, text: trimOutput(parseClaude(result.stdout)) };
  },
  // Claude con escritura (ejecuta pasos del core).
  async claudeWrite(prompt, repo, options) {
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--add-dir", repo];
    const result = await runProcess("claude", args, { cwd: repo, timeoutMs: options.timeoutMs, logFile: options.logFile });
    return { agent: "claude", ...result, text: trimOutput(parseClaude(result.stdout)) };
  },
  // Arbitro: sintesis PURA (no agentica). Sin --add-dir y con herramientas
  // deshabilitadas para que NO se ponga a explorar el repo y muera por timeout
  // (ya tiene todas las propuestas en el prompt). Emite directriz + plan de un tiro.
  async claudeArbiter(prompt, repo, options) {
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose",
      "--disallowedTools", "Bash", "Edit", "Write", "Read", "Glob", "Grep",
      "WebFetch", "WebSearch", "Task", "NotebookEdit", "TodoWrite"];
    const result = await runProcess("claude", args, { cwd: repo, timeoutMs: options.timeoutMs, logFile: options.logFile });
    return { agent: "claude", ...result, text: trimOutput(parseClaude(result.stdout)) };
  },
  // Kimi: en debate sin auto-aprobacion (no edita); en ejecucion, -p ya
  // ejecuta herramientas headless. --yolo NO se puede combinar con -p en
  // kimi-code actual (error: Cannot combine --prompt with --yolo).
  async kimiPlan(prompt, repo, options) {
    const args = ["-p", prompt, "--output-format", "text"];
    const result = await runProcess("kimi", args, { cwd: repo, timeoutMs: options.timeoutMs, logFile: options.logFile });
    return { agent: "kimi", ...result, text: trimOutput(result.stdout.trim() || result.stderr.trim()) };
  },
  async kimiWrite(prompt, repo, options) {
    const args = ["-p", prompt, "--output-format", "text"];
    const result = await runProcess("kimi", args, { cwd: repo, timeoutMs: options.timeoutMs, logFile: options.logFile });
    return { agent: "kimi", ...result, text: trimOutput(result.stdout.trim() || result.stderr.trim()) };
  },
  async codexPlan(prompt, repo, options) {
    const args = ["exec", "--json", "--sandbox", "read-only", "--cd", repo, "--skip-git-repo-check", prompt];
    const result = await runProcess("codex", args, { cwd: repo, timeoutMs: options.timeoutMs, logFile: options.logFile });
    return { agent: "codex", ...result, text: trimOutput(extractCodexLastMessage(result.stdout)) };
  },
  async codexExecute(prompt, repo, options) {
    const sandbox = process.env.COUNCIL_CODEX_SANDBOX || "workspace-write";
    const run = (sb) => runProcess("codex",
      ["exec", "--json", "--sandbox", sb, "--cd", repo, "--skip-git-repo-check", prompt],
      { cwd: repo, timeoutMs: options.timeoutMs, logFile: options.logFile });
    let result = await run(sandbox);
    // En VPS/contenedores sin user-namespaces, bubblewrap revienta el sandbox de
    // Codex (bwrap: setting up uid map: Permission denied / apply_patch
    // verification failed) y devuelve exit 0 SIN tocar nada. Reintentamos UNA vez
    // sin sandbox para que Codex pueda editar (entorno controlado del VPS).
    if (sandbox !== "danger-full-access" && codexSandboxFailed(result)) {
      if (options.logFile) {
        try { appendFileSync(options.logFile, `\n[council-dev] sandbox bwrap falló; reintento con --sandbox danger-full-access\n`); } catch { /* */ }
      }
      result = await run("danger-full-access");
      result.sandboxFallback = true;
    }
    return { agent: "codex", ...result, text: trimOutput(extractCodexLastMessage(result.stdout)) };
  },
  // Gemini (4a voz). En debate, approval-mode plan = solo lectura; en ejecucion, yolo.
  async geminiPlan(prompt, repo, options) {
    const args = ["-p", prompt, "--approval-mode", "plan", "--skip-trust", "--output-format", "text"];
    const result = await runProcess("gemini", args, { cwd: repo, timeoutMs: options.timeoutMs, logFile: options.logFile, env: geminiEnv() });
    return { agent: "gemini", ...result, text: trimOutput(result.stdout.trim() || result.stderr.trim()) };
  },
  async geminiWrite(prompt, repo, options) {
    const args = ["-p", prompt, "--yolo", "--skip-trust", "--output-format", "text"];
    const result = await runProcess("gemini", args, { cwd: repo, timeoutMs: options.timeoutMs, logFile: options.logFile, env: geminiEnv() });
    return { agent: "gemini", ...result, text: trimOutput(result.stdout.trim() || result.stderr.trim()) };
  },
};

function parseClaude(stdout) {
  const s = (stdout || "").trim();
  if (!s) return "";
  // stream-json: varias lineas JSON (eventos). El texto final esta en el evento
  // type=result; si no, juntamos los mensajes del assistant.
  if (s.includes('"type":"result"') || s.includes('"type":"assistant"')) {
    let result = null;
    let lastAssistant = null;
    for (const line of s.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const o = JSON.parse(t);
        if (o.type === "result" && typeof o.result === "string") result = o.result;
        if (o.type === "assistant" && Array.isArray(o.message?.content)) {
          const txt = o.message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
          if (txt) lastAssistant = txt;
        }
      } catch { /* linea parcial/no-json */ }
    }
    if (result || lastAssistant) return result ?? lastAssistant;
  }
  // Formato json simple {result:...} o texto plano (compatibilidad)
  try {
    const parsed = JSON.parse(s);
    return parsed.result ?? parsed.message ?? s;
  } catch {
    return s;
  }
}

// --------------------------------------------------------------------------- //
//  Prompts (espanol neutro)                                                    //
// --------------------------------------------------------------------------- //
function basePrompt(task) {
  if (LANG === "es") {
    return `Participas en un consejo tecnico de cuatro CLIs (Claude, Codex, Kimi, Gemini). Responde en espanol neutro latinoamericano (tuteo: tu, tienes, puedes, aqui; nada de voseo).

TAREA:
${task}

Reglas:
- NO edites archivos. Analiza el repo solo si hace falta.
- No adivines rutas/APIs/comportamiento: lo que no sepas, marcalo como supuesto.
- Entrega una propuesta concreta con estas secciones markdown:
  ## Metodologia
  ## Pipeline
  ## Workflow
  ## Analisis y riesgos
  ## Criterios de verificacion
- Se especifico (archivos, comandos, pasos). Nada de relleno.\n- ECONOMIA DE SALIDA (obligatorio): no reformules ni repitas el enunciado, no\n  expliques lo que vas a hacer antes de hacerlo, no cierres con resumenes de lo ya\n  dicho. Cero preambulo. Prosa densa. Si algo se dice en una linea, no uses tres.`;
  }
  return `You are on a technical council of four AI CLIs (Claude, Codex, Kimi, Gemini). Respond in clear, concise English.

TASK:
${task}

Rules:
- Do NOT edit files. Only inspect the repo if needed.
- Don't guess paths/APIs/behavior: mark anything you're unsure about as an assumption.
- Deliver a concrete proposal with these markdown sections:
  ## Methodology
  ## Pipeline
  ## Workflow
  ## Analysis and risks
  ## Verification criteria
- Be specific (files, commands, steps). No filler.\n- OUTPUT ECONOMY (mandatory): do not restate the task, do not explain what you\n  are about to do before doing it, do not close with summaries of what you already\n  said. Zero preamble. Dense prose. If a point fits in one line, don't use three.`;
}


// THE PRUNER — one Zord gets this role in round 2. The other three argue about HOW
// to build; this one asks WHETHER to build. With four models proposing in parallel
// the bias is to over-deliver: nobody has the job of cutting.
// Ladder distilled from Ponytail (github.com/DietrichGebert/ponytail, MIT).
const PRUNER = (process.env.MEGAZORD_PRUNER || process.env.MEGAZORD_PODADOR || "codex").toLowerCase();
const PRUNER_ROLE = {
  en: `
================== YOUR ROLE THIS ROUND: THE PRUNER ==================
The other advisors argue about HOW to build. Your only job is to ask
WHETHER to build. You are a lazy senior dev: lazy means efficient, not
careless. The best code is the code never written.

For each proposed piece, climb this ladder and STOP at the first rung that holds:
  1. Does this need to be built at all? (YAGNI)
  2. Does it already exist in this repo? Reuse the helper/pattern that's here.
  3. Does the standard library already do this?
  4. Does a native platform feature cover it?
  5. Does an already-installed dependency solve it?
  6. Can this be one line?
  7. Only then: the minimum that works.

CRITICAL — the ladder runs AFTER you understand the problem, not instead of it.
Read the task and the code it touches, trace the real flow, then prune. A small
change in the wrong place isn't lazy, it's a bug. NEVER prune correctness, error
handling, tenant/data isolation, or verification.

Hard rules:
- No abstractions nobody asked for. No new dependency if avoidable.
- Deletion over addition. Boring over clever. Fewest files possible.
- Bug fix = root cause, not symptom: grep EVERY caller of the function you touch.
- Question complexity: "do you actually need X, or does Y cover it?"

Deliver, IN ADDITION to your improved proposal, a final section:
  ## Pruned
  List what is unnecessary in the other proposals, and which rung it falls on.
======================================================================
`,
  es: `
================== TU ROL EN ESTA RONDA: EL PODADOR ==================
Los otros asesores discuten COMO construir. Tu unico trabajo es preguntar
SI HAY QUE CONSTRUIR. Eres un senior perezoso: perezoso significa eficiente,
no descuidado. El mejor codigo es el que nunca se escribe.

Ante cada pieza propuesta, sube esta escalera y DETENTE en el primer peldano
que aguante:
  1. Hace falta construirlo? (YAGNI)
  2. Ya existe en este repositorio? Reusa el helper/patron que ya esta.
  3. Lo resuelve la libreria estandar del lenguaje?
  4. Lo cubre una funcion nativa de la plataforma?
  5. Lo resuelve una dependencia YA instalada?
  6. Cabe en una linea?
  7. Solo entonces: el minimo que funcione.

CRITICO — la escalera corre DESPUES de entender el problema, no en su lugar.
Lee la tarea y el codigo que toca, traza el flujo real, y recien ahi poda. Un
cambio pequeno en el sitio equivocado no es pereza: es un fallo. NO recortes
correctitud, manejo de errores, aislamiento entre clientes ni verificacion.

Reglas duras:
- Sin abstracciones que nadie pidio. Sin dependencia nueva si se puede evitar.
- Borrar antes que anadir. Aburrido antes que ingenioso. Los menos archivos posibles.
- Arreglo de bug = causa raiz, no sintoma: busca TODOS los llamadores.
- Cuestiona lo complejo: "de verdad hace falta X, o Y ya lo cubre?"

Entrega, ADEMAS de tu propuesta mejorada, una seccion final:
  ## Poda
  Lista lo que sobra de las propuestas ajenas, y por que peldano de la escalera cae.
======================================================================
`,
};

function critiquePrompt(task, proposals, forAgent = null) {
  const label = LANG === "es" ? "Propuesta" : "Proposal";
  const empty = LANG === "es" ? "[sin salida]" : "[no output]";
  const others = proposals.map((p, i) => `### ${label} ${i + 1}\n${capForPrompt(p.text || p.stderr || empty)}`).join("\n\n");
  // Only ONE Zord gets the role: if all four had it they would all converge on
  // minimalism and the disagreement — where the good decision comes from — is lost.
  const role = forAgent === PRUNER ? PRUNER_ROLE[LANG] : "";
  if (LANG === "es") {
    return `${basePrompt(task)}

${role}
PROPUESTAS DE LOS OTROS ASESORES (anonimas):
${others}

Ahora: 1) critica fallos, supuestos fragiles y riesgos de las otras propuestas; 2) reescribe y mejora TU propuesta integrando lo bueno. Manten las mismas secciones.`;
  }
  return `${basePrompt(task)}

${role}
THE OTHER ADVISORS' PROPOSALS (anonymized):
${others}

Now: 1) critique the flaws, fragile assumptions and risks in the other proposals; 2) rewrite and improve YOUR proposal, integrating what's good. Keep the same sections.`;
}

// El ARBITRO es Claude. Produce la directriz en espanol + un plan JSON con el
// reparto por fortalezas que execute usara para rutear cada paso.
function arbiterPrompt(task, firstRound, critiques) {
  const empty = LANG === "es" ? "[sin salida]" : "[no output]";
  const r1 = firstRound.map((p) => `## ${p.agent}\n${capForPrompt(p.text || p.stderr || empty)}`).join("\n\n");
  const crit = critiques.map((p) => `## ${p.agent}\n${capForPrompt(p.text || p.stderr || empty)}`).join("\n\n");

  if (LANG === "es") {
    return `Eres el Arquitecto Principal (Claude) y tienes la ultima palabra tecnica. Espanol neutro (tuteo, sin voseo). Recibiste la tarea y las propuestas refinadas del consejo. Sintetiza UNA directriz unica y accionable. No promedies: elige lo mejor de cada propuesta y justifica breve.

REGLA DE LA PODA (no negociable): una de las criticas trae una seccion "## Poda".
Esa seccion NO es una opinion mas que promedias con las otras tres — es un veto por
defecto. Procesala ANTES de armar el plan, punto por punto:
- Cada elemento podado queda FUERA del plan, salvo que escribas por que es
  imprescindible. La carga de la prueba la tiene quien quiere CONSTRUIR, no quien
  quiere recortar. Tres asesores diciendo "construyamos esto" no derrotan una poda.
- Solo puedes rescatar algo podado si es correctitud, manejo de errores, aislamiento
  entre clientes/datos, o verificacion. Comodidad, "por si acaso", "buenas practicas"
  y "escalabilidad futura" NO son motivos validos.
- Si rescatas algo, dilo explicitamente: "Rescato X porque <motivo>".
- Menos pasos y menos archivos es MEJOR resultado, no peor.


TAREA ORIGINAL:
${task}

PROPUESTAS RONDA 1:
${r1}

CRITICAS / REFINAMIENTO:
${crit}

Entrega DOS partes:

PARTE A — Directriz en markdown:
## Decision
## Plan de ejecucion (pasos numerados)
## Archivos afectados
## Reparto de trabajo
## Verificacion (comando real)
## Riesgo remanente

PARTE B — Plan ejecutable en un unico bloque \`\`\`json al final, con este shape exacto:
{"pasos":[{"owner":"claude|codex|kimi|gemini","titulo":"...","instruccion":"orden autocontenida","archivos":["ruta/relativa.ext"],"verify":"comando de verificacion"}]}

Reglas DURAS del plan (el motor las valida y rechaza si fallan):
- "archivos": lista de rutas RELATIVAS concretas que ese paso va a tocar. NADA de
  globs (* ? [ ]). Para correr pasos en paralelo, los pasos deben tocar archivos
  DISJUNTOS (dos pasos NO pueden declarar el mismo archivo). Si dos tareas tocan
  el mismo archivo, ponlas como UN solo paso o asigna distintos archivos.
- "verify": comando REAL de verificacion del paso (test/lint/compilacion). Debe
  empezar con uno de: node, npm, npx, php, composer, phpunit, artisan, python,
  python3, pytest, ruff, go, cargo, make, tsc, eslint, jest, vitest, bash -n.
  Sin punto y coma, pipes, &&, ni redirecciones. Ej: "node --check src/x.js",
  "php artisan test --filter=Foo", "pytest tests/test_x.py".

Reparto por fortalezas (cadena de mando Manuel->Claude->Codex/Kimi/Gemini):
- owner "claude" (🔴 Tyranno): SOLO pasos que exigen juicio critico de produccion (auth, dinero, datos de cliente, integracion final). Es el arbitro: NO debe acaparar la construccion.
- owner "codex" (⚫ Mastodon): el editor mas preciso. Refactors quirurgicos, tests, fixes acotados de un archivo, logica delicada en codigo existente.
- owner "kimi" (🔵 Triceratops): el caballo de volumen. Archivos NUEVOS, scaffolding, migraciones mecanicas, procesamiento, Python.
- owner "gemini" (🩷 Pterodactyl): research, QA, tests E2E, documentacion, revision multimodal.

REGLAS DE BALANCE (el gate las mira y Manuel audita el reparto):
- "claude" puede tener COMO MAXIMO el 40% de los pasos, y NUNCA mas pasos que codex+kimi juntos. Si un paso va a claude, la instruccion debe empezar justificando en una linea POR QUE exige juicio critico.
- Distribuye a los 4 owners cuando la tarea lo permita; un plan donde 1 owner tiene >50% de los pasos requiere justificacion explicita en la PARTE A.
- Piensa en PARALELO: pasos disjuntos entre owners distintos terminan antes que pasos apilados en un solo owner.
Cada "instruccion" debe ser autocontenida (el CLI asignado solo recibe ese texto).`;
  }

  return `You are the Principal Architect (Claude) with the final technical say. Respond in clear English. You received the task and the council's refined proposals. Synthesize ONE single, actionable directive. Don't average: pick the best of each proposal and justify briefly.

PRUNING RULE (non-negotiable): one of the critiques carries a "## Pruned" section.
That section is NOT just another opinion to average with the other three — it is a
veto by default. Process it BEFORE assembling the plan, item by item:
- Every pruned item stays OUT of the plan unless you write why it is indispensable.
  The burden of proof is on whoever wants to BUILD, not on whoever wants to cut.
  Three advisors saying "let's build this" do not defeat a prune: all three are
  builders and that is exactly their bias.
- You may only rescue a pruned item if it is correctness, error handling,
  tenant/data isolation, or verification. Convenience, "just in case", "best
  practices" and "future scalability" are NOT valid reasons.
- If you rescue something, say so in one line: "Rescuing X because <reason>".
- Fewer steps and fewer files is a BETTER result, not a worse one.

ORIGINAL TASK:
${task}

ROUND 1 PROPOSALS:
${r1}

CRITIQUES / REFINEMENT:
${crit}

Deliver TWO parts:

PART A — Directive in markdown:
## Decision
## Execution plan (numbered steps)
## Affected files
## Work split
## Verification (real command)
## Remaining risk

PART B — Executable plan in a SINGLE \`\`\`json block at the very end, with this exact shape (the "pasos" key name must be kept literally — the engine parses it):
{"pasos":[{"owner":"claude|codex|kimi|gemini","titulo":"...","instruccion":"self-contained order","archivos":["relative/path.ext"],"verify":"verification command"}]}

HARD rules of the plan (the engine validates and rejects on failure):
- "archivos": list of concrete RELATIVE paths that step will touch. NO globs
  (* ? [ ]). To run steps in parallel, steps must touch DISJOINT files (two steps
  must NOT declare the same file). If two tasks touch the same file, make them ONE
  step or assign different files.
- "verify": a REAL verification command for the step (test/lint/compile). It must
  start with one of: node, npm, npx, php, composer, phpunit, artisan, python,
  python3, pytest, ruff, go, cargo, make, tsc, eslint, jest, vitest, bash -n.
  No semicolons, pipes, &&, or redirections. E.g. "node --check src/x.js",
  "php artisan test --filter=Foo", "pytest tests/test_x.py".

Work split by strength (chain of command: you -> Claude -> Codex/Kimi/Gemini):
- owner "claude" (🦖 Tyranno): ONLY steps needing critical production judgment (auth, money, customer data, final integration). It's the referee: it must NOT hog the build.
- owner "codex" (🐘 Mastodon): the most precise editor. Surgical refactors, tests, single-file fixes, delicate logic in existing code.
- owner "kimi" (🛡️ Triceratops): the volume workhorse. NEW files, scaffolding, mechanical migrations, processing, Python.
- owner "gemini" (🦅 Pterodactyl): research, QA, E2E tests, documentation, multimodal review.

BALANCE RULES (the gate checks these):
- "claude" may own AT MOST 40% of the steps, and NEVER more steps than codex+kimi combined. If a step goes to claude, its instruccion must start by justifying in one line WHY it needs critical judgment.
- Distribute across the 4 owners when the task allows; a plan where one owner has >50% of steps requires explicit justification in PART A.
- Think in PARALLEL: disjoint steps across different owners finish faster than steps piled on one owner.
Each "instruccion" must be self-contained (the assigned CLI only receives that text).`;
}

function normalizeStep(step) {
  return {
    owner: String(step.owner || "claude").toLowerCase(),
    titulo: step.titulo || step.title || "",
    instruccion: step.instruccion || step.instruction || "",
    archivos: Array.isArray(step.archivos) ? step.archivos.map((f) => String(f).trim()).filter(Boolean)
            : Array.isArray(step.files) ? step.files.map((f) => String(f).trim()).filter(Boolean) : [],
    verify: typeof step.verify === "string" ? step.verify.trim() : null,
  };
}

// Extrae el objeto JSON balanceado desde el primer "{" (consciente de strings y
// escapes). Necesario porque las "instruccion" del plan suelen traer bloques de
// codigo con ``` anidados que rompen un regex no-greedy de fences.
function balancedJson(s) {
  let depth = 0, inStr = false, esc = false, started = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") { depth += 1; started = true; }
    else if (c === "}") {
      depth -= 1;
      if (started && depth === 0) return s.slice(0, i + 1);
    }
  }
  return null;
}

function extractPlan(directiveText) {
  const tryParse = (raw) => {
    try {
      const obj = JSON.parse(raw);
      if (Array.isArray(obj.pasos) && obj.pasos.length) return obj.pasos.map(normalizeStep);
    } catch { /* */ }
    return null;
  };
  // 1) ULTIMO bloque ```json con parser balanceado (robusto a ``` anidados)
  const idx = directiveText.lastIndexOf("```json");
  if (idx !== -1) {
    const after = directiveText.slice(idx + 7);
    const start = after.indexOf("{");
    if (start !== -1) {
      const raw = balancedJson(after.slice(start));
      if (raw) { const r = tryParse(raw); if (r) return r; }
    }
  }
  // 2) compatibilidad: primer fence simple
  const fence = directiveText.match(/```json\s*([\s\S]*?)```/i);
  if (fence) { const r = tryParse(fence[1]); if (r) return r; }
  // 3) ultimo recurso: primer "{"pasos"" balanceado en el texto plano
  const pIdx = directiveText.indexOf('{"pasos"');
  if (pIdx !== -1) {
    const raw = balancedJson(directiveText.slice(pIdx));
    if (raw) { const r = tryParse(raw); if (r) return r; }
  }
  // Fallback seguro: si el Arquitecto no entrego JSON valido, todo lo ejecuta
  // Claude como un unico paso (respeta "Claude toca el core"). Sin fan-out.
  return [normalizeStep({ owner: "claude", titulo: "Ejecutar directriz completa", instruccion: directiveText })];
}

// Owners cuya ESCRITURA no es fiable en este entorno y deben reasignarse. En el
// VPS Hostinger, Codex y Gemini fallan al editar (bwrap roto): se setea con
// COUNCIL_NO_EDIT=codex,gemini para que sus pasos pasen a quien sí edita (Claude/Kimi).
function noEditOwners() {
  return new Set((process.env.COUNCIL_NO_EDIT || "")
    .split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean));
}

// Elige el mejor editor disponible para un paso. Pura y testeable: recibe el
// owner preferido y el estado de capacidad/auth. Honra la cadena de mando (Codex
// el obrero mas fiable; Claude el ultimo recurso) y excluye a quien no edita
// fiable en este entorno (disabled) o no tiene login (kimi/gemini).
function resolveEditor(preferred, caps) {
  const { disabled = new Set(), kimiOk = true, geminiOk = true } = caps || {};
  const canEdit = (o) => {
    if (!CLI_PROFILES[o]?.canEdit) return false;
    if (disabled.has(o)) return false;
    if (o === "kimi") return kimiOk;
    if (o === "gemini") return geminiOk;
    return true; // claude / codex no tienen gate de auth aqui
  };
  for (const o of [preferred, "codex", "kimi", "claude"]) {
    if (CLI_PROFILES[o] && canEdit(o)) return o;
  }
  return "claude"; // garantia: alguien tiene que editar
}

// Reasigna el dueno cuando no esta disponible, no tiene login, o no edita de
// forma fiable en este entorno (COUNCIL_NO_EDIT).
function normalizeOwner(step) {
  const owner = CLI_PROFILES[step.owner] ? step.owner : "claude";
  const caps = { disabled: noEditOwners(), kimiOk: kimiConfigured(), geminiOk: geminiConfigured() };
  const resolved = resolveEditor(owner, caps);
  const reassignedFrom = resolved !== owner ? owner : null;
  return { ...step, owner: resolved, reassignedFrom };
}

// --------------------------------------------------------------------------- //
//  Rondas                                                                      //
// --------------------------------------------------------------------------- //
function liveVoices(results) {
  // Una voz cuenta si salio ok y produjo texto util.
  return results.filter((r) => r.ok && (r.text || "").trim().length > 0);
}

// Power Chamber: abre el panel del Zord con un encabezado y devuelve opciones
// con el logFile, para que su salida (debate o sintesis) se vea en vivo.
function dlog(repo, agent, label, options) {
  const logFile = join(repo, "_dispatch", `${agent}.log`);
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    const stamp = new Date().toISOString().slice(11, 19);
    appendFileSync(logFile, `\n\n===== ${label} · [${stamp}] ${CLI_PROFILES[agent]?.zord || agent}/${agent} =====\n`);
  } catch { /* */ }
  return { ...options, logFile };
}

async function firstRound(task, repo, options) {
  const prompt = basePrompt(task);
  const L = "🧠 debate ronda 1";
  return Promise.all([
    adapters.claudePlan(prompt, repo, dlog(repo, "claude", L, options)),
    adapters.kimiPlan(prompt, repo, dlog(repo, "kimi", L, options)),
    adapters.codexPlan(prompt, repo, dlog(repo, "codex", L, options)),
    adapters.geminiPlan(prompt, repo, dlog(repo, "gemini", L, options)),
  ]);
}

async function critiqueRound(task, repo, proposals, options) {
  const p = (agent) => critiquePrompt(task, proposals, agent);
  const L = "🧠 critica ronda 2";
  return Promise.all([
    adapters.claudePlan(p("claude"), repo, dlog(repo, "claude", L, options)),
    adapters.kimiPlan(p("kimi"), repo, dlog(repo, "kimi", L, options)),
    adapters.codexPlan(p("codex"), repo, dlog(repo, "codex", L, options)),
    adapters.geminiPlan(p("gemini"), repo, dlog(repo, "gemini", L, options)),
  ]);
}

async function runConsensus(task, repo, options) {
  const proposals = await firstRound(task, repo, options);
  const live = liveVoices(proposals);
  if (live.length < 2) {
    return { task, repo, proposals, critiques: [], directive: null,
      error: `Solo respondio ${live.length} voz; se necesitan >=2 para debatir. ` +
             `Revisa 'council-dev doctor' (Kimi suele faltar por /login).` };
  }
  const critiques = await critiqueRound(task, repo, liveVoices(proposals), options);
  const liveCrit = liveVoices(critiques).length ? liveVoices(critiques) : live;
  // El Arquitecto (Claude) sintetiza, en modo plan (solo lectura).
  const directive = await adapters.claudeArbiter(arbiterPrompt(task, live, liveCrit), repo, dlog(repo, "claude", "🔴 sintetizando directriz", options));
  return { task, repo, proposals, critiques, directive };
}

// --------------------------------------------------------------------------- //
//  Ejecucion por reparto                                                       //
// --------------------------------------------------------------------------- //
// Ejecuta UN paso ya normalizado (owner resuelto por normalizeOwner). Solo rutea.
async function executeStep(step, repo, options) {
  const owner = CLI_PROFILES[step.owner] ? step.owner : "claude";
  const files = step.archivos?.join(", ");
  const alcance = step.archivos?.length
    ? (LANG === "es"
        ? `\n\nToca SOLO estos archivos: ${files}. No toques otros.`
        : `\n\nTouch ONLY these files: ${files}. Do not touch others.`)
    : "";
  const header = LANG === "es"
    ? `Eres ${owner.toUpperCase()} ejecutando un paso de una directriz YA APROBADA por Manuel. Espanol neutro. Haz EXACTAMENTE esto y nada mas; manten el cambio acotado:`
    : `You are ${owner.toUpperCase()} executing a step of an ALREADY-APPROVED directive. Respond and code in English. Do EXACTLY this and nothing more; keep the change scoped:`;
  const prompt = `${header}

${step.instruccion}${alcance}`;

  // Power Chamber: cada Zord escribe en vivo a _dispatch/<owner>.log
  const logFile = join(repo, "_dispatch", `${owner}.log`);
  const stamp = new Date().toISOString().slice(11, 19);
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `\n\n===== ▶ [${stamp}] ${CLI_PROFILES[owner]?.zord || owner}/${owner} · ${step.titulo || "paso"} =====\n`);
  } catch { /* */ }

  const adapterOpts = { ...options, logFile };
  let result;
  if (owner === "codex") result = await adapters.codexExecute(prompt, repo, adapterOpts);
  else if (owner === "kimi") result = await adapters.kimiWrite(prompt, repo, adapterOpts);
  else if (owner === "gemini") result = await adapters.geminiWrite(prompt, repo, adapterOpts);
  else result = await adapters.claudeWrite(prompt, repo, adapterOpts);

  try {
    appendFileSync(logFile, `\n----- ${result.ok ? "✓ OK" : "✗ FALLO"} (${Math.round((result.durationMs || 0) / 1000)}s) -----\n`);
  } catch { /* */ }

  return { ...result, owner, reassignedFrom: step.reassignedFrom || null, titulo: step.titulo || "" };
}

// ¿el repo es un git? (enforceDeclaredFiles es best-effort, solo aplica si lo es)
async function repoIsGit(repo) {
  const r = await runProcess("git", ["-C", repo, "rev-parse", "--is-inside-work-tree"], { timeoutMs: 8000 });
  return r.ok && r.stdout.trim() === "true";
}

// Gate de plan: valida estructura ANTES de tocar nada. Globs y verify mala.
// Las colisiones NO son error: buildWaves las serializa. Solo se reportan.
function planGate(pasos, { fanout, requireVerify }) {
  const errors = [];
  const seen = new Map(); // archivo -> indice de primer paso que lo declara
  const collisions = [];
  pasos.forEach((s, i) => {
    for (const f of s.archivos) {
      if (/[*?\[\]]/.test(f)) errors.push(`Paso ${i + 1}: glob prohibido en archivos ("${f}").`);
      if (seen.has(f)) collisions.push(`"${f}" (pasos ${seen.get(f) + 1} y ${i + 1})`);
      else seen.set(f, i);
    }
    if (fanout && s.archivos.length === 0) {
      errors.push(`Paso ${i + 1}: fan-out exige declarar "archivos".`);
    }
    if (requireVerify) {
      if (!s.verify) errors.push(`Paso ${i + 1}: falta "verify" (verificacion obligatoria).`);
      else if (!isVerifyAllowed(s.verify)) errors.push(`Paso ${i + 1}: "verify" no permitido ("${s.verify}").`);
    } else if (s.verify && !isVerifyAllowed(s.verify)) {
      errors.push(`Paso ${i + 1}: "verify" no permitido ("${s.verify}").`);
    }
  });
  return { ok: errors.length === 0, errors, collisions };
}

// Agrupa pasos en "olas" donde los archivos son DISJUNTOS (cap MAX_PARALLEL).
// Pasos sin archivos declarados corren solos (ola propia). Colisiones se serializan.
function buildWaves(pasos) {
  const waves = [];
  for (const step of pasos) {
    const files = new Set(step.archivos || []);
    let placed = false;
    if (files.size > 0) {
      for (const wave of waves) {
        if (wave.steps.length >= MAX_PARALLEL || wave.files.size === 0) continue;
        let overlap = false;
        for (const f of files) if (wave.files.has(f)) { overlap = true; break; }
        if (!overlap) {
          for (const f of files) wave.files.add(f);
          wave.steps.push(step);
          placed = true;
          break;
        }
      }
    }
    if (!placed) waves.push({ files: new Set(files), steps: [step] });
  }
  return waves.map((w) => w.steps);
}

// Verificacion del paso (whitelist ya validada por planGate / isVerifyAllowed).
async function runVerify(cmd, repo, options) {
  if (!cmd) return { verify: null };
  if (!isVerifyAllowed(cmd)) return { verify: { cmd, ok: false, skipped: "comando no permitido" } };
  const r = await runProcess("sh", ["-c", cmd], { cwd: repo, timeoutMs: Math.min(options.timeoutMs, 120_000) });
  return { verify: { cmd, ok: r.ok, code: r.code, output: trimOutput((r.stdout || "") + (r.stderr || ""), 4000) } };
}

// Parsea `git status --porcelain` a un set de rutas tocadas: modificadas,
// nuevas/untracked (??) y renombradas (toma el destino tras " -> ").
function parsePorcelain(stdout) {
  const files = new Set();
  for (const line of (stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let path = line.slice(3); // formato "XY <path>"
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4); // rename: nos quedamos el destino
    path = path.trim().replace(/^"(.*)"$/, "$1"); // git cita rutas con espacios
    if (path) files.add(path);
  }
  return files;
}

// Best-effort (git): detecta archivos tocados FUERA de lo declarado y, sobre todo,
// si el paso NO toco NINGUNO de los archivos que declaro (fallo silencioso: p. ej.
// Codex con sandbox roto devuelve exit 0 sin escribir). Usa `status --porcelain`
// para incluir archivos NUEVOS (que `diff` no muestra). tocoDeclarados=null cuando
// no se puede determinar (sin git o sin archivos declarados).
async function enforceDeclaredFiles(step, repo, isGit) {
  if (!isGit || !step.archivos?.length) return { fuera: [], tocoDeclarados: null };
  const r = await runProcess("git", ["-C", repo, "status", "--porcelain"], { timeoutMs: 8000 });
  if (!r.ok) return { fuera: [], tocoDeclarados: null };
  const declared = new Set(step.archivos);
  const changed = parsePorcelain(r.stdout);
  const fuera = [...changed].filter((f) => !declared.has(f));
  const tocoDeclarados = [...declared].some((f) => changed.has(f));
  return { fuera, tocoDeclarados };
}

// Ejecuta paso + su verificacion. Falla si el paso o su verify fallan, O si el
// paso declaro archivos y no toco NINGUNO (no-op silencioso: deja imports rotos
// para los pasos que dependen de el). Escape hatch: COUNCIL_ALLOW_NOOP=1.
async function runStepAndVerify(step, repo, options, isGit, doVerify) {
  const exec = await executeStep(step, repo, options);
  const v = doVerify ? await runVerify(step.verify, repo, options) : { verify: null };
  const enf = await enforceDeclaredFiles(step, repo, isGit);
  const allowNoop = process.env.COUNCIL_ALLOW_NOOP === "1";
  const noEdit = enf.tocoDeclarados === false && !allowNoop;
  const ok = exec.ok && (v.verify ? v.verify.ok : true) && !noEdit;
  return { ...exec, ...v, ...enf, archivos: step.archivos, noEdit, ok };
}

// --------------------------------------------------------------------------- //
//  Comandos                                                                    //
// --------------------------------------------------------------------------- //
async function doctor(args) {
  const tools = ["codex", "claude", "kimi", "gemini", "node"];
  const checks = [];
  for (const tool of tools) {
    const exists = await commandExists(tool);
    const version = exists ? await runProcess(tool, ["--version"], { timeoutMs: 15_000 }) : null;
    const check = {
      tool, exists, ok: exists && version?.ok,
      version: version?.stdout.trim() || version?.stderr.trim() || null,
    };
    if (tool === "kimi") {
      check.authenticated = kimiConfigured();
      if (check.ok && !check.authenticated) {
        check.ok = false;
        check.note = "instalado pero SIN login: corre `kimi login` (device-code) y completa el flujo";
      }
    }
    if (tool === "gemini") {
      check.authenticated = geminiConfigured();
      if (check.ok && !check.authenticated) {
        check.ok = false;
        check.note = "instalado pero SIN login: corre `gemini`, elige 'Login with Google' (usa tu plan, no API key)";
      }
    }
    checks.push(check);
  }
  const result = { ok: checks.every((c) => c.ok), arbiter: "claude", projectRoot, checks };
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`council-dev ${VERSION}  (arbitro: Claude · ejecucion: reparto por fortalezas)`);
    for (const c of checks) {
      console.log(`${c.ok ? "OK " : "BAD"} ${c.tool}${c.version ? ` - ${c.version}` : ""}${c.note ? `  (${c.note})` : ""}`);
    }
  }
  return result.ok ? 0 : 1;
}

function printAgentSection(title, result) {
  console.log(`\n## ${title}`);
  console.log(result.text || result.stderr || "[sin salida]");
  if (!result.ok) {
    console.log(`\n[${result.agent || title} codigo ${result.code}${result.timedOut ? ", timeout" : ""}]`);
  }
}

// --------------------------------------------------------------------------- //
//  Costo / tokens                                                              //
// --------------------------------------------------------------------------- //
// Precios "equivalente API" (USD por 1M tokens) — referencia de magnitud. Con
// SUSCRIPCION tu costo marginal real es ~0 (pagas el plan fijo). Claude reporta
// su costo exacto; los demas se estiman.
const REFERENCE_PRICES = {
  claude: [15, 75],
  codex: [1.25, 10],
  kimi: [0.15, 2.5],
  gemini: [0.075, 0.30],
};

function extractUsage(agent, stdout) {
  const s = stdout || "";
  let inTok = 0, outTok = 0, cost = null, estimated = false;
  if (agent === "claude") {
    for (const line of s.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith("{") || !t.includes('"result"')) continue;
      try {
        const o = JSON.parse(t);
        if (o.type === "result") {
          const u = o.usage || {};
          inTok += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          outTok += (u.output_tokens || 0);
          if (typeof o.total_cost_usd === "number") cost = (cost || 0) + o.total_cost_usd;
        }
      } catch { /* */ }
    }
  } else if (agent === "codex") {
    let lastIn = 0, lastOut = 0;
    for (const line of s.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith("{") || !t.includes("token")) continue;
      try {
        const o = JSON.parse(t);
        const u = o.usage || o.info?.usage || o.msg?.usage;
        if (u && typeof u.input_tokens === "number") { lastIn = u.input_tokens; lastOut = u.output_tokens || 0; }
      } catch { /* */ }
    }
    inTok = lastIn; outTok = lastOut;
  } else {
    outTok = Math.round(s.length / 4); // estimacion gruesa por longitud
    estimated = true;
  }
  if (cost === null) {
    const [pin, pout] = REFERENCE_PRICES[agent] || [0, 0];
    cost = (inTok / 1e6) * pin + (outTok / 1e6) * pout;
    if (agent !== "claude") estimated = true;
  }
  return { inTok, outTok, cost, estimated };
}

function costoCommand(repo, args) {
  const runsDir = join(repo, ".council-dev", "runs");
  let files = [];
  try { files = readdirSync(runsDir).filter((f) => f.endsWith(".json")).sort(); } catch { /* */ }
  if (!files.length) { console.log(`No hay corridas en ${runsDir}`); return 1; }
  const d = JSON.parse(readFileSync(join(runsDir, files[files.length - 1]), "utf8"));

  const calls = [];
  for (const p of d.proposals || []) calls.push(p);
  for (const c of d.critiques || []) calls.push(c);
  if (d.directive) calls.push(d.directive);
  for (const e of d.ejecuciones || []) calls.push(e);

  const agg = {};
  for (const call of calls) {
    const agent = call.agent;
    if (!CLI_PROFILES[agent]) continue;
    const u = extractUsage(agent, call.stdout || "");
    const a = agg[agent] || (agg[agent] = { inTok: 0, outTok: 0, cost: 0, estimated: false });
    a.inTok += u.inTok; a.outTok += u.outTok; a.cost += u.cost; a.estimated = a.estimated || u.estimated;
  }

  const json = !!args.json;
  if (json) { console.log(JSON.stringify({ run: files[files.length - 1], task: d.task, agg }, null, 2)); return 0; }

  console.log(`\n💰 Costo de la última misión  (${files[files.length - 1].replace(".json", "")})`);
  console.log(`Tarea: ${(d.task || "").slice(0, 80)}\n`);
  console.log("Zord/CLI            Tokens in    Tokens out    Costo (ref API)");
  console.log("─".repeat(64));
  let totIn = 0, totOut = 0, totCost = 0, anyEst = false;
  for (const ag of ["claude", "codex", "kimi", "gemini"]) {
    const a = agg[ag]; if (!a) continue;
    totIn += a.inTok; totOut += a.outTok; totCost += a.cost; anyEst = anyEst || a.estimated;
    const z = CLI_PROFILES[ag].zord;
    const est = a.estimated ? " ~est" : "";
    console.log(`${(z + "/" + ag).padEnd(18)} ${String(a.inTok).padStart(10)} ${String(a.outTok).padStart(13)}   $${a.cost.toFixed(4)}${est}`);
  }
  console.log("─".repeat(64));
  console.log(`${"TOTAL".padEnd(18)} ${String(totIn).padStart(10)} ${String(totOut).padStart(13)}   $${totCost.toFixed(4)}`);
  console.log(`\nℹ️  Costo "equivalente API" de referencia. Con tus SUSCRIPCIONES el costo`);
  console.log(`   marginal real es ~$0 (pagas el plan fijo). Claude reporta costo exacto;`);
  console.log(`   Codex por tokens; Kimi/Gemini ${anyEst ? "ESTIMADO por longitud" : ""}.`);
  console.log(`   "Cupo restante por sesión" NO lo exponen las CLIs — míralo en cada panel/web.`);
  return 0;
}

// --------------------------------------------------------------------------- //
//  Actas de sesion + notificacion Telegram                                     //
// --------------------------------------------------------------------------- //
function listRuns(repo) {
  const dir = join(repo, ".council-dev", "runs");
  try { return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => join(dir, f)); }
  catch { return []; }
}

function snippet(text, n) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}

function decisionOf(directiveText) {
  const t = directiveText || "";
  const m = t.match(/##\s*Decision\b[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i);
  return (m ? m[1] : t).trim();
}

// Construye el "acta" legible de una corrida: quien opino que + conclusion.
function buildActa(d, { perZord = 350, decision = 1200 } = {}) {
  const lines = [];
  const kind = d.ejecuciones ? "MISION (construccion)" : d.critiques ? "CONSEJO (consenso)" : "PROPUESTAS";
  lines.push(`🦖 MEGAZORD — acta de sesion [${kind}]`);
  lines.push(`Tarea: ${snippet(d.task, 200)}`);
  lines.push("");
  lines.push("— OPINIONES (ronda 1) —");
  for (const p of d.proposals || []) {
    const z = CLI_PROFILES[p.agent]?.zord || p.agent;
    if (p.ok && (p.text || "").trim().length > 100) {
      lines.push(`✅ ${z}/${p.agent}: ${snippet(p.text, perZord)}`);
    } else {
      lines.push(`❌ ${z}/${p.agent}: NO participo (${snippet(p.text || p.stderr, 90) || "sin salida"})`);
    }
    lines.push("");
  }
  if (d.critiques?.length) {
    lines.push("— CRITICAS CRUZADAS (ronda 2) —");
    for (const p of d.critiques) {
      const z = CLI_PROFILES[p.agent]?.zord || p.agent;
      lines.push(p.ok && (p.text || "").trim().length > 100
        ? `✅ ${z}/${p.agent}: ${snippet(p.text, Math.floor(perZord * 0.7))}`
        : `❌ ${z}/${p.agent}: no critico`);
    }
    lines.push("");
  }
  if (d.directive?.text) {
    lines.push("— CONCLUSION DEL ARBITRO (Claude) —");
    lines.push(snippet(decisionOf(d.directive.text), decision));
    if (!d.ejecuciones) {
      const plan = extractPlan(d.directive.text);
      if (plan.length > 1 || (plan.length === 1 && plan[0].archivos.length)) {
        lines.push("");
        lines.push("— REPARTO PROPUESTO (aprueba con: megazord aprueba) —");
        for (const [i, paso] of plan.entries()) {
          const z = CLI_PROFILES[paso.owner]?.zord || paso.owner;
          lines.push(`${i + 1}. ${z}/${paso.owner} → ${snippet(paso.titulo, 55)} [${(paso.archivos || []).join(", ") || "sin archivos"}]`);
        }
      }
    }
  } else if (d.error) {
    lines.push(`⛔ Sin directriz: ${snippet(d.error, 200)}`);
  }
  if (d.ejecuciones?.length) {
    lines.push("");
    lines.push("— CONSTRUCCION —");
    for (const e of d.ejecuciones) {
      const z = CLI_PROFILES[e.owner]?.zord || e.owner;
      const v = e.verify ? (e.verify.ok ? " verify OK" : " verify FALLO") : "";
      const ne = e.noEdit ? " ⛔NO-EDITO" : "";
      lines.push(`${e.ok ? "✅" : "❌"} ${z}/${e.owner}: ${snippet(e.titulo, 60)}${v}${ne}`);
    }
  }
  return lines.join("\n");
}

// Resumen ejecutivo SENCILLO para Telegram: lo primero que lee Manuel en el
// celular. Lenguaje simple, sin jerga; el acta completa va despues.
function resumenSimple(d) {
  const esMision = !!d.ejecuciones;
  const L = [];
  L.push(esMision ? "🦖 MEGAZORD — MISIÓN TERMINADA" : "🦖 MEGAZORD — CONSEJO TERMINADO");
  L.push(`📌 Tema: ${snippet(d.task, 140)}`);
  const voz = (arr) => (arr || []).map((p) => {
    const z = CLI_PROFILES[p.agent]?.zord || p.agent;
    const okReal = p.ok && (p.text || "").trim().length > 100;
    return `${okReal ? "✅" : "❌"}${z}`;
  }).join(" ");
  if (d.proposals?.length) L.push(`👥 Voces: ${voz(d.proposals)}`);
  if (esMision) {
    const total = d.ejecuciones.length;
    const okN = d.ejecuciones.filter((e) => e.ok).length;
    L.push(`🔨 Construcción: ${okN}/${total} pasos OK${okN < total ? " ⚠️" : ""}`);
    for (const e of d.ejecuciones.filter((x) => !x.ok)) {
      const z = CLI_PROFILES[e.owner]?.zord || e.owner;
      L.push(`   ❌ falló: ${snippet(e.titulo, 50)} (${z}${e.noEdit ? " · no editó" : ""})`);
    }
  }
  if (d.directive?.text) {
    const dec = decisionOf(d.directive.text).replace(/[#*`>]/g, "").replace(/\s+/g, " ").trim();
    const frases = dec.split(/(?<=\.)\s+/).slice(0, 3).join(" ");
    L.push(`🧠 Conclusión: ${snippet(frases, 380)}`);
  } else if (d.error) {
    L.push(`⛔ Sin conclusión: ${snippet(d.error, 120)}`);
  }
  L.push(esMision
    ? (d.ejecuciones?.every((e) => e.ok) ? "➡️ Todo verde. Falta solo tu revisión final." : "➡️ Hay pasos fallidos: revisar antes de seguir.")
    : "➡️ Acta completa abajo 👇");
  return L.join("\n");
}

// Lo que se envia a Telegram: primero el resumen simple, luego el acta completa.
function mensajeTelegram(d) {
  return resumenSimple(d) + "\n\n" + "━".repeat(20) + "\n📜 ACTA COMPLETA\n" + "━".repeat(20) + "\n\n" + buildActa(d);
}

// Scorecard real por Zord: cuantos pasos, exito, noEdit — datos para asignar mejor.
function desempenoCommand(repo) {
  const runs = listRuns(repo);
  const stats = {}; let misiones = 0;
  for (const f of runs) {
    let d; try { d = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
    const ej = d.ejecuciones || [];
    if (!ej.length) continue;
    misiones += 1;
    for (const e of ej) {
      const o = e.owner || "?";
      const st = stats[o] || (stats[o] = { pasos: 0, ok: 0, noEdit: 0, recibioReasig: 0 });
      st.pasos += 1;
      if (e.ok) st.ok += 1;
      if (e.noEdit) st.noEdit += 1;
      if (e.reassignedFrom) st.recibioReasig += 1;
    }
  }
  const total = Object.values(stats).reduce((a, s) => a + s.pasos, 0);
  console.log(`\n📊 Desempeño por Zord — ${misiones} misión(es) en este repo\n`);
  if (!total) { console.log("(sin misiones con construcción aquí)"); return 0; }
  console.log("Zord/CLI            pasos    %   éxito  noEdit  recibió-reasignado");
  console.log("─".repeat(66));
  for (const [o, st] of Object.entries(stats).sort((a, b) => b[1].pasos - a[1].pasos)) {
    const z = CLI_PROFILES[o]?.zord || o;
    const pct = Math.round((100 * st.pasos) / total);
    const okPct = st.pasos ? Math.round((100 * st.ok) / st.pasos) : 0;
    console.log(`${(z + "/" + o).padEnd(18)} ${String(st.pasos).padStart(5)} ${String(pct).padStart(4)}% ${String(okPct).padStart(5)}% ${String(st.noEdit).padStart(6)} ${String(st.recibioReasig).padStart(10)}`);
  }
  console.log(`\nRegla sana: claude ≤40% de pasos. Si un Zord tiene éxito bajo o noEdit alto,`);
  console.log(`sus "manos" están rotas en este entorno (sandbox/auth) — arreglar antes de culpar al modelo.`);
  return 0;
}

function sesionCommand(repo, args) {
  const runs = listRuns(repo);
  if (!runs.length) { console.log("No hay sesiones grabadas en este repo."); return 1; }
  if (args.list) {
    console.log("Sesiones (mas reciente al final):");
    for (const r of runs.slice(-15)) console.log("  " + r.split("/").pop());
    return 0;
  }
  const idx = args.n ? Math.max(1, parseInt(args.n, 10)) : 1; // 1 = ultima
  const file = runs[runs.length - idx];
  if (!file) { console.log(`No existe la sesion #${idx} contando desde la ultima.`); return 1; }
  const d = JSON.parse(readFileSync(file, "utf8"));
  const full = !!args.full;
  console.log(`\n📜 ${file.split("/").pop()}\n`);
  console.log(buildActa(d, full ? { perZord: 4000, decision: 8000 } : {}));
  console.log(`\n(usa --full para el texto extendido, --list para ver sesiones, --n 2 para la penultima)`);
  return 0;
}

async function sesionTelegram(repo, args) {
  const runs = listRuns(repo);
  if (!runs.length) { console.log("No hay sesiones grabadas."); return 1; }
  const idx = args.n ? Math.max(1, parseInt(args.n, 10)) : 1;
  const file = runs[runs.length - idx];
  const d = JSON.parse(readFileSync(file, "utf8"));
  const ok = await notifyTelegram(mensajeTelegram(d));
  console.log(ok ? `📨 Acta de ${file.split("/").pop()} enviada a Telegram.` : "✗ No pude enviar (falta token o fallo la API).");
  return ok ? 0 : 1;
}

// Notificacion Telegram: usa el bot ya desplegado (@pixelmegaforcebot). Token en
// Token: env TELEGRAM_BOT_TOKEN o ~/.config/megazord/telegram-token.
// Chat: env TELEGRAM_CHAT_ID. Si falta cualquiera, la notificacion se omite en silencio.
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
function telegramToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN.trim();
  for (const p of [join(homedir(), ".config", "megazord", "telegram-token")]) {
    try { const t = readFileSync(p, "utf8").trim(); if (t) return t; } catch { /* */ }
  }
  return null;
}

async function notifyTelegram(text) {
  const token = telegramToken();
  if (!token || !TELEGRAM_CHAT_ID || process.env.COUNCIL_NOTIFY === "0") return false;
  const chunks = [];
  for (let i = 0; i < text.length; i += 3800) chunks.push(text.slice(i, i + 3800));
  try {
    for (const chunk of chunks.slice(0, 4)) { // max 4 mensajes por sesion
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: chunk, disable_web_page_preview: true }),
      });
      if (!res.ok) return false;
    }
    return true;
  } catch { return false; }
}

// Fase de ejecucion (plan -> gate -> olas -> verify). Compartida por 'execute'
// (consejo fresco) y 'ejecutar-plan' (reusa una directriz ya pagada).
async function executeFromConsensus(consensus, repo, args, options) {
  const pasos = extractPlan(consensus.directive.text).map(normalizeOwner);
  const fanout = !!args.fanout;
  const doVerify = !args["no-verify"];

  // Gate de plan (estructura). En fan-out exige archivos + verify.
  const gate = planGate(pasos, { fanout, requireVerify: fanout && doVerify });
  if (gate.collisions.length) {
    console.log(`\n⚠️ Colisiones de archivos (se serializan en olas): ${gate.collisions.join("; ")}`);
  }
  if (!gate.ok) {
    const file = writeRun(repo, "execute", { ...consensus, plan: pasos, gate });
    console.log(`\n⛔ Plan rechazado por el gate:\n - ${gate.errors.join("\n - ")}\nTranscripcion: ${file}`);
    return 1;
  }

  const zord = (o) => CLI_PROFILES[o]?.zord || o;
  console.log(`\nReparto: ${pasos.map((s) => `${zord(s.owner)}/${s.owner}:${(s.titulo || "paso").slice(0, 24)}`).join(" · ")}`);
  const isGit = await repoIsGit(repo);
  const ejecuciones = [];
  let aborted = false;

  if (fanout) {
    const waves = buildWaves(pasos);
    console.log(`🦖 Megazord en ${waves.length} ola(s) (cap ${MAX_PARALLEL} en paralelo)`);
    for (const [wi, wave] of waves.entries()) {
      console.log(`\n=== Ola ${wi + 1}/${waves.length} — ${wave.length} Zord(s) en paralelo ===`);
      const results = await Promise.all(
        wave.map((step) => runStepAndVerify(step, repo, options, isGit, doVerify))
      );
      for (const exec of results) {
        ejecuciones.push(exec);
        printAgentSection(`${exec.titulo} [${zord(exec.owner)}/${exec.owner}${exec.reassignedFrom ? ` ← ${exec.reassignedFrom}` : ""}]`, exec);
        if (exec.verify) console.log(`   ✔ verify: ${exec.verify.cmd} → ${exec.verify.ok ? "OK" : "FALLO"}`);
        if (exec.noEdit) console.log(`   ⛔ declaró archivos pero NO tocó ninguno (posible sandbox/edición fallida): ${exec.archivos?.join(", ") || ""}`);
        if (exec.fuera?.length) console.log(`   ⚠️ tocó archivos fuera de lo declarado: ${exec.fuera.join(", ")}`);
      }
      if (results.some((e) => !e.ok)) {
        console.log(`\n⛔ Ola ${wi + 1} con fallos. Gate cerrado: no abro la siguiente ola.`);
        aborted = true;
        break;
      }
    }
  } else {
    for (const [i, step] of pasos.entries()) {
      console.log(`\n→ Paso ${i + 1}/${pasos.length} [${zord(step.owner)}/${step.owner}] ${step.titulo || ""}`);
      const exec = await runStepAndVerify(step, repo, options, isGit, doVerify);
      ejecuciones.push(exec);
      printAgentSection(`paso ${i + 1} (${zord(exec.owner)}/${exec.owner}${exec.reassignedFrom ? ` ← ${exec.reassignedFrom}` : ""})`, exec);
      if (exec.verify) console.log(`   ✔ verify: ${exec.verify.cmd} → ${exec.verify.ok ? "OK" : "FALLO"}`);
      if (exec.noEdit) console.log(`   ⛔ declaró archivos pero NO tocó ninguno (posible sandbox/edición fallida): ${exec.archivos?.join(", ") || ""}`);
      if (!exec.ok) {
        console.log(`\n⛔ Paso ${i + 1} fallo. Detengo (no encadeno sobre un paso roto).`);
        aborted = true;
        break;
      }
    }
  }
  const file = writeRun(repo, "execute", { ...consensus, plan: pasos, fanout, ejecuciones, gate });
  console.log(`\nTranscripcion: ${file}`);
  if (await notifyTelegram(mensajeTelegram({ ...consensus, plan: pasos, ejecuciones }))) console.log("📨 Acta enviada a Telegram.");
  return !aborted && ejecuciones.every((e) => e.ok) ? 0 : 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || ["-h", "--help", "help"].includes(command)) {
    console.log(usage());
    return 0;
  }

  if (command === "doctor") return doctor(args);

  if (command === "selftest") return selftest();

  const repo = repoDir(args);
  if (!existsSync(repo)) throw new Error(`El repo no existe: ${repo}`);
  const options = { timeoutMs: timeoutMs(args) };

  if (command === "costo") return costoCommand(repo, args);
  if (command === "desempeno" || command === "stats") return desempenoCommand(repo);
  if (command === "sesion" || command === "actas") {
    return args.telegram ? sesionTelegram(repo, args) : sesionCommand(repo, args);
  }

  if (command === "propose") {
    const task = requireTask(args);
    const proposals = await firstRound(task, repo, options);
    const file = writeRun(repo, "propose", { task, repo, proposals });
    for (const p of proposals) printAgentSection(p.agent, p);
    console.log(`\nTranscripcion: ${file}`);
    return liveVoices(proposals).length >= 2 ? 0 : 1;
  }

  if (command === "consensus") {
    const task = requireTask(args);
    const result = await runConsensus(task, repo, options);
    const file = writeRun(repo, "consensus", result);
    if (result.error) {
      console.log(`\n${result.error}`);
    } else {
      printAgentSection("DIRECTRIZ FINAL (Arquitecto: Claude)", result.directive);
    }
    console.log(`\nTranscripcion: ${file}`);
    if (await notifyTelegram(mensajeTelegram(result))) console.log("📨 Acta enviada a Telegram.");
    return result.directive?.ok ? 0 : 1;
  }

  if (command === "execute") {
    const task = requireTask(args);
    if (!args.approve) throw new Error("Me niego a ejecutar sin --approve");
    const consensus = await runConsensus(task, repo, options);
    if (!consensus.directive) {
      const file = writeRun(repo, "execute", consensus);
      console.log(`\n${consensus.error}\nTranscripcion: ${file}`);
      return 1;
    }
    return executeFromConsensus(consensus, repo, args, options);
  }

  if (command === "ejecutar-plan" || command === "replan") {
    if (!args.approve) throw new Error("Me niego a ejecutar sin --approve");
    const runsList = listRuns(repo);
    const file = args.run ? args.run : runsList[runsList.length - 1];
    if (!file || !existsSync(file)) throw new Error("No encuentro la transcripcion (usa --run <ruta.json>)");
    const d = JSON.parse(readFileSync(file, "utf8"));
    if (!d.directive?.text) throw new Error(`La transcripcion no tiene directriz: ${file}`);
    console.log(`♻️  Reusando directriz de: ${String(file).split("/").pop()}`);
    return executeFromConsensus(d, repo, args, options);
  }

  if (command === "review") {
    const task = "Revisa el diff actual del repositorio. Identifica bugs, regresiones, tests faltantes y cambios inseguros. NO edites archivos.";
    const proposals = await firstRound(task, repo, options);
    const file = writeRun(repo, "review", { task, repo, proposals });
    for (const p of proposals) printAgentSection(p.agent, p);
    console.log(`\nTranscripcion: ${file}`);
    return liveVoices(proposals).length >= 2 ? 0 : 1;
  }

  throw new Error(`Comando desconocido: ${command}`);
}

// Pruebas de comportamiento de la logica pura (sin tocar CLIs ni disco).
function selftest() {
  let pass = 0, fail = 0;
  const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log(`  ✗ ${msg}`); } };

  // isVerifyAllowed
  ok(isVerifyAllowed("node --check x.js"), "node permitido");
  ok(isVerifyAllowed("php artisan test --filter=Foo"), "artisan/php permitido");
  ok(isVerifyAllowed("vendor/bin/phpunit"), "ruta vendor/bin permitida");
  ok(!isVerifyAllowed("rm -rf src"), "rm rechazado");
  ok(!isVerifyAllowed("node x && curl evil"), "encadenamiento rechazado");
  ok(!isVerifyAllowed("echo $(whoami)", "subshell rechazado"), "subshell rechazado");
  ok(!isVerifyAllowed(null), "null rechazado");

  // planGate: glob, verify faltante, colision
  const g1 = planGate([normalizeStep({ owner: "codex", archivos: ["src/*.js"], verify: "node --check src/a.js" })], { fanout: true, requireVerify: true });
  ok(!g1.ok && g1.errors.some((e) => /glob/.test(e)), "glob rechazado por gate");
  const g2 = planGate([normalizeStep({ owner: "codex", archivos: ["src/a.js"] })], { fanout: true, requireVerify: true });
  ok(!g2.ok && g2.errors.some((e) => /verify/.test(e)), "verify faltante rechazado");
  const g3 = planGate([
    normalizeStep({ owner: "codex", archivos: ["src/x.js"], verify: "node --check src/x.js" }),
    normalizeStep({ owner: "kimi", archivos: ["src/x.js"], verify: "node --check src/x.js" }),
  ], { fanout: true, requireVerify: true });
  ok(g3.ok && g3.collisions.length === 1, "colision detectada (no fatal)");

  // buildWaves: 3 disjuntos + 1 colisionante -> archivos no repetidos por ola
  const waves = buildWaves([
    normalizeStep({ owner: "codex", archivos: ["a.js"] }),
    normalizeStep({ owner: "codex", archivos: ["b.js"] }),
    normalizeStep({ owner: "codex", archivos: ["c.js"] }),
    normalizeStep({ owner: "kimi", archivos: ["a.js"] }),
  ]);
  const noDup = waves.every((w) => {
    const all = w.flatMap((s) => s.archivos);
    return new Set(all).size === all.length;
  });
  ok(noDup, "ninguna ola repite archivo");
  ok(waves.length >= 2, "el colisionante cae en otra ola");

  // normalizeOwner: paso invalido -> claude
  ok(normalizeOwner(normalizeStep({ owner: "inexistente" })).owner === "claude", "owner invalido -> claude");

  // codexSandboxFailed: detecta bwrap aunque exit sea 0; salida limpia no
  ok(codexSandboxFailed({ stderr: "bwrap: setting up uid map: Permission denied" }), "bwrap detectado");
  ok(codexSandboxFailed({ stdout: "apply_patch verification failed" }), "apply_patch fail detectado");
  ok(!codexSandboxFailed({ stdout: "cambios aplicados ok", stderr: "" }), "salida limpia no es fallo de sandbox");

  // parsePorcelain: modificados, untracked y renombrados (destino)
  const pp = parsePorcelain(" M src/a.js\n?? src/new.js\nR  old.js -> src/b.js\n");
  ok(pp.has("src/a.js") && pp.has("src/new.js") && pp.has("src/b.js") && pp.size === 3, "porcelain parsea M/??/rename");

  // resolveEditor: VPS con codex+gemini deshabilitados NO cae en codex
  const disabled = new Set(["codex", "gemini"]);
  ok(resolveEditor("codex", { disabled, kimiOk: true, geminiOk: false }) === "kimi", "codex disabled -> kimi");
  ok(resolveEditor("gemini", { disabled, kimiOk: false, geminiOk: false }) === "claude", "gemini disabled y kimi sin auth -> claude");
  ok(resolveEditor("kimi", { disabled: new Set(), kimiOk: true }) === "kimi", "kimi con auth se respeta");
  ok(resolveEditor("kimi", { disabled: new Set(), kimiOk: false }) === "codex", "kimi sin auth -> codex (fiable)");

  console.log(`selftest: ${pass} OK, ${fail} fallos`);
  return fail === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
