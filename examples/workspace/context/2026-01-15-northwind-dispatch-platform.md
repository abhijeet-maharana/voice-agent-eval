# Northwind dispatch platform · architecture context

A sample context pack: the system a round is grounded in. The "Architecture evaluation" round needs one; other rounds can use one.

## System
Northwind (fictional) runs route planning for small delivery fleets. Dispatchers watch live driver positions on a map and reassign stops during the day.

## Stack
TypeScript, React, Node.js, Postgres, Redis, AWS.

## Known pressure points
- Live driver positions pushed to about 500 dispatchers at once, from battery-sensitive mobile clients.
- Customer webhooks for delivery events; some customer endpoints are slow or down for hours.
- A public API with partners that retry aggressively on timeouts.

## Questions worth asking
- How would you fan out position updates to 500 dispatchers without overloading Postgres?
- How should the webhook pipeline treat an endpoint that has been failing for six hours?
