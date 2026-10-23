// The missions, in menu order. Each one: a briefing, a timeline (waves announced ahead of time so the player can
// prepare), live objectives with clear fail states, and a 1–3 star result.
import { ConvoyMission } from './convoy.ts';
import { DefendAssembly, DefendVlada } from './defend.ts';
import { RallyMission } from './rally.ts';
import { ClashMission } from './clash.ts';
import { SitInMission } from './sitin.ts';
import { MassacreMission } from './massacre.ts';
import { ResnicaRun } from './resnica.ts';
import { BlackBloc } from './blackbloc.ts';
import { CourtMission } from './court.ts';
import { PrideMission } from './pride.ts';
import { RescueMission } from './rescue.ts';
import { TutorialMission } from './tutorial.ts';

export const BUILTIN = [ TutorialMission, ConvoyMission, DefendAssembly, DefendVlada, RallyMission, ClashMission, SitInMission, MassacreMission, ResnicaRun, BlackBloc, CourtMission, PrideMission, RescueMission ];
