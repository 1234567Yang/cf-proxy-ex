# cf-proxy-ex Hardened Worker

## Technical Architecture and Maintenance Guide

This document describes the current structure and behavior of `worker.js`. It covers only features that are present in the current file.

The file is a standalone Cloudflare Worker module that implements a password-protected, URL-rewriting reverse proxy. It has no package dependencies, build step, external configuration file, database, or required framework.

> **Security notice:** A reverse proxy can read the requests, responses, cookies, and form data that pass through it. Do not use an untrusted deployment for authentication, private accounts, payment data, or other sensitive activity.

---

## 1. Proxy URL Model

A destination URL is placed directly after the proxy origin:

```text
https://proxy.example/https://destination.example/path?query=value
```

The browser remains connected to `proxy.example`. The Worker extracts the embedded destination, sends the upstream request, transforms the response where necessary, and returns it from the proxy origin.

The proxy has three primary route types:

```text
/                                      Home page
/robots.txt                            Disallow crawler indexing
/https://destination.example/...      Proxied destination
```

`/favicon.ico` redirects to a public favicon endpoint.

All request-specific values are stored in local variables inside `handleRequest()`. The Worker does not use mutable request-global URL state, so concurrent requests cannot overwrite each other's destination information.

---

## 2. Deployment

### Cloudflare Workers

Upload `worker.js` as the Worker source.

### Cloudflare Pages Advanced Mode

Rename the file to `_worker.js` and place it at the root of the Pages build output. Pages will execute it as a full Worker.

### Module Entry Point

The module exports one `fetch()` handler:

```js
export default {
  async fetch(request) {
    return await handleRequest(request);
  }
};
```

The entry point catches uncaught errors and returns a plain-text HTTP 500 response containing the stack and nested cause when available.

---

## 3. User Configuration

Most fork-level settings are in the `CONFIG` object near the top of the file.

| Setting | Purpose |
|---|---|
| `SITE_TITLE` | Title displayed by the home and password pages |
| `PASSWORD` | Password required to use the proxy; set to an empty string to disable the gate |
| `SHOW_PASSWORD_PAGE` | Selects the designed password form instead of a bare forbidden response |
| `PASSWORD_COOKIE_DAYS` | Lifetime of the password cookie |
| `GITHUB_REPO_URL` | Repository link shown in the footer |
| `CREDIT_NAME` | Optional credit label |
| `CREDIT_URL` | Optional credit destination |

The password page stores the entered password in the `__proxy_pwd__` browser cookie and reloads the page. This is a convenience gate, not a substitute for a full identity system. The cookie is created by client-side JavaScript and is therefore not `HttpOnly`.

---

## 4. Top-Level File Structure

The source is organized into these major sections:

1. Configuration and internal constants
2. Worker module entry point
3. Server-side URL, body, query, and cookie helpers
4. Client runtime template (`httpRequestInjection`)
5. HTML conversion template (`htmlCovPathInject`)
6. Home, password, and error page templates
7. Main request pipeline (`handleRequest`)
8. Response transformation helpers
9. Response cookie and redirect helpers

The client templates are JavaScript strings assembled by the Worker and executed in the visitor's browser. The comments inside the file intentionally avoid nested template literals in those strings because an unescaped backtick would terminate the outer Worker template.

---

## 5. Internal Constants and Cookies

### Internal constants

| Constant | Purpose |
|---|---|
| `PATH_SEP` | URL path separator |
| `COOKIE_NS_PREFIX` | Prefix used for per-site cookie namespaces |
| `PASSWORD_COOKIE_NAME` | Password cookie name |
| `LAST_VISIT_COOKIE_NAME` | Remembers the last top-level destination origin |
| `LAST_DOCUMENT_COOKIE_NAME` | Stores a short hash of the last top-level document URL |
| `REPLACE_LOCATION_OBJ_NAME` | Name of the proxy-aware Location shim |
| `MODULE_MARKER_SEGMENT` | Legacy module marker accepted for backward compatibility but no longer generated |

### Per-site cookie isolation

Every upstream cookie name is prefixed with a deterministic token derived from the destination host:

```text
__pxsite_<host-token>__<original-cookie-name>
```

Both the Worker and browser runtime contain the same `siteToken()` hash algorithm. These two copies must remain identical.

When a request is sent upstream, only cookies belonging to the current destination host are selected. The namespace prefix is removed before forwarding. When `Set-Cookie` is returned, the Worker adds the namespace prefix, removes the upstream `Domain` and `Path`, and assigns the cookie to the proxy domain with `Path=/`.

This prevents two proxied sites from reading or overwriting each other's cookies even though they share one browser origin.

### Top-level navigation cookies

`__proxy_last__` records the top-level destination origin. It is updated only for a successful top-level HTML document, not for tracker, CAPTCHA, advertisement, or widget iframes.

`__proxy_doc__` stores a short hash of the last top-level document URL. It supports the same-document navigation loop guard described later.

---

## 6. Server-Side URL Recovery and De-Proxying

### `extractProxiedUrl()`

Recovers a real destination URL from a value that contains the proxy prefix. It handles:

- Plain proxied URLs
- Multiple nested proxy prefixes
- Percent-encoded URL layers
- Proxy host references embedded in request metadata

Multiple layers are removed defensively because some libraries read an already proxied URL and wrap it again.

### `deproxyEmbeddedUrls()`

Removes proxy references from plain, URL-encoded, and JSON slash-escaped strings. It is used for server-side normalization and is designed to be idempotent.

### `deproxyForOrigin()`

Examines every query parameter structurally. A value is changed only when it is itself a proxied absolute HTTP or HTTPS URL. Opaque IDs, hashes, tokens, and ordinary text are preserved.

### `canonicalizeNestedQuery()`

Handles one additional structural level when an outer URL-valued parameter contains its own query parameters with proxied destinations.

### `restoreEncodedOriginParams()`

Some verification widgets encode their embedding origin as Base64. This function checks every query value without depending on a provider-specific parameter name. A value is replaced only if it decodes to the proxy's exact host. The replacement is the original referring page origin, including an explicit default port where required.

This mechanism supports Google reCAPTCHA origin validation while leaving unrelated Base64 values unchanged.

### Internal-path origin recovery

`handleRequest()` includes a strict public-host plausibility check and recovery logic for URLs that lost their original host. It supports:

- Root-relative paths that reached the proxy without a destination host
- Malformed absolute URLs whose authority is actually the first path segment
- Challenge and redirect flows that carry their intended origin in a redirect parameter

The recovery order is:

1. Original destination recovered from `Referer`
2. `__proxy_last__` top-level origin cookie
3. A structurally valid redirect or return URL query parameter

Ordinary absolute URLs on plausible public hosts bypass this recovery logic.

---

## 7. Request Processing Pipeline

`handleRequest()` performs the following steps.

### 7.1 Establish request-local proxy data

The function derives:

- `proxyBase`, including a non-default port
- `proxyHostOnly`
- The embedded destination string

### 7.2 Apply the password gate

If `CONFIG.PASSWORD` is non-empty, the request must contain the matching `__proxy_pwd__` cookie.

### 7.3 Serve Worker-owned routes

The home page, password page, `robots.txt`, and favicon behavior are handled without contacting an upstream destination.

A request from the `Bytespider` user agent receives a minimal response. This is an optional anti-scraper behavior in the current source.

### 7.4 Recover and canonicalize the destination

The Worker validates absolute destinations, recovers hostless internal paths, strips the legacy module marker, and redirects non-canonical target forms to one canonical proxy URL.

### 7.5 Correct encoded verification origins

If a Base64 query value decodes to the proxy origin, it is replaced with the original referring origin. The browser is redirected to the corrected proxied URL so scripts inside the verification frame also observe the corrected query string.

### 7.6 Prevent automatic same-document reload loops

A script-driven top-level GET navigation to the same document hash is answered with HTTP 204 when it has a `Referer` but no `Sec-Fetch-User: ?1` marker. A 204 navigation keeps the current document alive.

Explicit user navigation and reload remain allowed.

### 7.7 Build upstream headers

The Worker:

- Removes Cloudflare edge identity headers
- Removes forwarding and client-IP headers
- Removes browser `Sec-Fetch-*` headers before the upstream request
- De-proxies `Referer`
- Sets an upstream `Origin` to the actual destination origin when an Origin header exists
- Selects and de-namespaces cookies for the destination host
- Removes `zstd` from `Accept-Encoding`

`gzip`, `deflate`, and `br` remain available because the runtime can transparently decode them. `zstd` is excluded because forwarding compressed bytes through a runtime that does not decode them would corrupt text, images, fonts, or media after response header normalization.

### 7.8 Process the request body safely

Only textual content types are candidates for body de-proxying:

- `text/*`
- Form URL encoding
- JSON
- XML
- JavaScript

The body stream is split with `tee()`. A UTF-8 BOM is recognized, decoding is tolerant, and the body is treated as text only when it contains no replacement characters. Invalid or binary-looking data is forwarded byte-for-byte from the untouched stream branch.

Textual body transformations are structural:

- Form fields are individually checked
- JSON string values are recursively checked
- Generic text receives conservative complete-token replacement

If a body changes, stale `Content-Length` is removed. Body-bearing `Request` objects use `duplex: "half"`.

### 7.9 Perform the upstream fetch

The Worker constructs a new `Request` with `redirect: "manual"`. WebSocket upgrade requests are passed to `fetch()` with their method and rewritten headers.

For a byte-range GET, the subrequest explicitly uses `cache: "no-store"`. Cloudflare cache options set `cacheEverything: false` and a negative `cacheTtlByStatus` for every upstream status. This bypasses existing cached partial objects and prevents a new partial response from entering Cloudflare's cache. The upstream request also carries `Cache-Control: no-cache` and `Pragma: no-cache`.

### 7.10 Rewrite upstream redirects

An upstream `Location` header is resolved against the real destination and returned as another proxied URL. Upstream cookies on redirect responses are processed before the redirect is returned.

---

## 8. Response Processing

### HTML

For an HTML response, the Worker:

1. Detects the response charset from `Content-Type` or an HTML charset declaration
2. Decodes the body
3. Preserves a leading BOM indicator
4. Structurally de-proxies URL strings inside JSON script islands
5. Base64-encodes the original HTML bytes
6. Returns a small bootstrap document containing the client runtime and HTML converter

The browser runtime decodes the HTML, parses it in a detached document, rewrites URL-bearing elements, removes integrity metadata, and replaces the bootstrap document with the converted page using `document.open()`, `document.write()`, and `document.close()`.

CSP meta tags are removed during this conversion because their original-origin allowlists would block correctly proxied scripts, workers, frames, and connections. Equivalent CSP response headers are also removed later on the Worker.

### JavaScript

External JavaScript is not placed inside a `with` scope and is not globally wrapped. Strict mode, top-level lexical declarations, source identity, `eval`, and `Function` semantics remain native.

One narrow exception is applied to the Google reCAPTCHA runtime described in the compatibility section.

### CSS

Absolute HTTP and HTTPS URLs in CSS text are prefixed with the proxy URL. W3C namespace URLs are excluded.

### HLS and DASH manifests

Absolute media, key, and sub-playlist URLs in HLS and DASH manifests are rewritten to pass through the proxy. Relative references already resolve against the proxied manifest URL.

### JSON and ordinary text

Text-like responses are decoded and re-encoded as UTF-8. JSON response content is otherwise left to the page unless it appears as a JSON script island inside HTML.

### Binary data

Images, fonts, archives, media segments, downloads, and other binary responses pass through as streams without text decoding.

### Response header normalization

The Worker:

- Adds permissive `Access-Control-Allow-Origin`
- Removes framing, CSP, cross-origin isolation, permissions, and HSTS headers that conflict with proxy execution
- Removes stale `Content-Encoding`
- Removes `Content-Length` only when decompression or textual re-encoding made it stale
- Preserves a valid binary `Content-Length` and `Content-Range` where possible
- Marks every Range/206 response `no-store` at browser, CDN, Cloudflare CDN, and surrogate-cache levels
- Removes inherited `Age` and `CF-Cache-Status` values from partial responses

Preserving correct binary lengths is important for byte ranges, adaptive streaming, and segmented downloads. Disabling cache for 206 responses is equally important: otherwise a cache miss on a large media URL can start a full or delayed cache-fill, return the 206 headers immediately, and stall the requested middle-range body. The explicit bypass lets parallel download chunks and media seeks stream directly from the upstream server.

---

## 9. Browser Runtime

The `httpRequestInjection` string is executed before the destination page.

### Original URL model

The runtime distinguishes two forms:

- **Browser/network form:** the URL on the proxy origin
- **Original form:** the destination URL the page expects to observe

`changeURL()` converts original or relative destinations into proxy URLs. `getOriginalUrl()` removes proxy prefixes. `proxyAwareOriginalUrl()` resolves page-visible values against the original destination.

### Network API hooks

The runtime rewrites destinations used by:

- `fetch`
- `XMLHttpRequest.open`
- `navigator.sendBeacon`
- `EventSource`
- `Worker`
- `WebSocket`
- `window.open`

`Request` objects are rebuilt with their method, headers, body, credentials, cache mode, redirect mode, integrity, signal, and streamed-body duplex setting.

### DOM insertion hooks

Before inserted nodes can trigger network activity, the runtime processes:

- `appendChild`
- `insertBefore`
- `replaceChild`
- `append`
- `prepend`
- `before`
- `after`
- `innerHTML`
- `outerHTML`
- `insertAdjacentHTML`

Raw-text `SCRIPT` and `STYLE` elements are treated specially so JavaScript and CSS source text are not incorrectly HTML-escaped.

Integrity attributes are removed synchronously before dynamically inserted transformed resources can be checked against stale hashes.

### Element attributes and IDL properties

The runtime rewrites network-bearing values such as:

- `src`
- `href`
- `action`
- `formaction`
- `poster`
- `data`
- `srcset`
- `imagesrcset`
- `srcdoc`

Both `getAttribute`/`setAttribute` and important element IDL properties are handled.

For most page code, getters report original destination values while setters store a proxied browser value.

### Exact script-source view

Some module/chunk runtimes use the literal value of `script.getAttribute("src")` as an internal key. Returning an absolute de-proxied value when the page authored a root-relative value can make every chunk download successfully while hydration waits forever.

The runtime stores the exact authored script source in `data-px-original-script-src`, moves it to a `WeakMap` on first read, and removes the private DOM attribute. This preserves framework key semantics while the browser still fetches the proxied source.

### Shadow DOM

A document-level `MutationObserver` cannot see into shadow roots. `attachShadow()` is patched so each new shadow root receives its own URL-rewriting observer.

### Mutation observer

The observer handles elements and attributes created after initial parsing. It disconnects while applying its own changes, then reconnects, preventing self-generated mutation loops.

### Proxy-aware Location object

`ProxyLocation` exposes original values for:

- `href`
- `protocol`
- `host`
- `hostname`
- `port`
- `pathname`
- `search`
- `hash`
- `origin`

Assignments, `assign()`, and `replace()` navigate through `changeURL()`.

The real `document.URL`, `document.domain`, and `document.referrer` are exposed in destination-oriented form where possible.

### History API

`history.pushState()` and `history.replaceState()` translate page-authored destinations into proxy URLs while preserving application state.

### Cookie API

The runtime presents only cookies in the current destination's namespace and removes the namespace before returning `document.cookie` to page code. Cookie writes add the namespace and remove an incompatible upstream `Domain` attribute.

### Storage isolation

`localStorage` and `sessionStorage` keys are prefixed per destination host. `getItem`, `setItem`, `removeItem`, `clear`, `key`, `length`, property reads/writes, membership checks, and deletion operate within the current host namespace.

### Script compatibility scope

The runtime creates compatibility proxy objects for `window`, `location`, and global methods. The current implementation deliberately preserves source code, native direct `eval`, native `Function`, real `document` identity, constructor static properties, and function-as-namespace properties. `window.__wrapJS` is a source-preserving compatibility function rather than an active source sandbox.

---

## 10. Compatibility Modules

### 10.1 Parallel Downloads and Media Seeking

Range requests receive a dedicated cache-bypass path. This path is activated by an incoming `Range` header or an upstream HTTP 206 response.

For the upstream subrequest, the Worker:

- Preserves `Range`, `If-Range`, and other conditional headers
- Adds request-level `no-cache` directives
- Uses the standard Worker `cache: "no-store"` fetch option
- Sets `cf.cacheEverything` to `false`
- Sets `cf.cacheTtlByStatus` to a negative value for all normal response statuses

For the returned partial response, the Worker:

- Preserves status 206
- Preserves `Content-Range`, `Content-Length`, `Accept-Ranges`, `ETag`, and `Last-Modified`
- Adds `Cache-Control: private, no-store, no-cache, max-age=0, must-revalidate`
- Adds `CDN-Cache-Control`, `Cloudflare-CDN-Cache-Control`, and `Surrogate-Control` with `no-store`
- Removes stale cache-age/status metadata

This prevents Cloudflare's default static-file behavior for paths ending in extensions such as `.mp4` from turning random-access ranges into delayed cache fills. It allows independent download-manager chunks to run concurrently and lets a media element request data from the middle of a file without first downloading the beginning.

### 10.2 Google reCAPTCHA

`worker.js` contains three related mechanisms.

#### Encoded origin correction

Base64 query values that decode to the proxy origin are changed to the original embedding origin on both the client and Worker. The rule is structural and does not rely on the query parameter name.

#### `recaptcha-setup` message bridge

Google's parent, anchor, and image-challenge frames establish their channel with an origin-locked `postMessage` handshake. A path proxy changes the browser origin even when the query origin is correct.

Only runtime files matching this structure are transformed:

```text
www.gstatic.com/recaptcha/releases/<version>/recaptcha__<language>.js
www.recaptcha.net/recaptcha/releases/<version>/recaptcha__<language>.js
```

Method calls are routed to `__pxRecaptchaPostMessage`. The helper changes the target origin only when the message is exactly `recaptcha-setup`. Every other message and every other library delegates to its native method unchanged.

For the same handshake only, `MessageEvent.origin` reports the original source-frame origin. `MessageEvent.source` remains native.

This allows the normal image challenge flow to issue `reload`, `payload`, and verification requests.

#### Dynamic integrity handling

Integrity metadata is removed synchronously before dynamically inserted transformed CAPTCHA scripts are appended, preventing stale SRI hashes from blocking the modified runtime.

### 10.3 GitHub repository metadata

GitHub's deferred repository UI reads the browser's native pathname before requesting commit metadata. Under a path proxy it would otherwise see a path beginning with `/https://github.com/` and skip these requests:

```text
/<owner>/<repository>/latest-commit
/<owner>/<repository>/tree-commit-info
```

For a top-level `github.com` document, the route bootstrap temporarily exposes the original repository pathname. GitHub then loads commit messages and `relative-time` elements normally. The complete proxy URL is restored with native `replaceState` without a navigation event.

### 10.4 Pinterest route bootstrap

Pinterest's router also reads the native pathname. The proxy path matches its empty catch-all route rather than the intended page route.

For top-level `www.pinterest.com` and `pinterest.com` documents, the same route bootstrap temporarily exposes the original pathname. During this period:

- Proxy URL helpers continue to use the saved original destination
- Application `pushState` and `replaceState` remain on the virtual path
- Each tab/document keeps independent bootstrap state

The full proxy URL is restored eight seconds after the window load event, with a twenty-second maximum fallback. No navigation event is dispatched. This allows the full React application, images, buttons, and subsequent routes such as `/login/` to render and work.

### 10.5 Arena and Turbopack-style chunk loading

The exact script-source view described earlier preserves root-relative chunk identifiers used by Turbopack and similar runtimes. Downloaded chunks can register under the same keys the runtime used when it requested them, allowing flight data to be consumed and client hydration to proceed.

### 10.6 Relative challenge and redirect flows

The Worker-level internal-path recovery, nested de-proxying, encoded-origin correction, header rewriting, CSP meta removal, and top-level-only last-origin tracking collectively support challenge and redirect systems that construct callback URLs from page location or referrer values.

---

## 11. Route Bootstrap Isolation and Concurrent Tabs

The GitHub/Pinterest route bootstrap uses variables stored in the current page's JavaScript realm. It does not store pathname state in cookies, local storage, session storage, or Worker globals.

Therefore:

- Two tabs can bootstrap different repositories or Pinterest routes simultaneously
- Each tab has an independent saved proxy URL, virtual path, timer, and History object
- Restoring one tab's URL cannot modify another tab

The destination cookies themselves remain shared according to normal browser cookie rules.

During the short bootstrap interval, the address bar temporarily shows a path on the proxy origin without the embedded destination. Reloading manually during that interval can open the proxy home page. Normal use and concurrent tabs are unaffected.

---

## 12. HTML Conversion Details

`parseAndInsertDoc()` performs the initial document conversion in the browser:

1. Parse upstream HTML with `DOMParser`
2. Remove CSP meta tags
3. Walk every HTML element
4. Remove integrity attributes
5. Rewrite URL-bearing attributes
6. Preserve executable inline script text
7. Preserve JSON/data script islands
8. Rewrite absolute URLs inside inline style blocks
9. Normalize an HTML charset declaration to UTF-8
10. Serialize and install the final document with `document.write`

`rewriteSrcdocHtml()` separately processes iframe `srcdoc` documents and adds a small realm guard for URL-bearing static content inside them.

---

## 13. Security Model and Limitations

### Trust boundary

The Worker terminates the visitor's connection and creates a new upstream connection. The deployment operator can observe traffic passing through the proxy.

### Password gate

The built-in password mechanism is suitable for limiting casual access to a personal deployment. It is not a hardened authentication system, does not rate-limit password guesses, and stores the configured password in a client-readable cookie.

### Single browser origin

All destinations share the proxy browser origin. The code emulates destination URL, cookie, storage, history, and referrer behavior, but it cannot perfectly reproduce every browser security boundary. Systems that bind credentials to the actual top-level hostname, TLS origin, browser attestation, or server egress IP can still reject a proxied session.

Examples include some OAuth/FedCM flows, managed anti-bot challenges, origin-restricted identity widgets, and service-worker scope assumptions.

### Egress IP behavior

Upstream traffic originates from the Cloudflare runtime. The Worker cannot select a per-request consumer IP or guarantee a stable IP across every challenge flow. Verification systems that require one sticky egress identity may need an authorized external relay with a fixed outbound IP.

### HTML memory and CPU

HTML and text-like responses are buffered for decoding and transformation. Very large documents increase Worker memory, CPU, response size, and Base64 bootstrap overhead. Binary bodies remain streamed.

### Not an open proxy

A public unrestricted deployment can be abused and can consume bandwidth or trigger platform enforcement. Keep the password enabled, apply deployment-level rate controls where available, and do not expose a relay endpoint without authentication and destination allowlists.

---

## 14. Maintenance Invariants

When modifying the file, preserve these invariants:

1. Keep the server and client copies of `siteToken()` identical.
2. Do not place unescaped backticks inside client template strings.
3. Do not wrap external JavaScript globally in `with`, `eval`, or a function body.
4. Preserve native direct-`eval` and `Function` semantics.
5. Keep the real `document` object for WebIDL APIs that require native Node identity.
6. Do not regenerate the legacy module marker; only accept and strip it.
7. Never text-decode arbitrary binary request or response bodies.
8. Remove stale lengths only when a body was decompressed or re-encoded.
9. Update `Content-Length` assumptions whenever a transformed body changes.
10. Never allow Range/206 responses to enter an edge or browser cache.
11. Keep route-bootstrap host checks explicit so unrelated sites retain normal native history behavior.
12. Keep provider-specific JavaScript transformation narrowly matched to the intended runtime URL.
13. Preserve the distinction between top-level documents and iframe documents when updating internal navigation cookies.

---

## 15. Operational Checklist

After deploying a modified build, verify:

- Home page and password unlock
- A basic static site
- A JavaScript-heavy application
- Relative and absolute navigation
- Back/forward history
- Cookie isolation across two destinations
- JSON and form POST requests
- Binary upload passthrough
- Images, fonts, CSS, and module scripts
- Multiple simultaneous byte-range requests at the beginning, middle, and end of a large file
- Mid-file media seeking without a prior full download
- HLS or DASH URL rewriting
- GitHub repository commit metadata
- Pinterest home and route navigation
- Google reCAPTCHA checkbox and image challenge
- Arena/Turbopack hydration
- Two simultaneous tabs using different destinations

Useful failure signals include:

- `net::ERR_CONTENT_DECODING_FAILED`: stale encoding metadata
- 206 headers arrive but the body stalls: a Range response entered cache-fill instead of the no-store path
- Repeated 302 navigation: incorrect internal-origin recovery or a reload loop
- All chunks return 200 but hydration never begins: script-source key mismatch
- Skeleton placeholders with no failed request: application bootstrap saw the proxy pathname
- CAPTCHA domain error: encoded embedding origin still names the proxy
- CAPTCHA timeout before `reload`: cross-frame setup messaging did not complete

---

## 16. Summary

`worker.js` combines a Worker-side reverse proxy with a browser-side compatibility runtime.

The Worker is responsible for authentication, destination recovery, request normalization, cookie isolation, safe body forwarding, upstream fetches, redirects, content-type-aware response transformation, and response header repair.

The browser runtime is responsible for translating dynamic network calls, DOM attributes, navigation, history, cookies, storage, shadow DOM, source attributes, iframe content, and page-visible URL values.

Narrow compatibility modules are included for:

- Google reCAPTCHA encoded origins and frame setup
- GitHub deferred repository commit metadata
- Pinterest router bootstrap and subsequent navigation
- Arena/Turbopack-style script registration and hydration

All other destinations use the generic proxy pipeline.