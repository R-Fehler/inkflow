"""Sharing online as a server extension: the room on a relay (``host.py``),
its links in the owner's Share dialog and the terminal, and every guest's
page connection and request served by the server as if from its own port
(``ServerContext.serve_connection`` / ``serve_request``), for that guest's
role. The core server knows nothing of relays.
"""

from __future__ import annotations

from collections.abc import Coroutine

from typing_extensions import override

from inkflow.extensions import ServerContext, ServerExtension
from inkflow.logging import logger, report
from inkflow_editor.online import config as relay_config
from inkflow_editor.online import crypto as online_crypto
from inkflow_editor.online.host import Hooks, OnlineHost


class OnlineExtension(ServerExtension):
    """Share the served deck online through a relay (``inkflow relay``)."""

    name: str = "inkflow-editor online"

    def __init__(self, *, start_online: bool = False) -> None:
        self.start_online: bool = start_online
        """Share online from the start (``--share-online``)."""
        self.server: ServerContext | None = None
        self.host: OnlineHost | None = None

    @override
    async def start(self, server: ServerContext) -> None:
        self.server = server
        if self.start_online:
            problem = await self.start_sharing()
            if problem is not None:
                report("Error", f"cannot share online: {problem}", style="red")

    @override
    async def stop(self) -> None:
        await self.stop_sharing("the server stopped")

    @override
    async def close(self, *, switching: bool) -> None:
        del switching
        if self.host is not None:
            # Online guests' pages reconnect, to the next deck if one opens.
            await self.host.drop_pages()

    def _hooks(self) -> Hooks:
        server = self.server
        assert server is not None

        def changed() -> Coroutine[object, object, None]:
            async def run() -> None:
                server.share_changed()

            return run()

        return Hooks(
            connect=server.serve_connection,
            fetch=server.serve_request,
            changed=changed,
        )

    async def start_sharing(
        self, url: str | None = None, token: str | None = None
    ) -> str | None:
        """Share online through the configured relay (or ``url``); an error
        message when it cannot start."""
        if self.host is not None:
            return None
        if not online_crypto.available():
            return online_crypto.INSTALL_HINT
        configured = relay_config.load()
        if url is None and configured is None:
            return (
                "no relay set: see Share online in the docs, or `inkflow relay set URL`"
            )
        relay = url or (configured.url if configured else "")
        try:
            host = OnlineHost(
                relay,
                token or (configured.token if configured else None),
                self._hooks(),
            )
        except ValueError as exc:
            return str(exc)
        self.host = host
        host.start()
        logger.info(f"sharing online through {host.relay}")
        return None

    async def stop_sharing(self, reason: str = "sharing stopped") -> None:
        host, self.host = self.host, None
        if host is not None:
            await host.stop(reason)
            logger.info("sharing online off")

    @override
    def share_status(self) -> dict[str, object]:
        """The Share dialog's Online section."""
        configured = relay_config.load()
        status: dict[str, object] = {
            "available": online_crypto.available(),
            "installHint": online_crypto.INSTALL_HINT,
            "relay": configured.url if configured else None,
            "sharing": self.host is not None,
        }
        if self.host is not None:
            status.update(self.host.status())
        return {"online": status}

    @override
    async def share_op(self, op: str, msg: dict[str, object]) -> str | bool | None:
        """The Share dialog's Online section: on/off, new links, the relay."""
        if op == "online-on":
            return await self.start_sharing()
        if op == "online-off":
            await self.stop_sharing()
        elif op == "online-rotate":
            if self.host is not None:
                await self.host.rotate()
                logger.info("new online links")
        elif op == "relay-set":
            url = msg.get("url")
            token = msg.get("token")
            if not isinstance(url, str) or not url.strip():
                relay_config.forget()
                return None
            try:
                relay_config.save(url, token if isinstance(token, str) else None)
            except (ValueError, OSError) as exc:
                return f"cannot use that relay address: {exc}"
        else:
            return False
        return None

    @override
    def share_lines(self) -> list[str]:
        """What the terminal says about sharing online: the two links, or why
        there are none yet."""
        host = self.host
        if host is None:
            return []
        if host.state == "open":
            return [
                f"edit  {host.link('editor')}  (online)",
                f"view  {host.link('viewer')}  (online)",
            ]
        why = f": {host.error}" if host.error else ""
        return [f"online  {host.state} ({host.relay}){why}"]
