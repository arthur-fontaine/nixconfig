import { registerHooks } from "node:module";
// Pi's packages, and remote-control's api.ts (TypeScript Node can't strip), stubbed.
const pi = new URL("./pi.ts", import.meta.url).href;
const credentials = new URL("./credentials.ts", import.meta.url).href;
registerHooks({
	resolve(specifier, context, next) {
		if (specifier.startsWith("@earendil-works/")) return { url: pi, shortCircuit: true };
		if (specifier.endsWith("remote-control/api.ts")) return { url: credentials, shortCircuit: true };
		return next(specifier, context);
	},
});
