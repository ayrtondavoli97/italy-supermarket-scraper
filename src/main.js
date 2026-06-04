/**
 * Italian Supermarket Flyers & Deals Scraper
 * Stable extraction uses flyer offer APIs; investigation mode never changes output logic.
 */
import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const SOURCES = {
    conad: { url: 'https://confrontavolantini.com/conadsuperstore', name: 'Conad Superstore', support: 'structured' },
    lidl: { url: 'https://confrontavolantini.com/lidl', name: 'Lidl', support: 'structured' },
    eurospin: { url: 'https://confrontavolantini.com/eurospin', name: 'Eurospin', support: 'structured' },
    md: { url: 'https://confrontavolantini.com/md', name: 'MD Discount', support: 'structured' },
    aldi: { url: 'https://confrontavolantini.com/aldi', name: 'Aldi', support: 'structured' },
    famila: { url: 'https://confrontavolantini.com/famila', name: 'Famila', support: 'validation_pending' },
    ins: { url: 'https://confrontavolantini.com/ins-discount', name: "iN's Mercato", support: 'validation_pending' },
    esselunga: { url: 'https://confrontavolantini.com/esselunga', name: 'Esselunga', support: 'preview_fallback' },
};

await Actor.init();
const input = await Actor.getInput() ?? {};
const legacyKeyword = String(input.categoria ?? '').trim();
const {
    catena = 'tutti',
    keyword = legacyKeyword,
    maxItems = 1000,
    maxItemsPerChain = 1000,
    maxTotalItems = 10000,
    structuredOnly = true,
    diagnosticMode = false,
    investigateZeroResults = false,
    proxyConfig: proxyConfigInput,
} = input;
const runStartedAt = new Date().toISOString();
const requested = String(catena).toLowerCase();
const targets = requested === 'tutti'
    ? Object.entries(SOURCES)
    : Object.entries(SOURCES).filter(([key]) => key === requested);
if (!targets.length) throw new Error(`Catena non supportata: ${catena}`);
const perChainLimit = requested === 'tutti' ? Number(maxItemsPerChain) : Number(maxItems);
const outputLimit = requested === 'tutti' ? Number(maxTotalItems) : Number(maxItems);
const proxyConfiguration = proxyConfigInput ? await Actor.createProxyConfiguration(proxyConfigInput) : undefined;
console.log(`Catena="${catena}" | Keyword="${keyword || 'nessuna'}" | PerChainMax=${perChainLimit} | TotalMax=${outputLimit} | StructuredOnly=${structuredOnly} | Diagnostics=${diagnosticMode} | InvestigateZeroResults=${investigateZeroResults}`);

let savedCount = 0;
const savedKeys = new Set();
const coverage = [];

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    launchContext: { launchOptions: { headless: true } },
    maxConcurrency: 1,
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: investigateZeroResults ? 300 : 240,
    preNavigationHooks: [async (_ctx, options) => {
        options.waitUntil = 'domcontentloaded';
        options.timeout = 45_000;
    }],
    async requestHandler({ page, request, log }) {
        const { chain, chainName, sourceUrl, configuredSupport } = request.userData;
        const report = {
            chainSlug: chain,
            chainName,
            sourceUrl,
            configuredSupport,
            perChainLimit,
            activeFlyers: 0,
            flyerIds: [],
            structuredApiProducts: 0,
            fallbackProductsAvailable: 0,
            fallbackProductsSaved: 0,
            fallbackExcluded: false,
            savedProducts: 0,
            apiPagesWithProducts: 0,
            apiPagesEmpty: 0,
            status: 'processing',
            investigationSaved: false,
        };

        if (savedCount >= outputLimit) {
            report.status = 'skipped_total_limit_reached';
            coverage.push(report);
            log.info(`${chainName}: skipped because total output limit=${outputLimit} has already been reached.`);
            return;
        }

        await dismissCookies(page);
        await page.waitForTimeout(800);
        const flyers = await collectFlyers(page, sourceUrl);
        report.activeFlyers = flyers.length;
        report.flyerIds = flyers.map((flyer) => flyer.flyerId);
        log.info(`${chainName}: source=${sourceUrl} | active flyers IDs=${report.flyerIds.join(', ') || 'none'}`);
        if (diagnosticMode) await putJson(`debug_${chain}_FLYERS`, flyers);

        let structuredProducts = [];
        const apiPages = [];
        for (const flyer of flyers) {
            if (structuredProducts.length >= perChainLimit) break;
            const remaining = perChainLimit - structuredProducts.length;
            const result = await requestFlyerPages(page, chain, chainName, flyer, remaining, log, diagnosticMode);
            structuredProducts.push(...result.products);
            apiPages.push(...result.pages);
        }
        structuredProducts = uniqueProducts(structuredProducts).slice(0, perChainLimit);
        report.structuredApiProducts = structuredProducts.length;
        report.apiPagesWithProducts = apiPages.filter((pageRow) => pageRow.productCount > 0).length;
        report.apiPagesEmpty = apiPages.filter((pageRow) => pageRow.productCount === 0).length;

        let fallbackProducts = [];
        if (!structuredProducts.length) {
            fallbackProducts = await previewFallback(page, chain, chainName, sourceUrl, runStartedAt, log);
            report.fallbackProductsAvailable = fallbackProducts.length;
        }

        let products = structuredProducts;
        if (!products.length && fallbackProducts.length && !structuredOnly) {
            products = fallbackProducts.slice(0, perChainLimit);
            report.fallbackProductsSaved = products.length;
        } else if (!products.length && fallbackProducts.length && structuredOnly) {
            report.fallbackExcluded = true;
            log.info(`${chainName}: ${fallbackProducts.length} fallback products excluded because structuredOnly=true.`);
        }

        const filterTerm = String(keyword || '').trim().toLowerCase();
        if (filterTerm) {
            products = products.filter((product) => `${product.name} ${product.categoria || ''}`.toLowerCase().includes(filterTerm));
        }
        log.info(`${chainName}: candidates=${products.length}`);
        for (const product of products) {
            if (savedCount >= outputLimit) break;
            const key = recordKey(product);
            if (savedKeys.has(key)) continue;
            savedKeys.add(key);
            await Actor.pushData(product);
            report.savedProducts += 1;
            savedCount += 1;
        }

        if (report.structuredApiProducts > 0) report.status = 'structured_api';
        else if (report.fallbackProductsAvailable > 0 && structuredOnly) report.status = 'preview_fallback_excluded';
        else if (report.fallbackProductsSaved > 0) report.status = 'preview_fallback';
        else if (report.activeFlyers > 0) report.status = 'active_flyers_without_structured_offers';
        else report.status = 'no_active_flyers_detected';

        if (investigateZeroResults && report.structuredApiProducts === 0) {
            await saveZeroResultInvestigation(page, chain, chainName, sourceUrl, flyers, log);
            report.investigationSaved = true;
        }
        coverage.push(report);
        log.info(`${chainName}: saved=${report.savedProducts}, status=${report.status}, total run=${savedCount}`);
    },
});

await crawler.run(targets.map(([chain, source]) => ({
    url: source.url,
    uniqueKey: chain,
    userData: { chain, chainName: source.name, sourceUrl: source.url, configuredSupport: source.support },
})));

const summary = {
    actor: 'Italian Supermarket Flyers & Deals Scraper',
    scrapedAt: runStartedAt,
    requestedChain: catena,
    keywordFilter: keyword || '',
    structuredOnly,
    perChainLimit,
    outputLimit,
    totalProductsSaved: savedCount,
    maxTotalItemsReached: savedCount >= outputLimit,
    coverage,
    structuredApiChains: coverage.filter((row) => row.status === 'structured_api').map((row) => row.chainSlug),
    fallbackChainsIncluded: coverage.filter((row) => row.status === 'preview_fallback').map((row) => row.chainSlug),
    fallbackChainsExcluded: coverage.filter((row) => row.status === 'preview_fallback_excluded').map((row) => row.chainSlug),
    noProductsChains: coverage.filter((row) => ['no_active_flyers_detected', 'active_flyers_without_structured_offers'].includes(row.status)).map((row) => row.chainSlug),
};
await putJson('RUN_SUMMARY', summary);
console.log(`RUN SUMMARY: ${JSON.stringify(summary)}`);
console.log(`Done. Total saved: ${savedCount} offers.`);
await Actor.exit();

async function collectFlyers(page, sourceUrl) {
    const rawFlyers = await page.locator('button.chain-mini-thumb-btn').evaluateAll((buttons) => buttons.map((button, index) => {
        const imgSrc = button.querySelector('img')?.getAttribute('src') || '';
        const match = imgSrc.match(/flyer0*(\d+)_p\d+/i);
        const card = button.closest('.chain-mini-card') || button.parentElement;
        const dateMatch = (card?.innerText || '').match(/(\d{2}\/\d{2}\/\d{4})\s*[–-]\s*(\d{2}\/\d{2}\/\d{4})/);
        return {
            index,
            flyerId: match ? Number(match[1]) : null,
            coverImage: imgSrc,
            validFromRaw: dateMatch?.[1] || '',
            validToRaw: dateMatch?.[2] || '',
        };
    }).filter((flyer) => flyer.flyerId));
    return rawFlyers.map((flyer) => ({
        ...flyer,
        ...normalizeDateRange(flyer.validFromRaw, flyer.validToRaw),
        coverImage: absoluteUrl(flyer.coverImage, sourceUrl),
        sourcePageUrl: sourceUrl,
    }));
}

async function requestFlyerPages(page, chain, chainName, flyer, limit, log, diagnostics) {
    const products = [];
    const pages = [];
    const origin = new URL(flyer.sourcePageUrl).origin;
    for (let pageNumber = 1; pageNumber <= 80 && products.length < limit; pageNumber++) {
        const endpoint = `${origin}/api/offers?flyer_id=${encodeURIComponent(flyer.flyerId)}&page_number=${pageNumber}`;
        let response = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const res = await page.request.get(endpoint, { headers: { Accept: 'application/json' }, timeout: 15_000 });
                const text = await res.text();
                let body = null;
                try { body = JSON.parse(text); } catch { /* diagnostics retain response preview */ }
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
            log.warning(`${chainName}: flyer=${flyer.flyerId} page=${pageNumber} API failed after retries.`);
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
        const priceOfferText = normalizePrice(price);
        const priceOriginalText = normalizePrice(product.original_price ?? product.originalPrice ?? '');
        const record = {
            name: String(name).trim(),
            catena: product.store_name || chainName,
            chainSlug: chain,
            categoria: product.category || product.categoria || '',
            priceOffer: priceOfferText,
            priceOfferValue: toNumberOrNull(priceOfferText),
            priceOriginal: priceOriginalText,
            priceOriginalValue: toNumberOrNull(priceOriginalText),
            currency: 'EUR',
            country: 'IT',
            discount: String(product.discount ?? product.sconto ?? ''),
            validFrom: product.valid_from || product.validFrom || flyer.validFrom || '',
            validTo: product.valid_to || product.validTo || flyer.validTo || '',
            format: product.quantity || product.format || '',
            flyerId: product.flyer_id || flyer.flyerId,
            pageNumber: product.page_number || pageNumber,
            offerId: product.offer_id || product.id || '',
            img: absoluteUrl(product.page_image_url || product.image_url || product.image || flyer.coverImage, flyer.sourcePageUrl),
            sourcePageUrl: flyer.sourcePageUrl,
            offersApiUrl: endpoint,
            extractionSource: 'offers_api',
            dataQuality: 'structured_api',
            scrapedAt,
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
    for (let index = 2; index < lines.length; index++) {
        if (!/^\d{1,4}[,.]\d{2}\s*€$/.test(lines[index])) continue;
        const name = lines[index - 2].replace(/^[^\w\u00C0-\u024F]+/, '').trim();
        if (name.length <= 2) continue;
        const priceOfferText = normalizePrice(lines[index]);
        const record = {
            name,
            catena: chainName,
            chainSlug: chain,
            categoria: '',
            priceOffer: priceOfferText,
            priceOfferValue: toNumberOrNull(priceOfferText),
            priceOriginal: '',
            priceOriginalValue: null,
            currency: 'EUR',
            country: 'IT',
            discount: '',
            validFrom: '',
            validTo: '',
            validity: '',
            format: lines[index - 1],
            flyerId: '',
            pageNumber: '',
            offerId: '',
            img: '',
            sourcePageUrl: sourceUrl,
            offersApiUrl: '',
            extractionSource: 'preview_text',
            dataQuality: 'preview_fallback',
            scrapedAt,
        };
        record.offerKey = recordKey(record);
        record.productFingerprint = productFingerprint(record);
        products.push(record);
    }
    log.info(`${chainName}: preview fallback offers=${products.length}`);
    return uniqueProducts(products);
}

async function saveZeroResultInvestigation(page, chain, chainName, sourceUrl, flyers, log) {
    const prefix = `investigate_${chain}`;
    const audit = await collectStructureAudit(page);
    await Actor.setValue(`${prefix}_FULL_HTML`, await page.content(), { contentType: 'text/html' });
    await Actor.setValue(`${prefix}_FULL_TEXT`, await page.locator('body').innerText().catch(() => ''), { contentType: 'text/plain' });
    await Actor.setValue(`${prefix}_SCREENSHOT`, await page.screenshot({ fullPage: true }), { contentType: 'image/png' });
    await putJson(`${prefix}_DOM_AUDIT`, { chain, chainName, sourceUrl, discoveredFlyers: flyers, ...audit });
    const probes = [];
    for (let index = 0; index < Math.min(audit.clickableCandidates.length, 3); index++) {
        const button = page.locator('button, a, [role="button"]').filter({ hasText: /sfoglia|volantino|offert/i }).nth(index);
        const beforeUrl = page.url();
        await button.click({ force: true }).catch(() => {});
        await page.waitForTimeout(1200);
        probes.push({ index, beforeUrl, afterUrl: page.url(), postClick: await collectStructureAudit(page) });
        await page.keyboard.press('Escape').catch(() => {});
    }
    await putJson(`${prefix}_CLICK_PROBES`, probes);
    log.info(`INVESTIGATE ${chainName}: saved forensic files for zero-result source.`);
}

async function collectStructureAudit(page) {
    return page.evaluate(() => {
        const pattern = /volantin|sfoglia|offert|offer|catalog|promo|flyer|leaflet|brochure|pdf/i;
        const attrs = (node) => Object.fromEntries([...node.attributes].map((attribute) => [attribute.name, attribute.value]));
        const describe = (node) => ({ tag: node.tagName, text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 250), attrs: attrs(node), html: node.outerHTML.slice(0, 1500) });
        const clickableCandidates = [...document.querySelectorAll('button, a, [role="button"], [onclick], [data-href], [data-url]')]
            .filter((node) => pattern.test(`${node.textContent || ''} ${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''} ${node.getAttribute('href') || ''}`))
            .slice(0, 50).map(describe);
        const images = [...document.querySelectorAll('img')].map((image) => ({ src: image.currentSrc || image.src || '', alt: image.alt || '', html: image.outerHTML.slice(0, 1000) }))
            .filter((image) => pattern.test(`${image.src} ${image.alt}`)).slice(0, 100);
        const links = [...document.querySelectorAll('a[href]')].map((link) => ({ href: link.href, text: (link.textContent || '').replace(/\s+/g, ' ').trim() }))
            .filter((link) => pattern.test(`${link.href} ${link.text}`)).slice(0, 100);
        return { url: location.href, title: document.title, bodyTextPreview: (document.body.innerText || '').slice(0, 1000), clickableCandidates, images, links };
    }).catch((error) => ({ url: page.url(), error: String(error), clickableCandidates: [], images: [], links: [] }));
}

function normalizeDateRange(fromRaw, toRaw) {
    for (const format of ['DMY', 'MDY']) {
        const validFrom = toIsoDate(fromRaw, format);
        const validTo = toIsoDate(toRaw, format);
        if (!validFrom || !validTo) continue;
        const spanDays = (Date.parse(validTo) - Date.parse(validFrom)) / 86_400_000;
        if (spanDays >= 0 && spanDays <= 90) return { validFrom, validTo };
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
    const date = new Date(Date.UTC(year, month - 1, day));
    if (month < 1 || month > 12 || day < 1 || day > 31 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function buildValidity(from, to) { return from && to ? `${from} – ${to}` : ''; }
function absoluteUrl(value, baseUrl) { if (!value) return ''; try { return new URL(value, baseUrl).href; } catch { return String(value); } }
function normalizePrice(value) { return String(value ?? '').replace(/€/g, '').trim().replace(',', '.'); }
function toNumberOrNull(value) { const parsed = Number.parseFloat(value); return Number.isFinite(parsed) ? parsed : null; }
function normalizeText(value) { return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function recordKey(product) { return `${normalizeText(product.chainSlug || product.catena)}|${String(product.flyerId || 'x')}|${normalizeText(product.name)}|${normalizePrice(product.priceOffer)}`; }
function productFingerprint(product) { return `${normalizeText(product.chainSlug || product.catena)}|${normalizeText(product.name)}|${normalizeText(product.format)}`; }
function uniqueProducts(items) { const map = new Map(); for (const item of items) if (item?.name && item?.priceOffer && !map.has(recordKey(item))) map.set(recordKey(item), item); return [...map.values()]; }
async function putJson(key, value) { await Actor.setValue(key, JSON.stringify(value, null, 2), { contentType: 'application/json' }); }
async function dismissCookies(page) { for (const text of ['Continua senza accettare', 'Rifiuta', 'Accetta tutti', 'Accetta', 'OK']) { try { const button = page.locator(`button:has-text("${text}")`).first(); if (await button.isVisible({ timeout: 500 })) { await button.click(); return; } } catch { /* ignore */ } } }
