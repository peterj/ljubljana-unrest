# Mission Plugins

Mission plugins are ES modules loaded when the game starts. A plugin exports the SDK version it targets and either a mission class or a factory that returns one or more mission classes.

The runnable example is [`examples/hello-mission.js`](../examples/hello-mission.js). It imports no game files; all mission dependencies come from the SDK argument.

## Run Locally

Install dependencies and start the Vite development server:

```sh
npm install
npm run dev
```

Open the URL printed by Vite with the example plugin and mission id:

```text
http://localhost:5173/?plugin=/examples/hello-mission.js&m=hello-square
```

The plugin file must be served as a JavaScript ES module. For local development, serving it from the game's origin avoids a remote-plugin confirmation. If it is on another origin, the server must permit cross-origin module requests and the game will ask before loading it.

## Plugin Shape

Use a factory so the class can extend `Mission` from the supplied SDK:

```js
export const sdkVersion = 1;

export default ({ Mission }) => class MyMission extends Mission {
    static id = 'my-mission';
    static title = 'My Mission';
    static subtitle = 'A short description';
    static side = 'police';
    static brief = 'What is happening in this mission.';
    static goals = [ 'Complete the objective' ];
    static tips = [ 'A useful player tip' ];

    async setup() {
        // Create groups, squads, goals, and other mission state.
    }

    tick() {
        if ( this.t >= 60 ) this.end( true, 'Objective complete.' );
    }
};
```

The loader also accepts a default-exported subclass that already extends the exact `Mission` constructor used by the game. For standalone plugin files, the factory above is the portable way to receive that constructor. A factory may return one class or an array of classes, and may be async; the loader awaits it and registers the returned missions together.

## Mission Metadata

Every mission must satisfy these registry rules:

- `id`: unique lowercase slug matching `[a-z0-9][a-z0-9-]{0,39}`. It becomes the `m` query parameter.
- `title`, `subtitle`, and `brief`: non-empty strings. The brief is rendered as text; only balanced `<b>` and `<i>` tags are preserved.
- `side`: either `'police'` or `'protest'`.
- `goals` and `tips`: arrays of non-empty strings.
- `city`: optional folder name matching `[a-z0-9_-]+`, corresponding to a folder under `public/data/`.

The mission is selectable with `?plugin=<plugin-url>&m=<id>`. The game loads every `plugin` parameter before looking up the mission. A module, factory, or class that fails validation registers none of its missions; failures appear in the mission menu and do not prevent other plugins from loading.

## Lifecycle And SDK

Extend `Mission` and use its lifecycle methods:

- `async setup()` prepares the world and mission state before play begins.
- `start()` schedules opening events or timers after the player starts the mission.
- `tick(dt)` updates mission rules. `this.t` is elapsed game time in seconds; call `this.end(win, reason)` to finish.
- `objectives()`, `phase()`, and `score(win)` provide the HUD and result screen.
- `commands()` returns the standard orders for the mission side; override it to add or wrap orders.
- `draw(overlay)` draws mission-specific map overlays.

The base class also provides helpers such as `event()`, `after()`, `bystanders()`, and `nudgeOpinion()`. The SDK includes `Mission`, simulation enums and helpers, colors, geometry and spawn helpers, `Convoy`, and the `DefendMission` template. See the full list in [`src/game/sdk/index.js`](../src/game/sdk/index.js).

For a building-defense scenario, extend `DefendMission` instead of implementing waves, exits, and breach logic from scratch. Set the template's `target` and `waves` statics; see the built-in missions in [`src/game/missions/defend.js`](../src/game/missions/defend.js).

Import dependencies only from the supplied SDK object. Importing the game's source files may work in development but is not a supported plugin interface and will fail in production builds.

## Remote Code And Trust

Plugins are **not sandboxed**. They execute in the game page with the page's JavaScript privileges and can access or change its state, storage, and same-origin resources. Only load code from an author you trust.

Same-origin plugins can load without a confirmation. Cross-origin plugins are disabled in a default production build. They are enabled in development, or in a production build made with:

```sh
VITE_REMOTE_PLUGINS=1 npm run build
```

When remote plugins are enabled, the game asks before the first load of each exact URL in the tab. Confirmed URLs are remembered in `sessionStorage` for that tab. Remote URLs must use HTTPS, except HTTP URLs on localhost. A production opt-in is not a sandbox or a security boundary.

## Maps

Set `static city = 'folder-name'` to load map data from `public/data/folder-name/`; omit it to use the default city. The current `Mission` base class and several shared helpers still assume Ljubljana places and landmarks. A different map may therefore require plugin-owned placements and mission logic; setting `city` alone does not make every helper map-independent.
