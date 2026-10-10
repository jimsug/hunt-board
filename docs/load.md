# Load run

`scripts/load.ts` puts N viewers on one board, M of them moving a pointer ten times a second, with one of them moving a note every five seconds, and reports what each viewer received, the live latency (the sender's clock rides in the cursor's y coordinate) and the service's health.

```
bun run scripts/load.ts --url http://127.0.0.1:3190 --secret <secret> --hunt <17-char id> --viewers 50 --movers 10 --seconds 60
```

The hunt id and the node id must be Meteor-style ids, as Jolly Roger's are.

## 11 October 2026, one process on the development machine

Service started with `FEED=off` against a scratch Mongo; 50 viewers, 10 movers, 60 s.

| | |
|---|---|
| Joining 50 viewers | 232 ms |
| Live updates delivered | 293,020 (10 movers at 10 a second to 49 others each) |
| Per viewer | about 99 messages a second |
| Live latency, send to another socket | p50 3 ms, p90 5 ms, p99 7 ms, max 12 ms |
| Writes | 12, fanned out as 1,200 `change` messages |
| Memory | 73 MB before, 122 MB after |
| Errors | none |

Jolly Roger isn't involved in this run: with the feed on, the service holds one subscription pair per hunt that has a board, however many viewers the board has (see the feed tests), so Jolly Roger's load doesn't grow with viewers.
