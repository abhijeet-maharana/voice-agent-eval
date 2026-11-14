# When would you choose GraphQL over REST for a new API?

**Priority:** 1

## Short Answer
GraphQL fits when many clients need different shapes of the same data, for example a web app and a mobile app, and over-fetching or many round trips hurt. REST fits public APIs, simple resource models and cases where HTTP caching matters. GraphQL moves cost to the server: query complexity limits, N+1 queries (fixed with batching such as DataLoader) and harder caching.

## Going Deeper
A strong answer names the team and client mix as the deciding factor, not fashion. It mentions persisted queries for caching and security, depth and cost limits to stop expensive queries, schema evolution without versions (deprecate fields), and that errors come back with a 200 status, so monitoring must read the response body. It may mention tRPC or typed REST with OpenAPI when all clients are in one TypeScript codebase.
