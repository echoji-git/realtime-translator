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
const unsupportedText = "이 브라우저는 크롬 전사를 지원하지 않음(크롬 앱에서 여세요)";

function installFakes() {
  window.__speech = { instances: [] };
  window.__wake = { requests: 0 };
  const wake = {
    request: async () => {
      window.__wake.requests += 1;
      return { release: async () => {} };
    }
  };
  try {
    Object.defineProperty(Navigator.prototype, "wakeLock", { configurable: true, get: () => wake });
  } catch (e) {
    try { navigator.wakeLock = wake; } catch (e2) {}
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
      this.started = true;
      if (this.onstart) this.onstart();
    }
    stop() { this.started = false; if (this.onend) this.onend(); }
    abort() { this.started = false; }
  }
  window.SpeechRecognition = FakeSpeech;
  window.webkitSpeechRecognition = FakeSpeech;
}

const browser = await puppeteer.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"]
});
const errors = [];
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 900, isMobile: true, hasTouch: true });
page.on("pageerror", (err) => errors.push(String(err)));
page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
await page.evaluateOnNewDocument(installFakes);
await page.goto(pageUrl, { waitUntil: "load" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "load" });

const version = await page.$eval("#devVersion", (node) => node.textContent);
if (version.indexOf("v1.042 (261115)") === -1) throw new Error(version);
const history = await page.$eval("#devHistory", (node) => node.textContent);
if (history.indexOf("v1.042(261115)") === -1) throw new Error("missing v1.042 history");
if (history.indexOf("v1.041(261115)") === -1) throw new Error("missing v1.041 history");
if (history.indexOf("v1.01(261114)") === -1 || history.indexOf("v1.04(261115)") === -1) {
  throw new Error("old history removed");
}
const historyTop = await page.$eval("#devHistory li", (node) => node.textContent);
if (historyTop.indexOf("v1.042(261115)") !== 0) throw new Error(historyTop);
if (await page.$("#cutFast")) throw new Error("빠른 자막 버튼이 남아 있음");

await page.evaluate(() => document.getElementById("menuBtn").click());
await page.evaluate(() => document.querySelector('#sidebar .fold[data-fold="models"] .fold-btn').click());
await page.waitForFunction(() => !document.getElementById("fold-models").hidden);

const options = await page.evaluate(() => {
  return Array.from(document.querySelectorAll("#asrRoute option")).map((opt) => ({
    value: opt.value,
    label: opt.textContent
  }));
});
const expectOptions = [
  ["gemini", "Gemini 음성"],
  ["pc", "PC API"],
  ["local", "기기 내"],
  ["chrome", "크롬 전사"],
  ["none", "연결 안 함"]
];
expectOptions.forEach((pair, index) => {
  if (!options[index] || options[index].value !== pair[0] || options[index].label !== pair[1]) {
    throw new Error("options " + JSON.stringify(options));
  }
});

await page.evaluate(() => {
  const sel = document.getElementById("asrRoute");
  sel.size = sel.options.length;
});
await page.$eval("#asrRoute", (node) => node.scrollIntoView({ block: "center" }));
await new Promise((r) => setTimeout(r, 200));
await (await page.$("#fold-models")).screenshot({ path: outDir + "/v1041-dropdown-chrome.png" });
await page.screenshot({ path: outDir + "/v1041-dropdown-chrome-390.png" });

await page.evaluate(() => {
  const sel = document.getElementById("asrRoute");
  sel.size = 1;
});
await page.select("#asrRoute", "chrome");
const selected = await page.evaluate(() => ({
  route: document.getElementById("asrRoute").value,
  label: document.querySelector("#asrRoute option:checked").textContent,
  asrApi: document.getElementById("asrApiRow").hidden,
  pc: document.getElementById("pcPanel").hidden,
  local: document.getElementById("localAsrRow").hidden,
  trApi: document.getElementById("trApiRow").hidden,
  trRoute: document.getElementById("trRoute").value,
  googleHidden: document.getElementById("fastGoogleHint").hidden,
  google: document.getElementById("fastGoogleHint").textContent,
  asrHint: document.getElementById("asrHint").textContent,
  banner: document.getElementById("fastBanner").textContent,
  mic: document.getElementById("micLevelHint").textContent,
  micDisabled: document.getElementById("micLevel").disabled,
  cutHidden: document.getElementById("cutOptionBlock").hidden,
  cutNoteHidden: document.getElementById("chromeCutNote").hidden,
  cutNote: document.getElementById("chromeCutNote").textContent,
  lineHidden: document.getElementById("chromeLineBlock").hidden,
  lineLabel: document.getElementById("chromeLineVal").textContent,
  beep: document.getElementById("chromeBeepHint").textContent,
  supportHidden: document.getElementById("chromeSupportHint").hidden
}));
if (selected.route !== "chrome" || selected.label !== "크롬 전사") throw new Error(JSON.stringify(selected));
if (!selected.asrApi || !selected.pc || !selected.local) throw new Error("asr fields still shown " + JSON.stringify(selected));
if (selected.trApi || selected.trRoute !== "gemini") throw new Error("translation hidden " + JSON.stringify(selected));
if (selected.googleHidden || selected.google.indexOf("구글 서버") === -1) throw new Error(selected.google);
if (selected.asrHint.indexOf("네 단어") === -1 || selected.asrHint.indexOf("0.45초") === -1) throw new Error(selected.asrHint);
if (selected.mic.indexOf("적용되지 않습니다") === -1 || !selected.micDisabled) throw new Error(selected.mic);
if (selected.banner.indexOf("크롬 전사") === -1 || selected.banner.indexOf("구글 서버") === -1) throw new Error(selected.banner);
if (!selected.cutHidden || selected.cutNoteHidden || selected.cutNote.indexOf("크롬 전사에서는 적용되지 않음") === -1) {
  throw new Error(selected.cutNote);
}
if (selected.lineHidden || selected.lineLabel.indexOf("쉬면 1.0초") === -1 || selected.beep.indexOf("띵 소리") === -1) {
  throw new Error(selected.lineLabel + " " + selected.beep);
}
if (!selected.supportHidden) throw new Error("unsupported hint shown on chrome");
await page.$eval("#fastGoogleHint", (node) => node.scrollIntoView({ block: "center" }));
await new Promise((r) => setTimeout(r, 200));
await (await page.$("#fold-models")).screenshot({ path: outDir + "/v1041-chrome-selected.png" });

await page.evaluate(() => document.querySelector('#sidebar .fold[data-fold="segment"] .fold-btn').click());
await page.waitForFunction(() => !document.getElementById("fold-segment").hidden);
await page.$eval("#chromeCutNote", (node) => node.scrollIntoView({ block: "center" }));
await new Promise((r) => setTimeout(r, 200));
await (await page.$("#fold-segment")).screenshot({ path: outDir + "/v1041-chrome-cut-note.png" });

await page.setViewport({ width: 1280, height: 900, isMobile: true, hasTouch: true });
await page.evaluate(() => document.querySelector('#sidebar .fold[data-fold="models"] .fold-btn').click());
await page.waitForFunction(() => !document.getElementById("fold-models").hidden);
await page.$eval("#asrRoute", (node) => node.scrollIntoView({ block: "center" }));
await new Promise((r) => setTimeout(r, 200));
await page.screenshot({ path: outDir + "/v1041-chrome-selected-1280.png" });
await page.setViewport({ width: 420, height: 900, isMobile: true, hasTouch: true });
await page.waitForFunction(() => !document.getElementById("fold-models").hidden);
await page.select("#trRoute", "pc");
await page.waitForFunction(() => !document.getElementById("trPcPanel").hidden);
const trKept = await page.evaluate(() => ({
  tr: !document.getElementById("trPcPanel").hidden,
  asr: document.getElementById("pcPanel").hidden,
  route: document.getElementById("asrRoute").value,
  hint: document.getElementById("trRouteHint").textContent
}));
if (!trKept.tr || !trKept.asr || trKept.route !== "chrome") throw new Error(JSON.stringify(trKept));
if (trKept.hint.indexOf("크롬 전사") === -1) throw new Error(trKept.hint);

await page.evaluate(() => document.getElementById("closeSide").click());
await page.evaluate(() => document.getElementById("micBtn").click());
const started = await page.evaluate(() => {
  const rec = window.__speech.instances.filter((item) => item.started).pop();
  return {
    n: window.__speech.instances.length,
    lang: rec && rec.lang,
    continuous: rec && rec.continuous,
    interim: rec && rec.interimResults,
    status: document.getElementById("statusText").textContent
  };
});
if (started.n < 1 || started.lang !== "ko-KR" || !started.continuous || !started.interim) {
  throw new Error("speech " + JSON.stringify(started));
}
if (started.status.indexOf("크롬 전사") === -1) throw new Error(started.status);
await page.evaluate(() => document.getElementById("micBtn").click());

await page.evaluate(() => {
  localStorage.setItem("rtb.settings.v1", JSON.stringify({
    asrRoute: "local",
    localAsr: "whisper",
    cutMode: "fast",
    trRoute: "gemini",
    lang1: "ja",
    lang2: "en"
  }));
});
await page.reload({ waitUntil: "load" });
const migrated = await page.evaluate(() => {
  const saved = JSON.parse(localStorage.getItem("rtb.settings.v1") || "{}");
  return {
    route: document.getElementById("asrRoute").value,
    savedRoute: saved.asrRoute,
    savedCut: saved.cutMode,
    lang: document.getElementById("lang1").value,
    localHidden: document.getElementById("localAsrRow").hidden,
    hintHidden: document.getElementById("chromeSupportHint").hidden
  };
});
if (migrated.route !== "chrome" || migrated.savedRoute !== "chrome" || migrated.savedCut !== "overlap") {
  throw new Error("migrate " + JSON.stringify(migrated));
}
if (migrated.lang !== "ja" || !migrated.localHidden || !migrated.hintHidden) {
  throw new Error("migrate ui " + JSON.stringify(migrated));
}

const bare = await browser.newPage();
await bare.setViewport({ width: 420, height: 900 });
bare.on("pageerror", (err) => errors.push("bare " + String(err)));
await bare.evaluateOnNewDocument(() => {
  Object.defineProperty(window, "SpeechRecognition", { configurable: true, writable: true, value: undefined });
  Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, writable: true, value: undefined });
});
await bare.goto(pageUrl, { waitUntil: "load" });
await bare.evaluate(() => localStorage.clear());
await bare.reload({ waitUntil: "load" });
const speechGone = await bare.evaluate(() => typeof window.SpeechRecognition === "function" || typeof window.webkitSpeechRecognition === "function");
if (speechGone) throw new Error("speech api still present");
await bare.evaluate(() => {
  document.getElementById("menuBtn").click();
  document.querySelector('#sidebar .fold[data-fold="models"] .fold-btn').click();
});
await bare.waitForFunction(() => !document.getElementById("fold-models").hidden);
const optionVisible = await bare.$eval("#asrRoute option[value='chrome']", (node) => node.textContent);
if (optionVisible !== "크롬 전사") throw new Error(optionVisible);
const before = await bare.$eval("#asrRoute", (node) => node.value);
await bare.select("#asrRoute", "chrome");
const picked = await bare.evaluate(() => ({
  route: document.getElementById("asrRoute").value,
  hint: document.getElementById("chromeSupportHint").textContent,
  toast: document.getElementById("toast").textContent,
  hidden: document.getElementById("chromeSupportHint").hidden
}));
if (picked.route !== before || picked.hint !== unsupportedText || picked.toast !== unsupportedText || picked.hidden) {
  throw new Error("pick " + JSON.stringify(picked));
}

await bare.evaluate(() => {
  localStorage.setItem("rtb.settings.v1", JSON.stringify({
    asrRoute: "chrome",
    cutMode: "overlap",
    trRoute: "gemini"
  }));
});
await bare.reload({ waitUntil: "load" });
const loadedChrome = await bare.evaluate(() => {
  const saved = JSON.parse(localStorage.getItem("rtb.settings.v1") || "{}");
  return {
    route: document.getElementById("asrRoute").value,
    savedRoute: saved.asrRoute,
    hint: document.getElementById("chromeSupportHint").textContent,
    toast: document.getElementById("toast").textContent,
    option: document.querySelector("#asrRoute option[value='chrome']").textContent
  };
});
if (loadedChrome.route !== "gemini" || loadedChrome.savedRoute !== "gemini") {
  throw new Error("load chrome " + JSON.stringify(loadedChrome));
}
if (loadedChrome.hint !== unsupportedText || loadedChrome.toast !== unsupportedText || loadedChrome.option !== "크롬 전사") {
  throw new Error("load chrome notice " + JSON.stringify(loadedChrome));
}

await bare.evaluate(() => {
  localStorage.setItem("rtb.settings.v1", JSON.stringify({
    asrRoute: "pc",
    cutMode: "fast",
    trRoute: "gemini",
    pcBase: "https://desktop-ooi8v89.tail5025b3.ts.net"
  }));
});
await bare.reload({ waitUntil: "load" });
const loadedFast = await bare.evaluate(() => {
  const saved = JSON.parse(localStorage.getItem("rtb.settings.v1") || "{}");
  return {
    route: document.getElementById("asrRoute").value,
    savedRoute: saved.asrRoute,
    savedCut: saved.cutMode,
    hint: document.getElementById("chromeSupportHint").textContent,
    toast: document.getElementById("toast").textContent
  };
});
if (loadedFast.route !== "pc" || loadedFast.savedRoute !== "pc" || loadedFast.savedCut !== "overlap") {
  throw new Error("load fast " + JSON.stringify(loadedFast));
}
if (loadedFast.hint !== unsupportedText || loadedFast.toast !== unsupportedText) {
  throw new Error("load fast notice " + JSON.stringify(loadedFast));
}

const realErrors = errors.filter((line) => line.indexOf("favicon") === -1 && line.indexOf("404") === -1);
if (realErrors.length) throw new Error(realErrors.join("\n"));

console.log("page v1.041 tests ok");
console.log(JSON.stringify({ version, options, selected: { route: selected.route, cutNote: selected.cutNote }, started, migrated, picked, loadedChrome, loadedFast }, null, 2));
await browser.close();
server.close();
