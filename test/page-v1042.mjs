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

const STEPS = [
  { step: 1, pause: "0.6", chars: 25 },
  { step: 2, pause: "0.8", chars: 35 },
  { step: 3, pause: "1.0", chars: 45 },
  { step: 4, pause: "1.3", chars: 60 },
  { step: 5, pause: "1.6", chars: 80 }
];

function installFakes() {
  window.__speech = { instances: [], starts: [] };
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
      window.__speech.starts.push(Date.now());
      if (this.onstart) this.onstart();
    }
    stop() { this.started = false; if (this.onend) this.onend(); }
    abort() { this.started = false; }
    end() { this.started = false; if (this.onend) this.onend(); }
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
if (version.indexOf("v1.043 (261115)") === -1) throw new Error(version);
const historyTop = await page.$eval("#devHistory li", (node) => node.textContent);
if (historyTop.indexOf("v1.043(261115)") !== 0) throw new Error(historyTop);
const history = await page.$eval("#devHistory", (node) => node.textContent);
if (history.indexOf("v1.042(261115)") === -1 || history.indexOf("v1.041(261115)") === -1) throw new Error("old history removed");

await page.evaluate(() => document.getElementById("menuBtn").click());
await page.evaluate(() => document.querySelector('#sidebar .fold[data-fold="models"] .fold-btn').click());
await page.waitForFunction(() => !document.getElementById("fold-models").hidden);
await page.select("#asrRoute", "chrome");
await page.evaluate(() => document.querySelector('#sidebar .fold[data-fold="segment"] .fold-btn').click());
await page.waitForFunction(() => !document.getElementById("fold-segment").hidden);

const initial = await page.evaluate(() => ({
  value: document.getElementById("chromeLine").value,
  label: document.querySelector("label[for='chromeLine']").textContent,
  hint: document.getElementById("chromeLineHint").textContent,
  beep: document.getElementById("chromeBeepHint").textContent,
  hidden: document.getElementById("chromeLineBlock").hidden,
  cutHidden: document.getElementById("cutOptionBlock").hidden
}));
if (initial.value !== "3" || initial.hidden || !initial.cutHidden) throw new Error(JSON.stringify(initial));
if (initial.label.indexOf("줄 길이") === -1 || initial.label.indexOf("쉬면 1.0초 · 최대 45자") === -1) {
  throw new Error(initial.label);
}
if (initial.beep !== "띵 소리는 안드로이드 크롬이 듣기를 다시 시작할 때 내는 소리라 페이지에서 끌 수 없음, 다시 시작을 줄였음") {
  throw new Error(initial.beep);
}
if (/[\u3400-\u9fff]/.test(initial.label + initial.hint + initial.beep)) throw new Error("hanja in chrome line copy");
await page.$eval("#chromeLine", (node) => node.scrollIntoView({ block: "center" }));
await new Promise((r) => setTimeout(r, 200));
await (await page.$("#fold-segment")).screenshot({ path: outDir + "/v1042-line-default.png" });

const seen = [];
for (const step of STEPS) {
  await page.evaluate((value) => {
    const input = document.getElementById("chromeLine");
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, step.step);
  const label = await page.$eval("#chromeLineVal", (node) => node.textContent);
  const expect = "쉬면 " + step.pause + "초 · 최대 " + step.chars + "자";
  if (label !== expect) throw new Error(step.step + " " + label);
  seen.push({ step: step.step, pauseMs: Number(step.pause) * 1000, chars: step.chars, label: label });
  if (step.step === 1) {
    await page.$eval("#chromeBeepHint", (node) => node.scrollIntoView({ block: "center" }));
    await new Promise((r) => setTimeout(r, 150));
    await (await page.$("#fold-segment")).screenshot({ path: outDir + "/v1042-line-step1.png" });
  }
}
await page.evaluate(() => {
  const input = document.getElementById("chromeLine");
  input.value = "1";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.evaluate(() => document.getElementById("saveSettingsBtn").click());
await page.reload({ waitUntil: "load" });
const savedLine = await page.evaluate(() => {
  const saved = JSON.parse(localStorage.getItem("rtb.settings.v1") || "{}");
  return {
    value: document.getElementById("chromeLine").value,
    label: document.getElementById("chromeLineVal").textContent,
    saved: saved.chromeLine,
    route: document.getElementById("asrRoute").value
  };
});
if (savedLine.value !== "1" || savedLine.saved !== 1 || savedLine.route !== "chrome") throw new Error(JSON.stringify(savedLine));
if (savedLine.label.indexOf("쉬면 0.6초 · 최대 25자") === -1) throw new Error(savedLine.label);

await page.evaluate(() => document.getElementById("menuBtn").click());
await page.evaluate(() => document.getElementById("closeSide").click());
await page.evaluate(() => document.getElementById("micBtn").click());
const started = await page.evaluate(() => window.__speech.starts.length);
if (started !== 1) throw new Error("starts " + started);

async function emit(parts) {
  await page.evaluate((parts) => {
    const alive = window.__speech.instances.filter((item) => item.started);
    const rec = alive[alive.length - 1];
    const results = parts.map((part) => {
      const result = [{ transcript: part.text, confidence: 0.9 }];
      result.isFinal = !!part.final;
      result.length = 1;
      return result;
    });
    results.length = parts.length;
    rec.onresult({ resultIndex: 0, results: results });
  }, parts);
}
async function lines() {
  return page.evaluate(() => Array.from(document.querySelectorAll("#transcript .src")).map((node) => node.textContent));
}

await emit([{ text: "짧은 문장", final: false }]);
await new Promise((r) => setTimeout(r, 280));
await emit([{ text: "짧은 문장 이어서", final: false }]);
const early = await lines();
if (early.length !== 1 || early[0].indexOf("이어서") === -1) throw new Error("early " + JSON.stringify(early));
const startsMid = await page.evaluate(() => window.__speech.starts.length);
await new Promise((r) => setTimeout(r, 850));
const afterPause = await lines();
const startsAfterPause = await page.evaluate(() => window.__speech.starts.length);
if (startsAfterPause !== startsMid) throw new Error("pause restarted " + startsAfterPause);
await emit([{ text: "다음 줄입니다", final: false }]);
const paused = await lines();
if (paused.length !== 2) throw new Error("pause split " + JSON.stringify(paused));
if (paused[0].indexOf("이어서") === -1 || paused[1].indexOf("다음 줄") === -1) throw new Error(JSON.stringify(paused));
const startsAfterLine = await page.evaluate(() => window.__speech.starts.length);
if (startsAfterLine !== startsMid) throw new Error("line break called start " + startsAfterLine);

await page.evaluate(() => document.getElementById("micBtn").click());
await new Promise((r) => setTimeout(r, 200));
await page.evaluate(() => document.getElementById("micBtn").click());
await page.waitForFunction((n) => window.__speech.starts.length > n, { timeout: 1000 }, startsAfterLine);
const startsFresh = await page.evaluate(() => window.__speech.starts.length);
const longText = "aaaa bbbb cccc dddd eeee ffff";
await emit([{ text: longText, final: false }]);
const split = await lines();
const startsAfterChars = await page.evaluate(() => window.__speech.starts.length);
if (startsAfterChars !== startsFresh) throw new Error("char split restarted");
if (split.length < 3) throw new Error("no char split " + JSON.stringify(split));
const head = split[split.length - 2];
const rest = split[split.length - 1];
if (head.length > 25 || head.indexOf(" ") === -1) throw new Error("head " + head);
if (!rest || longText.indexOf(head) !== 0) throw new Error(JSON.stringify({ head: head, rest: rest }));
if ((head + " " + rest).replace(/\s+/g, " ") !== longText && (head + rest).replace(/\s+/g, "") !== longText.replace(/\s+/g, "")) {
  throw new Error("pieces " + JSON.stringify({ head: head, rest: rest }));
}

await emit([{ text: "말하는 중입니다", final: true }]);
const speakAt = Date.now();
const beforeSpeakEnd = await page.evaluate(() => window.__speech.starts.length);
await page.evaluate(() => {
  const rec = window.__speech.instances.filter((item) => item.started).pop();
  rec.end();
});
await page.waitForFunction((n) => window.__speech.starts.length > n, { timeout: 1000 }, beforeSpeakEnd);
const speakGap = Date.now() - speakAt;
if (speakGap > 180) throw new Error("speaking restart waited " + speakGap);

async function silenceGap() {
  const before = await page.evaluate(() => window.__speech.starts.length);
  const t0 = Date.now();
  await page.evaluate(() => {
    const rec = window.__speech.instances.filter((item) => item.started).pop();
    rec.onerror({ error: "no-speech" });
    rec.end();
  });
  await page.waitForFunction((n) => window.__speech.starts.length > n, { timeout: 4000 }, before);
  return Date.now() - t0;
}
const gap1 = await silenceGap();
const gap2 = await silenceGap();
const gap3 = await silenceGap();
if (gap1 > 600) throw new Error("first no-speech " + gap1);
if (gap2 < 700 || gap2 > 1600) throw new Error("second no-speech " + gap2);
if (gap3 < 1600 || gap3 > 2800) throw new Error("third no-speech " + gap3);
const status = await page.$eval("#statusText", (node) => node.textContent);
if (status.indexOf("다시 듣기") === -1) throw new Error(status);
await emit([{ text: "다시 말합니다", final: false }]);
const gapReset = await silenceGap();
if (gapReset > 600) throw new Error("reset no-speech " + gapReset);

const realErrors = errors.filter((line) => line.indexOf("favicon") === -1 && line.indexOf("404") === -1);
if (realErrors.length) throw new Error(realErrors.join("\n"));
console.log("page v1.042 tests ok");
console.log(JSON.stringify({ version: version, steps: seen, paused: paused, head: head, rest: rest, speakGap: speakGap, gaps: [gap1, gap2, gap3, gapReset], status: status }, null, 2));
await browser.close();
server.close();
