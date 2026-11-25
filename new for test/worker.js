// ============================================================================================
//  cf-proxy-ex - Cloudflare Worker web proxy (URL-rewriting reverse proxy)
//  REBUILT / HARDENED VERSION
// ============================================================================================
//
//  Forked this project?
//  --------------------------------------------------------------------------------------
//  Almost everything you'd want to change for a personal fork lives in the CONFIG
//  object below (password, site title, GitHub link in the footer, etc).
//
//  Deploy on Cloudflare Workers:
//    Upload this exact file as your Worker. The file name does not matter.
//
//  Deploy on Cloudflare Pages:
//    Rename this file to _worker.js and place it at the root of your Pages
//    project's build output directory. Cloudflare Pages will run it as a full
//    Worker and route every request through it. See Cloudflare's "Pages
//    Advanced Mode / _worker.js" documentation.
// ============================================================================================

const CONFIG = {
  // Site title shown in the browser tab and on the home page.
  SITE_TITLE: "Web Proxy",

  // Password required to use the proxy. Set to "" to disable the password gate.
  PASSWORD: "123",

  // If true, show a designed password page instead of a bare 403 response.
  SHOW_PASSWORD_PAGE: true,

  // How long the password cookie remains valid, in days.
  PASSWORD_COOKIE_DAYS: 7,

  // GitHub repository URL shown in the home page footer.
  // Forked this project? Change this to your own repository URL.
  GITHUB_REPO_URL: "https://github.com/1234567Yang/cf-proxy-ex",

  // Optional credit name/link shown in the footer. Leave both empty to hide it.
  CREDIT_NAME: "",
  CREDIT_URL: "",
};

// ---- Internal technical constants - most forks do not need to change these ----
const PATH_SEP = "/";
const COOKIE_NS_PREFIX = "__pxsite_";        // per-site cookie name prefix (namespacing)
const PASSWORD_COOKIE_NAME = "__proxy_pwd__";
const LAST_VISIT_COOKIE_NAME = "__proxy_last__";
const LAST_DOCUMENT_COOKIE_NAME = "__proxy_doc__";
const ROUTE_BOOT_RULES_COOKIE_NAME = "__proxy_route_rules__";
const DEFAULT_ROUTE_BOOT_PREFIXES = [
  "https://github.com",
  "https://www.pinterest.com",
  "https://pinterest.com",
  "https://9xbud.com",
  "https://www.9xbud.com",
  "https://9xbuddy.com",
  "https://www.9xbuddy.com",
  "https://9xbuddy.in",
  "https://www.9xbuddy.in",
  "https://9xbuddy.site",
  "https://www.9xbuddy.site",
  "https://9xbuddy.online",
  "https://www.9xbuddy.online",
];
const REPLACE_LOCATION_OBJ_NAME = "__location__yproxy__";
// Legacy reserved path segment. It is stripped for compatibility with older
// clients but is no longer generated. Marking module URLs changes their base
// path and breaks applications (notably GitHub) that derive chunk URLs from
// the URL of an already-loaded module.
const MODULE_MARKER_SEGMENT = "__pxmod__";

export default {
  async fetch(request) {
    try {
      return await handleRequest(request);
    } catch (err) {
      return new Response(
        "Proxy worker error: " + (err && err.stack ? err.stack : String(err)) +
        (err && err.cause ? ("\nCAUSE: " + (err.cause.stack || err.cause.message || String(err.cause))) : ""),
        { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }
  },
};

// ============================================================================================
//  Server-side helpers (run in the Worker itself, not in the visitor's browser)
// ============================================================================================

// Stable short per-host hash, used to namespace cookies so that two different proxied sites
// can never see or overwrite each other's cookies even though they share one proxy domain.
// NOTE: the exact same algorithm is duplicated in the client-side injected script further
// below (search for "siteToken") — if you ever change this function, change both copies.
function siteToken(host) {
  let h = 0;
  for (let i = 0; i < host.length; i++) {
    h = (Math.imul(31, h) + host.charCodeAt(i)) | 0;
  }
  return "h" + Math.abs(h).toString(36);
}
function sitePrefix(host) {
  return COOKIE_NS_PREFIX + siteToken(host) + "__";
}

// Reads a cookie value by name out of a raw `Cookie` header string.
function getCookieValue(name, cookieHeader) {
  if (!cookieHeader) return "";
  const re = new RegExp("(?:^|;\\s*)" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)");
  const m = re.exec(cookieHeader);
  return m ? decodeURIComponent(m[1]) : "";
}

// Base64-encodes a byte array without blowing the call stack on large inputs
// (replaces the old "comma separated byte list" approach, which was ~3x larger).
function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Given a header value that might be the proxy's own URL/host (e.g. a Referer header sent by
// the browser for a page served from the proxy), recover the *real* target URL it represents.
function extractProxiedUrl(value, proxyBase, proxyHostOnly) {
  if (!value) return null;
  let v = value;
  let strippedAnyLayer = false;
  // A proxied URL can also arrive percent-encoded inside a query value that
  // the server has already decoded exactly once (URLSearchParams semantics).
  // In that form the embedded target is still encoded, so the plain prefix
  // checks below cannot see it. Peel up to three encoding layers up-front,
  // remembering that decoding happened so the caller can re-encode correctly.
  for (let encGuard = 0; encGuard < 3; encGuard++) {
    if (!/%3a%2f%2f/i.test(v)) break;
    try {
      const decoded = decodeURIComponent(v);
      if (decoded === v) break;
      v = decoded;
    } catch { break; }
  }
  // Keep stripping proxy-host prefixes in a loop, not just once: a value can end up WRAPPED
  // MORE THAN ONCE (confirmed live: a Referer/request URL of the shape
  // "proxyHost/proxyHost/config?url=..." was observed coming out of an ad SDK that builds its
  // own callback URL from window.location/document.referrer while already running inside a
  // page this proxy rewrote -- it unknowingly picks up an already-proxied URL as its "origin"
  // and re-wraps it again when constructing its own request). Stripping only ONE layer here
  // used to leave the proxy's own hostname sitting inside the Referer/URL we hand to the real
  // destination site -- visibly revealing "this traffic is coming through a known proxy
  // hostname" to any WAF/bot-detection the destination runs, which plausibly explains
  // blocking that only shows up on a real public deployment (a distinctive *.workers.dev-style
  // hostname is a much more recognizable red flag to a WAF than this sandbox's local test
  // harness URL ever was). Loop until no further proxy-prefix layer is found.
  for (let guard = 0; guard < 10; guard++) {
    if (v.startsWith(proxyBase)) {
      v = v.substring(proxyBase.length);
    } else if (v.startsWith(proxyBase.substring(0, proxyBase.length - 1))) {
      v = v.substring(proxyBase.length - 1);
    } else {
      const marker = "://" + proxyHostOnly + "/";
      // Only the FIRST pass searches for the marker anywhere in the string (pre-existing
      // behavior, kept as-is for whatever malformed-Referer case it originally handled).
      // Subsequent passes only unwrap when the remaining string is ITSELF immediately another
      // full proxy-prefixed URL (idx === 0) -- not when the marker merely happens to appear
      // somewhere later in an otherwise-legitimate destination URL, which must not be touched.
      const idx = v.indexOf(marker);
      if (idx === -1 || (strippedAnyLayer && idx !== 0)) break;
      v = v.substring(idx + marker.length);
    }
    strippedAnyLayer = true;
    if (v.startsWith("/")) v = v.substring(1);
  }
  if (!strippedAnyLayer) return null;
  if (!v.startsWith("http")) v = "https://" + v;
  try {
    return new URL(v);
  } catch {
    return null;
  }
}

// De-proxy any proxy URL embedded *inside* another string: percent-encoded
// (sometimes more than once), slash-escaped (JSON style), or plain. Server-side
// code uses this before forwarding a request so that the destination never
// receives the proxy's own host anywhere in the URL it is asked to process --
// anti-bot/challenge servers validate redirect-style parameters and reject or
// mis-handle values that point at an unrelated proxy hostname. The transform is
// idempotent and a no-op for strings that contain no proxy reference.
function deproxyEmbeddedUrls(text, proxyBase, proxyHostOnly) {
  if (!text || typeof text !== "string") return text;
  const proxyNoSlash = proxyBase.substring(0, proxyBase.length - 1);
  let out = text;
  // Percent-encoded forms first: encodeURIComponent(proxyBase) and deeper
  // encodings a destination or intermediate script may have produced.
  let guard = 0;
  while (guard++ < 4) {
    let changed = false;
    const encodedForms = [
      [encodeURIComponent(proxyBase), ""],
      [encodeURIComponent(proxyNoSlash), ""],
      [encodeURI(proxyBase), ""],
    ];
    for (const [enc, _] of encodedForms) {
      if (enc && out.includes(enc)) {
        // An encoded proxied URL still embeds the *target* URL after the
        // encoded proxy prefix in encoded form. Recover by decoding the whole
        // value one layer when it is clearly a URL-bearing string, rather
        // than trying to splice encoded segments.
        try {
          const decoded = decodeURIComponent(out);
          if (decoded !== out) { out = decoded; changed = true; }
        } catch { /* leave as-is */ }
        break;
      }
    }
    if (!changed) break;
    // After one decode pass, rewrite any now-plain proxied URLs and repeat if
    // another encoded layer remains.
    out = out.split(proxyBase).join("");
    // The pass above may have produced a bare target URL at the start (good)
    // or stripped a legitimate proxy return URL (the caller decides whether
    // that is desired -- see deproxyForOrigin).
    if (!out.includes(encodeURIComponent(proxyNoSlash)) && !out.includes(encodeURIComponent("https://"))) break;
  }
  // JSON slash-escaped plain form: https:\/\/proxy.host\/https:\/\/site\/...
  out = out.replaceAll(proxyBase.replaceAll("/", "\\/"), "");
  out = out.replaceAll(proxyNoSlash.replaceAll("/", "\\/"), "");
  // Plain form.
  out = out.split(proxyBase).join("");
  out = out.split(proxyNoSlash + "/").join("");
  return out;
}

// Prepare a request URL string for forwarding to its real destination:
// embedded proxied destinations (most commonly redir/redirect/url parameters)
// are converted back to the original absolute URL the page intended, so the
// origin never sees this proxy's hostname in a value it must validate.
function deproxyForOrigin(urlString, proxyBase, proxyHostOnly) {
  if (!urlString) return urlString;
  let u;
  try { u = new URL(urlString); } catch { return urlString; }
  let changed = false;
  // Inspect *every* query parameter (not just known return-parameter names):
  // the rule is structural, not a name list. A value is converted only when,
  // after peeling encoding layers, it is itself a proxied URL whose embedded
  // target parses as an absolute http(s) URL. Plain text, tokens, hashes,
  // ids, and already-original URLs are forwarded byte-for-byte.
  for (const [key, value] of [...u.searchParams.entries()]) {
    const recovered = extractProxiedUrl(value, proxyBase, proxyHostOnly);
    if (recovered) {
      u.searchParams.set(key, recovered.href);
      changed = true;
    }
  }
  return changed ? canonicalizeNestedQuery(u, proxyBase, proxyHostOnly) : urlString;
}

// Verification widgets sometimes base64-encode their embedding origin in an
// otherwise opaque query value. Recover only values that decode to this exact
// proxy host, replacing them with the referring original page's origin.
function restoreEncodedOriginParams(url, proxyHostOnly, originalPageOrigin) {
  if (!url || !originalPageOrigin || !url.search) return url ? url.href : "";
  const proxyHostname = proxyHostOnly.split(":")[0].toLowerCase();
  let original;
  try { original = new URL(originalPageOrigin); } catch { return url.href; }
  for (const [key, value] of [...url.searchParams.entries()]) {
    if (!value || value.length < 8 || value.length > 512 || !/^[A-Za-z0-9+/_=-]+[.=]*$/.test(value)) continue;
    try {
      let normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/\./g, "=");
      while (normalized.length % 4) normalized += "=";
      const encodedOrigin = new URL(atob(normalized));
      if (encodedOrigin.hostname.toLowerCase() !== proxyHostname) continue;
      const explicitOrigin = original.protocol + "//" + original.hostname +
        (original.port ? ":" + original.port : (original.protocol === "https:" ? ":443" : original.protocol === "http:" ? ":80" : ""));
      url.searchParams.set(key, btoa(explicitOrigin).replace(/=/g, "."));
    } catch { /* opaque value, leave unchanged */ }
  }
  return url.href;
}

// De-proxy values inside a *text* request body before it is forwarded.
// The destination must never receive this proxy's hostname embedded in a
// value it validates (form fields, JSON payloads, GraphQL variables...).
// Conversion is structural and conservative:
//   - form-encoded bodies: each field value goes through the same
//     "is it a proxied absolute URL?" test as query parameters;
//   - JSON bodies: the document is parsed and only string *values* that are
//     proxied absolute URLs are converted (keys and opaque strings stay);
//   - other text: only complete proxied URL tokens are replaced, in plain
//     and slash-escaped form. Percent-encoded occurrences inside a body are
//     deliberately left alone: without knowing the field's own encoding
//     contract, decoding it here could corrupt the payload. Bodies that do
//     not change are returned as the original stream (body2) by the caller.
function deproxyBodyText(bodyText, proxyBase, proxyHostOnly, contentType) {
  if (!bodyText) return bodyText;
  const ct = (contentType || "").toLowerCase();
  const convert = (v) => {
    const r = extractProxiedUrl(v, proxyBase, proxyHostOnly);
    return r ? r.href : v;
  };
  try {
    if (ct.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(bodyText);
      let changed = false;
      for (const [key, value] of [...params.entries()]) {
        const next = convert(value);
        if (next !== value) { params.set(key, next); changed = true; }
      }
      return changed ? params.toString() : bodyText;
    }
    if (ct.includes("json")) {
      let data;
      try { data = JSON.parse(bodyText); } catch { return bodyText; }
      let changed = false;
      const walk = (node) => {
        if (typeof node === "string") {
          // A JSON string value may itself carry escaped slashes; normalize
          // only for the conversion test, then keep the author's escaping
          // style by converting the unescaped form and re-escaping.
          const unescaped = node.replaceAll("\\/", "/");
          const next = convert(unescaped);
          if (next !== unescaped) { changed = true; return node.includes("\\/") ? next.replaceAll("/", "\\/") : next; }
          return node;
        }
        if (Array.isArray(node)) return node.map(walk);
        if (node && typeof node === "object") {
          const out = {};
          for (const k of Object.keys(node)) out[k] = walk(node[k]);
          return out;
        }
        return node;
      };
      const out = walk(data);
      return changed ? JSON.stringify(out) : bodyText;
    }
  } catch { return bodyText; }
  // Generic text: replace complete proxied URL tokens only, in plain and
  // slash-escaped form. The remainder of the text is forwarded unchanged.
  let out = bodyText;
  const proxyNoSlash = proxyBase.substring(0, proxyBase.length - 1);
  out = out.split(proxyBase).join("");
  out = out.split(proxyNoSlash + "/").join("");
  out = out.replaceAll(proxyBase.replaceAll("/", "\\/"), "");
  out = out.replaceAll(proxyNoSlash.replaceAll("/", "\\/"), "");
  return out;
}

// After a top-level proxied value is recovered, its target may itself carry a
// query string containing further proxied values (nested return chains). Walk
// one structural level deeper so no proxy host remains anywhere in the URL
// that is finally forwarded.
function canonicalizeNestedQuery(u, proxyBase, proxyHostOnly) {
  let changed = false;
  for (const [key, value] of [...u.searchParams.entries()]) {
    try {
      const inner = new URL(value);
      if (!inner.search) continue;
      for (const [ik, iv] of [...inner.searchParams.entries()]) {
        const recovered = extractProxiedUrl(iv, proxyBase, proxyHostOnly);
        if (recovered) { inner.searchParams.set(ik, recovered.href); changed = true; }
      }
      if (changed) u.searchParams.set(key, inner.href);
    } catch { /* not a URL value -- leave untouched */ }
  }
  return u.href;
}

// Rewrite JSON script islands inside an HTML document before it is handed to
// the browser. Only script elements whose type marks them as JSON data are
// touched, and only complete proxied URL tokens inside their string values:
// each island is parsed, its string values are converted with the same
// structural rule as query parameters, and the island is re-serialized.
// Executable script text and everything else pass through untouched. An
// island that fails to parse is left exactly as authored.
function rewriteJsonIslands(html, proxyBase, proxyHostOnly) {
  if (!html || !html.includes(proxyHostOnly)) return html;
  return html.replace(/<script\b([^>]*\btype\s*=\s*["'][^"']*json[^"']*["'][^>]*)>([\s\S]*?)<\/script>/gi, (whole, attrs, text) => {
    const trimmed = String(text).trim();
    if (!trimmed || (trimmed.charAt(0) !== "{" && trimmed.charAt(0) !== "[")) return whole;
    let data;
    try { data = JSON.parse(trimmed); } catch { return whole; }
    let changed = false;
    const walk = (node) => {
      if (typeof node === "string") {
        const recovered = extractProxiedUrl(node, proxyBase, proxyHostOnly);
        if (recovered) { changed = true; return recovered.href; }
        return node;
      }
      if (Array.isArray(node)) return node.map(walk);
      if (node && typeof node === "object") {
        const out = {};
        for (const k of Object.keys(node)) out[k] = walk(node[k]);
        return out;
      }
      return node;
    };
    const out = walk(data);
    if (!changed) return whole;
    return "<script" + attrs + ">" + JSON.stringify(out) + "<\/script>";
  });
}

// Google reCAPTCHA uses an origin-locked setup message to connect its parent,
// anchor, and image-challenge frames. A path proxy puts those frames on the
// proxy's browser origin, so native postMessage rejects Google's targetOrigin
// before any reload/payload request can start. Rewrite method calls only in
// Google's reCAPTCHA runtime; the injected helper below translates only the
// literal recaptcha-setup handshake and delegates every other call unchanged.
function rewriteGoogleRecaptchaPostMessage(code) {
  if (!code || !code.includes("postMessage")) return code;
  return code.replace(/((?:this|[A-Za-z_$][\w$]*)(?:(?:\.[A-Za-z_$][\w$]*)|(?:\[[^\]\r\n]+\]))*)\.postMessage\s*\(/g,
    "__pxRecaptchaPostMessage($1,");
}

// 9xbuddy signs API requests with a key derived from location.hostname and
// sends the same hostname in x-requested-domain. Inside a path proxy, native
// Location reports the proxy host and the download API rejects the signature.
// Only the hashed modules that create/decode this signature are transformed.
function rewrite9xBuddyHostname(code) {
  if (!code || !code.includes("location.hostname")) return code;
  return code.replace(/\b[A-Za-z_$][\w$]*\.location\.hostname\b/g,
    "window.original_website_url.hostname");
}

// ============================================================================================
//  CLIENT-SIDE INJECTED SCRIPT  —  runs inside the visitor's browser, on top of every proxied
//  page. Everything in this template-literal string is plain JavaScript *text*; it is never
//  executed by the Worker itself. To avoid the classic "nested backtick" trap (a backtick
//  inside this backtick-delimited string would terminate it early and silently corrupt the
//  whole file) none of the code below builds strings with nested template literals — it only
//  ever uses string concatenation ('+') or .replace()/regex. Please keep that convention if
//  you edit this section.
// ============================================================================================
const httpRequestInjection = `
//=== Figure out which real ("original") site this proxied page represents =================
var nowURL = new URL(window.location.href);
var proxy_host = nowURL.host;
var proxy_protocol = nowURL.protocol;
var proxy_host_with_schema = proxy_protocol + "//" + proxy_host + "/";
// The real page URL *before* this proxy wrapped it. Client code must be able to
// tell the two apart: network destinations are built from the PROXIED form (so
// traffic stays on this proxy), while values a page *reports about itself* --
// return/redirect parameters, canonical/self URLs, referrer-style values it
// embeds in its own requests -- must be built from the ORIGINAL form, or the
// destination receives this proxy's hostname inside a value it validates
// against its own domain and rejects the request (confirmed live: Anubis
// builds redir from location.href and Startpage refuses a proxied redir).
var original_website_url_str_now = (function () {
    var h = window.location.href;
    return h.indexOf(proxy_host_with_schema) === 0 ? h.substring(proxy_host_with_schema.length) : h;
})();

// Some applications read the browser's non-configurable native pathname during
// bootstrap. A path proxy exposes /https://host/... there, which can suppress
// deferred requests or select an empty route. Route-boot rules temporarily
// present the original pathname, keep proxy helpers bound to the saved original
// URL, then restore the complete visible proxy URL without navigation. Rules
// live in one JSON cookie; the most specific matching URL prefix wins.
var __pxDefaultRouteBootPrefixes = ${JSON.stringify(DEFAULT_ROUTE_BOOT_PREFIXES)};
function __pxNormalizeRouteBootPrefix(value) {
    var url = new URL(String(value).trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw Error("Only HTTP and HTTPS URLs are supported.");
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    var path = url.pathname || "/";
    if (path.length > 1) path = path.replace(/\\/+$/, "");
    return url.origin + (path === "/" ? "" : path);
}
function __pxReadRouteBootOverrides() {
    var name = "${ROUTE_BOOT_RULES_COOKIE_NAME}=";
    var encoded = "";
    var parts = document.cookie.split(";");
    for (var i = 0; i < parts.length; i++) {
        var part = parts[i].trim();
        if (part.indexOf(name) === 0) encoded = part.substring(name.length);
    }
    if (!encoded) return {};
    try {
        var parsed = JSON.parse(decodeURIComponent(encoded));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (e) { return {}; }
}
function __pxRouteBootPrefixMatches(target, prefix) {
    try {
        var rule = new URL(prefix);
        if (target.origin !== rule.origin) return false;
        var rulePath = rule.pathname || "/";
        var targetPath = target.pathname || "/";
        return rulePath === "/" || targetPath === rulePath || targetPath.indexOf(rulePath + "/") === 0;
    } catch (e) { return false; }
}
function __pxShouldUseRouteBoot(target) {
    var decisions = Object.create(null);
    for (var i = 0; i < __pxDefaultRouteBootPrefixes.length; i++) {
        try { decisions[__pxNormalizeRouteBootPrefix(__pxDefaultRouteBootPrefixes[i])] = true; } catch (e) { /* ignore invalid default */ }
    }
    var overrides = __pxReadRouteBootOverrides();
    Object.keys(overrides).forEach(function (key) {
        try {
            var normalized = __pxNormalizeRouteBootPrefix(key);
            decisions[normalized] = overrides[key] === 1 || overrides[key] === true || overrides[key] === "1";
        } catch (e) { /* ignore invalid cookie entry */ }
    });
    var enabled = false;
    var bestLength = -1;
    Object.keys(decisions).forEach(function (prefix) {
        if (__pxRouteBootPrefixMatches(target, prefix) && prefix.length > bestLength) {
            bestLength = prefix.length;
            enabled = decisions[prefix];
        }
    });
    return enabled;
}
var __pxRouteModeEnabled = false;
var __pxRouteBootActive = false;
var __pxRouteFullBrowserUrl = window.location.href;
var __pxRouteVirtualPath = "";
var __pxNativeHistoryReplaceState = History.prototype.replaceState;
try {
    var __pxRouteOriginalUrl = new URL(original_website_url_str_now);
    if (window.top === window && __pxShouldUseRouteBoot(__pxRouteOriginalUrl)) {
        __pxRouteModeEnabled = true;
        __pxRouteBootActive = true;
        __pxRouteVirtualPath = __pxRouteOriginalUrl.pathname + __pxRouteOriginalUrl.search + __pxRouteOriginalUrl.hash;
        __pxNativeHistoryReplaceState.call(window.history, window.history.state, "", __pxRouteVirtualPath);
        var __pxFinishRouteBoot = function () {
            if (!__pxRouteBootActive) return;
            __pxNativeHistoryReplaceState.call(window.history, window.history.state, "", __pxRouteFullBrowserUrl);
            __pxRouteBootActive = false;
        };
        window.addEventListener("load", function () { setTimeout(__pxFinishRouteBoot, 8000); }, { once: true });
        setTimeout(__pxFinishRouteBoot, 20000);
    }
} catch (e) { __pxRouteBootActive = false; __pxRouteModeEnabled = false; }

// Recomputed on every access after bootstrap because a page can change its own
// URL via history.pushState/replaceState without a reload.
Object.defineProperty(window, 'original_website_url_str', {
    get: function () {
        return __pxRouteBootActive ? original_website_url_str_now : window.location.href.substring(proxy_host_with_schema.length);
    }
});
function proxyAwareOriginalUrl(value) {
    // Given any URL the page produced (proxied, original, relative, or mixed --
    // including values embedded percent-encoded or slash-escaped inside other
    // strings), return the ORIGINAL-site form. Network hooks use the inverse
    // (changeURL) for destinations; this is for *self-describing* values.
    if (value == null) return value;
    var v = String(value);
    try {
        if (v.indexOf(proxy_host_with_schema) === 0) return v.substring(proxy_host_with_schema.length);
        if (v.indexOf(proxy_host_with_schema.replaceAll("/", "\\/")) === 0) return v.substring(proxy_host_with_schema.length + 6);
        var decoded = v;
        for (var g = 0; g < 3; g++) {
            if (!/%3a%2f%2f/i.test(decoded)) break;
            var d = decodeURIComponent(decoded);
            if (d === decoded) break;
            decoded = d;
            if (decoded.indexOf(proxy_host_with_schema) === 0) return decoded.substring(proxy_host_with_schema.length);
        }
        // Relative or already-original absolute URL: resolve against the
        // original page URL so callers always get an absolute real URL.
        return new URL(v, original_website_url_str).href;
    } catch (e) {
        return v;
    }
}
Object.defineProperty(window, 'original_website_url', {
    get: function () { return new URL(original_website_url_str); }
});
Object.defineProperty(window, 'original_website_host', {
    get: function () {
        var h = original_website_url_str.substring(original_website_url_str.indexOf("://") + "://".length);
        return h.split('/')[0];
    }
});
Object.defineProperty(window, 'original_website_host_with_schema', {
    get: function () {
        return original_website_url_str.substring(0, original_website_url_str.indexOf("://")) + "://" + original_website_host + "/";
    }
});

//=== siteToken(host): MUST stay identical to the server-side copy in the Worker source =====
// (used to namespace cookies/storage per proxied site, see cookieInject()/storageInject())
function siteToken(host) {
    var h = 0;
    for (var i = 0; i < host.length; i++) {
        h = (Math.imul(31, h) + host.charCodeAt(i)) | 0;
    }
    return "h" + Math.abs(h).toString(36);
}
function sitePrefix(host) {
    return "${COOKIE_NS_PREFIX}" + siteToken(host) + "__";
}

//=== changeURL / getOriginalUrl: core helpers translating between real <-> proxied URLs =====
// Some browser-verification widgets encode the embedding origin as base64 in a
// query value. If that decoded value is structurally the proxy's own origin,
// replace it with the original page origin before the request leaves the page.
// Opaque base64 values that are not this proxy's absolute origin pass through.
function restoreEncodedOriginalOrigins(urlString) {
    try {
        var url = new URL(urlString);
        var changed = false;
        url.searchParams.forEach(function (value, key) {
            if (!value || value.length < 8 || value.length > 512 || !/^[A-Za-z0-9+/_=-]+[.=]*$/.test(value)) return;
            try {
                var normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/\./g, "=");
                while (normalized.length % 4) normalized += "=";
                var encodedOrigin = new URL(atob(normalized));
                if (encodedOrigin.hostname !== nowURL.hostname) return;
                var original = new URL(original_website_url.origin);
                var explicitOrigin = original.protocol + "//" + original.hostname +
                    (original.port ? ":" + original.port : (original.protocol === "https:" ? ":443" : original.protocol === "http:" ? ":80" : ""));
                url.searchParams.set(key, btoa(explicitOrigin).replace(/=/g, "."));
                changed = true;
            } catch (e) { /* not an encoded absolute origin */ }
        });
        return changed ? url.href : urlString;
    } catch (e) { return urlString; }
}
function changeURL(relativePath) {
    if (relativePath == null) return relativePath;
    // An empty string is a common placeholder value (e.g. a not-yet-populated img src). Left
    // alone, new URL("", base) resolves to the *base itself*, which would otherwise turn a
    // harmless empty attribute into a link back to the current page -- leave it untouched.
    if (relativePath === "") return relativePath;
    var relativePath_str = (relativePath instanceof URL) ? relativePath.href : String(relativePath);

    try {
        if (/^(blob|data|about|javascript|mailto|tel|sms|chrome|edge|chrome-extension|moz-extension):/i.test(relativePath_str)) {
            return relativePath_str;
        }
    } catch (e) {
        return relativePath_str;
    }

    try {
        var startWithLs = [proxy_host_with_schema, proxy_host + "/", proxy_host];
        startWithLs.forEach(function (x) {
            if (relativePath_str.startsWith(x)) relativePath_str = relativePath_str.substring(x.length);
        });
        startWithLs.forEach(function (x) {
            x = "/" + x;
            if (relativePath_str.startsWith(x)) relativePath_str = relativePath_str.substring(x.length);
        });

        var enhancedStartRm = [original_website_host_with_schema.substring(0, original_website_host_with_schema.length - 1), original_website_host];
        enhancedStartRm.forEach(function (x) {
            x = "/" + x;
            if (relativePath_str.startsWith(x)) relativePath_str = relativePath_str.substring(x.length);
        });
    } catch (e) { /* ignore */ }

    try {
        var absolutePath = new URL(relativePath_str, original_website_url_str).href;
        absolutePath = absolutePath.replaceAll(window.location.href, original_website_url_str);
        absolutePath = absolutePath.replaceAll(encodeURI(window.location.href), encodeURI(original_website_url_str));
        absolutePath = absolutePath.replaceAll(encodeURIComponent(window.location.href), encodeURIComponent(original_website_url_str));
        absolutePath = absolutePath.replaceAll(proxy_host, original_website_host);
        absolutePath = absolutePath.replaceAll(encodeURI(proxy_host), encodeURI(original_website_host));
        absolutePath = absolutePath.replaceAll(encodeURIComponent(proxy_host), encodeURIComponent(original_website_host));
        absolutePath = restoreEncodedOriginalOrigins(absolutePath);
        absolutePath = proxy_host_with_schema + absolutePath;
        return absolutePath;
    } catch (e) {
        console.log("changeURL exception: " + e.message + " | " + relativePath_str);
        return relativePath_str;
    }
}

function getOriginalUrl(url) {
    if (url == null) return url;
    if (typeof url !== "string") return url;
    // Strip possibly MULTIPLE proxy prefixes. A value can get wrapped twice when a
    // page/SDK builds a URL from an already-proxied href (ad widgets reading
    // location.href/document.currentScript.src are the repeat offenders) -- unwrapping
    // only one layer leaves the proxy's own hostname sitting inside the "original" URL
    // we hand back, and any later fetch()/location use of that value goes to a nonsense
    // self-referential address (proxy/proxy-host/config?... 404s). Loop defensively.
    var out = url;
    for (var __i = 0; __i < 5 && out.startsWith(proxy_host_with_schema); __i++) {
        out = out.substring(proxy_host_with_schema.length);
    }
    return out;
}

// Google reCAPTCHA-specific cross-frame handshake. The server-side transform
// routes method calls here from Google's runtime. Because this helper executes
// in the caller's realm, native MessageEvent.source remains correct; only the
// recaptcha-setup target/origin is virtualized.
function recaptchaMessageInject() {
    window.__pxRecaptchaPostMessage = function (target) {
        var args = Array.prototype.slice.call(arguments, 1);
        if (args[0] === "recaptcha-setup" && typeof args[1] === "string") {
            try {
                var requested = new URL(args[1]);
                if ((requested.protocol === "https:" || requested.protocol === "http:") &&
                    target && target.location && target.location.origin === window.location.origin) {
                    args[1] = window.location.origin;
                }
            } catch (e) { /* preserve native validation */ }
        }
        return target.postMessage.apply(target, args);
    };

    if (window.MessageEvent) {
        var originDescriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "origin");
        var sourceDescriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "source");
        if (originDescriptor && originDescriptor.get && sourceDescriptor && sourceDescriptor.get) {
            try {
                Object.defineProperty(MessageEvent.prototype, "origin", {
                    configurable: true,
                    enumerable: originDescriptor.enumerable,
                    get: function () {
                        var nativeOrigin = originDescriptor.get.call(this);
                        if (this.data !== "recaptcha-setup" || nativeOrigin !== window.location.origin) return nativeOrigin;
                        try {
                            var source = sourceDescriptor.get.call(this);
                            var sourceHref = source && source.location && source.location.href;
                            return sourceHref ? new URL(getOriginalUrl(sourceHref)).origin : nativeOrigin;
                        } catch (e) { return nativeOrigin; }
                    },
                });
            } catch (e) { /* browser may refuse prototype override */ }
        }
    }
    console.log("GOOGLE RECAPTCHA MESSAGE BRIDGE INJECTED");
}

// Like changeURL(), but for <script type="module"> src values: tags the rewritten URL with
// a reserved marker segment so the Worker knows -- purely from the request URL, the only thing
// it can see -- never to sandbox-wrap this file's body in with(...), which would be an instant
// SyntaxError against a module's implicit strict mode. See MODULE_MARKER_SEGMENT server-side.
function changeURLForScript(relativePath, isModuleScript) {
    // Module scripts must not be marked or routed through a reserved path
    // segment. GitHub and other modern applications build additional chunk
    // URLs from module URLs; inserting /__pxmod__/ into those URLs makes the
    // derived paths invalid and breaks dynamic imports. A normal proxied URL
    // is sufficient now that external JavaScript bodies are no longer wrapped.
    (void isModuleScript);
    return changeURL(relativePath);
}

//=== Network layer: fetch / XHR / WebSocket / SSE / Worker / sendBeacon all rewritten =======
function networkInject() {
    var originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        var args = Array.prototype.slice.call(arguments);
        args[1] = changeURL(url);
        return originalOpen.apply(this, args);
    };

    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
        if (typeof input === "string") {
            return originalFetch(changeURL(input), init);
        } else if (input instanceof Request) {
            // Rebuild the init dict explicitly (rather than just passing "input" straight through
            // the way a simpler version of this code might) so we can reliably add
            // duplex:"half" when there's a body. Chrome (and the Fetch spec generally) requires
            // that whenever a Request carries a streamed body -- same underlying rule as the
            // server-side fix in this proxy's Worker code; see that comment for the full story.
            // duplex must be left out entirely for bodyless requests (GET/HEAD).
            var newInit = {
                method: input.method, headers: input.headers, mode: input.mode,
                credentials: input.credentials, cache: input.cache, redirect: input.redirect,
                referrer: input.referrer, referrerPolicy: input.referrerPolicy,
                integrity: input.integrity, keepalive: input.keepalive, signal: input.signal,
                body: input.body,
            };
            if (input.body) newInit.duplex = "half";
            var newRequest = new Request(changeURL(input.url), newInit);
            return originalFetch(newRequest, init);
        }
        return originalFetch(input, init);
    };

    if (navigator.sendBeacon) {
        var originalBeacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = function (url, data) { return originalBeacon(changeURL(url), data); };
    }

    if (window.EventSource) {
        var OriginalEventSource = window.EventSource;
        window.EventSource = function (url, config) { return new OriginalEventSource(changeURL(url), config); };
        window.EventSource.prototype = OriginalEventSource.prototype;
    }

    if (window.Worker) {
        var OriginalWorker = window.Worker;
        window.Worker = function (url, options) { return new OriginalWorker(changeURL(url), options); };
        window.Worker.prototype = OriginalWorker.prototype;
    }

    if (window.WebSocket) {
        var OriginalWebSocket = window.WebSocket;
        window.WebSocket = function (url, protocols) {
            var targetUrl = changeURL(url);
            targetUrl = targetUrl.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
            return (protocols !== undefined) ? new OriginalWebSocket(targetUrl, protocols) : new OriginalWebSocket(targetUrl);
        };
        window.WebSocket.prototype = OriginalWebSocket.prototype;
    }

    // Service Workers run on their own thread and can intercept any request on their own terms —
    // that is fundamentally incompatible with URL-rewriting proxies like this one, so registration
    // is disabled outright instead of silently misbehaving (half-working SW is worse than none).
    if (navigator.serviceWorker && navigator.serviceWorker.register) {
        try {
            navigator.serviceWorker.register = function () {
                return Promise.reject(new DOMException("Service workers are disabled by this proxy", "NotSupportedError"));
            };
        } catch (e) { /* ignore */ }
    }

    console.log("NETWORK LAYER INJECTED");
}

//=== window.open ============================================================================
function windowOpenInject() {
    var originalOpen = window.open;
    window.open = function (url, name, specs) {
        return originalOpen.call(window, (url == null ? url : changeURL(url)), name, specs);
    };
    console.log("WINDOW.OPEN INJECTED");
}

//=== Anchor navigation guard ================================================================
// Element IDL/attribute patches intentionally *report* original URLs back to page
// scripts (many apps compare hrefs, build selectors from them, or send them to
// their own APIs). That creates a subtle trap for ordinary <a> navigation: by
// the time the browser performs the default action, it uses the element's
// underlying href state, and a script may have re-set that state from the
// de-proxied value it read earlier (or created the node in a realm/order where
// the attribute writer was missed). The result is a click that leaves the
// proxy and lands on the origin site even though every fetch/XHR/media URL was
// correctly proxied.
//
// Install a capture-phase document click handler as the last-resort invariant:
// for a normal, unmodified primary-button click on an anchor (or a descendant
// of one), resolve the destination the page *intends* (prefer the IDL href the
// site's own handlers see), translate it with changeURL(), and navigate the
// top frame there ourselves. We deliberately:
//   - run in the capture phase and stopPropagation/preventDefault only when we
//     are about to perform the navigation ourselves;
//   - ignore modified clicks, non-primary buttons, download links, explicit
//     non-_self targets, javascript:/data:/blob:/mailto: style hrefs, and pure
//     same-page fragment jumps (letting tabs/accordions keep working);
//   - leave clicks that page handlers already cancelled (defaultPrevented by
//     the time capture listeners on document have run in bubble order is not
//     observable here, so we only take over plain left clicks with no modifier
//     keys -- the exact case that otherwise escapes the proxy).
function anchorNavigationInject() {
    document.addEventListener("click", function (event) {
        try {
            if (!event || event.button !== 0) return;
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            var node = event.target;
            var anchor = null;
            while (node && node !== document) {
                if (node.tagName === "A") { anchor = node; break; }
                node = node.parentNode || (node.getRootNode && node.getRootNode().host) || null;
            }
            if (!anchor) return;
            var targetAttr = (anchor.getAttribute("target") || "").toLowerCase();
            if (targetAttr && targetAttr !== "_self") return;
            if (anchor.hasAttribute("download")) return;
            var intended = anchor.href || anchor.getAttribute("href") || "";
            if (!intended) return;
            if (/^(javascript|data|blob|mailto|tel|sms|about):/i.test(intended)) return;
            // Pure in-page fragment navigation must not be proxied away.
            var rawAttr = anchor.getAttribute("href") || "";
            if (rawAttr.charAt(0) === "#") return;
            var proxied = changeURL(intended);
            if (!proxied || typeof proxied !== "string") return;
            // Only intercept when the destination would otherwise leave the
            // proxy origin (or points at the origin site directly). If it is
            // already a proxy URL, let the default action proceed untouched so
            // middle-click semantics, handlers, and SPA routers behave as-is.
            var dest;
            try { dest = new URL(proxied, window.location.href); } catch (e) { return; }
            if (dest.origin !== window.location.origin) return;
            if (anchor.href === proxied) return; // already exactly right
            event.preventDefault();
            event.stopPropagation();
            window.location.assign(proxied);
        } catch (e) { /* never let the guard break a page's own click handling */ }
    }, true);
    console.log("ANCHOR NAVIGATION GUARD INJECTED");
}

//=== DOM insertion hooks (appendChild/insertBefore/append/...) catch nodes created purely ===
//=== in JS (not through attribute parsing) before they are attached to the document =========
function domInsertionInject() {
    function fixNode(node) {
        try {
            if (node && node.nodeType === 1) {
                // Transformed CAPTCHA/runtime responses no longer match the
                // origin's SRI digest; remove it synchronously before append.
                removeIntegrityAttributesFromElement(node);
                if (node.hasAttribute && node.hasAttribute("src")) node.setAttribute("src", node.getAttribute("src"));
                if (node.hasAttribute && node.hasAttribute("href")) node.setAttribute("href", node.getAttribute("href"));
                // A subtree cloned out of a <template> (or any pre-built fragment handed
                // to appendChild wholesale) carries its media URLs on DESCENDANT nodes --
                // fixing only the inserted root left e.g. a cloned <video> pointing at
                // the raw CDN, and the browser starts fetching it inside the very same
                // appendChild call, long before the MutationObserver can repair it.
                // Walk the inserted subtree with the same per-element rewrite used
                // everywhere else; re-setting an already-proxied URL is a no-op (the
                // IDL/attribute patches de-proxy on read), so this is idempotent.
                if (node.querySelectorAll) {
                    var __desc = node.querySelectorAll("[src],[href],[poster],[srcset],[integrity]");
                    for (var __di = 0; __di < __desc.length; __di++) processElement(__desc[__di]);
                }
                if (node.tagName === "TEMPLATE" && node.content) {
                    var __tpl = node.content.querySelectorAll("*");
                    for (var __tj = 0; __tj < __tpl.length; __tj++) processElement(__tpl[__tj]);
                }
            }
        } catch (e) { /* ignore */ }
    }
    [[Node.prototype, "appendChild"], [Node.prototype, "insertBefore"], [Node.prototype, "replaceChild"]].forEach(function (pair) {
        var proto = pair[0], name = pair[1];
        var orig = proto[name];
        proto[name] = function () {
            fixNode(arguments[0]);
            return orig.apply(this, arguments);
        };
    });
    ["append", "prepend", "before", "after"].forEach(function (name) {
        if (!Element.prototype[name]) return;
        var orig = Element.prototype[name];
        Element.prototype[name] = function () {
            for (var i = 0; i < arguments.length; i++) {
                if (arguments[i] instanceof Node) fixNode(arguments[i]);
            }
            return orig.apply(this, arguments);
        };
    });

    // innerHTML/outerHTML/insertAdjacentHTML hand the browser's HTML PARSER a raw markup
    // string directly -- unlike appendChild/etc. above (which receive already-built Node
    // objects this file's other patches already touched), the parser here creates brand-new
    // elements from that string and starts fetching their src/href-ish resources IMMEDIATELY,
    // before any later MutationObserver-based rewrite pass gets a chance to run. Confirmed root
    // cause of a real, live leak: Pornhub builds its related-video <video> tags via an innerHTML
    // assignment, so the very first parse already fires a request for the real, un-proxied CDN
    // URL -- the exact "a few request URLs didn't go through the proxy" symptom reported in
    // DevTools' Network tab. Fix: parse the markup into a detached <template> first (using the
    // ORIGINAL, unpatched innerHTML setter so this doesn't recurse into itself), run the same
    // per-element URL rewrite (covToAbs) used everywhere else in this file against it, then
    // only hand the ALREADY-rewritten markup to the real parser.
    var originalInnerHTMLDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    var originalOuterHTMLDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "outerHTML");

    function rewriteHtmlFragment(htmlString) {
        if (htmlString == null || htmlString === "") return htmlString;
        try {
            var tpl = document.createElement("template");
            originalInnerHTMLDescriptor.set.call(tpl, String(htmlString));
            var all = tpl.content.querySelectorAll("*");
            all.forEach(function (el) { processElement(el); });
            return originalInnerHTMLDescriptor.get.call(tpl);
        } catch (e) {
            return htmlString;
        }
    }

    // CRITICAL: a <script> (or <style>) element's .innerHTML/.outerHTML setter does NOT take
    // HTML markup to be parsed as child elements -- it takes plain raw TEXT (that's the whole
    // point of "raw text elements": the browser's tokenizer intentionally stops looking for
    // tags inside them). Real, live, minified ad-widget code does exactly this -- confirmed on
    // Pornhub's own homepage "hover-to-preview" video widget (trafficjunky's embeddedads
    // bundle): it builds a <script> element and does scriptEl.innerHTML = rawJsSourceCode,
    // where rawJsSourceCode is literal JS containing arrow functions ("=>") and "&&". Running
    // that raw JS text through rewriteHtmlFragment's <template>-based rewrite is wrong: a
    // <template>'s content fragment is NOT a raw-text context, so parsing "=> " / "&&" into it
    // stores them as a normal text node, and serializing that text node back out via
    // .innerHTML *correctly, per the HTML spec's own escaping rules for non-raw-text parents*
    // re-escapes it to "=&gt;" / "&amp;&amp;" -- permanently corrupting the script into a
    // SyntaxError ("Unexpected token ')'" confirmed live) the instant the browser actually
    // parses that <script>'s real raw-text content. That single corrupted widget script is what
    // broke the hover-preview-play feature across every site using this same widget pattern.
    // Fix: skip the HTML-fragment rewrite entirely for SCRIPT/STYLE elements -- their
    // innerHTML/outerHTML content is text, not child markup, so there is nothing for
    // covToAbs()'s per-element attribute walk to find in it anyway. (A <style> element's text
    // CAN contain url(...) that ought to be proxied, but naively re-escaping it the same way
    // would equally corrupt CSS containing a bare ">" or "&"; rewriting style text safely would
    // need a dedicated CSS-text pass -- e.g. the same replaceContentPaths() used elsewhere --
    // not the markup-rewrite path used here, so we deliberately leave it alone rather than risk
    // another entity-escaping corruption.)
    function isRawTextElement(el) {
        var t = el && el.tagName;
        return t === "SCRIPT" || t === "STYLE";
    }

    if (originalInnerHTMLDescriptor && originalInnerHTMLDescriptor.set) {
        Object.defineProperty(Element.prototype, "innerHTML", {
            get: originalInnerHTMLDescriptor.get,
            set: function (val) {
                var rewritten = isRawTextElement(this) ? val : rewriteHtmlFragment(val);
                originalInnerHTMLDescriptor.set.call(this, rewritten);
            },
            configurable: true,
        });
    }
    if (originalOuterHTMLDescriptor && originalOuterHTMLDescriptor.set) {
        Object.defineProperty(Element.prototype, "outerHTML", {
            get: originalOuterHTMLDescriptor.get,
            set: function (val) {
                // outerHTML replaces the element itself -- it being SCRIPT/STYLE means the
                // replacement markup is still ordinary HTML (it can be ANY tag, not necessarily
                // another script/style), so unlike innerHTML above we can't skip based on the
                // CURRENT tag. There is no real-world case for a script/style tag's raw JS/CSS
                // text being handed to outerHTML (outerHTML always parses full markup, by spec,
                // even for these tags), so the template-based rewrite is correct here as-is.
                originalOuterHTMLDescriptor.set.call(this, rewriteHtmlFragment(val));
            },
            configurable: true,
        });
    }
    if (Element.prototype.insertAdjacentHTML) {
        var originalInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
        Element.prototype.insertAdjacentHTML = function (position, text) {
            // Same raw-text reasoning as innerHTML above: insertAdjacentHTML parses the text
            // argument as markup in the context of this element's parent -- a
            // script/style element is never a valid insertion point for this API's HTML parsing
            // the way innerHTML is on the element itself -- but guard defensively anyway since
            // some polyfills/frameworks call it on script-like custom elements.
            var rewritten = isRawTextElement(this) ? text : rewriteHtmlFragment(text);
            return originalInsertAdjacentHTML.call(this, position, rewritten);
        };
    }

    console.log("DOM INSERTION HOOKS INJECTED");
}

//=== src / href / action / formaction / poster / data — get/setAttribute + IDL properties ===
function elementPropertyInject() {
    var urlAttrsAnyTag = ["src", "href"];
    var urlAttrsByTag = { FORM: ["action"], BUTTON: ["formaction"], INPUT: ["formaction"], OBJECT: ["data"], VIDEO: ["poster"] };

    function isUrlAttr(tagName, name) {
        name = String(name).toLowerCase();
        if (urlAttrsAnyTag.indexOf(name) !== -1) return true;
        var list = urlAttrsByTag[tagName];
        return !!(list && list.indexOf(name) !== -1);
    }

    var originalGetAttribute = HTMLElement.prototype.getAttribute;
    HTMLElement.prototype.getAttribute = function (name) {
        var val = originalGetAttribute.call(this, name);
        var lowerName = String(name).toLowerCase();
        if (this.tagName === "SCRIPT" && lowerName === "src" && val != null) {
            // Script runtimes use getAttribute("src") as an identifier, not
            // merely as a network URL. Preserve the exact value the page set
            // (relative, root-relative, or absolute) while the browser-facing
            // src remains the proxied URL. Turbopack, for example, keys the
            // promise for "/_next/chunk.js" by that literal string; returning
            // an absolute de-proxied URL creates a different key, so every
            // chunk downloads successfully but hydration waits forever.
            var scriptSrcView;
            if (SCRIPT_SRC_VIEWS.has(this)) {
                scriptSrcView = SCRIPT_SRC_VIEWS.get(this);
            } else {
                scriptSrcView = originalGetAttribute.call(this, SCRIPT_SRC_VIEW_ATTR);
                if (scriptSrcView != null) SCRIPT_SRC_VIEWS.set(this, scriptSrcView);
            }
            // The attribute is only a bridge across detached-DOM serialization;
            // keep the exact view in memory once this is the live element.
            if (originalGetAttribute.call(this, SCRIPT_SRC_VIEW_ATTR) != null) {
                rawRemoveAttr.call(this, SCRIPT_SRC_VIEW_ATTR);
            }
            if (scriptSrcView != null) return scriptSrcView;
        }
        if (isUrlAttr(this.tagName, lowerName)) return getOriginalUrl(val);
        return val;
    };

    var originalSetAttribute = HTMLElement.prototype.setAttribute;
    HTMLElement.prototype.setAttribute = function (name, value) {
        var lowerName = String(name).toLowerCase();
        if (this.tagName === "IFRAME" && lowerName === "srcdoc") {
            // See the big comment on rewriteSrcdocHtml's declaration: an iframe's srcdoc is an
            // entire inline HTML document, not a URL, so it needs its own dedicated rewrite
            // pass rather than the plain changeURL() used for ordinary URL attributes below.
            value = rewriteSrcdocHtml(value);
        } else if (isUrlAttr(this.tagName, lowerName)) {
            // <script src> needs both URL routing and an exact semantic view of
            // the value the page assigned. Store that view with a private
            // attribute before replacing the browser-facing src.
            if (this.tagName === "SCRIPT" && lowerName === "src") {
                SCRIPT_SRC_VIEWS.set(this, String(value));
                originalSetAttribute.call(this, SCRIPT_SRC_VIEW_ATTR, String(value));
                var __isMod = (originalGetAttribute.call(this, "type") || "").toLowerCase().trim() === "module";
                value = changeURLForScript(value, __isMod);
            } else {
                value = changeURL(value);
            }
        }
        return originalSetAttribute.call(this, name, value);
    };

    console.log("ELEMENT GET/SET ATTRIBUTE INJECTED");

    var setList = [
        [window.HTMLAnchorElement, "href"], [window.HTMLScriptElement, "src"], [window.HTMLImageElement, "src"],
        // NOTE: HTMLLinkElement/href is deliberately NOT in this list -- it is patched
        // separately right below (its IDL getter must report the browser-true URL, see the
        // comment there). If it were patched here too, the separate patch would capture
        // this already-patched descriptor instead of the native one and silently undo
        // itself (its "native" getter would actually be this de-proxying getter).
        [window.HTMLIFrameElement, "src"], [window.HTMLVideoElement, "src"],
        [window.HTMLAudioElement, "src"], [window.HTMLSourceElement, "src"], [window.HTMLObjectElement, "data"],
        [window.HTMLFormElement, "action"], [window.HTMLEmbedElement, "src"], [window.HTMLTrackElement, "src"],
    ];

    for (var i = 0; i < setList.length; i++) {
        var whichElement = setList[i][0];
        var whichProperty = setList[i][1];
        if (!whichElement || !whichElement.prototype) continue;
        // The descriptor is NOT always an own property of the subclass prototype:
        // HTMLVideoElement.src / HTMLAudioElement.src live on HTMLMediaElement.prototype.
        // Reading only the own descriptor makes this loop silently skip <video> and
        // <audio> -- their IDL setter then stays 100% native, so every
        // 'video.src = "https://cdn..."' set by a player/ad script escapes the proxy and
        // goes straight to the real CDN (confirmed live: cdn.banhq.com/*.mp4 requests that
        // were never rewritten). The network/DOM hooks cannot save that case: the browser
        // media loader fetches the raw attribute the native setter wrote. Walk the
        // prototype chain to find the real descriptor, and define the patch on the
        // element's own prototype (shadowing the inherited accessor) so subclass and
        // base-class elements share it.
        var descriptor = null;
        var __protoCursor = whichElement.prototype;
        while (__protoCursor && !descriptor) {
            descriptor = Object.getOwnPropertyDescriptor(__protoCursor, whichProperty);
            if (!descriptor) __protoCursor = Object.getPrototypeOf(__protoCursor);
        }
        if (!descriptor || !descriptor.get || !descriptor.set) continue;

        (function (descriptor, isScriptSrc) {
            Object.defineProperty(whichElement.prototype, whichProperty, {
                get: function () { return getOriginalUrl(descriptor.get.call(this)); },
                set: function (val) {
                    if (isScriptSrc) {
                        // IDL assignment (script.src = value) bypasses the
                        // patched setAttribute above, so preserve its exact
                        // getAttribute view here as well.
                        SCRIPT_SRC_VIEWS.set(this, String(val));
                        originalSetAttribute.call(this, SCRIPT_SRC_VIEW_ATTR, String(val));
                        var __isMod = (this.getAttribute("type") || "").toLowerCase().trim() === "module";
                        descriptor.set.call(this, changeURLForScript(val, __isMod));
                    } else {
                        descriptor.set.call(this, changeURL(val));
                    }
                },
                configurable: true,
            });
        })(descriptor, whichElement === window.HTMLScriptElement && whichProperty === "src");
    }

    // <link> IDL .href is returned AS-IS (unlike the other URL IDL properties above, which
    // are de-proxied through getOriginalUrl). Some players -- Pornhub's MGP player is the
    // confirmed case -- locate their own external stylesheet in the live DOM via
    // document.querySelector('link[href*="<name>-player"][href*=".css"]') and then match it
    // against document.styleSheets with sheet.href === link.href. document.styleSheets
    // always reports the URL the browser really fetched (the PROXIED URL), so if .href is
    // de-proxied here the strict-equality mirror check can never match, the player logs
    // "External CSS failed to load or parse", its template/CSS state machine goes FAILED,
    // and on first-visit / no-cache loads the player stalls on its gray pre-init box and
    // never starts playback. Setting still goes through changeURL() as usual; only the
    // getter reports the browser-true (proxied) href, mirroring what CSSStyleSheet.href
    // already reports. The attribute-side getter (getAttribute) above is deliberately left
    // de-proxied -- only this IDL pair is used by the mirror-check pattern.
    var linkHrefDescriptor = window.HTMLLinkElement && Object.getOwnPropertyDescriptor(window.HTMLLinkElement.prototype, "href");
    if (linkHrefDescriptor && linkHrefDescriptor.get && linkHrefDescriptor.set) {
        Object.defineProperty(window.HTMLLinkElement.prototype, "href", {
            get: function () { return linkHrefDescriptor.get.call(this); },
            set: function (val) { linkHrefDescriptor.set.call(this, changeURL(val)); },
            configurable: true,
        });
    }

    // Patch HTMLMediaElement.src itself as well: players frequently hold a generic
    // HTMLMediaElement reference (or feature-test the base class) and some set .src
    // through it; the subclass shadow above is the common path, this is the belt to
    // its suspenders. Same accessor semantics: de-proxied read, changeURL() write.
    if (window.HTMLMediaElement && window.HTMLMediaElement.prototype) {
        var mediaDescriptor = Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, "src");
        if (mediaDescriptor && mediaDescriptor.get && mediaDescriptor.set) {
            Object.defineProperty(window.HTMLMediaElement.prototype, "src", {
                get: function () { return getOriginalUrl(mediaDescriptor.get.call(this)); },
                set: function (val) { mediaDescriptor.set.call(this, changeURL(val)); },
                configurable: true,
            });
        }
    }

    // srcdoc is an inline HTML document, not a URL -- see the big comment on
    // rewriteSrcdocHtml's declaration for why it needs its own dedicated pass.
    var srcdocDescriptor = window.HTMLIFrameElement && Object.getOwnPropertyDescriptor(window.HTMLIFrameElement.prototype, "srcdoc");
    if (srcdocDescriptor && srcdocDescriptor.get && srcdocDescriptor.set) {
        Object.defineProperty(window.HTMLIFrameElement.prototype, "srcdoc", {
            get: function () { return srcdocDescriptor.get.call(this); },
            set: function (val) { srcdocDescriptor.set.call(this, rewriteSrcdocHtml(val)); },
            configurable: true,
        });
    }

    console.log("ELEMENT IDL PROPERTY (src/href/...) INJECTED");
}

//=== A drop-in replacement object for window.location that always talks in terms of the =====
//=== REAL (original) site's URL, while still actually navigating the real browser location ==
function ProxyLocation(originalLocation) {
    this.originalLocation = originalLocation;
}
ProxyLocation.prototype.reload = function (forcedReload) { this.originalLocation.reload(forcedReload); };
ProxyLocation.prototype.replace = function (url) { this.originalLocation.replace(changeURL(url)); };
ProxyLocation.prototype.assign = function (url) { this.originalLocation.assign(changeURL(url)); };
ProxyLocation.prototype.toString = function () { return original_website_url_str; };
Object.defineProperties(ProxyLocation.prototype, {
    href: {
        get: function () { return original_website_url_str; },
        set: function (url) { this.originalLocation.href = changeURL(url); },
    },
    protocol: {
        get: function () { return original_website_url.protocol; },
        set: function (value) { var u = original_website_url; u.protocol = value; this.originalLocation.href = proxy_host_with_schema + u.href; },
    },
    host: {
        get: function () { return original_website_url.host; },
        set: function (value) { var u = original_website_url; u.host = value; this.originalLocation.href = proxy_host_with_schema + u.href; },
    },
    hostname: {
        get: function () { return original_website_url.hostname; },
        set: function (value) { var u = original_website_url; u.hostname = value; this.originalLocation.href = proxy_host_with_schema + u.href; },
    },
    port: {
        get: function () { return original_website_url.port; },
        set: function (value) { var u = original_website_url; u.port = value; this.originalLocation.href = proxy_host_with_schema + u.href; },
    },
    pathname: {
        get: function () { return original_website_url.pathname; },
        set: function (value) { var u = original_website_url; u.pathname = value; this.originalLocation.href = proxy_host_with_schema + u.href; },
    },
    search: {
        get: function () { return original_website_url.search; },
        set: function (value) { var u = original_website_url; u.search = value; this.originalLocation.href = proxy_host_with_schema + u.href; },
    },
    hash: {
        get: function () { return original_website_url.hash; },
        set: function (value) { var u = original_website_url; u.hash = value; this.originalLocation.href = proxy_host_with_schema + u.href; },
    },
    origin: { get: function () { return original_website_url.origin; } },
});

function documentLocationInject() {
    Object.defineProperty(document, "URL", {
        get: function () { return original_website_url_str; },
        configurable: true,
    });
    try {
        Object.defineProperty(document, "domain", {
            get: function () { return original_website_host; },
            set: function () { /* no-op: cross-domain document.domain assignment can't really work here */ },
            configurable: true,
        });
    } catch (e) { /* some browsers may not allow redefining document.domain, ignore */ }
    try {
        Object.defineProperty(document, "referrer", {
            get: function () {
                var r = Object.getOwnPropertyDescriptor(Document.prototype, "referrer").get.call(document);
                return getOriginalUrl(r) || r;
            },
            configurable: true,
        });
    } catch (e) { /* ignore */ }

    Object.defineProperty(document, "${REPLACE_LOCATION_OBJ_NAME}", {
        get: function () { return new ProxyLocation(window.location); },
        set: function (url) { window.location.href = changeURL(url); },
        configurable: true,
    });
    console.log("DOCUMENT LOCATION/DOMAIN/REFERRER INJECTED");
}

function windowLocationInject() {
    Object.defineProperty(window, "${REPLACE_LOCATION_OBJ_NAME}", {
        get: function () { return new ProxyLocation(window.location); },
        set: function (url) { window.location.href = changeURL(url); },
        configurable: true,
    });
    console.log("WINDOW LOCATION INJECTED");
}

function safeFallbackLocationInject() {
    // Intentionally a no-op. The previous version installed an accessor on
    // Object.prototype, which mutated every ordinary object in the page and
    // could poison property lookups, serialization, and framework internals.
    // A public proxy should never add enumerable or inherited accessors to
    // Object.prototype; window/document-specific location shims are sufficient.
    console.log("OBJECT PROTOTYPE LEFT UNTOUCHED");
}

//=== history.pushState / replaceState need the same original<->proxy URL translation ========
function historyInject() {
    var originalPushState = History.prototype.pushState;
    var originalReplaceState = History.prototype.replaceState;

    function normalize(url) {
        if (!url) return url;
        var url_str = url.toString();
        var ow = original_website_url.href;
        var owNoSlash = ow.substring(0, ow.length - 1);
        if (url_str.startsWith("/" + ow)) url_str = url_str.substring(("/" + ow).length);
        else if (url_str.startsWith("/" + owNoSlash)) url_str = url_str.substring(("/" + owNoSlash).length);
        var owColonSlash = ow.replace("://", ":/");
        var owNoSlashColonSlash = owNoSlash.replace("://", ":/");
        if (url_str.startsWith("/" + owColonSlash)) url_str = url_str.substring(("/" + owColonSlash).length);
        else if (url_str.startsWith("/" + owNoSlashColonSlash)) url_str = url_str.substring(("/" + owNoSlashColonSlash).length);
        return url_str;
    }

    function routeHistoryValues(url) {
        var normalized = normalize(url);
        var proxied = changeURL(normalized);
        var original = new URL(normalized, original_website_url_str);
        return { proxied: proxied, virtual: original.pathname + original.search + original.hash };
    }
    function restoreProxiedUrl(historyObject, proxied) {
        var restore = function () {
            try { __pxNativeHistoryReplaceState.call(historyObject, historyObject.state, "", proxied); } catch (e) { /* ignore */ }
        };
        if (typeof queueMicrotask === "function") queueMicrotask(restore);
        else Promise.resolve().then(restore);
    }

    History.prototype.pushState = function (state, title, url) {
        if (__pxRouteBootActive) return originalReplaceState.call(this, state, title, __pxRouteVirtualPath);
        if (!url) return originalPushState.call(this, state, title, url);
        if (__pxRouteModeEnabled) {
            try {
                var values = routeHistoryValues(url);
                var result = originalPushState.call(this, state, title, values.virtual);
                restoreProxiedUrl(this, values.proxied);
                return result;
            } catch (e) { /* use normal proxy translation */ }
        }
        return originalPushState.call(this, state, title, changeURL(normalize(url)));
    };
    History.prototype.replaceState = function (state, title, url) {
        if (__pxRouteBootActive) return originalReplaceState.call(this, state, title, __pxRouteVirtualPath);
        if (!url) return originalReplaceState.call(this, state, title, url);
        if (__pxRouteModeEnabled) {
            try {
                var values = routeHistoryValues(url);
                var result = originalReplaceState.call(this, state, title, values.virtual);
                restoreProxiedUrl(this, values.proxied);
                return result;
            } catch (e) { /* use normal proxy translation */ }
        }
        return originalReplaceState.call(this, state, title, changeURL(normalize(url)));
    };

    window.addEventListener("popstate", function () {
        if (!__pxRouteModeEnabled || __pxRouteBootActive) return;
        try {
            var full = window.location.href;
            if (full.indexOf(proxy_host_with_schema) !== 0) return;
            var embedded = full.substring(proxy_host_with_schema.length);
            if (!/^https?:\\/\\//i.test(embedded)) return;
            var original = new URL(embedded);
            __pxNativeHistoryReplaceState.call(window.history, window.history.state, "", original.pathname + original.search + original.hash);
            restoreProxiedUrl(window.history, full);
        } catch (e) { /* ignore */ }
    }, true);
    console.log("HISTORY INJECTED");
}

//=== document.cookie: per-site namespacing + strip any explicit Domain= that would make the =
//=== browser silently reject the cookie (its Domain would point at the real site, not here) =
function cookieInject() {
    var descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    if (!descriptor) return;

    Object.defineProperty(document, "cookie", {
        configurable: true,
        get: function () {
            var raw = descriptor.get.call(document);
            if (!raw) return "";
            var prefix = sitePrefix(original_website_host);
            return raw.split(";")
                .map(function (s) { return s.trim(); })
                .filter(function (s) { return s.indexOf(prefix) === 0; })
                .map(function (s) { return s.substring(prefix.length); })
                .join("; ");
        },
        set: function (val) {
            try {
                var prefix = sitePrefix(original_website_host);
                var parts = String(val).split(";").map(function (s) { return s.trim(); });
                var nameVal = parts.shift();
                var eqIdx = nameVal.indexOf("=");
                if (eqIdx === -1) return;
                var name = nameVal.substring(0, eqIdx);
                var value = nameVal.substring(eqIdx + 1);

                var rest = [];
                parts.forEach(function (p) {
                    var lower = p.toLowerCase();
                    if (lower.indexOf("domain=") === 0) return;   // real site's domain would never match here
                    if (lower.indexOf("path=") === 0) return;      // always normalize path to "/" below
                    rest.push(p);
                });
                rest.push("path=/");

                descriptor.set.call(document, prefix + name + "=" + value + "; " + rest.join("; "));
            } catch (e) {
                console.log("cookie set error: " + e.message);
            }
        },
    });
    console.log("DOCUMENT.COOKIE INJECTED");
}

//=== localStorage / sessionStorage isolation per proxied site ===============================
function storageInject() {
    ["localStorage", "sessionStorage"].forEach(function (storageName) {
        var realStorage = window[storageName];
        var prefix = function () { return sitePrefix(original_website_host); };

        var storageProxy = new Proxy(realStorage, {
            get: function (target, prop) {
                if (prop === "getItem") return function (key) { return target.getItem(prefix() + key); };
                if (prop === "setItem") return function (key, val) { return target.setItem(prefix() + key, val); };
                if (prop === "removeItem") return function (key) { return target.removeItem(prefix() + key); };
                if (prop === "clear") return function () {
                    Object.keys(target).forEach(function (k) { if (k.indexOf(prefix()) === 0) target.removeItem(k); });
                };
                if (prop === "key") return function (i) {
                    var keys = Object.keys(target).filter(function (k) { return k.indexOf(prefix()) === 0; });
                    var k = keys[i];
                    return k === undefined ? null : k.substring(prefix().length);
                };
                if (prop === "length") {
                    return Object.keys(target).filter(function (k) { return k.indexOf(prefix()) === 0; }).length;
                }
                if (typeof target[prop] === "function") return target[prop].bind(target);
                var v = target.getItem(prefix() + String(prop));
                return v === null ? undefined : v;
            },
            set: function (target, prop, value) {
                target.setItem(prefix() + String(prop), value);
                return true;
            },
            has: function (target, prop) {
                return target.getItem(prefix() + String(prop)) !== null;
            },
            deleteProperty: function (target, prop) {
                target.removeItem(prefix() + String(prop));
                return true;
            },
        });

        try {
            Object.defineProperty(window, storageName, { get: function () { return storageProxy; }, configurable: true });
        } catch (e) { /* ignore if the browser refuses to redefine it */ }
    });
    console.log("STORAGE ISOLATION INJECTED");
}

//=== Sandbox scope for inline <script> / eval() / new Function() code =======================
//=== Lets plain identifiers "window" / "location" / "document" used inside such code ========
//=== resolve to proxy-aware fakes, via a "with(scope){ CODE }" trick =========================

// A JS quirk that matters a lot here: a bare identifier call resolved through a "with"
// statement's scope object -- e.g. "with(scopeObj){ foo() }" where foo is a property of
// scopeObj -- implicitly sets "this" to scopeObj itself for that call, NOT to the global
// object, even though a plain unqualified "foo()" outside any with() would set this=window.
// That breaks any global function whose Web IDL implementation branding-checks "this"
// (confirmed empirically: setTimeout throws "Illegal invocation" when its "this" ends up being
// an arbitrary scope object instead of a real Window -- fetch/btoa/Array.isArray/etc. happen
// not to care, but plenty of other APIs do), so plain methods like setTimeout/fetch/alert/
// addEventListener/getComputedStyle/btoa/atob/scrollTo/requestAnimationFrame/postMessage/
// matchMedia/open need to be re-bound to the real window before being handed back.
//
// But built-in CONSTRUCTORS/namespaces -- Array, Object, Promise, Number, RegExp, Map, Set,
// Function, Error, URL, Headers, Response, and so on -- are *also* typeof "function", yet
// Function.prototype.bind() does NOT copy a function's own static properties onto the bound
// wrapper it creates. Blindly binding those the same way silently strips every static method
// (Array.isArray, Object.defineProperty, Promise.resolve, URL.createObjectURL, ...), breaking
// an enormous share of ordinary JS that calls them. The web platform's naming convention is
// consistent enough to lean on here: constructors/namespaces are always capitalized
// (PascalCase), plain functions/methods never are -- so bind only the lowercase-named ones.
function bindOnlyIfPlainMethod(val, prop, bindTarget) {
    if (typeof val !== "function") return val;
    if (/^[A-Z]/.test(String(prop))) return val; // constructor/namespace -- never bind
    // "eval" must NEVER be bound, even though it's a lowercase plain-looking global function.
    // Confirmed root cause of a real, serious bug: a bound function is -- by spec -- never
    // eligible for "direct eval" treatment, even when its bound target is the real %eval%
    // intrinsic. So the instant a bare "eval" reference inside with()-sandboxed code resolves
    // to eval.bind(window) (which this same rebinding heuristic would otherwise produce, since
    // "eval" is lowercase like any ordinary method), every eval(x) call site in that code
    // silently becomes an *indirect* eval -- running in the global scope instead of the
    // caller's local scope -- so any evaluated string that references a local/closure variable
    // throws "ReferenceError: <name> is not defined". Confirmed live on Pornhub: its
    // networkbar-6.0.0.js runs eval(scope-expression) where "scope" is a local
    // variable of the enclosing function (verified present and correct immediately before the
    // eval() call) -- yet the eval() itself throws "scope is not defined", purely because this
    // rebinding handed it a bound copy of eval. Returning the real, unbound window.eval here
    // preserves correct direct-eval semantics for all with()-sandboxed code.
    if (prop === "eval") return val;
    // Confirmed root cause of a second, even more widely damaging bug: Function.prototype.bind()
    // returns a brand-new "bound function exotic object" that -- by spec -- carries over NONE of
    // the original function's own custom properties, only its length/name. That silently
    // destroys the extremely common "function-as-namespace" pattern (a callable function that
    // also has methods hung directly off of it, e.g. a head.js-style loader where the global
    // called head is itself a function AND has head.ready / head.load attached as extra
    // properties, jQuery's dollar-sign object and its .ajax, etc).
    // Confirmed live on Pornhub: its own inline bootstrap defines exactly such a head function
    // and later calls head.ready(...) -- but since the bare identifier head is read from
    // inside with()-sandboxed code, it resolved through this same rebinding path, got
    // bound via .bind(), and came back as a function with NO .ready/.load on it at all, throwing
    // "head.ready is not a function" and aborting the whole script-loading chain the video
    // player depends on -- which is why the player area stayed blank/gray with nothing ever
    // loading, even though every individual network request succeeded. A Proxy that only
    // intercepts the call itself (the apply trap, to supply the correct this value) while
    // leaving every property get/set/call-through default to the real target function preserves
    // BOTH the correct this-binding native APIs need AND every property/method a page's own
    // code attached to the function -- .bind() can only ever give you one or the other.
    return new Proxy(val, {
        apply: function (target, thisArgIgnored, args) {
            return Reflect.apply(target, bindTarget, args);
        },
    });
}

function createModernSandbox() {
    var fakeLocation = new ProxyLocation(window.location);

    var fakeWindow = new Proxy(window, {
        get: function (target, prop) {
            if (prop === "location") return fakeLocation;
            if (prop === "window" || prop === "self" || prop === "globalThis" || prop === "top" || prop === "parent" || prop === "frames") {
                return fakeWindow;
            }
            var val = target[prop];
            return bindOnlyIfPlainMethod(val, prop, target);
        },
        set: function (target, prop, value) {
            if (prop === "location") { fakeLocation.href = value; return true; }
            target[prop] = value;
            return true;
        },
    });

    // NOT currently wired into window.__proxy_scope below (see the comment there) -- kept only
    // because other code may still reference it. A Proxy, no matter how faithfully its traps
    // forward every operation, is still a *different object identity* than the real Document,
    // and many native WebIDL APIs do a strict internal "is this actually a Node?" brand check
    // on their arguments that a Proxy always fails (it has no real Node internal slots), even
    // though normal property access/method calls on it work perfectly. Confirmed root cause of
    // a real, serious bug: any sandboxed script that passes a bare "document" reference into an
    // API like document.createTreeWalker(document, ...) (exactly what Custom Elements/Shadow
    // DOM polyfills do, e.g. YouTube's webcomponents-all-noPatch.js) got "parameter 1 is not of
    // type 'Node'" and crashed -- which in turn broke large parts of YouTube's UI (comments,
    // description, video metadata are all custom elements that depend on that polyfill). Since
    // document.URL/domain/referrer are already spoofed directly on the REAL document object
    // elsewhere (see documentLocationInject()), this Proxy's only unique job was intercepting
    // bare document.location access -- a much narrower upside than the breakage it caused.
    var fakeDocument = new Proxy(document, {
        get: function (target, prop) {
            if (prop === "location") return fakeLocation;
            if (prop === "URL" || prop === "documentURI") return original_website_url_str;
            if (prop === "domain") return original_website_host;
            // Unlike window, "document" doesn't expose capitalized constructor-style statics
            // of its own worth protecting, and its (lowercase) instance methods like
            // querySelector/createElement/write *require* a real Document as "this" or they
            // throw "Illegal invocation" -- so bind unconditionally here is correct.
            var val = target[prop];
            return typeof val === "function" ? val.bind(target) : val;
        },
        set: function (target, prop, value) {
            if (prop === "location") { fakeLocation.href = value; return true; }
            target[prop] = value;
            return true;
        },
    });

    window.__proxy_scope = new Proxy({
        window: fakeWindow, self: fakeWindow, globalThis: fakeWindow, top: fakeWindow, parent: fakeWindow,
        // NOTE: deliberately the REAL "document" here, not fakeDocument -- see the big comment
        // on fakeDocument's declaration above for why.
        location: fakeLocation, document: document,
    }, {
        has: function (target, prop) { return (prop in target) || (prop in window); },
        get: function (target, prop) {
            if (prop in target) return target[prop];
            // This is what every bare identifier reference inside sandboxed code resolves
            // through (thanks to the enclosing with()). See bindOnlyIfPlainMethod's comment:
            // plain lowercase window methods need re-binding to the real window (otherwise
            // with()'s own "this=scope object" call-binding quirk breaks branded APIs like
            // setTimeout), while capitalized constructors/namespaces must stay unbound so their
            // static methods (Array.isArray, Object.defineProperty, Promise.resolve, ...) work.
            return bindOnlyIfPlainMethod(window[prop], prop, window);
        },
        set: function (target, prop, value) {
            if (prop === "location") { fakeLocation.href = value; return true; }
            window[prop] = value;
            return true;
        },
    });

    // NOTE: deliberately NOT also re-wrapping this in "(function(window,self,...){...}).call(...)"
    // the way some sandboxes do -- that would swallow eval()'s completion value (a function body
    // without an explicit "return" always evaluates to undefined), which breaks the extremely
    // common "var x = eval(expr)" pattern. "with", backed by the scope Proxy's has/get traps
    // above, is enough to shadow window/self/globalThis/location/document for bare identifier
    // references, and it does not swallow completion values or "return".
    // Keep a source-preserving compatibility property for older injected code.
    // It deliberately does not wrap code in a with block: wrapping changes script
    // scope, completion values, this-binding, and top-level lexical declarations.
    window.__wrapJS = function (code) { return String(code); };

    // DELIBERATELY NOT overriding window.eval (confirmed root cause of a real, serious bug).
    // The obvious approach -- replace window.eval with a custom function that wraps the code
    // string in "with(window.__proxy_scope){...}" before running it -- looks reasonable but
    // breaks an enormous amount of real-world code, because of a JS-spec subtlety: a call site
    // written literally as "eval(x)" is only treated as *direct* eval (which runs in the
    // caller's own local/closure scope, giving it access to that function's local variables)
    // when the "eval" identifier resolves to the realm's actual built-in %eval% intrinsic.
    // The instant window.eval is reassigned to ANY custom JS function, every "eval(x)" call
    // site becomes an ordinary function call instead -- there is no way for a replacement
    // function, however it is implemented (with or without the with() wrapper), to get that
    // direct-eval "runs in the caller's local scope" behavior back. So wrapping window.eval
    // silently converts every direct eval on the page into an indirect (global-scope-only)
    // eval, and any evaluated code that references a local variable from its enclosing
    // function -- a very common minified-bundle pattern -- throws "ReferenceError: <name> is
    // not defined" and crashes whatever that code was supposed to set up. Confirmed root cause
    // of Pornhub's video player and other UI breaking: e.g. its networkbar-6.0.0.js runs
    // eval(scope-expression) where "scope" is a parameter of the enclosing
    // function -- direct eval normally resolves that fine, but once window.eval was wrapped it
    // started throwing "scope is not defined", which cascaded into further TypeErrors and left
    // the page half-initialized. Leaving window.eval as the untouched native built-in preserves
    // correct direct-eval semantics for every site. The only cost is that bare "location"/
    // "window"/"document" identifiers inside a DYNAMICALLY CONSTRUCTED eval() string (i.e. one
    // whose text isn't known until runtime, so it can't be rewritten ahead of time the way
    // static inline/external script content is) won't resolve through the proxy-aware sandbox
    // -- a narrow edge case, and a much smaller downside than breaking direct eval everywhere.

    // new Function(...) is another way to run dynamic code, bypassing eval() entirely -- wrap it
    // too. Since "with" doesn't swallow "return", wrapping the function body text directly keeps
    // normal return-value behaviour intact.
    // Do not replace window.Function. Rewriting Function-created code changes
    // direct-eval semantics, alters source identity, and breaks libraries that
    // compile templates or perform capability detection. The injected fetch,
    // XHR, DOM, history, and navigation hooks already rewrite actual network
    // destinations without changing JavaScript execution semantics.

    console.log("MODERN SANDBOX SCOPE READY");
}

//=== MutationObserver based rewriting: catches anything the above hooks might have missed ===
//=== (attributes set by the page's own already-loaded code using native APIs, etc) ==========
var rawGetAttr = Element.prototype.getAttribute;
var rawSetAttr = Element.prototype.setAttribute;
var rawRemoveAttr = Element.prototype.removeAttribute;
// The browser must fetch a proxied script URL, while framework runtimes must
// still observe exactly the src string authored/assigned by the page. The
// private attribute survives the temporary DOM serialization used below; on
// its first read it moves into this WeakMap and is removed from the live DOM.
var SCRIPT_SRC_VIEW_ATTR = "data-px-original-script-src";
var SCRIPT_SRC_VIEWS = new WeakMap();

var OBS_PAGE_OPTIONS = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "href", "action", "formaction", "srcset", "imagesrcset", "poster", "data", "integrity"],
};

// Attaches the rewriting MutationObserver to a single root node (the main document, or a
// shadow root -- see the attachShadow patch below). Factored out of obsPage() so every root
// gets the exact same disconnect/process/reobserve treatment.
function observeRoot(root) {
    // CRITICAL: processElement()/covToAbs() themselves rewrite the very attributes this
    // observer watches (src, href, ...) via rawSetAttr. Without guarding against that, every
    // rewrite we make re-triggers this same observer, which processes it and (on a real,
    // continuously-updating site -- ads, trackers, lazy-loaded widgets, etc., all of which
    // mutate the DOM constantly) can chain into an effectively endless sequence of
    // microtask-queued MutationObserver callbacks. Since microtasks must fully drain before
    // the browser can get to its next task (rendering, timers, or even talking back to a
    // debugging/automation client), a long enough chain is indistinguishable from the page
    // hanging forever -- confirmed empirically: disabling this observer alone took a real
    // hard-hung page (https://www.bbc.com/, never reaching the "load" event) down to a normal
    // ~3 second load. Fix: temporarily disconnect while we make our own changes, so our own
    // writes are never queued as new records in the first place, then resume observing right
    // after -- nothing else can run in between since JS is single-threaded, so no genuine
    // concurrent mutation is ever missed by this.
    var observer = new MutationObserver(function (mutations) {
        observer.disconnect();
        var seen = new Set();
        for (var i = 0; i < mutations.length; i++) {
            var m = mutations[i];
            if (m.type === "childList") {
                m.addedNodes.forEach(function (node) { traverseAndConvert(node, seen); });
            } else if (m.type === "attributes" && !seen.has(m.target)) {
                seen.add(m.target);
                processElement(m.target);
            }
        }
        observer.observe(root, OBS_PAGE_OPTIONS);
    });
    observer.observe(root, OBS_PAGE_OPTIONS);
}

// MutationObserver.observe() never crosses shadow-DOM boundaries -- a subtree observer on
// document.documentElement sees nothing that happens inside a shadow root, even an open one.
// Modern sites increasingly build with custom elements/web components (YouTube's whole UI is
// Polymer/Lit custom elements, for one) that render their real content -- including <img>,
// <source>, <a>, etc. -- inside shadow roots. Without this, every src/href/srcset inside any
// shadow root is left pointing at the real origin instead of the proxy, so images and other
// assets silently fail to load (and in a true circumvention/firewall scenario, fail completely
// rather than just inefficiently) on any site that uses shadow DOM for its component markup.
// Fix: patch attachShadow so every newly created shadow root gets its own observer, exactly
// like the main document does. This correctly covers nested shadow roots too, since each
// nested attachShadow() call is itself intercepted by this same patch.
(function patchAttachShadow() {
    if (typeof Element === "undefined" || !Element.prototype.attachShadow) return;
    var originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
        var root = originalAttachShadow.call(this, init);
        try {
            observeRoot(root);
            // Shadow roots start empty, but process anything already present just in case
            // (e.g. declarative-shadow-DOM-like usage that populates synchronously) --
            // traverseAndConvert() itself requires an HTMLElement, which a ShadowRoot is not,
            // so query its children directly instead.
            var seen = new Set();
            root.querySelectorAll("*").forEach(function (child) {
                if (!seen.has(child)) { seen.add(child); processElement(child); }
            });
        } catch (e) {
            console.log("attachShadow observer exception: " + e.message);
        }
        return root;
    };
})();

function obsPage() {
    observeRoot(document.documentElement);
    console.log("OBSERVING THE WEBPAGE...");
}

function processElement(el) {
    removeIntegrityAttributesFromElement(el);
    covToAbs(el);
}

function traverseAndConvert(node, seen) {
    if (!(node instanceof HTMLElement)) return;
    seen = seen || new Set();
    if (!seen.has(node)) { seen.add(node); processElement(node); }
    node.querySelectorAll("*").forEach(function (child) {
        if (!seen.has(child)) { seen.add(child); processElement(child); }
    });
}

function convertAttr(element, name, converter) {
    if (!element.hasAttribute(name)) return;
    var raw = rawGetAttr.call(element, name);
    var newVal;
    try {
        newVal = converter(raw);
    } catch (e) {
        console.log("convertAttr exception: " + e.message + " | " + raw);
        return;
    }
    if (newVal == null || newVal === raw) return;
    rawSetAttr.call(element, name, newVal);
}

// Parses an srcset/imagesrcset attribute ("url desc, url desc, ...") and rewrites each URL.
function convertSrcset(srcset) {
    var isWs = function (c) { return c.trim() === ""; };
    var n = srcset.length;
    var out = [];
    var i = 0;

    while (i < n) {
        while (i < n && (isWs(srcset[i]) || srcset[i] === ",")) i++;
        if (i >= n) break;

        var j = i;
        while (j < n && !isWs(srcset[j])) j++;
        var url = srcset.slice(i, j);
        var desc = "";

        if (url.endsWith(",")) {
            url = url.replace(/,+$/, "");
        } else {
            var k = srcset.indexOf(",", j);
            if (k === -1) k = n;
            desc = srcset.slice(j, k).trim();
            j = k + 1;
        }

        out.push(desc ? (changeURL(url) + " " + desc) : changeURL(url));
        i = j;
    }
    return out.join(", ");
}

function covToAbs(element) {
    if (!(element instanceof HTMLElement)) return;
    var tag = element.tagName;

    convertAttr(element, "href", changeURL);
    if (tag === "SCRIPT") {
        // Initial HTML is rewritten in a detached DOM and then serialized.
        // Preserve the script's exact authored src before convertAttr replaces
        // it with the absolute proxy URL; the private attribute survives that
        // serialization and is available when the script executes.
        var __rawScriptSrc = rawGetAttr.call(element, "src");
        if (__rawScriptSrc != null && !SCRIPT_SRC_VIEWS.has(element) && rawGetAttr.call(element, SCRIPT_SRC_VIEW_ATTR) == null) {
            rawSetAttr.call(element, SCRIPT_SRC_VIEW_ATTR, __rawScriptSrc);
        }
        var __scriptType = (element.getAttribute("type") || "").toLowerCase().trim();
        var __isModuleScript = (__scriptType === "module");
        convertAttr(element, "src", function (raw) { return changeURLForScript(raw, __isModuleScript); });
    } else {
        convertAttr(element, "src", changeURL);
    }

    if (tag === "FORM") convertAttr(element, "action", changeURL);
    if (tag === "BUTTON" || tag === "INPUT") convertAttr(element, "formaction", changeURL);
    if (tag === "IMG" || tag === "SOURCE") convertAttr(element, "srcset", convertSrcset);
    if (tag === "LINK") convertAttr(element, "imagesrcset", convertSrcset);
    // An inline style="..." attribute (e.g. style="background-image:url(https://...)") is
    // plain CSS text, not a single URL -- covered by neither urlAttrsAnyTag/urlAttrsByTag above
    // nor the IDL-property patches in elementPropertyInject(), so a url() written directly in
    // it was slipping past every other rewrite and resolving straight off the real internet.
    // Confirmed live on Pornhub: a "mgp_nextThumb" preview thumbnail div sets its image via
    // exactly this pattern. replaceContentPaths() (normally used for inline <style> TAG
    // content) works just as well here since a style ATTRIBUTE's value is the same kind of
    // plain CSS text.
    convertAttr(element, "style", replaceContentPaths);
    if (tag === "VIDEO") convertAttr(element, "poster", changeURL);
    if (tag === "OBJECT") convertAttr(element, "data", changeURL);
    // <iframe srcdoc="..."> in INITIAL markup (or arriving via innerHTML) reaches the
    // browser without ever passing the setAttribute/IDL srcdoc patches -- the parser
    // consumes the attribute as-is. Run the same dedicated rewrite here so static
    // srcdoc documents get their inner URLs proxied + the realm guard injected.
    if (tag === "IFRAME" && element.hasAttribute("srcdoc")) {
        convertAttr(element, "srcdoc", rewriteSrcdocHtml);
    }
    // <template> content is a separate DocumentFragment: covToAbs walks elements, but
    // el.content descendants are not matched by querySelectorAll("*") on the outer
    // tree, so media URLs inside templates survived unrewritten and leaked when the
    // template was cloned into the live DOM (the browser fires the fetch during
    // appendChild, before any MutationObserver pass can repair the attribute).
    if (tag === "TEMPLATE" && element.content) {
        var __tplNodes = element.content.querySelectorAll("*");
        for (var __ti = 0; __ti < __tplNodes.length; __ti++) covToAbs(__tplNodes[__ti]);
    }
}

function removeIntegrityAttributesFromElement(element) {
    if (element.hasAttribute && element.hasAttribute("integrity")) {
        element.removeAttribute("integrity");
    }
}

function loopAndConvertToAbs() {
    var all = document.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
        removeIntegrityAttributesFromElement(all[i]);
        covToAbs(all[i]);
    }
    console.log("LOOPED EVERY ELEMENT");
}

function covScript() {
    var scripts = document.getElementsByTagName("script");
    for (var i = 0; i < scripts.length; i++) covToAbs(scripts[i]);
    setTimeout(covScript, 3000);
}

//=== Wire everything up ======================================================================
networkInject();
recaptchaMessageInject();
windowOpenInject();
anchorNavigationInject();
elementPropertyInject();
domInsertionInject();
documentLocationInject();
windowLocationInject();
safeFallbackLocationInject();
historyInject();
cookieInject();
storageInject();
createModernSandbox();

window.addEventListener("load", function () {
    loopAndConvertToAbs();
    obsPage();
    covScript();
    console.log("PAGE SCAN + OBSERVER STARTED");
});
console.log("WINDOW ONLOAD EVENT ADDED");

// If an externally-loaded <script src="..."> fails (often because its src still pointed at
// the real domain before our hooks caught it), rebuild and retry it once through the proxy.
// Guards carefully against inline/module scripts (which have no meaningful "src" to retry) --
// an earlier version of this handler mistakenly tried to "recover" those, and because
// changeURL("") resolves an empty string to the *current page's own URL*, it ended up
// re-fetching the whole HTML page a second time and feeding it to the script engine.
window.addEventListener("error", function (event) {
    var element = event.target || event.srcElement;
    if (!element || element.tagName !== "SCRIPT") return;
    if (element.alreadyChanged) return;
    if (!element.hasAttribute("src")) return;              // inline or module script body error, not a load failure
    if ((element.getAttribute("type") || "").toLowerCase() === "module") return; // retry as classic would mis-load it

    var originalSrc = element.getAttribute("src");
    if (!originalSrc) return;

    removeIntegrityAttributesFromElement(element);
    covToAbs(element);

    var newScript = document.createElement("script");
    newScript.src = element.src;
    newScript.async = element.async;
    newScript.defer = element.defer;
    newScript.alreadyChanged = true;
    document.head.appendChild(newScript);
}, true);
console.log("SCRIPT ERROR RECOVERY INJECTED");
`;

// ============================================================================================
//  Second client-side piece: parses the (already fetched) HTML body on the client, rewrites
//  every URL-bearing attribute, wraps inline scripts for the sandbox, and swaps it in with
//  document.write. Doing this on the client (instead of on the Worker) keeps the Worker's own
//  CPU time low and lets it use the exact same DOM APIs (and hooks above) the real page uses.
// ============================================================================================
const htmlCovPathInjectFuncName = "parseAndInsertDoc";
const htmlCovPathInject = `
function ${htmlCovPathInjectFuncName}(htmlString) {
  var parser = new DOMParser();
  var tempDoc = parser.parseFromString(htmlString, "text/html");
  tempDoc.querySelectorAll('meta[http-equiv]').forEach(function (meta) {
    if ((meta.getAttribute('http-equiv') || '').toLowerCase() === 'content-security-policy') meta.remove();
  });
  var allElements = tempDoc.querySelectorAll("*");

  allElements.forEach(function (element) {
    covToAbs(element);
    removeIntegrityAttributesFromElement(element);

    if (element.tagName === "SCRIPT") {
      var type = (element.getAttribute("type") || "").toLowerCase().trim();
      var isJsonLike = type.indexOf("json") !== -1; // application/json, importmap, ld+json, ...
      var isModule = (type === "module");
      var text = element.textContent;

      if (text && !element.src && !isJsonLike) {
        // Do not sandbox inline scripts with with(...). That wrapper confines
        // top-level let/const/class declarations to a block, while separate
        // classic scripts commonly expect those declarations to remain
        // visible in script scope. Leave classic inline code untouched here;
        // the runtime hooks handle URL-bearing APIs and navigation.
        element.textContent = text;
      }
    }

    if (element.tagName === "STYLE" && element.textContent) {
      element.textContent = replaceContentPaths(element.textContent);
    }
  });

  var modifiedHtml = tempDoc.documentElement.outerHTML;

  var charsetMeta = modifiedHtml.match(/content="text\\/html;\\s*charset=[^"]*"/i);
  if (charsetMeta) {
    modifiedHtml = modifiedHtml.replace(charsetMeta[0], "content='text/html;charset=utf-8'");
  }

  document.open();
  document.write("<!DOCTYPE html>" + modifiedHtml);
  document.close();
}

// Cheap heuristic: does this script text look like an ES module (top-level import/export)?
// Not 100% precise (e.g. the word could appear inside a string), but false positives just
// mean we skip sandbox-wrapping a classic script, which is a harmless, non-fatal trade-off —
// whereas a false negative (wrapping a real module) would be a hard SyntaxError.
function looksLikeEsModule(code) {
  return /(^|\\n)\\s*import\\s/.test(code) || /(^|\\n)\\s*export\\s/.test(code) ||
         /(^|\\n)\\s*import\\s*\\{/.test(code) || /(^|\\n)\\s*export\\s*\\{/.test(code) ||
         /(^|\\n)\\s*import\\s*\\*/.test(code);
}

// Rewrites bare absolute URLs found inside plain-text content (used for inline <style> blocks;
// full .css files are rewritten on the Worker side with the same regex, see replaceCssUrls()).
function replaceContentPaths(content) {
  var regex = /(https?:\\/\\/[^\\s'"()]+)/g;
  return content.replace(regex, function (match) {
    if (match.indexOf("http://www.w3.org/") === 0 || match.indexOf("https://www.w3.org/") === 0) return match;
    return changeURL(match);
  });
}

// <iframe srcdoc="..."> embeds an entire inline HTML document that the browser gives its own
// separate same-origin realm (its own window/document) -- a technique ad/tracking networks
// commonly use for ad creatives. That inline HTML's own markup (<img src="...">, <script
// src="...">, ...) is never seen by any of the rewriting this file does to the OUTER page, so
// any absolute http(s):// URL written directly in it resolves straight off the real internet,
// completely bypassing the proxy. Confirmed live on Pornhub: its ad iframes' srcdoc markup
// fires image/script requests straight at adtng.com and trafficjunky.net, visible in DevTools'
// Network tab as requests that never go through the proxy -- exactly the "a few request URLs
// did not pass through the proxy" symptom. Fix: run that HTML through the same element-by-
// element URL rewrite (covToAbs) and inline-<style> rewrite (replaceContentPaths) already used
// for the top-level page before ever handing it to the browser to parse (wired up below, at the
// srcdoc attribute/property interception points in elementPropertyInject()). This only catches
// URLs written directly in the srcdoc markup (what the "type: parser"-initiated requests we
// confirmed live all were) -- an ad creative's own later JS still runs in that iframe's own
// separate realm, which this proxy's network/element patches were never installed into, so
// requests a creative's script constructs dynamically after the initial parse are a known,
// unfixed-by-this-patch residual gap.
function rewriteSrcdocHtml(html) {
  if (!html) return html;
  try {
    var parser = new DOMParser();
    var tempDoc = parser.parseFromString(html, "text/html");
    var allElements = tempDoc.querySelectorAll("*");
    allElements.forEach(function (element) {
      covToAbs(element);
      if (element.tagName === "STYLE" && element.textContent) {
        element.textContent = replaceContentPaths(element.textContent);
      }
    });

    // The rewrite above only catches URLs written directly in the srcdoc markup at parse time
    // -- it does NOT protect any network call the creative's OWN script makes LATER (fetch,
    // XHR, etc.), because an "about:srcdoc" document is a completely separate realm that never
    // gets this file's normal networkInject()/elementPropertyInject() hooks installed into it.
    // Confirmed live on Pornhub: a hover-preview widget running inside exactly this kind of
    // srcdoc iframe fires a later fetch() straight at fl-cdn.trafficjunky.net with no proxy
    // prefix at all -- the "a request never went through the proxy" symptom. Separately, since
    // an "about:srcdoc" document's origin is INHERITED from its parent frame (same-origin,
    // per spec) while its location.href is literally the string "about:srcdoc", any creative
    // script that builds a request from location.origin/location.host unwittingly gets THIS
    // PROXY's own origin instead of whatever real ad-platform origin it expected -- which can
    // produce a bizarre self-referential request back at this Worker's own domain (observed:
    // a request shaped like proxyHost/proxyHost/config?url=... that 404s, since nothing on this
    // Worker actually serves a "/config" route). This injected hook only fixes the first,
    // common, and more damaging case (absolute http(s) URLs leaking around the proxy entirely);
    // it deliberately leaves bare relative/location-derived URLs alone, since there is no way
    // to know what origin the creative actually intended them to resolve against.
    var headEl = tempDoc.querySelector("head");
    if (!headEl) {
      headEl = tempDoc.createElement("head");
      tempDoc.documentElement.insertBefore(headEl, tempDoc.documentElement.firstChild);
    }
    var guardScript = tempDoc.createElement("script");
    guardScript.textContent =
      "(function(){try{" +
      "var __pxBase=" + JSON.stringify(proxy_host_with_schema) + ";" +
      "function __pxWrap(u){" +
      "if(typeof u!=='string')return u;" +
      "var __pxLower=u.slice(0,8).toLowerCase();" +
      "if(__pxLower.indexOf('http://')!==0&&__pxLower.indexOf('https://')!==0)return u;" + // only absolute http(s) -- leave relative/blob/data alone
      "if(u.indexOf(__pxBase)===0)return u;" +
      "return __pxBase+u;}" +
      "if(window.fetch){var __of=window.fetch;window.fetch=function(input,init){" +
      "if(typeof input==='string')return __of(__pxWrap(input),init);" +
      "if(input&&input.url){try{return __of(new Request(__pxWrap(input.url),input),init);}catch(e){return __of(input,init);}}" +
      "return __of(input,init);};}" +
      "if(window.XMLHttpRequest){var __oo=XMLHttpRequest.prototype.open;" +
      "XMLHttpRequest.prototype.open=function(method,url){" +
      "var args=Array.prototype.slice.call(arguments);args[1]=__pxWrap(url);" +
      "return __oo.apply(this,args);};}" +
      // fetch()/XHR only cover script-driven network calls -- a creative that instead builds a
      // brand-new <video>/<source>/<img> element after initial parse (e.g. document.createElement
      // + .src = url, never going through innerHTML/setAttribute) and lets the BROWSER's native
      // media/image loader fetch it is a distinct code path those two hooks never see at all.
      // Confirmed live: exactly this pattern on a trafficjunky video ad inside this same kind of
      // srcdoc realm. Patch the IDL src/href setters too, same idea as the top-level page's own
      // elementPropertyInject(), so a later native element creation inside this realm is covered.
      "var __pxTags=[window.HTMLImageElement,window.HTMLVideoElement,window.HTMLAudioElement," +
      "window.HTMLSourceElement,window.HTMLScriptElement,window.HTMLIFrameElement,window.HTMLMediaElement];" +
      "for(var __i=0;__i<__pxTags.length;__i++){" +
      "var __t=__pxTags[__i];if(!__t||!__t.prototype)continue;" +
      // NOTE: the descriptor must be looked up through the prototype CHAIN, not as an
      // own property: HTMLVideoElement/HTMLAudioElement inherit 'src' from
      // HTMLMediaElement, so an own-only lookup returns undefined for exactly the two
      // media tags this guard exists for, and their IDL sets escape the proxy.
      "var __d=null,__pc=__t.prototype;" +
      "while(__pc&&!__d){__d=Object.getOwnPropertyDescriptor(__pc,'src');if(!__d)__pc=Object.getPrototypeOf(__pc);}" +
      "if(!__d||!__d.get||!__d.set)continue;" +
      "(function(__d){Object.defineProperty(__t.prototype,'src',{" +
      "get:function(){return __d.get.call(this);}," +
      "set:function(v){__d.set.call(this,__pxWrap(v));}," +
      "configurable:true});})(__d);" +
      "}" +
      "}catch(e){}})();";
    headEl.insertBefore(guardScript, headEl.firstChild);

    return "<!DOCTYPE html>" + tempDoc.documentElement.outerHTML;
  } catch (e) {
    return html;
  }
}
`;

// ============================================================================================
//  HOME PAGE — the "enter a URL and hit Jump!" page
// ============================================================================================
const mainPage = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${CONFIG.SITE_TITLE}</title>
<style>
  :root {
    --bg1: #0f172a; --bg2: #1e293b; --accent: #38bdf8; --accent2: #818cf8;
    --card: rgba(15,23,42,0.94); --text: #e2e8f0; --muted: #94a3b8;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; min-height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Tahoma, Arial, sans-serif;
    background: radial-gradient(circle at 20% 20%, #1e293b, #0f172a 60%);
    color: var(--text);
    display: flex; flex-direction: column; align-items: center;
    min-height: 100vh; padding: 32px 16px;
  }
  .logo { font-size: 40px; margin-bottom: 6px; }
  h1 { font-size: 26px; margin: 0 0 4px; font-weight: 700; letter-spacing: 0.3px; }
  .subtitle { color: var(--muted); font-size: 14px; margin-bottom: 28px; text-align: center; }
  .card {
    width: 100%; max-width: 760px;
    background: var(--card);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 16px;
    padding: 28px;
    box-shadow: 0 10px 32px rgba(0,0,0,0.3);
  }
  form { display: flex; gap: 10px; }
  input[type="text"] {
    flex: 1; padding: 14px 16px; font-size: 15px; border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.12);
    background: rgba(255,255,255,0.05); color: var(--text); outline: none;
    transition: border-color .15s, box-shadow .15s;
  }
  input[type="text"]::placeholder { color: #64748b; }
  input[type="text"]:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(56,189,248,0.25); }
  button {
    padding: 14px 22px; font-size: 15px; font-weight: 600; border: none; border-radius: 10px;
    color: #06111f; cursor: pointer;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    transition: transform .12s, opacity .12s;
  }
  button:hover { opacity: 0.92; }
  button:active { transform: scale(0.97); }
  .quicklinks { margin-top: 18px; display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
  .chip {
    padding: 7px 14px; border-radius: 999px; font-size: 13px; color: var(--text);
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
    cursor: pointer; text-decoration: none; transition: background .15s;
  }
  .chip:hover { background: rgba(255,255,255,0.14); }
  .url-error, .rule-message { min-height: 18px; margin-top: 9px; color: #fca5a5; font-size: 12px; }
  .rule-message.ok { color: #86efac; }
  .route-rules { margin-top: 20px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 14px; }
  .route-rules summary { cursor: pointer; color: #cbd5e1; font-size: 13px; font-weight: 650; user-select: none; }
  .route-rules summary:hover { color: #fff; }
  .rules-panel { padding-top: 14px; }
  .rules-description, .rules-note { color: var(--muted); font-size: 12px; line-height: 1.55; margin: 0 0 12px; }
  .rule-editor { display: grid; grid-template-columns: minmax(0,1fr) auto auto; gap: 8px; align-items: center; }
  .rule-editor input[type="text"] { min-width: 0; padding: 10px 12px; font-size: 13px; }
  .rule-btn { padding: 10px 14px; font-size: 12px; border-radius: 8px; }
  .rule-btn.remove { color: #fee2e2; background: rgba(239,68,68,0.18); border: 1px solid rgba(248,113,113,0.35); }
  .rule-list { margin: 12px 0; max-height: 300px; overflow: auto; display: flex; flex-direction: column; gap: 7px; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
  .rule-row { display: grid; grid-template-columns: minmax(0,1fr) auto auto auto; gap: 7px; align-items: center; padding: 9px; border: 1px solid rgba(255,255,255,0.08); border-radius: 9px; background: rgba(255,255,255,0.035); }
  .rule-url { min-width: 0; overflow-wrap: anywhere; color: #dbeafe; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .rule-state { font-size: 11px; font-weight: 700; white-space: nowrap; }
  .rule-state.enabled { color: #86efac; }
  .rule-state.disabled { color: #fca5a5; }
  .builtin { display: inline-block; margin-left: 6px; color: #93c5fd; font-size: 10px; }
  @media (max-width: 640px) {
    .card { padding: 20px; box-shadow: 0 6px 18px rgba(0,0,0,0.24); }
    form { flex-direction: column; }
    .rule-editor { grid-template-columns: 1fr 1fr; }
    .rule-editor input { grid-column: 1 / -1; }
    .rule-list { max-height: none; overflow: visible; overscroll-behavior: auto; }
    .rule-row { grid-template-columns: 1fr auto auto; }
    .rule-state { grid-column: 1; }
  }
  .info { max-width: 760px; margin-top: 26px; font-size: 13px; color: var(--muted); line-height: 1.9; }
  .info b { color: var(--text); }
  footer { margin-top: auto; padding-top: 32px; text-align: center; font-size: 12px; color: #64748b; }
  footer a { color: #93c5fd; text-decoration: none; }
  footer a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <div class="logo">🌐</div>
  <h1>${CONFIG.SITE_TITLE}</h1>
  <div class="subtitle">Enter a website address and hit Jump!</div>

  <div class="card">
    <form id="urlForm" onsubmit="redirectToProxy(event)">
      <input type="text" id="targetUrl" placeholder="example.com" autocomplete="off" autofocus>
      <button type="submit" id="jump">Jump! 🚀</button>
    </form>
    <div class="url-error" id="urlError"></div>
    <div class="quicklinks">
      <a class="chip" onclick="fillUrl('https://wikipedia.org/')">Wikipedia</a>
      <a class="chip" onclick="fillUrl('https://github.com/')">GitHub</a>
      <a class="chip" onclick="fillUrl('https://duckduckgo.com/')">DuckDuckGo</a>
    </div>

    <details class="route-rules" id="routeRulesDetails">
      <summary>Route compatibility rules</summary>
      <div class="rules-panel">
        <p class="rules-description">Enable virtual-path bootstrap for sites that read the browser pathname and otherwise open an empty route or redirect incorrectly. Rules apply to the exact URL prefix and all of its subpaths.</p>
        <div class="rule-editor">
          <input type="text" id="routeRuleUrl" placeholder="https://example.com/app" autocomplete="off">
          <button type="button" class="rule-btn" onclick="applyRouteRule(1)">Set</button>
          <button type="button" class="rule-btn remove" onclick="applyRouteRule(0)">Remove</button>
        </div>
        <div class="rule-message" id="routeRuleMessage"></div>
        <div class="rule-list" id="routeRuleList"></div>
        <p class="rules-note">The most specific matching prefix wins. Remove stores a disabled override. Delete the <code>${ROUTE_BOOT_RULES_COOKIE_NAME}</code> cookie to reset all overrides to the built-in defaults.</p>
      </div>
    </details>
  </div>

  <div class="info">
    <b>How to use:</b><br>
    1. Type the address of the site you want to visit above, then press Jump!.<br>
    2. You can also type the destination URL directly after this proxy's own address in the browser address bar.<br>
    <b>Warning: It is strongly recommended not to log into important accounts on proxied sites.</b>
  </div>

  <footer>
    ${CONFIG.CREDIT_NAME && CONFIG.CREDIT_URL ? `<p>UI credit: <a href="${CONFIG.CREDIT_URL}" target="_blank" rel="noopener">${CONFIG.CREDIT_NAME}</a></p>` : ""}
    <p>This is an <a href="${CONFIG.GITHUB_REPO_URL}" target="_blank" rel="noopener">open-source project</a>.</p>
  </footer>

<script>
  var ROUTE_RULE_COOKIE_NAME = "${ROUTE_BOOT_RULES_COOKIE_NAME}";
  var DEFAULT_ROUTE_RULES = ${JSON.stringify(DEFAULT_ROUTE_BOOT_PREFIXES)};
  var routeRuleOverrides = readRouteRuleOverrides();

  function normalizeHttpUrl(value) {
    var input = String(value || "").trim();
    if (!input) throw Error("Enter a URL first.");
    if (input.indexOf("//") === 0) input = "https:" + input;
    else if (!/^[a-z][a-z0-9+.-]*:\\/\\//i.test(input)) input = "https://" + input;
    var url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw Error("Only HTTP and HTTPS URLs are supported.");
    return url.href;
  }
  function normalizeRouteRule(value) {
    var url = new URL(normalizeHttpUrl(value));
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    var path = url.pathname || "/";
    if (path.length > 1) path = path.replace(/\\/+$/, "");
    var normalized = url.origin + (path === "/" ? "" : path);
    if (normalized.length > 512) throw Error("The rule URL is too long.");
    return normalized;
  }
  function readCookieValue(name) {
    var prefix = name + "=";
    var found = "";
    document.cookie.split(";").forEach(function (part) {
      part = part.trim();
      if (part.indexOf(prefix) === 0) found = part.substring(prefix.length);
    });
    return found;
  }
  function readRouteRuleOverrides() {
    var raw = readCookieValue(ROUTE_RULE_COOKIE_NAME);
    if (!raw) return {};
    try {
      var parsed = JSON.parse(decodeURIComponent(raw));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (e) { return {}; }
  }
  function saveRouteRuleOverrides() {
    var keys = Object.keys(routeRuleOverrides);
    if (keys.length > 40) throw Error("A maximum of 40 route rules is supported.");
    var encoded = encodeURIComponent(JSON.stringify(routeRuleOverrides));
    if (encoded.length > 3500) throw Error("The route-rule cookie is too large.");
    var expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    var secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = ROUTE_RULE_COOKIE_NAME + "=" + encoded + "; expires=" + expiry.toUTCString() + "; path=/; SameSite=Lax" + secure;
  }
  function defaultRuleMap() {
    var defaults = Object.create(null);
    DEFAULT_ROUTE_RULES.forEach(function (rule) {
      try { defaults[normalizeRouteRule(rule)] = 1; } catch (e) { /* ignore invalid built-in */ }
    });
    return defaults;
  }
  function showRuleMessage(message, ok) {
    var element = document.getElementById("routeRuleMessage");
    element.textContent = message || "";
    element.className = "rule-message" + (ok ? " ok" : "");
  }
  function setRouteRule(prefix, value) {
    try {
      var normalized = normalizeRouteRule(prefix);
      if (!Object.prototype.hasOwnProperty.call(routeRuleOverrides, normalized) && Object.keys(routeRuleOverrides).length >= 40) {
        throw Error("A maximum of 40 route rules is supported.");
      }
      routeRuleOverrides[normalized] = value ? 1 : 0;
      saveRouteRuleOverrides();
      document.getElementById("routeRuleUrl").value = normalized;
      showRuleMessage((value ? "Enabled " : "Disabled ") + normalized, true);
      renderRouteRules();
    } catch (e) { showRuleMessage(e.message, false); }
  }
  function applyRouteRule(value) {
    setRouteRule(document.getElementById("routeRuleUrl").value, value);
  }
  function renderRouteRules() {
    var list = document.getElementById("routeRuleList");
    list.textContent = "";
    var defaults = defaultRuleMap();
    var combined = Object.create(null);
    Object.keys(defaults).forEach(function (key) { combined[key] = defaults[key]; });
    Object.keys(routeRuleOverrides).forEach(function (key) {
      try { combined[normalizeRouteRule(key)] = routeRuleOverrides[key] ? 1 : 0; } catch (e) { /* ignore invalid cookie entry */ }
    });
    Object.keys(combined).sort().forEach(function (prefix) {
      var row = document.createElement("div");
      row.className = "rule-row";
      var url = document.createElement("div");
      url.className = "rule-url";
      url.textContent = prefix;
      if (Object.prototype.hasOwnProperty.call(defaults, prefix)) {
        var builtin = document.createElement("span");
        builtin.className = "builtin";
        builtin.textContent = "built-in";
        url.appendChild(builtin);
      }
      var enabled = !!combined[prefix];
      var state = document.createElement("span");
      state.className = "rule-state " + (enabled ? "enabled" : "disabled");
      state.textContent = enabled ? "Enabled" : "Disabled";
      var setButton = document.createElement("button");
      setButton.type = "button";
      setButton.className = "rule-btn";
      setButton.textContent = "Set";
      setButton.onclick = function () { setRouteRule(prefix, 1); };
      var removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "rule-btn remove";
      removeButton.textContent = "Remove";
      removeButton.onclick = function () { setRouteRule(prefix, 0); };
      row.appendChild(url);
      row.appendChild(state);
      row.appendChild(setButton);
      row.appendChild(removeButton);
      list.appendChild(row);
    });
  }
  function redirectToProxy(event) {
    event.preventDefault();
    var error = document.getElementById("urlError");
    error.textContent = "";
    try {
      var targetUrl = normalizeHttpUrl(document.getElementById("targetUrl").value);
      document.getElementById("targetUrl").value = targetUrl;
      window.open(window.location.origin + "/" + targetUrl, "_blank");
    } catch (e) { error.textContent = e.message; }
  }
  function fillUrl(url) {
    document.getElementById("targetUrl").value = url;
    document.getElementById("jump").click();
  }
  renderRouteRules();
</script>
</body>
</html>
`;

// ============================================================================================
//  PASSWORD PAGE
// ============================================================================================
const pwdPage = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${CONFIG.SITE_TITLE} — Locked</title>
<style>
  :root { --accent: #38bdf8; --accent2: #818cf8; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Tahoma, Arial, sans-serif;
    background: radial-gradient(circle at 20% 20%, #1e293b, #0f172a 60%);
    color: #e2e8f0;
    display: flex; align-items: center; justify-content: center;
    min-height: 100%; padding: 16px;
  }
  .card {
    width: 100%; max-width: 380px; text-align: center;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 18px; padding: 36px 28px;
    backdrop-filter: blur(10px);
    box-shadow: 0 10px 40px rgba(0,0,0,0.4);
    animation: pop .25s ease-out;
  }
  @keyframes pop { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }
  .lock { font-size: 40px; margin-bottom: 10px; }
  h1 { font-size: 19px; margin: 0 0 6px; font-weight: 700; }
  p.sub { color: #94a3b8; font-size: 13px; margin: 0 0 22px; line-height: 1.7; }
  input[type="password"] {
    width: 100%; padding: 13px 14px; font-size: 15px; border-radius: 10px; text-align: center;
    border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.05);
    color: #e2e8f0; outline: none; margin-bottom: 14px; transition: border-color .15s, box-shadow .15s;
  }
  input[type="password"]:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(56,189,248,0.25); }
  button {
    width: 100%; padding: 13px; font-size: 15px; font-weight: 600; border: none; border-radius: 10px;
    color: #06111f; cursor: pointer;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    transition: transform .12s, opacity .12s;
  }
  button:hover { opacity: .92; }
  button:active { transform: scale(.97); }
  .err { color: #fca5a5; font-size: 13px; margin-top: 12px; min-height: 16px; }
  .shake { animation: shake .3s; }
  @keyframes shake { 20%,60%{transform:translateX(-6px);} 40%,80%{transform:translateX(6px);} }
</style>
</head>
<body>
  <form class="card" id="pwdForm" onsubmit="return setPassword(event)">
    <div class="lock">🔒</div>
    <h1>This page requires a password</h1>
    <p class="sub">Enter the password to continue.</p>
    <input id="password" type="password" placeholder="Password" autofocus>
    <button type="submit">Unlock</button>
    <div class="err" id="err"></div>
  </form>

<script>
  function setPassword(event) {
    event.preventDefault();
    try {
      var cookieDomain = window.location.hostname;
      var password = document.getElementById('password').value;
      var expiry = new Date();
      expiry.setTime(expiry.getTime() + (${CONFIG.PASSWORD_COOKIE_DAYS} * 24 * 60 * 60 * 1000));
      document.cookie = "${PASSWORD_COOKIE_NAME}=" + encodeURIComponent(password) +
        "; expires=" + expiry.toUTCString() + "; path=/; domain=" + cookieDomain + "; SameSite=Lax";
      location.reload();
    } catch (e) {
      var err = document.getElementById('err');
      err.textContent = e.message;
      document.querySelector('.card').classList.add('shake');
      setTimeout(function(){ document.querySelector('.card').classList.remove('shake'); }, 300);
    }
    return false;
  }
</script>
</body>
</html>
`;

const redirectError = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Redirect error</title></head>
<body style="font-family:sans-serif;padding:40px;">
<h2>Error while redirecting</h2>
<p>The website you tried to reach sent a redirect this proxy could not understand.</p>
</body></html>
`;

// ============================================================================================
//  MAIN REQUEST HANDLER — everything here is scoped to *this one request* via local consts.
//  (The old version kept the proxy's own base URL in module-level `var`s shared by every
//  in-flight request on the same Worker instance; under concurrency — e.g. two tabs loading
//  two different sites at once — a second request could overwrite those globals while the
//  first request was still awaiting a fetch(), scrambling both responses together. Threading
//  everything through local variables/parameters instead makes that class of bug impossible.)
// ============================================================================================
async function handleRequest(request) {
  const url = new URL(request.url);
  const proxyBase = `${url.protocol}//${url.host}/`; // e.g. https://my-proxy.example.com/ (host includes a port if any, hostname would silently drop it)
  const proxyHostOnly = url.host;

  // ---- Poison AI-scraper bots that ignore robots.txt (optional, harmless to remove) --------
  const userAgent = request.headers.get("User-Agent") || "";
  if (userAgent.includes("Bytespider")) {
    return getHTMLResponse("0");
  }

  // ---- Password gate --------------------------------------------------------------------
  const siteCookie = request.headers.get("Cookie") || "";
  if (CONFIG.PASSWORD !== "") {
    const pwd = getCookieValue(PASSWORD_COOKIE_NAME, siteCookie);
    if (pwd !== CONFIG.PASSWORD) {
      return handleWrongPwd();
    }
  }

  // ---- Worker-level static routes --------------------------------------------------------
  if (url.pathname === "/favicon.ico") {
    return getRedirect("https://www.google.com/favicon.ico");
  }
  if (url.pathname === "/robots.txt") {
    return new Response("User-Agent: *\nDisallow: /", { headers: { "Content-Type": "text/plain" } });
  }

  let actualUrlStr = url.pathname.substring(url.pathname.indexOf(PATH_SEP) + PATH_SEP.length) + url.search + url.hash;
  if (actualUrlStr === "") {
    return getHTMLResponse(mainPage);
  }

  // ---- Recover site-internal paths that lost their host ----------------------
  // Some scripts (challenge/anti-bot flows are the common case, e.g. Anubis
  // navigating to "/.within.website/x/cmd/anubis/api/pass-challenge?...") build
  // their next URL from the *real* location of the page they believe they are
  // on. Inside this proxy the browser's location is proxyHost/<target URL>, so
  // a root-relative or host-less destination can reach the Worker in shapes
  // that are NOT valid standalone targets:
  //
  //   proxyHost/https://.within.website/...   (host begins with a dot)
  //   proxyHost/https://localhost/...          (loopback / non-public host)
  //   proxyHost/some/relative/path             (no scheme at all -- already
  //                                             handled by the fallback below)
  //
  // Fetching a host like ".within.website" is meaningless and Cloudflare
  // surfaces it as a DNS/origin failure (error 1003). This is a *class* of
  // bug, not a single site: any destination whose host is not a plausible
  // public host must be re-based onto the site the visitor is actually
  // browsing. The origin is recovered, in order, from:
  //   1. the Referer (for a script-driven navigation it still points at the
  //      proxied page that initiated it -- the most precise signal), and
  //   2. the last-visited-site cookie the proxy maintains for exactly this
  //      kind of relative recovery.
  //
  // Safety properties (why this cannot break normal sites):
  //   - It only triggers when the purported host fails a strict plausibility
  //     check (empty, leading/trailing dot, empty label, no dot and not a
  //     known TLD-less intranet name is *not* enough on its own -- see below,
  //     loopback/private/reserved ranges, or an unparseable URL).
  //   - Ordinary absolute URLs with ordinary public hosts never enter this
  //     branch; their handling below is byte-for-byte unchanged.
  //   - If no origin can be recovered, control falls through to the existing
  //     generic handling instead of guessing.
  function isPlausiblePublicHost(host) {
    if (!host) return false;
    const h = host.toLowerCase();
    if (h.startsWith(".") || h.endsWith(".")) return false;
    if (h.includes("..")) return false;
    if (h === "localhost" || h.endsWith(".localhost")) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
      const parts = h.split(".").map(Number);
      if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
      // Loopback, private, link-local, and unspecified ranges are never a
      // public website the visitor typed into the proxy.
      if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return false;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
      if (parts[0] === 192 && parts[1] === 168) return false;
      if (parts[0] === 169 && parts[1] === 254) return false;
      return true; // a public IPv4 literal is a legitimate target
    }
    if (h.includes(":")) return false; // bare IPv6 without brackets etc. -- not a typed website host
    // A DNS name must contain a dot-separated label structure with a plausible
    // TLD (letters only, at least 2 chars). Single-label names (e.g. "search",
    // "watch") are relative paths, not hosts.
    if (!h.includes(".")) return false;
    const labels = h.split(".");
    if (labels.some((label) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))) return false;
    if (!/^[a-z]{2,}$/.test(labels[labels.length - 1])) return false;
    return true;
  }

  function recoverInternalPathOrigin() {
    const fromReferer = extractProxiedUrl(request.headers.get("referer"), proxyBase, proxyHostOnly);
    if (fromReferer) return fromReferer.origin;
    const lastVisit = getCookieValue(LAST_VISIT_COOKIE_NAME, siteCookie);
    if (lastVisit) {
      try { return new URL(lastVisit).origin; } catch { /* fall through */ }
    }
    // Last resort: challenge flows often carry their intended destination in
    // a redir/redirect-style query parameter (frequently as a proxied URL).
    // If such a URL is pasted into a fresh tab, that parameter is the only
    // remaining record of the real site. Accept it only when it decodes to a
    // proxied URL or to an absolute URL on a plausible public host.
    try {
      const qIndex = actualUrlStr.indexOf("?");
      if (qIndex !== -1) {
        const params = new URLSearchParams(actualUrlStr.substring(qIndex + 1).split("#")[0]);
        for (const key of ["redir", "redirect", "redirect_url", "redirectUrl", "return", "returnUrl", "url"]) {
          const raw = params.get(key);
          if (!raw) continue;
          const fromParam = extractProxiedUrl(raw, proxyBase, proxyHostOnly);
          if (fromParam) return fromParam.origin;
          try {
            const parsed = new URL(raw);
            // Proxied form (possibly copied from another proxy host):
            // https://proxy.example/https://site.example/...
            const embedded = parsed.pathname.match(/^\/(https?:\/\/.+)$/i);
            if (embedded) {
              try { return new URL(embedded[1]).origin; } catch { /* try next key */ }
            }
            if (parsed.hostname && isPlausiblePublicHost(parsed.hostname)) return parsed.origin;
          } catch { /* try next key */ }
        }
      }
    } catch { /* fall through to null */ }
    return null;
  }

  {
    // A site-internal destination reaches this Worker in three shapes:
    //   1. proxyHost/<site-internal path>            -- no scheme at all. The
    //      browser resolved a path like "/.within.website/..." against the
    //      *proxy* location; the real target is that same path on the origin
    //      the visitor is browsing. Re-base it directly, preserving the
    //      whole path, query, and hash.
    //   2. proxyHost/https://<first-segment>/...     -- an Anubis-style URL
    //      that was already absolute against a host-less base, so its first
    //      segment landed in the authority position. That segment is part
    //      of the intended path, not a host.
    //   3. Ordinary absolute URLs on real public hosts -- never touched here.
    //
    // Shape 1 is tried first and is the common case for root-relative script
    // navigations. Shape 2 only applies when the claimed authority fails the
    // plausibility check above. Both resolve against the browsing origin
    // (Referer, then last-visit cookie, then an embedded redirect target);
    // if no origin can be recovered, control falls through to the generic
    // handling below instead of guessing.
    if (!/^https?:\/\//i.test(actualUrlStr)) {
      // Shape 1 guard: only re-base onto a browsing origin when the value is
      // unambiguously a *path continuation*, i.e. the browser produced it by
      // resolving a path against the proxy location. That is exactly the
      // case when the whole value has no dot-containing first segment that
      // could be a host, or when it begins with "/" or "." characters. A
      // single first segment that is a plausible host ("www.example.com/x",
      // "foo.bar.baz") is ambiguous with a typed destination and must fall
      // through to the generic handling below, which treats it correctly.
      const segMatch = actualUrlStr.match(/^[^/?#]+/);
      const firstSeg = segMatch ? segMatch[0] : "";
      const firstSegHost = firstSeg.substring(firstSeg.lastIndexOf("@") + 1).split(":")[0];
      const looksLikePath = firstSeg === "" ||
        firstSeg.startsWith(".") ||
        !isPlausiblePublicHost(firstSegHost) ||
        actualUrlStr.startsWith(".") ||
        actualUrlStr.startsWith("/");
      if (looksLikePath) {
        const recoveredOriginS1 = recoverInternalPathOrigin();
        if (recoveredOriginS1) {
          return getRedirect(proxyBase + recoveredOriginS1 + "/" + actualUrlStr);
        }
      }
    }
    const schemeMatch = actualUrlStr.match(/^https?:\/\/([^/?#]+)/i);
    if (schemeMatch) {
      let claimedHost = schemeMatch[1];
      // Strip any userinfo and port before judging the host itself.
      claimedHost = claimedHost.substring(claimedHost.lastIndexOf("@") + 1);
      if (!claimedHost.startsWith("[")) claimedHost = claimedHost.split(":")[0];
      if (!isPlausiblePublicHost(claimedHost)) {
        // The claimed authority is actually the first segment of a
        // site-internal path (shape 2 above). Keep it as a path segment:
        // the intended destination is origin + "/" + authority + rest.
        const recoveredOrigin = recoverInternalPathOrigin();
        if (recoveredOrigin) {
          const afterScheme = actualUrlStr.substring(actualUrlStr.indexOf("://") + 3);
          const slashAt = afterScheme.indexOf("/");
          const authorityPart = slashAt === -1 ? afterScheme : afterScheme.substring(0, slashAt);
          const restPart = slashAt === -1 ? "" : afterScheme.substring(slashAt);
          const hostOnly = authorityPart.substring(authorityPart.lastIndexOf("@") + 1).split(":")[0];
          return getRedirect(proxyBase + recoveredOrigin + "/" + hostOnly + restPart);
        }
      }
    }
  }

  // Compatibility: older clients inserted a reserved module marker after the
  // proxy host. Strip it if it ever appears, but do not generate it anymore:
  // deriving chunk URLs from a marked module URL corrupts application paths.
  const modulePrefix = MODULE_MARKER_SEGMENT + PATH_SEP;
  if (actualUrlStr.startsWith(modulePrefix)) {
    actualUrlStr = actualUrlStr.substring(modulePrefix.length);
  }

  // ---- Figure out the real destination URL -----------------------------------------------
  try {
    let test = actualUrlStr;
    if (!test.startsWith("http")) test = "https://" + test;
    const u = new URL(test);
    if (!u.host.includes(".")) throw new Error("no dot in host");
  } catch {
    // Likely a relative request from a page that does its own internal routing (e.g. a search
    // engine rewriting "/?q=key"). Try to resolve it against whatever site the visitor last
    // loaded, using the matching per-site cookie namespace.
    const lastVisit = getCookieValue(LAST_VISIT_COOKIE_NAME, siteCookie);
    if (lastVisit) {
      return getRedirect(proxyBase + lastVisit + "/" + actualUrlStr);
    }
    return getHTMLResponse(
      "This proxy could not figure out which site you meant. Please go back to the home page and enter a full URL." +
      "<br><a href=\"" + proxyBase + "\">Home</a>"
    );
  }

  if (!actualUrlStr.startsWith("http") && !actualUrlStr.includes("://")) {
    return getRedirect(proxyBase + "https://" + actualUrlStr);
  }

  const actualUrl = new URL(actualUrlStr);

  // Normalize case/formatting differences (proxy.com/https://ABCabc.dev -> canonical form)
  if (actualUrlStr !== actualUrl.href) return getRedirect(proxyBase + actualUrl.href);

  const refererRaw = request.headers.get("referer");
  const refererOriginalUrl = extractProxiedUrl(refererRaw, proxyBase, proxyHostOnly);
  const restoredEncodedOrigins = restoreEncodedOriginParams(new URL(actualUrl.href), proxyHostOnly, refererOriginalUrl && refererOriginalUrl.origin);
  if (restoredEncodedOrigins !== actualUrl.href) return getRedirect(proxyBase + restoredEncodedOrigins);

  // Stop script-driven same-document reload loops without blocking explicit
  // user navigation. A 204 navigation keeps the current document alive.
  const incomingDocumentDest = (request.headers.get("Sec-Fetch-Dest") || "").toLowerCase();
  const previousDocument = getCookieValue(LAST_DOCUMENT_COOKIE_NAME, siteCookie);
  const isUserNavigation = request.headers.get("Sec-Fetch-User") === "?1";
  if (request.method === "GET" && incomingDocumentDest === "document" && !isUserNavigation &&
      request.headers.get("referer") && previousDocument === siteToken(actualUrl.href)) {
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  const cookiePrefix = sitePrefix(actualUrl.host);

  // =========================================================================================
  //  Build the outgoing request headers
  // =========================================================================================
  const trueOriginForHeaders = refererOriginalUrl ? refererOriginalUrl.origin : actualUrl.origin;

  // Headers that must never leave this Worker: they'd leak the visitor's real network
  // identity/location to whatever site is being proxied, and "Sec-Fetch-*" describe the
  // (meaningless, since it's proxy->origin) relationship between the Worker and the origin
  // rather than the browser and the origin, so forwarding them as-is can trigger bot/CSRF
  // checks on the destination site.
  const dropHeaders = new Set([
    "cf-connecting-ip", "x-forwarded-for", "x-real-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
    "cf-worker", "cf-connecting-ipv6", "cf-pseudo-ipv4", "x-forwarded-proto", "x-forwarded-host",
    "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user",
    // Cloudflare edge/runtime fingerprints. A destination does not need any of
    // these to answer the request, and several anti-bot systems key on them
    // (together with the egress IP range) to classify the traffic as
    // automated proxy traffic. Dropping every cf-prefixed header we did not
    // deliberately synthesize keeps the upstream request indistinguishable
    // from an ordinary server-side fetch. Response-side Cloudflare headers
    // are added by the edge *after* this Worker replies and are out of scope.
    "cf-ew-via", "cf-ew-layer", "cf-ew-websockets", "cf-ew-pass-through",
    "cdn-loop", "true-client-ip",
  ]);

  const clientHeaderWithChange = new Headers();
  request.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (dropHeaders.has(lowerKey)) return;
    // Belt-and-braces on top of the explicit drop list: no Cloudflare-added
    // request header of any name should reach the destination.
    if (lowerKey.startsWith("cf-") || lowerKey === "cdn-loop") return;

    let newValue = value.replaceAll(proxyBase + "http", "http");
    newValue = newValue.replaceAll(proxyBase, actualUrl.origin + "/");
    newValue = newValue.replaceAll(proxyBase.substring(0, proxyBase.length - 1), actualUrl.origin);
    newValue = newValue.replaceAll(proxyHostOnly, actualUrl.host);

    if (lowerKey === "origin") {
      // The Origin of an upstream CORS request must name the destination
      // being fetched, not the (possibly different) page that referred to
      // it. Previous behaviour used the Referer's origin, which for
      // cross-site media/API segment requests could name the wrong site.
      newValue = actualUrl.origin;
    } else if (lowerKey === "referer" && refererOriginalUrl) {
      newValue = refererOriginalUrl.href;
    }

    if (lowerKey === "cookie") {
      newValue = newValue
        .split(";")
        .map((c) => c.trim())
        .filter((c) => c.startsWith(cookiePrefix))
        .map((c) => c.substring(cookiePrefix.length))
        .join("; ");
      if (!newValue) return;
    }

    clientHeaderWithChange.set(key, newValue);
  });

  // 9xbuddy's download API validates the browser-generated signature together
  // with its current mirror domain and CORS headers. Accept any structurally
  // recognized 9xbud.* / 9xbuddy.* frontend only when x-requested-domain also
  // matches the last top-level browsing origin maintained by this proxy.
  if (actualUrl.hostname === "ab.9xbud.com" || actualUrl.hostname.endsWith(".9xbud.com")) {
    const requestedDomain = (clientHeaderWithChange.get("x-requested-domain") || "").toLowerCase().split(":")[0];
    const is9xBuddyDomain = /^(?:www\.)?9xbud(?:dy)?\.[a-z0-9-]+(?:\.[a-z0-9-]+)?$/i.test(requestedDomain);
    let source = null;
    if (is9xBuddyDomain && refererOriginalUrl && refererOriginalUrl.hostname.toLowerCase() === requestedDomain) {
      source = refererOriginalUrl;
    }
    if (!source && is9xBuddyDomain) {
      try {
        const lastTopLevelOrigin = new URL(getCookieValue(LAST_VISIT_COOKIE_NAME, siteCookie));
        if (lastTopLevelOrigin.hostname.toLowerCase() === requestedDomain) source = lastTopLevelOrigin;
      } catch { /* no valid top-level fallback */ }
    }
    if (source) {
      clientHeaderWithChange.set("Origin", source.origin);
      clientHeaderWithChange.set("Referer", source.origin + "/");
    }
  }

  // The fetch() runtime (Cloudflare Workers, and the undici-based Node test harness alike)
  // transparently decompresses gzip/deflate/br for us -- see the "Critical fix: Content-Encoding
  // / Content-Length are always stale" comment further down, which unconditionally strips those
  // response headers on the assumption that the body has already been decompressed. That
  // assumption is FALSE for zstd: the browser's real Accept-Encoding header (which this loop
  // just forwarded verbatim) commonly advertises "gzip, deflate, br, zstd", and if we pass that
  // straight to the origin, a zstd-capable origin (confirmed live: googletagmanager.com) will
  // happily respond with Content-Encoding: zstd -- which this runtime's fetch() does NOT know
  // how to auto-decompress, unlike the other three. The still-zstd-compressed (i.e. arbitrary
  // binary) bytes then flow into the same code path that assumes decompression already
  // happened: text responses get force-decoded as UTF-8 (mangling every invalid byte sequence
  // into U+FFFD and permanently destroying the content, confirmed root cause of a real
  // "Uncaught SyntaxError: Invalid or unexpected token" crash loading Google Tag Manager's
  // gtm.js through the proxy on Pornhub), while binary responses (images, video, fonts, ...)
  // get passed through with their Content-Encoding header stripped -- so the browser receives
  // raw compressed bytes but is told they're already-decoded image/font/etc. data, and either
  // fails to decode it at all or renders a truncated/degenerate (e.g. 1x1) placeholder instead
  // of the real image. Simplest correct fix: never advertise an encoding we can't guarantee
  // this runtime will transparently undo for us -- drop zstd from what we forward upstream.
  const acceptEncoding = clientHeaderWithChange.get("Accept-Encoding");
  if (acceptEncoding) {
    const filtered = acceptEncoding
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e && !/^zstd(;|$)/i.test(e));
    if (filtered.length) clientHeaderWithChange.set("Accept-Encoding", filtered.join(", "));
    else clientHeaderWithChange.set("Accept-Encoding", "gzip, deflate, br");
  }

  // =========================================================================================
  //  Build the outgoing request body.
  //
  //  Binary request bodies (protobuf/UMP media segment requests, uploads,
  //  beacons with binary payloads) must be forwarded byte-for-byte and must
  //  never be routed through a text decoder: UTF-8 decoding is lossy for
  //  arbitrary bytes (invalid sequences become U+FFFD), so even a body that
  //  happened to contain the proxy host as bytes came back corrupted, and
  //  media players then received valid HTTP 200 responses whose payload no
  //  longer parsed as media -- playback starts, then stalls once the
  //  corrupted segment is reached. Only forward a body through the text
  //  de-proxying path when its content type is genuinely textual AND the
  //  decoded text round-trips losslessly.
  // =========================================================================================
  const requestContentType = (request.headers.get("Content-Type") || "").toLowerCase();
  const bodyIsTextual = request.body && (
    requestContentType.startsWith("text/") ||
    requestContentType.includes("application/x-www-form-urlencoded") ||
    requestContentType.includes("json") ||
    requestContentType.includes("xml") ||
    requestContentType.includes("javascript")
  );
  let clientRequestBodyWithChange = request.body;
  if (bodyIsTextual) {
    const [body1, body2] = request.body.tee();
    try {
      const bytes = new Uint8Array(await new Response(body1).arrayBuffer());
      // Strip a UTF-8 BOM up front and decode tolerantly. A *fatal* decode on
      // a body that was merely labelled textual (mislabelled content types are
      // common -- media beacons and some APIs serve binary payloads as
      // text/plain or JSON) threw a TypeError out of this block and surfaced
      // as a Worker error pointing at the decode itself ("ignoreBOM" appears
      // in some runtimes' decode error text). Tolerate replacement chars
      // here, then only treat the body as text when it round-trips cleanly;
      // anything else is forwarded byte-for-byte via the second tee branch.
      var __bomLen = (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) ? 3 : 0;
      const bodyText = new TextDecoder("utf-8").decode(bytes.subarray(__bomLen));
      const looksTextual = bodyText.indexOf("�") === -1;
      if (looksTextual && (bodyText.includes(proxyBase) || bodyText.includes(proxyHostOnly))) {
        const rewritten = deproxyBodyText(bodyText, proxyBase, proxyHostOnly, requestContentType);
        clientRequestBodyWithChange = rewritten !== bodyText ? rewritten : body2;
      } else {
        clientRequestBodyWithChange = body2;
      }
    } catch {
      // Unreadable or non-text payload: forward the untouched second branch
      // of the tee, byte-for-byte.
      clientRequestBodyWithChange = body2;
    }
  }

  // "duplex: half" is mandatory (both in the Fetch spec and in the Cloudflare Workers runtime,
  // not just this Node test harness) whenever a Request is constructed with a body -- omitting
  // it throws "TypeError: RequestInit: duplex option is required when sending a body" and takes
  // down EVERY POST/PUT/PATCH request the proxy forwards: form submissions, fetch()/XHR POSTs,
  // analytics/consent beacons, login requests, GraphQL calls, all of it. That in turn is exactly
  // the kind of failure that leaves a cookie-consent "Accept" button looking stuck forever --
  // its click handler fires a POST that immediately rejects, so it never gets to dismiss the
  // banner or set the cookie that would stop it reappearing.
  // Before anything is forwarded, convert any proxied destination embedded
  // in this request's own query parameters back to the original absolute URL.
  // Challenge/anti-bot endpoints validate redirect-style parameters against
  // the site they belong to; handing them this proxy's hostname inside an
  // encoded value is what makes an otherwise-correct challenge fail at the
  // destination (observed as Anubis "Something went wrong" on Startpage).
  // Only parameters whose decoded value is itself an absolute URL wrapped in
  // this proxy are changed; tokens and opaque values pass through untouched.
  const originUrlStr = deproxyForOrigin(actualUrl.href, proxyBase, proxyHostOnly);
  const originUrl = originUrlStr === actualUrl.href ? actualUrl : new URL(originUrlStr);

  // If the body was rewritten above, its byte length changed: the incoming
  // Content-Length / Content-Type length assumptions are stale. Drop the
  // stale length (chunked transfer is used instead) and keep the original
  // content type. This must happen before the Request is constructed --
  // forwarding a rewritten body with the old Content-Length makes runtimes
  // reject the request outright (RequestContentLengthMismatchError).
  if (typeof clientRequestBodyWithChange === "string" && request.body) {
    clientHeaderWithChange.delete("Content-Length");
  }
  if (request.headers.get("Upgrade") === "websocket") {
    return fetch(originUrl, { headers: clientHeaderWithChange, method: request.method });
  }

  // Range responses must never enter Cloudflare's static-file cache. On a cache
  // miss, a large media URL can otherwise start an edge cache-fill before the
  // requested middle range is streamed, producing an immediate 206 header but
  // no body for tens of seconds. That breaks seeking and parallel downloaders.
  const isByteRangeRequest = request.method === "GET" && request.headers.has("Range");
  if (isByteRangeRequest) {
    clientHeaderWithChange.set("Cache-Control", "no-cache");
    clientHeaderWithChange.set("Pragma", "no-cache");
  }

  const modifiedRequest = new Request(originUrl, {
    headers: clientHeaderWithChange,
    method: request.method,
    body: request.body ? clientRequestBodyWithChange : request.body,
    redirect: "manual",
    ...(request.body ? { duplex: "half" } : {}),
  });

  const response = isByteRangeRequest
    ? await fetch(modifiedRequest, {
        // Cloudflare Workers supports no-store/no-cache on subrequests. Use
        // no-store so existing cached partial objects are bypassed as well.
        cache: "no-store",
        cf: {
          cacheEverything: false,
          // Negative TTL means "do not cache" rather than "cache and expire
          // immediately". Apply it to every possible upstream status.
          cacheTtlByStatus: { "200-599": -1 },
        },
      })
    : await fetch(modifiedRequest);

  // =========================================================================================
  //  Upstream redirect handling
  // =========================================================================================
  if (response.status.toString().startsWith("3") && response.headers.get("Location") != null) {
    try {
      const redirectTarget = new URL(response.headers.get("Location"), actualUrlStr).href;
      return getRedirect(proxyBase + redirectTarget, response, actualUrl, proxyHostOnly);
    } catch {
      return getHTMLResponse(redirectError + "<br>Location: " + response.headers.get("Location") + "<br>From: " + actualUrlStr);
    }
  }

  // =========================================================================================
  //  Process the response body according to its content type
  // =========================================================================================
  let modifiedResponse;
  const contentType = response.headers.get("Content-Type") || "";
  let isHTML = false;
  // Captured BEFORE any header mutation: tells us whether fetch() actually transparently
  // decompressed this body for us (see the stale-Content-Length comment below). Needed because
  // real video/audio CDNs almost never gzip/br-compress already-compressed media, so for the
  // overwhelming majority of Range-requested video/audio segments, image bytes, and file
  // downloads, the origin's Content-Length is NOT stale and must be preserved byte-for-byte --
  // adaptive-streaming players (hls.js/dash.js/Shaka, all fetch()-based) and download managers
  // that split a file into parallel Range requests both validate the chunk they received against
  // the advertised Content-Length (or the length implied by a 206's Content-Range), and an
  // unconditionally-deleted Content-Length forces the response into chunked transfer, which some
  // of those clients treat as "connection ended early / corrupt chunk" and abort or discard the
  // segment -- a very plausible root cause of video that fetches fine via a bare <video src>
  // smoke test (no MSE/byte-range fetch loop involved) but still fails to actually play through
  // a site's real player, and of images that decode as a degenerate placeholder.
  const originalContentEncoding = response.headers.get("Content-Encoding");
  let bodyLengthIsStale = false;

  if (response.body) {
    // HLS (.m3u8) and DASH (.mpd) streaming manifests are plain text containing further URLs
    // (sub-playlists, encryption key URIs, media segments) that must also be routed through the
    // proxy -- otherwise video players fetch those URLs directly from the real CDN, bypassing the
    // proxy entirely. That silently breaks playback whenever the real CDN's CORS policy doesn't
    // allow the proxy's origin, or when segment delivery depends on the proxy's own auth cookie --
    // which explains why some video-streaming sites play fine (permissive/no CORS, or only
    // relative segment URLs that happen to resolve correctly through the proxy already) while
    // others silently fail to load any video at all.
    const isManifestLike = [
      "application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl",
      "application/dash+xml", "video/vnd.mpeg.dash.mpd",
    ].some((marker) => contentType.includes(marker));
    const isTextLike = isManifestLike || ["text/", "application/json", "application/javascript", "application/ecmascript", "text/javascript"]
      .some((marker) => contentType.includes(marker));

    if (isTextLike) {
      const rawBytes = await response.arrayBuffer();
      let encoding = "utf-8";
      const charsetMatch = contentType.match(/charset=([^\s;]+)/i);
      if (charsetMatch) {
        encoding = charsetMatch[1];
      } else if (contentType.includes("text/html")) {
        const preview = new TextDecoder("utf-8").decode(rawBytes.slice(0, 1024 * 2));
        const metaMatch = preview.match(/charset\s*=\s*["']?\s*([^\s"';>]+)/i);
        if (metaMatch) encoding = metaMatch[1];
      }

      let bd;
      try {
        bd = new TextDecoder(encoding).decode(rawBytes);
      } catch {
        bd = new TextDecoder("utf-8").decode(rawBytes);
      }

      isHTML = contentType.includes("text/html") && bd.includes("<html");

      if (isHTML) {
        let hasBom = false;
        if (bd.charCodeAt(0) === 0xfeff) {
          bd = bd.substring(1);
          hasBom = true;
        }

        // Keep page-native JavaScript semantics intact. Textually replacing
        // location references across a complete HTML response also changes
        // strings and serialized framework data (including React/RSC flight
        // payloads), not just executable expressions. Runtime URL hooks plus
        // the server-side structural de-proxying of query/body values handle
        // actual navigation and callbacks without corrupting that data.
        //
        // One narrow textual exception is applied only to JSON script islands
        // (application/json, ld+json, importmap and similar): those are *data*,
        // not executable code, and pages routinely embed their own canonical /
        // return URLs there. Only complete proxied URL strings are converted;
        // executable script text is never rewritten.
        bd = rewriteJsonIslands(bd, proxyBase, proxyHostOnly);

        const encodedBody = bytesToBase64(new TextEncoder().encode(bd));

        const inject = `
<!DOCTYPE html>
<script>
(function () {
  ${httpRequestInjection}

  ${htmlCovPathInject}

  var __px_binary = atob("${encodedBody}");
  var __px_bytes = new Uint8Array(__px_binary.length);
  for (var __px_i = 0; __px_i < __px_binary.length; __px_i++) __px_bytes[__px_i] = __px_binary.charCodeAt(__px_i);
  ${htmlCovPathInjectFuncName}(new TextDecoder().decode(__px_bytes));
})();
</script>
`;
        bd = (hasBom ? "\uFEFF" : "") + inject;
      } else if (!isHTML && (contentType.includes("javascript") || contentType.includes("ecmascript"))) {
        // Never put an external classic script inside with(...). Even when the file is
        // an IIFE/webpack bundle, the wrapper changes script semantics in ways that
        // are impossible to contain safely: every top-level let/const/class becomes
        // block-scoped instead of script-scoped, bare identifiers resolve through a
        // Proxy instead of the real global object, `this` can stop being Window, and
        // dynamically generated code (new Function/eval/script injection) sees yet
        // another environment. Minified production bundles commonly depend on at
        // least one of those details. Confirmed on the PH mobile player: wrapping
        // mobile-player.min.js lets the file finish parsing, but the player's poster
        // and media bootstrap do not reach the state they reach when the same file
        // is served untouched (the original worker did not wrap it at all).
        //
        // Keep the URL *reference* rewriting that this worker performs elsewhere,
        // and let the injected client hooks (patched fetch/XHR/DOM/IDL accessors)
        // handle runtime URLs. Preserve top-level "use strict" exactly as authored
        // instead of stripping it: removing it can change `this`, octal/error
        // behavior, and the meaning of legacy bundled code.
        const isGoogleRecaptchaRuntime =
          (actualUrl.hostname === "www.gstatic.com" || actualUrl.hostname === "www.recaptcha.net") &&
          /\/recaptcha\/releases\/[^/]+\/recaptcha__[^/]+\.js$/i.test(actualUrl.pathname);
        const is9xBuddySignedRequestRuntime =
          /\/build\/assets\/(?:GetToken|GetQuery|Process)-[^/]+\.js$/i.test(actualUrl.pathname) &&
          (bd.includes("x-requested-domain") || bd.includes("xbuddy123sudo-") ||
           bd.includes("document.location.hostname.length"));
        if (isGoogleRecaptchaRuntime) bd = rewriteGoogleRecaptchaPostMessage(bd);
        else if (is9xBuddySignedRequestRuntime) bd = rewrite9xBuddyHostname(bd);
      } else if (contentType.includes("css")) {
        bd = replaceCssUrls(bd, proxyBase, proxyHostOnly);
      } else if (isManifestLike) {
        bd = replaceManifestUrls(bd, proxyBase, actualUrl);
      }

      modifiedResponse = new Response(bd, response);
      modifiedResponse.headers.set("Content-Type", contentType.replace(/charset=([^\s;]+)/i, "charset=utf-8"));
      bodyLengthIsStale = true; // re-encoded through TextDecoder/TextEncoder; byte count can differ
    } else {
      modifiedResponse = new Response(response.body, response);
    }
  } else {
    modifiedResponse = new Response(response.body, response);
  }

  // =========================================================================================
  //  Response cookies: namespace by site, point Domain at the proxy, Path always "/"
  // =========================================================================================
  // Read the frame kind from the INCOMING request (these Sec-Fetch-* headers are
  // stripped from the outgoing request, but the browser's originals are still
  // readable here): "document" = top-level navigation, "iframe"/"frame" = an
  // embedded frame's document, undefined = a browser that doesn't send it.
  const incomingSecFetchDest = (request.headers.get("Sec-Fetch-Dest") || "").toLowerCase();
  const isTopLevelDocument = incomingSecFetchDest === "" ? undefined : incomingSecFetchDest === "document";
  handleCookieHeader(modifiedResponse.headers, isHTML, response, actualUrl, proxyHostOnly, isTopLevelDocument);

  // =========================================================================================
  //  Strip response headers that would otherwise block embedding/execution through the proxy
  // =========================================================================================
  modifiedResponse.headers.set("Access-Control-Allow-Origin", "*");
  modifiedResponse.headers.set("X-Frame-Options", "ALLOWALL");
  ["Content-Security-Policy", "Content-Security-Policy-Report-Only", "Permissions-Policy",
   "Cross-Origin-Embedder-Policy", "Cross-Origin-Resource-Policy", "Cross-Origin-Opener-Policy",
   "Strict-Transport-Security"].forEach((h) => modifiedResponse.headers.delete(h));

  // ---- Critical fix: Content-Encoding / Content-Length are always stale here -------------
  // The fetch() spec (both in browsers, Node, and the Cloudflare Workers runtime) transparently
  // gunzip/brotli-decompresses the response body for you *before* you ever get to touch
  // response.body / .arrayBuffer() / .text() -- but it does NOT remove the original
  // "Content-Encoding" header, and "Content-Length" still reflects the origin's *compressed*
  // byte count. Since `new Response(bd, response)` (and the pass-through `new Response(response.body,
  // response)` branch) both carry that stale header pair straight through, every response the
  // origin sent gzip/br/deflate-compressed would tell the visitor's browser "this body is still
  // gzip-compressed" while actually handing it plain, already-decompressed bytes (possibly of a
  // different length too, if we rewrote the body). The browser then tries to gunzip plain text
  // and fails outright with net::ERR_CONTENT_DECODING_FAILED -- which silently breaks the main
  // HTML document, every compressed stylesheet, every compressed script, images referenced from
  // a broken stylesheet, and in turn anything (like a cookie-consent "Accept" button) whose JS
  // never got to run. Strip Content-Encoding unconditionally (we never re-compress), but only
  // strip Content-Length when it's actually stale -- i.e. when the origin told us the body was
  // compressed (so fetch()'s silent decompression changed the byte count) or when this code
  // re-encoded the body itself (the isTextLike branch above, which always sets
  // bodyLengthIsStale). The much more common case for video/audio segments, images, fonts, and
  // arbitrary file downloads is a verbatim byte passthrough with no Content-Encoding at all --
  // there the origin's Content-Length (and, for a 206, its Content-Range) is exactly correct,
  // and keeping it is essential: adaptive-streaming players (hls.js/dash.js/Shaka -- all
  // fetch()-based, all byte-range-fetching) validate each segment's received length against it
  // and discard/retry "short" segments, and download managers that split one file across several
  // parallel Range requests rely on it to know a chunk is complete and to size the file ahead of
  // time. Dropping it on every single response silently broke exactly those two things.
  modifiedResponse.headers.delete("Content-Encoding");
  if (bodyLengthIsStale || originalContentEncoding) {
    modifiedResponse.headers.delete("Content-Length");
  }

  // Prevent both the public Worker route and any Cloudflare subrequest cache
  // from storing partial objects under a media URL. Keep Content-Range,
  // Content-Length, ETag, and Accept-Ranges intact for standards-compliant
  // download managers and media seeking.
  if (isByteRangeRequest || modifiedResponse.status === 206) {
    modifiedResponse.headers.set("Cache-Control", "private, no-store, no-cache, max-age=0, must-revalidate");
    modifiedResponse.headers.set("CDN-Cache-Control", "no-store");
    modifiedResponse.headers.set("Cloudflare-CDN-Cache-Control", "no-store");
    modifiedResponse.headers.set("Surrogate-Control", "no-store");
    modifiedResponse.headers.set("Pragma", "no-cache");
    modifiedResponse.headers.set("Expires", "0");
    modifiedResponse.headers.delete("Age");
    modifiedResponse.headers.delete("CF-Cache-Status");
  }

  return modifiedResponse;
}

// Rewrites bare absolute URLs inside a CSS file's text so they go through the proxy.
function replaceCssUrls(bd, proxyBase, proxyHostOnly) {
  const regex = /(https?:\/\/[^\s'")]+)/g;
  return bd.replaceAll(regex, (match) => {
    if (match.startsWith("http://www.w3.org/") || match.startsWith("https://www.w3.org/")) return match;
    return proxyBase + match;
  });
}

// Rewrites absolute URLs inside an HLS (.m3u8) or DASH (.mpd) streaming manifest so that
// sub-playlists, encryption-key URIs, and media segments are also fetched through the proxy
// instead of going directly to the real CDN. Relative references inside the manifest need no
// change: since the manifest itself was fetched from a proxied URL (proxyBase + real URL), the
// player's own relative-URL resolution against that fetch URL already produces another valid,
// correctly-proxied URL -- only *absolute* http(s) URLs would otherwise escape the proxy.
function replaceManifestUrls(bd, proxyBase, actualUrl) {
  const regex = /(https?:\/\/[^\s"'<>]+)/g;
  return bd.replaceAll(regex, (match) => proxyBase + match);
}

// =============================================================================================
//  Set-Cookie handling: namespaces every cookie's *name* by which site set it, so that two
//  different proxied sites sharing this one proxy domain can never read or clobber each
//  other's cookies — regardless of whatever Path/Domain attributes they each asked for.
// =============================================================================================
function handleCookieHeader(headers, isHTML, response, actualUrl, proxyHostOnly, isTopLevelDocument) {
  const prefix = sitePrefix(actualUrl.host);
  // A cookie's Domain attribute must be a bare hostname -- no port. If the proxy itself is
  // reached through a non-default port (e.g. a local dev preview on :8787), leaving the port
  // in here makes the Domain attribute invalid and browsers silently drop the whole cookie.
  const proxyDomainOnly = proxyHostOnly.split(":")[0];

  // There are three APIs in the wild for reading multiple Set-Cookie headers at once:
  // the modern standard Headers.prototype.getSetCookie() (supported by current Cloudflare
  // Workers and Node), the older Cloudflare-Workers-only Headers.prototype.getAll("Set-Cookie"),
  // and, failing both, a plain .get() (fine as long as there's at most one cookie, since
  // Set-Cookie values themselves contain commas in Expires dates and can't be safely split).
  let rawCookies = [];
  if (typeof headers.getSetCookie === "function") {
    rawCookies = headers.getSetCookie();
  } else if (typeof headers.getAll === "function") {
    try { rawCookies = headers.getAll("Set-Cookie"); } catch { rawCookies = []; }
  }
  if (rawCookies.length === 0) {
    const v = headers.get("Set-Cookie");
    if (v) rawCookies = [v];
  }

  if (rawCookies.length > 0) {
    headers.delete("Set-Cookie");
    rawCookies.forEach((singleCookie) => {
      const parts = singleCookie.split(";").map((p) => p.trim());
      const nameVal = parts.shift();
      const eq = nameVal.indexOf("=");
      if (eq === -1) return; // malformed, drop it

      const name = nameVal.substring(0, eq);
      const value = nameVal.substring(eq + 1);

      const rest = parts.filter((p) => {
        const l = p.toLowerCase();
        return l.indexOf("domain=") !== 0 && l.indexOf("path=") !== 0;
      });
      rest.push("Path=/");
      rest.push("Domain=" + proxyDomainOnly);

      headers.append("Set-Cookie", prefix + name + "=" + value + "; " + rest.join("; "));
    });
  }

  // Remember "the site the visitor is browsing" ONLY for top-level document
  // navigations. HTML documents loaded into iframes (trackers, ad pixels,
  // captcha widgets, consent frames...) also arrive here as isHTML 200s, and
  // letting them overwrite this cookie corrupts every later relative-path
  // recovery: a relative navigation like "/login/" issued by the top-level
  // site would be re-based onto whichever third-party frame document loaded
  // last (confirmed live: a top-level site's own "/login/" was re-based onto
  // an ad/captcha iframe host and returned that host's 404 page). The
  // browser states the frame kind in Sec-Fetch-Dest; when the header is
  // absent (older browsers), keep the previous always-set behavior.
  if (isHTML && response.status === 200 && isTopLevelDocument !== false) {
    headers.append("Set-Cookie", LAST_VISIT_COOKIE_NAME + "=" + encodeURIComponent(actualUrl.origin) + "; Path=/; Domain=" + proxyDomainOnly);
    headers.append("Set-Cookie", LAST_DOCUMENT_COOKIE_NAME + "=" + siteToken(actualUrl.href) + "; Path=/; Domain=" + proxyDomainOnly + "; SameSite=Lax");
  }
}

function handleWrongPwd() {
  if (CONFIG.SHOW_PASSWORD_PAGE) {
    return getHTMLResponse(pwdPage, 401);
  }
  return getHTMLResponse("<h1>403 Forbidden</h1><p>You do not have access to view this page.</p>", 403);
}

function getHTMLResponse(html, status) {
  return new Response(html, {
    status: status || 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function getRedirect(url, originalResponse, actualUrl, proxyHostOnly) {
  if (originalResponse && actualUrl && proxyHostOnly) {
    const res = new Response(null, originalResponse);
    handleCookieHeader(res.headers, false, originalResponse, actualUrl, proxyHostOnly);
    res.headers.set("Location", url);
    res.headers.delete("Content-Security-Policy");
    return res;
  }
  return Response.redirect(url, 302);
}

