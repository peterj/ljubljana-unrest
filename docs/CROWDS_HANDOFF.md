# Crowds at police lines: handoff

For an agent picking up crowd behaviour (the standoff ladder) or the Clash mission. The user-facing description of
the `standoff` spawn option is in [PLUGIN_AUTHORING.md](PLUGIN_AUTHORING.md#runtime-capabilities). This page is the
map of the code and the decisions behind it.

## What it is

Crowds used to walk straight into a cordon: a march's flow field ignores police, so physics shoved the front ranks
into the shields, and anyone above 0.85 agitation turned on the police by themselves. Now a protester or
counter-protester group the AI runs climbs a ladder (`g.heat`) when a cordon blocks its way:

| Level | Mode | What the group does |
|---|---|---|
| 1 calm | `MODE.STANDOFF` | walks up to about 10 m of the line and stands; the rest queue behind. 60 s after its front got there → 2 |
| 2 probe | `MODE.STANDOFF` | as 1, plus a knot of 5–15 people from the front leans on the line for 10–20 s, then comes back |
| 3 breach | `MODE.PUSH` | the whole group leans on the line |
| 4 pyro | `MODE.STORM` | storms one point of the line (a flow field to just behind it) while its leader throws firecrackers there |

Police action within ~40 m (charge, kettle, arrest, snatch, gas, water, shield push, shots) or the group's own people
hurt or arrested by police step it up, at most once per 10 s. 90 s without either drops a level. Each kind has a
ceiling (`CEILING` in standoff.ts; default 3, militant kinds 4).

## Decisions to keep

- **Agitation does not drive the ladder.** It only sets the starting level. In Clash's old march the crowd reached
  0.75 agitation just squeezing into Čopova; an agitation trigger sent peaceful marches at the shields again.
- **Only the timer (1 → 2) and police action escalate**, as the user specified. Escalation is not inevitable: quiet
  policing calms crowds (ESIM: indiscriminate force unites a crowd against the police).
- **The player's own groups are exempt** (`standoff.exempt`, the protest side's protesters): their fire-up ladder
  (`Mission.fireUp`) stays separate.
- **Missions keep control.** The ladder only overrides `MARCH` and its own modes. A mission's `PUSH` / `STORM` order
  sets a floor at level 3 / 4; any other mode (hold, riot, sit, disperse, shield) hands the group back at once.
- **Probes are one reusable group per crowd group** (`g.standoff.probeGroup`, label `… · probe`, `probeOf` set):
  splitting off new groups each time would fill the group slots.
- **Firecrackers: flinch, not injury.** Officers within 4 m drop shields (no BRACE armour) and push at half strength
  for 6 s, and get stressed. Only the group leader throws, so snatching them stops it.
- **Local flash, not the screen strobe**, drawn on the overlay; dimmed when the ☀ switch is off. The HUD shows the ☀
  switch once a firecracker has gone off (`standoff.flashed`).

## Code

| Path | What |
|---|---|
| `src/sim/standoff.ts` | the ladder: blocking test, timer, triggers, cool-down, probes, breach point, throws and blasts |
| `src/sim/crowd.ts` | kernel: `MODE.STANDOFF` (stop at the police on the 4 m grid, step back closer, queue/creep), blasts (`u.blasts`, `flinchAt`) |
| `src/sim/world.ts` | `world.standoff`; `provoke()` called from every police action; `standoff.step()` per sim step |
| `src/main.ts` | `standoff.update()` per intel readback → feed messages (one per kind every 12 s); exempt factions |
| `src/game/mission.ts` | group tags (STANDOFF, PROBING, PROBE, FIRECRACKERS); firearms provoke; storm drain only for the player's groups |
| `src/ui/overlay.ts`, `src/audio/sound.ts`, `src/ui/hud.ts` | throws, flash and glow; bang; ☀ switch |
| `src/game/scenarios/runtime.ts`, `engine.ts`, `sdk.d.ts` | the SDK `standoff: { level, ceiling, blows }` crowd option; probes counted with their crowd actor |
| `src/game/missions/clash.ts` | Clash, the first built-in on the Scenario SDK |
| `tests/standoff.test.ts` | the ladder against a fake world |

## Things that are not obvious

- **Blocking:** a line blocks a group heading through it (toward `g.goal`, or along its recent movement) within 60 m
  of its front, or one it stands within 15 m of. A group heading through a line that presses up within 6 m of a
  group already standing off at it joins the standoff however far back: a 2,600-person march queues ~200 m.
- **Queueing in the kernel** took three attempts. A hard stop behind slow people deadlocks the front row when the
  flow field runs diagonally (row neighbours count as "ahead"); stopping within 0.8 m froze crowds whose normal
  spacing is ~0.6 m. Now: behind someone slow, creep at 0.3 m/s; stop only when pressed under 0.9 × `R_SAME`.
- **The 1-minute timer** starts when the front gets within 15 m of the line, not when the standoff begins.
- **A group whose centre crossed the line** has broken through and marches on (`g.standoff.side`).
- **Blows** (`g.touchy`, SDK `blows: true`): health lost since the last readback by a member within 1.6 m of an officer.
  Brawl damage away from officers does not count.
- **Pushing groups press calm ones into the shields.** Once one group is at 3, the calm groups in front of it get
  hurt and escalate in turn. That is the crowd physics, not the ladder; tune there if it cascades too fast.

## Clash on the SDK

Clash was reworked (2026-10-25): a peaceful rally of 2,000 holds Trg republike; a counter-protest of 900 on Kongresni
trg (`standoff: { level: 2, ceiling: 4, blows: true }`) sets off for it after 30 s. Four cordons seal the short routes
(Šubičeva east end ×3, south of Šubičeva by Trg republike ×2, a passage ×1, south-west ×1); they were placed by
shortest-route cuts on the cost grid, and the long way round south of the old town stays open. The station (3:20)
and Tivoli (7:00) waves head for the rally and miss the cordons.

It is written like a plugin, with only the public builders (`clashScenario( sdk )`), and registered through
`scenarioMission`. The old map markings (destination zone, wave countdown) are gone: SDK scenarios have HUD rows,
not overlays. `examples/clash-scenario.ts` (`clash-rules`) is still the preview of the old march version.

## Checking work

```bash
npm run typecheck && npm test
```

The user plays the changes in the game and reports back; do not run browser playthroughs unless asked. A baseline
from 2026-10-25 for comparison: the old Clash with a cordon across Čopova had 373 injuries caused by police by
t = 339 s; with the ladder, 81 by t = 331 s.

## Open

- The Clash cordon positions have not been seen in the game.
- The flinch effect on officers was confirmed to compile and fire, not measured.
