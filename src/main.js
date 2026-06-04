/**
 * Italy Supermarket Deals Scraper
 * Full-product extractor for confrontavolantini.com viewer modals.
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
const requestedChain = String(catena).toLowerCase();
const sourcesToScrape = requestedChain === 'tutti'
    ? Object.entries(SOURCES)
    : Object.entries(SOURCES).filter(([key]) => key === requestedChain);
if (!sourcesToScrape.length) {
    console.error(`Catena non supportata: ${catena}`);
    await Actor.exit(1);
}
console.log(`Catena="${catena}" | Categoria="${categoria || 'tutte'}" | Max=${maxItems} | Diagnostics=${diagnosticMode}`);

let collected = 0;
const outputKeys = new Set();
const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    launchContext: { launchOptions: { headless: true } },
    requestHandlerTimeoutSecs: 240,
    navigationTimeoutSecs: 45,
    maxConcurrency: 1,
    preNavigationHooks: [async (_ctx, options) => {
        options.waitUntil = 'domcontentloaded';
        options.timeout = 45_000;
    }],
    async requestHandler({ page, request, log }) {
        const { chain, chainName } = request.userData;
        const apiOffers = [];
        const apiDump = [];
        page.on('response', async (response) => {
            if (!response.url().includes('/api/offers?')) return;
            try {
                const json = await response.json();
                const parsed = extractOffersFromJson(json, chainName);
                apiOffers.push(...parsed);
                apiDump.push({ url: response.url(), parsedCount: parsed.length, json });
                log.info(`OFFERS API ${response.url()} -> ${parsed.length} offers`);
            } catch (error) {
                log.warning(`Unable to parse OFFERS API: ${error.message}`);
            }
        });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await dismissCookies(page, log);
        await page.waitForTimeout(800);
        const modalOffers = await scrapeAllFlyers(page, chain, chainName, maxItems - collected, log, diagnosticMode);
        await page.waitForTimeout(700);
        if (diagnosticMode) {
            await Actor.setValue(`debug_${chain}_RAW_OFFERS_API`, JSON.stringify(apiDump, null, 2), { contentType: 'application/json' });
            await Actor.setValue(`debug_${chain}_MODAL_ITEMS`, JSON.stringify(modalOffers, null, 2), { contentType: 'application/json' });
        }
        let items = mergeUniqueOffers([...apiOffers, ...modalOffers]);
        if (!items.length) items = await parsePreview(page, chainName, log);
        if (categoria) {
            const term = String(categoria).toLowerCase();
            items = items.filter((item) => String(item.name).toLowerCase().includes(term) || String(item.categoria || '').toLowerCase().includes(term));
        }
        log.info(`${chainName}: extracted candidates=${items.length}`);
        for (const item of items) {
            if (collected >= maxItems) break;
            const key = itemKey(item);
            if (outputKeys.has(key)) continue;
            outputKeys.add(key);
            await Actor.pushData(item);
            collected++;
        }
        log.info(`${chainName}: saved total=${collected}`);
    },
});

await crawler.run(sourcesToScrape.map(([chain, source]) => ({
    url: source.url,
    uniqueKey: `chain:${chain}`,
    userData: { chain, chainName: source.name },
})));
console.log(`Done. Total saved: ${collected} offers.`);
await Actor.exit();

async function scrapeAllFlyers(page, chain, chainName, limit, log, diagnostics) {
    const result = [];
    const covers = page.locator('button.chain-mini-thumb-btn');
    const count = await covers.count().catch(() => 0);
    log.info(`${chainName}: flyer covers found=${count}`);
    for (let index = 0; index < count && result.length < limit; index++) {
        const cover = covers.nth(index);
        const info = await cover.evaluate((element) => {
            const src = element.querySelector('img')?.getAttribute('src') || '';
            const match = src.match(/flyer0*(\d+)_p\d+/i);
            const validity = element.closest('.chain-mini-card')?.querySelector('.chain-mini-dates')?.textContent?.trim() || '';
            return { flyerId: match ? Number(match[1]) : '', validity };
        }).catch(() => ({ flyerId: '', validity: '' }));
        log.info(`${chainName}: open flyer index=${index}, flyerId=${info.flyerId}, validity=${info.validity}`);
        await cover.click({ force: true });
        const dialog = page.locator('[role="dialog"]').last();
        if (!(await dialog.isVisible({ timeout: 8000 }).catch(() => false))) {
            log.warning(`${chainName}: viewer not opened for flyer index=${index}`);
            continue;
        }
        const pages = await getTotalPages(dialog);
        log.info(`${chainName}: flyerId=${info.flyerId}, pages=${pages}`);
        for (let number = 1; number <= pages && result.length < limit; number++) {
            await page.waitForTimeout(450);
            const offers = await extractModalOffers(dialog, chainName, info, number);
            result.push(...offers);
            log.info(`${chainName}: flyerId=${info.flyerId} page=${number}/${pages} hotspot offers=${offers.length}`);
            if (diagnostics) await Actor.setValue(`debug_${chain}_FLYER_${info.flyerId}_PAGE_${number}`, JSON.stringify(offers, null, 2), { contentType: 'application/json' });
            if (number === pages) break;
            const next = dialog.locator('button[aria-label="Pagina successiva"]:not([disabled])').first();
            if (!(await next.isVisible({ timeout: 2000 }).catch(() => false))) break;
            const currentText = await dialog.locator('text=/Pagina\\s+\\d+\\s*\\/\\s*\\d+/').first().innerText().catch(() => '');
            await next.click({ force: true });
            await page.waitForFunction((oldText) => {
                const badge = [...document.querySelectorAll('[role="dialog"] span')].find((element) => /Pagina\s+\d+\s*\/\s*\d+/i.test(element.textContent || ''));
                return badge && badge.textContent !== oldText;
            }, currentText, { timeout: 5000 }).catch(() => page.waitForTimeout(500));
        }
        await dialog.locator('button[aria-label="Chiudi visualizzatore"]').click({ force: true }).catch(() => page.keyboard.press('Escape').catch(() => {}));
        await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(300);
    }
    return mergeUniqueOffers(result);
}

async function getTotalPages(dialog) {
    const text = await dialog.locator('text=/Pagina\\s+\\d+\\s*\\/\\s*\\d+/').first().innerText().catch(() => 'Pagina 1 / 1');
    const match = text.match(/Pagina\s+\d+\s*\/\s*(\d+)/i);
    return match ? Number(match[1]) : 1;
}

async function extractModalOffers(dialog, chainName, info, pageNumber) {
    return dialog.evaluate((root, args) => {
        const labels = [...new Set([...root.querySelectorAll('[aria-label^="Aggiungi "]')].map((element) => element.getAttribute('aria-label') || ''))];
        const image = root.querySelector('img[alt*="Volantino"]')?.getAttribute('src') || '';
        return labels.map((label) => {
            const match = label.match(/^Aggiungi\s+(.+?)\s+alla Nota Spesa,\s*([0-9]+(?:[.,][0-9]{1,2})?)\s*€$/i);
            if (!match) return null;
            return {
                name: match[1].trim(), catena: args.chainName, categoria: '', priceOffer: match[2].replace(',', '.'),
                priceOriginal: '', discount: '', validFrom: '', validTo: '', validity: args.validity, format: '',
                flyerId: args.flyerId, pageNumber: args.pageNumber, img: image, url: location.href, extractionSource: 'viewer_hotspot',
            };
        }).filter(Boolean);
    }, { chainName, flyerId: info.flyerId, validity: info.validity, pageNumber }).catch(() => []);
}

function extractOffersFromJson(json, chainName) {
    const arrays = [];
    const visit = (value, depth = 0) => {
        if (!value || depth > 8) return;
        if (Array.isArray(value)) { arrays.push(value); value.slice(0, 10).forEach((child) => visit(child, depth + 1)); }
        else if (typeof value === 'object') Object.values(value).forEach((child) => visit(child, depth + 1));
    };
    visit(json);
    const result = [];
    for (const array of arrays) {
        for (const product of array) {
            if (!product || typeof product !== 'object' || Array.isArray(product)) continue;
            const name = product.product_name || product.name || product.title || product.description || product.nome || product.label;
            const price = product.price_value ?? product.price ?? product.salePrice ?? product.offerPrice ?? product.prezzoOfferta ?? product.prezzo;
            if (!name || price === undefined || price === null) continue;
            result.push({
                name: String(name).trim(), catena: product.store_name || chainName, categoria: product.category || product.categoria || '',
                priceOffer: normalizePrice(price), priceOriginal: normalizePrice(product.original_price ?? product.originalPrice ?? product.regularPrice ?? ''),
                discount: String(product.discount ?? product.sconto ?? ''), validFrom: product.valid_from || product.validFrom || '', validTo: product.valid_to || product.validTo || '',
                format: product.quantity || '', flyerId: product.flyer_id || '', pageNumber: product.page_number || '', offerId: product.offer_id || '',
                img: product.page_image_url || '', url: '', extractionSource: 'offers_api',
            });
        }
    }
    return mergeUniqueOffers(result);
}

async function parsePreview(page, chainName, log) {
    const lines = await page.evaluate(() => document.body.innerText.split(/[\n\r]+/).map((line) => line.trim()).filter(Boolean)).catch(() => []);
    const result = [];
    for (let index = 2; index < lines.length; index++) {
        if (!/^(?:€\s*)?\d{1,4}[,.]\d{2}(?:\s*€)?$/.test(lines[index])) continue;
        const name = lines[index - 2].replace(/^[^\w\u00C0-\u024F]+/, '').trim();
        if (name.length >= 3) result.push({ name, catena: chainName, priceOffer: normalizePrice(lines[index]), format: lines[index - 1], extractionSource: 'preview_text' });
    }
    log.info(`${chainName}: fallback preview offers=${result.length}`);
    return mergeUniqueOffers(result);
}

function normalizePrice(value) { return String(value ?? '').replace(/€/g, '').trim().replace(',', '.'); }
function itemKey(item) { return `${String(item.catena).toLowerCase()}|${String(item.flyerId || 'no-flyer')}|${String(item.name).toLowerCase().replace(/\s+/g, ' ').trim()}|${normalizePrice(item.priceOffer)}`; }
function mergeUniqueOffers(items) {
    const map = new Map();
    for (const item of items) {
        if (!item?.name || !item.priceOffer) continue;
        const key = itemKey(item);
        if (!map.has(key) || item.extractionSource === 'offers_api') map.set(key, item);
    }
    return [...map.values()];
}
async function dismissCookies(page, log) {
    for (const label of ['Continua senza accettare', 'Rifiuta', 'Accetta tutti', 'Accetta', 'OK', 'Continua']) {
        try { const button = page.locator(`button:has-text("${label}")`).first(); if (await button.isVisible({ timeout: 800 })) { await button.click(); log.info(`Cookie dismissed: ${label}`); return; } } catch { /* ignore */ }
    }
}
