/**
 * Italy Supermarket Deals Scraper
 * Extracts current promotional offers from active flyers published on confrontavolantini.com.
 * Structured APIs are preferred; visible preview cards are used only as an explicit fallback.
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
const runStartedAt = new Date().toISOString();
const proxyConfiguration = proxyConfigInput ? await Actor.createProxyConfiguration(proxyConfigInput) : undefined;
const requested = String(catena).toLowerCase();
const targets = requested === 'tutti' ? Object.entries(SOURCES) : Object.entries(SOURCES).filter(([key]) => key === requested);
if (!targets.length) throw new Error(`Catena non supportata: ${catena}`);
console.log(`Catena="${catena}" | Categoria="${categoria || 'tutte'}" | Max=${maxItems} | Diagnostics=${diagnosticMode}`);

let savedCount = 0;
const savedKeys = new Set();
const coverage = [];
const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    launchContext: { launchOptions: { headless: true } },
    maxConcurrency: 1,
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 240,
    preNavigationHooks: [async (_ctx, options) => { options.waitUntil = 'domcontentloaded'; options.timeout = 45_000; }],
    async requestHandler({ page, request, log }) {
        const { chain, chainName, sourceUrl } = request.userData;
        const report = {
            chainSlug: chain, chainName, sourceUrl, activeFlyers: 0, flyerIds: [], structuredApiProducts: 0,
            fallbackProducts: 0, savedProducts: 0, apiPagesWithProducts: 0, apiPagesEmpty: 0, status: 'processing',
        };
        if (savedCount >= maxItems) {
            report.status = 'skipped_max_items_reached';
            coverage.push(report);
            log.info(`${chainName}: skipped because global maxItems=${maxItems} has already been reached.`);
            return;
        }
        await dismissCookies(page);
        await page.waitForTimeout(800);
        const flyers = await collectFlyers(page, sourceUrl);
        report.activeFlyers = flyers.length;
        report.flyerIds = flyers.map((flyer) => flyer.flyerId);
        log.info(`${chainName}: active flyers IDs=${report.flyerIds.join(', ') || 'none'}`);
        if (diagnosticMode) await putJson(`debug_${chain}_FLYERS`, flyers);

        let products = [];
        const apiPageStats = [];
        for (const flyer of flyers) {
            if (products.length >= maxItems - savedCount) break;
            const apiResult = await requestFlyerPages(page, chain, chainName, flyer, maxItems - savedCount - products.length, log, diagnosticMode);
            products.push(...apiResult.products);
            apiPageStats.push(...apiResult.pages);
        }
        products = uniqueProducts(products);
        report.structuredApiProducts = products.length;
        report.apiPagesWithProducts = apiPageStats.filter((stat) => stat.productCount > 0).length;
        report.apiPagesEmpty = apiPageStats.filter((stat) => stat.productCount === 0).length;
        if (!products.length) {
            products = await previewFallback(page, chain, chainName, sourceUrl, runStartedAt, log);
            report.fallbackProducts = products.length;
        }
        const term = String(categoria || '').trim().toLowerCase();
        if (term) products = products.filter((product) => `${product.name} ${product.categoria || ''}`.toLowerCase().includes(term));
        log.info(`${chainName}: candidates=${products.length}`);
        for (const product of products) {
            if (savedCount >= maxItems) break;
            const key = recordKey(product);
            if (savedKeys.has(key)) continue;
            savedKeys.add(key);
            await Actor.pushData(product);
            savedCount += 1;
            report.savedProducts += 1;
        }
        if (report.structuredApiProducts > 0) report.status = 'structured_api';
        else if (report.fallbackProducts > 0) report.status = 'preview_fallback';
        else if (report.activeFlyers > 0) report.status = 'active_flyers_without_structured_offers';
        else report.status = 'no_active_flyers_detected';
        coverage.push(report);
        log.info(`${chainName}: saved=${report.savedProducts}, status=${report.status}, total run=${savedCount}`);
    },
});

await crawler.run(targets.map(([chain, source]) => ({
    url: source.url,
    uniqueKey: chain,
    userData: { chain, chainName: source.name, sourceUrl: source.url },
})));
const summary = {
    actor: 'Italy Supermarket Deals Scraper', scrapedAt: runStartedAt, requestedChain: catena, categoryFilter: categoria || '',
    maxItems, totalProductsSaved: savedCount, maxItemsReached: savedCount >= maxItems, coverage,
    structuredApiChains: coverage.filter((row) => row.status === 'structured_api').map((row) => row.chainSlug),
    fallbackChains: coverage.filter((row) => row.status === 'preview_fallback').map((row) => row.chainSlug),
    noProductsChains: coverage.filter((row) => !['structured_api', 'preview_fallback'].includes(row.status)).map((row) => row.chainSlug),
};
await putJson('RUN_SUMMARY', summary);
console.log(`RUN SUMMARY: ${JSON.stringify(summary)}`);
console.log(`Done. Total saved: ${savedCount} offers.`);
await Actor.exit();

async function collectFlyers(page, sourceUrl) {
    const flyers = await page.locator('button.chain-mini-thumb-btn').evaluateAll((buttons) => buttons.map((button, index) => {
        const imgSrc = button.querySelector('img')?.getAttribute('src') || '';
        const idMatch = imgSrc.match(/flyer0*(\d+)_p\d+/i);
        const card = button.closest('.chain-mini-card') || button.parentElement;
        const dateMatch = (card?.innerText || '').match(/(\d{2}\/\d{2}\/\d{4})\s*[–-]\s*(\d{2}\/\d{2}\/\d{4})/);
        return { index, flyerId: idMatch ? Number(idMatch[1]) : null, coverImage: imgSrc, validFromRaw: dateMatch?.[1] || '', validToRaw: dateMatch?.[2] || '' };
    }).filter((flyer) => flyer.flyerId));
    return flyers.map((flyer) => {
        const dateRange = normalizeDateRange(flyer.validFromRaw, flyer.validToRaw);
        return { ...flyer, ...dateRange, coverImage: absoluteUrl(flyer.coverImage, sourceUrl), sourcePageUrl: sourceUrl };
    });
}

async function requestFlyerPages(page, chain, chainName, flyer, limit, log, diagnostics) {
    const products = [];
    const pages = [];
    const origin = new URL(flyer.sourcePageUrl).origin;
    for (let pageNumber = 1; pageNumber <= 80 && products.length < limit; pageNumber++) {
        const endpoint = `${origin}/api/offers?flyer_id=${encodeURIComponent(flyer.flyerId)}&page_number=${encodeURIComponent(pageNumber)}`;
        let response = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const res = await page.request.get(endpoint, { headers: { Accept: 'application/json' }, timeout: 15_000 });
                const text = await res.text();
                let body = null;
                try { body = JSON.parse(text); } catch { /* diagnostic preview retained */ }
                response = { endpoint, status: res.status(), body, textPreview: text.slice(0, 400), attempt };
                if (response.status === 200 && response.body) break;
            } catch (error) { response = { endpoint, error: String(error), attempt }; }
            log.warning(`${chainName}: retry flyer=${flyer.flyerId} page=${pageNumber} attempt=${attempt}`);
            await page.waitForTimeout(attempt * 400);
        }
        if (diagnostics) await putJson(`debug_${chain}_API_${flyer.flyerId}_PAGE_${pageNumber}`, response);
        if (!response || response.error || response.status !== 200 || !response.body) {
            log.warning(`${chainName}: flyer=${flyer.flyerId} page=${pageNumber} API failed after retries ${JSON.stringify(response).slice(0, 180)}`);
            break;
        }
        const parsed = parseApiPayload(response.body, chain, chainName, flyer, pageNumber, endpoint, runStartedAt);
        pages.push({ flyerId: flyer.flyerId, pageNumber, productCount: parsed.length, endpoint });
        log.info(`${chainName}: API flyer=${flyer.flyerId} page=${pageNumber} offers=${parsed.length}`);
        if (!parsed.length) break;
        products.push(...parsed);
    }
    return { products: uniqueProducts(products).slice(0, limit), pages };
}

function parseApiPayload(body, chain, chainName, flyer, pageNumber, endpoint, scrapedAt) {
    const objects = [];
    const walk = (value, depth = 0) => {
        if (!value || depth > 7) return;
        if (Array.isArray(value)) return value.forEach((item) => walk(item, depth + 1));
        if (typeof value !== 'object') return;
        objects.push(value);
        Object.values(value).forEach((item) => walk(item, depth + 1));
    };
    walk(body);
    return objects.map((product) => {
        const name = product.product_name || product.productName || product.name || product.title || product.nome || product.description;
        const price = product.price_value ?? product.priceValue ?? product.price ?? product.offer_price ?? product.offerPrice ?? product.prezzo;
        if (!name || price === undefined || price === null) return null;
        const record = {
            name: String(name).trim(), catena: product.store_name || chainName, chainSlug: chain, categoria: product.category || product.categoria || '',
            priceOffer: normalizePrice(price), priceOriginal: normalizePrice(product.original_price ?? product.originalPrice ?? ''), discount: String(product.discount ?? product.sconto ?? ''),
            validFrom: product.valid_from || product.validFrom || flyer.validFrom || '', validTo: product.valid_to || product.validTo || flyer.validTo || '',
            format: product.quantity || product.format || '', flyerId: product.flyer_id || flyer.flyerId, pageNumber: product.page_number || pageNumber,
            offerId: product.offer_id || product.id || '', img: absoluteUrl(product.page_image_url || product.image_url || product.image || flyer.coverImage, flyer.sourcePageUrl),
            sourcePageUrl: flyer.sourcePageUrl, offersApiUrl: endpoint, extractionSource: 'offers_api', dataQuality: 'structured_api', scrapedAt,
        };
        record.validity = buildValidity(record.validFrom, record.validTo);
        record.offerKey = record.offerId ? `${record.chainSlug}:${record.offerId}` : recordKey(record);
        record.productFingerprint = productFingerprint(record);
        return record;
    }).filter(Boolean);
}

async function previewFallback(page, chain, chainName, sourceUrl, scrapedAt, log) {
    const lines = await page.evaluate(() => document.body.innerText.split(/[\n\r]+/).map((line) => line.trim()).filter(Boolean)).catch(() => []);
    const products = [];
    for (let i = 2; i < lines.length; i++) {
        if (!/^\d{1,4}[,.]\d{2}\s*€$/.test(lines[i])) continue;
        const name = lines[i - 2].replace(/^[^\w\u00C0-\u024F]+/, '').trim();
        if (name.length <= 2) continue;
        const record = {
            name, catena: chainName, chainSlug: chain, categoria: '', priceOffer: normalizePrice(lines[i]), priceOriginal: '', discount: '', validFrom: '', validTo: '', validity: '',
            format: lines[i - 1], flyerId: '', pageNumber: '', offerId: '', img: '', sourcePageUrl: sourceUrl, offersApiUrl: '', extractionSource: 'preview_text', dataQuality: 'preview_fallback', scrapedAt,
        };
        record.offerKey = recordKey(record);
        record.productFingerprint = productFingerprint(record);
        products.push(record);
    }
    log.info(`${chainName}: preview fallback offers=${products.length}`);
    return uniqueProducts(products);
}

function normalizeDateRange(fromRaw, toRaw) {
    const formats = ['DMY', 'MDY'];
    for (const format of formats) {
        const validFrom = toIsoDate(fromRaw, format);
        const validTo = toIsoDate(toRaw, format);
        if (!validFrom || !validTo) continue;
        const start = Date.parse(validFrom);
        const end = Date.parse(validTo);
        const days = (end - start) / 86_400_000;
        if (days >= 0 && days <= 90) return { validFrom, validTo };
    }
    return { validFrom: '', validTo: '' };
}
function toIsoDate(value, format) {
    const match = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) return '';
    const first = Number(match[1]);
    const second = Number(match[2]);
    const year = Number(match[3]);
    const month = format === 'DMY' ? second : first;
    const day = format === 'DMY' ? first : second;
    if (month < 1 || month > 12 || day < 1 || day > 31) return '';
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function buildValidity(from, to) { return from && to ? `${from} – ${to}` : ''; }
function absoluteUrl(value, baseUrl) { if (!value) return ''; try { return new URL(value, baseUrl).href; } catch { return String(value); } }
function normalizePrice(value) { return String(value ?? '').replace(/€/g, '').trim().replace(',', '.'); }
function normalizeText(value) { return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function recordKey(product) { return `${normalizeText(product.chainSlug || product.catena)}|${String(product.flyerId || 'x')}|${normalizeText(product.name)}|${normalizePrice(product.priceOffer)}`; }
function productFingerprint(product) { return `${normalizeText(product.chainSlug || product.catena)}|${normalizeText(product.name)}|${normalizeText(product.format)}`; }
function uniqueProducts(items) { const map = new Map(); for (const item of items) if (item?.name && item?.priceOffer && !map.has(recordKey(item))) map.set(recordKey(item), item); return [...map.values()]; }
async function putJson(key, value) { await Actor.setValue(key, JSON.stringify(value, null, 2), { contentType: 'application/json' }); }
async function dismissCookies(page) { for (const label of ['Continua senza accettare', 'Rifiuta', 'Accetta tutti', 'Accetta', 'OK']) { try { const button = page.locator(`button:has-text("${label}")`).first(); if (await button.isVisible({ timeout: 500 })) { await button.click(); return; } } catch { /* ignore */ } } }
