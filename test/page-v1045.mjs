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
    pcEngine: "whisper",
    cutMode: "pause",
    chromeLine: 3,
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
const historyTop = await page.$eval("#devHistory li", (node) => node.textContent);
if (historyTop.indexOf("v1.046(261115)") !== 0) throw new Error(historyTop);
const history = await page.$eval("#devHistory", (node) => node.textContent);
if (history.indexOf("v1.045(261115)") === -1) throw new Error("missing v1.045 history");
if (history.indexOf("v1.044(261115)") === -1) throw new Error("missing v1.044 history");

await page.evaluate(() => document.getElementById("menuBtn").click());
await page.evaluate(() => document.querySelector('#sidebar .fold[data-fold="models"] .fold-btn').click());
await page.waitForFunction(() => !document.getElementById("fold-models").hidden);
await page.evaluate(() => document.querySelector('#sidebar .fold[data-fold="segment"] .fold-btn').click());
await page.waitForFunction(() => !document.getElementById("fold-segment").hidden);

const engines = await page.$$eval("#pcEngine option", (nodes) => nodes.map((node) => ({
  value: node.value,
  text: node.textContent
})));
if (engines.map((item) => item.value).join(",") !== "whisper,whisper-stream,sensevoice") {
  throw new Error(JSON.stringify(engines));
}
if (engines[1].text !== "Whisper 스트리밍") throw new Error(engines[1].text);
const initialEngine = await page.$eval("#pcEngine", (node) => node.value);
if (initialEngine !== "whisper") throw new Error(initialEngine);

async function cutState() {
  return page.evaluate(() => ({
    engine: document.getElementById("pcEngine").value,
    pauseOn: document.getElementById("cutPause").classList.contains("active"),
    overlapOn: document.getElementById("cutOverlap").classList.contains("active"),
    disabled: ["cutOverlap", "cutCut", "cutPause"].map((id) => document.getElementById(id).disabled),
    dim: document.getElementById("cutOptionBlock").classList.contains("is-dim"),
    note: document.getElementById("streamCutNote").hidden ? "" : document.getElementById("streamCutNote").textContent,
    segmentOff: document.getElementById("segment").disabled,
    lineOff: document.getElementById("chromeLine").disabled,
    segmentLabel: document.getElementById("segmentVal").textContent,
    pcNote: document.getElementById("pcStreamNote").hidden ? "" : document.getElementById("pcStreamNote").textContent
  }));
}

const before = await cutState();
if (!before.pauseOn || before.disabled.some(Boolean) || before.dim || before.note || before.segmentOff) {
  throw new Error("before " + JSON.stringify(before));
}

await page.select("#pcEngine", "whisper-stream");
const streaming = await cutState();
if (!streaming.pauseOn || streaming.overlapOn || streaming.disabled.some((off) => !off) || !streaming.dim) {
  throw new Error("stream " + JSON.stringify(streaming));
}
if (streaming.note !== "스트리밍은 자동으로 끊어요") throw new Error(streaming.note);
if (!streaming.segmentOff || streaming.lineOff || streaming.segmentLabel !== "사용 안 함") {
  throw new Error("slider " + JSON.stringify(streaming));
}
if (streaming.pcNote.indexOf("두 번 같은 앞부분") === -1) throw new Error(streaming.pcNote);
await page.evaluate(() => document.getElementById("cutOverlap").click());
const stillPause = await cutState();
if (!stillPause.pauseOn || stillPause.overlapOn) throw new Error("click changed " + JSON.stringify(stillPause));

await page.screenshot({ path: join(outDir, "v1045-stream-cut-dim-390.png") });

await page.select("#pcEngine", "sensevoice");
const sense = await cutState();
if (sense.engine !== "sensevoice" || sense.dim || sense.note || sense.disabled.some(Boolean) || !sense.pauseOn || sense.segmentOff) {
  throw new Error("sense " + JSON.stringify(sense));
}
await page.select("#pcEngine", "whisper");
const back = await cutState();
if (back.engine !== "whisper" || back.dim || back.note || back.disabled.some(Boolean) || !back.pauseOn || back.segmentOff) {
  throw new Error("back " + JSON.stringify(back));
}

await page.select("#pcEngine", "whisper-stream");
const flow = await page.evaluate(async () => {
  window.__calls = 0;
  window.__replies = [
    { text: "오늘 회의는", segments: [{ start: 0, end: 1, text: "오늘 회의는" }] },
    { text: "오늘 회의는 길어", segments: [{ start: 0, end: 1, text: "오늘 회의는" }, { start: 1, end: 2, text: "길어" }] },
    { text: "오늘 회의는 길었습니다.", segments: [{ start: 0, end: 1.2, text: "오늘 회의는" }, { start: 1.2, end: 2.4, text: "길었습니다." }] },
    { text: "오늘 회의는 길었습니다.", segments: [{ start: 0, end: 1.2, text: "오늘 회의는" }, { start: 1.2, end: 2.4, text: "길었습니다." }] }
  ];
  window.__defer = false;
  const origFetch = window.fetch;
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.indexOf("/inference") >= 0) {
      const body = window.__replies[window.__calls] || { text: "" };
      window.__calls += 1;
      const response = () => new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
      if (window.__defer) {
        return new Promise((resolve) => { window.__release = () => resolve(response()); });
      }
      return response();
    }
    if (u.indexOf("/api/chat") >= 0) {
      return new Response(JSON.stringify({ message: { content: "The meeting ran long." } }), {
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
  const quietBefore = window.__calls;
  window.RtbStream.feed(new Float32Array(16000));
  if (window.__calls !== quietBefore) throw new Error("quiet sent " + window.__calls);
  window.RtbStream.feed(loud(16000));
  await window.RtbStream.idle();
  window.RtbStream.feed(loud(16000));
  await window.RtbStream.idle();
  const mid = window.RtbStream.state();
  if (mid.confirmed !== "오늘 회의는" || mid.tail !== "길어") throw new Error("agree " + JSON.stringify(mid));
  if (!mid.lines.length || mid.lines.some((line) => line.status !== "hearing")) {
    throw new Error("early translate " + JSON.stringify(mid.lines));
  }
  const held = document.querySelector("#transcript .hold");
  if (!held || held.textContent !== "길어") throw new Error(held ? held.textContent : "no hold");
  window.RtbStream.feed(loud(16000));
  await window.RtbStream.idle();
  window.RtbStream.feed(loud(16000));
  await window.RtbStream.idle();
  let done = null;
  for (let i = 0; i < 30; i++) {
    const state = window.RtbStream.state();
    done = state.lines.find((line) => line.text.indexOf("길었습니다") >= 0 && !line.growing);
    if (done && done.status === "done") break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (!done || done.status !== "done" || done.engine !== "pc-whisper-stream") {
    throw new Error("commit " + JSON.stringify(window.RtbStream.state().lines));
  }
  if (done.text.indexOf("The meeting") >= 0) throw new Error(done.text);
  const translated = window.RtbStream.state().lines.find((line) => line.status === "done");
  return { calls: window.__calls, text: done.text, tgt: translated && translated.status };
});
if (flow.calls < 4) throw new Error("calls " + flow.calls);
if (flow.text.indexOf("오늘 회의는 길었습니다.") === -1) throw new Error(flow.text);

const skipped = await page.evaluate(async () => {
  document.getElementById("pcEngine").value = "whisper";
  document.getElementById("pcEngine").dispatchEvent(new Event("change", { bubbles: true }));
  document.getElementById("pcEngine").value = "whisper-stream";
  document.getElementById("pcEngine").dispatchEvent(new Event("change", { bubbles: true }));
  window.__defer = true;
  window.__calls = 0;
  window.__replies = [{ text: "잠깐" }, { text: "잠깐 더" }];
  function loud(n) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.2 * Math.sin((2 * Math.PI * 180 * i) / 16000);
    return out;
  }
  window.RtbStream.feed(loud(16000));
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (window.__calls !== 1 || !window.RtbStream.state().busy) {
    throw new Error("first " + window.__calls + " " + window.RtbStream.state().busy);
  }
  window.RtbStream.feed(loud(16000));
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (window.__calls !== 1) throw new Error("queued " + window.__calls);
  const release = window.__release;
  window.__release = null;
  release();
  await new Promise((resolve) => setTimeout(resolve, 40));
  if (window.__calls !== 2) throw new Error("second " + window.__calls);
  if (window.__release) window.__release();
  window.__defer = false;
  await window.RtbStream.idle();
  return window.__calls;
});
if (skipped !== 2) throw new Error("skip " + skipped);

const blanks = await page.evaluate(async () => {
  document.getElementById("pcEngine").value = "whisper";
  document.getElementById("pcEngine").dispatchEvent(new Event("change", { bubbles: true }));
  document.getElementById("pcEngine").value = "whisper-stream";
  document.getElementById("pcEngine").dispatchEvent(new Event("change", { bubbles: true }));
  window.__defer = false;
  window.__calls = 0;
  window.__replies = [
    { text: "(upbeat music)" },
    { text: "" }, { text: "" }, { text: "" }, { text: "" }, { text: "" }, { text: "" }
  ];
  function loud(n) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.2 * Math.sin((2 * Math.PI * 330 * i) / 16000);
    return out;
  }
  const toast = document.getElementById("toast");
  toast.textContent = "";
  window.RtbStream.feed(loud(16000));
  await window.RtbStream.idle();
  const afterHallucination = toast.textContent;
  for (let i = 0; i < 5; i++) {
    window.RtbStream.feed(loud(16000));
    await window.RtbStream.idle();
  }
  const told = toast.textContent;
  toast.textContent = "";
  window.RtbStream.feed(loud(16000));
  await window.RtbStream.idle();
  return { afterHallucination: afterHallucination, told: told, again: toast.textContent };
});
if (blanks.afterHallucination) throw new Error("hallucination toast " + blanks.afterHallucination);
if (blanks.told.indexOf("크게") === -1) throw new Error(blanks.told);
if (blanks.again) throw new Error("repeat toast " + blanks.again);

if (errors.length) throw new Error(errors.join("\n"));
await browser.close();
await new Promise((resolve) => server.close(resolve));
console.log("page v1.045 stream tests ok");
