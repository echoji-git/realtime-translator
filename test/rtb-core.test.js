"use strict";

const assert = require("assert");
const core = require("../rtb-core.js");

function sine(amp, n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * 440 * i) / 16000);
  return out;
}

function lineStarts(text, prefix) {
  return String(text).split(/\n/).some(function (line) {
    return line.trim().indexOf(prefix) === 0;
  });
}

const emptyGemini = core.geminiTranslatePrompt({
  srcLang: "en",
  targetLang: "ko",
  glossary: "",
  recentLines: [],
  srcText: "hello"
});
assert.strictEqual(lineStarts(emptyGemini, "용어집:"), false);
assert.strictEqual(emptyGemini.includes(core.EMPTY_RECENT), false);
assert.strictEqual(emptyGemini.includes("hello"), true);

const emptyGlossaryOnly = core.glossaryBlock("   \n# 메모\n");
assert.strictEqual(emptyGlossaryOnly, "");
assert.strictEqual(core.recentSourceBlock([]), "");
assert.strictEqual(core.recentSourceBlock(["", "  "]), "");

const filled = core.geminiTranslatePrompt({
  srcLang: "ko",
  targetLang: "en",
  glossary: "웨이퍼=wafer | 웨이파",
  recentLines: ["en: previous"],
  srcText: "다음"
});
assert.strictEqual(filled.includes("용어집 (원어=선호 번역):"), true);
assert.strictEqual(filled.includes("웨이퍼=wafer"), true);
assert.strictEqual(filled.includes("이번 회의에서 방금 확정된 원문 1개"), true);
assert.strictEqual(filled.includes(core.EMPTY_RECENT), false);

const emptyPc = core.pcTranslatePrompt({
  targetName: "한국어",
  glossary: "",
  srcText: "hello"
});
assert.strictEqual(lineStarts(emptyPc, "용어집:"), false);
assert.strictEqual(emptyPc.includes(core.EMPTY_RECENT), false);
assert.strictEqual(emptyPc.includes("Source:\nhello"), true);

const filledPc = core.pcTranslatePrompt({
  targetName: "한국어",
  glossary: "웨이퍼=wafer",
  srcText: "hello"
});
assert.strictEqual(filledPc.includes("용어집 (원어=선호 번역):"), true);

const cleaned = core.cleanModelOutput(
  "안녕\n용어집: 웨이퍼=wafer\n  용어집:(없음)\n이번 회의에서 방금 확정된 원문: (없음)\n끝"
);
assert.strictEqual(cleaned, "안녕\n끝");

const kept = core.cleanModelOutput("용어집 (원어=선호 번역):\n웨이퍼=wafer\n실제 번역");
assert.strictEqual(kept.includes("용어집 (원어=선호 번역):"), true);
assert.strictEqual(kept.includes("실제 번역"), true);

assert.strictEqual(core.cleanModelOutput("이번 회의에서 방금 확정된 원문: (없음) 그리고 덧붙임"), "");
assert.strictEqual(core.cleanModelOutput("용어집:"), "");

assert.strictEqual(core.pcModelTag("1b"), "gemma3:1b");
assert.strictEqual(core.pcModelTag("2b"), "gemma2:2b");
assert.strictEqual(core.pcModelTag("4b"), "gemma3:4b");
assert.strictEqual(core.pcModelTag("nope"), "gemma3:1b");
assert.deepStrictEqual(core.pcHeaders(" secret ", { "Content-Type": "application/json" }), {
  "Content-Type": "application/json",
  "X-RTB-Key": "secret"
});
assert.deepStrictEqual(core.pcHeaders("", {}), {});

const loud = sine(0.9, 1600);
const mid = core.applyMicLevel(loud, "mid");
assert.strictEqual(mid, loud);
const normal = core.applyMicLevel(loud, "기본");
assert.strictEqual(normal, loud);
for (let i = 0; i < loud.length; i++) assert.strictEqual(mid[i], loud[i]);

const quieted = core.applyMicLevel(loud, "low");
const loudRms = core.pcmRms(loud);
const quietedRms = core.pcmRms(quieted);
const ratioLow = quietedRms / loudRms;
assert.ok(Math.abs(ratioLow - 0.6) < 0.02, "작게 RMS 비 " + ratioLow);
assert.ok(core.pcmPeak(quieted) <= 0.6 * core.pcmPeak(loud) + 0.001);
assert.ok(core.pcmPeak(quieted) <= 1);

const quiet = sine(0.04, 1600);
const quietSame = core.applyMicLevel(quiet, "low");
assert.strictEqual(quietSame, quiet, "작아도 이미 작은 소리는 그대로");

const boosted = core.applyMicLevel(quiet, "high");
const ratioHigh = core.pcmRms(boosted) / core.pcmRms(quiet);
assert.ok(ratioHigh >= 1.95 && ratioHigh <= 3.05, "크게 RMS 비 " + ratioHigh);
assert.ok(core.pcmPeak(boosted) <= 1, "크게 꼭지 " + core.pcmPeak(boosted));
assert.ok(core.pcmRms(boosted) > core.pcmRms(quiet));

const hot = sine(0.95, 1600);
const hotOut = core.applyMicLevel(hot, "high");
assert.ok(core.pcmPeak(hotOut) <= 1, "큰 소리 크게 꼭지 " + core.pcmPeak(hotOut));
assert.ok(core.pcmPeak(hotOut) <= core.pcmPeak(hot) + 0.001);

const clipped = sine(1, 320);
const clippedOut = core.applyMicLevel(clipped, "low");
assert.ok(core.pcmPeak(clippedOut) <= 0.65);
assert.ok(core.pcmPeak(clippedOut) <= 1);

const silence = new Float32Array(400);
assert.strictEqual(core.applyMicLevel(silence, "high"), silence);

assert.strictEqual(core.fastTranslateWait({ full: "안녕", sent: "", now: 1000 }), 450);
assert.strictEqual(core.fastTranslateWait({ full: "하나 둘 셋", sent: "", now: 1000 }), 450);
assert.strictEqual(core.fastTranslateWait({ full: "one two three four", sent: "", now: 5000 }), 0);
assert.strictEqual(core.fastTranslateWait({
  full: "one two three four five six seven eight",
  sent: "one two three four",
  sentAt: 1000,
  now: 1200
}), 200);
assert.strictEqual(core.fastTranslateWait({
  full: "하나 둘",
  sent: "",
  immediate: true,
  now: 1000
}), 0);
assert.strictEqual(core.fastTranslateWait({ full: "끝.", sent: "", now: 1000 }), 0);
assert.strictEqual(core.fastTranslateWait({ full: "같은 문장", sent: "같은 문장", now: 1000 }), -1);
assert.strictEqual(core.fastUnitCount("가나다라마바사아자차카타"), 12);
assert.strictEqual(core.fastTranslateWait({ full: "가나다라마바사아자차카타", sent: "", now: 1000 }), 0);
assert.strictEqual(core.fastDelta("안녕 하세요", "안녕"), "하세요");
assert.strictEqual(core.fastEndsSentence("문장."), true);
assert.strictEqual(core.fastEndsSentence("문장"), false);

function tone(rms, n) {
  return sine(rms * Math.SQRT2, n);
}
assert.deepStrictEqual(core.MIC_HIGH_MAX, [4, 8, 12, 16, 20]);
assert.deepStrictEqual(core.MIC_LOW_GAIN, [0.7, 0.5, 0.35, 0.25, 0.18]);
const quietSpeech = tone(0.002, 1600);
const mildSpeech = tone(0.01, 1600);
for (let step = 1; step <= 5; step++) {
  const spec = { side: "high", step: step };
  const out = core.applyMicLevel(quietSpeech, spec);
  assert.ok(core.pcmRms(out) > core.pcmRms(quietSpeech), "크게 x" + step + " 가 커지지 않음");
  assert.ok(core.pcmPeak(out) <= 1, "크게 x" + step + " 꼭지");
}
assert.ok(core.keepsSpeech(mildSpeech, { side: "high", step: 1 }), "0.01 은 크게 x1 에서 남음");
assert.ok(core.keepsSpeech(quietSpeech, { side: "high", step: 2 }), "0.002 는 크게 x2 에서 남음");
assert.ok(core.keepsSpeech(quietSpeech, { side: "high", step: 5 }), "0.002 는 크게 x5 에서 남음");
const low2 = core.applyMicLevel(tone(0.2, 800), { side: "low", step: 2 });
const lowRatio = core.pcmRms(low2) / core.pcmRms(tone(0.2, 800));
assert.ok(Math.abs(lowRatio - 0.5) < 0.03, "작게 x2 비 " + lowRatio);
assert.strictEqual(core.micGate({ side: "mid", step: 0 }), 8);
assert.strictEqual(core.micGate({ side: "high", step: 2 }), 6);
assert.strictEqual(core.chunkWorthSending(2, 2, 8), false);
assert.strictEqual(core.chunkWorthSending(9, 2, 8), true);
assert.strictEqual(core.chunkWorthSending(2, 6, 6), true);
let blank = { streak: 0, noticeAt: 0 };
const told = [];
for (let i = 0; i < 4; i++) {
  blank = core.emptyHeardNotice(blank, 1000);
  told.push(blank.tell);
}
blank = core.emptyHeardNotice(blank, 1000);
assert.deepStrictEqual(told, [false, false, false, false]);
assert.strictEqual(blank.tell, true);
const during = core.emptyHeardNotice(blank, 1000 + 1000);
assert.strictEqual(during.tell, false);
const quietGap = core.emptyHeardNotice(core.clearEmptyHeard(blank), blank.noticeAt + 5000);
assert.strictEqual(quietGap.tell, false);
let again = { streak: 0, noticeAt: blank.noticeAt };
again = core.emptyHeardNotice(again, blank.noticeAt + core.EMPTY_HEARD_GAP);
assert.strictEqual(again.tell, false);
assert.strictEqual(again.streak, 1);

assert.strictEqual(core.fixSentenceSpace("불기능이 됩니다.불기대죠"), "불기능이 됩니다. 불기대죠");
const longKo = "오늘 회의에서는 작은 소리도 놓치지 않도록 줄을 나누고 번역을 확정한 다음 이어 적습니다. 그리고 다음 문장으로 넘어갑니다.";
const splitKo = core.splitTranscriptLine(longKo, 45);
assert.ok(splitKo && splitKo.head.length <= 45 && splitKo.head.length >= 18, splitKo && splitKo.head);
assert.ok(splitKo.rest.length > 0);
const pieces = core.piecesForTranslate(longKo, 40);
assert.ok(pieces.length >= 2);
pieces.forEach((part) => assert.ok(part.length <= 40, part));

const leak = "실례합니다, 용어집: (없음) 출처: let’s go to the next slide 답변: 죄송합니다, let’s go to the next slide";
assert.strictEqual(core.cleanTranslation(leak, "let’s go to the next slide"), "");
assert.strictEqual(core.cleanTranslation("Okay, I understand. Please provide the text you would like me to translate.", "그런데"), "");
assert.strictEqual(core.pcTranslateMessages({ targetName: "한국어", glossary: "", srcText: "hello" })[0].content.indexOf("용어집"), -1);
assert.strictEqual(core.pcTranslateMessages({ targetName: "한국어", glossary: "", srcText: "hello" })[1].content, "hello");
assert.ok(core.pcTranslateMessages({ targetName: "한국어", glossary: "웨이퍼=wafer", srcText: "hello" })[0].content.indexOf("웨이퍼=wafer") > 0);

assert.strictEqual(core.cleanTranscript("oeddwn i'n gwybod", {}), "");
assert.strictEqual(core.cleanTranscript("Mae'r gweithio", {}), "");
assert.strictEqual(core.cleanTranscript("yn oedig yn oedig yn oedig", {}), "");
assert.strictEqual(core.cleanTranscript("[BLANK_AUDIO] hello [INAUDIBLE]", {}), "hello");
assert.strictEqual(core.cleanTranscript("(upbeat music)", {}), "");
assert.strictEqual(core.cleanTranscript("(rock music) (laughter) (engine revving)", {}), "");
assert.strictEqual(core.cleanTranscript("[Music]", {}), "");
assert.strictEqual(core.cleanTranscript("Thank you for watching", { lowEnergy: true }), "");
assert.strictEqual(core.cleanTranscript("구독과 좋아요 부탁드립니다", { lowEnergy: true }), "");
assert.strictEqual(core.cleanTranscript("수고하셨습니다", { lowEnergy: true }), "");
assert.strictEqual(core.cleanTranscript("Thank you for watching", { lowEnergy: false }), "Thank you for watching");
assert.strictEqual(core.cleanTranscript("hello there", {}), "hello there");

console.log("rtb-core tests ok");
console.log("low-rms-ratio", ratioLow.toFixed(3), "high-rms-ratio", ratioHigh.toFixed(3));
console.log("low-peak", core.pcmPeak(quieted).toFixed(3), "high-peak", core.pcmPeak(boosted).toFixed(3));
