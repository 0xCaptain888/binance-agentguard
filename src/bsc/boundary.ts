import type { IncomingHttpHeaders } from "node:http";

export type BoundaryOptions = { mode: "local" | "testnet"; publicOrigin?: string; listenHost?: string };

// The gateway must preserve Host. Forwarded headers never select the origin,
// signer challenge, redirect target or client identity.
export function serviceBoundary(options: BoundaryOptions) {
  const host = options.listenHost ?? "127.0.0.1";
  if (!["127.0.0.1", "0.0.0.0"].includes(host)) throw new Error("Unsupported listen address");
  let publicOrigin: string | undefined;
  if (options.publicOrigin) {
    const url = new URL(options.publicOrigin);
    if (options.mode !== "testnet" || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !url.hostname.includes(".") || url.hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.endsWith(".localhost"))
      throw new Error("Public service requires a testnet HTTPS hostname origin");
    publicOrigin = url.origin;
  }
  if (host !== "127.0.0.1" && !publicOrigin) throw new Error("Non-loopback binding requires an explicit HTTPS public origin");
  if (options.mode === "local" && host !== "127.0.0.1") throw new Error("Local fixture must remain on loopback");
  return { host, publicOrigin };
}

export function trustedHost(headers: IncomingHttpHeaders, origin: string) {
  return headers.host === new URL(origin).host;
}

export function sameOrigin(headers: IncomingHttpHeaders, origin: string) {
  return headers.origin === origin && headers["sec-fetch-site"] !== "cross-site";
}
