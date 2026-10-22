/** Public protocol version. Plugin modules declare `export const sdkVersion = 1`. */
export const SDK_VERSION: 1;

/** Local map coordinates in meters: x increases eastward, y increases northward. */
export type Point = readonly [number, number];

/** A named map place, resolved before scenario setup; missing places fail preflight. */
export interface PlaceReference {
    /** Distinguishes a named place from fixed coordinates. */
    readonly kind: 'place';
    /** Exact place name in the selected map, including its original spelling. */
    readonly name: string;
}

/** Named landmark, resolved independently of places to avoid ambiguous map names. */
export interface LandmarkReference {
    /** Selects the map landmark lookup rather than a gathering place. */
    readonly kind: 'landmark';
    /** Exact landmark name in the selected map. */
    readonly name: string;
}

/** Named defended target with a footprint and evacuation exits. */
export interface TargetReference {
    /** Resolves both location center and typed building geometry. */
    readonly kind: 'target';
    /** Exact target name in the selected map. */
    readonly name: string;
}

/** Supported location definitions, all validated/resolved before setup. */
export type LocationReference = Point | PlaceReference | LandmarkReference | TargetReference;

/** Immutable map target; raw exits are not yet adjusted by a hold-building exit policy. */
export interface TargetInfo {
    /** Display name from the map. */
    readonly name: string;
    /** Local center in meters, also available through locations.get(alias). */
    readonly position: Point;
    /** Map-authored bounding radius in meters. */
    readonly radius: number;
    /** Outer footprint rings as flattened x/y pairs; inner courtyard rings are not included. */
    readonly footprints: readonly (readonly number[])[];
    /** Map-authored evacuation exit positions. */
    readonly exits: readonly Point[];
}

/** Active sampled people near the defended facade and adjusted evacuation exits. */
export interface BuildingMeasurement {
    /** Active protesters with agitation at least 0.4, within three meters of an outer footprint. */
    readonly facade: number;
    /** Protester counts inside each adjusted exit's twelve-meter radius. */
    readonly exits: readonly number[];
}

/** Target geometry prepared with the same adjusted exits used by a holdBuilding objective. */
export interface BuildingGeometry extends TargetInfo {
    /** Exit positions snapped/cleared using the shared defense policy and optional authored overrides. */
    readonly exits: readonly Point[];
}

/** Circle count over complete sampled population data, not live mutable engine arrays. */
export interface SpatialCountOptions {
    /** Location alias or coordinates defining the circle center. */
    at: string | Point;
    /** Positive radius in meters; the boundary itself is excluded. */
    radius: number;
    /** Optional semantic faction filter; only active people are counted. */
    faction?: 'protester' | 'police' | 'bystander' | 'counter';
    /** Minimum agitation from zero to one; defaults to zero. */
    minimumAgitation?: number;
}

/** Read-only geometry/measurement queries, returning null rather than inventing unavailable counts. */
export interface SpatialContext {
    /** Count active eligible people; null means a population actor lacks a complete observation. */
    count(options: SpatialCountOptions): number | null;
    /** Return setup-time target geometry with objective-consistent adjusted exits. */
    buildingGeometry(targetAlias: string, exitAt?: Readonly<Record<number, Point>>): BuildingGeometry;
    /** Measure facade/exits with the existing defense exit-clearance policy; results cache per observation. */
    building(targetAlias: string, exitAt?: Readonly<Record<number, Point>>): BuildingMeasurement | null;
    /** Nearest connected street point with host clearance; default search 60 meters, maximum 1000. */
    walkable(at: string | Point, radius?: number): Point | null;
}

/** Finite inventory with game-time cooldown; standard commands currently cost one unit. */
export interface ResourceOptions {
    /** Positive integer capacity, at most 100000. */
    capacity: number;
    /** Initial units, default capacity; zero means empty, not unlimited. */
    initial?: number;
    /** Cooldown in game seconds starting at application, default zero. */
    cooldown?: number;
}

/** Normalized immutable inventory configuration. */
export interface ResourceDefinition {
    /** Validated maximum units. */
    readonly capacity: number;
    /** Validated starting units. */
    readonly initial: number;
    /** Validated game-time cooldown. */
    readonly cooldown: number;
}

/** Current inventory; pending reservations are not yet spent. */
export interface ResourceObservation {
    /** Scenario resource ID. */
    readonly id: string;
    /** Configured maximum units. */
    readonly capacity: number;
    /** Unspent units, including reserved ones. */
    readonly left: number;
    /** Units held by accepted/preparing commands. */
    readonly reserved: number;
    /** Units not spent or reserved; HUD availability uses this value. */
    readonly available: number;
    /** Remaining cooldown in game seconds; does not tick while paused. */
    readonly readyIn: number;
}

/** Safe, semantic totals supplied to score policies; no raw stats/readback buffers. */
export interface ScenarioMetrics {
    /** Current public opinion, clamped from 0 to 100. */
    readonly opinion: number;
    /** Cumulative scenario counters from the host's aggregate stats. */
    readonly counters: Readonly<{
        /** People injured by police. */
        injuriesByPolice: number;
        /** Other civilian injuries. */
        otherInjuries: number;
        /** Police officers injured. */
        officersInjured: number;
        /** Arrested people. */
        arrests: number;
        /** Sitters arrested. */
        sitterArrests: number;
        /** People gone from the simulation. */
        peopleGone: number;
        /** Tear-gas deployments. */
        gasUsed: number;
        /** People affected by firearm actions. */
        shotsFired: number;
    }>;
}

/** Frozen finish-time input to a scenario-specific score policy. */
export interface ScenarioScoreContext {
    /** Whether the objective was won. */
    readonly win: boolean;
    /** Objective result reason. */
    readonly reason: string;
    /** Elapsed game time at finish. */
    readonly time: number;
    /** Final semantic outcome metrics. */
    readonly metrics: ScenarioMetrics;
}

/** Validated three-star result and bounded labeled rows shown on the result screen. */
export interface ScenarioScore {
    /** Integer from zero to three. */
    readonly stars: number;
    /** Up to twenty immutable label/value rows. */
    readonly lines: readonly (readonly [string, string | number])[];
}

/** Synchronous pure-by-contract mapping from frozen factual outcome to score presentation. */
export type ScenarioScoring = (context: ScenarioScoreContext) => ScenarioScore;

/** Standard semantic IDs; key bindings are host presentation, not execution IDs. */
export type PoliceCommandId = 'charge' | 'arrest' | 'snatch' | 'kettle' | 'shield-push' | 'crew' | 'water' | 'gas' | 'reinforce';

/** Opaque supported command definition returned by policeCommands. */
export interface PoliceCommandDefinition {
    /** Selects the standard police command implementation. */
    readonly kind: 'police-command';
    /** Unique command ID within this scenario. */
    readonly id: PoliceCommandId;
    /** Water/gas/reinforce cost source; null for the other standard orders. */
    readonly resource: string | null;
}

/** Read-only UI metadata; execution still validates all preconditions. */
export interface PoliceCommandInfo extends PoliceCommandDefinition {
    /** Default single-letter shortcut. */
    readonly key: string;
    /** Default host label. */
    readonly label: string;
    /** True when a captured squad or water-vehicle selection is required. */
    readonly needsSelection: boolean;
    /** Minimum escalation level recorded on application, not on a failed attempt. */
    readonly escalation: 0 | 1 | 2 | 3;
    /** Shield push uses a native hold/release aiming gesture. */
    readonly aim?: true;
    /** Water cannon selects a water-cannon vehicle, not a squad. */
    readonly forCars?: true;
    /** Crew toggle executes immediately for the selected parked patrol vehicle. */
    readonly immediate?: true;
}

/** Optional resource-backed commands appended to the basic force-order set. */
export interface PoliceCommandOptions {
    /** Enable tear gas using this declared resource ID. */
    gas?: string;
    /** Enable reinforcement dispatch using this declared resource ID. */
    reinforce?: string;
    /** Enable the directional water-cannon order using this declared resource ID. */
    water?: string;
    /** Enable the immediate `u` crew in/out order for selected police-patrol vehicles. */
    crew?: boolean;
}

/** A command captures these handles and destination before asynchronous preparation. */
export interface CommandRequest {
    /** Declared location alias or finite target coordinates. */
    at: string | Point;
    /** Squads or one selected water-cannon/patrol vehicle; gas/reinforce need no selection. */
    selection?: readonly ActorHandle[];
}

/** Successful application to host simulation, not proof of arrival, an arrest, or an injury. */
export interface CommandReceipt {
    /** Semantic command ID. */
    readonly command: PoliceCommandId;
    /** Captured resolved destination. */
    readonly at: Point;
    /** Original validated selection, unaffected by later UI selection changes. */
    readonly selection: readonly ActorHandle[];
    /** Actors whose orders were installed; gas has none, since area hits require later observation. */
    readonly affected: readonly ActorHandle[];
    /** Resource whose single reserved unit was committed, or null. */
    readonly resource: string | null;
    /** Game time at the synchronous application point. */
    readonly appliedAt: number;
    /** Selected CCTV-identified leader for snatch; not proof they were later detained. */
    readonly target?: PersonHandle;
    /** Newly allocated actor for a successful reinforcement dispatch. */
    readonly actor?: ActorHandle;
}

/** Expected command rejection does not fail the scenario or spend a reserved resource. */
export type CommandRejection = 'SELECTION_REQUIRED' | 'INVALID_SELECTION' | 'TARGET_NOT_FOUND' | 'TARGET_UNAVAILABLE' | 'WATER_BUSY' | 'NO_CREW' | 'VEHICLE_MOVING' | 'VEHICLE_TYPE' | 'BOARDING_PENDING'
    | 'CONTROL_BUSY' | 'PLAYER_CONTROL' | 'CORDON_REQUIRED' | 'SELECT_ENTIRE_CORDON' | 'INVALID_PUSH'
    | 'COOLDOWN' | 'RESOURCE_EMPTY' | 'RESOURCE_BUSY' | 'CAPACITY' | 'NO_STATION' | 'SUPERSEDED'
    | 'OWNER_STOPPED' | 'SCENARIO_STOPPED';

/** Resolution of standard command work; completion means application, not completion of the physical task. */
export type CommandOutcome =
    | { readonly status: 'completed'; readonly value: CommandReceipt }
    | { readonly status: 'rejected'; readonly code: CommandRejection }
    | { readonly status: 'cancelled'; readonly reason: string }
    | { readonly status: 'failed'; readonly error: Error };

/** Cancelable preparation followed by an irreversible synchronous application point. */
export interface CommandOperation extends Omit<Operation<CommandReceipt>, 'settled'> {
    /** Always inspect status; an expected rejection is a resolved outcome. */
    readonly settled: Promise<CommandOutcome>;
}

/** Author-facing execution; player UI and scripts use the same underlying validator. */
export interface CommandContext {
    /** Enabled standard commands and their current static metadata. */
    list(): readonly PoliceCommandInfo[];
    /** Execute for the owning behavior; other owners/player movement may prevent control acquisition. */
    execute(id: PoliceCommandId, request: CommandRequest): CommandOperation;
}

/** Configuration for the preview's timed survival objective. */
export interface SurviveOptions {
    /** Objective ID: a lowercase slug, independent of its display label. */
    id: string;
    /** Positive duration in game seconds; setup, briefing and pause do not count. */
    seconds: number;
    /** HUD label; defaults to 'Hold position'. */
    label?: string;
    /** Winning result message; defaults to 'Objective complete.'. */
    reason?: string;
}

/** Validated, immutable objective definition returned by {@link survive}. */
export interface SurviveObjective extends Readonly<SurviveOptions> {
    /** Identifies the timed survival evaluator. */
    readonly kind: 'survive';
}

/** Timed protection with immediate loss on logical capture or observed subject death. */
export interface ProtectOptions extends SurviveOptions {
    /** ID of a protected person declared during setup; objects are not accepted. */
    protected: string;
}

/** Validated protection objective; final safety requires active or carried state. */
export interface ProtectObjective extends Readonly<ProtectOptions> {
    /** Selects protected-person outcome checks rather than unconditional survival. */
    readonly kind: 'protect';
}

/** Objective kinds currently implemented by the preview. */
export type Objective = SurviveObjective | ProtectObjective | ExtractionObjective | HoldBuildingObjective;

/** Existing defense pressure/evacuation formulas, separate from waves, commands and scoring policies. */
export interface HoldBuildingOptions extends Omit<SurviveOptions, 'seconds'> {
    /** Alias declared using target(name); a missing or malformed target fails setup. */
    target: string;
    /** Game-time hold duration; defaults to twelve minutes. */
    seconds?: number;
    /** Optional zero-based hand-placed exits, snapped to a drivable street like the original template. */
    exitAt?: Readonly<Record<number, Point>>;
}

/** Validated building-defense rule; breach and evacuation failure precede timeout success. */
export interface HoldBuildingObjective extends Readonly<HoldBuildingOptions> {
    /** Selects facade/evacuation integration and default three-row objective HUD. */
    readonly kind: 'hold-building';
}

/** A confirmed vehicle extraction must reach this region before the deadline. */
export interface ExtractionOptions extends ProtectOptions {
    /** Declared exit location alias or fixed map coordinates. */
    at: string | Point;
    /** Allowed distance from the exit center in meters; default 10, maximum 100. */
    radius?: number;
}

/** Extraction wins only for exited state at this objective's exit, not merely aboard. */
export interface ExtractionObjective extends Readonly<ExtractionOptions> {
    /** Selects departure/exit checks in addition to protection terminal losses. */
    readonly kind: 'extract';
}

/** Initial population placement; exact positions follow the host's placement rules. */
export interface SpawnOptions {
    /** Unique actor ID within this run, shared across crowd and squad spawns. */
    id: string;
    /** Declared location alias or fixed local map coordinates. */
    at: string | Point;
    /** Integer from 1 to 10000; defaults to 100 for crowds and 24 for squads. */
    people?: number;
    /** Crowd spread radius in meters, default 20; squads currently use host formations instead. */
    spread?: number;
}

/** Civilian group spawn options used by wave and ambient population behaviors. */
export interface CrowdSpawnOptions extends SpawnOptions {
    /** Group display label; defaults to actor ID. */
    label?: string;
    /** People per backing simulation group; integer 1..500, default 60. */
    groupSize?: number;
    /** Initial ordered agitation range in [0,1]; default [0.05,0.25]. */
    agitation?: readonly [number, number];
    /** Initial group morale in [0,1]; default 0.5. */
    morale?: number;
    /** Share initially riding bicycles in [0,1]; default zero. */
    bikes?: number;
    /** Optional initial destination; makes default mode march instead of hold. */
    goal?: string | Point;
    /** Navigation goal radius in meters; default 25, maximum 1000. */
    goalRadius?: number;
    /** Initial semantic mode; march requires a goal. No raw simulation enums are exported. */
    mode?: 'hold' | 'march' | 'riot';
    /** Civilian faction; defaults to protester. */
    faction?: 'protester' | 'bystander' | 'counter';
}

/** Scattered passive onlookers that migrate among declared destinations. */
export interface BystanderSpawnOptions {
    /** Unique actor ID shared with other spawns. */
    id: string;
    /** Total population, divided into groups; maximum 10000. */
    people: number;
    /** Map places/landmarks or fixed coordinates used as wander destinations. */
    destinations: readonly (string | Point)[];
    /** People per wander group; defaults to 12. */
    groupSize?: number;
    /** Group placement spread in meters; defaults to 60. */
    spread?: number;
}

/** A behavior-controlled road vehicle; police patrols and water cannons are selectable police units. */
export interface VehicleSpawnOptions {
    /** Unique ID shared with the other actor kinds. */
    id: string;
    /** Spawn alias or coordinates; must snap to the drivable road network. */
    at: string | Point;
    /** Seats, including any accompanying bearer; default 1, maximum 8. */
    capacity?: number;
    /** Vehicle capability; transport is default, police-patrol creates a selectable car with crew. */
    type?: 'transport' | 'water-cannon' | 'police-patrol';
    /** Crew size for police-patrol only; defaults to eight, maximum sixteen. */
    crew?: number;
    /** Display label; defaults to ID. */
    label?: string;
}

/** Opaque actor reference. Obtain it from spawn or resolve; do not construct or persist it. */
export interface ActorHandle {
    /** Scenario-assigned actor ID. */
    readonly id: string;
    /** Determines supported operations; squads can form cordon lines. */
    readonly kind: 'crowd' | 'squad' | 'vehicle';
    /** Run identity used to reject references from another scenario instance. */
    readonly run: number;
}

/** Immutable aggregate from one simulation observation, not live mutable actor state. */
export interface ActorObservation {
    /** Actor represented by this sample. */
    readonly handle: ActorHandle;
    /** Active people for populations; 1 for an active vehicle, not its passenger count. */
    readonly alive: number;
    /** Mean position of active members, or null if no active center is available. */
    readonly center: Point | null;
}

/** Opaque identity for one person; never an exposed GPU index. Valid only in its run. */
export interface PersonHandle {
    /** Runtime-assigned person ID, stable across successive samples. */
    readonly id: string;
    /** Distinguishes a person reference from an aggregate actor reference. */
    readonly kind: 'person';
    /** Scenario run to which the person belongs. */
    readonly run: number;
}

/** Sampled person state. A missing sample is unavailable, not evidence of death or removal. */
export interface PersonObservation {
    /** Stable reference to the sampled person. */
    readonly handle: PersonHandle;
    /** Actor containing this person in the current observed membership. */
    readonly actor: ActorHandle;
    /** Semantic status decoded by the adapter; 'gone' includes off-map removal. */
    readonly status: 'active' | 'injured' | 'detained' | 'gone' | 'dead';
    /** Host-registered leadership, not acknowledgment that queued GPU role edits applied. */
    readonly leader: boolean;
    /** Sampled local map position in meters. */
    readonly position: Point;
    /** Semantic affiliation, distinct from health/activity status. */
    readonly faction: 'protester' | 'police' | 'bystander' | 'counter';
    /** Sampled agitation, clamped by the simulation to [0,1]. */
    readonly agitation: number;
    /** CCTV has identified this person's group leader; the fact persists for the group. */
    readonly identified: boolean;
}

/** Current host membership; intentionally separate from the immutable sampled PersonObservation. */
export interface PersonState {
    /** Stable person identity, unchanged by a group transfer. */
    readonly handle: PersonHandle;
    /** Actor currently owning the person in the host registry. */
    readonly actor: ActorHandle;
    /** Membership revision, incremented by each accepted transfer. */
    readonly revision: number;
    /** Pending host commit; null after a later sample confirms the new membership. */
    readonly pending: Readonly<{
        /** Game step at commit; confirmation requires a strictly later sampled step. */
        step: number;
        /** Observation sequence used to validate this transfer. */
        sample: number;
    }> | null;
    /** Explicit transport relationship; sampled off-map status alone does not imply capture. */
    readonly transport: TransportReference | null;
}

/** Preconditions and destination for a synchronous person membership transaction. */
export interface PersonTransfer {
    /** Registered destination actor, with a compatible faction and an eligible group. */
    to: ActorHandle | string;
    /** Current membership revision from people.state, not a guessed revision. */
    expectedRevision: number;
    /** Latest observation sequence used to verify the person's active status. */
    expectedSample: number;
    /** Promote the person in the target; otherwise preserve its active leader. Defaults to false. */
    promote?: boolean;
}

/** Host commit receipt; completion is not GPU acknowledgment. Rejection leaves both groups unchanged. */
export type PersonTransferResult =
    | {
        /** Both host memberships and leader designations changed in one synchronous transaction. */
        readonly status: 'completed';
        /** New accepted membership; pending remains non-null until confirmed by readback. */
        readonly value: PersonState
    }
    | {
        /** No memberships, leaders, offsets or queued edits were changed. */
        readonly status: 'rejected';
        /** Stale preconditions, eligibility, protected-target policy, or bounded edit capacity. */
        readonly code: 'STALE_REVISION' | 'STALE_OBSERVATION' | 'MEMBERSHIP_PENDING'
        | 'PERSON_UNAVAILABLE' | 'ALREADY_MEMBER' | 'PROTECTED_TARGET' | 'STALE_MEMBERSHIP'
        | 'INCOMPATIBLE_FACTION' | 'DUPLICATE_MEMBER' | 'EDIT_CAPACITY' | 'TARGET_LEADER_UNAVAILABLE'
        | 'PERSON_IN_TRANSPORT' | 'BOARDING_PENDING' | 'CONTROL_BUSY'
    };

/** Persistent protected identity, independent of its current bearer or carrier actor. */
export interface ProtectedHandle {
    /** Scenario-assigned object ID, retained through dropping and recovery. */
    readonly id: string;
    /** Person identities retain a fixed subject even when a different person carries them. */
    readonly kind: 'protected-object' | 'protected-person';
    /** Run identity; handles from a previous run are invalid. */
    readonly run: number;
}

/** Immutable relationship snapshot; live queries can be newer than the last observation. */
export interface ProtectedObservation {
    /** Identity of the same object before and after a handoff. */
    readonly handle: ProtectedHandle;
    /** Text displayed beside the object's map marker. */
    readonly label: string;
    /** Relationship revision; binding, dropping and transfer increment it, position updates do not. */
    readonly revision: number;
    /** Objects use pending/carried/dropped; people also use active/down/captured/dead. */
    readonly state: 'pending' | 'carried' | 'dropped' | 'active' | 'down' | 'captured' | 'dead' | 'boarding' | 'aboard' | 'exited';
    /** Intended initial actor while pending, current carrier actor while carried, otherwise null. */
    readonly actor: ActorHandle | null;
    /** Current bearer; null before initial binding or after dropping. */
    readonly carrier: PersonHandle | null;
    /** Latest known bearer/drop position; null until a valid position is known. */
    readonly position: Point | null;
    /** Original protected person, unchanged by recovery; null for objects or before initial binding. */
    readonly subject: PersonHandle | null;
    /** Latest capture-rule evaluation for a protected person; null for objects or before evaluation. */
    readonly capture: CaptureProgress | null;
    /** Transport relation while boarding, aboard, rolling back, or after extraction. */
    readonly transport: TransportReference | null;
}

/** Opaque handle for a crewless road vehicle. Use vehicles.drive rather than movement.move. */
export interface VehicleHandle extends ActorHandle {
    /** Vehicle capability discriminator. */
    readonly kind: 'vehicle';
}

/** A live CPU vehicle snapshot; unlike person samples, pose is not a GPU readback. */
export interface VehicleObservation {
    /** Stable vehicle handle for this run. */
    readonly handle: VehicleHandle;
    /** Declared vehicle capability. */
    readonly type: 'transport' | 'water-cannon' | 'police-patrol';
    /** Control/occupancy revision; supply it to drive and board mutations. */
    readonly revision: number;
    /** Current local map position in meters. */
    readonly position: Point;
    /** Current speed in meters per game second. */
    readonly speed: number;
    /** True while a road path remains installed, including a stopped/blocked vehicle. */
    readonly moving: boolean;
    /** Native patrol crew actor and whether its members are aboard or deployed. */
    readonly crew: VehicleCrewObservation | null;
    /** Total passenger seats configured at spawn. */
    readonly capacity: number;
    /** Reserved or occupied seats; an injured subject plus a separate bearer takes two. */
    readonly seatsUsed: number;
    /** Protected identities reserved/aboard; capacity is determined by seatsUsed, not this length. */
    readonly passengers: readonly ProtectedHandle[];
}

/** Registered squad representation of a patrol vehicle's native crew. */
export interface VehicleCrewObservation {
    /** Actor handle usable with squad commands and person queries. */
    readonly handle: ActorHandle;
    /** Crew lifecycle state; deployed crews can be selected and ordered as squads. */
    readonly state: 'aboard' | 'deployed';
    /** Native crew members. */
    readonly people: number;
    /** Members currently hidden aboard the vehicle. */
    readonly aboard: number;
}

/** Host-owned passenger state; boarding remains pending until conditional GPU edits are observed. */
export interface TransportReference {
    /** Vehicle associated with the ride, retained historically after exit. */
    readonly vehicle: VehicleHandle;
    /** Rollback restores saved boarding states before releasing the reservation. */
    readonly state: 'boarding' | 'rolling-back' | 'aboard' | 'exited';
}

/** Validated synchronous vehicle mutation result, not an arrival promise. */
export type VehicleResult =
    | { readonly status: 'completed'; readonly value: VehicleObservation }
    | { readonly status: 'rejected'; readonly code: 'STALE_REVISION' | 'CONTROL_BUSY' | 'BOARDING_PENDING' | 'NO_ROUTE'
        | 'NO_CREW' | 'VEHICLE_MOVING' | 'VEHICLE_TYPE' };

/** A boarding request uses both identity and vehicle revisions plus its source observation. */
export interface BoardingOptions extends ProtectedRevision {
    /** Vehicle revision obtained immediately before requesting boarding. */
    expectedVehicleRevision: number;
    /** Maximum pickup distance in meters; default 7, maximum 30. */
    radius?: number;
}

/** Boarding acceptance reserves seats; transport.aboard later confirms physical off-map state. */
export type BoardingResult =
    | { readonly status: 'completed'; readonly value: ProtectedObservation }
    | { readonly status: 'rejected'; readonly code: 'STALE_REVISION' | 'STALE_OBSERVATION' | 'PERSON_UNAVAILABLE'
        | 'VEHICLE_MOVING' | 'VEHICLE_FULL' | 'OUT_OF_RANGE' | 'STALE_MEMBERSHIP' | 'PERSON_PENDING' | 'EDIT_CAPACITY' };

/** Exit is a separate stopped-at-location transition after confirmed boarding. */
export interface ExitOptions {
    /** Current protected-identity revision. */
    expectedRevision: number;
    /** Required stopped destination region, independently checked by an extraction objective. */
    at: string | Point;
    /** Region radius in meters; default 10, maximum 100. */
    radius?: number;
}

/** Acknowledgment that the passenger reached an exit, or the reason it was refused. */
export type ExitResult =
    | { readonly status: 'completed'; readonly value: ProtectedObservation }
    | { readonly status: 'rejected'; readonly code: 'STALE_REVISION' | 'NOT_ABOARD' | 'EXIT_NOT_REACHED' };

/** Owned vehicle route, patrol crew control and protected-person transport. */
export interface VehicleContext {
    /** Resolve an allocated vehicle by actor ID; unknown/unallocated IDs throw. */
    resolve(id: string): VehicleHandle;
    /** Return immutable current CPU pose/control/occupancy data. */
    get(vehicle: VehicleHandle | string): VehicleObservation;
    /** Install a synchronous road route; same-owner requests supersede, another owner is refused. */
    drive(vehicle: VehicleHandle | string, at: string | Point, options: { expectedRevision: number }): VehicleResult;
    /** Stop only this owner's route, without taking another owner's control. */
    stop(vehicle: VehicleHandle | string): VehicleResult;
    /** Board or deploy a police patrol crew while parked; revisions prevent stale toggles. */
    toggleCrew(vehicle: VehicleHandle | string, options: { expectedRevision: number }): VehicleResult;
    /** Validate and reserve boarding; moving vehicles cannot board passengers. */
    board(person: ProtectedHandle, vehicle: VehicleHandle | string, options: BoardingOptions): BoardingResult;
    /** Confirm exit only after boarding and stopped arrival at the requested region. */
    exit(person: ProtectedHandle, options: ExitOptions): ExitResult;
}

/** Explicit actor-based protection rules; these do not alter faction or physical arrest state. */
export interface ProtectionOptions {
    /** Friendly actor IDs, including the initial subject actor; distinct from hostile IDs. */
    friendly: readonly string[];
    /** Actor IDs counted as hostile pressure, regardless of their simulation faction. */
    hostile: readonly string[];
    /** Counting and recovery radius in meters; defaults to 8. */
    radius?: number;
    /** Standing/carried capture duration in sampled game seconds; defaults to 4. */
    seconds?: number;
    /** Continuous downed capture duration; defaults to 8 seconds. */
    downSeconds?: number;
    /** Minimum nearby hostiles for standing pressure; defaults to 2. */
    minimum?: number;
    /** Minimum nearby hostiles for downed pressure; defaults to 4. */
    downMinimum?: number;
    /** Standing pressure requires hostile count times this factor to exceed support; default 2. */
    advantage?: number;
    /** Nearby active friends required for recovery; defaults to 4. */
    recoveryMinimum?: number;
}

/** Capture progress excludes the subject/current carrier and counts active observed people only. */
export interface CaptureProgress {
    /** Accumulated capture seconds; standing pressure decays, downed pressure resets when broken. */
    readonly held: number;
    /** Threshold for the person's current standing/carried or downed state. */
    readonly required: number;
    /** Whether hostile count/advantage currently meets the capture rule. */
    readonly pressure: boolean;
    /** False if a required actor's observation is incomplete; progress freezes in that case. */
    readonly available: boolean;
    /** Nearby eligible friendly supporters, excluding subject and current carrier. */
    readonly friendly: number;
    /** Nearby active hostile people. */
    readonly hostile: number;
}

/** A carried object by default, or an explicitly configured protected person. */
export type ProtectedCreation = {
    /** Unique lowercase-slug identity ID within this run. */
    id: string;
    /** Map marker label; defaults to ID. */
    label?: string;
    /** Initial actor whose observed active leader becomes the bearer/subject. */
    carrier: ActorHandle | string;
} & ({
    /** Omission preserves the original carried-object semantics. */
    kind?: 'object';
    /** Capture rules belong only to protected people. */
    protection?: never;
} | {
    /** Create a stable person subject with injury, recovery and capture state. */
    kind: 'person';
    /** Required, validated and detached actor-based rules. */
    protection: ProtectionOptions;
});

/** Preconditions for a synchronous relationship mutation; both must still match. */
export interface ProtectedRevision {
    /** Revision obtained from the latest protected-object query. */
    expectedRevision: number;
    /** Sequence of the current observation used to choose the action. */
    expectedSample: number;
}

/** A handoff moves the object between bearers, not people between simulation groups. */
export interface ProtectedTransfer extends ProtectedRevision {
    /** Nearby active person to become the new bearer. */
    carrier: PersonHandle;
    /** Also promote the bearer in their own group; defaults to false. */
    promote?: boolean;
    /** Maximum distance from the object's known position; default 12 meters, maximum 100. */
    radius?: number;
}

/**
 * Immediate relationship receipt, not an asynchronous operation or GPU acknowledgment.
 * STALE_REVISION means the relationship changed; STALE_OBSERVATION means a newer
 * sample arrived. CARRIER_UNAVAILABLE, CARRIER_BUSY and OUT_OF_RANGE describe an
 * ineligible bearer. ALREADY_CARRIER and NOT_CARRIED reject redundant changes.
 */
export type RelationshipResult =
    | {
        /** Relationship changes are committed in the host registry. */
        readonly status: 'completed';
        /** New immutable relationship state. */
        readonly value: ProtectedObservation
    }
    | {
        /** Preconditions failed; this request made no relationship/promotion changes. */
        readonly status: 'rejected';
        /** Stable reason suitable for retry or eligibility decisions. */
        readonly code: 'STALE_REVISION' | 'STALE_OBSERVATION' | 'CARRIER_UNAVAILABLE' | 'CARRIER_BUSY' | 'ALREADY_CARRIER' | 'OUT_OF_RANGE' | 'NOT_CARRIED' | 'MEMBERSHIP_PENDING'
            | 'TERMINAL_STATE' | 'NOT_DOWN' | 'RECOVERY_BLOCKED' | 'OBSERVATION_UNAVAILABLE' | 'TRANSPORT_STATE' | 'CONTROL_BUSY'
    };

/** Owner-scoped creation and revision-checked mutations for carried objects. */
export interface ProtectedContext {
    /** Create a pending object that binds to its initial actor's active leader when observed. */
    create(options: ProtectedCreation): ProtectedHandle;
    /** Find a registered object handle by ID; throws for an unknown ID. */
    resolve(id: string): ProtectedHandle;
    /** Read current host relationship state; throws for removed or foreign handles. */
    get(handle: ProtectedHandle): ProtectedObservation;
    /** Release the bearer and retain the object's last position, if both revisions match. */
    drop(handle: ProtectedHandle, options: ProtectedRevision): RelationshipResult;
    /** Assign an eligible bearer, optionally promoting them without altering group membership. */
    transfer(handle: ProtectedHandle, options: ProtectedTransfer): RelationshipResult;
}

/** Accepted readback snapshot. Its arrays and entries remain unchanged after later mutations. */
export interface Observation {
    /** Monotonically increasing accepted-sample sequence within this run. */
    readonly sequence: number;
    /** Completed game-step counter captured when this readback was requested. */
    readonly step: number;
    /** Game time in seconds captured at readback request, not at delivery. */
    readonly sampledAt: number;
    /** Difference between accepted sample times; zero initially and possibly while paused. */
    readonly elapsed: number;
    /** Runtime game time at publication; may be later than sampledAt. */
    readonly receivedAt: number;
    /** Aggregate actors for which valid sample data is available. */
    readonly actors: readonly ActorObservation[];
    /** People present in this sample, including inactive statuses. */
    readonly people: readonly PersonObservation[];
    /** Relationship state captured at publication, not a live relationship view. */
    readonly protected: readonly ProtectedObservation[];
    /** Vehicle state captured at publication from the CPU vehicle simulation. */
    readonly vehicles: readonly VehicleObservation[];
}

/** Resolved operation outcome; expected rejection and cancellation do not reject the promise. */
export type OperationOutcome<Result> =
    | {
        /** The operation-specific commit/completion point was reached. */
        readonly status: 'completed';
        /** Result defined by the requested action, such as an actor handle or installed route. */
        readonly value: Result
    }
    | {
        /** Movement could not acquire control; no order was installed. */
        readonly status: 'rejected';
        /** Player control takes priority; otherwise another behavior owns the actor. */
        readonly code: 'PLAYER_CONTROL' | 'CONTROL_BUSY'
    }
    | {
        /** Execution or infrastructure failed; gameplay behavior failures also fail the run. */
        readonly status: 'failed';
        /** Underlying diagnostic, including action attribution where available. */
        readonly error: Error
    }
    | {
        /** Pending work was canceled or superseded before successful settlement. */
        readonly status: 'cancelled';
        /** Caller-, owner-, or runtime-provided cancellation reason. */
        readonly reason: string
    };

/** Tracked asynchronous work; cancellation does not undo already applied simulation changes. */
export interface Operation<Result> {
    /** Run-scoped operation identifier for diagnostics. */
    readonly id: string;
    /** Current lifecycle state; 'applied' can precede final asynchronous settlement. */
    readonly state: 'preparing' | 'applied' | 'completed' | 'rejected' | 'failed' | 'cancelled';
    /** Aborted when this work is canceled; distinct from the behavior's lifetime signal. */
    readonly signal: AbortSignal;
    /** Always inspect the discriminated outcome rather than treating resolution as success. */
    readonly settled: Promise<OperationOutcome<Result>>;
    /**
     * Request cancellation. 'requested' is acknowledgment, 'already-settled' is a no-op,
     * and 'too-late' means application cannot be prevented. Use movement.stop for installed motion.
     */
    cancel(reason?: string): Readonly<{ status: 'requested' | 'already-settled' | 'too-late' }>;
}

/** Public setup/query capabilities; no Game, World, DOM, GPU buffers or raw simulation indices. */
export interface ScenarioContext {
    /** Live immutable semantic opinion/counter snapshot for decisions and scoring policies. */
    readonly metrics: ScenarioMetrics;
    /** Immutable inventory queries; only command execution reserves/spends in this slice. */
    readonly resources: { get(id: string): ResourceObservation; list(): readonly ResourceObservation[] };
    /** Enabled command catalog and owner-scoped execution. */
    readonly commands: CommandContext;
    /** Target aliases expose immutable footprint/exit geometry without raw map buffers. */
    readonly targets: { get(alias: string): TargetInfo };
    /** Sampled spatial measurements and connected-road placement. */
    readonly spatial: SpatialContext;
    /** Sampled person queries, current host membership, and owner-scoped membership transactions. */
    readonly people: {
        /** Sampled members, including inactive people; unknown actor references throw. */
        members(actor: ActorHandle | string): readonly PersonObservation[];
        /** Latest person sample, or null if unavailable; invalid/foreign handles throw. */
        get(handle: PersonHandle): PersonObservation | null;
        /** Current accepted membership, including its revision and pending readback state. */
        state(handle: PersonHandle): PersonState;
        /** Atomically move one active person between compatible actors without changing their handle. */
        transfer(handle: PersonHandle, options: PersonTransfer): PersonTransferResult
    };
    /** Carried-object identity and mutations; ownership follows the context that creates it. */
    readonly protected: ProtectedContext;
    /** Owned road driving, pickup, boarding and extraction. */
    readonly vehicles: VehicleContext;
    /** Setup spawns are scenario-owned; behavior-context spawns are released when that owner stops. */
    readonly spawn: {
        /** Spawn a crowd, possibly backed by multiple groups, and settle with its actor handle. */
        crowd(options: CrowdSpawnOptions): Operation<ActorHandle>;
        /** Spawn a distributed passive population that wanders among declared map destinations. */
        bystanders(options: BystanderSpawnOptions): Operation<ActorHandle>;
        /** Spawn a police squad in the host's compact formation. */
        squad(options: SpawnOptions): Operation<ActorHandle>;
        /** Spawn a crewless road car with owned visuals/collision and explicit seat capacity. */
        vehicle(options: VehicleSpawnOptions): Operation<VehicleHandle>;
    };
    /** Resolve declared aliases or validate/copy explicit map coordinates. */
    readonly locations: {
        /** Return immutable coordinates; unknown aliases or non-finite coordinates throw. */
        get(id: string | Point): Point
    };
    /** Actor handles and their latest sampled aggregates. */
    readonly actors: {
        /** Return null before valid sample data exists; invalid/foreign handles throw. */
        get(handle: ActorHandle): ActorObservation | null;
        /** Resolve an allocated actor ID, including a spawn still awaiting completion. */
        resolve(id: string): ActorHandle
    };
    /** Presentation capabilities currently limited to initial camera framing. */
    readonly presentation: {
        /** Owner-scoped text notification and optional map ping; not a gameplay event. */
        notice(text: string, kind?: 'info' | 'good' | 'warn' | 'bad', at?: string | Point | null): void;
        /** Set initial center and meters per screen pixel (default 0.5); smaller values zoom in. */
        focus(at: string | Point, zoom?: number): void
    };
    /** Elapsed game seconds; does not advance during setup, briefing, startup or pause. */
    readonly time: number;
    /** Latest accepted sample, or null during setup before bootstrap readback. */
    readonly observation: Observation | null;
}

/** Settings for a route installation; arrival is measured separately from installation. */
export interface MovementOptions {
    /** Center-to-destination arrival tolerance, default 8 meters, maximum 100. */
    radius?: number;
    /** Optional cordon start point for squads; the move destination supplies the other endpoint. */
    line?: Point;
}

/** Successful movement installation, not proof that the actor has reached the destination. */
export interface MovementResult {
    /** Actor receiving the order. */
    readonly actor: ActorHandle;
    /** Resolved destination, or the midpoint of a requested cordon line. */
    readonly destination: Point;
    /** Monotonic order generation used to reject superseded asynchronous work. */
    readonly generation: number;
    /** Game time at successful installation; movement may continue afterward. */
    readonly installedAt: number;
}

/** Common movement-event fields. Events are immutable and dispatched through an ordered queue. */
interface ActorEvent {
    /** Monotonic event sequence within the scenario run. */
    readonly sequence: number;
    /** Game time when the event was emitted. */
    readonly time: number;
    /** Actor whose movement changed. */
    readonly actor: ActorHandle;
    /** Resolved movement destination; line orders use their midpoint. */
    readonly at: Point;
}

/** Player overrides, installed orders and subsequent sample-based arrival are distinct events. */
export type MovementEvent =
    | (ActorEvent & {
        /** Player intent acquired control, before navigation necessarily finished preparing. */
        readonly type: 'player.move';
        /** Requested cordon start point, or null for point movement. */
        readonly line: Point | null
    })
    | (ActorEvent & {
        /** Applied means route installed; arrived requires a later eligible observation. */
        readonly type: 'movement.applied' | 'movement.arrived';
        /** Whether a player order or autonomous behavior owns this movement. */
        readonly source: 'player' | 'behavior';
        /** Behavior instance ID, or 'player' for player-owned orders. */
        readonly owner: string
    });

/** Common metadata for protected-object relationship events. */
interface IdentityEvent {
    /** Run-scoped event sequence, shared with movement events. */
    readonly sequence: number;
    /** Game time when the relationship event was emitted. */
    readonly time: number;
    /** Persistent object whose relationship changed. */
    readonly entity: ProtectedHandle;
}

/** Object identity survives carrier changes; removal instead invalidates its handle. */
export type ProtectedEvent =
    | (IdentityEvent & {
        /** Initial binding or a successful handoff selected a bearer. */
        readonly type: 'protected.carrier-changed';
        /** New person carrying the object. */
        readonly carrier: PersonHandle;
        /** Actor containing the new bearer. */
        readonly actor: ActorHandle;
        /** Relationship revision after the change. */
        readonly revision: number
    })
    | (IdentityEvent & {
        /** Voluntary release, observed carrier loss, or actor cleanup detached the bearer. */
        readonly type: 'protected.dropped';
        /** Last known object position; may be null if never sampled. */
        readonly position: Point | null;
        /** Revision after detachment, usable in a subsequent recovery request. */
        readonly revision: number;
        /** Cause such as 'released', 'injured', 'detained' or 'actor removed'. */
        readonly reason: string
    })
    | (IdentityEvent & {
        /** Owner cleanup removed the object, unlike a recoverable drop. */
        readonly type: 'protected.removed';
        /** Removal cause; currently 'owner stopped'. */
        readonly reason: string
    })
    | (IdentityEvent & {
        /** Protected-person injury, logical capture or observed death changed its lifecycle. */
        readonly type: 'protected.state-changed';
        /** Original protected subject, if initial binding completed. */
        readonly subject: PersonHandle | null;
        /** Lifecycle state before the transition. */
        readonly previous: ProtectedObservation['state'];
        /** Capture and death are terminal and cannot be recovered by transfer. */
        readonly state: 'down' | 'captured' | 'dead';
        /** Last known subject/bearer position. */
        readonly position: Point | null;
        /** Relationship revision after the transition. */
        readonly revision: number;
        /** Cause such as carrier injured, detained, subject dead or hostile pressure. */
        readonly reason: string
    });

/** Built-in event vocabulary for this preview; arbitrary custom event registration is not exposed. */
export type ScenarioEvent = MovementEvent | ProtectedEvent | PersonEvent | VehicleEvent | TransportEvent | CommandEvent;

/** Lifecycle facts distinguish intention, acceptance, application, cancellation and infrastructure failure. */
export interface CommandEvent {
    /** Applied/completed are emitted only after effects/order installation and resource commit. */
    readonly type: 'command.attempted' | 'command.accepted' | 'command.applied' | 'command.completed'
        | 'command.rejected' | 'command.cancelled' | 'command.failed';
    /** Run-scoped event sequence. */
    readonly sequence: number;
    /** Game time of dispatch. */
    readonly time: number;
    /** Semantic command ID, not a raw key code. */
    readonly command: PoliceCommandId;
    /** Operation ID linking all lifecycle events. */
    readonly operation: string;
    /** Captured target coordinates. */
    readonly at: Point;
    /** Captured squad handles; never mutable raw host groups. */
    readonly selection: readonly ActorHandle[];
    /** Selected leader person handle for snatch. */
    readonly target?: PersonHandle;
    /** Player UI or behavior/script origin. */
    readonly source: 'player' | 'behavior';
    /** Present after successful synchronous application. */
    readonly receipt?: CommandReceipt;
    /** Expected rejection code, when rejected. */
    readonly code?: CommandRejection;
    /** Cancellation or failure explanation, where applicable. */
    readonly reason?: string;
}

/** Route installation versus stopped arrival are distinct vehicle facts. */
export interface VehicleEvent {
    /** Driving is synchronous acceptance; arrived/stopped is discovered by later collection. */
    readonly type: 'vehicle.driving' | 'vehicle.arrived' | 'vehicle.stopped' | 'vehicle.crew-changed';
    /** Run-scoped event sequence. */
    readonly sequence: number;
    /** Game time of publication. */
    readonly time: number;
    /** Vehicle whose route changed. */
    readonly vehicle: VehicleHandle;
    /** Destination for driving, measured stopped position for arrival/stopped events. */
    readonly at: Point;
    /** Current vehicle revision. */
    readonly revision: number;
    /** Crew handle/state on crew-changed events. */
    readonly crew?: ActorHandle;
    /** Whether crew are aboard or deployed. */
    readonly state?: 'aboard' | 'deployed';
}

/** Boarding reservation, observed confirmation, exit, or completed boarding rollback. */
export interface TransportEvent {
    /** Rejected is emitted only after rollback has restored partial off-map changes. */
    readonly type: 'transport.boarding' | 'transport.aboard' | 'transport.exited' | 'transport.rejected';
    /** Run-scoped event sequence. */
    readonly sequence: number;
    /** Game time of publication. */
    readonly time: number;
    /** Protected identity, not an exposed simulation person index. */
    readonly entity: ProtectedHandle;
    /** Related vehicle, possibly removed when an administrative rollback occurred. */
    readonly vehicle: VehicleHandle;
    /** Present for successful lifecycle transitions. */
    readonly revision?: number;
    /** Confirmed exit position, when exiting. */
    readonly at?: Point;
    /** Reconciliation or removal failure reason, when rejected. */
    readonly reason?: string;
}

/** Membership commit and later sample confirmation are distinct facts. */
export type PersonEvent = {
    /** Host commit or subsequent readback confirmation of that membership. */
    readonly type: 'person.transferred' | 'person.membership-confirmed';
    /** Monotonic run-scoped event sequence. */
    readonly sequence: number;
    /** Game time at dispatch. */
    readonly time: number;
    /** Stable person whose membership changed. */
    readonly person: PersonHandle;
    /** Destination actor owning the person. */
    readonly actor: ActorHandle;
    /** New membership revision. */
    readonly revision: number;
    /** Source actor on transfer events; absent on confirmation events. */
    readonly previous?: ActorHandle;
};

/** Owned one-shot game-time timer; never uses wall-clock time for gameplay. */
export interface Timer {
    /** Pending, already fired, or canceled before firing. */
    readonly state: 'pending' | 'completed' | 'cancelled';
    /** Cancel a pending callback; no effect after completion or previous cancellation. */
    cancel(): void;
}

/** Per-instance behavior capabilities, guarded by the owner's active/starting lifetime. */
export interface BehaviorContext extends ScenarioContext {
    /** Unique attachment instance ID, distinct from the reusable behavior type ID. */
    readonly id: string;
    /** Aborted before stop hooks run; use it to observe owner termination. */
    readonly signal: AbortSignal;
    /** Owned orders respect player priority and other behaviors' existing control. */
    readonly movement: {
        /** Install movement; repeated same-owner requests supersede older ones. */
        move(actor: ActorHandle | string, at: Point | string, options?: MovementOptions): Operation<MovementResult>;
        /** Stop only this owner's order; never cancel another behavior's or the player's control. */
        stop(actor: ActorHandle | string): Readonly<{ status: 'completed' } | { status: 'rejected'; code: 'CONTROL_BUSY' }>;
    };
    /** Timers stop with their owner and do not fire while game time is paused. */
    readonly timeline: {
        /** Schedule a synchronous callback after non-negative game seconds; zero means a later update. */
        after(seconds: number, callback: (ctx: BehaviorContext) => void): Timer
    };
    /** Finish this behavior, cancel its work and release owned entities; does not win/end the scenario. */
    complete(): void;
}

/** Behavior completion, scenario completion, runtime failure, or scenario disposal. */
export type StopReason = 'completed' | 'finished' | 'failed' | 'disposed';

/** Read-only stop-hook context; gameplay mutations cannot be started from cleanup. */
export interface CleanupContext {
    /** Game time when cleanup begins. */
    readonly time: number;
    /** Last accepted observation, if bootstrap reached that stage. */
    readonly observation: Observation | null;
    /** Already aborted, indicating the owner has stopped. */
    readonly signal: AbortSignal;
}

/** Optional hooks returned synchronously by a behavior's create function. */
export interface BehaviorHooks {
    /** Initialize once before game time starts; must not await arrival, future samples or game-time timers. */
    start?(ctx: BehaviorContext): void | Promise<void>;
    /** Synchronous per-game-step logic; dt is game seconds and updates do not run while paused. */
    update?(ctx: BehaviorContext, dt: number): void;
    /** Synchronous fresh-sample logic; use sample.elapsed, not frame dt, for sampled-time integration. */
    observe?(ctx: BehaviorContext, sample: Observation): void;
    /** Synchronous ordered event handling; may initiate owned work, not return a promise. */
    onEvent?(ctx: BehaviorContext, event: ScenarioEvent): void;
    /** Called once on termination; asynchronous cleanup is bounded and cannot delay results indefinitely. */
    stop?(ctx: CleanupContext, reason: StopReason): void | Promise<void>;
}

/** Deep-readonly options view; runtime options must be finite, plain configuration data, not callbacks or handles. */
export type Configuration<Value> = Value extends readonly unknown[]
    ? { readonly [Index in keyof Value]: Configuration<Value[Index]> }
    : Value extends object ? { readonly [Key in keyof Value]: Configuration<Value[Key]> } : Value;

/** Reusable behavior type; its factory creates isolated hooks/state for each attachment and run. */
export interface BehaviorDefinition<Options extends { id: string }> {
    /** Lowercase-slug behavior type ID, not an attachment instance ID. */
    id: string;
    /** Optional synchronous options validation; throw a useful field-specific error on invalid input. */
    validate?(options: Configuration<Options>): void;
    /** Synchronously create fresh hooks; keep mutable private state inside this function's closure. */
    create(options: Configuration<Options>): BehaviorHooks;
}

/** Opaque validated attachment; pass it in ScenarioOptions.behaviors rather than constructing it. */
export interface BehaviorAttachment {
    /** Identifies a behavior attachment definition. */
    readonly kind: 'behavior';
    /** Instance ID, unique among attachments in one scenario. */
    readonly id: string;
    /** Reusable behavior type that will construct this attachment's hooks. */
    readonly type: string;
}

/** Route following selects exactly one fixed actor or changing protected-object carrier. */
export type RouteOptions = {
    /** Unique behavior attachment ID. */
    id: string;
    /** Non-empty ordered route: fixed map points or declared location aliases. */
    waypoints: readonly (Point | string)[];
    /** Center/proximity arrival tolerance; defaults to 8 meters. */
    radius?: number;
    /** Alias whose coordinates offset numeric waypoints; string aliases remain absolute. */
    relativeTo?: string
}
    & ({
        /** Actor ID to follow the route; player detours resume at a remaining forward waypoint. */
        actor: string;
        /** Cannot combine a fixed actor with a protected-object target. */
        protected?: never
    } | {
        /** Protected-object ID; dropping suspends motion and a new bearer continues the remaining route. */
        protected: string;
        /** Cannot combine a protected-object target with a fixed actor. */
        actor?: never
    });

/** Author input for the implemented preview; unsupported fields fail validation. */
export interface ScenarioOptions {
    /** Finite named resources; default empty. */
    resources?: Record<string, ResourceOptions>;
    /** Opt-in standard police orders; gas/reinforce definitions must reference declared resources. */
    commands?: readonly PoliceCommandDefinition[];
    /** Optional synchronous outcome score policy; return a validated 0..3 stars and result rows. */
    score?: ScenarioScoring;
    /** Show this scenario in the mission picker; default true. Direct ?m= URLs still work when false. */
    menu?: boolean;
    /** Globally unique lowercase slug used by the m query parameter and saved results. */
    id: string;
    /** Scenario name shown in the menu, briefing and HUD. */
    title: string;
    /** Short non-empty description shown with the title. */
    subtitle: string;
    /** Briefing text; the host escapes text and preserves only supported limited markup. */
    brief: string;
    /** Controlled side; only police scenarios are implemented in this preview. */
    side?: 'police';
    /** Optional folder under public/data; null or omission selects the default map. */
    city?: string | null;
    /** Briefing goal strings; display copy, separate from executable objective rules. */
    goals?: string[];
    /** Optional briefing tips; each entry must be non-empty text. */
    tips?: string[];
    /** Named aliases resolved before setup; a missing map place fails before spawning. */
    locations?: Record<string, LocationReference>;
    /** Initialize scenario-owned actors/objects; owned spawns are tracked even if not awaited explicitly. */
    setup?(ctx: ScenarioContext): unknown | Promise<unknown>;
    /** Validated attachments; each gets fresh hooks and private state when the run is set up. */
    behaviors?: readonly BehaviorAttachment[];
    /** Exactly one survival, protection, extraction, or building-defense objective is currently supported. */
    objectives: readonly [Objective];
}

/** Normalized immutable definition returned by defineScenario, not a running scenario instance. */
export interface ScenarioDefinition {
    /** Detached normalized resource capacities, initial amounts and cooldowns. */
    readonly resources: Readonly<Record<string, ResourceDefinition>>;
    /** Frozen validated command definitions; default empty. */
    readonly commands: readonly PoliceCommandDefinition[];
    /** Score policy, or null for the default three-star win/zero-star loss. */
    readonly score: ScenarioScoring | null;
    /** Whether this scenario appears in the player-facing picker. */
    readonly menu: boolean;
    /** Distinguishes a scenario definition from a mission class or behavior attachment. */
    readonly kind: 'scenario';
    /** Protocol version validated by the host. */
    readonly sdkVersion: 1;
    /** Validated scenario ID; see ScenarioOptions.id. */
    readonly id: string;
    /** Validated display title. */
    readonly title: string;
    /** Validated short description. */
    readonly subtitle: string;
    /** Briefing text, rendered by the host's limited rich-text policy. */
    readonly brief: string;
    /** Normalized supported side, defaulting to police. */
    readonly side: 'police';
    /** Selected map folder, normalized to null for the default map. */
    readonly city: string | null;
    /** Detached, frozen briefing goals; defaults to an empty array. */
    readonly goals: readonly string[];
    /** Detached, frozen briefing tips; defaults to an empty array. */
    readonly tips: readonly string[];
    /** Frozen location definitions; values are resolved for each run, not shared mutable positions. */
    readonly locations: Readonly<Record<string, LocationReference>>;
    /** Original setup callback, executed independently for each run. */
    readonly setup: ScenarioOptions['setup'];
    /** Frozen attachments; defaults to an empty array. */
    readonly behaviors: readonly BehaviorAttachment[];
    /** Frozen normalized supported objective. */
    readonly objectives: readonly [Objective];
}

/** Declare an exact named place without importing map or simulation internals. */
export function place(name: string): PlaceReference;
/** Declare an exact named landmark, independent of place-name lookups. */
export function landmark(name: string): LandmarkReference;
/** Declare a defended target; resolves center, radius, outer footprints and exits before setup. */
export function target(name: string): TargetReference;
/** Hold a building using the existing breach/exit formulas, loss-first precedence and default HUD. */
export function holdBuilding(options: HoldBuildingOptions): HoldBuildingObjective;
/** Create a validated timed objective whose progress drives the default HUD and winning result. */
export function survive(options: SurviveOptions): SurviveObjective;
/** Fail on capture/death or lack of safety at the deadline; win after the duration while active/carried. */
export function protect(options: ProtectOptions): ProtectObjective;
/** Win on confirmed stopped exit in this region before the deadline, not merely on boarding. */
export function extract(options: ExtractionOptions): ExtractionObjective;
/** Validate and detach a scenario definition; does not allocate simulation state or start play. */
export function defineScenario(options: ScenarioOptions): ScenarioDefinition;
/** Create a reusable attachment factory; each options object includes its unique instance ID. */
export function defineBehavior<Options extends { id: string }>(definition: BehaviorDefinition<Options>): (options: Options) => BehaviorAttachment;
/** Follow a route with owned movement, player detour/resume, and optional protected-object continuity. */
export function followRoute(options: RouteOptions): BehaviorAttachment;
/** Enable charge/arrest/kettle/shield push, optionally gas/reinforce with explicit resource bindings. */
/** Enable charge/arrest/snatch/kettle/shield push, optionally gas/reinforce with explicit resource bindings. */
export function policeCommands(options?: PoliceCommandOptions): readonly PoliceCommandDefinition[];