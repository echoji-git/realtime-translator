import puppeteer from "puppeteer-core";
import { createServer } from "http";
import { readFile } from "fs/promises";
import { extname, join } from "path";
import { mkdir } from "fs/promises";

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
await mkdir(outDir, { recursive: true });
const DEFAULT_BASE = "https://desktop-ooi8v89.tail5025b3.ts.net";

const browser = await puppeteer.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"]
});

function installFakes() {
  window.__tr = [];
  window.__trAborted = 0;
  window.__trHold = false;
  window.__wake = { requests: 0, releases: 0, type: "", error: "" };
  window.__speech = { instances: [] };
  const wake = {
    request: async (type) => {
      window.__wake.requests += 1;
      window.__wake.type = type;
      return { release: async () => { window.__wake.releases += 1; } };
    }
  };
  try {
    Object.defineProperty(Navigator.prototype, "wakeLock", { configurable: true, get: () => wake });
  } catch (e) {
    window.__wake.error = String(e);
    try { navigator.wakeLock = wake; } catch (e2) { window.__wake.error += " " + e2; }
  }
  class FakeSpeech {
    constructor() {
      this.lang = "";
      this.continuous = false;
      this.interimResults = false;
      this.onresult = null;
      this.onend = null;
      this.onerror = null;
      this.onstart = null;
      this.started = false;
      window.__speech.instances.push(this);
    }
    start() {
      if (this.started) {
        const err = new Error("started");
        err.name = "InvalidStateError";
        throw err;
      }
      this.started = true;
      if (this.onstart) this.onstart();
    }
    stop() {
      this.started = false;
      if (this.onend) this.onend();
    }
    abort() {
      this.started = false;
      if (this.onerror) this.onerror({ error: "aborted" });
      if (this.onend) this.onend();
    }
    end() {
      this.started = false;
      if (this.onend) this.onend();
    }
  }
  window.SpeechRecognition = FakeSpeech;
  window.webkitSpeechRecognition = FakeSpeech;
  const orig = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const u = String(url);
    const watch = u.includes("generativelanguage.googleapis.com") || u.includes("/api/chat") || u.includes("/manager/");
    if (!watch) return orig(url, opts);
    const headers = {};
    const raw = opts && opts.headers ? opts.headers : {};
    Object.keys(raw).forEach((key) => { headers[key] = raw[key]; });
    window.__tr.push({ url: u, body: opts && opts.body ? String(opts.body) : "", headers });
    const reply = () => {
      if (u.includes("/manager/status")) {
        return new Response(JSON.stringify({ ok: true, sensevoice: { installed: true } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/manager/apply")) {
        return new Response(JSON.stringify({
          ok: true,
          files: { exists: true, name: "ggml-base.bin" },
          ollama: { installed: true },
          vram: { used_mb: 10, total_mb: 100 },
          chunk_ms: 20
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/api/chat")) {
        return new Response(JSON.stringify({ message: { content: "hello there" } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "{\"translation\":\"hello\"}" }] } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    if (window.__trHold && (u.includes("generativelanguage") || u.includes("/api/chat"))) {
      return new Promise((resolve, reject) => {
        const fail = () => {
          window.__trAborted += 1;
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (opts && opts.signal) {
          if (opts.signal.aborted) fail();
          else opts.signal.addEventListener("abort", fail);
        }
        window.__trRelease = () => resolve(reply());
      });
    }
    return Promise.resolve(reply());
  };
}

async function clickId(page, id) {
  await page.evaluate((id) => {
    const node = document.getElementById(id);
    if (!node) throw new Error("missing " + id);
    node.click();
  }, id);
}

async function emit(page, parts) {
  await page.evaluate((parts) => {
    const alive = window.__speech.instances.filter((item) => item.started);
    const rec = alive[alive.length - 1] || window.__speech.instances[window.__speech.instances.length - 1];
    const results = parts.map((part) => {
      const result = [{ transcript: part.text, confidence: 0.9 }];
      result.isFinal = !!part.final;
      result.length = 1;
      return result;
    });
    results.length = parts.length;
    rec.onresult({ resultIndex: 0, results });
  }, parts);
}

const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
await page.evaluateOnNewDocument(installFakes);
await page.goto(pageUrl, { waitUntil: "load" });
await page.evaluate(() => {
  localStorage.setItem("rtb.settings.v1", JSON.stringify({
    trKey: "test-key",
    trModel: "gemini-test",
    trModelIds: ["gemini-test"],
    lang1: "ko",
    lang2: "en",
    asrRoute: "gemini",
    trRoute: "gemini",
    cutMode: "overlap"
  }));
});
await page.reload({ waitUntil: "load" });

const version = await page.$eval("#devVersion", (node) => node.textContent);
if (version.indexOf("v1.04 (261115)") === -1) throw new Error(version);
const history = await page.$eval("#devHistory", (node) => node.textContent);
if (history.indexOf("v1.04(261115)") === -1) throw new Error(history);
const googleHint = await page.$eval("#fastGoogleHint", (node) => node.textContent);
if (googleHint.indexOf("구글 서버") === -1) throw new Error(googleHint);

await clickId(page, "menuBtn");
await page.evaluate(() => document.querySelector('#sidebar .fold[data-fold="segment"] .fold-btn').click());
await page.waitForFunction(() => !document.getElementById("fold-segment").hidden);
await page.$eval("#cutOverlap", (node) => node.scrollIntoView({ block: "center" }));
await clickId(page, "cutCut");
await clickId(page, "cutPause");
await clickId(page, "cutOverlap");
const overlapOn = await page.$eval("#cutOverlap", (node) => node.classList.contains("active"));
if (!overlapOn) throw new Error("overlap mode broken");

await clickId(page, "cutFast");
const fastUi = await page.evaluate(() => ({
  fast: document.getElementById("cutFast").classList.contains("active"),
  hint: document.getElementById("segmentHint").textContent,
  mic: document.getElementById("micLevelHint").textContent,
  google: document.getElementById("fastGoogleHint").textContent,
  banner: document.getElementById("fastBanner").textContent,
  bannerHidden: document.getElementById("fastBanner").hidden,
  segmentDisabled: document.getElementById("segment").disabled
}));
if (!fastUi.fast) throw new Error("fast not selected");
if (fastUi.hint.indexOf("언어1") === -1 || fastUi.hint.indexOf("네 단어") === -1) throw new Error(fastUi.hint);
if (fastUi.mic.indexOf("적용되지 않습니다") === -1) throw new Error(fastUi.mic);
if (fastUi.google.indexOf("구글") === -1) throw new Error(fastUi.google);
if (fastUi.bannerHidden || fastUi.banner.indexOf("마이크 입력 크기") === -1) throw new Error(fastUi.banner);
if (!fastUi.segmentDisabled) throw new Error("segment still enabled");
await page.$eval("#cutFast", (node) => node.scrollIntoView({ block: "center" }));
await new Promise((r) => setTimeout(r, 250));
await page.screenshot({ path: outDir + "/v104-settings-caption-390.png" });

await clickId(page, "closeSide");
await clickId(page, "micBtn");
const started = await page.evaluate(() => {
  const rec = window.__speech.instances[window.__speech.instances.length - 1];
  return {
    n: window.__speech.instances.length,
    continuous: rec.continuous,
    interim: rec.interimResults,
    lang: rec.lang,
    started: rec.started,
    wake: window.__wake.requests,
    wakeType: window.__wake.type,
    wakeError: window.__wake.error,
    mic: document.getElementById("micBtn").textContent
  };
});
if (started.n !== 1 || !started.continuous || !started.interim || started.lang !== "ko-KR" || !started.started) {
  throw new Error("recognition " + JSON.stringify(started));
}
if (started.wake < 1 || started.wakeType !== "screen") throw new Error("wake " + JSON.stringify(started));
if (started.mic.indexOf("끄기") === -1) throw new Error(started.mic);

await emit(page, [{ text: "오늘", final: false }]);
await emit(page, [{ text: "오늘 회의", final: false }]);
const growing = await page.evaluate(() => ({
  interim: (document.querySelector(".interim-word") || {}).textContent || "",
  calls: window.__tr.filter((item) => item.url.indexOf("generativelanguage") !== -1).length
}));
if (growing.interim !== "오늘 회의") throw new Error("interim " + growing.interim);
if (growing.calls !== 0) throw new Error("early translate " + growing.calls);
const batchStart = Date.now();
await emit(page, [{ text: "오늘 회의 시작합니다", final: false }]);
await new Promise((r) => setTimeout(r, 200));
const stillWaiting = await page.evaluate(() => window.__tr.filter((item) => item.url.indexOf("generativelanguage") !== -1).length);
if (stillWaiting !== 0) throw new Error("batched too early");
await page.waitForFunction(() => {
  return window.__tr.filter((item) => item.url.indexOf("generativelanguage") !== -1).length === 1
    && document.querySelector(".tgt")
    && document.querySelector(".tgt").textContent === "hello";
}, { timeout: 2500 });
const batchMs = Date.now() - batchStart;
if (batchMs < 400) throw new Error("batch waited only " + batchMs);
const batchedBody = await page.evaluate(() => window.__tr.filter((item) => item.url.indexOf("generativelanguage") !== -1)[0].body);
if (batchedBody.indexOf("오늘 회의 시작합니다") === -1) throw new Error(batchedBody);
await page.screenshot({ path: outDir + "/v104-fast-live-390.png" });

await emit(page, [{ text: "오늘 회의 시작합니다", final: true }]);
const locked = await page.evaluate(() => ({
  interim: document.querySelectorAll(".interim-word").length,
  src: document.querySelector(".src").textContent,
  calls: window.__tr.filter((item) => item.url.indexOf("generativelanguage") !== -1).length
}));
if (locked.interim !== 0) throw new Error("interim remained");
if (locked.src !== "오늘 회의 시작합니다") throw new Error(locked.src);
if (locked.calls !== 1) throw new Error("final resent " + locked.calls);

const beforeSentence = locked.calls;
const sentenceAt = Date.now();
await emit(page, [{ text: "다음 일정을 말씀드립니다.", final: true }]);
await page.waitForFunction((n) => window.__tr.filter((item) => item.url.indexOf("generativelanguage") !== -1).length > n, { timeout: 800 }, beforeSentence);
if (Date.now() - sentenceAt > 700) throw new Error("final sentence waited too long");

await page.evaluate(() => { window.__trHold = true; });
await emit(page, [{ text: "alpha beta gamma delta", final: false }]);
await page.waitForFunction(() => window.__tr.some((item) => item.body.indexOf("alpha beta gamma delta") !== -1));
await page.evaluate(() => { window.__trHold = false; });
await emit(page, [{ text: "alpha beta gamma delta epsilon zeta eta theta", final: true }]);
await page.waitForFunction(() => window.__trAborted >= 1, { timeout: 2000 });

const beforeEnd = await page.evaluate(() => window.__speech.instances.length);
await page.evaluate(() => {
  const alive = window.__speech.instances.filter((item) => item.started);
  alive[alive.length - 1].end();
});
await page.waitForFunction((n) => {
  const items = window.__speech.instances;
  return items.length > n && items[items.length - 1].started;
}, { timeout: 2000 }, beforeEnd);

await page.evaluate(() => {
  const rec = window.__speech.instances.filter((item) => item.started).pop();
  rec.onerror({ error: "no-speech" });
});
const noSpeech = await page.$eval("#statusText", (node) => node.textContent);
if (noSpeech.indexOf("말이 들리지 않아") === -1) throw new Error(noSpeech);

const beforeStop = await page.evaluate(() => window.__speech.instances.length);
await clickId(page, "micBtn");
await new Promise((r) => setTimeout(r, 700));
const afterStop = await page.evaluate(() => ({
  n: window.__speech.instances.length,
  started: window.__speech.instances.filter((item) => item.started).length,
  mic: document.getElementById("micBtn").textContent,
  released: window.__wake.releases
}));
if (afterStop.n !== beforeStop || afterStop.started !== 0) throw new Error("restarted after stop " + JSON.stringify(afterStop));
if (afterStop.mic !== "마이크") throw new Error(afterStop.mic);
if (afterStop.released < 1) throw new Error("wake not released");

await clickId(page, "micBtn");
await page.evaluate(() => {
  const rec = window.__speech.instances.filter((item) => item.started).pop();
  rec.onerror({ error: "not-allowed" });
  rec.end();
});
const denied = await page.$eval("#statusText", (node) => node.textContent);
if (denied.indexOf("마이크 사용이 거부") === -1) throw new Error(denied);
const deniedCount = await page.evaluate(() => window.__speech.instances.length);
await new Promise((r) => setTimeout(r, 700));
const deniedAfter = await page.evaluate(() => window.__speech.instances.length);
if (deniedAfter !== deniedCount) throw new Error("restarted after denial " + deniedAfter);

await page.evaluate(() => {
  const rec = window.__speech.instances[window.__speech.instances.length - 1];
  if (rec && rec.onerror) rec.onerror({ error: "network" });
  document.getElementById("toast").style.display = "none";
});
const network = await page.$eval("#toast", (node) => node.textContent);
if (network.indexOf("음성 인식 서버") === -1) throw new Error(network || "empty toast");

await clickId(page, "menuBtn");
await page.evaluate(() => document.querySelector('#sidebar .fold[data-fold="models"] .fold-btn').click());
await page.select("#asrRoute", "pc");
await page.waitForFunction(() => !document.getElementById("pcPanel").hidden);
const asrDefault = await page.evaluate(() => ({
  preset: document.getElementById("pcBasePreset").value,
  hidden: document.getElementById("pcBaseCustomRow").hidden,
  engine: !!document.getElementById("pcEngine"),
  apply: !!document.getElementById("pcApplyBtn")
}));
if (asrDefault.preset !== DEFAULT_BASE || !asrDefault.hidden || !asrDefault.engine || !asrDefault.apply) {
  throw new Error("asr address " + JSON.stringify(asrDefault));
}
await page.$eval("#pcBaseNote", (node) => node.scrollIntoView({ block: "center" }));
await new Promise((r) => setTimeout(r, 250));
await page.screenshot({ path: outDir + "/v104-settings-pc-asr-390.png" });
await page.select("#pcBasePreset", "__custom__");
await page.$eval("#pcBase", (node) => {
  node.value = "https://asr.example.ts.net";
  node.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.screenshot({ path: outDir + "/v104-settings-pc-custom-390.png" });

await page.select("#trRoute", "pc");
await page.waitForFunction(() => !document.getElementById("trPcPanel").hidden);
const trDefault = await page.evaluate(() => ({
  preset: document.getElementById("pcTrBasePreset").value,
  hidden: document.getElementById("pcTrBaseCustomRow").hidden,
  asrHidden: document.getElementById("pcPanel").hidden
}));
if (trDefault.preset !== DEFAULT_BASE || !trDefault.hidden || trDefault.asrHidden) throw new Error(JSON.stringify(trDefault));
await page.select("#pcTrBasePreset", "__custom__");
await page.$eval("#pcTrBase", (node) => {
  node.value = "https://tr.example.ts.net";
  node.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.$eval("#pcTrKey", (node) => {
  node.value = "tr-secret";
  node.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.$eval("#pcTrBase", (node) => node.scrollIntoView({ block: "center" }));
await page.screenshot({ path: outDir + "/v104-settings-pc-tr-390.png" });
await clickId(page, "saveSettingsBtn");
await clickId(page, "micBtn");
const chatBefore = await page.evaluate(() => window.__tr.length);
await emit(page, [{ text: "번역은 이 주소로 보냅니다.", final: true }]);
await page.waitForFunction((n) => window.__tr.length > n && window.__tr.some((item) => item.url.indexOf("https://tr.example.ts.net/api/chat") === 0), { timeout: 2000 }, chatBefore);
const chat = await page.evaluate(() => window.__tr.filter((item) => item.url.indexOf("/api/chat") !== -1).pop());
if (!chat || chat.headers["X-RTB-Key"] !== "tr-secret") throw new Error(JSON.stringify(chat));
if (chat.body.indexOf("번역은 이 주소로 보냅니다") === -1) throw new Error(chat.body);

const savedSplit = await page.evaluate(() => JSON.parse(localStorage.getItem("rtb.settings.v1")));
if (savedSplit.pcBase !== "https://asr.example.ts.net" || savedSplit.pcTrBase !== "https://tr.example.ts.net") {
  throw new Error(JSON.stringify({ pcBase: savedSplit.pcBase, pcTrBase: savedSplit.pcTrBase }));
}

await page.evaluate((base) => {
  localStorage.setItem("rtb.settings.v1", JSON.stringify({
    pcBase: "https://saved.example.ts.net",
    pcKey: "old-key",
    asrRoute: "pc",
    trRoute: "pc",
    trKey: "test-key",
    trModel: "gemini-test",
    trModelIds: ["gemini-test"]
  }));
  window.__savedBase = base;
}, DEFAULT_BASE);
await page.reload({ waitUntil: "load" });
const migrated = await page.evaluate((base) => ({
  asrPreset: document.getElementById("pcBasePreset").value,
  asrValue: document.getElementById("pcBase").value,
  asrHidden: document.getElementById("pcBaseCustomRow").hidden,
  trPreset: document.getElementById("pcTrBasePreset").value,
  trValue: document.getElementById("pcTrBase").value,
  trKey: document.getElementById("pcTrKey").value,
  base
}), DEFAULT_BASE);
if (migrated.asrPreset !== "__custom__" || migrated.asrValue !== "https://saved.example.ts.net" || migrated.asrHidden) {
  throw new Error("asr migrate " + JSON.stringify(migrated));
}
if (migrated.trPreset !== "__custom__" || migrated.trValue !== "https://saved.example.ts.net" || migrated.trKey !== "old-key") {
  throw new Error("tr migrate " + JSON.stringify(migrated));
}

await page.evaluate((base) => {
  localStorage.setItem("rtb.settings.v1", JSON.stringify({
    pcBase: base,
    asrRoute: "pc",
    trRoute: "gemini"
  }));
}, DEFAULT_BASE);
await page.reload({ waitUntil: "load" });
const sameDefault = await page.evaluate(() => ({
  preset: document.getElementById("pcBasePreset").value,
  hidden: document.getElementById("pcBaseCustomRow").hidden
}));
if (sameDefault.preset !== DEFAULT_BASE || !sameDefault.hidden) throw new Error(JSON.stringify(sameDefault));

const bare = await browser.newPage();
await bare.setViewport({ width: 390, height: 844 });
bare.on("pageerror", (err) => errors.push(String(err)));
await bare.evaluateOnNewDocument(() => {
  Object.defineProperty(window, "SpeechRecognition", { configurable: true, writable: true, value: undefined });
  Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, writable: true, value: undefined });
});
await bare.goto(pageUrl, { waitUntil: "load" });
await bare.evaluate(() => localStorage.clear());
await bare.reload({ waitUntil: "load" });
const hasSpeech = await bare.evaluate(() => typeof window.SpeechRecognition === "function" || typeof window.webkitSpeechRecognition === "function");
if (hasSpeech) throw new Error("speech api still present");
await clickId(bare, "menuBtn");
await bare.evaluate(() => document.querySelector('#sidebar .fold[data-fold="segment"] .fold-btn').click());
await bare.waitForFunction(() => !document.getElementById("fold-segment").hidden);
await clickId(bare, "cutFast");
const unsupported = await bare.evaluate(() => ({
  hint: document.getElementById("segmentHint").textContent,
  toast: document.getElementById("toast").textContent,
  fast: document.getElementById("cutFast").classList.contains("active"),
  overlap: document.getElementById("cutOverlap").classList.contains("active")
}));
if (unsupported.hint !== "이 브라우저는 빠른 자막을 지원하지 않음") throw new Error(unsupported.hint);
if (unsupported.toast !== "이 브라우저는 빠른 자막을 지원하지 않음") throw new Error(unsupported.toast);
if (unsupported.fast || !unsupported.overlap) throw new Error(JSON.stringify(unsupported));

const realErrors = errors.filter((line) => line.indexOf("favicon") === -1 && line.indexOf("404") === -1);
if (realErrors.length) throw new Error(realErrors.join("\n"));

console.log("page v1.04 tests ok");
console.log(JSON.stringify({ version, batchMs, started, migrated, unsupported }, null, 2));
await browser.close();
server.close();
