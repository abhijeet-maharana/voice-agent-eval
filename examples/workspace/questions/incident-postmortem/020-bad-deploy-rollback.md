# A deploy causes errors for 10% of requests. What do you do in the first 15 minutes?

## Short Answer
Roll back first, debug second: the fastest safe step is to return to the last good version or turn off the feature flag. Confirm the error rate drops on the dashboards. Tell people what is happening in one incident channel. Keep the evidence (logs, the failing version, a sample request) for the root cause analysis afterwards.

## Going Deeper
A strong answer explains why a 10% failure suggests one node, one region, one client type or a partial rollout, and how to check that quickly. It covers what to do if a rollback is not safe (a database migration already ran: roll forward with a fix, or keep the old code compatible with the new schema), and proposes follow-ups: canary deploys with automatic rollback on error rate, and migrations that are backward compatible.
