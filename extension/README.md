# Tag Inspector: competitive ad-ops intel for any website

A Chrome extension that shows how a site's marketing is wired: which ad platforms and accounts it uses, what each platform is told counts as a conversion, the media mix and agency fingerprints, and a recorder for clicking through a funnel.

## Install / update
1. Unzip this folder.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. **Load unpacked** → pick the `gtm-inspector` folder. If an older version is installed, remove it first or click its reload icon.
4. Chrome will ask for permission to "read and change data on all websites". The recorder needs this to capture events from the start of each page load (details below).

## Views

**Overview**
- **Media mix:** every marketing vendor found, grouped by channel (Search, Social, Programmatic, CTV/TV, Retargeting, Affiliate, Attribution, CDP, CRM, Analytics, Testing, Session replay, Consent).
- **Agency signals:** fingerprints such as a trading desk's account name (e.g. `buzz_key=dentsu`), with evidence.
- **Ad accounts & pixel IDs:** Google Ads, Floodlight, GA4, Meta, TikTok, Snapchat, LinkedIn, Microsoft, Reddit, Pinterest, AdRoll, Trade Desk and more. Hover an ID to see where it was found.
- **See their ads:** one-click links to the Meta Ad Library, Google Ads Transparency Center, LinkedIn Ad Library and TikTok Ad Library. The brand name used for searches can be edited and is remembered per site.

**Conversions**
Every conversion tag in GTM and Adobe Launch, per platform: the event, account, value sent, and triggers. It flags:
- duplicate conversions on the same trigger
- fixed values (e.g. `1`), which count conversions instead of revenue
- purchase events sent without a value
- values scraped from page text
- "Purchase" events firing on non-purchase steps
- page visits counted as conversions
- paused tags and tags with no trigger

Commented-out code is ignored, so you see what actually runs. Exports to CSV.

**● Recorder**
Press **Record**, then click through the site in that tab (search → booking → checkout). It captures every data layer push and tracking pixel across page loads and page changes. The popup can be closed while you browse.
- **Timeline:** pages, data layer events (with price/value fields pulled out) and pixels (platform, event, account, value). Repeated identical events collapse into one row with a ×N count.
- **Pixels by platform:** each platform's events, counts, values sent, and how many carried de-duplication event IDs.
- **Funnel:** the order of the site's own events, with the prices each carried.
- **Things to check:** event bursts (e.g. an event firing 40× in 5 seconds), purchase events sent more than once, conversions without values, one platform firing to several accounts.
- Exports to CSV or JSON. Recordings live in session storage and are deleted when the tab or browser closes.

**Promos**
Press **Scan site** to read robots.txt and the sitemap, find promo, deal and campaign pages (including expired ones still online), and fetch up to 25 of them (same-site only, 3 at a time).
- **Offer calendar:** each offer with status (active / upcoming / ongoing / expired / redirects), start and end dates parsed from the fine print, prices, % off and restrictions.
- **Campaign folders:** asset folders and file names carrying fiscal quarters, campaign names and phase numbers (e.g. `q4-fy2026`, `Holiday-Campaign_Phase-1`).
- **Recently updated:** the newest pages by sitemap date, a quick way to spot launches.
- Results are cached per site, so the last scan is there next time. Exports to CSV/JSON.

**Cost**
What marketing and other third-party code costs this page load: requests, bytes and JavaScript for first-party, marketing/tag managers, other third-party (CDN, fonts, maps, payments) and unclassified, plus page timings and a per-vendor table. Some third parties hide their size from the browser; the view says when totals are a minimum and when a JavaScript share isn't reliable.

**Container views** (GTM, Google tag, Adobe Launch), **Data Layer** and **Server-side** work as before.

## Privacy and permissions
- A small script runs on every page so the recorder can capture events from the very start of each page load. It only observes: every function it hooks passes through to the original unchanged.
- Nothing is stored or sent anywhere unless you press Record on that tab. Recordings stay in your browser and are cleared when you close the tab.
- The recorder does see whatever the site puts in its data layer, which can include your own details if you type them into a form. Keep that in mind before exporting or sharing a recording.

## Notes
- GTM removes tag names when it publishes, so GTM items show by type and ID; Adobe Launch keeps rule names.
- Ad-library searches use the brand name you set. Snapchat and Pinterest don't offer a general public ad library.
- When recording a booking flow, stop before entering personal or payment details. Some booking systems also hold inventory while you're on the checkout page.
