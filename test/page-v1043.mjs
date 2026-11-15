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
await page.evaluateOnNewDocument(() => {
  window.__senseInstalled = false;
  const orig = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.indexOf("/manager/") === -1) return orig(url, opts);
    return Promise.resolve(new Response(JSON.stringify({
      ok: true,
      sensevoice: { installed: !!window.__senseInstalled }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  };
});
await page.goto(pageUrl, { waitUntil: "load" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "load" });

const version = await page.$eval("#devVersion", (node) => node.textContent);
if (version.indexOf("v1.046 (261115)") === -1) throw new Error(version);
const historyTop = await page.$eval("#devHistory li", (node) => node.textContent);
if (historyTop.indexOf("v1.046(261115)") !== 0) throw new Error(historyTop);
if ((await page.$eval("#devHistory", (node) => node.textContent)).indexOf("v1.043(261115)") === -1) {
  throw new Error("old history removed");
}
const history = await page.$eval("#devHistory", (node) => node.textContent);
if (history.indexOf("v1.042(261115)") === -1) throw new Error("old history removed");

await page.evaluate(() => document.getElementById("menuBtn").click());
await page.evaluate(() => document.querySelector('#sidebar .fold[data-fold="models"] .fold-btn').click());
await page.waitForFunction(() => !document.getElementById("fold-models").hidden);
await page.select("#asrRoute", "pc");
await page.waitForFunction(() => {
  const note = document.getElementById("pcSenseNote");
  const opt = document.querySelector('#pcEngine option[value="sensevoice"]');
  return document.getElementById("pcEngine").value === "whisper"
    && note.hidden
    && opt
    && opt.textContent.indexOf("설치 필요") !== -1;
});
const whisper = await page.evaluate(() => ({
  engine: document.getElementById("pcEngine").value,
  hidden: document.getElementById("pcSenseNote").hidden,
  text: document.getElementById("pcSenseNote").textContent,
  option: document.querySelector('#pcEngine option[value="sensevoice"]').textContent
}));
if (whisper.engine !== "whisper" || !whisper.hidden || whisper.text) throw new Error("whisper " + JSON.stringify(whisper));
if (whisper.option !== "SenseVoice (설치 필요)") throw new Error(whisper.option);
await page.$eval("#pcEngine", (node) => node.scrollIntoView({ block: "center" }));
await new Promise((r) => setTimeout(r, 200));
await (await page.$("#fold-models")).screenshot({ path: outDir + "/v1043-whisper-no-install-note.png" });

await page.select("#pcEngine", "sensevoice");
const missing = await page.evaluate(() => ({
  hidden: document.getElementById("pcSenseNote").hidden,
  text: document.getElementById("pcSenseNote").textContent,
  engine: document.getElementById("pcEngine").value
}));
if (missing.engine !== "sensevoice" || missing.hidden || missing.text !== "설치 필요") {
  throw new Error("missing " + JSON.stringify(missing));
}

await page.select("#pcEngine", "whisper");
const back = await page.evaluate(() => ({
  hidden: document.getElementById("pcSenseNote").hidden,
  text: document.getElementById("pcSenseNote").textContent
}));
if (!back.hidden || back.text) throw new Error("back " + JSON.stringify(back));

await page.evaluate(() => { window.__senseInstalled = true; });
await page.select("#asrRoute", "gemini");
await page.select("#asrRoute", "pc");
await page.waitForFunction(() => {
  const opt = document.querySelector('#pcEngine option[value="sensevoice"]');
  return opt && opt.textContent === "SenseVoice";
});
await page.select("#pcEngine", "sensevoice");
const installed = await page.evaluate(() => ({
  hidden: document.getElementById("pcSenseNote").hidden,
  text: document.getElementById("pcSenseNote").textContent,
  option: document.querySelector('#pcEngine option[value="sensevoice"]').textContent
}));
if (!installed.hidden || installed.text || installed.option !== "SenseVoice") {
  throw new Error("installed " + JSON.stringify(installed));
}

const realErrors = errors.filter((line) => line.indexOf("favicon") === -1 && line.indexOf("404") === -1);
if (realErrors.length) throw new Error(realErrors.join("\n"));
console.log("page v1.043 tests ok");
console.log(JSON.stringify({ version, whisper, missing, installed }, null, 2));
await browser.close();
server.close();
