# Italian Supermarket Flyers & Deals Scraper

Apify Actor for extracting current promotional offers from Italian grocery flyers into a structured dataset suitable for comparison, price monitoring and downstream analytics.

## Current coverage

The Actor automatically detects active flyers and extracts products from structured flyer-offer APIs where available. Clean structured output is the default behaviour.

| Chain | Current extraction quality |
| --- | --- |
| Conad Superstore | Structured API offers — validated |
| Lidl | Structured API offers — validated |
| Eurospin | Structured API offers — validated |
| MD Discount | Structured API offers — validated |
| Aldi | Structured API offers — validated |
| Famila | Included for validation |
| iN's Mercato | Included for validation |
| Esselunga | Preview fallback only when available; excluded by default |

A complete validation run on 2026-06-04 produced **997 structured API-quality current offers** from Conad Superstore, Lidl, Eurospin, MD Discount and Aldi. An additional 10 Esselunga preview records were available in lower-quality fallback mode.

Coverage can change when active flyers or source-site data availability change.

## Clean output by default

The default input enables `structuredOnly: true`. This excludes preview-only records from the dataset, keeping the standard output suitable for data pipelines and price monitoring.

Set `structuredOnly` to `false` only when you intentionally want to include marked fallback records:

```json
{
  "catena": "tutti",
  "structuredOnly": false,
  "maxItemsPerChain": 1000,
  "maxTotalItems": 10000
}
```

Fallback records are always identified with:

```json
{
  "extractionSource": "preview_text",
  "dataQuality": "preview_fallback"
}
```

## Output fields

Each structured dataset record can include:

| Field | Description |
| --- | --- |
| `name` | Product name |
| `catena` | Store chain display name |
| `chainSlug` | Stable chain identifier |
| `priceOffer` | Promotional price as source-compatible text |
| `priceOfferValue` | Promotional price as a numeric value for analytics |
| `priceOriginal` | Original price text, where supplied by the source |
| `priceOriginalValue` | Original price numeric value, where supplied by the source |
| `currency` | Currency code, `EUR` |
| `country` | Country code, `IT` |
| `format` | Quantity or packaging format |
| `validFrom`, `validTo`, `validity` | Flyer validity period when detectable |
| `flyerId`, `pageNumber`, `offerId` | Source flyer/product references |
| `img` | Flyer page or product image URL where supplied |
| `sourcePageUrl` | Chain flyer source page |
| `offersApiUrl` | API endpoint used for structured extraction |
| `extractionSource` | `offers_api` or `preview_text` |
| `dataQuality` | `structured_api` or `preview_fallback` |
| `offerKey` | Stable key for one current promotional offer |
| `productFingerprint` | Product-matching helper for historical comparison |
| `scrapedAt` | ISO timestamp of the Actor run |

## Recommended all-chain input

```json
{
  "catena": "tutti",
  "keyword": "",
  "structuredOnly": true,
  "maxItemsPerChain": 1000,
  "maxTotalItems": 10000,
  "diagnosticMode": false,
  "investigateZeroResults": false
}
```

### Limit behaviour

For a single selected chain, use `maxItems`.

For `catena: "tutti"`, use:

- `maxItemsPerChain`: maximum products retained from each supermarket, preventing a large catalogue from exhausting the output before other chains are processed.
- `maxTotalItems`: overall run safety ceiling.

Example: `maxItemsPerChain: 100` gives each available chain room to return up to 100 products rather than letting the first large chain consume a single global quota.

## Product keyword filter

Use `keyword` to filter product names, for example:

```json
{
  "catena": "tutti",
  "keyword": "birra",
  "structuredOnly": true,
  "maxItemsPerChain": 1000,
  "maxTotalItems": 10000
}
```

The legacy `categoria` input remains accepted by the code for backward compatibility, but the current source does not consistently provide true category metadata. `keyword` is therefore the accurate public filter.

## Run summary

Every run stores a `RUN_SUMMARY` JSON record in the default key-value store. It includes total products saved, limit settings, quality mode and per-chain extraction status.

Possible statuses include:

- `structured_api`: clean structured products were obtained.
- `preview_fallback`: fallback records were included because `structuredOnly` was disabled.
- `preview_fallback_excluded`: preview products existed but were excluded from clean output.
- `no_active_flyers_detected`: no supported active flyer cards were detected.
- `active_flyers_without_structured_offers`: flyers exist but no structured products were returned.
- `skipped_total_limit_reached`: the global safety ceiling was reached before this chain was processed.

## Diagnostics

For development and source validation only:

- `diagnosticMode: true` stores API response diagnostics for structured flyers.
- `investigateZeroResults: true` stores page HTML, screenshot, DOM audit and click probes only for chains with zero structured API products.

## Notes

This Actor extracts publicly displayed promotional information through the flyer source experience. Results represent current visible or structured offers at run time; availability and completeness depend on active flyers and source-site coverage.
