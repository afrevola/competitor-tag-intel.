# Competitor Tag Intel

Competitive ad-ops and marketing intel from any public website, read from what the site already sends a browser:

- **Media mix:** every marketing vendor, grouped by channel (search, social, programmatic, CTV, affiliate, analytics and more), plus agency fingerprints.
- **Ad accounts and pixel IDs:** Google Ads, Floodlight, GA4, Meta, TikTok, Snap, LinkedIn, Microsoft, Reddit, Pinterest, AdRoll, The Trade Desk and others, with links to each platform's public ad library.
- **Conversion map:** what each ad platform is told counts as a conversion and the value sent. Flags duplicates, fixed values, missing values, values scraped from page text, and page visits counted as conversions.
- **Server-side tracking:** server GTM containers, first-party collection endpoints, Conversions API and enhanced-conversions signals.
- **Promo calendar:** offers from the site's promo pages, with dates, prices and status, plus campaign asset folders.
- **Tracking cost:** requests, bytes and JavaScript added by marketing tags compared with the site itself.
- **Comparison across competitors:** a side-by-side table, a vendor matrix, and account IDs shared between sites.

The repo has three parts:

| Folder | What it is |
| --- | --- |
| `SKILL.md` | A Claude skill that runs everything for one site or several competitors at once (one subagent per site). |
| `toolkit/` | The headless toolkit the skill uses: an in-page capture script and a Node command line (`intel.js`). No dependencies. |
| `extension/` | **Tag Inspector**, a Chrome extension built on the same code, for looking at sites by hand. |

## Use it as a Claude skill

1. Zip the `competitor-tag-intel` folder. SKILL.md must be at the top level of that folder.
2. In Claude, go to **Customize → Skills → + → Upload a skill** and pick the zip.
3. Claude needs a browser it can control: **Claude in Chrome** or the Claude desktop app's built-in browser.
4. Ask something like:
   - "Pull tag intel on topgolf.com"
   - "Compare the marketing setups of topgolf.com, puttshack.com and mainevent.com"

For one site you get a report. For several sites you also get a comparison page.

## Use the toolkit without Claude

Node 18+ is required.

1. Open the site in Chrome, open DevTools → Console, and paste the contents of `toolkit/capture.min.js`.
2. The capture returns a packed string. If the output says `parts=N` with N above 1, run `__tiPart(1)`, `__tiPart(2)` and so on for the rest.
3. Save each output to a file, then run:

```
node toolkit/intel.js extract part0.txt part1.txt -o capture.json --expect example.com
node toolkit/intel.js analyze capture.json -o out/example.com
node toolkit/intel.js compare out/*/report.json -o out/comparison
```

After editing anything in `toolkit/lib/`, run `node toolkit/build.js` to rebuild the in-page scripts.

## Install the Chrome extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension` folder.

See `extension/README.md` for what each view shows.

## Ground rules

- Public pages only: no logins, form submissions or getting around bot protection.
- The promo scan stays on the site being analyzed and fetches at most about 30 pages, three at a time.
- When recording a booking flow, stop before entering any personal or payment details.
