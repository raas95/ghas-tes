#!/usr/bin/env node
// Ubah hasil SARIF CodeQL jadi JSON detail per temuan, lalu POST ke WEBHOOK_URL.
// Dipanggil dari workflow CodeQL: node codeql_to_webhook.js <folder-sarif>
// Env dari GitHub Actions: GITHUB_* (otomatis). Env tambahan: WEBHOOK_URL, LANGUAGE.
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SNIPPET_CONTEXT = 3; // jumlah baris sebelum/sesudah baris rentan
const HTTP_TIMEOUT_MS = 20000;
const env = process.env;
const WORKSPACE = fs.realpathSync(env.GITHUB_WORKSPACE || ".");
const SERVER = env.GITHUB_SERVER_URL || "https://github.com";
const REPO = env.GITHUB_REPOSITORY || "";
const SHA = env.GITHUB_SHA || "";
const DOCS_LANG = { py: "python", js: "javascript", java: "java", go: "go",
  rb: "ruby", cs: "csharp", cpp: "cpp", swift: "swift" };
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };

const log = (msg, level = "notice") => console.log(`::${level}::${msg}`);

function severityLabel(score) {
  const n = parseFloat(score);
  if (Number.isNaN(n)) return "unknown";
  if (n >= 9) return "critical";
  if (n >= 7) return "high";
  if (n >= 4) return "medium";
  return "low";
}

const fileCache = new Map();
// Baca file repo secara aman (tidak boleh keluar dari workspace).
function readLines(uri) {
  if (fileCache.has(uri)) return fileCache.get(uri);
  let lines = null;
  try {
    const full = fs.realpathSync(path.join(WORKSPACE, uri));
    if (full.startsWith(WORKSPACE + path.sep)) {
      lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
    }
  } catch (e) {
    log(`Gagal baca ${uri}: ${e.message}`, "warning");
  }
  fileCache.set(uri, lines);
  return lines;
}

function location(loc) {
  const pl = (loc && loc.physicalLocation) || {};
  const region = pl.region || {};
  const uri = (pl.artifactLocation || {}).uri || null;
  const start = region.startLine ?? null;
  return {
    file: uri,
    start_line: start,
    end_line: region.endLine ?? start,
    start_column: region.startColumn ?? null,
    end_column: region.endColumn ?? null,
    link: uri && start ? `${SERVER}/${REPO}/blob/${SHA}/${uri}#L${start}` : null,
  };
}

function codeAt(loc) {
  const lines = loc.file ? readLines(loc.file) : null;
  if (!lines || !loc.start_line) return null;
  return lines.slice(loc.start_line - 1, loc.end_line).join("\n");
}

function snippet(loc) {
  const lines = loc.file ? readLines(loc.file) : null;
  if (!lines || !loc.start_line) return null;
  const lo = Math.max(1, loc.start_line - SNIPPET_CONTEXT);
  const hi = Math.min(lines.length, loc.end_line + SNIPPET_CONTEXT);
  const out = [];
  for (let n = lo; n <= hi; n++) {
    const mark = n >= loc.start_line && n <= loc.end_line ? ">" : " ";
    out.push(`${mark} ${String(n).padStart(4)} | ${lines[n - 1]}`);
  }
  return { start_line: lo, end_line: hi, code: out.join("\n") };
}

// Ganti '[teks](id)' di pesan CodeQL dengan 'teks (file:baris)'.
function resolveMessage(result) {
  const related = new Map((result.relatedLocations || []).map((r) => [r.id, location(r)]));
  const text = (result.message || {}).text || "";
  return text.replace(/\[([^\]]+)\]\((\d+)\)/g, (_, label, id) => {
    const loc = related.get(Number(id));
    return loc ? `${label} (${loc.file}:${loc.start_line})` : label;
  });
}

// Jalur data dari sumber (input user) ke sink (titik rentan).
function dataFlow(result) {
  const flows = result.codeFlows || [];
  if (!flows.length) return null;
  const steps = ((flows[0].threadFlows || [])[0] || {}).locations || [];
  return steps.map((step, i) => {
    const loc = location(step.location);
    const role = i === 0 ? "source" : i === steps.length - 1 ? "sink" : "step";
    return {
      step: i + 1,
      role,
      note: ((step.location || {}).message || {}).text || null,
      ...loc,
      code: codeAt(loc),
    };
  });
}

function commitInfo() {
  const info = { sha: SHA };
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%B"],
      { cwd: WORKSPACE, encoding: "utf8", timeout: 10000 });
    const [sha, name, email, date, ...msg] = out.split("\x1f");
    Object.assign(info, { sha, author_name: name, author_email: email,
      authored_at: date, message: msg.join("\x1f").trim() });
  } catch (e) {
    log(`Gagal ambil info commit: ${e.message}`, "warning");
  }
  info.url = `${SERVER}/${REPO}/commit/${info.sha}`;
  return info;
}

// Siapa yang memicu scan: pusher (push) atau pembuat PR (pull_request).
function triggerInfo() {
  const info = {
    event: env.GITHUB_EVENT_NAME || null,
    actor: env.GITHUB_ACTOR || null,
    triggering_actor: env.GITHUB_TRIGGERING_ACTOR || null,
    ref: env.GITHUB_REF || null,
  };
  let event;
  try {
    event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  } catch (e) {
    log(`Gagal baca event payload: ${e.message}`, "warning");
    return info;
  }
  if (event.pusher) {
    info.pusher = event.pusher;
    info.compare_url = event.compare || null;
  }
  const pr = event.pull_request;
  if (pr) {
    info.pull_request = {
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      author: (pr.user || {}).login,
      head_branch: (pr.head || {}).ref,
      head_sha: (pr.head || {}).sha,
      base_branch: (pr.base || {}).ref,
    };
  }
  return info;
}

function buildFindings(sarifDir) {
  const files = fs.readdirSync(sarifDir).filter((f) => f.endsWith(".sarif")).sort();
  if (!files.length) throw new Error(`Tidak ada file .sarif di ${sarifDir}`);
  const findings = [];
  for (const file of files) {
    const sarif = JSON.parse(fs.readFileSync(path.join(sarifDir, file), "utf8"));
    for (const run of sarif.runs || []) {
      const tool = run.tool || {};
      const rules = new Map();
      for (const comp of [tool.driver || {}, ...(tool.extensions || [])]) {
        for (const rule of comp.rules || []) rules.set(rule.id, rule);
      }
      for (const r of run.results || []) {
        const ruleId = r.ruleId || (r.rule || {}).id;
        const rule = rules.get(ruleId) || {};
        const props = rule.properties || {};
        const tags = props.tags || [];
        const score = props["security-severity"] ?? null;
        const loc = location((r.locations || [])[0]);
        const prefix = (ruleId || "").split("/")[0];
        const docs = DOCS_LANG[prefix]
          ? `https://codeql.github.com/codeql-query-help/${DOCS_LANG[prefix]}/${ruleId.replace(/\//g, "-")}/`
          : null;
        const help = rule.help || {};
        findings.push({
          rule_id: ruleId,
          title: (rule.shortDescription || {}).text || ruleId,
          severity: severityLabel(score),
          security_severity_score: score,
          level: r.level || (rule.defaultConfiguration || {}).level || null,
          precision: props.precision || null,
          cwe: [...new Set(tags.filter((t) => t.startsWith("external/cwe/"))
            .map((t) => t.split("/").pop().toUpperCase()))].sort(),
          tags: tags.filter((t) => !t.startsWith("external/")),
          location: loc,
          vulnerable_code: codeAt(loc),
          snippet: snippet(loc),
          why: {
            message: resolveMessage(r),
            description: (rule.fullDescription || {}).text || null,
          },
          data_flow: dataFlow(r),
          how_to_fix: help.markdown || help.text || null,
          docs_url: rule.helpUri || docs,
          alerts_url: `${SERVER}/${REPO}/security/code-scanning?query=is%3Aopen+rule%3A${ruleId}`,
          fingerprint: (r.partialFingerprints || {}).primaryLocationLineHash || null,
        });
      }
    }
  }
  findings.sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    (a.location.file || "").localeCompare(b.location.file || "") ||
    (a.location.start_line || 0) - (b.location.start_line || 0));
  return findings;
}

async function main() {
  const sarifDir = process.argv[2] || "sarif-results";
  const findings = buildFindings(sarifDir);
  const bySeverity = {};
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;

  const payload = {
    event: "code_scanning_result",
    generated_at: new Date().toISOString(),
    repository: { name: REPO, url: `${SERVER}/${REPO}` },
    branch: env.GITHUB_REF_NAME || null,
    language: env.LANGUAGE || null,
    commit: commitInfo(),
    triggered_by: triggerInfo(),
    workflow: {
      name: env.GITHUB_WORKFLOW || null,
      run_id: env.GITHUB_RUN_ID || null,
      run_url: `${SERVER}/${REPO}/actions/runs/${env.GITHUB_RUN_ID}`,
    },
    summary: { total_findings: findings.length, by_severity: bySeverity },
    findings,
  };

  fs.writeFileSync("payload.json", JSON.stringify(payload, null, 2));
  log(`Total temuan: ${findings.length} ${JSON.stringify(bySeverity)}`);

  const url = env.WEBHOOK_URL;
  if (!url) {
    log("Secret WEBHOOK_URL belum di-set, skip kirim webhook", "warning");
    return 0;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "codeql-webhook" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      log(`Webhook gagal: HTTP ${res.status} - ${body}`, "error");
      return 1;
    }
    log(`Webhook terkirim, status ${res.status}`);
  } catch (e) {
    log(`Webhook gagal: ${e.message}`, "error");
    return 1;
  }
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    log(`Gagal memproses SARIF: ${e.name}: ${e.message}`, "error");
    console.error(e.stack);
    process.exitCode = 1;
  });
