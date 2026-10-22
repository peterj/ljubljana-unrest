import { DefendMission } from '../sdk/index.ts';

export class DefendAssembly extends DefendMission {

	static id = 'defend-assembly';
	static title = 'National Assembly';
	static short = 'the Assembly';
	static subtitle = 'Hold the National Assembly for 12 minutes';
	static target = 'Državni zbor';
	static exitAt = { 1: [ - 404, - 55 ] };	// Šubičeva, in front of the south façade (user's placement)
	static brief = `A controversial law passes its final reading tonight. Unions, students and the Metelkova scene have called
		everyone to <b>Trg republike</b>. Keep the crowd off the doors of the National Assembly and keep at least one evacuation exit open.`;
	static goals = [ 'Survive 12:00', 'Do not let the façade breach meter fill', 'Keep at least one exit open' ];
	static tips = [ 'Waves are announced 30 s ahead — meet them before they reach the square', 'Cordon lines (right-drag) hold better than loose blocks',
		'Cyclists arrive fast and get off their bikes once they hit a line', 'Patrol cars parked across a street make a quick roadblock',
		'Gas clears a crowd fast but costs public opinion', 'Agitated groups become rioters — calm areas stay calm' ];
	static waves = [
		{ t: 8, n: 2200, from: 'Kongresni trg', label: 'Students' },
		{ t: 120, n: 1800, from: 'Prešernov trg', label: 'Metelkova bloc' },
		{ t: 190, n: 450, from: 'Prešernov trg', label: 'Friday cyclists', bikes: 1 },
		{ t: 250, n: 1100, from: 'PU Ljubljana', label: 'Radicals', agitation: [ 0.5, 0.8 ], morale: 0.8 },
		{ t: 400, n: 2600, from: 'Kongresni trg', label: 'Trade unions' },
		{ t: 560, n: 1500, from: 'Ministrstvo za finance', label: 'Late arrivals' },
	];

}

export class DefendVlada extends DefendMission {

	static id = 'defend-vlada';
	static title = 'Government Palace';
	static short = 'the Government building';
	static subtitle = 'Hold the Government building on Gregorčičeva';
	static target = 'Vlada RS';
	static brief = `The cabinet is in an emergency session at <b>Gregorčičeva</b>. An angry crowd gathers on <b>Erjavčeva</b> and
		marches on the Government building in two columns: west by <b>Prešernova</b>, east by <b>Igriška</b>, both onto Gregorčičeva.
		They are spoiling for a fight: every baton, canister and arrest makes the crowd around it angrier. The ministers must be able to leave.
		A <b>water cannon</b> is parked in front of exit 1.`;
	static goals = [ 'Survive 12:00', 'Do not let the façade breach meter fill', 'Keep at least one exit open' ];
	static tips = [ 'Both columns are announced 30 s ahead — meet them on Prešernova and Igriška before they reach Gregorčičeva',
		'Water cannon: click the truck, right-click to drive it by road; W shows its reach — hold the left button to aim, release to spray',
		'Force (charges, kettles, gas, water, arrests, injuries) makes the crowd around it angrier — use it sparingly and far from the main body',
		'Cordon lines (right-drag) hold better than loose blocks', 'Cyclists arrive fast and get off their bikes once they hit a line' ];
	static outrage = true;
	static routes = [
		{ name: 'Prešernova', legs: [ [ - 668, - 216 ], [ - 700, - 300 ] ], rally: [ - 682, - 308 ] },
		{ name: 'Igriška', legs: [ [ - 410, - 279 ], [ - 500, - 361 ] ], rally: [ - 548, - 350 ] },
	];
	static waves = [
		{ t: 8, n: 2000, at: [ - 545, - 243 ], from: 'Erjavčeva', label: 'Students', agitation: [ 0.35, 0.6 ] },
		{ t: 130, n: 2000, at: [ - 545, - 243 ], from: 'Erjavčeva', label: 'Farmers', agitation: [ 0.35, 0.6 ] },
		{ t: 200, n: 450, at: [ - 545, - 243 ], from: 'Erjavčeva', label: 'Friday cyclists', bikes: 1, agitation: [ 0.35, 0.6 ] },
		{ t: 270, n: 1000, at: [ - 545, - 243 ], from: 'Erjavčeva', label: 'Radicals', agitation: [ 0.55, 0.85 ], morale: 0.8 },
		{ t: 420, n: 2400, at: [ - 545, - 243 ], from: 'Erjavčeva', label: 'Everyone else', agitation: [ 0.35, 0.6 ] },
	];

	async setup() {

		await super.setup();
		this.resources.water = { left: 6, max: 6 };

	}

}
