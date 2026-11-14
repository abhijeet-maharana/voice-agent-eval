# How do you make a payment or order API safe to retry?

**Priority:** 1

## Short Answer
Accept an idempotency key from the client on every request that changes state. Store the key with the request and its result. If the same key arrives again, return the stored result instead of acting twice. Claim the key atomically (a unique constraint or Redis SET NX) so two parallel retries cannot both run, and expire keys after a set time.

## Going Deeper
A strong answer covers the in-progress case (a second request while the first is still running gets a 409 or waits), rejects a reused key with a different body, stores the key in the same transaction as the business change, and says that retries happen everywhere: client timeouts, load balancers, queue redelivery. It may compare this to natural idempotency (PUT with a full resource) and to deduplicating events by id on the consumer side.
