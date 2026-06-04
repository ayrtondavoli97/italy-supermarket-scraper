/**
 * Italy Supermarket Deals Scraper
 * Sources: 
 *   - Lidl Italia (lidl.it) — weekly offers, no login required
 *   - Eurospin (eurospin.it) — weekly offers, no login required
 *   - Penny Market (penny.it) — weekly offers, no login required
 * Input: catena, categoria, maxItems
 * Output: name, catena, priceOffer, priceOriginal, discount, validFrom, validTo, img, url
 */

import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const SOURCES = {
    'lidl':      { url: 'https://confrontavolantini.com/lidl',      name: 'Lidl' },
    'eurospin':  { url: 'https://confrontavolantini.com/eurospin',  name: 'Eurospin' },
    'conad':     { url: 'https://confrontavolantini.com/conad',     name: 'Conad' },
    'penny':     { url: 'https://confrontavolantini.com/penny',     name: 'Penny Market' },
    'md':        { url: 'https://confrontavolantini.com/md',        name: 'MD Discount' },
    'aldi':      { url: 'https://confrontavolantini.com/aldi',      name: 'Aldi' },
    'coop':      { url: 'https://confrontavolantini.com/coop',      name: 'Coop' },
    'carrefour': { url: 'https://confrontavolantini.com/carrefour', name: 'Carrefour' },
    'esselunga': { url: 'https://confrontavolantini.com/esselunga', name: 'Esselunga' },
};

await Actor.init();

const input = await Actor.getInput() ?? {};
const {
    catena = 'tutti',
    categoria = '',
    maxItems = 500,
    proxyConfig: proxyConfigInput,
} = input;

const proxyConfiguration = proxyConfigInput
    ? await Actor.createProxyConfiguration(proxyConfigInput)
    : undefined;

console.log(`Catena="${catena}" | Categoria="${categoria || 'tutte'}" | Max=${maxItems}`);

const catenaLower = catena.toLowerCase();
const sourcesToScrape = catenaLower === 'tutti'
    ? Object.entries(SOURCES)
    : Object.entries(SOURCES).filter(([k]) => k === catenaLower);

if (sourcesToScrape.length === 0) {
    console.error(`Catena non supportata: "${catena}". Usa: ${Object.keys(SOURCES).join(', ')} o "tutti"`);
    await Actor.exit(1);
}

const startUrls = sourcesToScrape.map(([key, src]) => ({
    url: src.url,
    userData: { chain: key, chainName: src.name, page: 1 },
}));

let collected = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    launchContext: { launchOptions: { headless: true } },
    requestHandlerTimeoutSecs: 120,
    navigationTimeoutSecs: 45,
    maxConcurrency: 2,
    preNavigationHooks: [
        async (_crawlingContext, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 45_000;
        },
    ],

    async requestHandler({ page, request, log, addRequests }) {
        const { chain, chainName, page: pageNum = 1 } = request.userData;
        log.info(`${chainName} page=${pageNum} | ${request.url}`);

        // Intercept API responses
        const apiOffers = [];
        page.on('response', async response => {
            const url = response.url();
            const ct = response.headers()['content-type'] || '';
            if (!ct.includes('json')) return;
            try {
                const json = await response.json();
                const offers = extractOffersFromJson(json, chainName);
                if (offers.length > 0) {
                    apiOffers.push(...offers);
                    log.info(`API: ${url.substring(0, 100)} → ${offers.length} offers`);
                }
            } catch { /* ignore */ }
        });

        // Playwright crawler already navigated — just wait for DOM
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await dismissCookies(page, log);
        await page.waitForTimeout(2000);

        // If this is the index page, find the active flyer and navigate to it
        const isFlyerIndex = await page.evaluate(() => {
            return document.body.innerText.includes('Attivo') && document.body.innerText.includes('Sfoglia');
        });

        if (isFlyerIndex) {
            log.info('Flyer index page — checking if products already visible...');
            // Check if products are already on this page (confrontavolantini /chain page has them)
            const hasProducts = await page.evaluate(() =>
                /\d+[,.]\d{2}\s*€/.test(document.body.innerText)
            );
            if (!hasProducts) {
                // Need to navigate to actual flyer page
                const flyerUrl = await page.evaluate(() => {
                    // Find "Sfoglia" link adjacent to "Attivo" status
                    const allLinks = [...document.querySelectorAll('a[href]')];
                    // Look for a link whose surrounding text contains "Attivo"
                    for (const a of allLinks) {
                        const parent = a.closest('li, div, article, tr') || a.parentElement;
                        if (parent && parent.textContent.includes('Attivo') && a.textContent.trim().toLowerCase().includes('sfoglia')) {
                            return a.href;
                        }
                    }
                    return null;
                });
                if (flyerUrl) {
                    log.info(`Navigating to flyer: ${flyerUrl}`);
                    await page.goto(flyerUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                    await page.waitForTimeout(2000);
                }
            } else {
                log.info('Products already visible on this page, parsing directly');
            }
        }

        // Save debug HTML
        if (pageNum === 1 && collected === 0) {
            const html = await page.content();
            await Actor.setValue(`debug_${chain}_p1`, html, { contentType: 'text/html' });
            const txt = await page.evaluate(() => document.body.innerText.substring(0, 800));
            log.info(`Preview:\n${txt}`);
        }

        log.info(`API offers: ${apiOffers.length}`);

        let items = apiOffers.length > 0
            ? apiOffers
            : await parseOffersText(page, chainName, log);

        if (categoria) {
            items = items.filter(i =>
                i.categoria?.toLowerCase().includes(categoria.toLowerCase()) ||
                i.name?.toLowerCase().includes(categoria.toLowerCase())
            );
        }

        log.info(`${chainName} p${pageNum}: ${items.length} offers`);

        for (const item of items) {
            if (collected >= maxItems) break;
            await Actor.pushData(item);
            collected++;
        }

        // Try next page
        if (collected < maxItems) {
            const nextUrl = await page.evaluate(() => {
                const a = document.querySelector('a[rel="next"]');
                return a?.href || null;
            });
            if (nextUrl) {
                await addRequests([{ url: nextUrl, userData: { chain, chainName, page: pageNum + 1 } }]);
            }
        }
    },

    failedRequestHandler({ request, log }) { log.error(`Failed: ${request.url}`); },
});

await crawler.run(startUrls);
console.log(`Done. Total saved: ${collected} offers.`);
await Actor.exit();

function extractOffersFromJson(json, chainName) {
    const candidates = [
        json.offers, json.products, json.items, json.deals, json.promotions,
        json.data?.offers, json.data?.products, json.data?.items,
        json.result?.offers, json.results,
        Array.isArray(json) ? json : null,
    ].filter(Array.isArray);

    for (const arr of candidates) {
        if (arr.length === 0) continue;
        const first = arr[0];
        if (first.name || first.title || first.price !== undefined || first.offerPrice !== undefined) {
            return arr.map(p => ({
                name: p.name || p.title || p.description || '',
                catena: chainName,
                categoria: p.category || p.categoria || '',
                priceOffer: String(p.price ?? p.salePrice ?? p.offerPrice ?? p.prezzoOfferta ?? ''),
                priceOriginal: String(p.originalPrice ?? p.regularPrice ?? p.prezzoOriginale ?? ''),
                discount: String(p.discount ?? p.sconto ?? p.percentOff ?? ''),
                validFrom: p.validFrom || p.startDate || p.dal || '',
                validTo: p.validTo || p.endDate || p.al || '',
                img: p.image || p.imageUrl || p.img || '',
                url: p.url || p.link || '',
            })).filter(p => p.name);
        }
    }
    return [];
}

async function parseOffersText(page, chainName, log) {
    const rawText = await page.evaluate(() => document.body.innerText);
    log.info(`Raw text length: ${rawText.length}`);

    const lines = rawText.split(/[\n\r]+/).map(l => l.trim()).filter(l => l.length > 0);
    log.info(`Lines: ${lines.length}`);

    const priceLineIndices = [];
    for (let i = 0; i < lines.length; i++) {
        if (/^\d{1,3}[,.]\d{2}\s*€$/.test(lines[i])) priceLineIndices.push(i);
    }
    log.info(`Price lines: ${priceLineIndices.length} | e.g.: ${priceLineIndices.slice(0,3).map(i=>lines[i]).join(', ')}`);

    const NAV_SKIP = new Set(['Home','Anteprima','Discount','Elettronica','Animali','Bricolage',
        'Salute e Benessere','Ultimi Volantini','Back to School','Iper e Super',
        'Cura casa e corpo','beta','Sfoglia','Attivo','Scaduto','La tua lista della spesa']);

    const isFormat = s => /\d+\s*(ml|g|kg|l|lt|pz|cl)/i.test(s) || /^\d+x/i.test(s);

    const items = [];
    const seen = new Set();

    for (const i of priceLineIndices) {
        const price = lines[i].replace(/\s*€$/, '').trim().replace(',', '.');
        const prev1 = i >= 1 ? lines[i - 1] : '';
        const prev2 = i >= 2 ? lines[i - 2] : '';

        let name, format;
        if (isFormat(prev1) && prev2 && !NAV_SKIP.has(prev2)) {
            format = prev1; name = prev2;
        } else if (prev1 && !NAV_SKIP.has(prev1) && !isFormat(prev1) && !/^\d/.test(prev1) && !/^pag\./.test(prev1)) {
            name = prev1; format = '';
        } else continue;

        // Remove leading emoji
        name = name.replace(/^[^\w\u00C0-\u024F]+/, '').trim();
        if (!name || name.length < 3 || seen.has(name)) continue;
        seen.add(name);

        let validity = '';
        for (let j = Math.max(0, i-10); j < Math.min(lines.length, i+3); j++) {
            if (/\d{2}\/\d{2}\/\d{4}/.test(lines[j])) { validity = lines[j]; break; }
        }

        items.push({ name, catena: chainName, categoria: '', priceOffer: price,
            priceOriginal: '', discount: '', validity, img: '', url: '', format: format || '' });
    }

    log.info(`Parsed ${items.length} offers from text`);
    return items;
}

async function dismissCookies(page, log) {
    // Try Sourcepoint iframe first
    try {
        for (const frame of page.frames()) {
            if (frame.url().includes('sourcepoint') || frame.url().includes('sp-')) {
                const btn = frame.locator('button:has-text("Continua senza accettare"), button:has-text("Rifiuta")').first();
                if (await btn.isVisible({ timeout: 2000 })) {
                    await btn.click();
                    log.info('Cookie dismissed via iframe');
                    return;
                }
            }
        }
    } catch { /* ignore */ }
    // Direct buttons
    for (const text of ['Accetta tutti', 'Accetta', 'OK', 'Continua', 'Accept all', 'Acconsento']) {
        try {
            const btn = page.locator(`button:has-text("${text}")`).first();
            if (await btn.isVisible({ timeout: 1500 })) {
                await btn.click();
                await page.waitForTimeout(500);
                log.info(`Cookie dismissed: "${text}"`);
                return;
            }
        } catch { /* ignore */ }
    }
}
