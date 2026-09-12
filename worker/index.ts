/**
 * Vestyr Worker — API only.
 *
 * wrangler.jsonc sets `run_worker_first: ["/api/*"]`, so ordinary page and
 * asset requests are served straight from Workers Static Assets and never
 * reach this code. The ASSETS fallback below only exists for safety.
 */
import { EmailMessage } from "cloudflare:email";

export interface Env {
  ASSETS: Fetcher;
  /** Send-email binding, configured in wrangler.jsonc. */
  CONTACT_EMAIL: { send(message: EmailMessage): Promise<void> };
  /** Secret. `wrangler secret put TURNSTILE_SECRET_KEY` */
  TURNSTILE_SECRET_KEY?: string;
  /** Verified destination address. Set as a var or secret, never hardcoded. */
  CONTACT_RECIPIENT?: string;
  /** Sender on the Cloudflare-onboarded domain. */
  CONTACT_SENDER?: string;
}

const MAX_BODY_BYTES = 64 * 1024;

const LIMITS = {
  name: 100,
  email: 254,
  company: 150,
  message: 5000,
  diagnostic: 300
} as const;

// Deliberately permissive but structurally strict; real validation is the
// reply landing in an inbox, not a clever regex.
const EMAIL_RE = /^[^\s@,;:<>]+@[^\s@.,;:<>]+(\.[^\s@.,;:<>]+)+$/;

const GENERIC_ERROR = "Unable to send message.";

interface ContactPayload {
  name?: unknown;
  email?: unknown;
  company?: unknown;
  message?: unknown;
  website?: unknown;
  diagnostic?: unknown;
  turnstileToken?: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

const ok = () => json({ success: true });
const fail = (error: string, status: number) => json({ success: false, error }, status);

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Strip CR/LF so a submitted value can never inject extra mail headers. */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** RFC 2047 encoded-word, so non-ASCII names survive the Subject line. */
function encodeHeaderValue(value: string): string {
  const safe = headerSafe(value);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(safe)) return safe;
  return "=?UTF-8?B?" + base64(new TextEncoder().encode(safe)) + "?=";
}

function wrap76(value: string): string {
  return (value.match(/.{1,76}/g) || []).join("\r\n");
}

async function verifyTurnstile(token: string, secret: string, ip: string | null): Promise<boolean> {
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);

  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body
    });
    if (!res.ok) return false;
    const result = (await res.json()) as { success?: boolean };
    return result.success === true;
  } catch {
    return false;
  }
}

function buildMime(opts: {
  sender: string;
  recipient: string;
  replyTo: string;
  name: string;
  company: string;
  email: string;
  message: string;
  diagnostic: string;
}): string {
  const lines = [
    "New enquiry from vestyr.com",
    "",
    `Name: ${opts.name}`,
    `Company: ${opts.company || "—"}`,
    `Email: ${opts.email}`,
    "",
    "Message:",
    opts.message
  ];
  if (opts.diagnostic) lines.push("", `Diagnostic: ${opts.diagnostic}`);
  const body = lines.join("\r\n");

  const headers = [
    `From: ${encodeHeaderValue("Vestyr Website")} <${opts.sender}>`,
    `To: <${opts.recipient}>`,
    `Reply-To: <${opts.replyTo}>`,
    `Subject: ${encodeHeaderValue(`New Vestyr enquiry from ${opts.name}`)}`,
    `Message-ID: <${crypto.randomUUID()}@${opts.sender.split("@")[1]}>`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64"
  ];

  return headers.join("\r\n") + "\r\n\r\n" + wrap76(base64(new TextEncoder().encode(body))) + "\r\n";
}

async function handleContact(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json({ success: false, error: "Method not allowed." }, 405);
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return fail("Unsupported content type.", 415);
  }

  const declared = Number(request.headers.get("content-length") || "0");
  if (declared > MAX_BODY_BYTES) return fail("Message too large.", 413);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return fail("Message too large.", 413);

  let payload: ContactPayload;
  try {
    payload = JSON.parse(raw) as ContactPayload;
  } catch {
    return fail("Malformed request.", 400);
  }

  // Honeypot: accept and discard, so bots learn nothing from the response.
  if (str(payload.website, 200) !== "") return ok();

  const name = str(payload.name, LIMITS.name);
  const email = str(payload.email, LIMITS.email);
  const company = str(payload.company, LIMITS.company);
  const message = str(payload.message, LIMITS.message);
  const diagnostic = str(payload.diagnostic, LIMITS.diagnostic);

  if (!name || !email || !message) return fail("Please complete the required fields.", 400);
  if (!EMAIL_RE.test(email)) return fail("Please enter a valid email address.", 400);

  if (!env.TURNSTILE_SECRET_KEY) {
    console.error("contact: TURNSTILE_SECRET_KEY is not configured");
    return fail(GENERIC_ERROR, 500);
  }
  const token = str(payload.turnstileToken, 4096);
  if (!token) return fail("Please complete the verification check.", 400);

  const verified = await verifyTurnstile(
    token,
    env.TURNSTILE_SECRET_KEY,
    request.headers.get("CF-Connecting-IP")
  );
  if (!verified) return fail("Verification failed. Please try again.", 403);

  const recipient = env.CONTACT_RECIPIENT;
  const sender = env.CONTACT_SENDER || "website@vestyr.com";
  if (!recipient) {
    console.error("contact: CONTACT_RECIPIENT is not configured");
    return fail(GENERIC_ERROR, 500);
  }

  try {
    const mime = buildMime({
      sender,
      recipient,
      replyTo: email,
      name: headerSafe(name),
      company: headerSafe(company),
      email: headerSafe(email),
      message,
      diagnostic
    });
    await env.CONTACT_EMAIL.send(new EmailMessage(sender, recipient, mime));
  } catch (err) {
    // Log the failure reason only — never the submitted personal data.
    console.error("contact: send failed", err instanceof Error ? err.message : "unknown");
    return fail(GENERIC_ERROR, 502);
  }

  return ok();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/contact") return handleContact(request, env);
    if (pathname.startsWith("/api/")) return json({ success: false, error: "Not found." }, 404);

    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
