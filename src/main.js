/**
 * Italy Supermarket Deals Scraper
 * Source: VolantinoFacile.it — aggregates offers from all major Italian supermarkets
 * URL: https://www.volantinofacile.it/{chain}/volantino-{chain}
 * Input: catena (optional), categoria (optional), maxItems
 * Output: product, priceOffer, priceOriginal, discount%, chain, validFrom, validTo
 */

import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

// All supported chains on VolantinoFacile
const CHAINS = {
    'tutti':        null,
    'esselunga':    'esselunga',
    'conad':        'conad',
    'coop':         'coop',
    'lidl':         'lidl',
    'eurospin':     'eurospin',
    'carrefour':    'carrefour',
    'penny':        'penny-market',
    'md':           'md-discount',
    'aldi':         'aldi',
    'bennet':       'bennet',
    'iper':         'iper',
    'pam':          'pam',
    'despar':       'despar',
    'famila':       'famila',
    'interspar':    'interspar',
};

const BASE = 'https://www.volantinofacile.it';

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

// Build start URLs
let startUrls = [];
const chainSlug = CHAINS[catena.toLowerCase()] ?? catena.toLowerCase();

if (catena === 'tutti' || !chainSlug) {
    // Scrape the main offers aggregation page
    startUrls = [
        { url: `${BASE}/volantini-iper-supermercati`, userData: { chain: 'tutti', page: 1 } },
        { url: `${BASE}/volantini-discount`,          userData: { chain: 'discount', page: 1 } },
    ];
} else {
    startUrls = [{
        url: `${BASE}/${chainSlug}/volantino-${chainSlug}`,
        userData: { chain: chainSlug, page: 1 },
    }];
}

let collected = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    launchContext: { launchOptions: { headless: true } },
    requestHandlerTimeoutSecs: 120,
    maxConcurrency: 2,

    async requestHandler({ page, request, log, addRequests }) {
        const { chain, page: pageNum = 1 } = request.userData;
        log.info(`Chain=${chain} page=${pageNum} | ${request.url}`);

        // Intercept API responses
        const apiOffers = [];
        page.on('response', async response => {
            const url = response.url();
            const ct = response.headers()['content-type'] || '';
            if (!ct.includes('json')) return;
            if (!url.includes('/api/') && !url.includes('offer') && !url.includes('product') && !url.includes('flyer')) return;
            try {
                const json = await response.json();
                const offers = extractOffers(json, url);
                if (offers.length > 0) {
                    apiOffers.push(...offers);
                    log.info(`API: ${url.substring(0, 100)} → ${offers.length} offers`);
                }
            } catch { /* ignore */ }
        });

        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await dismissCookies(page, log);
        await page.waitForTimeout(3000);

        // Save debug HTML on first run
        if (pageNum === 1 && collected === 0) {
            const html = await page.content();
            await Actor.setValue(`debug_${chain}_p1`, html, { contentType: 'text/html' });
            const txt = await page.evaluate(() => document.body.innerText.substring(0, 800));
            log.info(`Page preview:\n${txt}`);
        }

        log.info(`API offers intercepted: ${apiOffers.length}`);

        // Use API offers if found, else DOM
        let items = apiOffers.length > 0
            ? apiOffers
            : await parseOffersDOM(page, log, chain);

        // Filter by categoria if specified
        if (categoria && items.length > 0) {
            items = items.filter(i =>
                i.categoria?.toLowerCase().includes(categoria.toLowerCase()) ||
                i.name?.toLowerCase().includes(categoria.toLowerCase())
            );
        }

        log.info(`${chain} p${pageNum}: ${items.length} offers`);

        for (const item of items) {
            if (collected >= maxItems) break;
            await Actor.pushData(item);
            collected++;
        }

        // Pagination
        if (collected < maxItems) {
            const nextUrl = await page.evaluate(() => {
                const next = document.querySelector('a[rel="next"], [class*="next"]:not([disabled])');
                return next?.href || null;
            });
            if (nextUrl) {
                await addRequests([{ url: nextUrl, userData: { chain, page: pageNum + 1 } }]);
            }
        }
    },

    failedRequestHandler({ request, log }) { log.error(`Failed: ${request.url}`); },
});

await crawler.run(startUrls);
console.log(`Done. Total saved: ${collected} offers.`);
await Actor.exit();

// ── Extract offers from API JSON ─────────────────────────────────────────────
function extractOffers(json, apiUrl) {
    const candidates = [
        json.offers, json.products, json.items, json.deals,
        json.data?.offers, json.data?.products, json.data?.items,
        json.result?.offers, json.results,
        Array.isArray(json) ? json : null,
    ].filter(Array.isArray);

    for (const arr of candidates) {
        if (arr.length === 0) continue;
        const first = arr[0];
        if (first.name || first.title || first.description || first.price !== undefined) {
            return arr.map(p => ({
                name: p.name || p.title || p.description || p.denominazione || '',
                catena: p.store || p.chain || p.retailer || p.brand || '',
                categoria: p.category || p.categoria || '',
                priceOffer: String(p.price ?? p.salePrice ?? p.offerPrice ?? p.prezzoOfferta ?? ''),
                priceOriginal: String(p.originalPrice ?? p.regularPrice ?? p.prezzoOriginale ?? ''),
                discount: String(p.discount ?? p.sconto ?? p.percentOff ?? ''),
                validFrom: p.validFrom || p.startDate || p.dal || '',
                validTo: p.validTo || p.endDate || p.al || '',
                img: p.image || p.imageUrl || p.img || '',
                url: p.url || p.link || apiUrl,
            })).filter(p => p.name);
        }
    }
    return [];
}

// ── DOM parsing fallback ──────────────────────────────────────────────────────
async function parseOffersDOM(page, log, chain) {
    return page.evaluate((chain) => {
        const g = (el, ...sels) => {
            for (const s of sels) {
                try { const f = el.querySelector(s); if (f) return f.textContent.trim(); } catch {}
            }
            return '';
        };

        // Find offer cards — VolantinoFacile uses various card layouts
        let cards = [
            ...document.querySelectorAll(
                '[class*="offer-card"], [class*="OfferCard"], [class*="product-card"], ' +
                '[class*="deal-card"], [class*="flyer-product"], [class*="promo-item"], ' +
                'article[class*="offer"], article[class*="product"]'
            )
        ];

        // Fallback: any element with a price discount pattern
        if (cards.length === 0) {
            cards = [...document.querySelectorAll('li, article, div[class*="item"]')].filter(el => {
                const txt = el.textContent.trim();
                return txt.includes('€') && txt.length > 15 && txt.length < 2000 &&
                    !el.closest('nav') && !el.closest('header') && !el.closest('footer');
            }).slice(0, 300);
        }

        return cards.map(card => {
            const txt = card.textContent.trim();

            const name = g(card,
                '[class*="name"]', '[class*="title"]', '[class*="product-name"]',
                '[class*="offer-name"]', 'h2', 'h3', 'h4', 'strong'
            );
            if (!name || name.length < 2 || name.length > 300) return null;

            // Offer price
            const offerPriceEl = card.querySelector(
                '[class*="offer-price"], [class*="sale-price"], [class*="promo-price"], ' +
                '[class*="new-price"], [class*="current-price"]'
            );
            const offerMatch = (offerPriceEl?.textContent || txt).match(/(\d{1,3}[,\.]\d{2})\s*€/);
            const priceOffer = offerMatch ? offerMatch[1].replace(',', '.') : '';

            // Original price (crossed out)
            const origEl = card.querySelector('s, del, [class*="old"], [class*="original"], [class*="regular"], [class*="barred"]');
            const origMatch = origEl?.textContent.match(/(\d{1,3}[,\.]\d{2})/);
            const priceOriginal = origMatch ? origMatch[1].replace(',', '.') : '';

            // Discount %
            const discountEl = card.querySelector('[class*="discount"], [class*="percent"], [class*="save"], [class*="sconto"]');
            const discount = discountEl?.textContent.trim() || '';

            // Validity dates
            const validEl = card.querySelector('[class*="valid"], [class*="date"], [class*="expir"], time');
            const validity = validEl?.textContent.trim() || '';

            // Chain name
            const chainEl = card.querySelector('[class*="store"], [class*="chain"], [class*="brand"], [class*="logo"] img');
            const catenaName = chainEl?.textContent.trim() || chainEl?.getAttribute('alt') || chain;

            const img = card.querySelector('img')?.src || '';
            const link = card.querySelector('a');
            const url = link?.href || '';

            return {
                name,
                catena: catenaName,
                categoria: g(card, '[class*="category"], [class*="categoria"]'),
                priceOffer,
                priceOriginal,
                discount,
                validity,
                img,
                url,
            };
        }).filter(Boolean);
    }, chain);
}

async function dismissCookies(page, log) {
    // Sourcepoint iframe (common on VolantinoFacile)
    try {
        const frames = page.frames();
        for (const frame of frames) {
            if (frame.url().includes('sourcepoint') || frame.url().includes('privacy') || frame.url().includes('sp-')) {
                const btn = frame.locator('button:has-text("Continua senza accettare"), button:has-text("Rifiuta"), button:has-text("Reject")').first();
                if (await btn.isVisible({ timeout: 2000 })) {
                    await btn.click();
                    log.info('Cookie dismissed via iframe');
                    return;
                }
            }
        }
    } catch { /* ignore */ }
    // Direct buttons
    for (const text of ['Accetta tutti', 'Accetta', 'Continua senza accettare', 'OK']) {
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
