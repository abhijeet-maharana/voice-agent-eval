# Design a system that delivers webhooks to customer endpoints.

## Short Answer
Write each event to a durable queue in the same transaction as the change that caused it (an outbox), then deliver from workers. Sign every payload (HMAC with a per-customer secret) and include an event id so receivers can drop duplicates. Retry failures with exponential backoff and jitter, stop after a limit, and park the event in a dead letter queue the customer can replay. Isolate slow or failing endpoints so one customer cannot block others.

## Going Deeper
A strong answer says delivery is at least once, so receivers must be idempotent, and explains why exactly once delivery over HTTP is not possible. It covers per-endpoint concurrency limits, timeouts, disabling an endpoint after repeated failures with a notification, ordering (usually not guaranteed; give a sequence number or timestamp instead), secret rotation with two valid secrets for a while, and a delivery log the customer can inspect.
