// Where a served page opens the server's WebSocket: on the very address the
// page came from (its host and port, whatever name, LAN address or SSH tunnel
// that is), at /_inkflow/ws, over TLS when the page is.

export const WS_PATH = "/_inkflow/ws";

export function socketUrl(loc: { protocol: string; host: string }): string {
    const scheme = loc.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${loc.host || "localhost"}${WS_PATH}`;
}

// Close code the server uses to send a guest away; the page says why and
// does not reconnect (its link stopped working, or the owner disconnected it).
export const SENT_AWAY = 4001;

export function openSocket(): WebSocket {
    return new WebSocket(socketUrl(location));
}
