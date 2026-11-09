// Paste into the JavaScript tool to return everything recorded on this page so far (gzip+base64 parts, like capture.js).
await (async () => {
  
  const __tiPack = async (obj, tag) => {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    const gz = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    let bin = ''; for (let i = 0; i < gz.length; i += 0x8000) bin += String.fromCharCode.apply(null, gz.subarray(i, i + 0x8000));
    const b64 = btoa(bin), CH = 150000, n = Math.max(1, Math.ceil(b64.length / CH));
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => A[x % 62]).join('');
    const host = location.hostname;
    window.__tiPart = (i) => '__' + tag + '_PART_' + i + '_OF_' + n + '_ID_' + id + '_HOST_' + host + '__' + b64.slice(i * CH, (i + 1) * CH) + '__' + tag + '_PART_END__ ' +
      'pad:' + Array.from(crypto.getRandomValues(new Uint8Array(45000)), (x) => A[x % 62]).join('');
    return window.__tiPart(0) + ' parts=' + n + ' host=' + host;
  };
  return await __tiPack({ v: 1, url: location.href, items: (window.__tiGot || []).map((s) => JSON.parse(s)) }, 'TAGINTELREC');
})()
