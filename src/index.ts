// Serves the Jotform address widget (public/index.html) and looks up addresses
// with Google Places on the widget's behalf, so the Google key never reaches
// the browser.
//
//   GET /                         the widget page, only inside a Jotform iframe
//   GET /api/suggest?q=&session=  address suggestions, home country first
//   GET /api/place?id=&session=   address parts for a picked suggestion
import { env } from "cloudflare:workers";

// Sites allowed to embed the widget. Add a Jotform custom form domain here if you use one.
const ALLOWED_HOSTS = ["jotform.com"];
const FRAME_ANCESTORS = ALLOWED_HOSTS.flatMap((h) => [`https://${h}`, `https://*.${h}`]).join(" ");

const MAX_PRIMARY = 5; // max suggestions from the home country
const MAX_TOTAL = 8; // max suggestions overall
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
		throw new Error("lookup_failed");
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

// The home country's display name ("Canada") and a matcher for suggestions
// whose secondary text ends with it. Computed once per Worker instance.
let region: { code: string; name: string; matcher: RegExp } | undefined;
function homeRegion() {
	if (!region) {
		const code = (env.PRIMARY_COUNTRY || "ca").toLowerCase();
		const name = new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code;
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		region = { code, name, matcher: new RegExp(`(^|,\\s*)${escaped}$`, "i") };
	}
	return region;
}

// Home-country results first, then worldwide, without duplicates.
async function suggest(input: string, session: string) {
	const { code, name, matcher } = homeRegion();
	const results = await Promise.allSettled([autocomplete(input, session, code), autocomplete(input, session)]);
	if (results.every((r) => r.status === "rejected")) throw new Error("lookup_failed");
	const [home, world] = results.map((r) => (r.status === "fulfilled" ? r.value : []));

	const seen = new Set<string>();
	const primary: Suggestion[] = [];
	const other: Suggestion[] = [];
	for (const p of home) {
		if (!p.placeId || seen.has(p.placeId) || primary.length >= MAX_PRIMARY) continue;
		seen.add(p.placeId);
		primary.push(toSuggestion(p));
	}
	for (const p of world) {
		if (!p.placeId || seen.has(p.placeId)) continue;
		const s = toSuggestion(p);
		// Home-country results from the worldwide query belong in the first group
		if (matcher.test(s.secondary) && primary.length < MAX_PRIMARY) {
			seen.add(p.placeId);
			primary.push(s);
			continue;
		}
		if (primary.length + other.length >= MAX_TOTAL) continue;
		seen.add(p.placeId);
		other.push(s);
	}
	return {
		groups: [
			{ label: name, items: primary },
			{ label: "Other countries", items: other },
		],
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

	const session = url.searchParams.get("session") ?? "";
	if (!SESSION_RE.test(session)) return json({ error: "bad_request" }, 400);

	try {
		if (url.pathname === "/api/suggest") {
			const q = (url.searchParams.get("q") ?? "").trim();
			if (q.length < 3 || q.length > 200) return json({ error: "bad_request" }, 400);
			return json(await suggest(q, session));
		}
		if (url.pathname === "/api/place") {
			const id = url.searchParams.get("id") ?? "";
			if (!PLACE_ID_RE.test(id)) return json({ error: "bad_request" }, 400);
			return json(await placeParts(id, session));
		}
	} catch (err) {
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
