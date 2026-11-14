# Design a rate limiter for a public API.

**Priority:** 1

## Short Answer
Clarify the limit first: per API key or per IP, requests per second or per minute, hard reject or queue. Pick an algorithm: token bucket (allows short bursts) or sliding window (smoother). Keep counters in a shared store such as Redis with atomic increments, so every API node sees the same count. Reject with 429 and a Retry-After header. Decide what happens when Redis is down: fail open or fail closed.

## Going Deeper
A strong answer compares fixed window (simple, but allows double bursts at window edges), sliding window log (exact, memory heavy) and sliding window counter (a good middle ground). It makes the check and increment atomic (a Lua script or a single INCR with expiry), adds local in-memory limits as a first line, returns rate limit headers so clients can back off, and names different tiers per plan. It explains why fail open is usually right for a paid API and fail closed for login endpoints.
