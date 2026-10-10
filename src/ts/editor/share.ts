// The owner's Share… dialog: share the deck on the local network (or a VPN)
// and stop again, without restarting; an editor link and a view link per
// address, each with Copy and a QR code; new links (everyone who joined with
// the old ones is disconnected); who is connected, with Disconnect.

import qrcode from "qrcode-generator";
import { collab } from "./collab";
import { dialogOpen, openDialog } from "./dialog";
import { clear, h, toast } from "./dom";
import { onMessage, sendRaw } from "./net";

interface Link {
    address: string;
    editor: string;
    view: string;
}

interface ShareStatus {
    sharing: boolean;
    links: Link[];
    names: string[];
    port: number;
    people: {
        id: string;
        name: string;
        role: string;
        page: string;
        slide: number | null;
    }[];
    error?: string;
}

let status: ShareStatus | null = null;
let body: HTMLElement | null = null;
const button = document.getElementById("btn-share");

/** An SVG QR code for `text` (generated here; nothing leaves the page). */
export function qrSvg(text: string): string {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
}

function copy(text: string, what: string): void {
    const done = () => toast(`${what} copied`, "ok");
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, () => fallback());
    } else fallback();
    function fallback(): void {
        const area = h("textarea", {}, text);
        document.body.append(area);
        area.select();
        try {
            document.execCommand("copy");
            done();
        } catch {
            toast("Select the link and copy it", "error");
        }
        area.remove();
    }
}

function linkRow(label: string, url: string, hint: string): HTMLElement {
    const qr = h("div", { class: "share-qr", title: `QR code: ${label}` });
    qr.innerHTML = qrSvg(url);
    return h(
        "div",
        { class: "share-link" },
        qr,
        h(
            "div",
            { class: "share-link-text" },
            h("strong", {}, label),
            h("span", { class: "hint" }, hint),
            h("input", {
                type: "text",
                readonly: true,
                value: url,
                onfocus: (e: Event) => (e.target as HTMLInputElement).select(),
            }),
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn",
                    onclick: () => copy(url, label),
                },
                "Copy",
            ),
        ),
    );
}

function render(): void {
    if (!body || !status) return;
    clear(body);
    const s = status;
    body.append(
        h(
            "div",
            { class: "share-state" },
            h(
                "p",
                {},
                s.sharing
                    ? "Shared on the network: people with a link below can join."
                    : "Only this computer can open the deck. Share it to give people on the same network (or VPN) a link.",
            ),
            h(
                "button",
                {
                    type: "button",
                    class: s.sharing ? "pbtn" : "pbtn primary",
                    onclick: () =>
                        sendRaw({
                            type: "share",
                            op: s.sharing ? "off" : "on",
                        }),
                },
                s.sharing ? "Stop sharing" : "Share on the network",
            ),
        ),
    );
    if (s.error) body.append(h("p", { class: "share-error" }, s.error));
    if (s.sharing) {
        if (!s.links.length) {
            body.append(
                h(
                    "p",
                    { class: "hint" },
                    "No network address found. Start inkflow with --host <address>.",
                ),
            );
        }
        for (const link of s.links) {
            body.append(
                h(
                    "section",
                    { class: "share-address" },
                    h("h3", {}, link.address),
                    linkRow(
                        "Editor link",
                        link.editor,
                        "Edits the deck with you (not your computer's files, git or programs).",
                    ),
                    linkRow(
                        "View link",
                        link.view,
                        "Watches the presentation and follows your slide.",
                    ),
                ),
            );
        }
        if (s.names.length) {
            body.append(
                h(
                    "p",
                    { class: "hint" },
                    `The same links also work with ${s.names.join(", ")} in place of the address, where the network supports it.`,
                ),
            );
        }
        body.append(
            h(
                "div",
                { class: "share-actions" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn",
                        onclick: () => {
                            if (
                                confirm(
                                    "Make new links? Everyone who joined with the current ones is disconnected.",
                                )
                            ) {
                                sendRaw({ type: "share", op: "rotate" });
                            }
                        },
                    },
                    "New links",
                ),
            ),
            h(
                "p",
                { class: "hint" },
                "The links travel unencrypted on the network: on a network you do not trust, share over SSH or a VPN instead.",
            ),
        );
    }
    body.append(
        h(
            "p",
            { class: "hint" },
            "From another computer over SSH: ",
            h(
                "code",
                {},
                `ssh -L ${s.port}:localhost:${s.port} you@this-computer`,
            ),
            `, then open http://localhost:${s.port}/edit there (as you).`,
        ),
    );
    const people = s.people.filter((p) => p.id !== collab.me?.id);
    body.append(
        h("h3", {}, people.length ? "Connected" : "No one else is connected"),
    );
    const list = h("ul", { class: "share-people" });
    for (const p of people) {
        const where =
            p.slide == null
                ? ""
                : p.page === "presenter"
                  ? `presenting slide ${p.slide + 1}`
                  : `on slide ${p.slide + 1}`;
        list.append(
            h(
                "li",
                {},
                h("span", { class: "who" }, p.name),
                h(
                    "span",
                    { class: "hint" },
                    `${p.role}${where ? ` · ${where}` : ""}`,
                ),
                p.role === "owner"
                    ? null
                    : h(
                          "button",
                          {
                              type: "button",
                              class: "pbtn",
                              onclick: () =>
                                  sendRaw({
                                      type: "share",
                                      op: "kick",
                                      id: p.id,
                                  }),
                          },
                          "Disconnect",
                      ),
            ),
        );
    }
    body.append(list);
}

function setStatus(msg: Record<string, unknown>): void {
    status = msg as unknown as ShareStatus;
    if (button) button.classList.toggle("on", status.sharing);
    if (status.error) toast(status.error, "error");
    if (body && dialogOpen()) render();
}

export function openShare(): void {
    body = h("div", { class: "share-dialog" }, h("p", {}, "…"));
    openDialog("Share", body, {
        wide: true,
        onClose: () => {
            body = null;
        },
    });
    sendRaw({ type: "share", op: "status" });
    render();
}

export function initShare(): void {
    onMessage("share-status", setStatus);
    button?.addEventListener("click", openShare);
}
