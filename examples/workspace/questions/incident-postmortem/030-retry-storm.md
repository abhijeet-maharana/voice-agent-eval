# A downstream service slows down and your whole system falls over. What happened, and how do you prevent it?

## Short Answer
Likely a retry storm and resource exhaustion: callers time out, retry right away, and multiply the load on a service that is already slow, while their own threads or connections stay busy waiting. Prevent it with timeouts on every call, retries with exponential backoff and jitter and a retry budget, a circuit breaker that fails fast when the service is unhealthy, and bulkheads (separate pools) so one slow dependency cannot use up every connection.

## Going Deeper
A strong answer explains why retries at several layers multiply (3 retries at 3 layers is up to 27 calls), suggests retrying only at one layer, shedding load with 429 or 503 early, serving a cached or degraded response when the dependency is down, and testing it with fault injection. The follow-up includes an alert on dependency latency, not only on errors.
