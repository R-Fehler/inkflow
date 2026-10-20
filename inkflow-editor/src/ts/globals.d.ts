// The editor page's own injected global (inkflow_editor/server.py's
// editor_html); the presenter's (__SLIDES_JSON__, __WS_PORT__…) are the
// core's, in src/ts/globals.d.ts.
import type { EditorModel } from "./editor/types";

declare global {
    const __MODEL_JSON__: EditorModel | null;
}
