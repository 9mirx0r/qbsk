# QBSK — entity workload

An earlier release criterion 1: **measure before designing.** The question was whether an entity
system can live in QBSK, or whether it has to be TypeScript exposed as natives. The two
are hard to swap later, so the answer had to be a number.

## Measurement environment

| | |
|---|---|
| Date | August 8, 2026 |
| OS | Windows 11 Home 10.0.26200 |
| Node | v24.19.0 |
| Command | `node bench/entities.mjs` |

The workload is deliberately entity-**shaped**, not a microbenchmark: N entities, each a
dict of five components, all read, decided over and rebuilt once per turn, with the scene
composed on top — which is what a turn in a roguelike actually does.

## Result

```
  count |    QBSK |  native |  ratio | verdict
  ------+---------+---------+--------+--------
     50 |    3.57 |   0.030 |   118x | comfortable
    200 |    1.96 |   0.031 |    63x | comfortable
    500 |    1.86 |   0.011 |   165x | comfortable
   1000 |    2.70 |   0.014 |   195x | comfortable
   2000 |    4.88 |   0.031 |   159x | usable
```

The 50-entity row is slower than the 200 and 500 rows because it is measured first and
pays the JIT warm-up. It is left in rather than tidied away: a benchmark that hides its
own noise teaches the wrong lesson about how much to trust a single number.

## The decision

**Entities live in QBSK.**

2000 entities stepped in under 5 ms is affordable, and the reason is the distinction this
whole phase is built on: **a turn is not a frame.** A turn happens when the player acts,
not sixty times a second. 4.88 ms of work on a keypress is invisible; the same work every
frame would not be.

The interpreter is 60–200× slower than the equivalent TypeScript, and that ratio is real.
It is also not the deciding number — the absolute cost is, and the absolute cost fits with
three times the headroom.

What this buys, and it is the reason to prefer it even at 160×: an entity is an ordinary
dict in the live environment, so `vars`, `get` and console evaluation reach it the moment
it exists. The debugging loop built in an earlier release works on the simulation for free. A
TypeScript entity store would be invisible to all of it unless deliberately surfaced,
which is work that would have to be done and then kept in step forever.

## When to revisit

Move to a native store when a turn genuinely needs **more than ~5000 entities**, which is
where this table extrapolates past the frame line. Dwarf Fortress fortress-mode scale
would qualify; a Cataclysm-sized map with an active reality bubble would not.

Re-run `node bench/entities.mjs` before believing any of this on different hardware.
