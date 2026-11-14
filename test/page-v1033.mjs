import puppeteer from "puppeteer-core";
import { createServer } from "http";
import { readFile } from "fs/promises";
import { extname, join } from "path";

const root = new URL("..", import.meta.url).pathname;
const types = { ".html": "text/html", ".js": "text/javascript" };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = join(root, decodeURIComponent(url.pathname));
  try {
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch (e) {
    res.writeHead(404);
    res.end("missing");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/translator.html`;
const outDir = "/opt/cursor/artifacts";

const browser = await puppeteer.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"]
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1400 });
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
const dialogs = [];
let acceptNext = false;
page.on("dialog", async (dialog) => {
  dialogs.push(dialog.message());
  if (acceptNext) await dialog.accept();
  else await dialog.dismiss();
});

await page.evaluateOnNewDocument(() => {
  window.__calls = [];
  window.__mode = "ok";
  const orig = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.indexOf("/manager/") !== -1) {
      const record = { url: u, body: opts && opts.body ? String(opts.body) : "", headers: opts && opts.headers ? opts.headers : {} };
      window.__calls.push(record);
      if (window.__mode === "down") throw new Error("network");
      if (u.indexOf("/manager/status") !== -1) {
        return new Response(JSON.stringify({
          ok: true,
          sensevoice: { installed: false, note: "설치 필요" },
          vram: { used_mb: 1000, total_mb: 6144 }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = record.body ? JSON.parse(record.body) : {};
      if (body.engine === "sensevoice") {
        return new Response(JSON.stringify({
          ok: false,
          error: "설치 필요",
          sensevoice: { installed: false, note: "설치 필요" },
          files: { exists: false, need_install: true, name: "sensevoice" },
          ollama: { installed: true },
          vram: { used_mb: 1000, total_mb: 6144 },
          chunk_ms: null
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        ok: true,
        model: body.model,
        sensevoice: { installed: false, note: "설치 필요" },
        files: { exists: true, need_install: false, name: "ggml-base.bin" },
        ollama: { installed: true, need_install: false },
        vram: { used_mb: 1800, total_mb: 6144 },
        chunk_ms: 350
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return orig(url, opts);
  };
});

await page.goto(pageUrl, { waitUntil: "load" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "load" });

const defaults = await page.evaluate(() => ({
  version: document.getElementById("devVersion").textContent,
  asr: document.getElementById("asrRoute").value,
  tr: document.getElementById("trRoute").value,
  pcHidden: document.getElementById("pcPanel").hidden,
  mic: document.getElementById("micLevel").value,
  engine: document.getElementById("pcEngine").value,
  size: document.getElementById("pcSize").value,
  trSize: document.getElementById("pcTrSize").value,
  hint: document.getElementById("pcModelHint").textContent
}));
if (defaults.version.indexOf("v1.033") === -1) throw new Error("version " + defaults.version);
if (defaults.asr !== "gemini" || defaults.tr !== "gemini") throw new Error("default route " + JSON.stringify(defaults));
if (!defaults.pcHidden) throw new Error("pc panel should be hidden");
if (defaults.mic !== "mid" || defaults.engine !== "whisper" || defaults.size !== "base" || defaults.trSize !== "1b") {
  throw new Error("pc defaults " + JSON.stringify(defaults));
}
if (defaults.hint.indexOf("gemma3:1b") === -1) throw new Error(defaults.hint);

await page.evaluate(() => {
  document.getElementById("menuBtn").click();
  document.querySelector('#sidebar .fold[data-fold="models"] .fold-btn').click();
});
await page.waitForFunction(() => document.getElementById("sidebar").classList.contains("open") && !document.getElementById("fold-models").hidden);
await (await page.$("#fold-models")).screenshot({ path: outDir + "/settings-default-v1033.png" });
await page.select("#asrRoute", "pc");
await page.$eval("#pcBase", (node) => { node.value = "https://pc.example.ts.net"; node.dispatchEvent(new Event("input", { bubbles: true })); });
await page.$eval("#pcKey", (node) => { node.value = "secret-key"; node.dispatchEvent(new Event("input", { bubbles: true })); });
await page.waitForFunction(() => document.getElementById("pcSenseNote").textContent === "설치 필요" && !document.getElementById("pcSenseNote").hidden);
const shown = await page.evaluate(() => ({
  hidden: document.getElementById("pcPanel").hidden,
  labels: ["pcBase", "pcKey", "pcEngine", "pcSize", "pcTrSize", "pcApplyBtn"].map((id) => !!document.getElementById(id)),
  sense: document.getElementById("pcEngine").querySelector('option[value="sensevoice"]').textContent
}));
if (shown.hidden || shown.labels.some((ok) => !ok)) throw new Error("panel " + JSON.stringify(shown));
if (shown.sense.indexOf("설치 필요") === -1) throw new Error(shown.sense);
await page.$eval("#fold-models", (node) => node.scrollIntoView());
await (await page.$("#fold-models")).screenshot({ path: outDir + "/settings-pc-v1033.png" });

const before = await page.evaluate(() => window.__calls.length);
await page.evaluate(() => document.getElementById("pcApplyBtn").click());
await page.waitForFunction(() => document.getElementById("pcApplyNote").textContent.indexOf("조각당 시간: 350 ms") !== -1);
await (await page.$("#fold-models")).screenshot({ path: outDir + "/settings-pc-applied-v1033.png" });
const applied = await page.evaluate(() => {
  const call = window.__calls.filter((item) => item.url.indexOf("/manager/apply") !== -1).pop();
  return {
    note: document.getElementById("pcApplyNote").textContent,
    call: call,
    saved: JSON.parse(localStorage.getItem("rtb.settings.v1"))
  };
});
if (applied.note.indexOf("모델 파일: 있음") === -1 || applied.note.indexOf("1800 / 6144") === -1) throw new Error(applied.note);
if (!applied.call || JSON.parse(applied.call.body).model !== "gemma3:1b") throw new Error(JSON.stringify(applied.call));
if (applied.call.headers["X-RTB-Key"] !== "secret-key") throw new Error(JSON.stringify(applied.call.headers));
if (applied.saved.pcBase !== "https://pc.example.ts.net" || applied.saved.pcKey !== "secret-key") throw new Error(JSON.stringify(applied.saved));

await page.select("#pcTrSize", "4b");
await page.select("#pcSize", "turbo");
const callsAtWarn = await page.evaluate(() => window.__calls.length);
await page.evaluate(() => document.getElementById("pcApplyBtn").click());
await new Promise((r) => setTimeout(r, 200));
const afterDismiss = await page.evaluate(() => window.__calls.length);
if (afterDismiss !== callsAtWarn) throw new Error("dismiss still applied " + afterDismiss);
if (!dialogs.some((text) => text.indexOf("6GB") !== -1 && text.indexOf("turbo") !== -1)) throw new Error(dialogs.join(" | "));
acceptNext = true;
await page.evaluate(() => document.getElementById("pcApplyBtn").click());
await page.waitForFunction(() => {
  const calls = window.__calls.filter((item) => item.url.indexOf("/manager/apply") !== -1);
  const last = calls[calls.length - 1];
  return last && JSON.parse(last.body).model === "gemma3:4b" && JSON.parse(last.body).size === "turbo";
});

await page.select("#pcSize", "base");
await page.select("#pcTrSize", "1b");
await page.evaluate(() => { window.__mode = "down"; });
await page.$eval("#pcBase", (node) => { node.value = "https://down.example.ts.net"; });
await page.evaluate(() => document.getElementById("pcApplyBtn").click());
await page.waitForFunction(() => document.getElementById("pcApplyNote").textContent === "데스크톱 설정은 직접 바꿔야 함");
const savedDown = await page.evaluate(() => JSON.parse(localStorage.getItem("rtb.settings.v1")).pcBase);
if (savedDown !== "https://down.example.ts.net") throw new Error(savedDown);

await page.evaluate(() => { window.__mode = "ok"; });
await page.select("#pcEngine", "sensevoice");
await page.evaluate(() => document.getElementById("pcApplyBtn").click());
await page.waitForFunction(() => document.getElementById("pcApplyNote").textContent === "설치 필요");
await (await page.$("#fold-models")).screenshot({ path: outDir + "/settings-pc-result-v1033.png" });

await page.select("#asrRoute", "gemini");
const hiddenAgain = await page.$eval("#pcPanel", (node) => node.hidden);
if (!hiddenAgain) throw new Error("panel stayed open");
await page.select("#trRoute", "pc");
const trShows = await page.$eval("#pcPanel", (node) => node.hidden);
if (trShows) throw new Error("translation pc should show panel");
await page.select("#trRoute", "gemini");

await page.evaluate(() => document.querySelector('#sidebar .fold[data-fold="segment"] .fold-btn').click());
await page.waitForFunction(() => !document.getElementById("fold-segment").hidden);
await page.select("#micLevel", "high");
await page.evaluate(() => document.getElementById("saveSettingsBtn").click());
await (await page.$("#fold-segment")).screenshot({ path: outDir + "/settings-mic-v1033.png" });
await page.reload({ waitUntil: "load" });
const micSaved = await page.$eval("#micLevel", (node) => node.value);
if (micSaved !== "high") throw new Error("mic not saved " + micSaved);

const cleaned = await page.evaluate(() => {
  const core = window.RtbClean;
  const prompt = core.geminiTranslatePrompt({
    srcLang: "en", targetLang: "ko", glossary: "", recentLines: [], srcText: "hello"
  });
  const text = core.cleanModelOutput("안녕\n용어집: 남음\n이번 회의에서 방금 확정된 원문: (없음)\n끝");
  const loud = new Float32Array(1600);
  const quiet = new Float32Array(1600);
  for (let i = 0; i < 1600; i++) {
    loud[i] = 0.9 * Math.sin((2 * Math.PI * 440 * i) / 16000);
    quiet[i] = 0.04 * Math.sin((2 * Math.PI * 440 * i) / 16000);
  }
  const mid = core.applyMicLevel(loud, "mid");
  const low = core.applyMicLevel(loud, "low");
  const high = core.applyMicLevel(quiet, "high");
  return {
    promptHasEmptyGlossary: prompt.split("\n").some((line) => line.trim().indexOf("용어집:") === 0),
    promptHasNone: prompt.indexOf("이번 회의에서 방금 확정된 원문: (없음)") !== -1,
    cleaned: text,
    same: mid === loud,
    lowPeak: core.pcmPeak(low),
    highRatio: core.pcmRms(high) / core.pcmRms(quiet),
    highPeak: core.pcmPeak(high)
  };
});
if (cleaned.promptHasEmptyGlossary || cleaned.promptHasNone) throw new Error(JSON.stringify(cleaned));
if (cleaned.cleaned !== "안녕\n끝") throw new Error(cleaned.cleaned);
if (!cleaned.same || cleaned.lowPeak > 0.6 || cleaned.highRatio < 1.9 || cleaned.highPeak > 1) {
  throw new Error(JSON.stringify(cleaned));
}
const realErrors = errors.filter((line) => line.indexOf("favicon") === -1 && line.indexOf("404") === -1);
if (realErrors.length) throw new Error(realErrors.join("\n"));

console.log("page tests ok");
console.log(JSON.stringify({ defaults, applied: applied.note, dialogs, cleaned }, null, 2));
await browser.close();
server.close();
