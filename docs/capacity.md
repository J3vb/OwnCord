# Capacity

How many people one OwnCord server can carry, and on what hardware. Every
number here was measured, except where it says "estimate".

People who change the code, or want to repeat a run, want the
[capacity measurements](architecture/capacity-measurements.md) page. It has
the method, the commands and every run in full.

## The short answer

| People online at once  | Hardware            | Status                                            |
| ---------------------- | ------------------- | ------------------------------------------------- |
| Up to 100, 25 in voice | 2 vCPU / 4 GB / SSD | Measured, every target met with room              |
| About 1,000            | 2 vCPU / 4 GB / SSD | Measured: chat is fine, big login rushes are slow |
| About 2,000            | 4 vCPU / 8 GB / SSD | Estimate, not measured yet                        |

Buy more CPU, not more memory. Memory is not the limit at any of these sizes.

## The profile

The first promise OwnCord makes, on the cheapest machine an owner is likely to
buy:

| Target                         | Result                                     |
| ------------------------------ | ------------------------------------------ |
| 250 registered accounts        | Met                                        |
| 100 people connected at once   | Met, held for 3 minutes                    |
| 25 people in one voice channel | Met: every stream arrived, no lost packets |

During that run each of the 100 people sent a message every 2 seconds, much
busier than a real community. Even so, the server used about a seventh of its
two cores.

## Reference hardware

**2 vCPU, 4 GB RAM, SSD, Linux x64.** That is a small VPS or a single-board
computer.

The test runs the server inside a container held to exactly that budget, so
anyone with Docker can repeat it. The load generators run outside that budget,
so they do not steal the server's CPU.

The test runs on one machine with no router or proxy in between. On a real
network, add your own network delay to every number here.

## How fast it feels

These are the limits the server must stay under for 95 out of 100 actions.
They are only ever made stricter, never looser.

| Action                               | Limit  | Measured at 100 online |
| ------------------------------------ | ------ | ---------------------- |
| Signing in                           | 600 ms | 264 ms                 |
| Connecting to chat                   | 200 ms | 17 ms                  |
| Sending a message (until it is sent) | 150 ms | 35 ms                  |
| A message reaching everyone else     | 200 ms | 36 ms                  |
| Joining voice (OwnCord's part)       | 250 ms | 4 ms                   |

Signing in is the slowest on purpose. The password check is made expensive so
stolen password files are hard to crack.

## Sizing for 1,000–2,000 online

**1,000 online, on 2 vCPU / 4 GB, measured:**

- Normal chat is fast: a message reaches everyone in about 14 ms, and the
  server uses less than a tenth of its CPU.
- A burst of four times the normal chat rate is still well inside every limit.
- **A rush of 500 sign-ins in 10 seconds is too much.** About one in five gave
  up. Checking passwords is what fills the CPU.
- **When all 1,000 reconnect at once** (for example after a restart), everyone
  is back within 30 seconds, but each person waits longer than the 5-second
  goal.

**2,000 online is an estimate.** The one run at 2,000 did not count: the test
machine itself ran out of CPU before the server did. Until a valid run exists,
plan on **4 vCPU / 8 GB** for 2,000. That roughly doubles how fast sign-ins and
message delivery can go, which are the two limits on 2 vCPU.

**How far it stretches.** In a stress test where everyone chats nonstop, one
2 vCPU server held every limit up to 300 people, and missed the sign-in limit
at 400. Real communities chat far less than that, which is why 1,000 works.

Above 2,000, the database (SQLite writes one thing at a time) and sending each
message to everyone are the next limits.

### Open-file limit

Each connected person uses one open file on the server. The server raises its
own limit at start-up, but it cannot go above the limit your system sets. A
limit of 1,024 (an old default) runs out at a few hundred people, and 2,000
online needs about 2,100. How to raise it for systemd, Docker or a plain
program: [Open-file limit](hosting/reference.md#open-file-limit-file-descriptors).

## Scale profile

The scale profile is the test for 1,000 to 2,000 people online. It models a
real community instead of a stress test:

- People are spread over 20 text channels, about 100 per channel at 2,000.
- One person in ten is chatting, each sending a message about every 8 seconds.
- People change their status about once every 10 minutes.
- The test also checks a burst of four times that chat rate, a rush of 500
  sign-ins, and everyone reconnecting at once.

The results are in [Sizing for 1,000–2,000 online](#sizing-for-10002000-online).
The full tables, run by run, are in
[Scale profile](architecture/capacity-measurements.md#scale-profile) on the
measurements page.

## Limits you can set

The settings that cap connections, uploads and disk use, and what happens
when you hit each one, are in
[Limits you can set](hosting/monitoring.md#limits-you-can-set).

## What these numbers do not promise

- **They come from one machine on shared CI runners.** Compare them with other
  runs of the same test, not with numbers from other software.
- **Nothing blocks a release on them.** The test runs each week on the
  release branch, so a slowdown shows up in its history.
- **A miss is published, never hidden.** The hardware was chosen before the
  first run. A missed target is recorded and never re-run on a bigger machine
  to make it pass.
