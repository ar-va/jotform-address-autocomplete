// Serves the Jotform address widget (public/index.html) and looks up addresses
// with Google Places on the widget's behalf, so the Google key never reaches
// the browser.
//
//   GET /                         the widget page, only inside a Jotform iframe
//   GET /api/suggest?q=&session=&country=&scope=
//                                 address suggestions: in one country (default)
//                                 or, with scope=world, anywhere. One Google call.
//   GET /api/place?id=&session=   address parts for a picked suggestion
//   GET /api/status               {"search":"ok"|"limited"} (Google quota used up)
import { env } from "cloudflare:workers";

// Sites allowed to embed the widget. Add a Jotform custom form domain here if you use one.
const ALLOWED_HOSTS = ["jotform.com"];
const FRAME_ANCESTORS = ALLOWED_HOSTS.flatMap((h) => [`https://${h}`, `https://*.${h}`]).join(" ");

const PLACE_TYPES = ["street_address", "premise", "subpremise", "route"];
const PLACES_API = "https://places.googleapis.com/v1";
const GOOGLE_TIMEOUT_MS = 5000;
const SUGGEST_FIELDS = [
	"suggestions.placePrediction.placeId",
	"suggestions.placePrediction.text.text",
	"suggestions.placePrediction.structuredFormat",
].join(",");

const SESSION_RE = /^[0-9a-f-]{36}$/i;
const PLACE_ID_RE = /^[A-Za-z0-9_-]{1,512}$/;
const COUNTRY_RE = /^[a-z]{2}$/;
// Characters an address search may contain: letters in any language (with
// accents), digits, spaces and . , ' ’ # / & ( ) -. Same list as the widget.
const QUERY_RE = /^[\p{L}\p{M}\p{N} .,'’#/&()-]{3,200}$/u;

// When Google says the daily quota is used up, stop asking it for a while:
// rejected calls are pointless, and the widget can switch to manual entry
// straight away. Stored in this data centre's cache (not Google content).
const QUOTA_PAUSE_SECONDS = 600;
const QUOTA_FLAG_PATH = "/__quota-exhausted";

// Sent with every response. The page allows scripts from Jotform's widget
// library (which loads theme files and fonts itself), so script sources are
// not restricted; everything else that isn't needed is switched off.
const COMMON_HEADERS = {
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "same-origin",
	"X-Robots-Tag": "noindex, nofollow",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};
const PAGE_CSP = `frame-ancestors ${FRAME_ANCESTORS}; object-src 'none'; base-uri 'none'; form-action 'none'`;
const API_CSP = "default-src 'none'; frame-ancestors 'none'";

type Suggestion = { id: string; main: string; secondary: string; text: string };
type Prediction = {
	placeId?: string;
	text?: { text?: string };
	structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
};
type AddressComponent = { longText?: string; shortText?: string; types?: string[] };

function hostMatches(url: string, hosts: string[]): boolean {
	try {
		const host = new URL(url).hostname;
		return hosts.some((h) => host === h || host.endsWith("." + h));
	} catch {
		return false;
	}
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
	const out = new Response(res.body, res);
	for (const [k, v] of Object.entries({ ...COMMON_HEADERS, ...headers })) out.headers.set(k, v);
	return out;
}

function json(body: unknown, status = 200): Response {
	return withHeaders(new Response(JSON.stringify(body), { status }), {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
		"Content-Security-Policy": API_CSP,
	});
}

function text(body: string, status: number): Response {
	return withHeaders(new Response(body, { status }), {
		"Content-Type": "text/plain",
		"Content-Security-Policy": API_CSP,
	});
}

/* ---------- The widget page ---------- */

// Modern browsers send Sec-Fetch-Dest: iframe for framed loads, and the
// frame-ancestors policy stops non-Jotform pages from framing it. Older
// browsers without Sec-Fetch-* fall back to a Referer check.
async function servePage(request: Request, url: URL): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed", 405);
	const dest = request.headers.get("Sec-Fetch-Dest");
	const allowed = dest === "iframe" || (!dest && hostMatches(request.headers.get("Referer") ?? "", ALLOWED_HOSTS));
	if (!allowed) return text("Forbidden", 403);

	const res = await env.ASSETS.fetch(new Request(new URL("/", url), request));
	return withHeaders(res, {
		"Content-Security-Policy": PAGE_CSP,
		"Cache-Control": "no-cache",
		Vary: "Sec-Fetch-Dest, Referer",
	});
}

/* ---------- Address lookups ---------- */

// Only the widget page itself (same origin) may call the API. Headers can be
// forged by scripts, so the rate limit below is the real abuse protection.
function isFromWidget(request: Request, url: URL): boolean {
	const site = request.headers.get("Sec-Fetch-Site");
	if (site) return site === "same-origin";
	return hostMatches(request.headers.get("Referer") ?? "", [url.hostname]);
}

class LookupError extends Error {}

function quotaFlagKey(url: URL): Request {
	return new Request(url.origin + QUOTA_FLAG_PATH);
}

async function quotaExhausted(url: URL): Promise<boolean> {
	return (await caches.default.match(quotaFlagKey(url))) !== undefined;
}

async function markQuotaExhausted(url: URL): Promise<void> {
	const flag = new Response("1", { headers: { "Cache-Control": `max-age=${QUOTA_PAUSE_SECONDS}` } });
	await caches.default.put(quotaFlagKey(url), flag);
}

async function google<T>(path: string, init: { method: "GET" | "POST"; body?: unknown; fieldMask: string }): Promise<T> {
	const headers: Record<string, string> = {
		"X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
		"X-Goog-FieldMask": init.fieldMask,
	};
	if (init.body !== undefined) headers["Content-Type"] = "application/json";
	const res = await fetch(PLACES_API + path, {
		method: init.method,
		headers,
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
		signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
	});
	if (!res.ok) {
		// Shows up in the Worker's logs; the browser only gets a generic error.
		console.error(`Google Places ${path.split("?")[0]} failed: ${res.status} ${await res.text()}`);
		throw new LookupError(res.status === 429 ? "quota_exceeded" : "lookup_failed");
	}
	return res.json<T>();
}

async function autocomplete(input: string, session: string, regionCode?: string): Promise<Prediction[]> {
	const body: Record<string, unknown> = { input, sessionToken: session, includedPrimaryTypes: PLACE_TYPES };
	if (regionCode) body.includedRegionCodes = [regionCode];
	const data = await google<{ suggestions?: { placePrediction?: Prediction }[] }>("/places:autocomplete", {
		method: "POST",
		body,
		fieldMask: SUGGEST_FIELDS,
	});
	return (data.suggestions ?? []).flatMap((s) => (s.placePrediction ? [s.placePrediction] : []));
}

function toSuggestion(p: Prediction): Suggestion {
	const text = p.text?.text ?? "";
	return {
		id: p.placeId ?? "",
		main: p.structuredFormat?.mainText?.text ?? text,
		secondary: p.structuredFormat?.secondaryText?.text ?? "",
		text,
	};
}

// English name for a country code ("ca" -> "Canada"), or undefined if the
// code isn't a real region. Cached per Worker instance.
const countryNames = new Map<string, string | undefined>();
function countryName(code: string): string | undefined {
	if (!countryNames.has(code)) {
		let name: string | undefined;
		try {
			name = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }).of(code.toUpperCase());
		} catch {
			name = undefined;
		}
		countryNames.set(code, name && name !== "Unknown Region" ? name : undefined);
	}
	return countryNames.get(code);
}

// One Google call: addresses in `country`, or anywhere when scope is "world".
async function suggest(input: string, session: string, country: string, scope: "country" | "world") {
	const name = countryName(country) ?? country.toUpperCase();
	const predictions = await autocomplete(input, session, scope === "country" ? country : undefined);
	const items = predictions.filter((p) => p.placeId).map(toSuggestion);
	return {
		country,
		countryName: name,
		scope,
		groups: [{ label: scope === "country" ? name : "All countries", items }],
	};
}

async function placeParts(id: string, session: string) {
	const data = await google<{ addressComponents?: AddressComponent[] }>(
		`/places/${encodeURIComponent(id)}?sessionToken=${encodeURIComponent(session)}`,
		{ method: "GET", fieldMask: "addressComponents" },
	);
	const comps = data.addressComponents ?? [];
	const get = (type: string) => comps.find((c) => c.types?.includes(type))?.longText ?? "";
	return {
		streetNumber: get("street_number"),
		route: get("route"),
		unit: get("subpremise"),
		city: get("locality") || get("postal_town") || get("sublocality") || get("administrative_area_level_2"),
		province: get("administrative_area_level_1"),
		postalCode: get("postal_code"),
		country: get("country"),
	};
}

async function serveApi(request: Request, url: URL): Promise<Response> {
	if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
	if (!isFromWidget(request, url)) return json({ error: "forbidden" }, 403);

	// Per-visitor limit, so nobody can use up the Google quota for everyone else.
	const visitor = request.headers.get("CF-Connecting-IP") ?? "unknown";
	const { success } = await env.API_RATE_LIMIT.limit({ key: visitor });
	if (!success) return json({ error: "rate_limited" }, 429);

	if (!env.GOOGLE_MAPS_API_KEY) {
		console.error("GOOGLE_MAPS_API_KEY secret is not set");
		return json({ error: "not_configured" }, 503);
	}

	// Lets the widget switch to manual entry on load, without asking Google.
	const paused = await quotaExhausted(url);
	if (url.pathname === "/api/status") return json({ search: paused ? "limited" : "ok" });
	if (paused) return json({ error: "quota_exceeded" }, 503);

	const session = url.searchParams.get("session") ?? "";
	if (!SESSION_RE.test(session)) return json({ error: "bad_request" }, 400);

	try {
		if (url.pathname === "/api/suggest") {
			const q = (url.searchParams.get("q") ?? "").trim();
			const country = (url.searchParams.get("country") || env.PRIMARY_COUNTRY || "ca").toLowerCase();
			const scope = url.searchParams.get("scope") === "world" ? "world" : "country";
			if (!QUERY_RE.test(q) || !COUNTRY_RE.test(country) || !countryName(country)) {
				return json({ error: "bad_request" }, 400);
			}
			return json(await suggest(q, session, country, scope));
		}
		if (url.pathname === "/api/place") {
			const id = url.searchParams.get("id") ?? "";
			if (!PLACE_ID_RE.test(id)) return json({ error: "bad_request" }, 400);
			return json(await placeParts(id, session));
		}
	} catch (err) {
		if (err instanceof LookupError && err.message === "quota_exceeded") {
			await markQuotaExhausted(url);
			return json({ error: "quota_exceeded" }, 503);
		}
		if (err instanceof Error && err.name === "TimeoutError") console.error("Google Places timed out");
		return json({ error: "lookup_failed" }, 502);
	}
	return json({ error: "not_found" }, 404);
}

export default {
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/api/")) return serveApi(request, url);
		if (url.pathname === "/" || url.pathname === "/index.html") return servePage(request, url);
		return text("Not found", 404);
	},
} satisfies ExportedHandler;
