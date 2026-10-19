import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "jotform-address-autocomplete-google-maps",
		compatibilityDate: "2026-09-30",
		entrypoint,
		// Every request goes through src/index.ts so it can block non-Jotform loads.
		assets: { runWorkerFirst: true },
		// The address Jotform loads the widget from. Change this to your own domain.
		domains: ["address.example.com"],
		workersDev: false,
		// Logs (e.g. Google errors) are viewable in the Cloudflare dashboard. Query
		// strings hold what people type, so they are left out of the logs.
		observability: { enabled: true, redactQueryString: true },
		env: {
			ASSETS: bindings.assets(),
			// Google Maps Platform key with Places API (New). Set it in .dev.vars,
			// then deploy with: cf deploy --secrets-file .dev.vars
			GOOGLE_MAPS_API_KEY: bindings.secret(),
			// Suggestions from this country (ISO 3166-1 alpha-2 code) are listed first.
			PRIMARY_COUNTRY: bindings.text("ca"),
			// Address lookups allowed per visitor (IP address) per minute. A person
			// filling in the form uses about 2–10; this stops one visitor from
			// burning through the daily Google quota. The namespace is any number
			// unique within your Cloudflare account.
			API_RATE_LIMIT: bindings.rateLimit({ namespace: "1001", simple: { limit: 30, period: 60 } }),
		},
	},
});
