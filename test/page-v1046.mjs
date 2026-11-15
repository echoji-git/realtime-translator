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
page.on("pageerror", (err) => errors.push(String(err)));
page.on("console", (msg) => {
  if (msg.type() !== "error") return;
  const loc = msg.location();
  const url = loc && loc.url ? loc.url : "";
  if (url.indexOf("favicon.ico") >= 0) return;
  errors.push(msg.text() + " " + url);
});
await page.evaluateOnNewDocument(installFakes);
await page.goto(pageUrl, { waitUntil: "load" });
await page.evaluate(() => {
  localStorage.setItem("rtb.settings.v1", JSON.stringify({
    asrRoute: "pc",
    trRoute: "pc",
    pcEngine: "whisper-stream",
    cutMode: "pause",
    lang1: "ko",
    lang2: "en",
    pcBase: "https://desktop.example",
    pcTrBase: "https://desktop.example",
    pcModel: "gemma3:1b"
  }));
});
await page.reload({ waitUntil: "load" });

const version = await page.$eval("#devVersion", (node) => node.textContent);
if (version.indexOf("v1.046 (261115)") === -1) throw new Error(version);

const flow = await page.evaluate(async () => {
  window.__langs = [];
  window.__prompts = [];
  window.__replies = [
    { text: "안녕하세요", language: "ko" },
    { text: "안녕하세요", language: "ko" },
    { text: "hello there", language: "en" },
    { text: "hello there", language: "en" }
  ];
  const origFetch = window.fetch;
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.indexOf("/inference") >= 0) {
      const body = opts && opts.body;
      const lang = body && body.get ? String(body.get("language") || "") : "";
      window.__langs.push(lang);
      if (body && body.get && (body.get("prompt") || body.get("initial_prompt"))) {
        window.__prompts.push("bias");
      }
      const next = window.__replies[window.__langs.length - 1] || { text: "" };
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (u.indexOf("/api/chat") >= 0) {
      return new Response(JSON.stringify({ message: { content: "Hello there." } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (u.indexOf("/manager/") >= 0) {
      return new Response(JSON.stringify({ ok: true, sensevoice: { installed: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return origFetch(url, opts);
  };
  function loud(n) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / 16000);
    return out;
  }
  for (let i = 0; i < 4; i++) {
    window.RtbStream.feed(loud(16000));
    await window.RtbStream.idle();
  }
  const state = window.RtbStream.state();
  const shown = state.lines.map((line) => line.text + "/" + line.lang).join(" | ");
  const english = state.lines.some((line) => line.text.indexOf("hello there") >= 0 && line.lang === "en");
  return {
    langs: window.__langs.slice(),
    prompts: window.__prompts.slice(),
    english: english,
    shown: shown
  };
});
if (flow.langs.length < 4) throw new Error("langs " + JSON.stringify(flow.langs));
if (flow.langs.some((lang) => lang !== "auto")) throw new Error("locked " + JSON.stringify(flow.langs));
if (flow.prompts.length) throw new Error("prompt " + JSON.stringify(flow.prompts));
if (!flow.english) throw new Error("english dropped " + flow.shown);

await page.select("#lang1", "en");
await page.select("#lang2", "en");
const forced = await page.evaluate(async () => {
  window.__langs = [];
  window.__replies = [{ text: "hello there", language: "en" }];
  function loud(n) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.2 * Math.sin((2 * Math.PI * 260 * i) / 16000);
    return out;
  }
  window.RtbStream.feed(loud(16000));
  await window.RtbStream.idle();
  return {
    langs: window.__langs.slice(),
    code: window.RtbClean.sttLanguage("en", "en"),
    sense: window.RtbClean.sttLanguage(
      document.getElementById("lang1").value,
      document.getElementById("lang2").value
    )
  };
});
if (forced.langs.join(",") !== "en") throw new Error("forced " + JSON.stringify(forced));
if (forced.sense !== "en") throw new Error(forced.sense);

await page.select("#pcEngine", "whisper");
await page.select("#pcEngine", "sensevoice");
const engines = await page.evaluate(() => ({
  engine: document.getElementById("pcEngine").value,
  code: window.RtbClean.sttLanguage(
    document.getElementById("lang1").value,
    document.getElementById("lang2").value
  )
}));
if (engines.engine !== "sensevoice" || engines.code !== "en") throw new Error(JSON.stringify(engines));

if (errors.length) throw new Error(errors.join("\n"));
await browser.close();
await new Promise((resolve) => server.close(resolve));
console.log("page v1.046 language tests ok");
