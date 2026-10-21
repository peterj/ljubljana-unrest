// The missions, in menu order. Each one: a briefing, a timeline (waves announced ahead of time so the player can
// prepare), live objectives with clear fail states, and a 1–3 star result.
import { ConvoyMission } from './convoy.js';
import { DefendAssembly, DefendVlada } from './defend.js';
import { RallyMission } from './rally.js';
import { ClashMission } from './clash.js';
import { SitInMission } from './sitin.js';
import { MassacreMission } from './massacre.js';
import { ResnicaRun } from './resnica.js';
import { BlackBloc } from './blackbloc.js';
import { CourtMission } from './court.js';
import { PrideMission } from './pride.js';
import { RescueMission } from './rescue.js';
import { TutorialMission } from './tutorial.js';

export const BUILTIN = [ TutorialMission, ConvoyMission, DefendAssembly, DefendVlada, RallyMission, ClashMission, SitInMission, MassacreMission, ResnicaRun, BlackBloc, CourtMission, PrideMission, RescueMission ];
