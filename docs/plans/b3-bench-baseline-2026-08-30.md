# B3 benchmark baseline — 2026-08-30

**Status:** recorded 2026-08-30. Baselines are recorded, not gated: no CI
step compares these numbers, and no workflow runs the script that produced
them. The performance gate is B6's; this is the figure it will be set against.

Regenerate with `make bench-baseline` from `Server/`. The script refuses to
write a baseline that is missing any of the benchmarks it expects, so a rename
cannot silently shorten the table.

## Provenance

- Commit: `c7917fcc7e30e49b4baa0b3d084ded8395ccdbe7`
- Date (UTC): 2026-08-30
- Toolchain: `go version go1.26.7 windows/amd64`
- Platform: `windows/amd64`
- CPU: AMD Ryzen 9 7950X3D 16-Core Processor
- benchstat: `go run golang.org/x/perf/cmd/benchstat@v0.0.0-20260825160852-19be9d8e6c70`

Command:

```
go test -run '^$' -bench '^Benchmark(PermissionInvalidation|ReadStateWrite|BroadcastFanout|ReplaySelection|UploadAdmission|ReconnectStorm)$' -benchmem -count=6 ./...
```

## Reading these numbers

- One machine, one run. A figure here is comparable only with another run of
  this script on the same hardware and toolchain — never across contributors.
- The `ws` benchmarks point the default logger at `io.Discard` for the
  duration of the run (`quietLogs`, `ws/hub_bench_test.go`), so these figures
  exclude the log sink's write cost but keep the record-formatting cost.
- `± n%` is benchstat's confidence range over the repeats. The
  allocation-heavy benchmarks carry the widest ranges; read a small movement in
  those as noise until a repeat says otherwise.

## benchstat

```
goos: windows
goarch: amd64
pkg: github.com/J3vb/OwnCord/Server/api
cpu: AMD Ryzen 9 7950X3D 16-Core Processor
                   │ b3-baseline │
                   │   sec/op    │
UploadAdmission-32   253.2n ± 4%

                   │ b3-baseline │
                   │    B/op     │
UploadAdmission-32    56.00 ± 0%

                   │ b3-baseline │
                   │  allocs/op  │
UploadAdmission-32    3.000 ± 0%

pkg: github.com/J3vb/OwnCord/Server/service
                  │ b3-baseline │
                  │   sec/op    │
ReadStateWrite-32   52.61µ ± 5%

                  │ b3-baseline  │
                  │     B/op     │
ReadStateWrite-32   5.597Ki ± 0%

                  │ b3-baseline │
                  │  allocs/op  │
ReadStateWrite-32    163.0 ± 0%

pkg: github.com/J3vb/OwnCord/Server/ws
                          │ b3-baseline  │
                          │    sec/op    │
ReconnectStorm-32           358.9µ ±  7%
PermissionInvalidation-32   860.6µ ±  2%
BroadcastFanout-32          3.480µ ±  3%
ReplaySelection-32          16.26µ ± 32%
geomean                     64.66µ

                          │ b3-baseline  │
                          │     B/op     │
ReconnectStorm-32           592.2Ki ± 0%
PermissionInvalidation-32   121.0Ki ± 0%
BroadcastFanout-32            992.0 ± 0%
ReplaySelection-32          31.35Ki ± 0%
geomean                     38.41Ki

                          │ b3-baseline │
                          │  allocs/op  │
ReconnectStorm-32            952.0 ± 0%
PermissionInvalidation-32   3.601k ± 0%
BroadcastFanout-32           2.000 ± 0%
ReplaySelection-32           10.00 ± 0%
geomean                      91.00
```
