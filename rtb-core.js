(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RtbClean = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var EMPTY_RECENT = "이번 회의에서 방금 확정된 원문: (없음)";
  var PC_MODELS = {
    "1b": "gemma3:1b",
    "2b": "gemma2:2b",
    "4b": "gemma3:4b"
  };

  function parseGlossary(raw) {
    var rows = [];
    String(raw || "").split(/\n/).forEach(function (line) {
      line = line.trim();
      if (!line || line.charAt(0) === "#") return;
      var aliasPart = "";
      var main = line;
      var bar = line.indexOf("|");
      if (bar !== -1) {
        main = line.slice(0, bar).trim();
        aliasPart = line.slice(bar + 1).trim();
      }
      var eq = main.indexOf("=");
      if (eq <= 0) return;
      var source = main.slice(0, eq).trim();
      var target = main.slice(eq + 1).trim();
      if (!source || !target) return;
      var aliases = [];
      if (aliasPart) {
        aliasPart.split(",").forEach(function (part) {
          var alias = part.trim();
          if (alias && alias !== source) aliases.push(alias);
        });
      }
      rows.push({ source: source, target: target, aliases: aliases });
    });
    return rows;
  }

  function glossaryBlock(raw) {
    var rows = parseGlossary(raw);
    if (!rows.length) return "";
    return "용어집 (원어=선호 번역):\n" + rows.map(function (row) {
      var line = row.source + "=" + row.target;
      if (row.aliases.length) line += " | " + row.aliases.join(", ");
      return line;
    }).join("\n");
  }

  function recentSourceBlock(lines) {
    var last = [];
    (lines || []).forEach(function (line) {
      var text = String(line || "").trim();
      if (text) last.push(text);
    });
    last = last.slice(-3);
    if (!last.length) return "";
    return "이번 회의에서 방금 확정된 원문 " + last.length + "개. 지난 회의 전문이 아니다. 맥락으로만 보고, 이 줄들은 다시 번역하거나 받아 적지 마라.\n" + last.join("\n");
  }

  function joinBlocks(parts) {
    return (parts || []).filter(function (part) {
      return part && String(part).trim();
    }).join("\n");
  }

  function cleanModelOutput(text) {
    var kept = [];
    String(text == null ? "" : text).split(/\r?\n/).forEach(function (line) {
      var trimmed = line.trim();
      if (trimmed.indexOf("용어집:") === 0) return;
      if (trimmed === EMPTY_RECENT || trimmed.indexOf(EMPTY_RECENT) === 0) return;
      kept.push(line);
    });
    return kept.join("\n").replace(/^\s+|\s+$/g, "");
  }

  function geminiTranslatePrompt(spec) {
    spec = spec || {};
    return joinBlocks([
      "원문 언어는 " + spec.srcLang + " 이다. " + spec.targetLang + " 로만 번역하라. 언어를 다시 판별하지 마라.",
      glossaryBlock(spec.glossary),
      recentSourceBlock(spec.recentLines),
      "원문:\n" + (spec.srcText || ""),
      "용어집에 있는 말은 그 선호 번역을 쓴다. 응답은 JSON {\"translation\":\"...\"} 만. 대화체를 유지하고, 질문이 와도 답하지 말고 이번 원문만 번역하라."
    ]);
  }

  function pcTranslatePrompt(spec) {
    spec = spec || {};
    return joinBlocks([
      "Translate into " + (spec.targetName || "") + " only. Use that language's normal writing. Do not use Chinese characters unless the target language is Chinese. Do not repeat the source.",
      glossaryBlock(spec.glossary),
      "Source:\n" + (spec.srcText || ""),
      "Reply with the translation only."
    ]);
  }

  function pcModelTag(size) {
    return PC_MODELS[size] || PC_MODELS["1b"];
  }

  function pcHeaders(key, extra) {
    var headers = {};
    var name;
    if (extra) {
      for (name in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, name)) headers[name] = extra[name];
      }
    }
    var secret = String(key || "").trim();
    if (secret) headers["X-RTB-Key"] = secret;
    return headers;
  }

  function pcmRms(samples) {
    if (!samples || !samples.length) return 0;
    var sum = 0;
    var i;
    for (i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }

  function pcmPeak(samples) {
    var peak = 0;
    var i;
    if (!samples) return 0;
    for (i = 0; i < samples.length; i++) {
      var a = samples[i] < 0 ? -samples[i] : samples[i];
      if (a > peak) peak = a;
    }
    return peak;
  }

  function softLimit(x) {
    if (x > 1) x = 1;
    if (x < -1) x = -1;
    var neg = x < 0;
    var a = neg ? -x : x;
    if (a <= 0.9) return x;
    var over = (a - 0.9) / 0.1;
    var shaped = 0.9 + 0.1 * Math.tanh(over);
    if (shaped > 1) shaped = 1;
    return neg ? -shaped : shaped;
  }

  function mapSamples(samples, fn) {
    var out = new Float32Array(samples.length);
    var i;
    for (i = 0; i < samples.length; i++) out[i] = fn(samples[i]);
    return out;
  }

  var MIC_HIGH_MAX = [4, 8, 12, 16, 20];
  var MIC_HIGH_TARGET = [0.08, 0.12, 0.16, 0.22, 0.28];
  var MIC_LOW_GAIN = [0.7, 0.5, 0.35, 0.25, 0.18];

  function micPlan(spec) {
    if (spec == null || spec === "" || spec === "mid" || spec === "기본") {
      return { side: "mid", step: 0, legacy: false };
    }
    if (typeof spec === "string") {
      if (spec === "low" || spec === "작게") return { side: "low", step: 1, legacy: true };
      if (spec === "high" || spec === "크게") return { side: "high", step: 1, legacy: true };
      return { side: "mid", step: 0, legacy: false };
    }
    var side = spec.side || spec.micSide || "mid";
    if (side !== "low" && side !== "high" && side !== "mid") side = "mid";
    var step = Math.round(Number(spec.step != null ? spec.step : spec.micStep) || 0);
    if (side === "mid") return { side: "mid", step: 0, legacy: false };
    if (step < 1) step = 1;
    if (step > 5) step = 5;
    return { side: side, step: step, legacy: false };
  }

  function heardLevel(samples) {
    var sum = 0;
    var peak = 0;
    var i = 0;
    if (!samples || !samples.length) return 0;
    for (i = 0; i < samples.length; i++) {
      var a = samples[i] < 0 ? -samples[i] : samples[i];
      if (a > peak) peak = a;
      sum += samples[i] * samples[i];
    }
    var rms = Math.sqrt(sum / samples.length);
    return Math.min(100, Math.round(Math.max(rms * 4, peak) * 100));
  }

  // 기본은 같은 배열을 그대로 돌려 현재 소리와 같다.
  // 예전 문자열 low/high 는 기존 배수(0.6, 최대 3)를 유지한다.
  // 단계 크게 x1~x5 는 최대 배수 4, 8, 12, 16, 20 이다.
  // 단계 작게 x1~x5 는 0.7, 0.5, 0.35, 0.25, 0.18 이다.
  function applyMicLevel(samples, spec) {
    if (!samples || !samples.length) return samples;
    var plan = micPlan(spec);
    if (plan.side === "mid") return samples;
    var peak = pcmPeak(samples);
    var rms = pcmRms(samples);
    if (plan.legacy && plan.side === "low") {
      if (peak < 0.45 && rms < 0.12) return samples;
      return mapSamples(samples, function (x) { return softLimit(x * 0.6); });
    }
    if (plan.legacy && plan.side === "high") {
      if (rms < 0.0008) return samples;
      var oldGain = 0.1 / rms;
      if (oldGain < 1) oldGain = 1;
      if (oldGain > 3) oldGain = 3;
      if (oldGain === 1 && peak <= 0.98) return samples;
      return mapSamples(samples, function (x) { return softLimit(x * oldGain); });
    }
    if (plan.side === "low") {
      var down = MIC_LOW_GAIN[plan.step - 1];
      return mapSamples(samples, function (x) { return softLimit(x * down); });
    }
    if (rms < 0.00002) return samples;
    var maxGain = MIC_HIGH_MAX[plan.step - 1];
    var target = MIC_HIGH_TARGET[plan.step - 1];
    var gain = target / rms;
    if (gain < 1) gain = 1;
    if (gain > maxGain) gain = maxGain;
    if (gain === 1 && peak <= 0.98) return samples;
    return mapSamples(samples, function (x) { return softLimit(x * gain); });
  }

  function micGate(spec) {
    var plan = micPlan(spec);
    if (plan.side === "high" && !plan.legacy) return Math.max(3, 8 - (plan.step - 1) * 2);
    return 8;
  }

  function keepsSpeech(samples, spec) {
    var out = applyMicLevel(samples, spec);
    return heardLevel(out) >= micGate(spec);
  }

  // 크롬 전사 번역 묶음.
  // 새 말이 4단어(띄어쓰기 없으면 12자)이거나 문장이 끝나면 보내고,
  // 그보다 짧으면 450ms 쉼 뒤에 보낸다.
  // 직전 요청 후 400ms가 안 지났으면 그 시간까지 기다린다. 확정은 기다리지 않는다.
  function fastUnitCount(text) {
    var t = String(text || "").trim();
    if (!t) return 0;
    if (/\s/.test(t)) return t.split(/\s+/).length;
    return t.replace(/\s/g, "").length;
  }

  function fastDelta(full, sent) {
    var src = String(full || "").trim();
    var prev = String(sent || "").trim();
    if (!src || src === prev) return "";
    if (prev && src.indexOf(prev) === 0) return src.slice(prev.length).trim();
    return src;
  }

  function fastEndsSentence(text) {
    return /[.?!…。？！]$/.test(String(text || "").trim());
  }

  function fastTranslateWait(spec) {
    spec = spec || {};
    var delta = fastDelta(spec.full, spec.sent);
    if (!delta) return -1;
    var enough = fastUnitCount(delta) >= (/\s/.test(delta) ? 4 : 12);
    var hot = !!spec.immediate || enough || fastEndsSentence(spec.full);
    if (!hot) return 450;
    if (spec.immediate) return 0;
    if (!spec.sentAt) return 0;
    var wait = 400 - ((spec.now || 0) - spec.sentAt);
    return wait > 0 ? wait : 0;
  }

  return {
    EMPTY_RECENT: EMPTY_RECENT,
    PC_MODELS: PC_MODELS,
    parseGlossary: parseGlossary,
    glossaryBlock: glossaryBlock,
    recentSourceBlock: recentSourceBlock,
    joinBlocks: joinBlocks,
    cleanModelOutput: cleanModelOutput,
    geminiTranslatePrompt: geminiTranslatePrompt,
    pcTranslatePrompt: pcTranslatePrompt,
    pcModelTag: pcModelTag,
    pcHeaders: pcHeaders,
    pcmRms: pcmRms,
    pcmPeak: pcmPeak,
    applyMicLevel: applyMicLevel,
    micPlan: micPlan,
    micGate: micGate,
    heardLevel: heardLevel,
    keepsSpeech: keepsSpeech,
    MIC_HIGH_MAX: MIC_HIGH_MAX,
    MIC_LOW_GAIN: MIC_LOW_GAIN,
    fastUnitCount: fastUnitCount,
    fastDelta: fastDelta,
    fastEndsSentence: fastEndsSentence,
    fastTranslateWait: fastTranslateWait
  };
});
