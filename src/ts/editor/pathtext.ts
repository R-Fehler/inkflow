// Paths typed in the folder picker, as text: pure, so they are unit-tested.

export function sepOf(path: string): string {
    return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

export function withSep(dir: string): string {
    const sep = sepOf(dir);
    return dir.endsWith(sep) ? dir : dir + sep;
}

export function joinPath(dir: string, name: string): string {
    return withSep(dir) + name;
}

export function baseName(path: string): string {
    return (
        path
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .pop() || path
    );
}

export function samePath(a: string, b: string): boolean {
    const norm = (p: string) => p.replace(/(.)[\\/]+$/, "$1");
    return norm(a) === norm(b);
}

/** The longest start every name shares (case as in the first name). */
export function commonPrefix(names: string[]): string {
    if (!names.length) return "";
    let prefix = names[0];
    for (const name of names.slice(1)) {
        let i = 0;
        while (
            i < prefix.length &&
            i < name.length &&
            prefix[i].toLowerCase() === name[i].toLowerCase()
        ) {
            i++;
        }
        prefix = prefix.slice(0, i);
    }
    return prefix;
}

/** The names that start with ``typed``, ignoring case. */
export function startingWith(names: string[], typed: string): string[] {
    const t = typed.toLowerCase();
    return names.filter((n) => n.toLowerCase().startsWith(t));
}

/** A typed path as the folder it names and the start of a name in it. */
export function splitTyped(value: string): { dir: string; prefix: string } {
    const i = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
    if (i < 0) return { dir: "", prefix: value };
    return { dir: value.slice(0, i + 1), prefix: value.slice(i + 1) };
}

/** An asset reference as written in the deck: the server stamps served
 * slides with the file's version (``?v=…``) so a changed file reloads. */
export function assetRef(href: string): string {
    return href.replace(/\?v=[0-9a-f]+$/, "");
}
