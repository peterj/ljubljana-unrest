export const SDK_VERSION: 1;

export type Point = readonly [number, number];
export interface PlaceReference { readonly kind: 'place'; readonly name: string; }
export interface SurviveOptions { id: string; seconds: number; label?: string; reason?: string; }
export interface SurviveObjective extends Readonly<SurviveOptions> { readonly kind: 'survive'; }
export interface SpawnOptions { id: string; at: string | Point; people?: number; spread?: number; }
export interface ActorHandle { readonly id: string; readonly kind: 'crowd' | 'squad'; readonly run: number; }
export interface ActorObservation { readonly handle: ActorHandle; readonly alive: number; readonly center: Point | null; }
export interface Observation {
    readonly sequence: number;
    readonly receivedAt: number;
    readonly actors: readonly ActorObservation[];
}

export type OperationOutcome<Result> =
    | { readonly status: 'completed'; readonly value: Result }
    | { readonly status: 'failed'; readonly error: Error }
    | { readonly status: 'cancelled'; readonly reason: string };

export interface Operation<Result> {
    readonly id: string;
    readonly state: 'preparing' | 'completed' | 'failed' | 'cancelled';
    readonly signal: AbortSignal;
    readonly settled: Promise<OperationOutcome<Result>>;
    cancel(reason?: string): Readonly<{ status: 'requested' | 'already-settled' }>;
}

export interface ScenarioContext {
    readonly spawn: {
        crowd(options: SpawnOptions): Operation<ActorHandle>;
        squad(options: SpawnOptions): Operation<ActorHandle>;
    };
    readonly locations: { get(id: string | Point): Point };
    readonly actors: { get(handle: ActorHandle): ActorObservation | null };
    readonly presentation: { focus(at: string | Point, zoom?: number): void };
    readonly time: number;
    readonly observation: Observation | null;
}

export interface ScenarioOptions {
    id: string;
    title: string;
    subtitle: string;
    brief: string;
    side?: 'police';
    city?: string | null;
    goals?: string[];
    tips?: string[];
    locations?: Record<string, PlaceReference | Point>;
    setup?(ctx: ScenarioContext): unknown | Promise<unknown>;
    objectives: readonly [SurviveObjective];
}

export interface ScenarioDefinition {
    readonly kind: 'scenario';
    readonly sdkVersion: 1;
    readonly id: string;
    readonly title: string;
    readonly subtitle: string;
    readonly brief: string;
    readonly side: 'police';
    readonly city: string | null;
    readonly goals: readonly string[];
    readonly tips: readonly string[];
    readonly locations: Readonly<Record<string, PlaceReference | Point>>;
    readonly setup: ScenarioOptions['setup'];
    readonly objectives: readonly [SurviveObjective];
}

export function place(name: string): PlaceReference;
export function survive(options: SurviveOptions): SurviveObjective;
export function defineScenario(options: ScenarioOptions): ScenarioDefinition;