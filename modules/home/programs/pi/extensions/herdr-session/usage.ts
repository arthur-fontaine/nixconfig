// The Claude usage pi-claude-code attaches to a response, as a rate-limit diagnostic.
const RATE_LIMIT = "claude-code.rate-limit";

export type Window = { utilization?: number; resetsAt?: number; status?: string };
export type RateLimit = { unifiedWindows?: { five_hour?: Window; seven_day?: Window }; overageStatus?: string; isUsingOverage?: boolean };

export function usageOf(message: unknown): RateLimit | undefined {
	const diagnostics = (message as { diagnostics?: { type?: string; details?: RateLimit }[] })?.diagnostics;
	return diagnostics?.findLast((d) => d?.type === RATE_LIMIT)?.details;
}

