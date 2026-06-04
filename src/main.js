/**
 * Italy Supermarket Scraper — Carrefour Italia
 * spesa.carrefour.it — catalog accessible without store selection
 * Uses internal API: /api/2.0/page/category?id=...
 */

import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const BASE = 'https://spesa.carrefour.it';

// Carrefour category IDs (from site navigation)
const CATEGORIES = [
    { id: 'frutta-e-verdura',        name: 'Frutta e Verdura' },
    { id: 'carne-e-pesce',           name: 'Carne e Pesce' },
    { id: 'salumi-e-formaggi',       name: 'Salumi e Formaggi' },
    { id: 'pane-e-pasticceria',      name: 'Pane e Pasticceria' },
    { id: 'pasta-riso-cereali',      name: 'Pasta, Riso e Cereali' },
    { id: 'sughi-conserve',          name: 'Sughi e Conserve' },
    { id: 'olio-condimenti',         name: 'Olio e Condimenti' },
    { id: 'dolci-snack',             name: 'Dolci e Snack' },
    { id: 'colazione',               name: 'Colazione' },
    { id: 'bevande',                 name: 'Bevande' },
    { id: 'vini-birre-alcolici',     name: 'Vini, Birre e Alcolici' },
    { id: 'surgelati',               name: 'Surgelati' },
    { id: 'latticini-uova',          name: 'Latticini e Uova' },
    { id: 'pulizia-casa',            name: 'Pulizia Casa' },
    { id: 'igiene-persona',          name: 'Igiene Persona' },
    { id: 'neonati-bambini',         name: 'Neonati e Bambini' },
    { id: 'animali',                 name: 'Animali' },
    { id: 'bio-vegano',              name: 'Bio e Vegano' },
];

await Actor.init();

const input = await Actor.getInput() ?? {};
const { categoria = '', query = '', maxItems = 2000, proxyConfig: proxyConfigInput } = input;

const proxyConfiguration = proxyConfigInput
    ? await Actor.createProxyConfiguration(proxyConfigInput)
    : undefined;

console.log(`Categoria="${categoria || 'tutte'}" | Query="${query}" | Max=${maxItems}`);

let cats = CATEGORIES;
if (categoria) {
    cats = CATEGORIES.filter(c =>
        c.id.includes(categoria.toLowerCase()) ||
        c.name.toLowerCase().includes(categoria.toLowerCase())
    );
    if (cats.length === 0) cats = [{ id: categoria, name: categoria }];
}
const catsNeeded = query ? 1 : Math.max(1, Math.ceil(maxItems / 40));
const catsToScrape = cats.slice(0, catsNeeded);

const startUrls = query
    ? [{ url: `${BASE}/search?q=${encodeURIComponent(query)}&page=1`, userData: { slug: 'search', catName: 'Ricerca', page: 1 } }]
    : catsToScrape.map(c => ({
        url: `${BASE}/${c.id}`,
        userData: { slug: c.id, catName: c.name, page: 1 },
    }));

let collected = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    launchContext: { launchOptions: { headless: true } },
    requestHandlerTimeoutSecs: 120,
    maxConcurrency: 2,

    async requestHandler({ page, request, log, addRequests }) {
        const { slug, catName, page: pageNum = 1 } = request.userData;
        log.info(`${catName} page=${pageNum} | ${request.url}`);

        // Intercept API responses
        const apiProducts = [];
        page.on('response', async response => {
            const url = response.url();
            const ct = response.headers()['content-type'] || '';
            if (!ct.includes('json')) return;
            if (!url.includes('/api/') && !url.includes('product') && !url.includes('catalog') && !url.includes('search')) return;
            try {
                const json = await response.json();
                const products = findProductsInJson(json);
                if (products.length > 0) {
                    apiProducts.push(...products);
                    log.info(`API hit: ${url.substring(0, 100)} → ${products.length} products`);
                }
            } catch { /* ignore */ }
        });

        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await dismissCookies(page, log);

        // Wait for content
        await page.waitForTimeout(3000);

        // Save debug on first run
        if (pageNum === 1 && collected === 0) {
            const html = await page.content();
            await Actor.setValue(`debug_${slug}`, html, { contentType: 'text/html' });
            const txt = await page.evaluate(() => document.body.innerText.substring(0, 500));
            log.info(`Page preview:\n${txt}`);
        }

        log.info(`API products intercepted: ${apiProducts.length}`);

        // Use API products if found, else DOM
        let items = apiProducts.length > 0 ? apiProducts : await parseDOM(page, log);

        log.info(`${catName} p${pageNum}: ${items.length} products`);

        for (const item of items) {
            if (collected >= maxItems) break;
            await Actor.pushData({ ...item, supermarket: 'Carrefour', categoria: catName });
            collected++;
        }

        // Next page
        const hasNext = await page.evaluate(() =>
            !!document.querySelector('a[rel="next"], [class*="next"]:not([disabled]), button[aria-label*="next"]')
        );
        if (hasNext && collected < maxItems) {
            const nextUrl = new URL(request.url);
            nextUrl.searchParams.set('page', pageNum + 1);
            await addRequests([{ url: nextUrl.toString(), userData: { ...request.userData, page: pageNum + 1 } }]);
        }
    },

    failedRequestHandler({ request, log }) { log.error(`Failed: ${request.url}`); },
});

await crawler.run(startUrls);
console.log(`Done. Total saved: ${collected} products.`);
await Actor.exit();

function findProductsInJson(json) {
    const candidates = [
        json.products, json.items, json.data?.products, json.data?.items,
        json.result?.products, json.results, json.catalog?.products,
        json.page?.products, Array.isArray(json) ? json : null,
    ].filter(Array.isArray);

    for (const arr of candidates) {
        if (arr.length === 0) continue;
        const first = arr[0];
        if (first.name || first.title || first.description || first.price !== undefined) {
            return arr.map(p => ({
                name: p.name || p.title || p.description || '',
                price: String(p.price ?? p.sellingPrice ?? p.currentPrice ?? ''),
                oldPrice: String(p.originalPrice ?? p.crossedPrice ?? p.listPrice ?? ''),
                pricePerUnit: p.pricePerUnit || p.unitPrice || '',
                brand: p.brand || p.brandName || '',
                weight: p.netContent || p.weight || p.format || '',
                promo: p.promoLabel || p.badge || p.promotion?.label || '',
                img: p.image || p.imageUrl || p.thumbnail || '',
                url: p.url || p.link || '',
                sku: String(p.id || p.sku || p.ean || ''),
            })).filter(p => p.name);
        }
    }
    return [];
}

async function parseDOM(page, log) {
    return page.evaluate(() => {
        const productLinks = [...document.querySelectorAll('a[href*="/product"], a[href*="/prodotto"], a[href*="/p/"]')];
        const seen = new Set();
        const unique = productLinks.filter(a => { if (seen.has(a.href)) return false; seen.add(a.href); return true; });

        return unique.map(link => {
            let card = link;
            while (card && card !== document.body) {
                const cls = card.className || '';
                if (cls.includes('product') || cls.includes('item') || card.tagName === 'LI' || card.tagName === 'ARTICLE') break;
                card = card.parentElement;
            }
            const txt = card?.textContent.trim() || '';
            const priceMatch = txt.match(/(\d{1,3}[,\.]\d{2})\s*€/);
            return {
                name: link.textContent.trim() || card?.querySelector('h2,h3,h4,[class*="name"],[class*="title"]')?.textContent.trim() || '',
                price: priceMatch?.[1]?.replace(',', '.') || '',
                oldPrice: '', pricePerUnit: '', brand: '', weight: '', promo: '',
                img: card?.querySelector('img')?.src || '',
                url: link.href,
            };
        }).filter(i => i.name && i.name.length > 2);
    });
}

async function dismissCookies(page, log) {
    for (const text of ['Accetta tutti', 'Accetta', 'Accept all', 'Continua senza accettare']) {
        try {
            const btn = page.locator(`button:has-text("${text}")`).first();
            if (await btn.isVisible({ timeout: 2000 })) {
                await btn.click();
                await page.waitForTimeout(500);
                log.info(`Cookie dismissed: "${text}"`);
                return;
            }
        } catch { /* ignore */ }
    }
    // Sourcepoint iframe
    try {
        const frame = page.frames().find(f => f.url().includes('sourcepoint') || f.url().includes('privacy'));
        if (frame) {
            const btn = frame.locator('button:has-text("Continua"), button:has-text("Reject"), button:has-text("Accetta")').first();
            if (await btn.isVisible({ timeout: 2000 })) { await btn.click(); log.info('Cookie dismissed via iframe'); }
        }
    } catch { /* ignore */ }
}
