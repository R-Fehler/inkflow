# Sharing a served deck

`inkflow serve` listens on this computer only. To let other devices watch the
presentation (a phone as a remote screen, colleagues following along on their
laptops), share it: on the same network or VPN with a link, or through SSH
tunnels to a server you can log in to. Nothing is uploaded anywhere; the deck
stays on the computer that runs `inkflow serve`.

Everything travels on one port: the pages, their pictures and videos, and the
live connection (a WebSocket at `/_inkflow/ws` on the same port), so whatever
reaches the page reaches the live connection too.

## Who is who

| Role | Who | Can |
|---|---|---|
| **Owner** | Anyone on the computer running inkflow (a browser there, a command, an [SSH tunnel](#over-ssh)); in [SSH mode](#ssh-mode) only whoever opened the owner link | Everything: drive the presentation, open source files in their programs, share |
| **Viewer** | Someone who opened a *view link* | Watch the presentation; it follows the presenter's slide |
| **Editor** | Someone who opened an *editor link*, offered only when a [plugin](../reference/extending.md) on the server edits the deck | What that plugin lets an editor do; never what is the owner's alone |

A viewer's page starts in [follow](sync.md#sync-modes) mode. It can still look
around on its own (switch to *solo*), but its navigation never moves anyone
else's slide, it draws [ink](ink.md) on no one else's screen and never saves
any, and it cannot open the deck's files in a program.

## On the same network (or VPN)

```bash
inkflow serve --share
```

prints a view link for each address of this computer, and the same with its
`.local` name where the network resolves it:

```text
Sharing  view  http://192.168.1.20:7777/?k=unWSwLKvHD3PErKBFp2kBN-R
Sharing  also  http://laptop.local:7777 (same ?k= links)
```

A link is used once: opening it sets a cookie for this server and moves on to
the same address without the `?k=` part, so the token does not stay in the
address bar, the history or a screenshot. Links stop working when the server
stops; a guest then needs a new link.

Starting with `--host` set to one of this computer's network addresses also
shares: other machines can reach it, so they need a link.

Without `--port`, inkflow takes 7777, or the next free port when another
server has it (it says so). One server per deck: a second `inkflow serve` of a
deck that is already served says where instead of starting another.

### VPN and Tailscale

A VPN is a network like any other: with `--share` the links include the VPN
address (a Tailscale `100.x.y.z`, a WireGuard address). Use `--host <address>`
to listen on that address only, not on the local network:

```bash
inkflow serve --share --host 100.101.102.103
```

To use a name instead of the address (a Tailscale MagicDNS name, say), allow
it: inkflow refuses requests that name a host it does not know (see
[security](#security)).

```bash
inkflow serve --share --allow-host laptop.tail1234.ts.net
```

For HTTPS, `tailscale serve` can put the server behind the tailnet's
certificate. Requests then arrive from `tailscale serve` on this computer, so
they are not the owner's; they need a link like any guest:

```bash
inkflow serve --share --allow-host laptop.tail1234.ts.net
tailscale serve --bg 7777
# links: https://laptop.tail1234.ts.net/?k=… (the token the terminal printed)
```

Or serve HTTPS yourself with a certificate and key, such as `tailscale cert`
writes:

```bash
tailscale cert laptop.tail1234.ts.net
inkflow serve --share --host 100.101.102.103 --allow-host laptop.tail1234.ts.net \
    --tls laptop.tail1234.ts.net.crt laptop.tail1234.ts.net.key
```

## Over SSH

When the deck runs on a server you log in to, open it through an SSH tunnel:
nothing listens on the network, and the pages, pictures, videos and the live
connection all travel inside SSH on the one port.

```bash
ssh -L 7777:localhost:7777 you@server.example.com
# on the server:
inkflow serve --deck talk/deck.py
```

then open `http://localhost:7777/` on your computer. To forward a different
local port (7777 is busy on your computer), say `ssh -L 8000:localhost:7777 …`
and open `http://localhost:8000/`.

### SSH mode

Everyone logged in to the server reaches its `localhost`, and so does everyone
who forwards a port to it. So when inkflow is started from an SSH login (it
sees `SSH_CONNECTION` or `SSH_CLIENT` in its environment) it runs in **SSH
mode**: being on the machine is not enough to be the owner. It prints an
**owner link**:

```text
SSH mode  being on this machine is not enough: open the owner link, through your SSH tunnel
Owner  http://localhost:7777/?k=tb9XiVFCe8LZNRKhInLIWeUl
       open it through: ssh -L 7777:localhost:7777 you@203.0.113.5
```

Opening the owner link through your tunnel makes you the owner in that browser
(it sets a cookie of its own, so trying a share link in the same browser
leaves you the owner; the token leaves the address bar). Opening
`http://localhost:7777/` without it answers *Open the owner link*. The owner
link stays the same while the server runs; starting inkflow again makes a new
one.

`--ssh` turns SSH mode on wherever inkflow starts (inside `tmux` started
outside an SSH login, say), `--no-ssh` turns it off (a server only you can log
in to). Commands of your own user on the server keep working as the owner:
they read the owner token from the server's record in your user's state
folder, which other users cannot read.

In SSH mode, `--share` never makes the server listen on the network: the links
name `localhost`, for each guest to open through their own tunnel
(`ssh -N -L 7777:localhost:7777 <their login>@server.example.com`). A guest
needs both a login on the server and a link.

## Security

- Without `--share` (and with the default `--host localhost`) the server
  listens on this computer only.
- Every request from another machine needs a link's token (or the cookie it
  set). Tokens are 144 random bits, compared in constant time, and never
  written in full to the logs.
- A web page from another site cannot use the server: the live connection
  only accepts pages the server served itself (its `Origin`), and every
  request must name this computer (its `Host`: `localhost`, an address, this
  computer's name or one given with `--allow-host`), so a site that points its
  own name at your computer (*DNS rebinding*) is refused.
- Pages are never shown inside another site's frame, and send no `Referer`
  (which could carry a token).
- Without SSH mode, anyone who can reach `localhost` on this computer is the
  owner: other users logged in to the same machine too. On a machine other
  people log in to, use [SSH mode](#ssh-mode) (the default when inkflow
  starts from an SSH login): there only the owner link makes the owner, and
  commands read the owner token from a file only your user can read (`0600`,
  in a folder only you can open).
- A browser sends the cookies of `localhost` to every port on it, so a program
  of yours listening on another local port could see an inkflow cookie. The
  tokens in them stop working when the server stops.
- Plain HTTP on a network you do not trust (café Wi-Fi, a conference) lets
  anyone on it read the links and the deck as they pass. Prefer SSH or a VPN
  there, or `--tls` with a certificate.
