# Editing together

Several people can work on one deck at the same time: you on your computer,
colleagues in the same room or on the same VPN through a share link, or you
yourself from another machine over SSH. Everyone sees the others' edits within
a moment, who is on which slide, and what they have selected. Nothing is
uploaded anywhere: the deck stays on the computer that runs `inkflow edit`.

## Who is who

There are three roles.

| Role | Who | Can |
|---|---|---|
| **Owner** | Anyone on the computer running inkflow (a browser there, a command, an agent, an [SSH tunnel](#over-ssh)) | Everything |
| **Editor** | Someone who opened an *editor link* | Edit the deck: slides, text, pictures, notes, ink, theme, export |
| **Viewer** | Someone who opened a *view link* | Watch the presentation; it follows the presenter's slide |

An editor changes the deck's own files, and nothing else on your computer. These
stay with the owner:

- opening files in other programs (**Open ▾**), the system file chooser, folder
  browsing, opening or creating other decks, the recent-decks list;
- git: commit, push, pull, switching branches and every other operation that
  writes (an editor still sees the status and history);
- worktrees (add, merge, remove), Git → Publish… setup, **Pack deck…**, copying
  this computer's fonts into the deck;
- inserting a file by its path on disk, exporting outside the deck's folder;
- the agents' context file and `inkflow goto`/`select`, the Share dialog, and
  **Quit Inkflow**.

An editor's edit never writes code or settings that your computer would run or
read: no Python modules, scripts or `.toml`/`.lock` files, and nothing in a hidden
folder (`.git/`, `.env`…). `deck.py` itself is changed only through the editor's
own structural edits, as for you.

A viewer gets the presenter page only: `/edit` answers *View-only link*, and
anything a viewer sends besides following along is ignored.

## On the same network (or VPN)

```bash
inkflow edit --share
```

prints two links for each address of this computer, and the same with its
`.local` name where the network resolves it:

```text
Sharing  edit  http://192.168.1.20:7777/edit?k=4ReDLi5Snm8Ihq9Yre7-KYBC
Sharing  view  http://192.168.1.20:7777/?k=unWSwLKvHD3PErKBFp2kBN-R
Sharing  also  http://laptop.local:7777 (same ?k= links)
```

The editor's **Share…** button (top right, for the owner only) does the same
without restarting: **Share on the network** starts listening on the network,
**Stop sharing** goes back to this computer only. The dialog shows each link with
**Copy** and a QR code to scan with a phone, and lists who is connected, each
with **Disconnect**. **New links** makes new ones: the old links stop working and
everyone who joined with them is disconnected.

A link is used once: opening it sets a cookie for this server and moves on to the
same address without the `?k=` part, so the token does not stay in the address
bar, the history or a screenshot. Links stop working when sharing stops or new
links are made; a guest then sees *Disconnected* and needs a new link.

Starting with `--host` set to one of this computer's network addresses also
shares: other machines can reach it, so they need a link.

### VPN and Tailscale

A VPN is a network like any other: with `--share` the links include the VPN
address (a Tailscale `100.x.y.z`, a WireGuard address). Use
`--host <address>` to listen on that address only, not on the local network:

```bash
inkflow edit --share --host 100.101.102.103
```

To use a name instead of the address (a Tailscale MagicDNS name, say), allow it:
inkflow refuses requests that name a host it does not know (see
[security](#security)).

```bash
inkflow edit --share --allow-host laptop.tail1234.ts.net
```

For HTTPS, `tailscale serve` can put the server behind the tailnet's
certificate. Requests then arrive from `tailscale serve` on this computer, so
they are not the owner's; they need a link like any guest:

```bash
inkflow edit --share --allow-host laptop.tail1234.ts.net
tailscale serve --bg 7777
# links: https://laptop.tail1234.ts.net/edit?k=… (the token from the Share dialog)
```

Or serve HTTPS yourself with a certificate and key, such as `tailscale cert`
writes:

```bash
tailscale cert laptop.tail1234.ts.net
inkflow edit --share --host 100.101.102.103 --allow-host laptop.tail1234.ts.net \
    --tls laptop.tail1234.ts.net.crt laptop.tail1234.ts.net.key
```

## Over SSH

When the deck lives on another machine you can log in to (a workstation, a
server), forward its port:

```bash
ssh -L 7777:localhost:7777 you@workstation
# on the workstation:
inkflow edit --no-open --deck talk/deck.py
```

and open `http://localhost:7777/edit` on your own computer. Through the tunnel
you are the owner, with everything the owner can do (you have a shell there
anyway). No link is needed and nothing listens on the network. To forward to a
different local port, `ssh -L 8000:localhost:7777 …` and open
`http://localhost:8000/edit`.

Everything (pages, pictures, videos and the live connection) travels over the
one port, so one forward is all it takes.

## Seeing each other

The first time you open an editor link, the editor asks for your name (kept in
that browser). Each person gets a colour:

- **avatars** in the toolbar, one per person with a page open (a dashed ring:
  presenting). Click someone's avatar to go to their slide, your own to change
  your name;
- **coloured dots** in the slide list on the slide each person is on;
- **their selection** outlined on the canvas in their colour, with their name
  (*typing* while they edit text).

Nothing of this is written to the deck; it disappears when they close the page.

## Undo is yours

<kbd>Ctrl</kbd>+<kbd>Z</kbd> takes back *your* latest change, not whatever
anyone did last. It does so only when no later change (anyone's) touched the
same file. Otherwise it says who changed it: *Ana changed features.md after
you: your edit cannot be undone without theirs*, and the Undo button's tooltip
says so beforehand. Ana can undo hers first, or you change it back by hand.
Redo works the same way.

Changes an agent makes on this computer (`inkflow slide`, `inkflow shape`) are
the owner's: only the owner's pages undo them.

## Two people, one file

Every change is checked against the version of the deck the page showed when you
made it. When someone else changed the same file in between, your change is
refused rather than written over theirs, and your editor is brought up to date
with a note: *Ana changed slides/drawing.svg meanwhile*. Drag or edit again.

Text you were typing is never lost. If someone changed the same text while you
typed, a box shows what you typed: **Copy** it, **Use mine instead** to put it
in place of theirs on purpose, or **Keep theirs**. If they changed something
else (another text on the same slide, the slide list), your text is saved as
usual.

## Security

- Without `--share` (and with the default `--host localhost`) the server listens
  on this computer only.
- Every request from another machine needs a link's token (or the cookie it set).
  Tokens are 144 random bits, compared in constant time, and never written in
  full to the logs.
- A web page from another site cannot use the server: the live connection only
  accepts pages the server served itself (its `Origin`), and every request must
  name this computer (its `Host`: `localhost`, an address, this computer's name
  or one given with `--allow-host`), so a site that points its own name at your
  computer (*DNS rebinding*) is refused.
- Anyone who can reach `localhost` on this computer is the owner: other users
  logged in to the same machine too. Share a multi-user machine over SSH only
  from your own account, or not at all.
- Plain HTTP on a network you do not trust (café Wi-Fi, a conference) lets anyone
  on it read the links and the deck as they pass. Prefer SSH or a VPN there, or
  `--tls` with a certificate.
