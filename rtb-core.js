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

  function fixSentenceSpace(text) {
    return String(text || "").replace(/([.?!…])(?=[가-힣A-Za-z])/g, "$1 ");
  }

  function splitTranscriptLine(text, maxChars) {
    var t = fixSentenceSpace(String(text || "").replace(/\s+/g, " ").trim());
    var max = Math.round(Number(maxChars) || 45);
    if (max < 8) max = 8;
    if (t.length <= max) return null;
    var windowText = t.slice(0, max);
    var floor = Math.floor(max * 0.4);
    var best = -1;
    var i;
    for (i = windowText.length - 1; i >= floor; i--) {
      if (".?!…".indexOf(windowText.charAt(i)) >= 0) {
        best = i + 1;
        break;
      }
    }
    if (best < 0) {
      for (i = windowText.length - 1; i >= floor; i--) {
        var ch = windowText.charAt(i);
        if (ch === "," || ch === "，") {
          best = i + 1;
          break;
        }
      }
    }
    if (best < 0) {
      var space = windowText.lastIndexOf(" ");
      if (space >= floor) best = space;
    }
    if (best < 0) best = max;
    var head = t.slice(0, best).trim();
    var rest = t.slice(best).trim();
    if (!head) return null;
    return { head: head, rest: rest };
  }

  function piecesForTranslate(text, maxChars) {
    var parts = [];
    var rest = fixSentenceSpace(String(text || "").replace(/\s+/g, " ").trim());
    var guard = 0;
    while (rest && guard < 12) {
      guard += 1;
      var split = splitTranscriptLine(rest, maxChars);
      if (!split || !split.rest) {
        parts.push(rest);
        break;
      }
      parts.push(split.head);
      rest = split.rest;
    }
    return parts;
  }

  function normUtterance(text) {
    return String(text || "").replace(/\s+/g, "").toLowerCase();
  }

  function sameUtterance(a, b) {
    var left = normUtterance(a);
    var right = normUtterance(b);
    return !!left && left === right;
  }

  function repeatsSource(out, source) {
    var src = normUtterance(source);
    var text = normUtterance(out);
    if (!src || src.length < 8) return sameUtterance(out, source);
    return text.indexOf(src) >= 0;
  }

  function cleanTranslation(text, source) {
    var t = cleanModelOutput(text);
    var phrases = [
      "용어집: (없음)",
      "용어집:(없음)",
      "Reply with the translation only.",
      "Reply with the translation only",
      "Do not repeat the source.",
      "Okay, I understand. Please provide the text you would like me to translate.",
      "Okay, I understand. Please provide the text",
      "Please provide the text you would like me to translate",
      "Please provide the text"
    ];
    var i;
    for (i = 0; i < phrases.length; i++) {
      if (t.indexOf(phrases[i]) >= 0) t = t.split(phrases[i]).join(" ");
    }
    t = t.replace(/(?:^|[\s,])(?:용어집|출처|답변|출력|Source|Reply)\s*:\s*/gi, " ");
    t = t.replace(/\s+/g, " ").trim();
    t = t.replace(/^(실례합니다|죄송합니다)[, ]*/g, "").trim();
    if (!t) return "";
    if (source && repeatsSource(t, source)) return "";
    return t;
  }

  function pcTranslateMessages(spec) {
    spec = spec || {};
    var gloss = glossaryBlock(spec.glossary);
    var system = "Translate into " + (spec.targetName || "") + " only. Reply with the translation only. Do not repeat the source. Do not add Source, Reply, glossary, or labels.";
    if (gloss) system += "\n" + gloss;
    return [
      { role: "system", content: system },
      { role: "user", content: String(spec.srcText || "") }
    ];
  }

  function isLoopHallucination(text) {
    var parts = String(text || "").toLowerCase().split(/\s+/).filter(function (part) { return part; });
    if (parts.length < 6) return false;
    var counts = {};
    var i;
    var max = 0;
    for (i = 0; i < parts.length; i++) {
      counts[parts[i]] = (counts[parts[i]] || 0) + 1;
      if (counts[parts[i]] > max) max = counts[parts[i]];
    }
    return max >= 3 && max / parts.length >= 0.4;
  }

  function looksWelsh(text) {
    var t = String(text || "").toLowerCase();
    if (/\b(oeddwn|gwybod|gweithio|oedig)\b/.test(t)) return true;
    if (/\b(mae'r|i'n|o'r)\b/.test(t)) return true;
    return false;
  }

  function isStockHallucination(text) {
    var t = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!t) return false;
    var phrases = [
      "구독과 좋아요 부탁드립니다",
      "구독 좋아요 부탁드립니다",
      "수고하셨습니다",
      "thank you for watching",
      "thanks for watching"
    ];
    var i;
    for (i = 0; i < phrases.length; i++) {
      if (t === phrases[i] || t.indexOf(phrases[i]) === 0 && t.length < phrases[i].length + 8) return true;
    }
    return false;
  }

  function cleanTranscript(text, spec) {
    spec = spec || {};
    var t = String(text || "");
    t = t.replace(/\[(?:BLANK_AUDIO|INAUDIBLE|Music|MUSIC|music)\]/g, " ");
    t = t.replace(/\((?:upbeat music|rock music|laughter|engine revving|music|applause)\)/gi, " ");
    t = fixSentenceSpace(t.replace(/\s+/g, " ").trim());
    if (!t) return "";
    if (isLoopHallucination(t) || looksWelsh(t)) return "";
    if (spec.lowEnergy && isStockHallucination(t)) return "";
    return t;
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

  var EMPTY_HEARD_LIMIT = 5;
  var EMPTY_HEARD_GAP = 60000;

  function chunkWorthSending(preLevel, postLevel, gate) {
    var line = gate == null ? 8 : gate;
    return preLevel >= 8 || postLevel >= line;
  }

  function emptyHeardNotice(state, now) {
    state = state || {};
    var streak = state.streak || 0;
    var noticeAt = state.noticeAt || 0;
    now = now || 0;
    if (noticeAt && now - noticeAt < EMPTY_HEARD_GAP) {
      return { streak: streak, noticeAt: noticeAt, tell: false };
    }
    streak += 1;
    if (streak < EMPTY_HEARD_LIMIT) {
      return { streak: streak, noticeAt: noticeAt && now - noticeAt >= EMPTY_HEARD_GAP ? 0 : noticeAt, tell: false };
    }
    return { streak: 0, noticeAt: now, tell: true };
  }

  function clearEmptyHeard(state) {
    state = state || {};
    return { streak: 0, noticeAt: state.noticeAt || 0 };
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

  // Whisper 스트리밍.
  // 약 1초마다 모아 둔 소리(최대 15초)를 다시 전사하고,
  // 직전 결과와 이번 결과에서 같은 앞부분만 확정한다.
  // 문장 부호, 짧은 쉼, 줄 길이에서 그 확정분을 번역으로 넘긴다.
  var STREAM_EVERY_SAMPLES = 16000;
  var STREAM_MIN_SAMPLES = 12800;
  var STREAM_MAX_SAMPLES = 16000 * 15;

  function streamNorm(text) {
    return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function streamTokens(text) {
    var raw = String(text || "").replace(/\s+/g, " ").trim();
    if (!raw) return [];
    var parts = raw.split(" ");
    var out = [];
    var i;
    for (i = 0; i < parts.length; i++) {
      var part = parts[i];
      var matched = part.match(/^(.*?)([.?!…。？！]+)$/);
      if (matched && matched[1]) {
        out.push(matched[1]);
        out.push(matched[2]);
      } else if (part) {
        out.push(part);
      }
    }
    return out;
  }

  function joinStreamTokens(tokens) {
    var out = "";
    var i;
    for (i = 0; i < tokens.length; i++) {
      var tok = tokens[i];
      if (!tok) continue;
      if (/^[.?!…。？！]+$/.test(tok)) out += tok;
      else out += (out ? " " : "") + tok;
    }
    return out.replace(/\s+/g, " ").trim();
  }

  function streamAgree(prev, curr) {
    var a = streamTokens(prev);
    var b = streamTokens(curr);
    var i = 0;
    while (i < a.length && i < b.length && streamNorm(a[i]) === streamNorm(b[i])) i++;
    var confirmed = joinStreamTokens(b.slice(0, i));
    var full = joinStreamTokens(b);
    var tail = full.indexOf(confirmed) === 0 ? full.slice(confirmed.length).trim() : joinStreamTokens(b.slice(i));
    return { confirmed: confirmed, tail: tail, full: full };
  }

  function streamExtend(held, prev, curr) {
    var agree = streamAgree(prev, curr);
    var confirmed = agree.confirmed;
    var full = agree.full;
    held = String(held || "").replace(/\s+/g, " ").trim();
    if (held) {
      if (full.indexOf(held) === 0) {
        if (confirmed.indexOf(held) !== 0) confirmed = held;
      } else {
        confirmed = streamAgree(held, full).confirmed;
      }
    }
    var tail = "";
    if (confirmed && full.indexOf(confirmed) === 0) tail = full.slice(confirmed.length).trim();
    else if (!confirmed) tail = full;
    else tail = agree.tail;
    return { prev: full, confirmed: confirmed, tail: tail };
  }

  function streamLastPunct(text) {
    var t = String(text || "").replace(/\s+/g, " ").trim();
    var last = -1;
    var i;
    for (i = 0; i < t.length; i++) {
      if (".?!…。？！".indexOf(t.charAt(i)) >= 0) last = i;
    }
    if (last < 0) return { commit: "", keep: t };
    return { commit: t.slice(0, last + 1).trim(), keep: t.slice(last + 1).trim() };
  }

  function streamCommit(confirmed, tail, spec) {
    spec = spec || {};
    var text = String(confirmed || "").replace(/\s+/g, " ").trim();
    var restTail = String(tail || "").replace(/\s+/g, " ").trim();
    var maxChars = Math.round(Number(spec.maxChars) || 45);
    if (maxChars < 8) maxChars = 8;
    if (spec.force) {
      return {
        commit: [text, restTail].filter(Boolean).join(" ").trim(),
        keepConfirmed: "",
        keepTail: ""
      };
    }
    var commit = "";
    var keep = text;
    var cut = streamLastPunct(text);
    if (cut.commit) {
      commit = cut.commit;
      keep = cut.keep;
    }
    if (!commit && text.length > maxChars) {
      var split = splitTranscriptLine(text, maxChars);
      if (split && split.head) {
        commit = split.head;
        keep = split.rest;
      }
    }
    if (spec.pause) {
      commit = [commit, keep].filter(Boolean).join(" ").trim();
      keep = "";
    }
    return { commit: commit, keepConfirmed: keep, keepTail: restTail };
  }

  function streamTrimSeconds(segments, committed) {
    var want = streamNorm(committed);
    if (!want || !segments || !segments.length) return 0;
    var acc = "";
    var end = 0;
    var i;
    for (i = 0; i < segments.length; i++) {
      var seg = segments[i] || {};
      var piece = streamNorm(seg.text);
      if (!piece) continue;
      var next = acc ? acc + " " + piece : piece;
      var segEnd = Number(seg.end);
      if (!isFinite(segEnd) || segEnd < 0) segEnd = end;
      if (want.indexOf(next) === 0 || next.indexOf(want) === 0) {
        acc = next;
        end = segEnd;
        if (next.length >= want.length || next.indexOf(want) === 0) return end;
      } else if (acc && want.indexOf(acc) === 0) {
        return end;
      } else {
        break;
      }
    }
    return end;
  }

  function streamTrimRatio(committed, full) {
    var c = streamNorm(committed).length;
    var f = streamNorm(full).length;
    if (!c || !f) return 0;
    var ratio = c / f;
    if (ratio > 1) ratio = 1;
    return ratio;
  }

  function pcApplyEngine(engine) {
    return engine === "whisper-stream" ? "whisper" : String(engine || "whisper");
  }

  // 언어1과 언어2가 다르면 양쪽을 듣고, 같으면 그 언어만 지정한다.
  function sttLanguage(lang1, lang2) {
    var a = String(lang1 || "").trim();
    var b = String(lang2 || "").trim();
    if (a && a === b) return a;
    return "auto";
  }

  function scriptKind(text) {
    var stats = { hangul: 0, latin: 0, han: 0, kana: 0, cyr: 0, thai: 0 };
    var s = String(text || "");
    var i;
    for (i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xac00 && c <= 0xd7a3) stats.hangul++;
      else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) stats.latin++;
      else if (c >= 0x4e00 && c <= 0x9fff) stats.han++;
      else if (c >= 0x3040 && c <= 0x30ff) stats.kana++;
      else if (c >= 0x0400 && c <= 0x04ff) stats.cyr++;
      else if (c >= 0x0e00 && c <= 0x0e7f) stats.thai++;
    }
    var best = "";
    var n = 0;
    var tie = false;
    var name;
    for (name in stats) {
      if (!Object.prototype.hasOwnProperty.call(stats, name)) continue;
      if (stats[name] > n) {
        best = name;
        n = stats[name];
        tie = false;
      } else if (stats[name] === n && n > 0) {
        tie = true;
      }
    }
    if (!n || tie) return "";
    return best;
  }

  function langScript(lang) {
    if (lang === "ko") return "hangul";
    if (lang === "ja") return "kana";
    if (lang === "zh") return "han";
    if (lang === "ru") return "cyr";
    if (lang === "th") return "thai";
    return "latin";
  }

  function pickHeardLang(text, serverLang, lang1, lang2) {
    var a = String(lang1 || "").trim();
    var b = String(lang2 || "").trim();
    if (a && a === b) return a;
    var kind = scriptKind(text);
    var aOk = !!(kind && langScript(a) === kind);
    var bOk = !!(kind && langScript(b) === kind);
    if (aOk && !bOk) return a;
    if (bOk && !aOk) return b;
    var server = String(serverLang || "").trim().toLowerCase();
    if (server === a || server === b) return server;
    return "";
  }

  function asrListenPrompt(lang1, lang2) {
    var a = String(lang1 || "").trim();
    var b = String(lang2 || "").trim();
    if (a && a === b) {
      return "말한 언어는 " + a + " 이다. 들린 말을 그 언어의 글자로만 받아 적어라. 다른 언어로 옮기지 마라. 응답은 JSON {\"lang\":\"" + a + "\",\"text\":\"...\"} 만.";
    }
    return "말한 언어는 " + a + " 또는 " + b + " 이다. 들린 말을 그 언어의 글자로만 받아 적어라. 다른 언어로 옮기지 마라. 어느 쪽인지는 소리로 정하라. 둘 다 아니면 text는 빈 문자열로 하라. 응답은 JSON {\"lang\":\"" + a + " 또는 " + b + "\",\"text\":\"...\"} 만.";
  }

  return {
    EMPTY_RECENT: EMPTY_RECENT,
    PC_MODELS: PC_MODELS,
    parseGlossary: parseGlossary,
    glossaryBlock: glossaryBlock,
    recentSourceBlock: recentSourceBlock,
    joinBlocks: joinBlocks,
    cleanModelOutput: cleanModelOutput,
    fixSentenceSpace: fixSentenceSpace,
    splitTranscriptLine: splitTranscriptLine,
    piecesForTranslate: piecesForTranslate,
    sameUtterance: sameUtterance,
    repeatsSource: repeatsSource,
    cleanTranslation: cleanTranslation,
    pcTranslateMessages: pcTranslateMessages,
    cleanTranscript: cleanTranscript,
    isLoopHallucination: isLoopHallucination,
    looksWelsh: looksWelsh,
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
    chunkWorthSending: chunkWorthSending,
    emptyHeardNotice: emptyHeardNotice,
    clearEmptyHeard: clearEmptyHeard,
    EMPTY_HEARD_LIMIT: EMPTY_HEARD_LIMIT,
    EMPTY_HEARD_GAP: EMPTY_HEARD_GAP,
    MIC_HIGH_MAX: MIC_HIGH_MAX,
    MIC_LOW_GAIN: MIC_LOW_GAIN,
    fastUnitCount: fastUnitCount,
    fastDelta: fastDelta,
    fastEndsSentence: fastEndsSentence,
    fastTranslateWait: fastTranslateWait,
    STREAM_EVERY_SAMPLES: STREAM_EVERY_SAMPLES,
    STREAM_MIN_SAMPLES: STREAM_MIN_SAMPLES,
    STREAM_MAX_SAMPLES: STREAM_MAX_SAMPLES,
    streamAgree: streamAgree,
    streamExtend: streamExtend,
    streamCommit: streamCommit,
    streamTrimSeconds: streamTrimSeconds,
    streamTrimRatio: streamTrimRatio,
    pcApplyEngine: pcApplyEngine,
    sttLanguage: sttLanguage,
    pickHeardLang: pickHeardLang,
    asrListenPrompt: asrListenPrompt
  };
});
