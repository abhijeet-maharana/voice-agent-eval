# Design a URL shortener.

## Short Answer
Requirements and scale first (reads far outnumber writes). API: create and redirect. IDs: base62 from a counter or random with collision checks. Storage: a key value store. A cache in front for hot links. 301 vs 302 trade-off for analytics.

## Going Deeper
Go deeper on: custom aliases, expiry, abuse prevention, analytics through an async queue, and how the design changes at 10x traffic.
