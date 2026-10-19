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

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
	});
}

function forbidden(): Response {
	return new Response("Forbidden", {
		status: 403,
		headers: { "Content-Type": "text/plain", "X-Robots-Tag": "noindex" },
	});
}

/* ---------- The widget page ---------- */

// Modern browsers send Sec-Fetch-Dest: iframe for framed loads, and the
// frame-ancestors header stops non-Jotform pages from framing it. Older
// browsers without Sec-Fetch-* fall back to a Referer check.
async function servePage(request: Request, url: URL): Promise<Response> {
	const dest = request.headers.get("Sec-Fetch-Dest");
	const allowed = dest === "iframe" || (!dest && hostMatches(request.headers.get("Referer") ?? "", ALLOWED_HOSTS));
	if (!allowed) return forbidden();

	const res = await env.ASSETS.fetch(new Request(new URL("/", url), request));
	const out = new Response(res.body, res);
	out.headers.set("Content-Security-Policy", `frame-ancestors ${FRAME_ANCESTORS}`);
	out.headers.set("X-Robots-Tag", "noindex, nofollow");
	out.headers.set("Cache-Control", "no-cache");
	out.headers.set("Vary", "Sec-Fetch-Dest, Referer");
	return out;
}

/* ---------- Address lookups ---------- */

// Only the widget page itself (same origin) may call the API.
function isFromWidget(request: Request, url: URL): boolean {
	const site = request.headers.get("Sec-Fetch-Site");
	if (site) return site === "same-origin";
	return hostMatches(request.headers.get("Referer") ?? "", [url.hostname]);
}

async function google(path: string, init: RequestInit & { fieldMask?: string }): Promise<any> {
	const headers: Record<string, string> = { "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY };
	if (init.body) headers["Content-Type"] = "application/json";
	if (init.fieldMask) headers["X-Goog-FieldMask"] = init.fieldMask;
	const res = await fetch(PLACES_API + path, { ...init, headers });
	if (!res.ok) {
		// Shows up in the Worker's logs; the browser only gets a generic error.
		console.error(`Google Places ${path.split("?")[0]} failed: ${res.status} ${await res.text()}`);
		throw new Error("lookup_failed");
	}
	return res.json();
}

async function autocomplete(input: string, session: string, regionCode?: string): Promise<Prediction[]> {
	const body: Record<string, unknown> = { input, sessionToken: session, includedPrimaryTypes: PLACE_TYPES };
	if (regionCode) body.includedRegionCodes = [regionCode];
	const data = await google("/places:autocomplete", { method: "POST", body: JSON.stringify(body) });
	return (data.suggestions ?? []).map((s: { placePrediction?: Prediction }) => s.placePrediction).filter(Boolean);
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

// Home-country results first, then worldwide, without duplicates.
async function suggest(input: string, session: string) {
	const region = (env.PRIMARY_COUNTRY || "ca").toLowerCase();
	const regionName = new Intl.DisplayNames(["en"], { type: "region" }).of(region.toUpperCase()) ?? region;
	const results = await Promise.allSettled([autocomplete(input, session, region), autocomplete(input, session)]);
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
	const inRegion = new RegExp(`(^|,\\s*)${regionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
	for (const p of world) {
		if (!p.placeId || seen.has(p.placeId)) continue;
		const s = toSuggestion(p);
		// Home-country results from the worldwide query belong in the first group
		if (inRegion.test(s.secondary) && primary.length < MAX_PRIMARY) {
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
			{ label: regionName, items: primary },
			{ label: "Other countries", items: other },
		],
	};
}

async function placeParts(id: string, session: string) {
	const data = await google(`/places/${encodeURIComponent(id)}?sessionToken=${encodeURIComponent(session)}`, {
		method: "GET",
		fieldMask: "addressComponents",
	});
	const comps: AddressComponent[] = data.addressComponents ?? [];
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

const SESSION_RE = /^[0-9a-f-]{36}$/i;
const PLACE_ID_RE = /^[A-Za-z0-9_-]{1,512}$/;

async function serveApi(request: Request, url: URL): Promise<Response> {
	if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
	if (!isFromWidget(request, url)) return json({ error: "forbidden" }, 403);
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
	} catch {
		return json({ error: "lookup_failed" }, 502);
	}
	return json({ error: "not_found" }, 404);
}

export default {
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/api/")) return serveApi(request, url);
		if (url.pathname === "/" || url.pathname === "/index.html") return servePage(request, url);
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler;
