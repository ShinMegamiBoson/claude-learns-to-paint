// Serve byte ranges for the video, so Safari on iPhone can play it
// (Pages' static assets answer every range request with the whole file).
export async function onRequest({ request, env }) {
  const res = await env.ASSETS.fetch(request);
  const range = request.headers.get('Range');
  if (!range || res.status !== 200) return res;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m || (m[1] === '' && m[2] === '')) return res;
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  const headers = new Headers(res.headers);
  headers.set('Accept-Ranges', 'bytes');
  if (start >= size || start > end) {
    headers.set('Content-Range', `bytes */${size}`);
    headers.delete('Content-Length');
    return new Response(null, { status: 416, headers });
  }
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  const body = start === 0 && end === size - 1 ? buf : buf.slice(start, end + 1);
  return new Response(body, { status: 206, headers });
}
