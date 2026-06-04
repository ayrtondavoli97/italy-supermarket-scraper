# Italian Supermarket Flyers & Deals Scraper

Apify Actor for extracting current promotional offers from Italian supermarket flyers into a structured dataset suitable for comparison, price monitoring and downstream analytics.

## Current coverage

The Actor automatically detects active flyers and extracts products from structured flyer offer data when available.

| Chain | Current extraction quality |
| --- | --- |
| Lidl | Structured API offers |
| Eurospin | Structured API offers |
| MD Discount | Structured API offers |
| Aldi | Structured API offers |
| Esselunga | Preview fallback where visible products are available |
| Conad | Monitored; structured coverage under development |
| Penny Market | Monitored; structured coverage under development |
| Coop | Monitored; structured coverage under development |
| Carrefour | Monitored; structured coverage under development |

Coverage can change when active flyers or source-site data availability change.

## Output fields

Each dataset record can include:

| Field | Description |
| --- | --- |
| `name` | Product name |
| `catena` | Store chain display name |
| `chainSlug` | Stable chain identifier |
| `priceOffer` | Promotional price |
| `priceOriginal` | Original price, where supplied by the source |
| `discount` | Discount, where supplied by the source |
| `format` | Quantity or packaging format |
| `validFrom`, `validTo`, `validity` | Flyer validity period when detectable |
| `flyerId`, `pageNumber`, `offerId` | Source flyer/product references |
| `img` | Flyer page or product image URL where supplied |
| `sourcePageUrl` | Chain flyer source page |
| `offersApiUrl` | API endpoint used for structured extraction |
| `extractionSource` | `offers_api` or `preview_text` |
| `dataQuality` | `structured_api` or `preview_fallback` |
| `offerKey` | Stable record key for a specific offer |
| `productFingerprint` | Product matching helper for historical comparison |
| `scrapedAt` | ISO timestamp of the Actor run |

## Input example

```json
{
  "catena": "tutti",
  "categoria": "",
  "maxItems": 5000,
  "diagnosticMode": false
}
```

`maxItems` is an upper limit: the Actor returns fewer records when fewer currently mapped offers are available.

## Run summary

Every run stores a `RUN_SUMMARY` JSON record in the default key-value store. It includes the product total, whether the maximum limit was reached, and per-chain extraction status:

- `structured_api`: clean structured products were obtained.
- `preview_fallback`: only visible preview products were available.
- `no_active_flyers_detected`: no supported active flyer cards were detected.
- `active_flyers_without_structured_offers`: flyers exist but no structured products were returned.
- `skipped_max_items_reached`: the global output limit was reached before this chain was processed.

## Notes

This Actor extracts publicly displayed promotional information through the flyer source experience. Results represent current visible or structured offers at run time; availability and completeness depend on active flyers and source-site coverage.
