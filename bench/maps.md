# QBSK — map size, and the decision not to build chunking

an earlier release criterion 1: **measure whether anything needs a map bigger than memory** before
designing C6. The phase said outright that "decide not to build it, and record why" was a
valid outcome. This is that record.

## Measurement environment

| | |
|---|---|
| Date | August 8, 2026 |
| OS | Windows 11 Home 10.0.26200 |
| Node | v24.19.0 |
| Command | `node bench/maps.mjs` |

Each map is `size` wide and half as tall. `path` runs corner to corner — the worst case —
on open floor and on a serpentine maze that forces the route to double back, because A*
on open floor expands almost nothing and would flatter the result. `sight` is one look at
radius 11 from the centre.

**Read the shape, not the milliseconds.** The absolute figures move between runs (see
`bench/tiles.md` for the same caution); what reproduces is how each column grows with the
map.

## Result

```
   size |    cells |  path open |  path maze |  sight r11 |   map KB
  ------+----------+------------+------------+------------+---------
     60 |     1800 |       2.86 |       5.42 |      2.098 |       4
    200 |    20000 |       3.24 |      14.83 |      0.661 |      42
    500 |   125000 |       7.64 |      45.15 |      0.852 |     252
   1000 |   500000 |       4.63 |     128.37 |      0.923 |     992
   2000 |  2000000 |      11.60 |     507.44 |      1.321 |    3938
```

## The decision: chunking is not built

**Memory is nowhere near a limit.** A 2000×1000 map — two million cells, far larger than
anything this project intends to draw — is **4 MB** held as QBSK values. A 1000×500 map is
under one megabyte. Chunking exists so a world can be larger than memory, and memory is
not the constraint at any size worth having.

**And chunking would not fix what does get slow.** The one column that grows badly is A*
across a maze: 128 ms at 1000 wide, 507 ms at 2000. That cost is the search space, and
splitting the same map into chunks does not shrink it — a route from one corner to the
other still has to be found across the whole thing. The answer to that problem is
**hierarchical pathfinding** (a coarse route between regions, refined per chunk), which is
a different feature with a different design, and it is not what C6 describes.

So C6 is deferred, not skipped, with a condition attached: **revisit when a world needs to
be streamed from disk rather than held**, which is a save-format question before it is a
rendering one. Nothing in the project is close to that.

**Composition was deliberately not measured against map size**, because the screen is
bounded: a 2000×1000 map still draws 120×40. That is the fact the whole decision turns on
and it is worth stating plainly rather than leaving implied.

## What the measurement did find

**`sight` was allocating a mask the size of the whole map on every call.** The scan is
bounded by the radius; the allocation was not, so a radius-11 look cost 1.8 ms on a
60-wide map and **44 ms on a 2000-wide one** — a cost that had nothing to do with what the
player could see.

Fixed by collecting lit cells sparsely by row and building the mask strings at the end. A
radius touches about 2r+1 rows however large the map is:

```
  sight r11 at size 2000    44.29 ms  ->  1.32 ms      33x
  and it is now flat:       0.66 ms at 200, 1.32 ms at 2000
```

A test pins the property rather than the number (`tests/unit/fov.test.ts`): a map thirty
times larger must not be twenty times slower at the same radius.

**That is the argument for criterion 1 existing.** The phase set out to decide about
chunking and found a real inefficiency in shipped code instead — one that no amount of
reasoning about the algorithm would have surfaced, because the algorithm was correct and
the allocation around it was not.
