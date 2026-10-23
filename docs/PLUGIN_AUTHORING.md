# Scenario Plugins (SDK v1)

Mission plugins are ES modules that export `sdkVersion = 1` and a factory returning one or more Scenario SDK definitions. Plugins are trusted, unsandboxed JavaScript; only load code from an author you trust.

## Run Locally

Install dependencies and start Vite:

```sh
npm install
npm run dev
```

Open the URL printed by Vite with the example plugin and scenario ID:

```text
http://localhost:5173/?plugin=/examples/hello-scenario.js&m=hello-scenario
```

The factory receives only the public Scenario SDK builders. It does not receive `Mission`, simulation enums, `World`, raw GPU buffers, or the DOM. Do not import game internals from a plugin.

## Minimal Scenario

```js
export const sdkVersion = 1;

export default ( { defineScenario, place, survive } ) => defineScenario( {
    id: 'hello-scenario',
    title: 'Hello Square',
    subtitle: 'A short description',
    brief: 'Keep Trg republike calm for one minute.',
    goals: [ 'Hold the square for 1:00' ],
    locations: { square: place( 'Trg republike' ) },
    setup( ctx ) {

        ctx.presentation.focus( 'square', 0.5 );
        ctx.spawn.crowd( { id: 'demonstrators', at: 'square', people: 300 } );
        ctx.spawn.squad( { id: 'squad-east', at: [ - 10, 20 ] } );

    },
    objectives: [ survive( { id: 'hold', seconds: 60, label: 'Hold the square' } ) ],
} );
```

See [hello-scenario.js](../examples/hello-scenario.js) for a runnable example. Examples use `menu: false` to stay out of the mission picker while remaining directly loadable by URL.

## Definitions

`defineScenario` validates and freezes plain configuration. Unknown fields, duplicate IDs, malformed values, and missing location references fail registration or setup rather than being ignored.

Scenario IDs, location aliases, behavior IDs, resource IDs, and command IDs are lowercase slugs. Locations use `place(name)`, `landmark(name)`, `target(name)`, or fixed local-meter coordinates. Named locations are resolved before setup runs.

The current preview supports police-side scenarios with one primary objective: `survive`, `protect`, `extract`, `holdBuilding`, `preventClash`, or `escortConvoy`. Ordered `defineOutcome` rules can end a scenario before its default objective result. A synchronous `score` policy returns a validated star count and result rows.

`phase` supplies short synchronous HUD text. `indicators` adds rows driven by supported semantic counters. `initiallyLockedCommands` hides configured orders from the briefing until a behavior unlocks them.

## Runtime Capabilities

Setup can spawn crowds, bystanders, squads, and vehicles. Spawn calls return owned operations; inspect `settled` outcomes when later logic depends on allocation. Setup waits for outstanding owned operations before entering the briefing.

Attach reusable behaviors with `defineBehavior`. Each attachment gets fresh private state and `start`, `update`, `observe`, `onEvent`, `onAction`, and `stop` hooks. Behaviors can own game-time timers, movement, commands, crowd changes, actors, convoys, and coach cards. Owned work is canceled or cleaned up when the behavior stops.

Player actions are semantic events. Selection contains opaque actor handles, movement contains copied coordinates, and vehicle actions contain vehicle handles; raw groups and person indices are not exposed. Use `ctx.commands.lock(id)` and `unlock(id)` for owner-scoped progressive command availability. Locks are released when the owner stops.

The coach capability supports a chapter, instruction text, step and total, an optional HUD spot, and Continue/Skip callbacks. It clears automatically when its behavior stops.

`ctx.convoys.create({ id, vehicles, vipIndex })` creates a kinematic convoy on the selected city's authored route. `ctx.convoys.get(handle)` returns immutable progress, integrity, blockers, attackers, and speed. `ctx.convoys.at(handle, distance)` samples a route point; `ctx.convoys.depart(handle)` starts movement once. The SDK does not expose the internal convoy object, mesh, or GPU statistics.

`ctx.metrics` contains immutable semantic counters, including per-step `clashContacts` and integrated pressure for `preventClash`. It does not expose raw stats arrays. Command acceptance is not proof of a physical result such as injury, arrest, arrival, or contact; use observed facts for those outcomes.

## Registration And Trust

A factory may return one definition or an array of definitions. The loader validates the entire package before registering any scenario; duplicate IDs are rejected. The optional `m` query parameter selects a scenario after all `plugin` parameters load.

Same-origin plugins can load without confirmation. Cross-origin plugins are disabled in a default production build. They are enabled in development, or in an explicitly opted-in build:

```sh
VITE_REMOTE_PLUGINS=1 npm run build
```

When enabled, the game asks before importing a remote URL and remembers a confirmed URL only in the current tab's `sessionStorage`. This is a trust prompt, not a sandbox.

## Current Limits

The Scenario SDK is an experimental preview, not a full replacement for the built-in mission system. Existing missions stay on their original path until each candidate passes its own parity gate. Scenario-specific directors, protest-side systems, custody workflows, overlays, and full score/result compatibility are still under development. Setting `city` alone does not guarantee map independence; shared host helpers and authored routes may still be Ljubljana-specific.

Run `npm test`, `npm run build`, and `tsc --noEmit --strict --lib ES2022,DOM src/game/scenarios/index.d.ts` when changing the SDK. Add source-backed tests for setup, timing, outcomes, scoring, and player workflows, plus a browser smoke when the host/UI path is involved.
