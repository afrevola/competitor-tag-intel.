// Pricing: plan / tier / ticket tables pulled from pricing, plans, membership, pass and ticket pages
// (any industry). Works on the page text the promo scan saves.

const PRICE_PAGE = /pricing|\/prices?\b|\/plans?\b|membership|subscri|\/pass(es)?\b|season-?pass|tickets?|\/rates?\b|packages?|\/compare-plans|\/buy\b|\/shop\/plans|\/join\b/i;
const MONEY = '(?:US\\$|C\\$|A\\$|[$£€¥₹])\\s?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?(?!\\d)';
const UNIT = '\\s*(?:\\/\\s*|per\\s+|a\\s+)?(seat|user|member|person|guest|night|ticket|agent|device|location|month|mo|year|yr|annually|week|day|hour|game)?\\.?(?:\\s*\\/\\s*(month|mo|year|yr|night))?';
const STOP = new Set(['Total', 'Save', 'Billed', 'Only', 'From', 'Starting', 'Get', 'Try', 'Buy', 'Was', 'Now', 'Plus', 'And', 'The', 'Per', 'Includes', 'Special', 'Yearly', 'Monthly', 'Annual', 'Choose', 'Price', 'Pricing', 'Popular', 'Most', 'Best', 'Value', 'Recommended', 'New', 'Sale', 'Off', 'Of', 'Credits', 'Discount']);

// Name written just before the price: last capitalized word(s) after a sentence or camel-case break
function nameBefore(text, idx) {
  let pre = text.slice(Math.max(0, idx - 60), idx);
  pre = pre.replace(/([a-z0-9.!?:)])([A-Z])/g, '$1|$2').split(/[|.!?:;•·\n]/).pop().trim();
  const words = pre.split(/\s+/).filter(Boolean);
  const keep = [];
  for (let i = words.length - 1; i >= 0 && keep.length < 3; i--) {
    const w = words[i].replace(/[^\w+&'’-]/g, '');
    if (!w || !/^[A-Z0-9+]/.test(w) || STOP.has(w)) break;
    keep.unshift(w);
  }
  return keep.join(' ');
}
// Label written just after the price ("$600 - Super early bird", "$49/month Squad")
function labelAfter(text, end) {
  const m = text.slice(end, end + 40).match(/^\s*[-–—:]\s*([A-Za-z][A-Za-z ]{2,28}?)(?=\s*(?:[-–—$£€¥₹]|Sold|\d|$|[A-Z][a-z]+[A-Z]))/);
  return m ? m[1].trim() : '';
}

export function extractPricing(pages = []) {
  const out = [];
  for (const p of pages) {
    if (!p.text) continue;
    const url = p.finalUrl || p.url || '';
    const head = `${p.title || ''} ${(p.h1 || []).join(' ')} ${(p.h2 || []).join(' ')}`;
    if (!PRICE_PAGE.test(url) && !/pricing|plans|membership|tickets|passes|rates/i.test(head)) continue;
    const text = p.text;
    const re = new RegExp(`(${MONEY})${UNIT}`, 'g');
    const tiers = [];
    const seen = new Set();
    // Section headings (pass / plan names) and where they sit in the text
    const heads = [...(p.h2 || []), ...(p.h1 || [])].map((h) => h.replace(/\s+/g, ' ').trim()).filter((h) => h.length > 2 && h.length < 60)
      .map((h) => ({ h, at: text.indexOf(h) })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at);
    const headingBefore = (idx) => { let last = ''; for (const x of heads) { if (x.at < idx) last = x.h; else break; } return last; };
    for (const m of text.matchAll(re)) {
      const price = m[1].replace(/\s+/g, '');
      const unit = [m[2], m[3]].filter(Boolean).join(' / ').replace(/\bmo\b/, 'month').replace(/\byr\b/, 'year') || null;
      const ctx = text.slice(Math.max(0, m.index - 30), m.index);
      // skip totals, savings, add-on math and strike-throughs
      if (/total(?: of)?\s*$|=\s*$|save\s*(?:up to)?\s*$|off\s*$|x\s*\d+\s*seats?\s*=?\s*$|-\s*$|\+\s*$|[$£€¥₹]\s?[\d,.]+\s*$/i.test(ctx)) continue;
      if (/^\s*(off|x\s*\d)/i.test(text.slice(m.index + m[0].length, m.index + m[0].length + 6))) continue;
      let name = nameBefore(text, m.index);
      const after = labelAfter(text, m.index + m[0].length);
      if (after) {
        // "£300 - Early bird": the label after the price names the price step; the section heading names the option
        const h = headingBefore(m.index);
        name = h && !/register|pricing|plans|faq|tickets/i.test(h) ? `${h} · ${after}` : after;
      }
      if (!name || !/[A-Za-z]/.test(name)) continue;
      const key = `${name}|${price}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tiers.push({ name: name.slice(0, 80), price, unit });
      if (tiers.length >= 16) break;
    }
    if (!tiers.length) continue;
    const save = text.match(/save\s*(?:up to\s*)?(\d{1,2})\s?%/i);
    const notes = [];
    if (save && /year|annual/i.test(text)) notes.push(`${save[1]}% off for annual billing`);
    else if (save) notes.push(`save ${save[1]}%`);
    if (/billed annually/i.test(text)) notes.push('prices shown billed annually');
    if (/no credit card/i.test(text)) notes.push('free trial, no credit card');
    else if (/free trial|try (it )?for free|start free/i.test(text)) notes.push('free trial');
    const special = text.match(/special offer:?\s*(?:[$£€]\s?\d+|\d+\s?%)\s*off(?:\s*\/\s*(?:month|mo|year))?/i);
    if (special) notes.push(special[0].replace(/\s+/g, ' ').trim());
    if (/credits?\s*=\s*\$\d+[^.]{0,40}discount\s*=\s*-\$\d+/i.test(text)) notes.push('included AI/usage credits are priced, then discounted to $0');
    const group = text.match(/(\d{1,2})\s?% discount when you buy (\d+) or more \w+|groups? of (\d+) or more[^.]{0,40}?(\d{1,2})\s?%/i);
    if (group) notes.push(group[0].replace(/\s+/g, ' ').trim());
    if (/sold out/i.test(text)) notes.push('some options sold out');
    const seats = text.match(/team size:?\s*(\d+)\s*seats?/i);
    if (seats) notes.push(`prices shown for ${seats[1]} seats`);
    // The same table on many pages (one per location) is listed once
    const sig = tiers.map((t) => t.name + t.price).join('|');
    const twin = out.find((o) => o._sig === sig);
    if (twin) { twin.alsoOn.push(url); continue; }
    out.push({ _sig: sig, alsoOn: [], url, title: (p.h1?.[0] || p.title || '').trim().slice(0, 80), tiers, notes: [...new Set(notes)] });
  }
  for (const o of out) delete o._sig;
  return out;
}
