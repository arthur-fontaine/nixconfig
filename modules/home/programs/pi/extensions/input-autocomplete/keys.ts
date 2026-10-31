// Down and Up between the suggestions and pi-subagents' FleetView, the agent list under
// the editor. FleetView takes Down and Left at an empty prompt from a terminal input
// listener, which runs before the editor; as in Claude Code, where a list of more than
// one suggestion keeps Up and Down, the suggestions keep them while they can cycle.

export type Step = "next" | "previous";

// The suggestion Down or Up moves to, or undefined when the key isn't the suggestions'.
// Up on the first one goes on to the prompt history.
export function cycle(step: Step | undefined, count: number, selected: number): number | undefined {
	if (step === "next") return count > 1 ? (selected + 1) % count : undefined;
	if (step === "previous") return selected > 0 ? selected - 1 : undefined;
	return undefined;
}

export interface Arrival {
	// The editor has focus and the prompt is empty: where FleetView takes its keys.
	idle: boolean;
	// The suggestions would cycle on this key.
	cycles: boolean;
	// Down or Left, which move into FleetView when it lists agents.
	entersList: boolean;
	// Escape, which moves back out of it.
	leavesList: boolean;
}

// take: the suggestions handle the key before FleetView sees it.
// yield: the key may move into FleetView, which then owns Up and Down; the suggestion
//   is cleared and none comes back until the draft changes or Escape leaves the list.
// return: Escape, back at the prompt, where the suggestion comes back.
export type Arbitration = "take" | "yield" | "return" | undefined;

export function arbitrate(key: Arrival): Arbitration {
	if (!key.idle) return undefined;
	if (key.cycles) return "take";
	if (key.entersList) return "yield";
	if (key.leavesList) return "return";
	return undefined;
}
