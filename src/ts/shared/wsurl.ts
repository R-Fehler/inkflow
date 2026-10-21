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

// A page shared through a relay (an extension's online sharing) may run in a
// frame whose top window holds the channel to the server: there the page's
// connection is one over that channel, shaped like a WebSocket, which the
// top window offers as `__inkflowRelay`. Anywhere else it is the server's
// WebSocket on the page's own address.
interface RelayParent {
    __inkflowRelay?: { openSocket(): unknown };
}

function relay(): RelayParent["__inkflowRelay"] {
    try {
        if (window.parent !== window) {
            return (window.parent as unknown as RelayParent).__inkflowRelay;
        }
    } catch {
        // Framed by another site: no relay.
    }
    return undefined;
}

export function openSocket(): WebSocket {
    const relayed = relay();
    if (!relayed) return new WebSocket(socketUrl(location));
    const sock = relayed.openSocket() as WebSocket;
    // The page going away (a reload, another page) ends its connection, as
    // the browser ends a WebSocket.
    window.addEventListener("pagehide", () => sock.close(1001, "page left"));
    return sock;
}
