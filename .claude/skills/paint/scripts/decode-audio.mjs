// decode-audio.mjs IN OUT.wav — decode any audio Chrome can play (Opus in
// .m4a from Suno, for one) to a 16-bit WAV, using the paint daemon's headless
// Chrome. The whole file, untouched: no trimming, no resampling.
import fs from 'node:fs';
const [inp, out] = process.argv.slice(2);
const port = +(process.env.INK_CDP_PORT || 9339);
const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const ev = (expr) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); })
  .then((m) => { if (m.result.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text); return m.result.result.value; });
const b64 = fs.readFileSync(inp).toString('base64');
await ev('window.__a = ""');
for (let i = 0; i < b64.length; i += 1 << 20) await ev(`window.__a += ${JSON.stringify(b64.slice(i, i + (1 << 20)))}`);
const info = await ev(`(async () => {
  const s = atob(window.__a), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  const ctx = new OfflineAudioContext(2, 48000, 48000);
  const buf = await ctx.decodeAudioData(u.buffer);
  const n = buf.length, ch = buf.numberOfChannels, pcm = new Int16Array(n * ch);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) pcm[i * ch + c] = Math.max(-32768, Math.min(32767, Math.round(d[i] * 32767))); }
  const b = new Uint8Array(pcm.buffer); let out = ''; for (let i = 0; i < b.length; i += 0x8000) out += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  window.__p = btoa(out);
  return { rate: buf.sampleRate, ch, n, len: window.__p.length };
})()`);
let p = '';
for (let i = 0; i < info.len; i += 1 << 20) p += await ev(`window.__p.slice(${i}, ${i + (1 << 20)})`);
const pcm = Buffer.from(p, 'base64');
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(info.ch, 22);
h.writeUInt32LE(info.rate, 24); h.writeUInt32LE(info.rate * info.ch * 2, 28); h.writeUInt16LE(info.ch * 2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
fs.writeFileSync(out, Buffer.concat([h, pcm]));
await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
console.log(`decoded ${(info.n / info.rate).toFixed(3)} s, ${info.ch} ch, ${info.rate} Hz → ${out}`);
process.exit(0);
