# B3 benchmark baseline — 2026-09-01

**Status:** recorded 2026-09-01. Baselines are recorded, not gated: no CI
step compares these numbers, and no workflow runs the script that produced
them. The performance gate is B6's; this is the figure it will be set against.

Regenerate with `make bench-baseline` from `Server/`. The script refuses to
write a baseline that is missing any of the benchmarks it expects, so a rename
cannot silently shorten the table.

## Provenance

- Commit: `8a5817a14329dc839a94cf234de1d2f986aa6c4d`
- Date (UTC): 2026-09-01
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
- `go test ./...` runs the three packages' benchmark binaries concurrently
  (`-p` defaults to GOMAXPROCS), so each package's figures are measured under
  the others' load. A noise source the command shape B3-6 specifies accepts.
- `BenchmarkPermissionInvalidation` runs against a bare hub with no
  `PermissionService`, so every client's verdict is a live lookup. That is the
  uncached worst case, not what a server with the 30 s permission cache pays.
- Regenerating writes a NEW dated file. Replace the row in
  `docs/plans/README.md` and delete the superseded document — only the newest
  baseline is kept, so there is one number to compare against.

## Against the 2026-08-30 baseline this replaces

Same machine, same toolchain. Five of six rows reproduce within their
confidence ranges. `PermissionInvalidation` does not (927.4µ ± 2% / 3.601k
allocs recorded → 1.496m ± 12% / 3.801k here), but the recorded row is
**irreproducible at its own provenance commit**: re-run at `ec8ef24a` on
this machine it measures 1.21–1.29 ms / 3.801k allocs — and allocs/op is
deterministic for fixed code, so the recorded run's working tree did not
match the commit it names (it was recorded mid-flight in the B3-6
multi-worktree session). Measured at `f9245212`, `ead64cdc`, `e13adaf8`,
`227ae081` and `8a5817a`, the figure is flat — no B3 structural commit
moved it. Details in the B3 exit section of
[hp-3-scorecard-2026-08-29.md](hp-3-scorecard-2026-08-29.md).

## benchstat

```
goos: windows
goarch: amd64
pkg: github.com/J3vb/OwnCord/Server/api
cpu: AMD Ryzen 9 7950X3D 16-Core Processor
                   │ b3-baseline │
                   │   sec/op    │
UploadAdmission-32   268.3n ± 4%

                   │ b3-baseline │
                   │    B/op     │
UploadAdmission-32    56.00 ± 0%

                   │ b3-baseline │
                   │  allocs/op  │
UploadAdmission-32    3.000 ± 0%

pkg: github.com/J3vb/OwnCord/Server/service
                  │ b3-baseline │
                  │   sec/op    │
ReadStateWrite-32   59.81µ ± 6%

                  │ b3-baseline  │
                  │     B/op     │
ReadStateWrite-32   5.603Ki ± 0%

                  │ b3-baseline │
                  │  allocs/op  │
ReadStateWrite-32    163.0 ± 0%

pkg: github.com/J3vb/OwnCord/Server/ws
                          │ b3-baseline  │
                          │    sec/op    │
ReconnectStorm-32           391.5µ ± 30%
PermissionInvalidation-32   1.496m ± 12%
BroadcastFanout-32          3.720µ ±  7%
ReplaySelection-32          26.78µ ± 20%
geomean                     87.40µ

                          │ b3-baseline  │
                          │     B/op     │
ReconnectStorm-32           592.2Ki ± 0%
PermissionInvalidation-32   126.4Ki ± 0%
BroadcastFanout-32            992.0 ± 0%
ReplaySelection-32          31.35Ki ± 0%
geomean                     38.83Ki

                          │ b3-baseline │
                          │  allocs/op  │
ReconnectStorm-32            952.0 ± 0%
PermissionInvalidation-32   3.801k ± 0%
BroadcastFanout-32           2.000 ± 0%
ReplaySelection-32           10.00 ± 0%
geomean                      92.23
```
