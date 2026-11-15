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

function installFakes() {
  class FakeSpeech {
    start() {}
    stop() {}
    abort() {}
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
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
page.on("pageerror", (err) => errors.push(String(err)));
page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
await page.evaluateOnNewDocument(installFakes);
await page.goto(pageUrl, { waitUntil: "load" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "load" });

const version = await page.$eval("#devVersion", (node) => node.textContent);
if (version.indexOf("v1.045 (261115)") === -1) throw new Error(version);
const historyTop = await page.$eval("#devHistory li", (node) => node.textContent);
if (historyTop.indexOf("v1.045(261115)") !== 0) throw new Error(historyTop);

await page.evaluate(() => document.getElementById("menuBtn").click());
await page.evaluate(() => document.querySelector('#sidebar .fold[data-fold="segment"] .fold-btn').click());
await page.waitForFunction(() => !document.getElementById("fold-segment").hidden);

const initial = await page.evaluate(() => ({
  cut: document.getElementById("cutPause").classList.contains("active"),
  mid: document.getElementById("micMid").classList.contains("active"),
  low: document.getElementById("micLow").textContent,
  high: document.getElementById("micHigh").textContent
}));
if (!initial.cut || !initial.mid || initial.low !== "작게" || initial.high !== "크게") {
  throw new Error("initial " + JSON.stringify(initial));
}

async function click(id) {
  await page.evaluate((id) => document.getElementById(id).click(), id);
}
async function labels() {
  return page.evaluate(() => ({
    low: document.getElementById("micLow").textContent,
    mid: document.getElementById("micMid").textContent,
    high: document.getElementById("micHigh").textContent,
    lowOn: document.getElementById("micLow").classList.contains("active"),
    midOn: document.getElementById("micMid").classList.contains("active"),
    highOn: document.getElementById("micHigh").classList.contains("active"),
    toast: document.getElementById("toast").textContent
  }));
}

await click("micHigh");
let state = await labels();
if (state.high !== "크게 x1" || !state.highOn || state.lowOn) throw new Error("x1 " + JSON.stringify(state));
await click("micHigh");
state = await labels();
if (state.high !== "크게 x2" || !state.highOn) throw new Error("x2 " + JSON.stringify(state));
await page.$eval("#micHigh", (node) => node.scrollIntoView({ block: "center" }));
await new Promise((r) => setTimeout(r, 200));
await page.screenshot({ path: outDir + "/v1044-mic-high-x2-390.png" });
await (await page.$("#fold-segment")).screenshot({ path: outDir + "/v1044-mic-high-x2-fold.png" });

for (let i = 0; i < 4; i++) await click("micHigh");
state = await labels();
if (state.high !== "크게 x5" || state.toast.indexOf("x5") === -1) throw new Error("max " + JSON.stringify(state));

await click("micLow");
state = await labels();
if (state.low !== "작게 x1" || !state.lowOn || state.highOn || state.high !== "크게") {
  throw new Error("switch low " + JSON.stringify(state));
}
await click("micLow");
state = await labels();
if (state.low !== "작게 x2") throw new Error(state.low);
await click("micMid");
state = await labels();
if (!state.midOn || state.low !== "작게" || state.high !== "크게") throw new Error("reset " + JSON.stringify(state));

await page.evaluate(() => {
  localStorage.setItem("rtb.settings.v1", JSON.stringify({ micLevel: "high", cutMode: "overlap" }));
});
await page.reload({ waitUntil: "load" });
const fromHigh = await page.evaluate(() => {
  const saved = JSON.parse(localStorage.getItem("rtb.settings.v1"));
  return {
    high: document.getElementById("micHigh").textContent,
    on: document.getElementById("micHigh").classList.contains("active"),
    side: saved.micSide,
    step: saved.micStep
  };
});
if (fromHigh.high !== "크게 x1" || !fromHigh.on || fromHigh.side !== "high" || fromHigh.step !== 1) {
  throw new Error("migrate high " + JSON.stringify(fromHigh));
}

await page.evaluate(() => {
  localStorage.setItem("rtb.settings.v1", JSON.stringify({ micLevel: "low" }));
});
await page.reload({ waitUntil: "load" });
const fromLow = await page.$eval("#micLow", (node) => node.textContent + (node.classList.contains("active") ? " on" : ""));
if (fromLow !== "작게 x1 on") throw new Error(fromLow);

await page.evaluate(() => {
  localStorage.setItem("rtb.settings.v1", JSON.stringify({ micLevel: "mid" }));
});
await page.reload({ waitUntil: "load" });
const fromMid = await page.evaluate(() => document.getElementById("micMid").classList.contains("active"));
if (!fromMid) throw new Error("mid not restored");

await page.evaluate(() => document.getElementById("menuBtn").click());
await page.evaluate(() => document.querySelector('#sidebar .fold[data-fold="segment"] .fold-btn').click());
await click("micHigh");
await click("micHigh");
await page.evaluate(() => document.getElementById("saveSettingsBtn").click());
await page.reload({ waitUntil: "load" });
const kept = await page.evaluate(() => {
  const saved = JSON.parse(localStorage.getItem("rtb.settings.v1"));
  return { text: document.getElementById("micHigh").textContent, side: saved.micSide, step: saved.micStep };
});
if (kept.text !== "크게 x2" || kept.side !== "high" || kept.step !== 2) throw new Error("save " + JSON.stringify(kept));

await page.evaluate(() => document.getElementById("menuBtn").click());
await page.evaluate(() => document.querySelector('#sidebar .fold[data-fold="models"] .fold-btn').click());
await page.select("#asrRoute", "chrome");
const chromeMic = await page.evaluate(() => ({
  disabled: document.getElementById("micHigh").disabled && document.getElementById("micLow").disabled,
  hint: document.getElementById("micLevelHint").textContent
}));
if (!chromeMic.disabled || chromeMic.hint.indexOf("적용되지 않습니다") === -1) {
  throw new Error("chrome " + JSON.stringify(chromeMic));
}

const realErrors = errors.filter((line) => line.indexOf("favicon") === -1 && line.indexOf("404") === -1);
if (realErrors.length) throw new Error(realErrors.join("\n"));
console.log("page v1.044 tests ok");
console.log(JSON.stringify({ version, fromHigh, kept }, null, 2));
await browser.close();
server.close();
