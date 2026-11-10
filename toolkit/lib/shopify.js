// Shopify stores configure most pixels through Shopify itself (apps and "customer events"), not a tag manager.
// The storefront publishes that configuration (webPixelsConfigList) in its HTML; this turns it into
// vendors, account IDs and conversions.
import { detectVendors } from './vendors.js';

const parse = (s) => { if (s && typeof s === 'object') return s; try { return JSON.parse(s); } catch { return null; } };
// Some app configs are JSON inside a JSON string ({"config":"{\"google_tag_ids\":…}"})
const deep = (v) => {
  const o = parse(v);
  if (!o || typeof o !== 'object') return o;
  for (const k of Object.keys(o)) if (typeof o[k] === 'string' && /^\s*[{[]/.test(o[k])) { const x = parse(o[k]); if (x) o[k] = deep(x); }
  return o;
};

// Shopify fires these app pixels on its standard customer events; purchase values come from the order itself
const SHOPIFY_VALUE = 'order total (sent by Shopify)';

function identify(cfg, raw) {
  const s = JSON.stringify(cfg || raw || '');
  const c = cfg?.config && typeof cfg.config === 'object' ? cfg.config : cfg || {};
  if (c.google_tag_ids || c.gtag_events) return 'Google & YouTube';
  if (/axon/i.test(s)) return 'AppLovin (Axon)';
  if (c.mparticleKey) return 'mParticle';
  if (c.webPixelConfig && c.accountID) return 'Klaviyo';
  if (c.pixel_id && /facebook|meta|capi/i.test(s)) return 'Meta Pixel';
  if (c.pixelId && /^\d{12,17}$/.test(String(c.pixelId))) return 'Meta Pixel';
  if (c.pixelCode || c.pixel_code) return 'TikTok';
  if (c.tagId && /^\d{10,14}$/.test(String(c.tagId))) return 'Pinterest';
  // Generic: any known vendor in the settings, ignoring the store's own myshopify domain
  return detectVendors(s.replace(/[\w-]+\.myshopify\.com/g, '')).filter((v) => v !== 'Shopify')[0] || null;
}
// Where an unidentified app sends its data, if its settings say
const sendsTo = (cfg) => { const m = JSON.stringify(cfg || '').match(/https?:\\?\/\\?\/([\w.-]+)/); return m ? m[1].replace(/^(collect|api|track|t)\./, '') : null; };

export function analyzeShopify(page) {
  const sh = page?.shopify;
  if (!sh) return null;
  const pixels = [];
  const ids = []; // [platform, id, source]
  const conversions = [];
  for (const p of sh.webPixels || []) {
    const cfg = deep(p.config);
    const app = p.type === 'CUSTOM' ? 'Custom pixel (code added in Shopify settings)'
      : p.apiClientId === 'shopify-pixel' ? "Shopify's own pixel"
      : identify(cfg, p.config) || (sendsTo(cfg) ? `Unidentified app (sends to ${sendsTo(cfg)})` : `Unidentified app (Shopify app #${p.apiClientId})`);
    const src = `Shopify pixel: ${app}`;
    const c = cfg?.config && typeof cfg.config === 'object' ? cfg.config : cfg || {};
    const events = [];
    if (app === 'Google & YouTube') {
      for (const t of c.google_tag_ids || []) ids.push([/^AW-/.test(t) ? 'Google Ads' : /^G-/.test(t) ? 'GA4' : 'Google tag', t, src]);
      for (const ev of c.gtag_events || []) {
        const labels = [].concat(ev.action_label || []);
        for (const l of labels) {
          const [acct, label] = String(l).split('/');
          if (/^AW-/.test(acct)) {
            ids.push(['Google Ads', acct, src]);
            if (label) conversions.push({ platform: 'Google Ads', account: acct, event: `${ev.type} (${label})`, label, value: /purchase/.test(ev.type) ? SHOPIFY_VALUE : null, shopifyEvent: ev.type });
          } else if (/^G-/.test(acct)) {
            ids.push(['GA4', acct, src]);
            conversions.push({ platform: 'GA4', account: acct, event: ev.type, label: ev.type, value: /purchase|checkout|cart|payment|shipping/.test(ev.type) ? SHOPIFY_VALUE : null, shopifyEvent: ev.type });
          } else if (/^MC-/.test(acct)) ids.push(['Google Merchant Center', acct, src]);
          events.push(ev.type);
        }
      }
    } else if (app === 'Meta Pixel') {
      const id = c.pixel_id || c.pixelId;
      ids.push(['Meta Pixel', id, src]);
      conversions.push({ platform: 'Meta Pixel', account: String(id), event: 'Shopify standard events (incl. Purchase)', label: 'Purchase', value: SHOPIFY_VALUE, shopifyEvent: 'checkout_completed' });
    } else if (app === 'TikTok') {
      const id = c.pixelCode || c.pixel_code;
      ids.push(['TikTok', id, src]);
      conversions.push({ platform: 'TikTok', account: id, event: 'Shopify standard events (incl. CompletePayment)', label: 'CompletePayment', value: SHOPIFY_VALUE, shopifyEvent: 'checkout_completed' });
    } else if (app === 'Pinterest') {
      ids.push(['Pinterest', c.tagId, src]);
      conversions.push({ platform: 'Pinterest', account: String(c.tagId), event: 'Shopify standard events (incl. checkout)', label: 'checkout', value: SHOPIFY_VALUE, shopifyEvent: 'checkout_completed' });
    } else if (app === 'AppLovin (Axon)') {
      if (c.eventKey) ids.push(['AppLovin (Axon)', c.eventKey, src]);
      conversions.push({ platform: 'AppLovin (Axon)', account: c.name || c.eventKey || null, event: 'Shopify standard events (incl. purchase)', label: 'purchase', value: SHOPIFY_VALUE, shopifyEvent: 'checkout_completed' });
    } else if (app === 'Klaviyo') ids.push(['Klaviyo', c.accountID, src]);
    else if (app === 'ShareASale') { ids.push(['ShareASale', c.merchantID, src]); conversions.push({ platform: 'ShareASale', account: c.merchantID ? 'merchant ' + c.merchantID : null, event: 'affiliate sale (Shopify checkout)', label: 'sale', value: SHOPIFY_VALUE, shopifyEvent: 'checkout_completed' }); }
    else if (app === 'mParticle') ids.push(['mParticle', c.mparticleKey, src]);
    pixels.push({
      app, type: p.type, appId: p.apiClientId || null, runtime: p.runtime || null,
      purposes: p.purposes || [], events, settings: Object.keys(c).filter((k) => !/key|token|secret/i.test(k)).slice(0, 12),
    });
  }
  const apps = [...new Set(sh.appEmbeds || [])].map((h) => ({ handle: h, vendor: detectVendors(h)[0] || null }));
  const vendors = [...new Set([
    ...pixels.map((p) => p.app).filter((a) => !/^(Custom pixel|Unidentified|Google & YouTube|Shopify's own)/.test(a)),
    ...(pixels.some((p) => p.app === 'Google & YouTube') ? ['Google Ads'] : []),
    ...apps.map((a) => a.vendor).filter(Boolean),
  ])];
  return {
    shop: sh.shop, theme: sh.theme, currency: sh.currency, country: sh.country,
    pixels, apps, vendors, ids: ids.filter(([, id]) => id), conversions,
  };
}

// Extract the webPixelsConfigList array from a storefront script (balanced brackets, string-aware)
export function sliceJsonArray(text, from) {
  const start = text.indexOf('[', from);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}
