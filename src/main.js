/**
 * Italy Supermarket Deals Scraper
 * Extracts highlighted products from confrontavolantini.com active flyers.
 */
import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const SOURCES = {
    lidl: { url: 'https://confrontavolantini.com/lidl', name: 'Lidl' },
    eurospin: { url: 'https://confrontavolantini.com/eurospin', name: 'Eurospin' },
    conad: { url: 'https://confrontavolantini.com/conad', name: 'Conad' },
    penny: { url: 'https://confrontavolantini.com/penny', name: 'Penny Market' },
    md: { url: 'https://confrontavolantini.com/md', name: 'MD Discount' },
    aldi: { url: 'https://confrontavolantini.com/aldi', name: 'Aldi' },
    coop: { url: 'https://confrontavolantini.com/coop', name: 'Coop' },
    carrefour: { url: 'https://confrontavolantini.com/carrefour', name: 'Carrefour' },
    esselunga: { url: 'https://confrontavolantini.com/esselunga', name: 'Esselunga' },
};

await Actor.init();
const input = await Actor.getInput() ?? {};
const {
    catena = 'tutti',
    categoria = '',
    maxItems = 500,
    diagnosticMode = false,
    proxyConfig: proxyConfigInput,
} = input;
const proxyConfiguration = proxyConfigInput ? await Actor.createProxyConfiguration(proxyConfigInput) : undefined;
const requested = String(catena).toLowerCase();
const targets = requested === 'tutti' ? Object.entries(SOURCES) : Object.entries(SOURCES).filter(([key]) => key === requested);
if (!targets.length) throw new Error(`Catena non supportata: ${catena}`);
console.log(`Catena="${catena}" | Categoria="${categoria || 'tutte'}" | Max=${maxItems} | Diagnostics=${diagnosticMode}`);

let savedCount = 0;
const savedKeys = new Set();
const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    launchContext: { launchOptions: { headless: true } },
    maxConcurrency: 1,
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 240,
    preNavigationHooks: [async (_ctx, options) => { options.waitUntil = 'domcontentloaded'; options.timeout = 45000; }],
    async requestHandler({ page, request, log }) {
        const { chain, chainName } = request.userData;
        await dismissCookies(page);
        await page.waitForTimeout(800);
        const flyers = await collectFlyers(page);
        log.info(`${chainName}: active flyers IDs=${flyers.map((f) => f.flyerId).join(', ') || 'none'}`);
        if (diagnosticMode) await putJson(`debug_${chain}_FLYERS`, flyers);

        let products = [];
        for (const flyer of flyers) {
            if (products.length >= maxItems - savedCount) break;
            const flyerProducts = await requestFlyerPages(page, chain, chainName, flyer, maxItems - savedCount - products.length, log, diagnosticMode);
            products.push(...flyerProducts);
        }
        products = uniqueProducts(products);

        if (!products.length) {
            log.warning(`${chainName}: direct API returned no products; trying one UI click only for diagnostics/fallback.`);
            products = await modalFallback(page, chainName, log);
        }
        if (!products.length) products = await previewFallback(page, chainName, log);

        const term = String(categoria || '').toLowerCase();
        if (term) products = products.filter((p) => `${p.name} ${p.categoria || ''}`.toLowerCase().includes(term));
        log.info(`${chainName}: candidates=${products.length}`);
        for (const product of products) {
            if (savedCount >= maxItems) break;
            const key = productKey(product);
            if (savedKeys.has(key)) continue;
            savedKeys.add(key);
            await Actor.pushData(product);
            savedCount += 1;
        }
        log.info(`${chainName}: saved total=${savedCount}`);
    },
});

await crawler.run(targets.map(([chain, source]) => ({ url: source.url, uniqueKey: chain, userData: { chain, chainName: source.name } })));
console.log(`Done. Total saved: ${savedCount} offers.`);
await Actor.exit();

async function collectFlyers(page) {
    return page.locator('button.chain-mini-thumb-btn').evaluateAll((buttons) => buttons.map((button, index) => {
        const src = button.querySelector('img')?.getAttribute('src') || '';
        const match = src.match(/flyer0*(\d+)_p\d+/i);
        return { index, flyerId: match ? Number(match[1]) : null, coverImage: src };
    }).filter((flyer) => flyer.flyerId));
}

async function requestFlyerPages(page, chain, chainName, flyer, limit, log, diagnostics) {
    const results = [];
    const origin = new URL(page.url()).origin;
    for (let pageNumber = 1; pageNumber <= 80 && results.length < limit; pageNumber++) {
        const endpoint = `${origin}/api/offers?flyer_id=${encodeURIComponent(flyer.flyerId)}&page_number=${encodeURIComponent(pageNumber)}`;
        let response = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const res = await page.request.get(endpoint, {
                    headers: { Accept: 'application/json' },
                    timeout: 15000,
                });
                const text = await res.text();
                let body = null;
                try { body = JSON.parse(text); } catch { /* stored in diagnostics */ }
                response = { endpoint, status: res.status(), body, textPreview: text.slice(0, 400), attempt };
                if (response.status === 200 && response.body) break;
            } catch (error) {
                response = { endpoint, error: String(error), attempt };
            }
            log.warning(`${chainName}: retry flyer=${flyer.flyerId} page=${pageNumber} attempt=${attempt}`);
            await page.waitForTimeout(attempt * 400);
        }

        if (diagnostics) await putJson(`debug_${chain}_API_${flyer.flyerId}_PAGE_${pageNumber}`, response);
        if (!response || response.error || response.status !== 200 || !response.body) {
            log.warning(`${chainName}: flyer=${flyer.flyerId} page=${pageNumber} API failed after retries ${JSON.stringify(response).slice(0, 180)}`);
            break;
        }
        const parsed = parseApiPayload(response.body, chainName, flyer.flyerId, pageNumber);
        log.info(`${chainName}: API flyer=${flyer.flyerId} page=${pageNumber} offers=${parsed.length}`);
        if (!parsed.length) break;
        results.push(...parsed);
    }
    return uniqueProducts(results).slice(0, limit);
}

function parseApiPayload(body, chainName, flyerId, pageNumber) {
    const objects = [];
    const walk = (value, depth = 0) => {
        if (!value || depth > 7) return;
        if (Array.isArray(value)) return value.forEach((item) => walk(item, depth + 1));
        if (typeof value !== 'object') return;
        objects.push(value);
        Object.values(value).forEach((item) => walk(item, depth + 1));
    };
    walk(body);
    return objects.map((p) => {
        const name = p.product_name || p.productName || p.name || p.title || p.nome || p.description;
        const price = p.price_value ?? p.priceValue ?? p.price ?? p.offer_price ?? p.offerPrice ?? p.prezzo;
        if (!name || price === undefined || price === null) return null;
        return {
            name: String(name).trim(), catena: p.store_name || chainName, categoria: p.category || '',
            priceOffer: normalizePrice(price), priceOriginal: normalizePrice(p.original_price ?? p.originalPrice ?? ''),
            discount: String(p.discount ?? ''), validFrom: p.valid_from || '', validTo: p.valid_to || '',
            format: p.quantity || p.format || '', flyerId: p.flyer_id || flyerId, pageNumber: p.page_number || pageNumber,
            offerId: p.offer_id || p.id || '', img: p.page_image_url || p.image_url || '', url: '', extractionSource: 'offers_api',
        };
    }).filter(Boolean);
}

async function modalFallback(page, chainName, log) {
    const cover = page.locator('button.chain-mini-thumb-btn').first();
    if (!(await cover.isVisible().catch(() => false))) return [];
    await cover.click({ force: true }).catch(() => {});
    const close = page.locator('button[aria-label="Chiudi visualizzatore"]').last();
    await close.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    if (!(await close.isVisible().catch(() => false))) return [];
    const items = await page.evaluate((store) => [...document.querySelectorAll('[aria-label^="Aggiungi "]')].map((node) => {
        const label = node.getAttribute('aria-label') || '';
        const match = label.match(/^Aggiungi\s+(.+?)\s+alla Nota Spesa,\s*([0-9]+(?:[.,][0-9]{1,2})?)\s*€$/i);
        return match ? { name: match[1], catena: store, priceOffer: match[2].replace(',', '.'), extractionSource: 'viewer_hotspot' } : null;
    }).filter(Boolean), chainName).catch(() => []);
    log.info(`${chainName}: modal fallback offers=${items.length}`);
    return items;
}

async function previewFallback(page, chainName, log) {
    const lines = await page.evaluate(() => document.body.innerText.split(/[\n\r]+/).map((line) => line.trim()).filter(Boolean)).catch(() => []);
    const items = [];
    for (let i = 2; i < lines.length; i++) {
        if (!/^\d{1,4}[,.]\d{2}\s*€$/.test(lines[i])) continue;
        const name = lines[i - 2].replace(/^[^\w\u00C0-\u024F]+/, '').trim();
        if (name.length > 2) items.push({ name, catena: chainName, priceOffer: normalizePrice(lines[i]), format: lines[i - 1], extractionSource: 'preview_text' });
    }
    log.info(`${chainName}: preview fallback offers=${items.length}`);
    return uniqueProducts(items);
}

function normalizePrice(value) { return String(value ?? '').replace(/€/g, '').trim().replace(',', '.'); }
function productKey(p) { return `${String(p.catena).toLowerCase()}|${String(p.flyerId || 'x')}|${String(p.name).toLowerCase()}|${normalizePrice(p.priceOffer)}`; }
function uniqueProducts(items) { const map = new Map(); for (const item of items) if (item?.name && item?.priceOffer && !map.has(productKey(item))) map.set(productKey(item), item); return [...map.values()]; }
async function putJson(key, value) { await Actor.setValue(key, JSON.stringify(value, null, 2), { contentType: 'application/json' }); }
async function dismissCookies(page) { for (const label of ['Continua senza accettare', 'Rifiuta', 'Accetta tutti', 'Accetta', 'OK']) { try { const b = page.locator(`button:has-text("${label}")`).first(); if (await b.isVisible({ timeout: 500 })) { await b.click(); return; } } catch { /* ignore */ } } }
