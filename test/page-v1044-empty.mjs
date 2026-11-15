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
const browser = await puppeteer.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"]
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));
await page.goto(`http://127.0.0.1:${port}/translator.html`, { waitUntil: "load" });

const result = await page.evaluate(() => {
  const old = document.documentElement.innerHTML.indexOf("PC가 받아 적지 못했습니다");
  const quiet = window.RtbLive.worthSending(2, 2);
  const boosted = window.RtbClean.chunkWorthSending(2, 6, 6);
  const loud = window.RtbLive.worthSending(9, 2);
  const t0 = 100000;
  for (let i = 0; i < 4; i++) window.RtbLive.noteBlank(true, t0);
  const before = document.getElementById("toast").style.display;
  window.RtbLive.noteBlank(false, t0);
  const quietIgnored = document.getElementById("toast").style.display;
  window.RtbLive.noteBlank(true, t0);
  const toast = document.getElementById("toast");
  const shown = { display: toast.style.display, text: toast.textContent };
  window.RtbLive.noteBlank(true, t0 + 1000);
  const repeat = toast.textContent;
  const gap = window.RtbClean.EMPTY_HEARD_GAP;
  for (let i = 0; i < 5; i++) window.RtbLive.noteBlank(true, t0 + gap + i);
  return { old, quiet, boosted, loud, before, quietIgnored, shown, repeat, afterGap: toast.textContent };
});
if (result.old !== -1) throw new Error("old toast remains");
if (result.quiet !== false || result.boosted !== true || result.loud !== true) throw new Error(JSON.stringify(result));
if (result.before === "block" || result.quietIgnored === "block") throw new Error("early toast " + JSON.stringify(result));
if (result.shown.display !== "block" || result.shown.text.indexOf("크게를 눌러") === -1) throw new Error(result.shown.text);
if (result.repeat !== result.shown.text) throw new Error("repeat changed toast");
if (result.afterGap.indexOf("크게를 눌러") === -1) throw new Error(result.afterGap);
const realErrors = errors.filter((line) => line.indexOf("favicon") === -1);
if (realErrors.length) throw new Error(realErrors.join("\n"));
console.log("page v1.044 empty-toast tests ok");
console.log(JSON.stringify(result, null, 2));
await browser.close();
server.close();
