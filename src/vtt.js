// WebVTT transcript utilities for the KIT editor.
// parse() → cues [{start, end, text}] in seconds.
// sliceRange() → cues within a clip, re-based to clip-relative time.
// toSrt() → SRT text for ffmpeg subtitle burn-in.
// toMarkedText() → "[mm:ss] line" text for clip selection by the brain.

function ts(s) { // "00:01:02.500" or "01:02.500" → seconds
  const p = s.trim().split(':').map(Number);
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return Number(s) || 0;
}

function parse(vtt) {
  const cues = [];
  const blocks = String(vtt).replace(/\r/g, '').split('\n\n');
  for (const b of blocks) {
    const lines = b.split('\n').filter(Boolean);
    const ti = lines.findIndex(l => l.includes('-->'));
    if (ti === -1) continue;
    const [a, z] = lines[ti].split('-->');
    const text = lines.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!text) continue;
    cues.push({ start: ts(a.replace(/,/g, '.')), end: ts(z.split(' ')[1] ? z.trim().split(' ')[0] : z).valueOf ? ts(z.replace(/,/g, '.').trim().split(' ')[0]) : 0, text });
  }
  return cues.filter(c => c.end > c.start);
}

function sliceRange(cues, start, end) {
  return cues.filter(c => c.end > start && c.start < end).map(c => ({
    start: Math.max(0, c.start - start),
    end: Math.min(end - start, c.end - start),
    text: c.text
  }));
}

function fmtSrt(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60), ms = Math.round((sec % 1) * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)},${String(ms).padStart(3, '0')}`;
}

function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${fmtSrt(c.start)} --> ${fmtSrt(c.end)}\n${c.text}\n`).join('\n');
}

function toMarkedText(cues, maxChars) {
  const cap = maxChars || 150000;
  let out = [];
  let last = -30;
  for (const c of cues) {
    if (c.start - last >= 15) { // timestamp marker roughly every 15s of content
      const m = Math.floor(c.start / 60), s = Math.floor(c.start % 60);
      out.push(`[${m}:${String(s).padStart(2, '0')}]`);
      last = c.start;
    }
    out.push(c.text);
  }
  let text = out.join(' ');
  if (text.length > cap) text = text.slice(0, cap) + ' …[transcript truncated]';
  return text;
}

module.exports = { parse, sliceRange, toSrt, toMarkedText };
