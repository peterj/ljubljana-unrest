// Browser globals the game reads or sets that lib.dom does not declare.
interface Window {
	game: any; // the running Game, exposed for debugging and playtest harnesses
}

interface Navigator {
	userAgentData?: { mobile: boolean };
}
