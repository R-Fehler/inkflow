// Back from presenting to an editor, at the slide on screen. Only a server
// with an editor says where one is: its "welcome" names the page
// (`{"editor": "/edit"}`, added by a server extension). A static build, a
// bare `inkflow serve` and a view link have none, and the button stays
// hidden.
//
// An editor may open this page in a window of its own; when that editor tab
// is still there, it is moved to this slide and brought back, and this
// window closes. Otherwise this tab becomes the editor.

import { state } from "./state";

let editorPath: string | null = null;

export function backToEditor(): void {
    if (editorPath === null) return;
    const hash = `#slide=${state.slideIndex + 1}`;
    const opener = window.opener as Window | null;
    try {
        if (
            opener &&
            !opener.closed &&
            opener.location.origin === location.origin &&
            opener.location.pathname.startsWith(editorPath)
        ) {
            opener.location.hash = hash;
            opener.focus();
            window.close();
            if (window.closed) return;
        }
    } catch {
        // Another origin, or a window that is gone: take this tab instead.
    }
    location.href = `${editorPath}${hash}`;
}

// Where the server's editor is (a same-origin path), or null for none.
export function setEditor(path: string | null): void {
    editorPath = path?.startsWith("/") ? path : null;
    const button = document.getElementById("btn-to-editor");
    if (button) button.style.display = editorPath === null ? "none" : "";
}

export function initToEditor(): void {
    const button = document.getElementById("btn-to-editor");
    if (!button) return;
    button.style.display = "none"; // until the server names an editor
    button.addEventListener("click", backToEditor);
}
